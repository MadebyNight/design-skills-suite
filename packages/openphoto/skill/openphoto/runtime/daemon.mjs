import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ArtifactStore } from './artifact-store.mjs'
import { COMMAND_IDS, normalizeCommands } from './command-schema.mjs'
import { DocumentDriver } from './document-driver.mjs'
import { JobStore } from './job-store.mjs'
import { ModelStore } from './model-store.mjs'
import { installModel } from './model-installer.mjs'
import { ERROR_CODES, requestSchema, responseError } from './protocol.mjs'
import { resolveDataRoot } from './daemon-lock.mjs'
import { locateBrowser } from './browser.mjs'

const ENABLED_OPERATIONS = [
  'runtime.health', 'runtime.capabilities', 'artifact.import', 'artifact.read',
  'document.open', 'document.inspect', 'document.mutate', 'document.renderArtifact', 'document.applyArtifact', 'document.close',
  'ai.analyze.start', 'ai.job.get',
  'model.status', 'model.install', 'model.install.cancel'
]
const DEFAULT_MODEL_LOCK = resolve(dirname(fileURLToPath(import.meta.url)), '../manifests/models.lock.json')
const DEFAULT_MODEL_ROUTE = resolve(dirname(fileURLToPath(import.meta.url)), '../manifests/model-route.json')
const SHA256 = /^[a-f0-9]{64}$/u
const MODEL_FOR_CAPABILITY = {
  'background-remove': 'Xenova/modnet',
  depth: 'Xenova/depth-anything-small-hf',
  detect: 'Xenova/detr-resnet-50',
  segment: 'Xenova/detr-resnet-50-panoptic'
}

function requestError(code, message, details) {
  return Object.assign(new Error(`${code}: ${message}`), {
    code,
    ...(details === undefined ? {} : { details })
  })
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

function requirePlainObject(value, label) {
  if (!isPlainObject(value)) {
    throw requestError('INVALID_REQUEST', `${label} must be a plain object`)
  }
  return value
}

function modelManifestError(message) {
  return requestError('MODEL_MANIFEST_INCOMPLETE', message)
}

function modelEntry(manifest, modelId) {
  if (!requireManifest(manifest) || !Object.hasOwn(manifest.models, modelId)) {
    throw modelManifestError('model is not present in the model lock')
  }
  const entry = manifest.models[modelId]
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry) || (Object.getPrototypeOf(entry) !== Object.prototype && Object.getPrototypeOf(entry) !== null) || typeof entry.revision !== 'string' || entry.revision.length === 0) {
    throw modelManifestError('model revision is missing from the model lock')
  }
  return entry
}

function requireManifest(manifest) {
  return manifest !== null
    && typeof manifest === 'object'
    && !Array.isArray(manifest)
    && (Object.getPrototypeOf(manifest) === Object.prototype || Object.getPrototypeOf(manifest) === null)
    && manifest.models !== null
    && typeof manifest.models === 'object'
    && !Array.isArray(manifest.models)
}

function assertCompleteModelEntry(entry) {
  if (!isHttpUrl(entry.source) || typeof entry.license !== 'string' || entry.license.length === 0 || !Array.isArray(entry.files) || entry.files.length === 0) {
    throw modelManifestError('model lock entry is incomplete')
  }
  for (const file of entry.files) {
    if (file === null || typeof file !== 'object' || Array.isArray(file) || (Object.getPrototypeOf(file) !== Object.prototype && Object.getPrototypeOf(file) !== null) || typeof file.path !== 'string' || file.path.length === 0 || !isHttpUrl(file.url) || !Number.isSafeInteger(file.bytes) || file.bytes <= 0 || typeof file.sha256 !== 'string' || !SHA256.test(file.sha256)) {
      throw modelManifestError('model lock entry is incomplete')
    }
  }
  return entry
}

function isHttpUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return false
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function installStatus(job) {
  return {
    installId: job.installId,
    modelId: job.modelId,
    revision: job.revision,
    status: job.status,
    ...(job.error === undefined ? {} : { error: structuredClone(job.error) })
  }
}

function installResult(job) {
  return { installId: job.installId, modelId: job.modelId, status: job.status }
}

function cancelResult(job) {
  return {
    installId: job.installId,
    status: job.status,
    ...(job.error === undefined ? {} : { error: structuredClone(job.error) })
  }
}

function recordedError(error) {
  const code = errorCode(error)
  return { code, message: error?.message ?? 'model installation failed' }
}

function analysisResult(job) {
  return {
    jobId: job.jobId,
    status: job.status,
    ...(job.result === undefined ? {} : { result: structuredClone(job.result) }),
    ...(job.error === undefined ? {} : { error: structuredClone(job.error) })
  }
}

function normalizeAnalysisPayload(payload) {
  const modelId = MODEL_FOR_CAPABILITY[payload.capability]
  if (!modelId && payload.capability !== 'upscale') {
    throw requestError('UNSUPPORTED_CAPABILITY', `unsupported analysis capability: ${payload.capability}`)
  }
  if (payload.capability === 'segment' && payload.point === undefined) {
    throw requestError('INVALID_REQUEST', 'segment requires point')
  }
  if (payload.capability !== 'segment' && payload.point !== undefined) {
    throw requestError('INVALID_REQUEST', 'point is only supported by segment')
  }
  if (payload.capability === 'upscale' && payload.factor === undefined) {
    throw requestError('INVALID_REQUEST', 'upscale requires factor')
  }
  if (payload.capability !== 'upscale' && payload.factor !== undefined) {
    throw requestError('INVALID_REQUEST', 'factor is only supported by upscale')
  }
  return {
    capability: payload.capability,
    objectId: payload.objectId,
    sourceRevision: payload.sourceRevision,
    ...(payload.point === undefined ? {} : { point: structuredClone(payload.point) }),
    ...(payload.factor === undefined ? {} : { factor: payload.factor }),
    ...(modelId === undefined ? {} : { modelId })
  }
}

function modelDownloadDetails(job, entry, cacheRoot) {
  return {
    jobId: job.jobId,
    modelId: job.modelId,
    revision: entry.revision,
    source: entry.source,
    license: entry.license,
    totalBytes: entry.files.reduce((total, file) => total + file.bytes, 0),
    cacheRoot
  }
}

function isArtifactRef(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && typeof value.artifactId === 'string' && value.artifactId.length > 0
}

function isLoopbackModelPath(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' && url.hostname === '127.0.0.1'
  } catch {
    return false
  }
}

function normalizeRenderPayload(payload) {
  requirePlainObject(payload, 'document.renderArtifact payload')
  const allowed = new Set(['format', 'quality', 'matte'])
  if (!Object.hasOwn(payload, 'format') || Object.keys(payload).some(key => !allowed.has(key))) {
    throw requestError('INVALID_REQUEST', 'document.renderArtifact payload has missing or unknown fields')
  }
  if (typeof payload.format !== 'string') throw requestError('INVALID_REQUEST', 'format is required')
  const format = payload.format === 'jpg' ? 'jpeg' : payload.format
  if (!['png', 'jpeg'].includes(format)) throw requestError('FORMAT_UNSUPPORTED', 'format must be png, jpeg, or jpg')
  if (payload.quality !== undefined && (typeof payload.quality !== 'number' || !Number.isFinite(payload.quality) || payload.quality <= 0 || payload.quality > 1)) {
    throw requestError('INVALID_REQUEST', 'quality must be a number between 0 and 1')
  }
  if (payload.matte !== undefined && (typeof payload.matte !== 'string' || !/^#[0-9a-fA-F]{6}$/u.test(payload.matte))) {
    throw requestError('INVALID_REQUEST', 'matte must be a six-digit hexadecimal color')
  }
  return {
    format,
    ...(payload.quality === undefined ? {} : { quality: payload.quality }),
    ...(payload.matte === undefined ? {} : { matte: payload.matte.toLowerCase() })
  }
}

function revisionFrom(value) {
  const revision = value?.revision ?? value?.descriptor?.revision
  if (!Number.isSafeInteger(revision) || revision < 0) throw requestError('RUNTIME_CRASH', 'bridge returned an invalid document revision')
  return revision
}

function errorCode(error) {
  if (ERROR_CODES.has(error?.code)) return error.code
  const matched = /^([A-Z_]+):/u.exec(error?.message ?? '')
  return matched && ERROR_CODES.has(matched[1]) ? matched[1] : 'RUNTIME_CRASH'
}

function readBody(request) {
  return new Promise((resolveBody, reject) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

async function localAssetState(shell) {
  const remote = /(cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com|huggingface\.co|\.hf\.co)/iu
  const [index, worker] = await Promise.all([
    readFile(resolve(shell, 'index.html'), 'utf8'),
    readFile(resolve(shell, 'sw.js'), 'utf8')
  ])
  if (remote.test(index) || remote.test(worker)) throw new Error('shell contains a remote runtime origin')
  return 'ready'
}

export class OpenPhotoDaemon {
  constructor({
    dataRoot = resolveDataRoot(),
    driverFactory,
    instanceId = randomUUID(),
    assertLease,
    onLeaseLost,
    modelManifest,
    modelManifestPath = DEFAULT_MODEL_LOCK,
    modelRouteManifest,
    modelRouteManifestPath = DEFAULT_MODEL_ROUTE,
    modelInstaller = installModel,
    modelStore,
    modelRouting = null,
    testPipeline
  } = {}) {
    this.dataRoot = resolve(dataRoot)
    this.instanceId = instanceId
    this.artifacts = new ArtifactStore(resolve(this.dataRoot, 'artifacts'))
    this.driverFactory = driverFactory ?? (({ artifacts, modelRouting: routing, testPipeline: pipeline } = {}) => new DocumentDriver({
      artifacts,
      modelRouting: routing,
      ...(pipeline === undefined ? {} : { testPipeline: pipeline })
    }))
    this.assertLease = assertLease
    this.onLeaseLost = onLeaseLost
    this.jobs = new JobStore()
    this.models = modelStore ?? new ModelStore({ dataRoot: this.dataRoot })
    this.modelManifest = modelManifest
    this.modelManifestPath = resolve(modelManifestPath)
    this.modelManifestPromise = null
    this.modelRouteManifest = modelRouteManifest
    this.modelRouteManifestPath = resolve(modelRouteManifestPath)
    this.modelRouteManifestPromise = null
    this.modelRoutingPromise = null
    this.modelInstaller = modelInstaller
    this.modelRouting = modelRouting
    this.testPipeline = testPipeline
    this.installControllers = new Map()
    this.installPromises = new Map()
    this.installSlots = new Map()
    this.documents = new Map()
    this.server = null
    this.closePromise = null
    this.closing = false
    this.closeSignal = new Promise(resolveClose => {
      this.resolveCloseSignal = resolveClose
    })
  }

  capabilities() {
    return { operations: ENABLED_OPERATIONS.slice(), commands: COMMAND_IDS.slice(), formats: ['png', 'jpeg', 'jpg'] }
  }

  async health() {
    let browser
    try {
      browser = await locateBrowser()
    } catch (error) {
      browser = { error: { code: error.code ?? 'BROWSER_NOT_FOUND', message: error.message } }
    }
    const shell = resolve(dirname(fileURLToPath(import.meta.url)), '../assets/openshop')
    let assets = 'ready'
    try {
      await localAssetState(shell)
    } catch (error) {
      assets = { error: error.message }
    }
    return { instanceId: this.instanceId, node: process.version, browser, assets, loopbackOnly: true }
  }

  async enqueueDocument(document, action) {
    const queued = document.queue.then(action)
    document.queue = queued.catch(() => {})
    return queued
  }

  documentFor(documentId) {
    const document = this.documents.get(documentId)
    if (!document || document.closing) throw requestError('NOT_FOUND', 'document not found')
    return document
  }

  async disposeDocument(documentId, document, { suppressErrors = false } = {}) {
    document.closing = true
    if (this.documents.get(documentId) === document) this.documents.delete(documentId)
    for (const job of this.jobs.list(job => job.kind === 'analysis'
      && job.documentId === documentId
      && ['queued', 'waiting_for_model', 'running'].includes(job.status))) {
      this.jobs.transition(job.jobId, 'failed', {
        error: { code: 'NOT_FOUND', message: 'document not found' }
      })
    }
    document.closePromise ??= Promise.resolve().then(() => document.driver?.close())
    try {
      await document.closePromise
    } catch (error) {
      if (!suppressErrors) throw error
    }
  }

  async discardUncommittedDocument(documentId, document) {
    await this.disposeDocument(documentId, document, { suppressErrors: true })
  }

  async openDocument(artifactId) {
    const inputArtifact = await this.artifacts.describe(artifactId)
    const modelRouting = await this.loadModelRouting()
    const driver = await this.driverFactory({
      artifacts: this.artifacts,
      modelRouting,
      ...(this.testPipeline === undefined ? {} : { testPipeline: this.testPipeline })
    })
    if (!driver || typeof driver.open !== 'function' || typeof driver.close !== 'function') {
      throw requestError('RUNTIME_CRASH', 'document driver is invalid')
    }
    try {
      const descriptor = await driver.open({ inputArtifact })
      const revision = revisionFrom(descriptor)
      const documentId = `document-${randomUUID()}`
      await this.verifyLease()
      this.documents.set(documentId, { driver, revision, queue: Promise.resolve(), closing: false, closePromise: null })
      return { documentId, descriptor, revision }
    } catch (error) {
      try {
        await driver.close()
      } catch {
        // The primary browser/bootstrap failure remains the response error.
      }
      throw error
    }
  }

  async inspectDocument(documentId) {
    const document = this.documentFor(documentId)
    return this.enqueueDocument(document, async () => {
      if (document.closing) throw requestError('NOT_FOUND', 'document not found')
      await this.verifyLease()
      const descriptor = await document.driver.inspect()
      const revision = revisionFrom(descriptor)
      try {
        await this.verifyLease()
      } catch (error) {
        await this.discardUncommittedDocument(documentId, document)
        throw error
      }
      document.revision = revision
      return { descriptor, revision: document.revision }
    })
  }

  async mutateDocument(documentId, expectedRevision, commands) {
    const document = this.documentFor(documentId)
    return this.enqueueDocument(document, async () => {
      if (document.closing) throw requestError('NOT_FOUND', 'document not found')
      if (expectedRevision !== document.revision) throw requestError('REVISION_CONFLICT', 'document revision changed')
      await this.verifyLease()
      const result = await document.driver.mutate({ expectedRevision, commands })
      const revision = revisionFrom(result)
      try {
        await this.verifyLease()
      } catch (error) {
        await this.discardUncommittedDocument(documentId, document)
        throw error
      }
      document.revision = revision
      return result
    })
  }

  async renderDocument(documentId, expectedRevision, options) {
    const document = this.documentFor(documentId)
    return this.enqueueDocument(document, async () => {
      if (document.closing) throw requestError('NOT_FOUND', 'document not found')
      if (expectedRevision !== document.revision) throw requestError('REVISION_CONFLICT', 'document revision changed')
      await this.verifyLease()
      try {
        const result = await document.driver.render({ expectedRevision, ...options })
        if (!Buffer.isBuffer(result?.bytes) || !result?.metadata) {
          throw requestError('RUNTIME_CRASH', 'document driver returned an invalid render result')
        }
        await this.verifyLease()
        const artifact = await this.artifacts.put(result.bytes, result.metadata, {
          assertLease: () => this.verifyLease()
        })
        return { artifact }
      } catch (error) {
        if (errorCode(error) === 'RUNTIME_CRASH') await this.discardUncommittedDocument(documentId, document)
        throw error
      }
    })
  }

  async applyArtifact(documentId, expectedRevision, payload) {
    const document = this.documentFor(documentId)
    return this.enqueueDocument(document, async () => {
      if (document.closing) throw requestError('NOT_FOUND', 'document not found')
      if (expectedRevision !== document.revision) throw requestError('REVISION_CONFLICT', 'document revision changed')
      await this.verifyLease()
      try {
        if (typeof document.driver.applyArtifact !== 'function') {
          throw requestError('RUNTIME_CRASH', 'document driver does not support artifact application')
        }
        const artifact = await this.artifacts.describe(payload.artifactId)
        const result = await document.driver.applyArtifact({
          expectedRevision,
          artifact,
          targetObjectId: payload.targetObjectId,
          placement: payload.placement
        })
        const revision = revisionFrom(result)
        try {
          await this.verifyLease()
        } catch (error) {
          await this.discardUncommittedDocument(documentId, document)
          throw error
        }
        document.revision = revision
        return result
      } catch (error) {
        if (errorCode(error) === 'RUNTIME_CRASH') await this.discardUncommittedDocument(documentId, document)
        throw error
      }
    })
  }

  async startAnalysis(documentId, payload) {
    const request = normalizeAnalysisPayload(payload)
    const document = this.documentFor(documentId)
    return this.enqueueDocument(document, async () => {
      if (document.closing) throw requestError('NOT_FOUND', 'document not found')
      if (request.sourceRevision !== document.revision) throw requestError('REVISION_CONFLICT', 'document revision changed')
      const entry = request.modelId === undefined
        ? null
        : assertCompleteModelEntry(modelEntry(await this.loadModelManifest(), request.modelId))
      if (typeof document.driver.captureAnalysisInput !== 'function') {
        throw requestError('RUNTIME_CRASH', 'document driver does not support analysis input capture')
      }
      await this.verifyLease()
      const inputArtifact = await document.driver.captureAnalysisInput({
        objectId: request.objectId,
        assertLease: () => this.verifyLease()
      })
      if (!isArtifactRef(inputArtifact)) throw requestError('RUNTIME_CRASH', 'document driver returned an invalid analysis input artifact')
      await this.verifyLease()
      const jobId = `analysis-${randomUUID()}`
      const job = this.jobs.create({
        kind: 'analysis',
        jobId,
        documentId,
        sourceRevision: request.sourceRevision,
        targetObjectId: request.objectId,
        inputArtifact,
        capability: request.capability,
        ...(request.point === undefined ? {} : { point: request.point }),
        ...(request.factor === undefined ? {} : { factor: request.factor }),
        ...(request.modelId === undefined ? {} : { modelId: request.modelId }),
        status: 'queued'
      })
      if (entry !== null) {
        const cache = await this.cacheStatus(request.modelId, entry)
        if (cache.status !== 'installed') {
          const waiting = this.jobs.transition(jobId, 'waiting_for_model')
          const current = await this.cacheStatus(request.modelId, entry)
          if (current.status !== 'installed') {
            throw requestError(
              'MODEL_DOWNLOAD_REQUIRED',
              'the required local model is not installed',
              modelDownloadDetails(waiting, entry, this.models.cacheRoot)
            )
          }
          this.jobs.transition(jobId, 'queued')
        }
      }
      this.scheduleAnalysis(jobId)
      return { jobId: job.jobId, status: job.status }
    })
  }

  scheduleAnalysis(jobId) {
    void this.runAnalysis(jobId)
  }

  resumeWaitingAnalysis(modelId) {
    const jobs = this.jobs.requeueWaitingForModel(modelId)
    for (const job of jobs) this.scheduleAnalysis(job.jobId)
    return jobs
  }

  async runAnalysis(jobId) {
    const initial = this.jobs.get(jobId)
    if (!initial || initial.kind !== 'analysis' || initial.status !== 'queued') return
    const document = this.documents.get(initial.documentId)
    if (!document || typeof document.driver?.analyze !== 'function') return
    try {
      await this.enqueueDocument(document, async () => {
        const job = this.jobs.get(jobId)
        if (!job || job.kind !== 'analysis' || job.status !== 'queued') return
        if (document.closing) {
          this.jobs.transition(jobId, 'failed', { error: { code: 'NOT_FOUND', message: 'document not found' } })
          return
        }
        try {
          await this.verifyLease()
          const running = this.jobs.transition(jobId, 'running', { error: undefined })
          const entry = running.modelId === undefined
            ? null
            : assertCompleteModelEntry(modelEntry(await this.loadModelManifest(), running.modelId))
          const model = entry === null ? undefined : await this.modelDescriptor(document, running.modelId, entry)
          const result = await document.driver.analyze({
            capability: running.capability,
            inputArtifact: running.inputArtifact,
            assertLease: () => this.verifyLease(),
            ...(running.point === undefined ? {} : { point: running.point }),
            ...(running.factor === undefined ? {} : { factor: running.factor }),
            ...(model === undefined ? {} : { model })
          })
          await this.verifyLease()
          const completed = this.analysisCompletion(result, running)
          this.jobs.transition(jobId, 'completed', { result: completed, error: undefined })
        } catch (error) {
          if (this.closing) return
          try {
            await this.verifyLease()
          } catch {
            return
          }
          const current = this.jobs.get(jobId)
          if (current?.status === 'queued' || current?.status === 'running') {
            this.jobs.transition(jobId, 'failed', { error: recordedError(error) })
          }
        }
      })
    } catch {
      // The document queue remains usable after an earlier request failure.
    }
  }

  analysisCompletion(result, job) {
    if (result?.kind === 'json') return { kind: 'json', value: structuredClone(result.value) }
    if (result?.kind === 'raster' && isArtifactRef(result.artifact)
      && result.targetObjectId === job.targetObjectId
      && ['replace-target', 'add-above-target'].includes(result.placement)) {
      return {
        kind: 'raster',
        artifact: structuredClone(result.artifact),
        targetObjectId: result.targetObjectId,
        placement: result.placement
      }
    }
    throw requestError('RUNTIME_CRASH', 'document driver returned an invalid analysis result')
  }

  analysisJob(jobId) {
    const job = this.jobs.get(jobId)
    if (!job || job.kind !== 'analysis') throw requestError('NOT_FOUND', 'analysis job not found')
    return analysisResult(job)
  }

  async closeDocument(documentId) {
    const document = this.documentFor(documentId)
    document.closing = true
    return this.enqueueDocument(document, async () => {
      await this.disposeDocument(documentId, document)
      return { closed: true }
    })
  }

  async loadModelManifest() {
    if (this.modelManifest !== undefined) {
      if (!requireManifest(this.modelManifest) || this.modelManifest.schemaVersion !== 1) {
        throw modelManifestError('model lock is invalid')
      }
      return this.modelManifest
    }
    this.modelManifestPromise ??= readFile(this.modelManifestPath, 'utf8')
      .then(contents => JSON.parse(contents))
      .catch(error => {
        throw modelManifestError(`could not read model lock: ${error.message}`)
      })
    const manifest = await this.modelManifestPromise
    if (!requireManifest(manifest) || manifest.schemaVersion !== 1) throw modelManifestError('model lock is invalid')
    return manifest
  }

  async loadModelRouteManifest() {
    if (this.modelRouteManifest !== undefined) {
      if (!isPlainObject(this.modelRouteManifest) || this.modelRouteManifest.schemaVersion !== 1) {
        throw modelManifestError('model route is invalid')
      }
      return this.modelRouteManifest
    }
    this.modelRouteManifestPromise ??= readFile(this.modelRouteManifestPath, 'utf8')
      .then(contents => JSON.parse(contents))
      .catch(error => {
        throw modelManifestError(`could not read model route: ${error.message}`)
      })
    const manifest = await this.modelRouteManifestPromise
    if (!isPlainObject(manifest) || manifest.schemaVersion !== 1) throw modelManifestError('model route is invalid')
    return manifest
  }

  async loadModelRouting() {
    if (this.modelRouting !== null) return this.modelRouting
    this.modelRoutingPromise ??= Promise.all([this.loadModelManifest(), this.loadModelRouteManifest()])
      .then(([lock, manifest]) => ({ manifest, lock, modelStore: this.models }))
    return this.modelRoutingPromise
  }

  async modelDescriptor(document, modelId, entry) {
    const routing = await this.loadModelRouting()
    const observation = routing?.manifest?.observations?.[modelId]
    const locked = routing?.lock?.models?.[modelId]
    if (!observation || observation.revision !== entry.revision || locked?.revision !== entry.revision) {
      throw modelManifestError('model route does not match the model lock')
    }
    const localModelPath = document.driver?.modelLocalPath
    if (!isLoopbackModelPath(localModelPath)) throw modelManifestError('model route is unavailable for this document')
    return { id: modelId, revision: entry.revision, localModelPath }
  }

  async cacheStatus(modelId, entry) {
    const cached = await this.models.status(modelId, entry.revision, entry.files)
    return {
      modelId,
      revision: entry.revision,
      status: cached.status === 'installed' ? 'installed' : 'missing'
    }
  }

  installJobsFor(modelId, revision) {
    return this.jobs.list(job => job.kind === 'model-install'
      && job.cacheRoot === this.models.cacheRoot
      && job.modelId === modelId
      && job.revision === revision)
  }

  installSlotKey(modelId, revision) {
    return JSON.stringify([this.models.cacheRoot, modelId, revision])
  }

  async modelStatus(payload) {
    const manifest = await this.loadModelManifest()
    if (payload.installId !== undefined) {
      const job = this.jobs.get(payload.installId)
      if (!job || job.kind !== 'model-install') throw requestError('NOT_FOUND', 'model installation not found')
      const entry = modelEntry(manifest, job.modelId)
      return { cache: [await this.cacheStatus(job.modelId, entry)], installs: [installStatus(job)] }
    }

    if (payload.modelId !== undefined) {
      const entry = modelEntry(manifest, payload.modelId)
      return {
        cache: [await this.cacheStatus(payload.modelId, entry)],
        installs: this.installJobsFor(payload.modelId, entry.revision).map(installStatus)
      }
    }

    const modelIds = Object.keys(manifest.models)
    const entries = modelIds.map(modelId => [modelId, modelEntry(manifest, modelId)])
    return {
      cache: await Promise.all(entries.map(([modelId, entry]) => this.cacheStatus(modelId, entry))),
      installs: this.jobs.list(job => job.kind === 'model-install').map(installStatus)
    }
  }

  async runModelInstall({ installId, modelId, revision, manifest, controller, slotKey, slot }) {
    try {
      await this.modelInstaller({
        manifest,
        modelId,
        cacheRoot: this.models.cacheRoot,
        signal: controller.signal,
        assertLease: () => this.verifyLease(),
        modelStore: this.models
      })
      await this.verifyLease()
      const installed = this.jobs.transition(installId, 'installed', { error: undefined })
      this.resumeWaitingAnalysis(modelId)
      return installed
    } catch (error) {
      const status = errorCode(error) === 'CANCELLED' ? 'cancelled' : 'failed'
      return this.jobs.transition(installId, status, { error: recordedError(error) })
    } finally {
      this.installControllers.delete(installId)
      this.installPromises.delete(installId)
      if (this.installSlots.get(slotKey) === slot) this.installSlots.delete(slotKey)
    }
  }

  async awaitWhileOpen(operation) {
    if (this.closing) throw requestError('RUNTIME_CRASH', 'daemon is closing')
    const pending = Promise.resolve().then(operation)
    return Promise.race([
      pending,
      this.closeSignal.then(() => {
        throw requestError('RUNTIME_CRASH', 'daemon is closing')
      })
    ])
  }

  async prepareModelInstall({ modelId, entry, manifest, slotKey, slot }) {
    if (this.closing) throw requestError('RUNTIME_CRASH', 'daemon is closing')
    const active = this.installJobsFor(modelId, entry.revision).find(job => job.status === 'installing')
    if (active) {
      const cleanup = this.installPromises.get(active.installId)
      if (cleanup) {
        slot.active = true
        void cleanup.then(
          () => {
            if (this.installSlots.get(slotKey) === slot) this.installSlots.delete(slotKey)
          },
          () => {
            if (this.installSlots.get(slotKey) === slot) this.installSlots.delete(slotKey)
          }
        )
      }
      return installResult(active)
    }

    let cache = await this.awaitWhileOpen(() => this.cacheStatus(modelId, entry))
    if (this.closing) throw requestError('RUNTIME_CRASH', 'daemon is closing')
    await this.awaitWhileOpen(() => this.verifyLease())
    if (this.closing) throw requestError('RUNTIME_CRASH', 'daemon is closing')
    if (cache.status === 'missing') {
      const rawStatus = await this.awaitWhileOpen(() => this.models.status(modelId, entry.revision, entry.files))
      if (this.closing) throw requestError('RUNTIME_CRASH', 'daemon is closing')
      if (rawStatus.status === 'installing') {
        await this.awaitWhileOpen(() => this.verifyLease())
        if (this.closing) throw requestError('RUNTIME_CRASH', 'daemon is closing')
        if (rawStatus.installToken) {
          await this.awaitWhileOpen(() => this.models.cleanupFailedInstall(modelId, entry.revision, rawStatus.installToken))
          if (this.closing) throw requestError('RUNTIME_CRASH', 'daemon is closing')
        }
        cache = await this.awaitWhileOpen(() => this.cacheStatus(modelId, entry))
        await this.awaitWhileOpen(() => this.verifyLease())
        if (this.closing) throw requestError('RUNTIME_CRASH', 'daemon is closing')
      }
    }

    if (cache.status === 'installed') {
      const completed = this.installJobsFor(modelId, entry.revision).find(job => job.status === 'installed')
      if (completed) return installResult(completed)
      const installId = `install-${randomUUID()}`
      const job = this.jobs.create({
        kind: 'model-install',
        jobId: installId,
        installId,
        cacheRoot: this.models.cacheRoot,
        modelId,
        revision: entry.revision,
        status: 'installed'
      })
      this.resumeWaitingAnalysis(modelId)
      return installResult(job)
    }

    if (this.closing) throw requestError('RUNTIME_CRASH', 'daemon is closing')
    await this.awaitWhileOpen(() => this.verifyLease())
    if (this.closing) throw requestError('RUNTIME_CRASH', 'daemon is closing')
    const installId = `install-${randomUUID()}`
    const controller = new AbortController()
    const job = this.jobs.create({
      kind: 'model-install',
      jobId: installId,
      installId,
      cacheRoot: this.models.cacheRoot,
      modelId,
      revision: entry.revision,
      status: 'installing'
    })
    slot.active = true
    this.installControllers.set(installId, controller)
    const cleanup = this.runModelInstall({
      installId,
      modelId,
      revision: entry.revision,
      manifest,
      controller,
      slotKey,
      slot
    })
    this.installPromises.set(installId, cleanup)
    void cleanup
    return installResult(job)
  }

  async installModel(modelId) {
    const manifest = await this.awaitWhileOpen(() => this.loadModelManifest())
    const entry = assertCompleteModelEntry(modelEntry(manifest, modelId))
    if (this.closing) throw requestError('RUNTIME_CRASH', 'daemon is closing')
    const slotKey = this.installSlotKey(modelId, entry.revision)
    const existing = this.installSlots.get(slotKey)
    if (existing) return existing.promise

    const slot = { active: false, promise: null }
    slot.promise = this.prepareModelInstall({ modelId, entry, manifest, slotKey, slot })
    this.installSlots.set(slotKey, slot)
    void slot.promise.then(
      () => {
        if (!slot.active && this.installSlots.get(slotKey) === slot) this.installSlots.delete(slotKey)
      },
      () => {
        if (!slot.active && this.installSlots.get(slotKey) === slot) this.installSlots.delete(slotKey)
      }
    )
    return slot.promise
  }

  async cancelModelInstall(installId) {
    const job = this.jobs.get(installId)
    if (!job || job.kind !== 'model-install') throw requestError('NOT_FOUND', 'model installation not found')
    if (job.status !== 'installing') return cancelResult(job)

    const controller = this.installControllers.get(installId)
    const cleanup = this.installPromises.get(installId)
    if (!controller || !cleanup) {
      const terminal = this.jobs.get(installId)
      if (terminal && terminal.status !== 'installing') return cancelResult(terminal)
      throw requestError('RUNTIME_CRASH', 'model installation lost its cleanup handle')
    }
    controller.abort()
    await cleanup
    const terminal = this.jobs.get(installId)
    if (!terminal) throw requestError('NOT_FOUND', 'model installation not found')
    return cancelResult(terminal)
  }

  async verifyLease() {
    try {
      await this.assertLease?.()
    } catch (error) {
      if (error?.code === 'RUNTIME_CRASH') void this.onLeaseLost?.()
      throw error
    }
  }

  async dispatch(request) {
    try {
      await this.verifyLease()
    } catch (error) {
      return responseError(request?.requestId ?? null, errorCode(error), error.message)
    }
    try {
      requestSchema(request)
    } catch (error) {
      return responseError(request?.requestId ?? null, 'INVALID_REQUEST', error.message)
    }
    try {
      if (!ENABLED_OPERATIONS.includes(request.op)) return responseError(request.requestId, 'UNSUPPORTED_CAPABILITY', `${request.op} is not enabled in this runtime milestone`)
      if (request.op === 'runtime.capabilities') return { requestId: request.requestId, ok: true, result: this.capabilities() }
      if (request.op === 'runtime.health') {
        const result = await this.health()
        await this.verifyLease()
        return { requestId: request.requestId, ok: true, result }
      }
      if (request.op === 'artifact.import') {
        const result = await this.artifacts.import(request.payload.sourcePath, { assertLease: () => this.verifyLease() })
        return { requestId: request.requestId, ok: true, result }
      }
      if (request.op === 'artifact.read') {
        const result = await this.artifacts.describe(request.payload.artifactId)
        await this.verifyLease()
        return { requestId: request.requestId, ok: true, result }
      }
      if (request.op === 'model.status') {
        const result = await this.modelStatus(request.payload)
        await this.verifyLease()
        return { requestId: request.requestId, ok: true, result }
      }
      if (request.op === 'model.install') {
        const result = await this.installModel(request.payload.modelId)
        return { requestId: request.requestId, ok: true, result }
      }
      if (request.op === 'model.install.cancel') {
        const result = await this.cancelModelInstall(request.payload.installId)
        return { requestId: request.requestId, ok: true, result }
      }
      if (request.op === 'document.open') {
        const result = await this.openDocument(request.payload.artifactId)
        return { requestId: request.requestId, ok: true, result }
      }
      if (request.op === 'document.inspect') {
        const result = await this.inspectDocument(request.documentId)
        return { requestId: request.requestId, ok: true, result }
      }
      if (request.op === 'document.mutate') {
        const commands = normalizeCommands(request.payload.commands)
        const result = await this.mutateDocument(request.documentId, request.expectedRevision, commands)
        return { requestId: request.requestId, ok: true, result }
      }
      if (request.op === 'document.renderArtifact') {
        const options = normalizeRenderPayload(request.payload)
        const result = await this.renderDocument(request.documentId, request.expectedRevision, options)
        return { requestId: request.requestId, ok: true, result }
      }
      if (request.op === 'document.applyArtifact') {
        const result = await this.applyArtifact(request.documentId, request.expectedRevision, request.payload)
        return { requestId: request.requestId, ok: true, result }
      }
      if (request.op === 'ai.analyze.start') {
        const result = await this.startAnalysis(request.documentId, request.payload)
        return { requestId: request.requestId, ok: true, result }
      }
      if (request.op === 'ai.job.get') {
        const result = this.analysisJob(request.payload.jobId)
        await this.verifyLease()
        return { requestId: request.requestId, ok: true, result }
      }
      if (request.op === 'document.close') {
        const result = await this.closeDocument(request.documentId)
        return { requestId: request.requestId, ok: true, result }
      }
      return responseError(request.requestId, 'UNSUPPORTED_CAPABILITY', `${request.op} is not enabled in this runtime milestone`)
    } catch (error) {
      return responseError(request?.requestId ?? null, errorCode(error), error.message, error.details)
    }
  }

  async listen({ host = '127.0.0.1', port = 0 } = {}) {
    if (host !== '127.0.0.1') throw new Error('daemon only accepts the 127.0.0.1 loopback host')
    if (this.server) throw new Error('daemon is already listening')
    this.server = createServer(async (request, response) => {
      if (request.method !== 'POST' || new URL(request.url, 'http://127.0.0.1').pathname !== '/rpc') {
        response.writeHead(404).end()
        return
      }
      const body = await readBody(request)
      const lines = body.split(/\r?\n/u).filter(Boolean)
      const responses = []
      for (const line of lines) {
        try {
          responses.push(await this.dispatch(JSON.parse(line)))
        } catch (error) {
          responses.push(responseError(null, 'INVALID_REQUEST', error.message))
        }
      }
      response.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8' })
      response.end(responses.map(item => JSON.stringify(item)).join('\n') + (responses.length ? '\n' : ''))
    })
    await new Promise((resolveListen, reject) => {
      this.server.once('error', reject)
      this.server.listen(port, host, () => {
        this.server.off('error', reject)
        resolveListen()
      })
    })
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('daemon did not bind a TCP port')
    return { host, port: address.port }
  }

  async close() {
    if (this.closePromise) return this.closePromise
    this.closePromise = this.closeAll()
    return this.closePromise
  }

  async closeAll() {
    const failures = []
    this.closing = true
    this.resolveCloseSignal?.()
    for (const controller of this.installControllers.values()) controller.abort()
    while (true) {
      const installers = [...this.installPromises.values()]
      const preparations = [...this.installSlots.values()].map(slot => slot.promise).filter(Boolean)
      if (installers.length === 0 && preparations.length === 0) break
      const installerResults = await Promise.allSettled(installers)
      await Promise.allSettled(preparations)
      for (const installer of installerResults) {
        if (installer.status === 'rejected') failures.push(installer.reason)
      }
    }
    this.installControllers.clear()
    this.installPromises.clear()
    this.installSlots.clear()
    const documents = [...this.documents.entries()]
    await Promise.all(documents.map(async ([documentId, document]) => {
      try {
        await this.disposeDocument(documentId, document)
      } catch (error) {
        failures.push(error)
      }
    }))
    this.documents.clear()
    this.jobs.clear()
    if (this.server) {
      const server = this.server
      this.server = null
      try {
        await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()))
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length) throw new AggregateError(failures, 'OpenPhoto daemon cleanup failed')
  }
}

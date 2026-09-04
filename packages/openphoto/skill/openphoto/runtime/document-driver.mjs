import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { imageMetadataFor } from './artifact-store.mjs'
import { openDocument } from './browser.mjs'
import { ERROR_CODES } from './protocol.mjs'
import { createStaticServer } from './static-server.mjs'

function failure(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code })
}

function nameForArtifact(artifact) {
  const extension = artifact.mimeType === 'image/jpeg' ? 'jpg' : 'png'
  return `${artifact.artifactId}.${extension}`
}

function dataUrlBytes(value) {
  const match = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=\s]+)$/u.exec(String(value ?? ''))
  if (!match) throw failure('ARTIFACT_INVALID', 'bridge returned an invalid image data URL')
  const bytes = Buffer.from(match[2].replace(/\s/g, ''), 'base64')
  if (!bytes.byteLength) throw failure('ARTIFACT_INVALID', 'bridge returned an empty image')
  return { mimeType: match[1], bytes }
}

function imageForDataUrl(value) {
  const { mimeType, bytes } = dataUrlBytes(value)
  const metadata = imageMetadataFor(bytes)
  if (metadata.mimeType !== mimeType) throw failure('ARTIFACT_INVALID', 'bridge output format does not match its data')
  return { bytes, metadata }
}

function dataUrlForImage(bytes) {
  const metadata = imageMetadataFor(bytes)
  if (!['image/png', 'image/jpeg'].includes(metadata.mimeType)) throw failure('ARTIFACT_INVALID', 'artifact is not a PNG or JPEG image')
  return `data:${metadata.mimeType};base64,${bytes.toString('base64')}`
}

function initScriptForTestPipeline(testPipeline) {
  return `window.__OPENPHOTO_TEST_PIPELINE__ = (${testPipeline.toString()})`
}

export class DocumentDriver {
  #browser = null
  #staticServer = null
  #modelLocalPath = null

  constructor({
    artifacts,
    assetRoot = resolve(fileURLToPath(new URL('../assets', import.meta.url))),
    createServer = createStaticServer,
    openBrowser = openDocument,
    modelRouting = null,
    testPipeline
  } = {}) {
    if (!artifacts) throw new Error('artifacts is required')
    if (testPipeline !== undefined && process.env.NODE_ENV !== 'test') {
      throw failure('INVALID_REQUEST', 'testPipeline is only available when NODE_ENV=test')
    }
    if (testPipeline !== undefined && typeof testPipeline !== 'function') {
      throw failure('INVALID_REQUEST', 'testPipeline must be a function')
    }
    this.artifacts = artifacts
    this.assetRoot = resolve(assetRoot)
    this.createServer = createServer
    this.openBrowser = openBrowser
    this.modelRouting = modelRouting
    this.testPipeline = testPipeline
  }

  get modelLocalPath() {
    return this.#modelLocalPath
  }

  #page() {
    if (!this.#browser?.page) throw failure('NOT_FOUND', 'document browser is not open')
    return this.#browser.page
  }

  async #bridgeCall(method, value) {
    const outcome = await this.#page().evaluate(async ({ method, value }) => {
      try {
        const bridge = window.__openphoto
        if (!bridge) throw new Error('OpenPhoto bridge is unavailable')
        let result
        switch (method) {
          case 'open': {
            const binary = atob(value.base64)
            const imageBytes = new Uint8Array(binary.length)
            for (let index = 0; index < binary.length; index += 1) imageBytes[index] = binary.charCodeAt(index)
            result = bridge.open({ blob: new Blob([imageBytes], { type: value.mimeType }), name: value.name })
            break
          }
          case 'inspect':
            result = bridge.inspect()
            break
          case 'mutate':
            result = bridge.mutate(value)
            break
          case 'render':
            result = bridge.render(value)
            break
          case 'captureInput':
            result = bridge.captureInput(value)
            break
          case 'analyze':
            result = bridge.analyze(value)
            break
          case 'apply':
            result = bridge.apply(value)
            break
          default:
            throw new Error(`unsupported bridge method: ${method}`)
        }
        return { ok: true, result: await result }
      } catch (error) {
        return {
          ok: false,
          error: {
            code: typeof error?.code === 'string' ? error.code : null,
            message: String(error?.message || error)
          }
        }
      }
    }, { method, value })
    if (!outcome?.ok) {
      const code = ERROR_CODES.has(outcome?.error?.code) ? outcome.error.code : 'RUNTIME_CRASH'
      throw failure(code, outcome?.error?.message || 'bridge call failed')
    }
    return outcome.result
  }

  async open({ inputArtifact }) {
    if (this.#browser || this.#staticServer) throw failure('BUSY', 'document is already open')
    if (!inputArtifact?.artifactId || !['image/png', 'image/jpeg'].includes(inputArtifact.mimeType)) {
      throw failure('ARTIFACT_INVALID', 'document input must be a PNG or JPEG artifact')
    }

    const inputBytes = await this.artifacts.read(inputArtifact.artifactId)
    const metadata = imageMetadataFor(inputBytes)
    if (metadata.mimeType !== inputArtifact.mimeType || metadata.width !== inputArtifact.width || metadata.height !== inputArtifact.height) {
      throw failure('ARTIFACT_INVALID', 'document input metadata does not match its content')
    }

    try {
      this.#staticServer = this.createServer({
        assetRoot: this.assetRoot,
        ...(this.modelRouting === null ? {} : { modelRouting: this.modelRouting })
      })
      const address = await this.#staticServer.listen()
      this.#modelLocalPath = address.modelLocalPath ?? null
      this.#browser = await this.openBrowser({
        baseUrl: address.url,
        ...(this.testPipeline === undefined ? {} : { initScript: initScriptForTestPipeline(this.testPipeline) })
      })
      await this.#page().waitForFunction(() => document.documentElement.dataset.openphotoReady === 'true'
        && document.documentElement.dataset.osBoot === 'ready'
        && typeof window.__openphoto?.open === 'function')
      return await this.#bridgeCall('open', {
        base64: inputBytes.toString('base64'),
        mimeType: inputArtifact.mimeType,
        name: basename(nameForArtifact(inputArtifact))
      })
    } catch (error) {
      try {
        await this.close()
      } catch {
        // Preserve the original page/bootstrap failure for the daemon response.
      }
      throw error
    }
  }

  async inspect() {
    return this.#bridgeCall('inspect', {})
  }

  async mutate({ expectedRevision, commands }) {
    return this.#bridgeCall('mutate', { expectedRevision, commands })
  }

  async render({ expectedRevision, format, quality, matte }) {
    const result = await this.#bridgeCall('render', {
      expectedRevision,
      format,
      ...(quality === undefined ? {} : { quality }),
      ...(matte === undefined ? {} : { matte })
    })
    const { bytes, metadata } = imageForDataUrl(result?.dataUrl)
    const normalizedFormat = format === 'jpg' ? 'jpeg' : format
    const expectedMimeType = normalizedFormat === 'jpeg' ? 'image/jpeg' : 'image/png'
    if (metadata.mimeType !== expectedMimeType) {
      throw failure('ARTIFACT_INVALID', 'bridge output format does not match its data')
    }
    return { bytes, metadata }
  }

  async captureAnalysisInput({ objectId, assertLease }) {
    const result = await this.#bridgeCall('captureInput', { objectId })
    const { bytes, metadata } = imageForDataUrl(result?.dataUrl)
    if (typeof result?.targetObjectId !== 'string' || result.targetObjectId.length === 0
      || result.width !== metadata.width || result.height !== metadata.height) {
      throw failure('RUNTIME_CRASH', 'bridge returned invalid analysis input metadata')
    }
    const artifact = await this.artifacts.put(bytes, metadata, { assertLease })
    return { ...artifact, targetObjectId: result.targetObjectId, width: metadata.width, height: metadata.height }
  }

  async analyze({ capability, inputArtifact, point, factor, model, assertLease }) {
    if (!inputArtifact?.artifactId || typeof inputArtifact.targetObjectId !== 'string' || inputArtifact.targetObjectId.length === 0
      || !Number.isSafeInteger(inputArtifact.width) || inputArtifact.width < 1
      || !Number.isSafeInteger(inputArtifact.height) || inputArtifact.height < 1) {
      throw failure('ARTIFACT_INVALID', 'analysis input artifact is required')
    }
    const inputBytes = await this.artifacts.read(inputArtifact.artifactId)
    const metadata = imageMetadataFor(inputBytes)
    if (metadata.width !== inputArtifact.width || metadata.height !== inputArtifact.height) {
      throw failure('ARTIFACT_INVALID', 'analysis input metadata does not match its content')
    }
    const input = {
      dataUrl: dataUrlForImage(inputBytes),
      width: inputArtifact.width,
      height: inputArtifact.height,
      targetObjectId: inputArtifact.targetObjectId
    }
    const result = await this.#bridgeCall('analyze', {
      capability,
      input,
      ...(point === undefined ? {} : { point }),
      ...(factor === undefined ? {} : { factor }),
      ...(model === undefined ? {} : { model })
    })
    if (result?.kind === 'json') return { kind: 'json', value: result.value }
    if (result?.kind !== 'raster') throw failure('RUNTIME_CRASH', 'bridge returned an invalid analysis result')
    const output = imageForDataUrl(result.dataUrl)
    const artifact = await this.artifacts.put(output.bytes, output.metadata, { assertLease })
    return {
      kind: 'raster',
      artifact,
      targetObjectId: result.targetObjectId,
      placement: result.placement
    }
  }

  async applyArtifact({ expectedRevision, artifact, targetObjectId, placement }) {
    if (!artifact?.artifactId) throw failure('ARTIFACT_INVALID', 'artifact is required')
    const dataUrl = dataUrlForImage(await this.artifacts.read(artifact.artifactId))
    return this.#bridgeCall('apply', { expectedRevision, dataUrl, targetObjectId, placement })
  }

  async close() {
    const browser = this.#browser
    const staticServer = this.#staticServer
    this.#browser = null
    this.#staticServer = null
    this.#modelLocalPath = null
    const results = await Promise.allSettled([browser, staticServer]
      .filter(Boolean)
      .map(resource => Promise.resolve().then(() => resource.close())))
    const rejected = results.find(result => result.status === 'rejected')
    if (rejected) throw rejected.reason
  }
}

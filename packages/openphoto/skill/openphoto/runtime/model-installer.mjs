import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, posix, relative, resolve } from 'node:path'
import { ModelStore } from './model-store.mjs'

const SHA256 = /^[a-f0-9]{64}$/u

function installerError(code, message, cause) {
  return Object.assign(new Error(`${code}: ${message}`, cause === undefined ? {} : { cause }), { code })
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

function incompleteManifest(message) {
  return installerError('MODEL_MANIFEST_INCOMPLETE', message)
}

function requireHttpUrl(value, field) {
  if (!nonEmptyString(value)) throw incompleteManifest(`${field} is required`)
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw incompleteManifest(`${field} must be an HTTP URL`)
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw incompleteManifest(`${field} must be an HTTP URL`)
  return value
}

function resolveManifestPath(root, value) {
  if (!nonEmptyString(value) || value.includes('\\') || value.includes('\0') || posix.isAbsolute(value)) {
    throw incompleteManifest('model file path must be a relative slash-separated path')
  }
  const segments = value.split('/')
  if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
    throw incompleteManifest('model file path must not contain empty, dot, or parent segments')
  }
  const path = resolve(root, ...segments)
  const pathFromRoot = relative(root, path)
  if (!pathFromRoot || pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) {
    throw incompleteManifest('model file path escapes the installation directory')
  }
  return path
}

function validateManifest(manifest, modelId) {
  if (!isPlainObject(manifest) || !isPlainObject(manifest.models)) throw incompleteManifest('models manifest is required')
  if (!nonEmptyString(modelId) || !Object.hasOwn(manifest.models, modelId)) throw incompleteManifest('model is not present in the manifest')

  const model = manifest.models[modelId]
  if (!isPlainObject(model)) throw incompleteManifest('model manifest entry is invalid')
  if (!nonEmptyString(model.revision)) throw incompleteManifest('model revision is required')
  requireHttpUrl(model.source, 'model source')
  if (!nonEmptyString(model.license)) throw incompleteManifest('model license is required')
  if (!Array.isArray(model.files) || model.files.length === 0) throw incompleteManifest('model files are required')

  const paths = new Set()
  const files = model.files.map((file, index) => {
    if (!isPlainObject(file)) throw incompleteManifest(`model file ${index} is invalid`)
    if (!nonEmptyString(file.path)) throw incompleteManifest(`model file ${index} path is required`)
    if (paths.has(file.path)) throw incompleteManifest(`model file ${index} path is duplicated`)
    paths.add(file.path)
    requireHttpUrl(file.url, `model file ${index} URL`)
    if (!Number.isSafeInteger(file.bytes) || file.bytes <= 0) throw incompleteManifest(`model file ${index} byte size is invalid`)
    if (typeof file.sha256 !== 'string' || !SHA256.test(file.sha256)) throw incompleteManifest(`model file ${index} SHA-256 is invalid`)
    return { path: file.path, url: file.url, bytes: file.bytes, sha256: file.sha256 }
  })

  return { revision: model.revision, files }
}

function cancellationError() {
  return installerError('CANCELLED', 'model installation was cancelled')
}

async function assertActive(signal, assertLease) {
  if (signal?.aborted) throw cancellationError()
  await assertLease()
  if (signal?.aborted) throw cancellationError()
}

async function cleanupFailedInstall({ store, modelId, revision, installToken, temporaryPaths, installStarted, assertLease }) {
  await Promise.allSettled([...temporaryPaths].map(path => rm(path, { force: true })))
  if (!installStarted) return
  try {
    // A fenced-out daemon may only remove its UUID-named temporary files; the store
    // cleanup below is scoped to this install token.
    await assertLease()
  } catch {
    return
  }
  if (installToken) await store.cleanupFailedInstall(modelId, revision, installToken).catch(() => {})
}

async function writeAll(handle, bytes, position, signal, assertLease) {
  let offset = 0
  while (offset < bytes.byteLength) {
    await assertActive(signal, assertLease)
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, position + offset)
    if (!bytesWritten) throw installerError('MODEL_DOWNLOAD_FAILED', 'could not write model file')
    offset += bytesWritten
    await assertActive(signal, assertLease)
  }
}

async function downloadFile({ file, temporaryPath, signal, assertLease }) {
  await assertActive(signal, assertLease)
  let response
  try {
    response = await fetch(file.url, { signal })
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw cancellationError()
    throw installerError('MODEL_DOWNLOAD_FAILED', `could not download ${file.path}`, error)
  }
  if (!response.ok || !response.body) {
    throw installerError('MODEL_DOWNLOAD_FAILED', `could not download ${file.path}: HTTP ${response.status}`)
  }
  await assertActive(signal, assertLease)

  const reader = response.body.getReader()
  const hash = createHash('sha256')
  let handle
  let byteSize = 0
  let responseComplete = false
  try {
    handle = await open(temporaryPath, 'wx')
    await assertActive(signal, assertLease)
    while (true) {
      await assertActive(signal, assertLease)
      let next
      try {
        next = await reader.read()
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') throw cancellationError()
        throw error
      }
      if (next.done) {
        responseComplete = true
        break
      }
      const chunk = Buffer.from(next.value)
      if (byteSize + chunk.byteLength > file.bytes) {
        throw installerError('MODEL_DOWNLOAD_FAILED', `${file.path} exceeds its declared byte size`)
      }
      await writeAll(handle, chunk, byteSize, signal, assertLease)
      byteSize += chunk.byteLength
      hash.update(chunk)
      await assertActive(signal, assertLease)
    }
    await handle.sync()
  } finally {
    if (!responseComplete) {
      try {
        await reader.cancel()
      } catch {
        // A cancellation race with fetch is harmless here.
      }
    }
    try {
      reader.releaseLock()
    } catch {
      // The response body may already have been aborted by fetch.
    }
    await handle?.close()
  }

  if (byteSize !== file.bytes) {
    throw installerError('MODEL_DOWNLOAD_FAILED', `${file.path} byte size does not match the manifest`)
  }
  if (hash.digest('hex') !== file.sha256) {
    throw installerError('MODEL_DOWNLOAD_FAILED', `${file.path} SHA-256 does not match the manifest`)
  }
  await assertActive(signal, assertLease)
  return { path: file.path, bytes: byteSize, sha256: file.sha256 }
}

function assertModelStore(store) {
  if (!store || typeof store.status !== 'function' || typeof store.beginInstall !== 'function' || typeof store.completeInstall !== 'function' || typeof store.cleanupFailedInstall !== 'function') {
    throw new Error('modelStore must implement status, beginInstall, completeInstall, and cleanupFailedInstall')
  }
  return store
}

function normalizeInstallError(error, signal) {
  if (error?.code === 'MODEL_MANIFEST_INCOMPLETE' || error?.code === 'MODEL_DOWNLOAD_FAILED' || error?.code === 'RUNTIME_CRASH') return error
  if (signal?.aborted || error?.code === 'CANCELLED' || error?.name === 'AbortError') return cancellationError()
  return installerError('MODEL_DOWNLOAD_FAILED', 'model installation failed', error)
}

export async function installModel({ manifest, modelId, cacheRoot, signal, assertLease = () => {}, modelStore } = {}) {
  const model = validateManifest(manifest, modelId)
  if (!nonEmptyString(cacheRoot)) throw new Error('cacheRoot is required')
  if (typeof assertLease !== 'function') throw new Error('assertLease must be a function')
  const store = assertModelStore(modelStore ?? new ModelStore({ cacheRoot }))
  const resolvedCacheRoot = resolve(cacheRoot)
  if (!nonEmptyString(store.cacheRoot) || resolve(store.cacheRoot) !== resolvedCacheRoot) {
    throw new Error('modelStore cacheRoot does not match the requested cacheRoot')
  }
  const temporaryPaths = new Set()
  let installStarted = false
  let installToken
  let published = false

  try {
    await assertActive(signal, assertLease)
    const existing = await store.status(modelId, model.revision, model.files)
    if (existing?.status === 'installed') {
      return { ...existing, revision: existing.revision ?? model.revision }
    }
    if (existing?.status === 'installing') throw installerError('MODEL_DOWNLOAD_FAILED', 'model installation is already in progress')

    await assertActive(signal, assertLease)
    const installation = await store.beginInstall(modelId, model.revision)
    installStarted = true
    if (!nonEmptyString(installation?.installDir) || !nonEmptyString(installation?.installToken)) throw new Error('model store returned an invalid installation owner')
    installToken = installation.installToken
    await assertActive(signal, assertLease)
    const installDir = resolve(installation.installDir)
    const installDirFromCacheRoot = relative(resolvedCacheRoot, installDir)
    if (!installDirFromCacheRoot || installDirFromCacheRoot.startsWith('..') || isAbsolute(installDirFromCacheRoot)) {
      throw new Error('model store installation directory escapes cache root')
    }

    const verifiedFiles = []
    for (const file of model.files) {
      const destination = resolveManifestPath(installDir, file.path)
      const temporaryPath = resolve(`${destination}.${randomUUID()}.part`)
      if (relative(installDir, temporaryPath).startsWith('..') || isAbsolute(relative(installDir, temporaryPath))) {
        throw new Error('model temporary path escapes installation directory')
      }
      temporaryPaths.add(temporaryPath)
      await assertActive(signal, assertLease)
      await mkdir(dirname(destination), { recursive: true })
      await assertActive(signal, assertLease)
      const verified = await downloadFile({ file, temporaryPath, signal, assertLease })
      await assertActive(signal, assertLease)
      await rename(temporaryPath, destination)
      temporaryPaths.delete(temporaryPath)
      await assertActive(signal, assertLease)
      verifiedFiles.push(verified)
    }

    // ModelStore writes installed.json and atomically promotes the completed directory.
    await assertActive(signal, assertLease)
    const installed = await store.completeInstall(modelId, model.revision, verifiedFiles, installToken)
    published = true
    return { ...installed, revision: installed.revision ?? model.revision }
  } catch (error) {
    if (!published) {
      await cleanupFailedInstall({ store, modelId, revision: model.revision, installToken, temporaryPaths, installStarted, assertLease })
    }
    throw normalizeInstallError(error, signal)
  }
}

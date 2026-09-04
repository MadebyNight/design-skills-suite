import { createReadStream } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join, relative, resolve, isAbsolute } from 'node:path'

function modelKey(modelId) {
  if (typeof modelId !== 'string' || modelId.length === 0) throw new Error('modelId is required')
  return createHash('sha256').update(modelId).digest('hex')
}

function revisionKey(revision) {
  if (typeof revision !== 'string' || revision.length === 0) throw new Error('revision is required')
  return createHash('sha256').update(revision).digest('hex')
}

function assertWithin(root, candidate) {
  const path = resolve(candidate)
  const pathFromRoot = relative(root, path)
  if (!pathFromRoot || pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) throw new Error('model path escapes cache root')
  return path
}

function installToken(value = randomUUID()) {
  if (typeof value !== 'string' || !value || value.includes('/') || value.includes('\\') || value === '.' || value === '..') {
    throw new Error('install token is invalid')
  }
  return value
}

function isRelativeModelPath(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\\')
    && !isAbsolute(value) && !value.split('/').some(segment => !segment || segment === '.' || segment === '..')
}

function hasExpectedFiles(files, expectedFiles) {
  if (expectedFiles === undefined) return true
  if (!Array.isArray(files) || !Array.isArray(expectedFiles) || files.length !== expectedFiles.length) return false
  const expectedByPath = new Map()
  for (const file of expectedFiles) {
    if (!file || !isRelativeModelPath(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes <= 0
      || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(file.sha256) || expectedByPath.has(file.path)) {
      return false
    }
    expectedByPath.set(file.path, file)
  }
  const actualPaths = new Set()
  return files.every(file => {
    const expected = expectedByPath.get(file?.path)
    if (typeof file?.path !== 'string' || actualPaths.has(file.path)) return false
    actualPaths.add(file.path)
    return expected !== undefined && file.bytes === expected.bytes && file.sha256 === expected.sha256
  })
}

async function hasVerifiedContents(installedDir, expectedFiles) {
  if (expectedFiles === undefined) return true
  try {
    for (const file of expectedFiles) {
      const path = assertWithin(installedDir, resolve(installedDir, ...file.path.split('/')))
      const info = await stat(path)
      if (!info.isFile() || info.size !== file.bytes) return false
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(path)) hash.update(chunk)
      if (hash.digest('hex') !== file.sha256) return false
    }
    return true
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false
    throw error
  }
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

export class ModelStore {
  constructor({ dataRoot = process.env.OPENPHOTO_DATA_DIR, cacheRoot } = {}) {
    const localAppData = process.env.LOCALAPPDATA
    if (cacheRoot !== undefined) {
      if (typeof cacheRoot !== 'string' || cacheRoot.length === 0) throw new Error('cacheRoot must be a non-empty path')
      this.cacheRoot = resolve(cacheRoot)
      this.dataRoot = dataRoot ? resolve(dataRoot) : resolve(this.cacheRoot, '..')
      return
    }
    if (!dataRoot && !localAppData) throw new Error('OPENPHOTO_DATA_DIR or LOCALAPPDATA is required')
    this.dataRoot = resolve(dataRoot || join(localAppData, 'OpenPhoto'))
    this.cacheRoot = resolve(this.dataRoot, 'models')
  }

  pathsFor(modelId, revision) {
    const key = modelKey(modelId)
    const modelRoot = assertWithin(this.cacheRoot, resolve(this.cacheRoot, key))
    if (revision === undefined) {
      return {
        installedDir: modelRoot,
        installingDir: assertWithin(this.cacheRoot, resolve(this.cacheRoot, `${key}.installing`)),
        key,
        revision: undefined
      }
    }
    const versionKey = revisionKey(revision)
    return {
      installedDir: assertWithin(this.cacheRoot, resolve(modelRoot, versionKey)),
      installingDir: assertWithin(this.cacheRoot, resolve(modelRoot, `${versionKey}.installing`)),
      key,
      revision
    }
  }

  async status(modelId, revision, expectedFiles) {
    const { installedDir, installingDir } = this.pathsFor(modelId, revision)
    try {
      const installed = JSON.parse(await readFile(resolve(installedDir, 'installed.json'), 'utf8'))
      if (installed.modelId !== modelId) throw new Error('model cache metadata mismatch')
      if ((revision === undefined || installed.revision === revision)
        && hasExpectedFiles(installed.files, expectedFiles)
        && await hasVerifiedContents(installedDir, expectedFiles)) {
        return { modelId, status: 'installed', ...installed }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    let entries
    try {
      entries = await readdir(installingDir, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') return { modelId, ...(revision === undefined ? {} : { revision }), status: 'missing' }
      throw error
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const candidate = assertWithin(installingDir, resolve(installingDir, entry.name))
      try {
        const marker = JSON.parse(await readFile(resolve(candidate, '.openphoto-installing'), 'utf8'))
        if (marker?.modelId !== modelId || (revision !== undefined && marker.revision !== revision)) continue
        return {
          modelId,
          ...(revision === undefined ? {} : { revision }),
          status: 'installing',
          ...(typeof marker.installToken === 'string' ? { installToken: marker.installToken } : {}),
          installDir: candidate
        }
      } catch (error) {
        if (error?.code !== 'ENOENT' && error instanceof SyntaxError === false) throw error
      }
    }
    return { modelId, ...(revision === undefined ? {} : { revision }), status: 'missing' }
  }

  async beginInstall(modelId, revision, requestedToken) {
    const { installingDir } = this.pathsFor(modelId, revision)
    const token = installToken(requestedToken)
    const installDir = assertWithin(installingDir, resolve(installingDir, token))
    await mkdir(installDir, { recursive: true })
    await writeFile(resolve(installDir, '.openphoto-installing'), JSON.stringify({
      modelId,
      ...(revision === undefined ? {} : { revision }),
      installToken: token
    }) + '\n')
    return { modelId, ...(revision === undefined ? {} : { revision }), installToken: token, installDir }
  }

  async completeInstall(modelId, revision, files, requestedToken) {
    if (Array.isArray(revision) && files === undefined) {
      files = revision
      revision = undefined
    }
    if (!Array.isArray(files)) throw new Error('files must be an array')
    const { installedDir, installingDir } = this.pathsFor(modelId, revision)
    let token = requestedToken
    if (token === undefined) token = (await this.status(modelId, revision)).installToken
    token = installToken(token)
    const installDir = assertWithin(installingDir, resolve(installingDir, token))
    const markerPath = resolve(installDir, '.openphoto-installing')
    let marker
    try {
      marker = JSON.parse(await readFile(markerPath, 'utf8'))
    } catch (error) {
      throw new Error(`model installation owner marker is unavailable: ${error.message}`)
    }
    if (marker.modelId !== modelId || marker.installToken !== token || (revision !== undefined && marker.revision !== revision)) {
      throw new Error('model installation owner mismatch')
    }
    const record = { modelId, ...(revision === undefined ? {} : { revision }), files, installedAt: new Date().toISOString() }
    await writeFile(resolve(installDir, 'installed.json'), JSON.stringify(record, null, 2) + '\n')
    await rm(markerPath, { force: true })
    try {
      await rename(installDir, installedDir)
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error?.code) || !(await isDirectory(installedDir))) throw error
      const existing = await this.status(modelId, revision, files)
      if (existing.status === 'installed') {
        await rm(installDir, { recursive: true, force: true })
        return existing
      }
      if (existing.status !== 'missing') throw error
      await rm(installedDir, { recursive: true, force: true })
      await rename(installDir, installedDir)
    }
    await rmdir(installingDir).catch(error => {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error?.code)) throw error
    })
    return { modelId, status: 'installed', ...record }
  }

  async cleanupFailedInstall(modelId, revision, requestedToken) {
    const { installingDir } = this.pathsFor(modelId, revision)
    if (requestedToken === undefined) return
    const token = installToken(requestedToken)
    const installDir = assertWithin(installingDir, resolve(installingDir, token))
    await rm(installDir, { recursive: true, force: true })
    await rmdir(installingDir).catch(error => {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error?.code)) throw error
    })
  }
}

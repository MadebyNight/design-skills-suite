import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { extname, isAbsolute, relative, resolve } from 'node:path'

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const ARTIFACT_ID = /^[a-f0-9]{64}$/u

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function assertWithin(root, candidate) {
  const path = resolve(candidate)
  const pathFromRoot = relative(root, path)
  if (!pathFromRoot || pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) throw new Error('artifact path escapes store root')
  return path
}

function extensionFor(mimeType) {
  if (mimeType === 'image/png') return 'png'
  if (mimeType === 'image/jpeg') return 'jpg'
  throw new Error('ARTIFACT_INVALID: unsupported MIME type')
}

function dimensionsForPng(bytes) {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.subarray(12, 16).toString('ascii') !== 'IHDR') {
    throw new Error('ARTIFACT_INVALID: invalid PNG')
  }
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  if (!width || !height) throw new Error('ARTIFACT_INVALID: invalid PNG dimensions')
  return { mimeType: 'image/png', width, height }
}

function dimensionsForJpeg(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('ARTIFACT_INVALID: invalid JPEG')
  const sofMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])
  let index = 2
  while (index < bytes.length) {
    while (bytes[index] === 0xff) index++
    const marker = bytes[index++]
    if (marker === 0xd9 || marker === 0xda) break
    if (index + 1 >= bytes.length) break
    const length = bytes.readUInt16BE(index)
    if (length < 2 || index + length > bytes.length) break
    if (sofMarkers.has(marker)) {
      if (length < 7) break
      const height = bytes.readUInt16BE(index + 3)
      const width = bytes.readUInt16BE(index + 5)
      if (!width || !height) break
      return { mimeType: 'image/jpeg', width, height }
    }
    index += length
  }
  throw new Error('ARTIFACT_INVALID: JPEG dimensions not found')
}

export function imageMetadataFor(bytes) {
  return bytes.subarray(0, 8).equals(PNG_SIGNATURE) ? dimensionsForPng(bytes) : dimensionsForJpeg(bytes)
}

export class ArtifactStore {
  constructor(root) {
    this.root = resolve(root)
    this.pendingPuts = new Map()
  }

  pathsFor(artifactId, mimeType, temporaryId) {
    if (!ARTIFACT_ID.test(artifactId)) throw new Error('ARTIFACT_INVALID: artifactId is invalid')
    const extension = extensionFor(mimeType)
    const path = assertWithin(this.root, resolve(this.root, `${artifactId}.${extension}`))
    const metadataPath = assertWithin(this.root, resolve(this.root, `${artifactId}.${extension}.json`))
    const temporarySuffix = temporaryId ? `.${temporaryId}` : ''
    return {
      path,
      metadataPath,
      temporaryPath: assertWithin(this.root, resolve(this.root, `${artifactId}.${extension}${temporarySuffix}.part`)),
      metadataTemporaryPath: assertWithin(this.root, resolve(this.root, `${artifactId}.${extension}.json${temporarySuffix}.part`))
    }
  }

  async put(input, metadata, { assertLease } = {}) {
    const bytes = Buffer.from(input)
    const artifactId = sha256(bytes)
    const previous = this.pendingPuts.get(artifactId) ?? Promise.resolve()
    const pending = previous.catch(() => {}).then(() => this.putArtifact(bytes, artifactId, metadata, { assertLease }))
    this.pendingPuts.set(artifactId, pending)
    try {
      return await pending
    } finally {
      if (this.pendingPuts.get(artifactId) === pending) this.pendingPuts.delete(artifactId)
    }
  }

  async putArtifact(bytes, artifactId, metadata, { assertLease } = {}) {
    await assertLease?.()
    const mimeType = metadata?.mimeType
    const width = metadata?.width
    const height = metadata?.height
    if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
      throw new Error('ARTIFACT_INVALID: width and height are required')
    }
    try {
      return await this.describe(artifactId)
    } catch (error) {
      if (!String(error?.message).startsWith('NOT_FOUND:')) throw error
    }

    const { path, metadataPath, temporaryPath, metadataTemporaryPath } = this.pathsFor(artifactId, mimeType, randomUUID())
    await mkdir(this.root, { recursive: true })
    let wroteContentTemporary = false
    let wroteMetadataTemporary = false
    try {
      try {
        const existing = await readFile(path)
        if (sha256(existing) !== artifactId) throw new Error('ARTIFACT_INVALID: existing artifact hash mismatch')
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
        await assertLease?.()
        wroteContentTemporary = true
        await writeFile(temporaryPath, bytes)
        await assertLease?.()
        await rename(temporaryPath, path)
        wroteContentTemporary = false
      }
      const artifact = { artifactId, sha256: artifactId, mimeType, byteSize: bytes.byteLength, width, height, path }
      await assertLease?.()
      wroteMetadataTemporary = true
      await writeFile(metadataTemporaryPath, JSON.stringify(artifact, null, 2) + '\n')
      await assertLease?.()
      // Metadata is the artifact publication point; it stays invisible until this fence passes.
      await rename(metadataTemporaryPath, metadataPath)
      wroteMetadataTemporary = false
      // A visible artifact is immutable and may already be observed by a successor daemon.
      // Never retract its manifest after this point, even if the final lease check fails.
      await assertLease?.()
      return artifact
    } catch (error) {
      if (wroteContentTemporary || wroteMetadataTemporary) {
        await Promise.allSettled([
          ...(wroteContentTemporary ? [rm(temporaryPath, { force: true })] : []),
          ...(wroteMetadataTemporary ? [rm(metadataTemporaryPath, { force: true })] : [])
        ])
      }
      throw error
    }
  }

  async describe(artifactId) {
    if (!ARTIFACT_ID.test(artifactId)) throw new Error('ARTIFACT_INVALID: artifactId is invalid')
    for (const mimeType of ['image/png', 'image/jpeg']) {
      const { path, metadataPath } = this.pathsFor(artifactId, mimeType)
      try {
        const metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
        if (metadata.artifactId !== artifactId || metadata.sha256 !== artifactId || metadata.mimeType !== mimeType || metadata.path !== path) {
          throw new Error('ARTIFACT_INVALID: artifact metadata mismatch')
        }
        const bytes = await readFile(path)
        if (sha256(bytes) !== artifactId || metadata.byteSize !== bytes.byteLength) throw new Error('ARTIFACT_INVALID: artifact content mismatch')
        return metadata
      } catch (error) {
        if (error?.code === 'ENOENT') continue
        throw error
      }
    }
    throw new Error('NOT_FOUND: artifact not found')
  }

  async read(artifactId) {
    const metadata = await this.describe(artifactId)
    const bytes = await readFile(metadata.path)
    if (sha256(bytes) !== artifactId) throw new Error('ARTIFACT_INVALID: artifact content mismatch')
    return bytes
  }

  async import(sourcePath, { assertLease } = {}) {
    await assertLease?.()
    const resolvedSource = resolve(sourcePath)
    const extension = extname(resolvedSource).toLowerCase()
    if (!['.png', '.jpg', '.jpeg'].includes(extension)) throw new Error('FORMAT_UNSUPPORTED: import accepts PNG or JPEG')
    const bytes = await readFile(resolvedSource)
    const metadata = imageMetadataFor(bytes)
    return this.put(bytes, metadata, { assertLease })
  }

  async remove(artifactId) {
    const metadata = await this.describe(artifactId)
    const { path, metadataPath } = this.pathsFor(artifactId, metadata.mimeType)
    await rm(path)
    await rm(metadataPath)
  }
}

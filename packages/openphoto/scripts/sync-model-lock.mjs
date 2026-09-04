import { mkdir, rename, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const FIXED_MODELS = Object.freeze({
  'Xenova/modnet': 'fa2fa546052fba4c08921230a26cc69a333fca12',
  'Xenova/depth-anything-small-hf': '2e942621ab9f2371c1df9eb223291b5ac31475e6',
  'Xenova/detr-resnet-50': '8be7ab59ff663484ee9ba2e8d8f267330d5ad03e',
  'Xenova/detr-resnet-50-panoptic': 'ea24b2d4e0bfae31f0a1299ba3fb892a2df064de'
})

const SHA256 = /^[a-f0-9]{64}$/u
const REQUIRED_RUNTIME_FILES = ['config.json', 'preprocessor_config.json']
const RUNTIME_CONFIG_FILES = new Set(REQUIRED_RUNTIME_FILES)
const LICENSE_SOURCES = Object.freeze({
  'Xenova/depth-anything-small-hf': 'LiheYoung/depth-anything-small-hf',
  'Xenova/detr-resnet-50': 'facebook/detr-resnet-50',
  'Xenova/detr-resnet-50-panoptic': 'facebook/detr-resnet-50-panoptic'
})

function encodeRepository(repository) {
  const parts = repository.split('/')
  if (parts.length !== 2 || parts.some(part => !part)) throw new Error(`invalid model repository: ${repository}`)
  return parts.map(encodeURIComponent).join('/')
}

function encodeFilePath(path) {
  if (typeof path !== 'string' || !path || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..' || part.includes('\\'))) {
    throw new Error(`invalid model file path: ${path}`)
  }
  return path.split('/').map(encodeURIComponent).join('/')
}

async function fetchJson(url, fetchImpl) {
  const response = await fetchImpl(url, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`metadata request failed (${response.status}): ${url}`)
  return response.json()
}

function licenseFor(metadata, repository) {
  const license = metadata?.cardData?.license ?? metadata?.license
  if (typeof license !== 'string' || !license.trim()) throw new Error(`model metadata has no license: ${repository}`)
  return license.trim()
}

async function collectLicense({ metadata, repository, fetchImpl }) {
  try {
    return licenseFor(metadata, repository)
  } catch (error) {
    const licenseRepository = LICENSE_SOURCES[repository]
    if (!licenseRepository) throw error
    const licenseMetadata = await fetchJson(`https://huggingface.co/api/models/${encodeRepository(licenseRepository)}`, fetchImpl)
    return licenseFor(licenseMetadata, licenseRepository)
  }
}

function metadataFile(entry, repository) {
  if (!entry || entry.type !== 'file' || typeof entry.path !== 'string') return null
  if (!RUNTIME_CONFIG_FILES.has(entry.path) && !entry.path.startsWith('onnx/')) return null
  const bytes = entry.lfs?.size ?? entry.size
  const sha256 = entry.lfs?.sha256 ?? entry.lfs?.oid ?? entry.sha256 ?? null
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || (sha256 === null && !RUNTIME_CONFIG_FILES.has(entry.path))
    || (sha256 !== null && !SHA256.test(sha256))) {
    throw new Error(`model metadata has no byte size or SHA-256: ${repository}/${entry.path}`)
  }
  return { path: entry.path, bytes, sha256 }
}

function isRuntimeModelPath(path) {
  return typeof path === 'string' && (RUNTIME_CONFIG_FILES.has(path) || path.startsWith('onnx/'))
}

function treeEntries(tree, repository) {
  if (!Array.isArray(tree)) throw new Error(`model metadata tree is invalid: ${repository}`)
  const files = tree
    .filter(entry => entry?.type === 'file' && isRuntimeModelPath(entry.path))
    .map(entry => metadataFile(entry, repository))
    .filter(Boolean)
  if (!files.length) throw new Error(`model metadata contains no files: ${repository}`)
  const paths = new Set()
  for (const file of files) {
    encodeFilePath(file.path)
    if (paths.has(file.path)) throw new Error(`model metadata repeats a file: ${repository}/${file.path}`)
    paths.add(file.path)
  }
  for (const path of REQUIRED_RUNTIME_FILES) {
    if (!paths.has(path)) throw new Error(`model metadata is missing required runtime file: ${repository}/${path}`)
  }
  if (!files.some(file => file.path.startsWith('onnx/'))) {
    throw new Error(`model metadata is missing ONNX runtime files: ${repository}`)
  }
  return files
}

export async function digestRuntimeFile({ url, bytes, fetchImpl }) {
  const path = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '')
  if (!RUNTIME_CONFIG_FILES.has(path)) throw new Error(`refusing to read non-runtime model content: ${url}`)
  const response = await fetchImpl(url, { headers: { accept: 'application/octet-stream' } })
  if (!response.ok || !response.body || typeof response.body.getReader !== 'function') {
    throw new Error(`runtime metadata file request failed (${response.status}): ${url}`)
  }
  const reader = response.body.getReader()
  const hash = createHash('sha256')
  let total = 0
  let responseComplete = false
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) {
        responseComplete = true
        break
      }
      const chunk = Buffer.from(next.value)
      total += chunk.byteLength
      if (total > bytes) throw new Error(`runtime metadata file exceeds declared byte size: ${url}`)
      hash.update(chunk)
    }
  } finally {
    if (!responseComplete) {
      try { await reader.cancel() } catch { /* response may already be closed */ }
    }
    try { reader.releaseLock() } catch { /* response may already be closed */ }
  }
  if (total !== bytes) throw new Error(`runtime metadata file byte size does not match: ${url}`)
  return hash.digest('hex')
}

export async function collectModelLock({ fetchImpl = fetch, digestImpl = digestRuntimeFile } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetchImpl must be a function')
  if (typeof digestImpl !== 'function') throw new Error('digestImpl must be a function')
  const models = {}
  for (const [repository, revision] of Object.entries(FIXED_MODELS)) {
    const encodedRepository = encodeRepository(repository)
    const metadataUrl = `https://huggingface.co/api/models/${encodedRepository}/revision/${encodeURIComponent(revision)}`
    const treeUrl = `https://huggingface.co/api/models/${encodedRepository}/tree/${encodeURIComponent(revision)}?recursive=true&expand=true`
    const [metadata, tree] = await Promise.all([
      fetchJson(metadataUrl, fetchImpl),
      fetchJson(treeUrl, fetchImpl)
    ])
    const files = await Promise.all(treeEntries(tree, repository).map(async file => {
      const url = `https://huggingface.co/${encodedRepository}/resolve/${encodeURIComponent(revision)}/${encodeFilePath(file.path)}`
      const sha256 = file.sha256 ?? await digestImpl({ url, bytes: file.bytes, fetchImpl })
      if (typeof sha256 !== 'string' || !SHA256.test(sha256)) {
        throw new Error(`runtime metadata file has no SHA-256: ${repository}/${file.path}`)
      }
      return { ...file, sha256, url }
    }))
    models[repository] = {
      revision,
      license: await collectLicense({ metadata, repository, fetchImpl }),
      source: `https://huggingface.co/${encodedRepository}/tree/${encodeURIComponent(revision)}`,
      files
    }
  }
  return { schemaVersion: 1, models }
}

export async function syncModelLock({ outputPath, fetchImpl = fetch, digestImpl = digestRuntimeFile } = {}) {
  if (typeof outputPath !== 'string' || !outputPath) throw new Error('outputPath is required')
  const lock = await collectModelLock({ fetchImpl, digestImpl })
  const destination = resolve(outputPath)
  const temporaryPath = `${destination}.part`
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(temporaryPath, `${JSON.stringify(lock, null, 2)}\n`)
  await rename(temporaryPath, destination)
  return lock
}

async function main() {
  const [outputPath] = process.argv.slice(2)
  if (!outputPath) throw new Error('usage: sync-model-lock <models.lock.json>')
  const lock = await syncModelLock({ outputPath })
  console.log(`model lock synchronized (${Object.keys(lock.models).length} models)`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) void main()

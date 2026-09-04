import { mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const defaultRuntimeDir = resolve(repoRoot, 'skill/openphoto/assets/ai-runtime')
const defaultLockFile = resolve(repoRoot, 'skill/openphoto/manifests/assets.lock.json')

const ASSETS = [
  {
    key: 'transformers',
    url: 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.0.0',
    file: 'transformers.min.js',
    licenseUrl: 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.0.0/LICENSE',
    licenseFile: 'licenses/transformers-LICENSE'
  },
  {
    key: 'onnx-wasm',
    url: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.25.0-dev.20260327-722743c0e2/dist/ort-wasm-simd-threaded.asyncify.wasm',
    file: 'ort-wasm-simd-threaded.asyncify.wasm',
    licenseUrl: 'https://cdn.jsdelivr.net/gh/microsoft/onnxruntime@722743c0e2f8c8cb86543a2435189f2df9022a7a/LICENSE',
    licenseFile: 'licenses/onnxruntime-web-LICENSE'
  },
  {
    key: 'onnx-safari-wasm',
    url: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.25.0-dev.20260327-722743c0e2/dist/ort-wasm-simd-threaded.wasm',
    file: 'ort-wasm-simd-threaded.wasm',
    licenseUrl: 'https://cdn.jsdelivr.net/gh/microsoft/onnxruntime@722743c0e2f8c8cb86543a2435189f2df9022a7a/LICENSE',
    licenseFile: 'licenses/onnxruntime-web-LICENSE'
  }
]

const FONT_CSS_URL = 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=DM+Sans:wght@400;500;600;700&display=swap'
const FONT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function download(url, headers = {}) {
  let lastError
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, { headers, redirect: 'follow' })
      if (!response.ok) {
        const error = new Error(`download failed (${response.status}): ${url}`)
        error.retryable = false
        throw error
      }
      const bytes = Buffer.from(await response.arrayBuffer())
      if (!bytes.byteLength) {
        const error = new Error(`download returned zero bytes: ${url}`)
        error.retryable = false
        throw error
      }
      return bytes
    } catch (error) {
      if (error.retryable === false) throw error
      lastError = error
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 250))
    }
  }
  throw new Error(`download failed after 3 attempts: ${url}`, { cause: lastError })
}

function fontUrlsFrom(css) {
  const urls = [...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)\s]+\.woff2)\)/giu)].map(match => match[1])
  const unique = [...new Set(urls)]
  if (!unique.length) throw new Error('Google Fonts response did not contain WOFF2 URLs')
  return unique
}

async function writeRelative(root, relativeFile, bytes) {
  const destination = resolve(root, relativeFile)
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, bytes)
}

export async function syncRuntimeAssets({ runtimeDir = defaultRuntimeDir, lockFile = defaultLockFile } = {}) {
  const resolvedRuntimeDir = resolve(runtimeDir)
  const resolvedLockFile = resolve(lockFile)
  const assetDownloads = []
  for (const asset of ASSETS) assetDownloads.push({ ...asset, bytes: await download(asset.url) })
  const licenses = new Map()
  for (const asset of ASSETS) {
    if (!licenses.has(asset.licenseFile)) licenses.set(asset.licenseFile, await download(asset.licenseUrl))
  }

  const fontCssBytes = await download(FONT_CSS_URL, { 'user-agent': FONT_USER_AGENT })
  const remoteFontCss = fontCssBytes.toString('utf8')
  const fontUrls = fontUrlsFrom(remoteFontCss)
  const fontDownloads = []
  for (const [index, url] of fontUrls.entries()) {
    fontDownloads.push({
      key: `font-${String(index + 1).padStart(2, '0')}`,
      url,
      file: `fonts/${String(index + 1).padStart(2, '0')}.woff2`,
      bytes: await download(url, { 'user-agent': FONT_USER_AGENT })
    })
  }
  let localFontCss = remoteFontCss
  for (const font of fontDownloads) localFontCss = localFontCss.replaceAll(font.url, `./${font.file}`)
  if (/https:\/\/fonts\.gstatic\.com/iu.test(localFontCss)) throw new Error('font stylesheet still contains a remote font URL')

  await mkdir(resolvedRuntimeDir, { recursive: true })
  for (const asset of assetDownloads) await writeRelative(resolvedRuntimeDir, asset.file, asset.bytes)
  for (const [licenseFile, bytes] of licenses) await writeRelative(resolvedRuntimeDir, licenseFile, bytes)
  for (const font of fontDownloads) await writeRelative(resolvedRuntimeDir, font.file, font.bytes)
  await writeRelative(resolvedRuntimeDir, 'openphoto-fonts.css', Buffer.from(localFontCss, 'utf8'))

  const lock = {
    version: 1,
    generatedAt: new Date().toISOString(),
    assets: assetDownloads.map(({ key, url, file, bytes, licenseFile }) => ({ key, url, file, bytes: bytes.byteLength, sha256: sha256(bytes), licenseFile })),
    fonts: fontDownloads.map(({ key, url, file, bytes }) => ({ key, url, file, bytes: bytes.byteLength, sha256: sha256(bytes) })),
    fontStylesheet: {
      url: FONT_CSS_URL,
      file: 'openphoto-fonts.css',
      bytes: Buffer.byteLength(localFontCss),
      sha256: sha256(Buffer.from(localFontCss, 'utf8'))
    }
  }
  await mkdir(dirname(resolvedLockFile), { recursive: true })
  await writeFile(resolvedLockFile, JSON.stringify(lock, null, 2) + '\n')
  return lock
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [runtimeDir, lockFile] = process.argv.slice(2)
  const lock = await syncRuntimeAssets({ runtimeDir, lockFile })
  console.log(JSON.stringify({ assets: lock.assets.length, fonts: lock.fonts.length, lockFile: resolve(lockFile ?? defaultLockFile) }))
}

import { access, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

function replaceExactlyOnce(source, before, after, label) {
  const count = source.split(before).length - 1
  if (count !== 1) throw new Error(`${label}: expected one anchor, found ${count}`)
  return source.replace(before, after)
}

function removeRuntimeEntry(source, key) {
  const anchor = `        ${key}: Object.freeze({`
  const count = source.split(anchor).length - 1
  if (count !== 1) throw new Error(`${key}: expected one runtime entry, found ${count}`)
  const start = source.indexOf(anchor)
  const end = source.indexOf('        }),\n', start)
  if (end < 0) throw new Error(`${key}: runtime entry has no closing anchor`)
  return source.slice(0, start) + source.slice(end + '        }),\n'.length)
}

const cspBefore = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'; form-action 'none'; script-src 'self' 'sha256-p7wJ1Vq4fkpiKgIlMXwiynzoeLFoeYzxzvK2aPUMzgA=' 'sha256-Av2g26oEJiMigIz7WkLihWDQ7leg0Yd1qUZ8JFshYdE=' 'wasm-unsafe-eval' blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self' https://cdn.jsdelivr.net https://huggingface.co https://*.hf.co blob:; worker-src 'self' blob:; frame-src 'none';">`
const cspAfter = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self' blob:; worker-src 'self' blob:; frame-src 'none'">`
const googleFonts = `<link rel="preconnect" href="https://fonts.googleapis.com">\n<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">`

const remoteRuntimeUrls = [
  ['https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.0.0', '../ai-runtime/transformers.min.js', 'transformers runtime'],
  ['https://cdn.jsdelivr.net/npm/onnxruntime-web@1.25.0-dev.20260327-722743c0e2/dist/ort-wasm-simd-threaded.asyncify.wasm', '../ai-runtime/ort-wasm-simd-threaded.asyncify.wasm', 'threaded ONNX runtime'],
  ['https://cdn.jsdelivr.net/npm/onnxruntime-web@1.25.0-dev.20260327-722743c0e2/dist/ort-wasm-simd-threaded.wasm', '../ai-runtime/ort-wasm-simd-threaded.wasm', 'Safari ONNX runtime']
]

export async function patchOpenPhotoShell({ shellDir, runtimeDir }) {
  const shell = resolve(shellDir)
  const runtime = resolve(runtimeDir)
  for (const file of ['transformers.min.js', 'ort-wasm-simd-threaded.asyncify.wasm', 'ort-wasm-simd-threaded.wasm', 'openphoto-fonts.css']) {
    await access(resolve(runtime, file))
  }

  const indexPath = resolve(shell, 'index.html')
  let index = (await readFile(indexPath, 'utf8')).replaceAll('\r\n', '\n')
  index = replaceExactlyOnce(index, cspBefore, cspAfter, 'CSP replacement')
  index = replaceExactlyOnce(index, googleFonts, '<link rel="stylesheet" href="../ai-runtime/openphoto-fonts.css">', 'font stylesheet replacement')
  for (const [remote, local, label] of remoteRuntimeUrls) index = replaceExactlyOnce(index, remote, local, label)
  index = replaceExactlyOnce(
    index,
    '            lib.env.allowLocalModels = false;',
    '            lib.env.allowLocalModels = true;',
    'background removal local model setting'
  )
  for (const key of ['psdDecoder', 'pdfExporter', 'photonModule', 'photonWasm', 'gifEncoder', 'gifWorker']) index = removeRuntimeEntry(index, key)
  index = replaceExactlyOnce(
    index,
    '    initPWA() {\n        this._initFileLaunchQueue();',
    "    initPWA() {\n        if (new URLSearchParams(location.search).get('openphoto') === '1') {\n            this._setOfflineState({ lane:'standalone', online:navigator.onLine !== false, installed:false, shellReady:true, error:null });\n            return;\n        }\n        this._initFileLaunchQueue();",
    'OpenPhoto service-worker bypass'
  )
  index = replaceExactlyOnce(index, '</body>', '<script src="openphoto-bridge.js"></script>\n</body>', 'bridge injection')

  const swPath = resolve(shell, 'sw.js')
  let sw = (await readFile(swPath, 'utf8')).replaceAll('\r\n', '\n')
  const optionalAssets = `const OPTIONAL_ASSETS = [
    "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=DM+Sans:wght@400;500;600;700&display=swap",
    "https://cdn.jsdelivr.net/npm/@silvia-odwyer/photon@0.3.3/photon_rs.js",
    "https://cdn.jsdelivr.net/npm/@silvia-odwyer/photon@0.3.3/photon_rs_bg.wasm",
    "https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.js",
    "https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.worker.js",
    "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.0.0",
    "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.25.0-dev.20260327-722743c0e2/dist/ort-wasm-simd-threaded.asyncify.wasm",
    "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.25.0-dev.20260327-722743c0e2/dist/ort-wasm-simd-threaded.wasm"
];`
  sw = replaceExactlyOnce(sw, optionalAssets, 'const OPTIONAL_ASSETS = [];', 'service-worker remote asset list')
  sw = replaceExactlyOnce(
    sw,
    `const RUNTIME_ORIGINS = new Set([
    "https://cdn.jsdelivr.net",
    "https://fonts.googleapis.com",
    "https://fonts.gstatic.com"
]);`,
    'const RUNTIME_ORIGINS = new Set();',
    'service-worker runtime origins'
  )
  sw = replaceExactlyOnce(
    sw,
    `    if (CACHEABLE_RUNTIME_URLS.has(url.href)) return true;
    return url.origin === 'https://fonts.gstatic.com'
        && /\\.(?:woff2?|ttf)$/i.test(url.pathname);`,
    `    if (CACHEABLE_RUNTIME_URLS.has(url.href)) return true;
    return false;`,
    'service-worker remote font cache'
  )

  await writeFile(indexPath, index)
  await writeFile(swPath, sw)
  const bridgePath = resolve(shell, 'openphoto-bridge.js')
  try {
    await access(bridgePath)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    await writeFile(bridgePath, "window.__openphoto = Object.freeze({ version: 'openphoto-bridge/v1' })\ndocument.documentElement.dataset.openphotoReady = 'true'\n")
  }
}

async function main() {
  const [shellDir, runtimeDir] = process.argv.slice(2)
  if (!shellDir || !runtimeDir) throw new Error('usage: patch-openphoto-shell <shellDir> <runtimeDir>')
  await patchOpenPhotoShell({ shellDir, runtimeDir })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) void main()

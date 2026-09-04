import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const remote = /(cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com|huggingface\.co|\.hf\.co)/iu
const expectedCsp = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self' blob:; worker-src 'self' blob:; frame-src 'none'">`

export async function checkLocalAssets(shellDir) {
  const shell = resolve(shellDir)
  const runtime = resolve(shell, '../ai-runtime')
  for (const file of ['transformers.min.js', 'ort-wasm-simd-threaded.asyncify.wasm', 'ort-wasm-simd-threaded.wasm', 'openphoto-fonts.css']) {
    await access(resolve(runtime, file))
  }
  const files = [
    ['index.html', resolve(shell, 'index.html')],
    ['sw.js', resolve(shell, 'sw.js')],
    ['openphoto-bridge.js', resolve(shell, 'openphoto-bridge.js')],
    ['../ai-runtime/openphoto-fonts.css', resolve(runtime, 'openphoto-fonts.css')]
  ]
  const bodies = await Promise.all(files.map(([, file]) => readFile(file, 'utf8')))
  for (const [index, body] of bodies.entries()) assert.doesNotMatch(body, remote, files[index][0])

  const [indexHtml] = bodies
  assert.ok(indexHtml.includes(expectedCsp), 'CSP must be the OpenPhoto local-only policy')
  assert.ok(indexHtml.includes('<link rel="stylesheet" href="../ai-runtime/openphoto-fonts.css">'), 'local font stylesheet is required')
  assert.ok(indexHtml.includes('<script src="openphoto-bridge.js"></script>'), 'OpenPhoto bridge is required')
  const initPwa = indexHtml.indexOf('    initPWA() {')
  const bypass = indexHtml.indexOf("new URLSearchParams(location.search).get('openphoto') === '1'", initPwa)
  const registration = indexHtml.indexOf("'serviceWorker' in navigator", initPwa)
  assert.ok(initPwa >= 0 && bypass > initPwa && registration > bypass, 'OpenPhoto PWA bypass must precede service-worker registration')
  const bypassBlock = indexHtml.slice(bypass, registration)
  assert.match(bypassBlock, /lane:'standalone'[\s\S]*return;/u, 'OpenPhoto PWA bypass must set standalone state and return')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [shellDir] = process.argv.slice(2)
  if (!shellDir) throw new Error('usage: check-local-assets <shellDir>')
  await checkLocalAssets(shellDir)
}

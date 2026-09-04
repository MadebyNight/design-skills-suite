import { createServer } from 'node:net'
import { resolve } from 'node:path'

process.env.NODE_ENV = 'test'

const { defineConfig } = await import('@playwright/test')
const { locateBrowser } = await import('../runtime/browser.mjs')

const skillRoot = resolve(import.meta.dirname, '..')
const assetsRoot = resolve(skillRoot, 'assets')
const staticServer = resolve(skillRoot, 'runtime/static-server.mjs')
const selected = await locateBrowser()
const requested = process.env.OPENPHOTO_BROWSER
if (requested && selected.kind !== requested) throw new Error(`requested ${requested} browser but located ${selected.kind}`)

const port = Number(process.env.OPENPHOTO_TEST_PORT) || await new Promise((resolvePort, reject) => {
  const socket = createServer()
  socket.once('error', reject)
  socket.listen(0, '127.0.0.1', () => {
    const address = socket.address()
    socket.close(error => error ? reject(error) : resolvePort(address.port))
  })
})
process.env.OPENPHOTO_TEST_PORT = String(port)
const baseURL = `http://127.0.0.1:${port}`
const command = `"${process.execPath}" "${staticServer}" "${assetsRoot}" ${port}`

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: {
    baseURL,
    browserName: 'chromium',
    headless: true,
    launchOptions: { executablePath: selected.executablePath, headless: true }
  },
  projects: [{ name: selected.kind }],
  webServer: { command, url: `${baseURL}/openshop/index.html?openphoto=1`, reuseExistingServer: false, timeout: 30_000 }
})

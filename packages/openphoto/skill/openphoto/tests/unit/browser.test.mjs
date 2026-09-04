import assert from 'node:assert/strict'
import test from 'node:test'
import { locateBrowser, openDocument, probeBrowser } from '../../runtime/browser.mjs'

test('explicit browser path wins over discovery', async () => {
  const found = await locateBrowser({ explicitPath: 'C:/custom/browser.exe', exists: async path => path === 'C:/custom/browser.exe' })
  assert.deepEqual(found, { kind: 'custom', executablePath: 'C:/custom/browser.exe' })
})

test('missing browsers produce a readable error', async () => {
  await assert.rejects(() => locateBrowser({ exists: async () => false }), { code: 'BROWSER_NOT_FOUND' })
})

test('a located executable is rejected when required browser APIs are unavailable', async () => {
  const fakeBrowser = {
    version: () => 'HeadlessChrome/123.0.0.0',
    newPage: async () => ({ goto: async () => {}, evaluate: async () => ({ canvas: true, webAssembly: false, createImageBitmap: true, offscreenCanvas: true }) }),
    close: async () => {}
  }
  await assert.rejects(
    () => probeBrowser({ executablePath: 'C:/custom/browser.exe', launch: async () => fakeBrowser }),
    { code: 'BROWSER_UNSUPPORTED' }
  )
})

test('a system Chromium version may be reported without a product prefix', async () => {
  const fakeBrowser = {
    version: () => '151.0.7922.138',
    newPage: async () => ({ goto: async () => {}, evaluate: async () => ({ canvas: true, webAssembly: true, createImageBitmap: true, offscreenCanvas: true }), close: async () => {} }),
    close: async () => {}
  }
  await probeBrowser({ executablePath: 'C:/custom/browser.exe', launch: async () => fakeBrowser })
})

test('openDocument keeps the Chromium launch method bound during its probe', async () => {
  let launchThis
  const page = { goto: async () => {} }
  const context = { newPage: async () => page, close: async () => {} }
  const chromium = {
    launch() {
      launchThis = this
      return { close: async () => {} }
    },
    launchPersistentContext: async () => context
  }
  const document = await openDocument({
    baseUrl: 'http://127.0.0.1:1',
    locate: async () => ({ kind: 'custom', executablePath: 'C:/custom/browser.exe' }),
    probe: async ({ launch }) => { await launch({}) },
    chromium
  })
  try {
    assert.equal(launchThis, chromium)
  } finally {
    await document.close()
  }
})

test('openDocument installs an init script before navigating to OpenPhoto', async () => {
  const calls = []
  const page = { goto: async () => { calls.push('goto') } }
  const context = {
    addInitScript: async script => { calls.push({ initScript: script }) },
    newPage: async () => page,
    close: async () => {}
  }
  const document = await openDocument({
    baseUrl: 'http://127.0.0.1:1',
    initScript: 'window.__OPENPHOTO_TEST_PIPELINE__ = () => ({})',
    locate: async () => ({ kind: 'custom', executablePath: 'C:/custom/browser.exe' }),
    probe: async () => {},
    chromium: { launchPersistentContext: async () => context }
  })
  try {
    assert.deepEqual(calls, [{ initScript: { content: 'window.__OPENPHOTO_TEST_PIPELINE__ = () => ({})' } }, 'goto'])
  } finally {
    await document.close()
  }
})

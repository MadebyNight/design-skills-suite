import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function browserError(code, message) {
  return Object.assign(new Error(message), { code })
}

async function defaultExists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export async function locateBrowser({ explicitPath = process.env.OPENPHOTO_BROWSER_PATH, preferred = process.env.OPENPHOTO_BROWSER, exists = defaultExists } = {}) {
  if (explicitPath) {
    if (await exists(explicitPath)) return { kind: 'custom', executablePath: explicitPath }
    throw browserError('BROWSER_NOT_FOUND', `configured browser does not exist: ${explicitPath}`)
  }
  if (preferred !== undefined && !['chrome', 'edge'].includes(preferred)) {
    throw browserError('BROWSER_NOT_FOUND', `OPENPHOTO_BROWSER must be chrome or edge, received: ${preferred}`)
  }
  const candidates = [
    ['chrome', join(process.env.ProgramFiles ?? 'C:/Program Files', 'Google/Chrome/Application/chrome.exe')],
    ['edge', join(process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe')]
  ]
  for (const [kind, executablePath] of candidates) {
    if (preferred && kind !== preferred) continue
    if (await exists(executablePath)) return { kind, executablePath }
  }
  throw browserError('BROWSER_NOT_FOUND', preferred ? `requested ${preferred} browser was not found` : 'Chrome or Edge was not found')
}

async function defaultLaunch(options) {
  const { chromium } = await import('playwright-core')
  return chromium.launch(options)
}

export async function probeBrowser({ executablePath, launch = defaultLaunch }) {
  let browser
  try {
    browser = await launch({ executablePath, headless: true })
    const version = await browser.version()
    if (!/(?:Chrome|Chromium|Edg)\//iu.test(version) && !/^\d+\.\d+\.\d+\.\d+$/u.test(version)) {
      throw browserError('BROWSER_UNSUPPORTED', `non-Chromium browser version: ${version}`)
    }
    const page = await browser.newPage()
    await page.goto('data:text/html,<title>OpenPhoto browser probe</title>')
    const features = await page.evaluate(() => ({
      canvas: typeof HTMLCanvasElement !== 'undefined',
      webAssembly: typeof WebAssembly !== 'undefined',
      createImageBitmap: typeof createImageBitmap === 'function',
      offscreenCanvas: typeof OffscreenCanvas !== 'undefined'
    }))
    for (const [feature, available] of Object.entries(features)) {
      if (!available) throw browserError('BROWSER_UNSUPPORTED', `required browser feature is unavailable: ${feature}`)
    }
    await page.close?.()
    return { executablePath, version }
  } catch (error) {
    if (error?.code === 'BROWSER_UNSUPPORTED') throw error
    throw browserError('BROWSER_UNSUPPORTED', `browser probe failed: ${error.message}`)
  } finally {
    await browser?.close()
  }
}

export async function openDocument({ baseUrl, explicitPath, locate = locateBrowser, probe = probeBrowser, chromium: suppliedChromium, initScript } = {}) {
  if (!baseUrl) throw new Error('baseUrl is required')
  const located = await locate({ explicitPath })
  const chromium = suppliedChromium ?? (await import('playwright-core')).chromium
  await probe({ executablePath: located.executablePath, launch: options => chromium.launch(options) })
  const profileDir = await mkdtemp(join(tmpdir(), 'openphoto-profile-'))
  let context
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      executablePath: located.executablePath,
      headless: true,
      args: ['--no-first-run', '--disable-extensions']
    })
    if (initScript !== undefined) await context.addInitScript({ content: initScript })
    const page = await context.newPage()
    await page.goto(new URL('/openshop/index.html?openphoto=1', baseUrl).href, { waitUntil: 'domcontentloaded' })
    let closed = false
    return {
      ...located,
      context,
      page,
      profileDir,
      async close() {
        if (closed) return
        closed = true
        try {
          await context.close()
        } finally {
          await rm(profileDir, { recursive: true, force: true })
        }
      }
    }
  } catch (error) {
    try {
      await context?.close()
    } finally {
      await rm(profileDir, { recursive: true, force: true })
    }
    throw error
  }
}

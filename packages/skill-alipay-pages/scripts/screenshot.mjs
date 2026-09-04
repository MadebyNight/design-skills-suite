import path from 'node:path'
import { pathToFileURL } from 'node:url'

export async function screenshotPage({ prototypePath, outputPath, viewportHeight = 720 }) {
  let chromium
  try {
    ;({ chromium } = await import('@playwright/test'))
  } catch (cause) {
    const error = new Error('截图需要已安装的 @playwright/test 与 Chromium；当前依赖不可用')
    error.code = 'PLAYWRIGHT_UNAVAILABLE'
    error.cause = cause
    throw error
  }
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 375, height: viewportHeight } })
    await page.route(/^https?:\/\//, route => route.abort())
    await page.goto(pathToFileURL(path.resolve(prototypePath)).href, { waitUntil: 'load' })
    const size = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }))
    if (size.scrollWidth > 375) throw new Error(`页面横向溢出：scrollWidth=${size.scrollWidth}`)
    await page.screenshot({ path: outputPath, fullPage: true })
    return { outputPath, ...size }
  } finally {
    await browser.close()
  }
}

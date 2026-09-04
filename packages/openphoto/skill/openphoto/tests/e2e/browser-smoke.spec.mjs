import { test, expect } from '@playwright/test'

test('selected system browser can load the offline OpenPhoto shell', async ({ page }) => {
  const failures = []
  const requests = []
  const localUrl = url => url.startsWith('http://127.0.0.1') || url.startsWith('blob:http://127.0.0.1')
  page.on('requestfailed', request => failures.push(request.url()))
  page.on('request', request => requests.push(request.url()))
  await page.goto('/openshop/index.html?openphoto=1', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('html')).toHaveAttribute('data-openphoto-ready', 'true')
  expect(await page.evaluate(() => Object.keys(window.__openphoto).sort())).toEqual([
    'analyze', 'apply', 'captureInput', 'inspect', 'mutate', 'open', 'render', 'version'
  ])
  expect(failures.filter(url => !localUrl(url))).toEqual([])
  expect(requests.filter(url => !localUrl(url))).toEqual([])
  const registrations = await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)
  expect(registrations).toBe(0)
})

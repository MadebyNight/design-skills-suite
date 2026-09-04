import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { COMPONENT_LIB } from '../scripts/build-catalog.mjs'
import { assemblePage } from '../scripts/assemble.mjs'
import { homeCarouselScript } from '../scripts/catalog/composition.mjs'
import { validateOutput } from '../scripts/validate.mjs'
import { buildDesignPackage } from '../scripts/package.mjs'
import { screenshotPage } from '../scripts/screenshot.mjs'

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'alipay-pages-'))
}

test('受控组装只替换文本、图片和已登记 variant', () => {
  const outputRoot = temporaryDirectory()
  try {
    const result = assemblePage({
      outputRoot,
      changes: {
        texts: [{ className: 'home-search__placeholder', value: '搜索相机与演唱会设备' }],
        images: [{
          currentSrc: '../assets/home/banner-concert.png',
          sourcePath: path.join(COMPONENT_LIB, 'assets', 'home', 'banner-concert.png'),
          outputPath: 'assets/generated/banner.png',
        }],
        variants: [{ className: 'home-category-tabs__item', index: 1, add: ['is-active'] }],
      },
    })
    const html = fs.readFileSync(result.prototypePath, 'utf8')
    assert.match(html, /搜索相机与演唱会设备/)
    assert.match(html, /assets\/generated\/banner\.png/)
    assert.doesNotMatch(html, /\.\.\/(?:assets|styles)/)
    assert.equal(validateOutput({ outputRoot }).passed, true)
  } finally { fs.rmSync(outputRoot, { recursive: true, force: true }) }
})

test('首页轮播仅交付固定本地脚本，首张初始可见并以 3000ms 循环', () => {
  const outputRoot = temporaryDirectory()
  try {
    assemblePage({ pageType: 'home', outputRoot, changes: { homeCarousel: true } })
    const html = fs.readFileSync(path.join(outputRoot, 'prototype.html'), 'utf8')
    const script = fs.readFileSync(path.join(outputRoot, 'scripts', 'home-carousel.js'), 'utf8')
    assert.match(html, /<script src="scripts\/home-carousel\.js"><\/script>\s*<\/body>/)
    assert.equal(script, homeCarouselScript())
    assert.match(script, /slide\.hidden = index !== 0/)
    assert.match(script, /setInterval\([\s\S]*?\}, 3000\)/)
    assert.equal(validateOutput({ outputRoot, pageType: 'home' }).passed, true)

    const minifiedHtml = html.replace(/\r?\n\s*/g, '')
    fs.writeFileSync(path.join(outputRoot, 'prototype.html'), minifiedHtml)
    assert.equal(validateOutput({ outputRoot, pageType: 'home' }).passed, true)

    fs.writeFileSync(path.join(outputRoot, 'prototype.html'), minifiedHtml.replace('</script></body>', '</script><div></div></body>'))
    assert.ok(validateOutput({ outputRoot, pageType: 'home' }).errors.some(error => error.includes('首页轮播脚本必须位于 body 末尾')))

    fs.writeFileSync(path.join(outputRoot, 'prototype.html'), html.replace('</body>', '  <script src="scripts/other.js"></script>\n</body>'))
    assert.ok(validateOutput({ outputRoot, pageType: 'home' }).errors.some(error => error.includes('未登记 script')))
  } finally { fs.rmSync(outputRoot, { recursive: true, force: true }) }
})

test('未登记 variant 与未知 class 被拒绝', () => {
  const outputRoot = temporaryDirectory()
  try {
    assert.throws(() => assemblePage({ outputRoot, changes: { variants: [{ className: 'home-nav', add: ['is-new'] }] } }), /未登记 variant/)
    assemblePage({ outputRoot })
    const prototype = path.join(outputRoot, 'prototype.html')
    fs.writeFileSync(prototype, fs.readFileSync(prototype, 'utf8').replace('home-page', 'home-page injected-class'))
    const report = validateOutput({ outputRoot })
    assert.equal(report.passed, false)
    assert.ok(report.errors.some(error => error.includes('injected-class')))
  } finally { fs.rmSync(outputRoot, { recursive: true, force: true }) }
})

test('生成合法 DesignPackage 元数据', () => {
  const outputRoot = temporaryDirectory()
  try {
    const { catalog } = assemblePage({ outputRoot })
    fs.writeFileSync(path.join(outputRoot, 'design-brief.json'), JSON.stringify({ id: 'brief-home' }))
    validateOutput({ outputRoot })
    const result = buildDesignPackage({
      outputRoot,
      designBriefId: 'brief-home',
      sourceCommit: catalog.sourceCommit,
      skillDependencies: [{ id: 'skill-alipay-pages', version: '0.1.0' }],
    })
    assert.equal(result.designBriefId, 'brief-home')
    assert.ok(result.files.some(file => file.kind === 'prototype.html'))
    assert.ok(result.files.every(file => /^[a-f0-9]{64}$/.test(file.sha256)))
  } finally { fs.rmSync(outputRoot, { recursive: true, force: true }) }
})

test('截图入口在当前环境可验证，且不保留测试产物', async () => {
  const outputRoot = temporaryDirectory()
  try {
    assemblePage({ outputRoot })
    const outputPath = path.join(outputRoot, 'prototype.png')
    try {
      const result = await screenshotPage({
        prototypePath: path.join(outputRoot, 'prototype.html'),
        outputPath,
      })
      assert.equal(result.scrollWidth, 375)
      assert.ok(fs.existsSync(outputPath))
      assert.ok(fs.statSync(outputPath).size > 0)
    } catch (error) {
      assert.equal(error.code, 'PLAYWRIGHT_UNAVAILABLE')
    }
  } finally { fs.rmSync(outputRoot, { recursive: true, force: true }) }
})

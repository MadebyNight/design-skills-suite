import assert from 'node:assert/strict'
import test from 'node:test'
import { renderDeliveryIndex } from '../../runtime/delivery-index.mjs'

const input = {
  title: '春日城市漫游',
  type: 'alipay.landing',
  prototypePath: 'other/item-01/prototype.html',
  configPath: 'configs/item-01.config.json',
  assetsPath: 'assets/item-01/',
  screenshotPath: 'other/item-01/screenshot.png',
}

test('renderDeliveryIndex 输出四卡片、相对入口与离线文档', () => {
  const html = renderDeliveryIndex(input)
  assert.match(html, /^<!doctype html>/i)
  assert.match(html, /春日城市漫游/)
  assert.match(html, /alipay\.landing/)
  for (const [kind, href] of Object.entries({
    prototype: input.prototypePath,
    config: input.configPath,
    assets: input.assetsPath,
    screenshot: input.screenshotPath,
  })) {
    assert.match(html, new RegExp(`data-kind="${kind}"`))
    assert.match(html, new RegExp(href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  assert.equal((html.match(/class="card"/g) || []).length, 4)
  assert.match(html, /<svg/)
  assert.doesNotMatch(html, /https?:\/\//i)
  assert.match(html, /prefers-reduced-motion/)
})

test('截图缺失时渲染可访问 fallback，并保持四张卡片', () => {
  const html = renderDeliveryIndex({ ...input, screenshotPath: undefined })
  assert.match(html, /暂无截图/)
  assert.match(html, /href="#preview"/)
  assert.equal((html.match(/class="card"/g) || []).length, 4)
})

test('文本会转义，路径必须是相对本地路径', () => {
  const html = renderDeliveryIndex({ ...input, title: '<交付 & 预览>' })
  assert.match(html, /&lt;交付 &amp; 预览&gt;/)
  for (const key of ['prototypePath', 'configPath', 'assetsPath', 'screenshotPath']) {
    assert.throws(() => renderDeliveryIndex({ ...input, [key]: '../outside' }), /相对本地路径|不得越出/)
    assert.throws(() => renderDeliveryIndex({ ...input, [key]: 'https://example.com/a' }), /相对本地路径/)
  }
})

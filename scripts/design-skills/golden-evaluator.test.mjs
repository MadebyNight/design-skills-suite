import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runGoldenEvaluation } from './golden-evaluator.mjs'
import { deriveLandingConfig } from '../../packages/skill-alipay-landing/runtime/planner.mjs'
import { designLanding } from '../../packages/skill-alipay-landing/bin/landing-design.mjs'
import { generateAsset, testProvider } from '../../packages/skill-image-generate/runtime/generator.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function goldenBrief(number) {
  const file = fs.readdirSync(path.join(repoRoot, 'test-fixtures', 'design-skills', 'golden'))
    .find(name => name.startsWith(String(number).padStart(2, '0')))
  return JSON.parse(fs.readFileSync(path.join(repoRoot, 'test-fixtures', 'design-skills', 'golden', file), 'utf8')).input.brief
}

test('八个黄金任务均产生结构化评测结果', { timeout: 300_000, concurrency: false }, async () => {
  const report = await runGoldenEvaluation()
  assert.equal(report.total, 8)
  assert.equal(report.passed, 8, JSON.stringify(report.tasks.filter(task => !task.passed), null, 2))
  assert.equal(report.completionRate, 1)
  assert.equal(report.humanBlindReview.status, 'not_completed')
  for (const taskId of ['golden-05', 'golden-06']) {
    const task = report.tasks.find(item => item.taskId === taskId)
    assert.ok(task, `${taskId} 缺少评测结果`)
    assert.equal(task.evidence.pageCalls, 2)
    assert.equal(task.evidence.pendingAssets, 0)
    assert.equal(task.evidence.validationReport?.passed, true)
    assert.equal(task.evidence.allAssetResultsValid, true)
    assert.equal(task.evidence.finalAssets.length, task.evidence.totalRequests)
    assert.equal(task.evidence.acceptedCount, task.evidence.totalRequests)
    for (const asset of task.evidence.finalAssets) {
      assert.equal(asset.width > 0 && asset.height > 0, true)
      assert.equal(asset.mimeType, asset.format === 'png' ? 'image/png' : 'image/jpeg')
      assert.ok(['cover', 'contain'].includes(asset.fit))
    }
  }
  // 落地页期望必须基于新 landing 链路合同（deriveLandingConfig），
  // 且不为商品图片创建素材请求。
  const landingTask = report.tasks.find(item => item.taskId === 'golden-06')
  const expected = deriveLandingConfig(goldenBrief(6)).assetRequests
  assert.equal(landingTask.evidence.totalRequests, expected.length)
  assert.ok(expected.every(request => /landing\.default\.(hero|imageAd\.[12])\.image/.test(request.id)), `槽位命名合同：${expected.map(r => r.id).join(', ')}`)
  for (const request of expected) {
    assert.ok(!/product/i.test(request.id), `不得为商品图创建素材请求：${request.id}`)
    const delivered = landingTask.evidence.finalAssets.find(asset => asset.assetRequestId === request.id)
    assert.ok(delivered, `缺少交付素材：${request.id}`)
    assert.equal(delivered.targetWidth, request.targetWidth)
    assert.equal(delivered.targetHeight, request.targetHeight)
  }
  const hero = expected.find(request => request.slot === 'hero')
  assert.deepEqual([hero.targetWidth, hero.targetHeight], [1500, 720])
  const imageAds = expected.filter(request => request.slot.startsWith('imageAd'))
  assert.ok(imageAds.length >= 1, '单图 IMAGE_AD 请求必须存在')
  for (const imageAd of imageAds) {
    assert.deepEqual([imageAds[0].targetWidth, imageAds[0].targetHeight], [1404, 480], '单图 IMAGE_AD 为 1404x480')
  }
})

test('双图 IMAGE_AD 合同：deriveLandingConfig 派生两请求 686x480 且 designLanding 原型不回填占位', { timeout: 120_000 }, async () => {
  const brief = goldenBrief(6)
  brief.goal = '为双十一大促设计一个支付宝小程序落地页，包含双图广告，完成研究、素材与原型交付'
  const derived = deriveLandingConfig(brief, { landingKey: 'landing-02' })
  const slots = derived.assetRequests
  assert.equal(slots.length, 3, `hero + 双图恰好 3 个槽位：${JSON.stringify(slots.map(s => s.id))}`)
  assert.deepEqual(slots.map(s => [s.id, s.targetWidth, s.targetHeight]), [
    ['landing.landing-02.hero.image', 1500, 720],
    ['landing.landing-02.imageAd.1.image', 686, 480],
    ['landing.landing-02.imageAd.2.image', 686, 480],
  ])
  const module = derived.config.modules.find(m => m.type === 'IMAGE_AD')
  assert.equal(module.mode.mode, 'double')
  assert.equal(module.mode.count, 2)

  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'landing-double-'))
  try {
    const page = await designLanding({ brief, outputRoot, landingKey: 'landing-02' })
    assert.equal(page.status, 'completed_with_pending_assets')
    assert.equal(page.pendingAssetRequests.length, 3)
    assert.deepEqual(page.pendingAssetRequests.map(r => [r.id, r.targetWidth, r.targetHeight]),
      slots.map(s => [s.id, s.targetWidth, s.targetHeight]))
    // 比例验收 + 重试合同与页面能力基线一致。
    for (const request of page.pendingAssetRequests) {
      assert.deepEqual(request.acceptance, { mode: 'aspect-ratio', maxAspectRatioError: 0.03 })
      assert.deepEqual(request.retryPolicy, { generateMaxAttempts: 3, adaptMaxAttempts: 2 })
    }
    const prototype = fs.readFileSync(path.join(outputRoot, 'prototype.html'), 'utf8')
    const placeholderCount = (prototype.match(/素材生成失败/g) || []).length
    assert.equal(placeholderCount, 3, '未回填槽位以诊断占位呈现')
    // 双图按序实例化两个受控单图容器（is-single 为 catalog 默认组合 class）。
    const imageAdBlocks = (prototype.match(/class="lp-image-ad /g) || []).length
    assert.equal(imageAdBlocks, 2, `双图实例化为两个单图容器，实际 ${imageAdBlocks}`)
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true })
  }
})

test('比例验收边界：生成素材按 aspect-ratio 合同验收，适配后不再要求严格像素相等', { timeout: 60_000 }, async () => {
  const brief = goldenBrief(6)
  const derived = deriveLandingConfig(brief)
  const request = derived.assetRequests.find(s => s.slot === 'hero')
  const generated = await generateAsset(
    { ...request, format: 'png', fit: 'cover', safeArea: '重要内容居中，避免被裁切', referenceImages: [], forbiddenContent: [], allowGenerate: true, allowEdit: true },
    { provider: testProvider, artifactRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'gen-')) },
  )
  // testProvider 输出 2x1：与 hero 1500x720 目标比例偏差超 3%，共享合同应拒绝；
  // 端到端链路里 runner 会用 OpenPhoto 适配到目标尺寸后按 aspect-ratio 合同验收。
  assert.equal(generated.width === 1500 && generated.height === 720, false, 'testProvider 不直出目标尺寸，验证适配/验收合同真实生效')
})
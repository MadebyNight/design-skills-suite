import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import test from 'node:test'
import { Registry, validate } from '../../design-skill-contracts/scripts/validate.mjs'
import { CONTRACT_DIR } from '../../skill-alipay-pages/scripts/build-catalog.mjs'
import {
  DEFAULT_IMAGE_SLOTS,
  DEFAULT_LANDING_THEMES,
  deriveLandingConfig,
  enumerateImageSlots,
  loadLandingCatalog,
  normalizeDesignBrief,
  planLanding,
  LANDING_PACKAGE_ROOT,
  LANDING_PAGE_TYPE,
  LANDING_SCHEMA_VERSION,
} from '../runtime/planner.mjs'
import { normalizePendingAssetRequests, validateAssetRequest } from '../runtime/asset-requester.mjs'
import { blocksFromConfig, designLanding } from '../bin/landing-design.mjs'

const run = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const bin = path.join(here, '..', 'bin', 'landing-design.mjs')
const SCHEMA_DIR = path.join(CONTRACT_DIR, 'schemas')

const DESIGN_BRIEF_ID = 'http://schemas.design-agent.local/design-skill/v1/design-brief.schema.json'
const DESIGN_PACKAGE_ID = 'http://schemas.design-agent.local/design-skill/v1/design-package.schema.json'
const ASSET_REQUEST_ID = 'http://schemas.design-agent.local/design-skill/v1/asset-request.schema.json'
const LANDING_CONFIG_ID = 'http://schemas.design-agent.local/design-skill/v1/landing-config.schema.json'

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'alipay-landing-'))
}

function validBrief(overrides = {}) {
  return {
    id: 'brief-landing-test',
    goal: '为演唱会租赁活动设计一个支付宝落地页',
    deliverableType: 'alipay.landing',
    audience: '25-35 岁城市年轻用户',
    brandConstraints: ['只允许使用现有落地页组件', '禁止新增 class', '禁止内联样式'],
    contentRequirements: ['精选演唱会靓机', '全场设备日租 0.01 元起'],
    visualConstraints: ['保持清爽色调', '信息层级清晰'],
    outputSpec: { width: 375, height: 812, format: 'png' },
    inputArtifacts: [],
    researchPolicy: 'optional',
    forbiddenChanges: ['修改按钮圆角', '新增组件', '修改 tokens'],
    ...overrides,
  }
}

function assertValid(obj, schemaId) {
  const registry = Registry.fromDirectory(SCHEMA_DIR)
  const schema = registry.byId.get(schemaId).schema
  assert.deepEqual(validate(obj, schema, registry, schema.$id), [])
}

async function cli(args, env = {}) {
  try {
    const { stdout } = await run(process.execPath, [bin, ...args], {
      cwd: LANDING_PACKAGE_ROOT,
      env: { ...process.env, ...env },
    })
    return { code: 0, stdout }
  } catch (e) {
    return { code: e.code || 1, stdout: e.stdout || '' }
  }
}

test('landing catalog 只有 7 类组件且页面类型为 alipay.landing', () => {
  const catalog = loadLandingCatalog()
  assert.equal(catalog.pageType, LANDING_PAGE_TYPE)
  assert.equal(catalog.components.length, 7)
})

test('DesignBrief 校验：合法通过，非 landing 拒绝', () => {
  const brief = validBrief()
  assert.equal(normalizeDesignBrief(brief).id, 'brief-landing-test')
  assert.equal(normalizeDesignBrief(JSON.stringify(brief)).id, 'brief-landing-test')
  const home = validBrief({ deliverableType: 'alipay.home' })
  assert.throws(() => normalizeDesignBrief(home), (e) => e.code === 'UNSUPPORTED_DELIVERABLE')
  assert.throws(() => normalizeDesignBrief('{"id":1}'), (e) => e.code === 'INVALID_BRIEF')
  assert.throws(() => normalizeDesignBrief('not-json'), (e) => e.code === 'INVALID_JSON')
})

test('枚举图片槽位：稳定默认映射齐备且尺寸正确', () => {
  const { slots } = enumerateImageSlots()
  const files = Object.keys(DEFAULT_IMAGE_SLOTS)
  assert.equal(slots.length, files.length, '所有稳定默认槽位都应被枚举')
  for (const slot of slots) {
    const def = DEFAULT_IMAGE_SLOTS[slot.file]
    assert.ok(def, `未知槽位文件：${slot.file}`)
    assert.equal(slot.targetWidth, def.width)
    assert.equal(slot.targetHeight, def.height)
    assert.equal(slot.usageSlot, def.usage)
    assert.ok(['cover', 'contain'].includes(slot.fit), `非法 fit：${slot.fit}`)
  }
  // 抽查稳定默认值
  const byFile = Object.fromEntries(slots.map((s) => [s.file, s]))
  assert.equal(byFile['hero.png'].usageSlot, 'landing.slot.hero')
  assert.equal(byFile['hero.png'].targetWidth, 375)
  assert.equal(byFile['hero.png'].targetHeight, 180)
  assert.equal(byFile['image-ad.png'].usageSlot, 'landing.slot.image-ad')
  assert.equal(byFile['image-ad.png'].targetWidth, 375)
  assert.equal(byFile['image-ad.png'].targetHeight, 120)
  assert.equal(byFile['product-osmo.jpg'].usageSlot, 'landing.slot.product.1')
  assert.equal(byFile['product-vivo.jpg'].usageSlot, 'landing.slot.product.2')
  assert.equal(byFile['product-fuji.png'].usageSlot, 'landing.slot.product.3')
  assert.equal(byFile['product-osmo.jpg'].targetWidth, 184)
  assert.equal(byFile['product-osmo.jpg'].targetHeight, 152)
  assert.equal(byFile['product-fuji.png'].fit, 'contain')
  assert.equal(byFile['hero.png'].fit, 'cover')
})

test('缺图请求：规划层为每个缺图槽生成合法 AssetRequest', () => {
  const plan = planLanding(validBrief())
  assert.ok(plan.assetRequests.length >= 1)
  const ids = new Set()
  for (const req of plan.assetRequests) {
    assertValid(req, ASSET_REQUEST_ID)
    ids.add(req.id)
    assert.equal(req.id, req.usageSlot)
    assert.equal(req.allowEdit, true, '缺图请求允许对本次生成结果做交付适配')
  }
  assert.equal(ids.size, plan.assetRequests.length, 'AssetRequest id 唯一')
  // 文本首版只替换前两个 lp-section-title，截断 16 字
  assert.equal(plan.texts.length, 2, '应替换前两个区块标题')
  assert.equal(plan.texts[0].className, 'lp-section-title')
  assert.equal(plan.texts[0].index, 0)
  assert.equal(plan.texts[1].index, 1)
  assert.ok(plan.texts.every((t) => t.value.length <= 16), '文案应截断 16 字')
  assert.match(plan.texts[0].value, /精选/)
})

test('已有图回填：输入素材命中槽位时回填而非请求', () => {
  const { slots } = enumerateImageSlots()
  const target = slots.find((s) => s.file === 'hero.png')
  const tmp = temporaryDirectory()
  try {
    // 构造一个真实存在的素材文件
    const fakePath = path.join(tmp, 'hero.png')
    fs.writeFileSync(fakePath, 'fake-bytes')
    const artifact = {
      assetRequestId: target.usageSlot,
      artifactId: 'asset-hero',
      path: fakePath,
      mimeType: 'image/png',
      width: 375,
      height: 180,
      sha256: 'a'.repeat(64),
      sourceSkill: 'skill-image-generate',
      sourceSkillVersion: '0.1.0',
      strictSizeSatisfied: true,
      notes: [],
    }
    const brief = validBrief({ inputArtifacts: [artifact] })
    const plan = planLanding(brief)
    assert.ok(plan.assetRequests.length < Object.keys(DEFAULT_IMAGE_SLOTS).length, '回填后缺图请求应减少')
    const change = plan.imageChanges.find((c) => c.currentSrc === target.href)
    assert.ok(change, '应生成对应图片替换')
    assert.equal(change.sourcePath, fakePath)
    assert.equal(plan.assetRequests.some((r) => r.usageSlot === target.usageSlot), false)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('designLanding 四项同源产物：config/guide 落盘且 designPackage 记录', async () => {
  const outputRoot = temporaryDirectory()
  try {
    const brief = validBrief({
      contentRequirements: ['精选演唱会活动专场促销文案',
        '落地灯日租低至 0.01 元起',
        '第三条不应生效'],
    })
    const { designPackage } = await designLanding({ brief, outputRoot })
    assert.equal(designPackage.designBriefId, brief.id)
    // 四项同源产物齐备
    assert.ok(fs.existsSync(path.join(outputRoot, 'landing-config.json')))
    assert.ok(fs.existsSync(path.join(outputRoot, 'prototype.html')))
    assert.ok(fs.existsSync(path.join(outputRoot, 'configuration-guide.md')))
    assert.ok(fs.existsSync(path.join(outputRoot, 'assets')))
    // landing-config.json 符合 landing-schema/v1 严格 Schema
    const landingConfig = JSON.parse(fs.readFileSync(path.join(outputRoot, 'landing-config.json'), 'utf8'))
    assertValid(landingConfig, LANDING_CONFIG_ID)
    assert.equal(landingConfig.schemaVersion, LANDING_SCHEMA_VERSION)
    // prototype 与配置同源：标题来自 config.modules 的 SECTION_TITLE，第三条不消费
    const html = fs.readFileSync(path.join(outputRoot, 'prototype.html'), 'utf8')
    const title = landingConfig.modules.find((m) => m.type === 'SECTION_TITLE')
    assert.ok(title, '默认派生应含 SECTION_TITLE')
    assert.ok(html.includes(title.mode.text))
    assert.match(html, new RegExp(title.mode.text))
    assert.doesNotMatch(html, /第三条不应生效/)
    assert.doesNotMatch(html, /\.\.\/(?:assets|styles)/)
    assert.ok(fs.existsSync(path.join(outputRoot, 'validation-report.json')))
    // configuration-guide.md 从同一份配置渲染
    const guide = fs.readFileSync(path.join(outputRoot, 'configuration-guide.md'), 'utf8')
    assert.ok(guide.includes(landingConfig.page.name))
    assert.ok(guide.includes('landing-config.json'))
    assert.ok(guide.includes('发布前必填'))
    // DesignPackage 元数据符合契约并记录配置产物 kind
    assertValid(designPackage, DESIGN_PACKAGE_ID)
    const kinds = new Set(designPackage.files.map((f) => f.kind))
    assert.ok(kinds.has('landing-config.json'))
    assert.ok(kinds.has('configuration-guide.md'))
    assert.ok(designPackage.files.some((f) => f.kind === 'prototype.html'))
    assert.ok(designPackage.files.every((f) => !f.sha256 || /^[a-f0-9]{64}$/.test(f.sha256)))
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true })
  }
})

test('缺图请求 + 回填组装后的 asset 数量一致', async () => {
  const outputRoot = temporaryDirectory()
  try {
    const brief = validBrief()
    const { pendingAssetRequests, status, warnings } = await designLanding({ brief, outputRoot })
    assert.ok(pendingAssetRequests.length >= 1)
    assert.equal(status, 'completed_with_pending_assets', '缺图时状态不得伪装 succeeded')
    // asset-manifest.json 与返回的 pendingAssetRequests 同源一致
    const manifest = JSON.parse(fs.readFileSync(path.join(outputRoot, 'asset-manifest.json'), 'utf8'))
    assert.deepEqual(manifest.pendingAssetRequests, pendingAssetRequests)
    for (const req of pendingAssetRequests) assertValid(req, ASSET_REQUEST_ID)
    // 缺图槽位保持 pending，但原型继续使用快照素材，不能提前显示失败。
    const html = fs.readFileSync(path.join(outputRoot, 'prototype.html'), 'utf8')
    assert.doesNotMatch(html, /素材生成失败/, 'pending 不能显示失败占位')
    assert.equal(warnings.some((w) => w.includes('素材生成失败') || w.includes('素材未回填')), false)
    const guide = fs.readFileSync(path.join(outputRoot, 'configuration-guide.md'), 'utf8')
    assert.match(guide, /待生成，原型暂用快照素材预览/)
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true })
  }
})

test('designLanding 透传 theme/landingKey：落 config/page.name 与槽位命名并同源渲染', async () => {
  const outputRoot = temporaryDirectory()
  try {
    const brief = validBrief()
    const result = await designLanding({ brief, outputRoot, theme: '演唱会租赁', landingKey: 'landing-07' })
    const landingConfig = JSON.parse(fs.readFileSync(path.join(outputRoot, 'landing-config.json'), 'utf8'))
    assert.equal(landingConfig.landingKey, 'landing-07')
    assert.equal(landingConfig.page.name, '演唱会租赁')
    assertValid(landingConfig, LANDING_CONFIG_ID)
    // 素材槽位命名空间携带 landingKey
    for (const req of result.pendingAssetRequests) {
      assert.match(req.usageSlot, /^landing\.landing-07\./)
    }
    // 配置指南同源渲染主题与 landingKey
    const guide = fs.readFileSync(path.join(outputRoot, 'configuration-guide.md'), 'utf8')
    assert.ok(guide.includes('演唱会租赁'))
    assert.ok(guide.includes('landing-07'))
    // 原型标题来自同一配置
    const html = fs.readFileSync(path.join(outputRoot, 'prototype.html'), 'utf8')
    const title = landingConfig.modules.find((m) => m.type === 'SECTION_TITLE')
    assert.ok(title)
    assert.ok(html.includes(title.mode.text))
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true })
  }
})

test('designLanding：accepted 素材回填，pending 不显示失败', async () => {
  const outputRoot = temporaryDirectory()
  try {
    // 构造一个已验收素材：命中 hero 槽位（经内部参数 completedAssets 显式传入）。
    const tmp = temporaryDirectory()
    fs.writeFileSync(path.join(tmp, 'hero.png'), 'fake-bytes')
    const heroAsset = {
      assetRequestId: 'landing.default.hero.image',
      artifactId: 'asset-hero',
      path: path.join(tmp, 'hero.png'),
      mimeType: 'image/png',
      width: 375,
      height: 180,
      sha256: 'a'.repeat(64),
      sourceSkill: 'skill-image-generate',
      sourceSkillVersion: '0.1.0',
      strictSizeSatisfied: true,
      notes: [],
    }
    // 显式诉求只包含主图与标题，命中后应转为 succeeded。
    const brief = validBrief({ goal: '只要主图与标题的活动页', contentRequirements: ['精选靓机'], visualConstraints: ['页面使用纯色背景'] })
    const result = await designLanding({ brief, outputRoot, completedAssets: [heroAsset] })
    const landingConfig = JSON.parse(fs.readFileSync(path.join(outputRoot, 'landing-config.json'), 'utf8'))
    assert.ok(landingConfig.modules.some((m) => m.type === 'HERO_IMAGE'))
    // hero 已回填：不得再出现在 pending 列表
    const heroPending = result.pendingAssetRequests.find((r) => r.usageSlot === 'landing.default.hero.image')
    if (heroPending) throw new Error('hero 已回填，不应再有 pending 请求')
    // 全部回填 → succeeded；pending/accepted 都不显示失败文本
    assert.equal(result.status, 'succeeded')
    const html = fs.readFileSync(path.join(outputRoot, 'prototype.html'), 'utf8')
    assert.doesNotMatch(html, /素材生成失败/)
    // 原型仍受 validateOutput 约束（交付完成即证明）
    const report = JSON.parse(fs.readFileSync(path.join(outputRoot, 'validation-report.json'), 'utf8'))
    assert.equal(report.passed, true)
    fs.rmSync(tmp, { recursive: true, force: true })
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true })
  }
})

test('designLanding：failedAssets 显示失败，审阅报告按 assets/page 顺序记录状态与 375 基准提示', async () => {
  const outputRoot = temporaryDirectory()
  try {
    const result = await designLanding({
      brief: validBrief({ outputSpec: { width: 390, height: 812, format: 'png' } }),
      outputRoot,
      failedAssets: ['landing.default.hero.image'],
    })
    assert.equal(result.pendingAssetRequests.some((request) => request.usageSlot === 'landing.default.hero.image'), false)
    assert.match(fs.readFileSync(path.join(outputRoot, 'prototype.html'), 'utf8'), /素材生成失败/)
    assert.match(fs.readFileSync(path.join(outputRoot, 'configuration-guide.md'), 'utf8'), /按 375px 基准生成/)
    const review = JSON.parse(fs.readFileSync(path.join(outputRoot, 'visual-review.json'), 'utf8'))
    assert.deepEqual(review.sections.map((section) => section.name), ['assets', 'page'])
    assert.equal(review.sections[0].entries.find((entry) => entry.usageSlot === 'landing.default.hero.image').rules, 'failed')
    assert.equal(review.sections[1].rules, 'pending')
    assert.deepEqual(review.warnings, ['视觉模型未配置，已跳过可选视觉评审'])
    assert.ok(result.designPackage.files.some((file) => file.path === 'visual-review.json'))
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true })
  }
})

test('designLanding：背景槽位 pending 保留快照，failed 在页面或对应模块显示诊断', async () => {
  const brief = validBrief({
    goal: '沉浸背景图、优惠券整体背景图、金额区背景图、内容区背景图和商品集合背景图',
    contentRequirements: [],
    visualConstraints: [],
  })
  const backgroundSlots = [
    'landing.default.pageBackground.image',
    'landing.default.couponGroup.1.overallBackground.image',
    'landing.default.couponGroup.1.amountAreaBackground.image',
    'landing.default.couponGroup.1.contentAreaBackground.image',
    'landing.default.productCollection.1.background.image',
  ]
  const pendingRoot = temporaryDirectory()
  const failedRoot = temporaryDirectory()
  try {
    const pending = await designLanding({ brief, outputRoot: pendingRoot })
    assert.deepEqual(
      pending.pendingAssetRequests.filter((request) => backgroundSlots.includes(request.usageSlot)).map((request) => request.usageSlot),
      backgroundSlots,
      '背景 pending 槽位仍进入素材请求链',
    )
    assert.doesNotMatch(fs.readFileSync(path.join(pendingRoot, 'prototype.html'), 'utf8'), /素材生成失败/, '背景 pending 继续显示快照')

    const failed = await designLanding({ brief, outputRoot: failedRoot, failedAssets: backgroundSlots })
    assert.equal(failed.pendingAssetRequests.some((request) => backgroundSlots.includes(request.usageSlot)), false)
    const html = fs.readFileSync(path.join(failedRoot, 'prototype.html'), 'utf8')
    assert.equal((html.match(/素材生成失败/g) || []).length, backgroundSlots.length)
    assert.match(html, /<div class="lp-hero"><span class="lp-section-title">素材生成失败<\/span>/, '页面背景失败在页面顶部可见')
    assert.match(html, /<div class="lp-coupons"[^>]*><span class="lp-section-title">素材生成失败<\/span>/, '优惠券背景失败在优惠券模块内可见')
    assert.match(html, /<div class="lp-products"[^>]*><span class="lp-section-title">素材生成失败<\/span>/, '商品集合背景失败在商品模块内可见')
  } finally {
    fs.rmSync(pendingRoot, { recursive: true, force: true })
    fs.rmSync(failedRoot, { recursive: true, force: true })
  }
})

test('CLI capabilities 输出能力清单', async () => {
  const { code, stdout } = await cli(['capabilities'])
  assert.equal(code, 0)
  const parsed = JSON.parse(stdout)
  assert.equal(parsed.skillManifest.id, 'skill-alipay-landing')
  assert.ok(parsed.capabilities.some((c) => c.id === 'page.alipay.landing.design'))
})

test('CLI 非 landing deliverableType 返回稳定错误', async () => {
  const tmp = temporaryDirectory()
  try {
    const outDir = path.join(tmp, 'out')
    const brief = validBrief({ deliverableType: 'alipay.home' })
    const { code, stdout } = await cli(['request', '--json', JSON.stringify(brief), '--output', outDir])
    assert.equal(code, 1)
    const parsed = JSON.parse(stdout)
    assert.equal(parsed.code, 'UNSUPPORTED_DELIVERABLE')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('真实截图 375 宽度下无横向溢出', async (t) => {
  const outputRoot = temporaryDirectory()
  try {
    const brief = validBrief()
    await designLanding({ brief, outputRoot, screenshot: true })
    assert.ok(fs.existsSync(path.join(outputRoot, 'prototype.png')), '应生成全页截图')
    const designPackage = JSON.parse(fs.readFileSync(path.join(outputRoot, 'design-package.json'), 'utf8'))
    assert.ok(designPackage.files.some((f) => f.kind === 'prototype.png'), '截图应纳入 DesignPackage')
    // screenshot.mjs 在 scrollWidth > 375 时抛错；走到这里即证明无横向溢出
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true })
  }
})

test('测试结束清理临时目录', async () => {
  const out = temporaryDirectory()
  try {
    await designLanding({ brief: validBrief(), outputRoot: out })
  } finally {
    fs.rmSync(out, { recursive: true, force: true })
    assert.equal(fs.existsSync(out), false)
  }
})

// ---------------------------------------------------------------------------
// landing config 派生：DesignBrief + 可选 { theme, landingKey } → landing-schema/v1
// ---------------------------------------------------------------------------

function assertLandingConfigValid(config) {
  const registry = Registry.fromDirectory(SCHEMA_DIR)
  const schema = registry.byId.get(LANDING_CONFIG_ID).schema
  assert.deepEqual(validate(config, schema, registry, schema.$id), [])
}

test('deriveLandingConfig：省略 options 时用默认主题且不含 landingKey', () => {
  const derived = deriveLandingConfig(validBrief())
  assert.equal(derived.config.schemaVersion, LANDING_SCHEMA_VERSION)
  assert.equal(derived.config.page.name, DEFAULT_LANDING_THEMES[0])
  assert.equal(derived.config.landingKey, undefined, '独立交付省略 landingKey')
  // 页面级配置：activityTime 留空交由用户填写，navTitle ≤15。
  assert.deepEqual(derived.config.page.activityTime, { startTime: '', endTime: '' })
  assert.ok(derived.config.page.navTitle.length <= 15)
  assert.equal(derived.config.page.background.type, 'image')
  assert.ok(derived.assetRequests.some((request) => request.slot === 'pageBackground'), '默认主动规划页面背景图')
  assertLandingConfigValid(derived.config)
  // 素材槽位命名空间：landing.default.<slot>.image
  for (const req of derived.assetRequests) {
    assert.match(req.usageSlot, /^landing\.default\.[a-zA-Z0-9.]+\.image$/)
  }
})

test('deriveLandingConfig：仅主题采用完整默认序列，ACTION_BUTTON 仅显式诉求时加入', () => {
  const onlyTheme = deriveLandingConfig(validBrief({
    goal: '夏日租赁主题',
    contentRequirements: [],
    visualConstraints: [],
  }))
  assert.deepEqual(onlyTheme.config.modules.map((module) => module.type), [
    'HERO_IMAGE', 'SPACER', 'COUPON_GROUP', 'SECTION_TITLE',
    'IMAGE_AD', 'SECTION_TITLE', 'PRODUCT_COLLECTION', 'SPACER',
  ])
  assert.equal(onlyTheme.config.modules.some((module) => module.type === 'ACTION_BUTTON'), false)

  const explicitAction = deriveLandingConfig(validBrief({ goal: '夏日租赁主题，需要一个报名按钮', contentRequirements: [], visualConstraints: [] }))
  assert.equal(explicitAction.config.modules.some((module) => module.type === 'ACTION_BUTTON'), true)
})

test('deriveLandingConfig：完整默认序列优先使用两个受控区块文案', () => {
  const derived = deriveLandingConfig(validBrief({
    goal: '开学季视觉主题',
    contentRequirements: ['新学期福利', '开学装备精选'],
    visualConstraints: [],
  }))
  assert.deepEqual(
    derived.config.modules.filter((module) => module.type === 'SECTION_TITLE').map((module) => module.mode.text),
    ['新学期福利', '开学装备精选'],
  )
})

test('deriveLandingConfig：显式主题完全替换默认主题并写入 landingKey', () => {
  const derived = deriveLandingConfig(validBrief(), { theme: '演唱会租赁', landingKey: 'landing-07' })
  assert.equal(derived.config.page.name, '演唱会租赁')
  assert.equal(derived.config.landingKey, 'landing-07')
  for (const req of derived.assetRequests) {
    assert.equal(req.usageSlot, req.id)
    assert.match(req.usageSlot, /^landing\.landing-07\./)
  }
  assertLandingConfigValid(derived.config)
})

test('deriveLandingConfig：演唱会、开学季和金秋主题派生不同的受控模块配色', () => {
  const cases = [
    ['演唱会主题', '#175CD3', '#EAF2FF'],
    ['蓝金开学季主题', '#C99518', '#EEF5FF'],
    ['金秋出行主题', '#B9740B', '#FFF4D6'],
  ]
  for (const [theme, couponColor, productColor] of cases) {
    const derived = deriveLandingConfig(validBrief({ goal: '活动主题', contentRequirements: [], visualConstraints: [] }), { theme })
    const coupon = derived.config.modules.find((module) => module.type === 'COUPON_GROUP')
    const product = derived.config.modules.find((module) => module.type === 'PRODUCT_COLLECTION')
    assert.equal(coupon.amountAreaBackground.color, couponColor)
    assert.equal(product.background.color, productColor)
    assertLandingConfigValid(derived.config)
  }
})

test('deriveLandingConfig：七类白名单模块可配置且产出模块 id 稳定唯一', () => {
  const brief = validBrief({
    goal: '活动页：主图、广告图、区块标题、优惠券、商品集合、跳转按钮和留白都要',
    contentRequirements: ['精选演唱会靓机', '全场日租 0.01 元起', '立即报名'],
  })
  const derived = deriveLandingConfig(brief, { landingKey: 'landing-01' })
  const types = derived.config.modules.map((m) => m.type)
  for (const t of ['HERO_IMAGE', 'IMAGE_AD', 'SECTION_TITLE', 'COUPON_GROUP', 'PRODUCT_COLLECTION', 'ACTION_BUTTON', 'SPACER']) {
    assert.ok(types.includes(t), `缺少白名单模块：${t}`)
  }
  const ids = derived.config.modules.map((m) => m.id)
  assert.equal(new Set(ids).size, ids.length, '模块 id 唯一')
  assert.ok(ids.every((id) => /^[A-Za-z0-9._-]+$/.test(id)), '模块 id 符合稳定 ID 约束')
  assertLandingConfigValid(derived.config)
  // 主图最多 1 个
  assert.equal(types.filter((t) => t === 'HERO_IMAGE').length, 1)
})

test('deriveLandingConfig：标题 ≤20 字截断', () => {
  const long = '这个标题肯定超过二十个字因为我要数一数到底到底到底多少个字呀'
  const derived = deriveLandingConfig(validBrief({ contentRequirements: [long] }))
  const title = derived.config.modules.find((m) => m.type === 'SECTION_TITLE')
  assert.ok(title.mode.text.length <= 20, '标题必须 ≤20 字')
  assert.equal(title.mode.text.length, 20)
})

test('deriveLandingConfig：页面背景单选、activityTime 留空并写入 pendingResourceRequests', () => {
  const derived = deriveLandingConfig(validBrief({
    goal: '带优惠券和商品的落地页',
    inputArtifacts: [],
  }), { theme: '夏日出游租赁' })
  const cfg = derived.config
  // 页面级配置三项：name/navTitle/background（活动时间固定留空）
  assert.deepEqual(cfg.page.activityTime, { startTime: '', endTime: '' })
  // COUPON_GROUP/PRODUCT_COLLECTION 无真实引用 → 结构化待补请求 + 参考样例占位引用
  const couponModule = cfg.modules.find((m) => m.type === 'COUPON_GROUP')
  const productModule = cfg.modules.find((m) => m.type === 'PRODUCT_COLLECTION')
  assert.ok(cfg.pendingResourceRequests.some((r) => r.resourceType === 'coupon' && r.moduleRef === couponModule.id))
  assert.ok(cfg.pendingResourceRequests.some((r) => r.resourceType === 'product' && r.moduleRef === productModule.id))
  assertLandingConfigValid(cfg)
  // 提供真实引用 ID 后 pendingResourceRequests 归零
  const withRefs = deriveLandingConfig(validBrief({
    goal: '带优惠券和商品的落地页',
    inputArtifacts: [{ couponTemplateId: 'cpt-9001' }, { productId: 'itm-9002' }],
  }))
  assert.deepEqual(withRefs.pendingResourceRequests, [])
  const cg = withRefs.config.modules.find((m) => m.type === 'COUPON_GROUP')
  assert.equal(cg.coupons[0].couponTemplateId, 'cpt-9001')
})

test('deriveLandingConfig：页面背景无需关键词即生成，明确纯色时使用主题纯色', () => {
  const automatic = deriveLandingConfig(validBrief({
    goal: '绿色调开学季主题',
    contentRequirements: [],
    visualConstraints: [],
  }), { theme: '绿色调开学季主题', landingKey: 'landing-02' })
  assert.deepEqual(automatic.config.page.background, {
    type: 'image',
    image: 'assets/landing-02.pageBackground.image.png',
  })
  assert.ok(automatic.assetRequests.some((request) => request.slot === 'pageBackground'))

  const solid = deriveLandingConfig(validBrief({
    goal: '绿色调开学季主题',
    contentRequirements: [],
    visualConstraints: ['页面使用纯色背景'],
  }), { theme: '绿色调开学季主题', landingKey: 'landing-02' })
  assert.deepEqual(solid.config.page.background, { type: 'color', color: '#EEF5FF' })
  assert.equal(solid.assetRequests.some((request) => request.slot === 'pageBackground'), false)
})

test('主题背景和已声明区块背景各有独立槽位与输出路径', () => {
  const derived = deriveLandingConfig(validBrief({
    goal: '沉浸背景图、图片标题、优惠券整体背景图、金额区背景图、内容区背景图和商品集合背景图',
    contentRequirements: [],
    visualConstraints: [],
  }))
  assert.equal(derived.config.page.background.type, 'image')
  const slots = derived.assetRequests.map((request) => request.slot)
  assert.deepEqual(slots, [
    'pageBackground', 'hero', 'sectionTitle.1', 'couponGroup.1.overallBackground',
    'couponGroup.1.amountAreaBackground', 'couponGroup.1.contentAreaBackground',
    'productCollection.1.background',
  ])
  assert.equal(new Set(derived.assetRequests.map((request) => request.usageSlot)).size, slots.length)
  const { assetRequests } = blocksFromConfig(derived.config)
  assert.deepEqual(assetRequests.map((request) => request.slot), slots)
  assert.equal(new Set(assetRequests.map((request) => request.outputPath)).size, assetRequests.length)
})

test('素材请求隔离参考图，并把 ResearchPack 受控建议写入槽位提示词', async () => {
  const outputRoot = temporaryDirectory()
  try {
    const referencePath = path.join(outputRoot, 'hero-reference.png')
    fs.writeFileSync(referencePath, 'reference')
    const result = await designLanding({
      brief: validBrief({
        goal: '主图和双图广告',
        inputArtifacts: [{
          assetRequestId: 'landing.default.hero.image', artifactId: 'asset-reference', path: referencePath,
          mimeType: 'image/png', width: 1500, height: 720, sha256: 'a'.repeat(64),
          sourceSkill: 'user-input', sourceSkillVersion: '0.0.0', strictSizeSatisfied: false, notes: [],
        }],
      }),
      outputRoot,
      researchPack: {
        queries: [], sources: [], adoptedElements: [],
        signals: [{ kind: 'color', value: '使用蓝色低饱和配色', sourceRefs: [] }],
      },
    })
    const hero = result.pendingAssetRequests.find((request) => request.usageSlot === 'landing.default.hero.image')
    const ad = result.pendingAssetRequests.find((request) => request.usageSlot === 'landing.default.imageAd.1.image')
    assert.equal(hero.referenceImages.length, 1)
    assert.equal(ad.referenceImages.length, 0)
    assert.match(hero.theme, /目标比例 1500:720/)
    assert.match(hero.theme, /使用蓝色低饱和配色/)
    assert.notEqual(hero.theme, ad.theme, '不同 usageSlot 必须使用独立提示词')
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true })
  }
})

test('deriveLandingConfig：素材槽位 landing.<key>.<slot>.image 初始为 pending', () => {
  const derived = deriveLandingConfig(validBrief({ goal: '主图加广告图' }), { landingKey: 'landing-02' })
  const slots = derived.assetRequests.map((r) => r.usageSlot)
  // 默认派生 IMAGE_AD 为单图模式：恰好 1 张 1404x480。
  assert.deepEqual(slots, [
    'landing.landing-02.pageBackground.image',
    'landing.landing-02.hero.image',
    'landing.landing-02.imageAd.1.image',
  ])
  for (const req of derived.assetRequests) {
    assert.equal(req.status, 'pending')
    assert.equal(req.diagnosticPlaceholder, undefined)
    assert.equal(req.allowGenerate, undefined, 'derive 层只描述 pending 槽位')
  }
  // 槽位尺寸按模块 mode：hero 1500x720；IMAGE_AD 单图 1404x480
  const ad = derived.assetRequests.filter((r) => r.slot.startsWith('imageAd'))
  assert.equal(ad.length, 1)
  assert.equal(ad[0].targetWidth, 1404)
  assert.equal(ad[0].targetHeight, 480)
  const hero = derived.assetRequests.find((r) => r.slot === 'hero')
  assert.equal(hero.targetWidth, 1500)
  assert.equal(hero.targetHeight, 720)
})

test('deriveLandingConfig：默认单图 1404x480；明确双图诉求派生 double 两图 686x480', () => {
  // 默认（brief 未提双图）：单图模式恰好 1 张 1404x480。
  const single = deriveLandingConfig(validBrief({ goal: '主图加广告图' }), { landingKey: 'landing-02' })
  const singleConfigAd = single.config.modules.find((m) => m.type === 'IMAGE_AD')
  assert.deepEqual(singleConfigAd.mode, { mode: 'single', count: 1 }, '默认派生单图 IMAGE_AD')
  assert.deepEqual(singleConfigAd.images, [`assets/landing-02.imageAd.1.image.png`])
  const singleReq = single.assetRequests.find((r) => r.slot === 'imageAd.1')
  assert.deepEqual([singleReq.targetWidth, singleReq.targetHeight], [1404, 480], '单图 1404x480')

  // 明确双图诉求：derive 从受控 brief 文本解析出 double 两图。
  const double = deriveLandingConfig(
    validBrief({ goal: '为演唱会设备租赁设计带主图与双图广告图的支付宝落地页' }),
    { landingKey: 'landing-02' },
  )
  const doubleModule = double.config.modules.find((m) => m.type === 'IMAGE_AD')
  assert.ok(doubleModule, '双图诉求应派生 IMAGE_AD 模块')
  assert.deepEqual(doubleModule.mode, { mode: 'double', count: 2 }, 'brief 明确双图 → mode=double count=2')
  assert.equal(doubleModule.images.length, 2, '双图模块恰好 2 张图')
  assertLandingConfigValid(double.config)
  // 双图两条请求，单张 686x480。
  const doubleSlots = double.assetRequests.filter((r) => r.slot.startsWith('imageAd'))
  assert.deepEqual(doubleSlots.map((s) => s.slot), ['imageAd.1', 'imageAd.2'])
  for (const req of doubleSlots) {
    assert.deepEqual([req.targetWidth, req.targetHeight], [686, 480], '双图单张 686x480')
  }
  // 真实 AssetRequest（bin 层）带比例验收 + 重试合同：误差 ≤3%，生成 3 次/适配 2 次
  assert.equal(single.assetRequests.every((r) => r.acceptance === undefined), true, 'derive 层状态数据不携带执行合同（合同在 bin 组装真实请求时追加）')
})

test('deriveLandingConfig：拒绝 jumpUrl/pageCode 与白名单外请求', () => {
  // 字段式生产字段注入
  assert.throws(
    () => deriveLandingConfig(validBrief({ forbiddenChanges: [{ jumpUrl: 'https://x' }] })),
    (e) => e.code === 'FORBIDDEN_FIELD',
  )
  // 文本式生产字段请求
  assert.throws(
    () => deriveLandingConfig(validBrief({ contentRequirements: ['按钮直接给我 jumpUrl 跳到外链'] })),
    (e) => e.code === 'FORBIDDEN_FIELD',
  )
  assert.throws(
    () => deriveLandingConfig(validBrief({ goal: '生成带 pageCode 的页面' })),
    (e) => e.code === 'FORBIDDEN_FIELD',
  )
  // options 中夹带 pageCode 拒绝
  assert.throws(
    () => deriveLandingConfig(validBrief(), { pageCode: 'LP-20260831-ABCD1234' }),
    (e) => e.code === 'INVALID_OPTIONS',
  )
  // 越界 landingKey
  assert.throws(
    () => deriveLandingConfig(validBrief(), { landingKey: 'key-01' }),
    (e) => e.code === 'INVALID_LANDING_KEY',
  )
  // 白名单外模块（视频/表单/倒计时）→ warning + 不落地该模块
  const derived = deriveLandingConfig(validBrief({ goal: '做一个带视频和倒计时的页面' }))
  assertLandingConfigValid(derived.config)
  assert.ok(derived.config.modules.every((m) => m.type !== 'VIDEO'), '白名单外模块不得写入 modules')
  assert.ok(derived.warnings.some((w) => w.includes('拒绝白名单外模块请求')))
})

test('deriveLandingConfig：非 landing deliverableType 拒绝', () => {
  assert.throws(
    () => deriveLandingConfig(validBrief({ deliverableType: 'alipay.home' })),
    (e) => e.code === 'UNSUPPORTED_DELIVERABLE',
  )
})

// ---------------------------------------------------------------------------
// 素材链路合同（docs/superpowers/specs/2026-09-01-page-asset-pipeline-design.md）
// ---------------------------------------------------------------------------

test('真实素材请求采用比例验收 3% 与 3+2 重试合同且通过 AssetRequest Schema', async () => {
  const outputRoot = temporaryDirectory()
  try {
    const { pendingAssetRequests } = await designLanding({ brief: validBrief(), outputRoot })
    assert.ok(pendingAssetRequests.length >= 1)
    for (const req of pendingAssetRequests) {
      assertValid(req, ASSET_REQUEST_ID, '含 acceptance/retryPolicy 的请求必须过公共 Schema')
      // 槽位命名统一 landing.<landingKey>.<slot>.image
      assert.match(req.usageSlot, /^landing\.default\.[a-zA-Z0-9.]+\.image$/)
      assert.equal(req.id, req.usageSlot)
      // 比例验收：3%（边界值通过）；重试：生成 3 次/适配 2 次
      assert.deepEqual(req.acceptance, { mode: 'aspect-ratio', maxAspectRatioError: 0.03 })
      assert.deepEqual(req.retryPolicy, { generateMaxAttempts: 3, adaptMaxAttempts: 2 })
    }
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true })
  }
})

test('IMAGE_AD 槽位尺寸按模块 mode：单图 1404x480，双图单张 686x480', () => {
  // 单图（derive 默认）
  const single = blocksFromConfig(deriveLandingConfig(validBrief({ goal: '主图加广告图' })).config)
  const singleAd = single.assetRequests.filter((r) => r.slot.startsWith('imageAd'))
  assert.equal(singleAd.length, 1)
  assert.deepEqual([singleAd[0].targetWidth, singleAd[0].targetHeight], [1404, 480])
  assert.equal(single.blocks.filter((b) => b.component === 'lp-image-ad').length, 1)
  assert.equal(single.blocks[0].variants, undefined, '单图保持模块容器 is-single 默认')

  // 双图（brief 明确双图诉求 → derive 派生 double）
  const derived = deriveLandingConfig(validBrief({ goal: '主图加双图广告的活动页' }))
  const double = blocksFromConfig(derived.config)
  const doubleAd = double.assetRequests.filter((r) => r.slot.startsWith('imageAd'))
  assert.equal(doubleAd.length, 2)
  for (const req of doubleAd) {
    assert.deepEqual([req.targetWidth, req.targetHeight], [686, 480], '双图单张 686x480')
  }
  // 双图在同一个受控 is-double 容器内横向并排。
  const doubleBlocks = double.blocks.filter((b) => b.component === 'lp-image-ad')
  assert.equal(doubleBlocks.length, 1)
  assert.equal(doubleBlocks[0].double, true)
})

test('designLanding 不为商品图片创建素材请求', async () => {
  const outputRoot = temporaryDirectory()
  try {
    // PRODUCT_COLLECTION 存在时也不产生商品图片请求
    const brief = validBrief({ goal: '主图、广告图和商品集合的活动页' })
    const { pendingAssetRequests } = await designLanding({ brief, outputRoot })
    assert.ok(pendingAssetRequests.every((r) => !r.usageSlot.includes('product')), '商品图片不进入请求链')
    const slots = pendingAssetRequests.map((r) => r.usageSlot)
    assert.ok(!slots.some((s) => s.startsWith('landing.default.product')), '不创建商品素材请求')
    // pending 请求均通过合同校验（含 acceptance/retryPolicy）
    for (const req of pendingAssetRequests) {
      assert.equal(req.acceptance.mode, 'aspect-ratio')
      assert.equal(req.retryPolicy.generateMaxAttempts, 3)
    }
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true })
  }
})

test('用户输入图片不直接作为最终素材：只进 referenceImages，原型无其回填', async () => {
  const outputRoot = temporaryDirectory()
  try {
    const tmp = temporaryDirectory()
    const inputPath = path.join(tmp, 'user-input.png')
    fs.writeFileSync(inputPath, 'user-bytes')
    const userAsset = {
      assetRequestId: 'landing.default.hero.image',
      artifactId: 'asset-user-input',
      path: inputPath,
      mimeType: 'image/png',
      width: 500,
      height: 200,
      sha256: 'b'.repeat(64),
      sourceSkill: 'user-input',
      sourceSkillVersion: '0.0.0',
      strictSizeSatisfied: false,
      notes: ['用户上传参考图'],
    }
    const brief = validBrief({ inputArtifacts: [userAsset], goal: '只要主图与标题的活动页', contentRequirements: ['精选靓机'] })
    const result = await designLanding({ brief, outputRoot })
    // 用户输入图不得直接当作最终素材：hero 槽位仍为 pending（除非另有已验收素材）
    const heroPending = result.pendingAssetRequests.find((r) => r.usageSlot === 'landing.default.hero.image')
    assert.ok(heroPending, '用户输入图不参与首次回填：hero 保持待生成')
    assert.equal(result.status, 'completed_with_pending_assets')
    // 但作为参考候选进入请求
    assert.ok(heroPending.referenceImages.some((r) => r.path === inputPath), '用户输入图应登记为 referenceImages 候选')
    // 原型无用户图片回填：仍为快照素材，pending 不能显示失败。
    const html = fs.readFileSync(path.join(outputRoot, 'prototype.html'), 'utf8')
    assert.doesNotMatch(html, /素材生成失败/)
    assert.ok(fs.existsSync(path.join(outputRoot, 'assets', 'default.hero.image.png')), '快照素材用于 pending 预览')
    fs.rmSync(tmp, { recursive: true, force: true })
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true })
  }
})

test('比例合格 brief 输入素材不直出：任意 sourceSkill 仅作参考图，completedAssets 显式传入才回填', async () => {
  const outputRoot = temporaryDirectory()
  try {
    const tmp = temporaryDirectory()
    const inputPath = path.join(tmp, 'user-input-exact.png')
    fs.writeFileSync(inputPath, 'user-bytes')
    // 初始公共输入 Artifact：宽高与 hero 槽位完全一致（sourceSkill 伪装为生成 Skill）。
    const userInput = {
      assetRequestId: 'landing.default.hero.image',
      artifactId: 'asset-user-input-exact',
      path: inputPath,
      mimeType: 'image/png',
      width: 1500,
      height: 720,
      sha256: 'b'.repeat(64),
      sourceSkill: 'skill-image-generate',
      sourceSkillVersion: '0.1.0',
      strictSizeSatisfied: true,
      notes: ['用户上传参考图'],
    }
    const brief = validBrief({ inputArtifacts: [userInput], goal: '只要主图与标题的活动页', contentRequirements: ['精选靓机'], visualConstraints: ['页面使用纯色背景'] })
    const result = await designLanding({ brief, outputRoot })
    // 比例合格也不得作为 imageChanges 直出：hero 保持 pending（诊断占位），状态不伪装 succeeded
    const heroPending = result.pendingAssetRequests.find((r) => r.usageSlot === 'landing.default.hero.image')
    assert.ok(heroPending, 'user-input 比例合格也不回填：hero 保持待生成')
    assert.equal(result.status, 'completed_with_pending_assets')
    assert.ok(heroPending.referenceImages.some((r) => r.path === inputPath), 'user-input 素材最多进 referenceImages')
    // 原型仍使用快照素材，user-input 图不进入最终 HTML 与素材包
    const html = fs.readFileSync(path.join(outputRoot, 'prototype.html'), 'utf8')
    assert.doesNotMatch(html, /素材生成失败/)
    assert.equal(html.includes('user-input-exact.png'), false, 'user-input 图不以原文件名进入最终 HTML')
    assert.ok(fs.existsSync(path.join(outputRoot, 'assets', 'default.hero.image.png')), 'pending 使用快照素材')
    // 非 user-input 的原始 brief 输入同样视为用户参考图：不直出，槽位保持 pending
    const compatRoot = temporaryDirectory()
    try {
      const genPath = path.join(compatRoot, 'generated-hero.png')
      fs.writeFileSync(genPath, 'gen-bytes')
      const generated = { ...userInput, path: genPath, sha256: 'c'.repeat(64), sourceSkill: 'skill-image-generate', sourceSkillVersion: '0.1.0' }
      const compat = await designLanding({
        brief: validBrief({ inputArtifacts: [generated], goal: '只要主图与标题的活动页', contentRequirements: ['精选靓机'], visualConstraints: ['页面使用纯色背景'] }),
        outputRoot: compatRoot,
      })
      assert.equal(compat.status, 'completed_with_pending_assets', '任意 sourceSkill 的 brief 输入都不直出：槽位保持 pending')
      assert.ok(compat.pendingAssetRequests.some((r) => r.usageSlot === 'landing.default.hero.image'))
      const compatHtml = fs.readFileSync(path.join(compatRoot, 'prototype.html'), 'utf8')
      assert.doesNotMatch(compatHtml, /素材生成失败/, 'brief 输入不回填：槽位保持 pending')
    } finally {
      fs.rmSync(compatRoot, { recursive: true, force: true })
    }
    // 已验收素材经内部参数 completedAssets 显式传入才可回填（编排器二次回填路径）
    const refillRoot = temporaryDirectory()
    try {
      const refillPath = path.join(refillRoot, 'accepted-hero.png')
      fs.writeFileSync(refillPath, 'accepted-bytes')
      const accepted = {
        ...userInput,
        path: refillPath,
        sha256: 'd'.repeat(64),
        sourceSkill: 'skill-image-generate',
        sourceSkillVersion: '0.1.0',
      }
      const refilled = await designLanding({
        brief: validBrief({ goal: '只要主图与标题的活动页', contentRequirements: ['精选靓机'], visualConstraints: ['页面使用纯色背景'] }),
        outputRoot: refillRoot,
        completedAssets: [accepted],
      })
      assert.equal(refilled.status, 'succeeded', 'completedAssets 命中槽位且比例合格应回填')
      assert.equal(refilled.pendingAssetRequests.some((r) => r.usageSlot === 'landing.default.hero.image'), false)
      const refillHtml = fs.readFileSync(path.join(refillRoot, 'prototype.html'), 'utf8')
      assert.doesNotMatch(refillHtml, /素材生成失败/, '已回填槽位不显示失败')
      assert.ok(fs.existsSync(path.join(refillRoot, 'assets', 'default.hero.image.png')), '回填素材复制进素材包')
    } finally {
      fs.rmSync(refillRoot, { recursive: true, force: true })
    }
    fs.rmSync(tmp, { recursive: true, force: true })
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true })
  }
})

test('completedAssets 比例浮点边界：理论恰好 3% 回填（epsilon），实际略超仍拒', async () => {
  // hero 1500x720 槽位：1545x720 理论恰好 3% 误差，但 IEEE754 下
  // (1545/720)/(1500/720) - 1 = 0.030000000000000027，无 epsilon 会被误拒
  //（与 orchestrator shared acceptance 的 1030x1000 vs 1:1 案例同一浮点语义）。
  const outputRoot = temporaryDirectory()
  try {
    const tmp = temporaryDirectory()
    const boundaryPath = path.join(tmp, 'hero-boundary.png')
    fs.writeFileSync(boundaryPath, 'boundary-bytes')
    const boundaryAsset = {
      assetRequestId: 'landing.default.hero.image',
      artifactId: 'asset-hero-boundary',
      path: boundaryPath,
      mimeType: 'image/png',
      width: 1545,
      height: 720,
      sha256: 'e'.repeat(64),
      sourceSkill: 'skill-image-generate',
      sourceSkillVersion: '0.1.0',
      strictSizeSatisfied: false,
      notes: [],
    }
    const brief = validBrief({ goal: '只要主图与标题的活动页', contentRequirements: ['精选靓机'], visualConstraints: ['页面使用纯色背景'] })
    const boundary = await designLanding({ brief, outputRoot, completedAssets: [boundaryAsset] })
    // 理论恰好 3%（浮点噪声 0.030000000000000027）：必须通过验收并回填
    assert.equal(boundary.pendingAssetRequests.some((r) => r.usageSlot === 'landing.default.hero.image'), false, '理论恰好 3% 边界应通过验收回填')
    assert.equal(boundary.status, 'succeeded')
    assert.ok(fs.existsSync(path.join(outputRoot, 'assets', 'default.hero.image.png')), '浮点边界素材应复制进素材包')
    const boundaryHtml = fs.readFileSync(path.join(outputRoot, 'prototype.html'), 'utf8')
    assert.doesNotMatch(boundaryHtml, /素材生成失败/, '浮点边界回填后不显示失败')

    // 实际略超（1546x720 ≈ 3.07%）：仍然拒绝，槽位保持 pending + 诊断占位
    const overRoot = temporaryDirectory()
    try {
      const overPath = path.join(tmp, 'hero-over.png')
      fs.writeFileSync(overPath, 'over-bytes')
      const overAsset = { ...boundaryAsset, path: overPath, width: 1546, height: 720, sha256: 'f'.repeat(64) }
      const over = await designLanding({
        brief: validBrief({ goal: '只要主图与标题的活动页', contentRequirements: ['精选靓机'], visualConstraints: ['页面使用纯色背景'] }),
        outputRoot: overRoot,
        completedAssets: [overAsset],
      })
      assert.ok(over.pendingAssetRequests.some((r) => r.usageSlot === 'landing.default.hero.image'), '实际略超（≈3.07%）仍拒绝')
      assert.equal(over.status, 'completed_with_pending_assets')
      assert.ok(over.warnings.some((w) => w.includes('未通过槽位')), '超差素材记 warning 且不回填')
    } finally {
      fs.rmSync(overRoot, { recursive: true, force: true })
    }
    fs.rmSync(tmp, { recursive: true, force: true })
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true })
  }
})

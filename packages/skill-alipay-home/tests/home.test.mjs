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
  FIXED_IMAGE_SLOTS,
  enumerateImageSlots,
  loadHomeCatalog,
  normalizeDesignBrief,
  planHome,
  deriveHomeConfig,
  HOME_CONFIG_SCHEMA_VERSION,
  HOME_MODULES,
  HOME_PACKAGE_ROOT,
  HOME_PAGE_TYPE,
  detectConstraintViolation,
  enumerateHomeConfigImageSlots,
} from '../runtime/planner.mjs'
import { normalizePendingAssetRequests, validateAssetRequest } from '../runtime/asset-requester.mjs'
import { designHome } from '../bin/home-design.mjs'

const run = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const bin = path.join(here, '..', 'bin', 'home-design.mjs')
const SCHEMA_DIR = path.join(CONTRACT_DIR, 'schemas')

const DESIGN_BRIEF_ID = 'http://schemas.design-agent.local/design-skill/v1/design-brief.schema.json'
const DESIGN_PACKAGE_ID = 'http://schemas.design-agent.local/design-skill/v1/design-package.schema.json'
const ASSET_REQUEST_ID = 'http://schemas.design-agent.local/design-skill/v1/asset-request.schema.json'
const HOME_CONFIG_ID = 'http://schemas.design-agent.local/design-skill/v1/alipay-home-config.schema.json'

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'alipay-home-'))
}

function validBrief(overrides = {}) {
  return {
    id: 'brief-home-test',
    goal: '为暑期促销设计一个支付宝小程序首页',
    deliverableType: 'alipay.home',
    audience: '25-35 岁城市年轻用户',
    brandConstraints: ['只允许使用现有首页组件', '禁止新增 class', '禁止内联样式'],
    contentRequirements: ['突出暑期优惠，搜索暑期好物'],
    visualConstraints: ['保持清新色调', '信息层级清晰'],
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
      cwd: HOME_PACKAGE_ROOT,
      env: { ...process.env, ...env },
    })
    return { code: 0, stdout }
  } catch (e) {
    return { code: e.code || 1, stdout: e.stdout || '' }
  }
}

test('home catalog 只有 8 类组件且页面类型为 alipay.home', () => {
  const catalog = loadHomeCatalog()
  assert.equal(catalog.pageType, HOME_PAGE_TYPE)
  assert.equal(catalog.components.length, 8)
})

test('DesignBrief 校验：合法通过，非 home 拒绝', () => {
  const brief = validBrief()
  assert.equal(normalizeDesignBrief(brief).id, 'brief-home-test')
  assert.equal(normalizeDesignBrief(JSON.stringify(brief)).id, 'brief-home-test')
  const landing = validBrief({ deliverableType: 'alipay.landing' })
  assert.throws(() => normalizeDesignBrief(landing), (e) => e.code === 'UNSUPPORTED_DELIVERABLE')
  assert.throws(() => normalizeDesignBrief('{"id":1}'), (e) => e.code === 'INVALID_BRIEF')
  assert.throws(() => normalizeDesignBrief('not-json'), (e) => e.code === 'INVALID_JSON')
})

test('枚举图片槽位：可生成槽位采用基线尺寸，固定快照槽位不计请求', () => {
  const { slots } = enumerateImageSlots()
  assert.equal(slots.length, 17, '17 个枚举槽位：banner/5 nav/3 tofu/waist + 搜索/TabBar/商品推荐固定快照')
  for (const slot of slots) {
    const def = DEFAULT_IMAGE_SLOTS[slot.file] || FIXED_IMAGE_SLOTS[slot.file]
    assert.ok(def, `未知槽位文件：${slot.file}`)
    assert.equal(slot.targetWidth, def.width)
    assert.equal(slot.targetHeight, def.height)
    assert.equal(slot.usageSlot, def.usage)
    assert.ok(['cover', 'contain'].includes(slot.fit), `非法 fit：${slot.fit}`)
  }
  // 抽查基线尺寸（spec：轮播 1404x600、金刚区 200x200、豆腐块 690x640/690x312、腰封 1440x328）
  const byFile = Object.fromEntries(slots.map((s) => [s.file, s]))
  assert.equal(byFile['banner-concert.png'].targetWidth, 1404)
  assert.equal(byFile['banner-concert.png'].targetHeight, 600)
  assert.equal(byFile['nav-action-camera.png'].targetWidth, 200)
  assert.equal(byFile['tofu-travel.png'].targetWidth, 690)
  assert.equal(byFile['tofu-travel.png'].targetHeight, 640)
  assert.equal(byFile['tofu-computer.png'].targetHeight, 312)
  assert.equal(byFile['waist.png'].targetWidth, 1440)
  assert.equal(byFile['waist.png'].targetHeight, 328)
  assert.equal(byFile['waist.png'].usageSlot, 'home.waistBanners.01.image')
  // 槽位命名统一为 home.<module>.<item>.<role>
  for (const slot of slots) {
    assert.match(slot.usageSlot, /^home\.[a-zA-Z]+\.[0-9]{2}\.[a-z]+$/, `槽位命名：${slot.usageSlot}`)
  }
  // 固定快照槽位：搜索图标/TabBar/商品推荐不生成素材请求
  assert.equal(byFile['search.png'].fixedSlot, true)
  assert.equal(byFile['home_b.png'].fixedSlot, true)
  assert.equal(byFile['product-osmo.jpg'].fixedSlot, true)
})

test('缺图请求：规划层为每个缺图槽生成合法 AssetRequest（含比例验收与重试合同）', () => {
  const plan = planHome(validBrief())
  assert.ok(plan.assetRequests.length >= 1)
  const ids = new Set()
  for (const req of plan.assetRequests) {
    assertValid(req, ASSET_REQUEST_ID)
    ids.add(req.id)
    assert.equal(req.id, req.usageSlot)
    assert.equal(req.allowEdit, true, '缺图请求允许对本次生成结果做交付适配')
    // 请求级执行合同：比例验收（误差 ≤3%）+ 3 生成 / 2 适配重试
    assert.deepEqual(req.acceptance, { mode: 'aspect-ratio', maxAspectRatioError: 0.03 })
    assert.deepEqual(req.retryPolicy, { generateMaxAttempts: 3, adaptMaxAttempts: 2 })
  }
  assert.equal(ids.size, plan.assetRequests.length, 'AssetRequest id 唯一')
  assert.equal(plan.texts.length, 1, '应有 1 条搜索框文案替换')
  assert.equal(plan.texts[0].value, '搜索热门租赁好物')
  // 搜索图标 / 固定 TabBar / 商品推荐不创建素材请求
  const slots = new Set(plan.assetRequests.map((r) => r.usageSlot))
  assert.equal(slots.has('home.searchBar.01.icon'), false, '搜索图标不建请求')
  assert.equal([...slots].some((s) => s.startsWith('home.searchBar.')), false, '固定骨架不建请求')
  assert.equal([...slots].some((s) => s.startsWith('home.productRecommendation.')), false, '商品推荐不建请求')
})

test('配置驱动槽位：三张轮播与三张腰封分别拥有独立请求、路径和预览回填', async () => {
  const outputRoot = temporaryDirectory()
  try {
    const landingThemes = ['出游租赁', '演唱会租赁', '数码租赁']
    const config = deriveHomeConfig(validBrief(), { landingThemes })
    const plan = planHome(validBrief(), { homeConfig: config })
    for (const module of ['carousel', 'waistBanners']) {
      const expected = config[module].map((item) => item.image.replace(/^assets\//, '').replace(/\.png$/, ''))
      const actual = plan.assetRequests
        .filter((request) => request.usageSlot.startsWith(`home.${module}.`))
        .map((request) => request.usageSlot)
      assert.deepEqual(actual, expected, `${module} 每个配置条目各有独立 AssetRequest`)
      assert.equal(new Set(expected).size, 3, `${module} 素材路径互不相同`)
    }

    const completedAssets = config.carousel.map((item, index) => {
      const file = path.join(outputRoot, `carousel-${index + 1}.png`)
      fs.writeFileSync(file, `carousel-${index + 1}`)
      return {
        assetRequestId: item.image.replace(/^assets\//, '').replace(/\.png$/, ''),
        artifactId: `carousel-${index + 1}`,
        path: file,
        mimeType: 'image/png', width: 1404, height: 600,
        sha256: String(index + 1).repeat(64), sourceSkill: 'skill-image-generate', sourceSkillVersion: '0.1.0',
        strictSizeSatisfied: true, notes: [],
      }
    })
    await designHome({ brief: validBrief(), outputRoot, landingThemes, completedAssets })
    const html = fs.readFileSync(path.join(outputRoot, 'prototype.html'), 'utf8')
    for (const item of config.carousel) assert.ok(html.includes(`src="${item.image}"`), '轮播 clone 使用自身 item.image')
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true })
  }
})

test('completedAssets 重复 artifactId 明确拒绝，ResearchPack 影响槽位提示词', () => {
  const config = deriveHomeConfig(validBrief())
  const [first, second] = config.carousel
  const completedAssets = [first, second].map((item) => ({
    assetRequestId: item.image.replace(/^assets\//, '').replace(/\.png$/, ''),
    artifactId: 'duplicated-result', path: 'fixture.png', mimeType: 'image/png', width: 1404, height: 600,
  }))
  assert.throws(
    () => planHome(validBrief(), { homeConfig: config, completedAssets }),
    (error) => error.code === 'DUPLICATE_COMPLETED_ASSET',
  )

  const baseline = planHome(validBrief(), { homeConfig: config })
  const researched = planHome(validBrief(), {
    homeConfig: config,
    researchPack: { signals: [{ kind: 'visual', value: '清新蓝绿渐变' }] },
  })
  const request = researched.assetRequests.find((item) => item.usageSlot === 'home.carousel.01.image')
  assert.ok(request.theme.includes('首页第 1 张轮播横幅'), 'prompt 包含槽位用途')
  assert.ok(request.theme.includes('清新蓝绿渐变'), 'ResearchPack 信号进入 prompt')
  assert.notEqual(request.theme, baseline.assetRequests.find((item) => item.usageSlot === request.usageSlot).theme)
})

test('已有图回填：completedAssets 验收素材（比例≤3%）命中槽位时回填且产物与 config 素材路径一致；brief.inputArtifacts 一律不回填', () => {
  const { slots } = enumerateImageSlots()
  const target = slots.find((s) => s.file === 'banner-concert.png')
  const tmp = temporaryDirectory()
  try {
    // 构造一个真实存在的素材文件，宽高比与 1404x600 完全一致
    const fakePath = path.join(tmp, 'banner-concert.png')
    fs.writeFileSync(fakePath, 'fake-bytes')
    const artifact = {
      assetRequestId: target.usageSlot,
      artifactId: 'asset-banner',
      path: fakePath,
      mimeType: 'image/png',
      width: 1404,
      height: 600,
      sha256: 'a'.repeat(64),
      sourceSkill: 'skill-image-generate',
      sourceSkillVersion: '0.1.0',
      strictSizeSatisfied: true,
      notes: [],
    }
    // brief.inputArtifacts 无论 sourceSkill 如何标记都不回填：槽位回退为生成请求
    const brief = validBrief({ inputArtifacts: [artifact] })
    const planFromBrief = planHome(brief)
    assert.ok(planFromBrief.assetRequests.length >= 1)
    assert.equal(planHasRequest(planFromBrief, target.usageSlot), true, 'brief.inputArtifacts 比例合格也不回填，槽位回退为生成请求')
    assert.equal(planImageChangeCount(planFromBrief), 0, 'brief.inputArtifacts 绝不形成 imageChanges')

    // 同一素材经 completedAssets 显式传入（编排器二次回填）：验收通过即回填
    const plan = planHome(validBrief(), { completedAssets: [artifact] })
    assert.equal(plan.assetRequests.length, 11, '默认 12 个配置槽位中已回填 1 个')
    const change = plan.imageChanges.find((c) => c.currentSrc === target.href)
    assert.ok(change, '应生成对应图片替换')
    assert.equal(change.sourcePath, fakePath)
    // outputPath 与 home-config 素材路径一致：assets/home.carousel.01.image.png
    assert.equal(change.outputPath, `assets/${target.usageSlot}.png`)
    assert.equal(plan.assetRequests.some((r) => r.usageSlot === target.usageSlot), false)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('completedAssets 比例浮点边界：理论恰好 3% 通过（epsilon），实际略超仍拒', () => {
  // 金刚区 200x200（1:1）槽位：206x200 理论恰好 3% 误差，但 IEEE754 下
  // 206/200 - 1 = 0.030000000000000027，无 epsilon 会被误拒（与 orchestrator
  // shared acceptance 的 1030x1000 vs 1:1 案例同一浮点语义）。
  const nav = enumerateImageSlots().slots.find((s) => s.file === 'nav-concert.png') // 200x200 1:1
  assert.ok(nav, '应存在金刚区 200x200 槽位')
  const tmp = temporaryDirectory()
  try {
    const fakePath = path.join(tmp, 'nav.png')
    fs.writeFileSync(fakePath, 'fake-bytes')
    const baseAsset = {
      assetRequestId: nav.usageSlot,
      artifactId: 'asset-nav-boundary',
      path: fakePath,
      mimeType: 'image/png',
      sha256: 'b'.repeat(64),
      sourceSkill: 'skill-image-generate',
      sourceSkillVersion: '0.1.0',
      strictSizeSatisfied: false,
      notes: [],
    }
    // 理论恰好 3%（206x200 vs 200x200）：必须通过验收并回填
    const boundary = planHome(validBrief(), {
      completedAssets: [{ ...baseAsset, width: 206, height: 200 }],
    })
    assert.equal(planHasRequest(boundary, nav.usageSlot), false, '理论恰好 3% 边界（浮点噪声 0.030000000000000027）应通过验收回填')
    assert.equal(boundary.imageChanges.some((c) => c.outputPath === `assets/${nav.usageSlot}.png`), true, '浮点边界素材应回填')

    // 实际略超（207x200 = 3.5%）：仍然拒绝，槽位回退为生成请求
    const over = planHome(validBrief(), {
      completedAssets: [{ ...baseAsset, width: 207, height: 200 }],
    })
    assert.equal(planHasRequest(over, nav.usageSlot), true, '实际略超（3.5%）仍拒绝')
    assert.equal(planImageChangeCount(over), 0, '超差素材绝不回填')
    assert.ok(over.warnings.some((w) => w.includes('未通过槽位') && w.includes('已跳过')))
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('比例验收：≤3% 通过（含边界 0.03），>3% 拒绝回填且仅作参考图', () => {
  const banner = enumerateImageSlots().slots.find((s) => s.file === 'banner-concert.png') // 1404x600
  const tmp = temporaryDirectory()
  try {
    const fakePath = path.join(tmp, 'ref.png')
    fs.writeFileSync(fakePath, 'fake-bytes')
    const baseAsset = {
      assetRequestId: banner.usageSlot,
      artifactId: 'asset-banner',
      path: fakePath,
      mimeType: 'image/png',
      sha256: 'a'.repeat(64),
      sourceSkill: 'skill-image-generate',
      sourceSkillVersion: '0.1.0',
      strictSizeSatisfied: false,
      notes: [],
    }
    // completedAssets 比例误差恰为 3%（边界值）：通过验收，直接回填
    const boundary = planHome(validBrief(), {
      completedAssets: [{ ...baseAsset, width: 1446, height: 600 }],
    })
    assert.equal(planHasRequest(boundary, banner.usageSlot), false, '边界 3% 误差素材应回填，不建请求')
    assert.equal(boundary.imageChanges.some((c) => c.outputPath === `assets/${banner.usageSlot}.png`), true, '边界值素材应回填')

    // brief.inputArtifacts 比例合格也绝不回填（仅作参考图）
    const fromBrief = planHome(validBrief({
      inputArtifacts: [{ ...baseAsset, width: 1446, height: 600 }],
    }))
    assert.equal(planHasRequest(fromBrief, banner.usageSlot), true, 'brief.inputArtifacts 不回填，槽位回退为生成请求')
    assert.equal(planImageChangeCount(fromBrief), 0, 'brief.inputArtifacts 绝不作为最终 imageChanges')

    // completedAssets 比例误差 3.5%：不通过 → 不回填，槽位回退为生成请求
    const over = planHome(validBrief(), {
      completedAssets: [{ ...baseAsset, width: 1447, height: 600 }],
    })
    assert.equal(planHasRequest(over, banner.usageSlot), true, '超差槽位回退为生成请求')
    assert.equal(planImageChangeCount(over), 0, '未验收素材绝不作为最终 imageChanges')
    assert.ok(over.warnings.some((w) => w.includes('未通过槽位') && w.includes('已跳过')))
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('比例合格 inputArtifacts 任意 sourceSkill 不直出：仅作参考图，槽位回退为生成请求', async () => {
  const banner = enumerateImageSlots().slots.find((s) => s.file === 'banner-concert.png') // 1404x600
  const tmp = temporaryDirectory()
  const outputRoot = temporaryDirectory()
  try {
    const fakePath = path.join(tmp, 'user.png')
    fs.writeFileSync(fakePath, 'fake-bytes')
    // 同一素材分别标记为 user-input 与 skill-image-generate：一律视为用户原始参考图。
    const baseInput = {
      assetRequestId: banner.usageSlot,
      artifactId: 'asset-user-input',
      path: fakePath,
      mimeType: 'image/png',
      width: 1404,
      height: 600,
      sha256: 'b'.repeat(64),
      sourceSkillVersion: '0.0.0',
      strictSizeSatisfied: true,
      notes: ['用户上传参考图'],
    }
    for (const sourceSkill of ['user-input', 'skill-image-generate']) {
      const userInput = { ...baseInput, sourceSkill }
      // planHome 层：比例合格也不得作为 imageChanges 直出，最多进 referenceImages。
      const plan = planHome(validBrief({ inputArtifacts: [userInput] }))
      assert.equal(planHasRequest(plan, banner.usageSlot), true, `sourceSkill=${sourceSkill} 比例合格也不回填，槽位回退为生成请求`)
      const request = plan.assetRequests.find((r) => r.usageSlot === banner.usageSlot)
      assert.deepEqual(
        request.referenceImages.map((a) => a.assetRequestId),
        [banner.usageSlot],
        `sourceSkill=${sourceSkill} 素材最多进 referenceImages`,
      )
      assert.equal(plan.imageChanges.length, 0, `sourceSkill=${sourceSkill} 素材绝不作为 imageChanges 直出`)
      // 匹配槽位的参考图正常进入 referenceImages（不再记逐槽防御 warning）；
      // 未匹配槽位的参考图才记 warning。
      assert.equal(plan.warnings.some((w) => w.includes('未匹配首页槽位')), false, `sourceSkill=${sourceSkill} 已匹配槽位不误报未匹配`)

      // designHome 层：最终 HTML 与素材包均无直出
      const result = await designHome({ brief: validBrief({ inputArtifacts: [userInput] }), outputRoot })
      const html = fs.readFileSync(path.join(outputRoot, 'prototype.html'), 'utf8')
      assert.equal(html.includes('user.png'), false, `sourceSkill=${sourceSkill} 图不以原文件名进入最终 HTML`)
      assert.equal(fs.existsSync(path.join(outputRoot, 'assets', `${banner.usageSlot}.png`)), true, `sourceSkill=${sourceSkill} 仅复制固定快照作为 pending 预览`)
      assert.ok(result.pendingAssetRequests.some((r) => r.usageSlot === banner.usageSlot), `sourceSkill=${sourceSkill} 槽位保持待生成`)
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
    fs.rmSync(outputRoot, { recursive: true, force: true })
  }
})

function planHasRequest(plan, usageSlot) {
  return plan.assetRequests.some((r) => r.usageSlot === usageSlot)
}

function planImageChangeCount(plan) {
  return plan.imageChanges.length
}

test('受控组装：文本替换 + 图片回填 + 完整 DesignPackage', async () => {
  const outputRoot = temporaryDirectory()
  try {
    const brief = validBrief({
      contentRequirements: ['暑期数码优惠',
        '突出暑期优惠，包含活动入口文案'],
    })
    const { designPackage } = await designHome({ brief, outputRoot })
    assert.equal(designPackage.designBriefId, brief.id)
    const html = fs.readFileSync(path.join(outputRoot, 'prototype.html'), 'utf8')
    assert.ok(html.includes('搜索热门租赁好物'))
    assert.doesNotMatch(html, /\.\.\/(?:assets|styles)/)
    assert.ok(fs.existsSync(path.join(outputRoot, 'prototype.html')))
    assert.ok(fs.existsSync(path.join(outputRoot, 'validation-report.json')))
    // DesignPackage 元数据符合契约
    assertValid(designPackage, DESIGN_PACKAGE_ID)
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
    const { pendingAssetRequests, status } = await designHome({ brief, outputRoot })
    assert.ok(pendingAssetRequests.length >= 1)
    assert.equal(status, 'completed_with_pending_assets')
    // 每个请求合法
    for (const req of pendingAssetRequests) assertValid(req, ASSET_REQUEST_ID)
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true })
  }
})

test('CLI capabilities 输出能力清单', async () => {
  const { code, stdout } = await cli(['capabilities'])
  assert.equal(code, 0)
  const parsed = JSON.parse(stdout)
  assert.equal(parsed.skillManifest.id, 'skill-alipay-home')
  assert.ok(parsed.capabilities.some((c) => c.id === 'page.alipay.home.design'))
})

test('CLI 非 home deliverableType 返回稳定错误', async () => {
  const tmp = temporaryDirectory()
  try {
    const outDir = path.join(tmp, 'out')
    const brief = validBrief({ deliverableType: 'alipay.landing' })
    const { code, stdout } = await cli(['request', '--json', JSON.stringify(brief), '--output', outDir])
    assert.equal(code, 1)
    const parsed = JSON.parse(stdout)
    assert.equal(parsed.code, 'UNSUPPORTED_DELIVERABLE')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('越界设计要求返回结构化拒绝且不生成原型', async () => {
  const outputRoot = temporaryDirectory()
  try {
    const brief = validBrief({
      goal: '设计首页，并把按钮圆角改为 24px，新增倒计时组件',
      contentRequirements: ['保留基础结构'],
    })
    const detected = detectConstraintViolation(brief)
    assert.ok(detected)
    const result = await designHome({ brief, outputRoot })
    assert.equal(result.status, 'rejected')
    assert.equal(result.designPackage, null)
    assert.ok(result.rejection.reasons.length >= 2)
    assert.ok(result.rejection.alternatives.length >= 1)
    assert.equal(fs.existsSync(path.join(outputRoot, 'prototype.html')), false)
  } finally { fs.rmSync(outputRoot, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------
// alipay-home-config/v1 配置派生
// ---------------------------------------------------------------------------

test('deriveHomeConfig：缺省派生固定六模块、默认两主题且通过严格 schema', () => {
  const config = deriveHomeConfig(validBrief())
  assert.equal(config.schemaVersion, HOME_CONFIG_SCHEMA_VERSION)
  assert.deepEqual(
    Object.keys(config).sort(),
    [...HOME_MODULES, 'schemaVersion', 'landingThemes', 'homeTheme'].sort(),
    '固定六内容模块，无多余字段',
  )
  assertValid(config, HOME_CONFIG_ID)
  // 主题默认两主题
  assert.equal(config.landingThemes.length, 2)
  assert.deepEqual(config.landingThemes[0], { landingKey: 'landing-01', theme: '夏日出游租赁', source: 'default' })
  assert.deepEqual(config.landingThemes[1], { landingKey: 'landing-02', theme: '演唱会租赁', source: 'default' })
  // 搜索栏 ≤ 20 字
  assert.ok(config.searchBar.placeholderText.length <= 20)
  assert.ok(config.searchBar.topBarCornerRadiusRpx >= 0 && config.searchBar.topBarCornerRadiusRpx <= 44)
  assert.ok(config.searchBar.inputCornerRadiusRpx >= 0 && config.searchBar.inputCornerRadiusRpx <= 34)
  // 金刚区 5 项起，前 5 项样例名称与顺序锁定
  assert.equal(config.quickEntries.entries.length, 5)
  assert.deepEqual(config.quickEntries.entries.map((e) => e.name),
    ['运动相机', '相机摄影', '演唱会神器', 'CCD专区', '超级补贴'])
  assert.deepEqual(config.quickEntries.entries.map((e) => e.slot), ['01', '02', '03', '04', '05'])
  // 豆腐块固定 3 槽位
  assert.equal(config.tofuBlocks.slots.length, 3)
  // 商品推荐固定 preserve-existing
  assert.deepEqual(config.productRecommendation, { mode: 'preserve-existing' })
})

test('deriveHomeConfig：首页主题自动派生搜索栏背景色', () => {
  const blueGold = deriveHomeConfig(validBrief(), { homeTheme: '蓝金品质生活主题首页' })
  assert.deepEqual(blueGold.searchBar, {
    placeholderText: '搜索热门租赁好物',
    topBarBackgroundColor: '#EAF2FF',
    inputBackgroundColor: '#FFF8E1',
    inputButtonBackgroundColor: '#175CD3',
    topBarCornerRadiusRpx: 44,
    inputCornerRadiusRpx: 34,
  })

  const green = deriveHomeConfig(validBrief(), { homeTheme: '绿色开学季' })
  assert.deepEqual(
    [green.searchBar.topBarBackgroundColor, green.searchBar.inputBackgroundColor, green.searchBar.inputButtonBackgroundColor],
    ['#EAF7F0', '#FFFFFF', '#147A55'],
  )
  assertValid(blueGold, HOME_CONFIG_ID)
  assertValid(green, HOME_CONFIG_ID)
})

test('deriveHomeConfig：素材槽位统一为 home.<module>.<item>.<role> 且页内唯一', () => {
  const config = deriveHomeConfig(validBrief())
  const paths = [
    ...config.carousel.map((c) => c.image),
    ...config.quickEntries.entries.map((e) => e.image),
    ...config.tofuBlocks.slots.map((s) => s.image),
    ...config.waistBanners.map((w) => w.image),
  ]
  // 素材路径必须与规划层 AssetRequest.id/usageSlot 一致（可回填对齐）。
  // 请求由最终 home-config 枚举：每个轮播和腰封都有独立槽位，即使源页面只有一个模板图。
  const requestable = new Set(enumerateHomeConfigImageSlots(config).map((slot) => slot.usageSlot))
  const configSlots = new Set(paths.map((p) => p.replace(/^assets\//, '').replace(/\.png$/, '')))
  assert.equal(requestable.size, 12, '默认两主题的生产素材请求共 12 槽')
  for (const slot of requestable) {
    assert.ok(configSlots.has(slot), `请求槽位必须在 config 中：${slot}`)
  }
  assert.deepEqual([...configSlots].sort(), [...requestable].sort(), '配置中的全部素材槽位均进入请求链路')
  for (const p of paths) {
    assert.match(p, /^assets\/home\.[a-zA-Z]+\.[0-9]{2}\.[a-z]+\.png$/, `素材路径命名：${p}`)
    assert.equal(p.includes('..'), false, '禁止 .. 路径段')
  }
  assert.equal(new Set(paths).size, paths.length, '素材路径页内唯一')
  // 轮播 item 序号与 landingKey 对齐，豆腐块 01 为左主图 large
  assert.deepEqual(config.carousel.map((c) => c.image), ['assets/home.carousel.01.image.png', 'assets/home.carousel.02.image.png'])
  assert.equal(config.tofuBlocks.slots[0].image, 'assets/home.tofuBlocks.01.large.png')
  assert.equal(config.tofuBlocks.slots[1].image, 'assets/home.tofuBlocks.02.image.png')
  assert.equal(config.tofuBlocks.slots[2].image, 'assets/home.tofuBlocks.03.image.png')
  // 建议比例（基线尺寸）：轮播 1404x600、金刚区 200x200、豆腐块 690x640/690x312、腰封 1440x328
  const sizeByPath = Object.fromEntries(enumerateHomeConfigImageSlots(config).map((s) => [s.outputPath, [s.targetWidth, s.targetHeight]]))
  assert.deepEqual(sizeByPath['assets/home.carousel.01.image.png'], [1404, 600])
  assert.deepEqual(sizeByPath['assets/home.quickEntries.01.image.png'], [200, 200])
  assert.deepEqual(sizeByPath['assets/home.tofuBlocks.01.large.png'], [690, 640])
  assert.deepEqual(sizeByPath['assets/home.tofuBlocks.02.image.png'], [690, 312])
  assert.deepEqual(sizeByPath['assets/home.waistBanners.01.image.png'], [1440, 328])
})

test('deriveHomeConfig：主题与成功落地页 ref 在 carousel/waist 各登记一次', () => {
  const config = deriveHomeConfig(validBrief(), {
    homeTheme: '夏日出游租赁',
    landingThemes: ['夏日出游租赁', '演唱会租赁', '数码好物'],
    landingPreviewRefs: [
      { landingKey: 'landing-02', landingPreviewRef: 'landing-02/prototype.html' },
      { landingKey: 'landing-03', landingPreviewRef: 'landing-03/prototype.html' },
    ],
  })
  assert.equal(config.homeTheme, '夏日出游租赁')
  assert.deepEqual(config.landingThemes.map((t) => [t.landingKey, t.theme, t.source]), [
    ['landing-01', '夏日出游租赁', 'orchestrator'],
    ['landing-02', '演唱会租赁', 'orchestrator'],
    ['landing-03', '数码好物', 'default'],
  ])
  // 成功落地页 ref：carousel 与 waistBanners 各一次，缺省主题不出现
  for (const key of ['landing-02', 'landing-03']) {
    const c = config.carousel.find((x) => x.landingKey === key)
    const w = config.waistBanners.find((x) => x.landingKey === key)
    assert.equal(c.landingPreviewRef, `${key}/prototype.html`)
    assert.equal(w.landingPreviewRef, `${key}/prototype.html`)
    assert.equal(config.carousel.filter((x) => x.landingPreviewRef === `${key}/prototype.html`).length, 1)
    assert.equal(config.waistBanners.filter((x) => x.landingPreviewRef === `${key}/prototype.html`).length, 1)
  }
  assert.equal(config.carousel.find((x) => x.landingKey === 'landing-01').landingPreviewRef, undefined)
  assert.equal(config.waistBanners.find((x) => x.landingKey === 'landing-01').landingPreviewRef, undefined)
  assertValid(config, HOME_CONFIG_ID)
})

test('deriveHomeConfig：缺失成功落地页 ref 不输出失效引用', () => {
  const config = deriveHomeConfig(validBrief())
  assert.equal(config.carousel.every((c) => c.landingPreviewRef === undefined), true)
  assert.equal(config.waistBanners.every((w) => w.landingPreviewRef === undefined), true)
})

test('deriveHomeConfig：越界 options 被稳定拒绝', () => {
  const brief = validBrief()
  assert.throws(() => deriveHomeConfig(brief, { landingThemes: [] }), (e) => e.code === 'INVALID_LANDING_THEMES')
  assert.throws(() => deriveHomeConfig(brief, { landingThemes: ['主题', 42] }), (e) => e.code === 'INVALID_LANDING_THEMES')
  assert.throws(() => deriveHomeConfig(brief, { landingPreviewRefs: [{ landingKey: 'landing-01', landingPreviewRef: 'a\\b' }] }),
    (e) => e.code === 'INVALID_LANDING_PREVIEW_REFS')
  assert.throws(() => deriveHomeConfig(brief, { landingPreviewRefs: [{ landingKey: 'landing-01', landingPreviewRef: '../escape' }] }),
    (e) => e.code === 'INVALID_LANDING_PREVIEW_REFS')
  assert.throws(() => deriveHomeConfig(brief, { landingPreviewRefs: [{ landingKey: 'bad-key', landingPreviewRef: 'x.html' }] }),
    (e) => e.code === 'INVALID_LANDING_PREVIEW_REFS')
  assert.throws(() => deriveHomeConfig(brief, { landingPreviewRefs: [{ landingKey: 'landing-01', landingPreviewRef: 'a.html' }, { landingKey: 'landing-01', landingPreviewRef: 'b.html' }] }),
    (e) => e.code === 'INVALID_LANDING_PREVIEW_REFS')
})

test('越界请求拒绝：jumpUrl、生产发布、商品生成、直播', () => {
  const cases = [
    { contentRequirements: ['给轮播图配置 jumpUrl 跳转链接'], reason: /jumpUrl/ },
    { goal: '设计首页并帮我发布上线到支付宝小程序', reason: /发布/ },
    { contentRequirements: ['生成 3 个推荐商品并调整商品排序'], reason: /商品/ },
    { goal: '在首页加一个直播频道模块', reason: /直播/ },
  ]
  for (const override of cases) {
    const brief = validBrief(override)
    const rejection = detectConstraintViolation(brief)
    assert.ok(rejection, `应拒绝：${JSON.stringify(override)}`)
    assert.ok(rejection.reasons.length >= 1)
    assert.match(rejection.reasons[0], cases[cases.indexOf(override)].reason)
    assert.ok(rejection.alternatives.length >= 1)
  }
})

test('测试结束清理临时目录', async () => {
  const out = temporaryDirectory()
  try {
    await designHome({ brief: validBrief(), outputRoot: out })
  } finally {
    fs.rmSync(out, { recursive: true, force: true })
    assert.equal(fs.existsSync(out), false)
  }
})

// ---------------------------------------------------------------------------
// 首页交付接入：四项同源产物、可选主题透传与配置驱动受控组装
// ---------------------------------------------------------------------------

test('designHome 交付四项同源产物且 designPackage 记录配置产物', async () => {
  const outputRoot = temporaryDirectory()
  try {
    const brief = validBrief()
    const { designPackage, status } = await designHome({ brief, outputRoot })
    assert.equal(status, 'completed_with_pending_assets')
    // 四项同源产物齐备
    assert.ok(fs.existsSync(path.join(outputRoot, 'home-config.json')))
    assert.ok(fs.existsSync(path.join(outputRoot, 'prototype.html')))
    assert.ok(fs.existsSync(path.join(outputRoot, 'configuration-guide.md')))
    assert.ok(fs.existsSync(path.join(outputRoot, 'assets')))
    // home-config.json 符合 alipay-home-config/v1 严格 Schema
    const homeConfig = JSON.parse(fs.readFileSync(path.join(outputRoot, 'home-config.json'), 'utf8'))
    assertValid(homeConfig, HOME_CONFIG_ID)
    assert.equal(homeConfig.schemaVersion, HOME_CONFIG_SCHEMA_VERSION)
    // prototype 与配置同源：搜索占位文案、金刚区槽位数一致
    const html = fs.readFileSync(path.join(outputRoot, 'prototype.html'), 'utf8')
    assert.ok(html.includes(homeConfig.searchBar.placeholderText))
    // 金刚区受控重建 5 项（matchAll 计数应等于槽位数，label/icon 各出现一次属模板内部结构）
    const navItems = (html.match(/class="[^"]*home-nav__item[^"]*"/g) || []).length
    assert.equal(navItems, homeConfig.quickEntries.entries.length, '金刚区受控重建 5 项')
    // configuration-guide.md 从同一份配置渲染
    const guide = fs.readFileSync(path.join(outputRoot, 'configuration-guide.md'), 'utf8')
    assert.ok(guide.includes(homeConfig.searchBar.placeholderText))
    assert.ok(guide.includes(homeConfig.homeTheme))
    assert.ok(guide.includes('home-config.json'))
    // DesignPackage 记录配置产物 kind
    const kinds = new Set(designPackage.files.map((f) => f.kind))
    assert.ok(kinds.has('home-config.json'))
    assert.ok(kinds.has('configuration-guide.md'))
    const configEntry = designPackage.files.find((f) => f.kind === 'home-config.json')
    const actualSha = (await import('node:crypto')).createHash('sha256')
      .update(fs.readFileSync(path.join(outputRoot, 'home-config.json'))).digest('hex')
    assert.equal(configEntry.sha256, actualSha, 'designPackage 记录的 home-config sha256 与落盘一致')
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true })
  }
})

test('designHome 透传可选主题参数：homeTheme/landingThemes/landingPreviewRefs 落入配置与指南', async () => {
  const outputRoot = temporaryDirectory()
  try {
    const brief = validBrief()
    const result = await designHome({
      brief,
      outputRoot,
      homeTheme: '夏日出游租赁首页',
      landingThemes: ['夏日出游租赁', '演唱会租赁', '数码好物'],
      landingPreviewRefs: [
        { landingKey: 'landing-02', landingPreviewRef: 'landing-02/prototype.html' },
        { landingKey: 'landing-03', landingPreviewRef: 'landing-03/prototype.html' },
      ],
    })
    assert.notEqual(result.designPackage, null)
    const homeConfig = JSON.parse(fs.readFileSync(path.join(outputRoot, 'home-config.json'), 'utf8'))
    assert.equal(homeConfig.homeTheme, '夏日出游租赁首页')
    assert.deepEqual(homeConfig.landingThemes.map((t) => [t.landingKey, t.theme, t.source]), [
      ['landing-01', '夏日出游租赁', 'orchestrator'],
      ['landing-02', '演唱会租赁', 'orchestrator'],
      ['landing-03', '数码好物', 'default'],
    ])
    // 成功落地页 ref 在 carousel 与 waistBanners 各登记一次
    assert.equal(homeConfig.carousel.find((c) => c.landingKey === 'landing-02').landingPreviewRef, 'landing-02/prototype.html')
    assert.equal(homeConfig.waistBanners.find((w) => w.landingKey === 'landing-02').landingPreviewRef, 'landing-02/prototype.html')
    assert.equal(homeConfig.carousel.every((c) => c.landingKey !== 'landing-01' || c.landingPreviewRef === undefined), true)
    assertValid(homeConfig, HOME_CONFIG_ID)
    // 配置指南同源渲染 landingPreviewRef
    const guide = fs.readFileSync(path.join(outputRoot, 'configuration-guide.md'), 'utf8')
    assert.ok(guide.includes('landing-02/prototype.html'))
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true })
  }
})

test('designHome 兼容编排器对象形 landingThemes：显式 landingKey 保留且 ref 规范化', async () => {
  const outputRoot = temporaryDirectory()
  try {
    // 模拟 orchestrator pageLinkage homeContextFor：成功 landing 携带内嵌 ref（批次相对路径），
    // 失败 landing 无内嵌 ref；首页主题仍保留失败主题（不写失效 ref）。
    const result = await designHome({
      brief: validBrief({ id: 'brief-home-linkage' }),
      outputRoot,
      homeTheme: '夏日出游租赁',
      landingThemes: [
        { landingKey: 'landing-01', theme: '夏日出游租赁', landingPreviewRef: 'items/item.land.1/attempts/0001' },
        { landingKey: 'landing-07', theme: '演唱会租赁' },
      ],
    })
    assert.notEqual(result.designPackage, null)
    const homeConfig = JSON.parse(fs.readFileSync(path.join(outputRoot, 'home-config.json'), 'utf8'))
    // 显式 landingKey 原样保留，绝不按位置重新编号
    assert.deepEqual(homeConfig.landingThemes.map((t) => [t.landingKey, t.theme, t.source]), [
      ['landing-01', '夏日出游租赁', 'orchestrator'],
      ['landing-07', '演唱会租赁', 'orchestrator'],
    ])
    // ref 规范为 <landingKey>/prototype.html（本交付目录下的离线预览路径），不透传批次相对路径
    assert.equal(homeConfig.carousel.find((c) => c.landingKey === 'landing-01').landingPreviewRef, 'landing-01/prototype.html')
    assert.equal(homeConfig.waistBanners.find((w) => w.landingKey === 'landing-01').landingPreviewRef, 'landing-01/prototype.html')
    assert.equal(homeConfig.carousel.find((c) => c.landingKey === 'landing-07').landingPreviewRef, undefined, '失败落地页不写失效引用')
    assertValid(homeConfig, HOME_CONFIG_ID)
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true })
  }
})

test('designHome previewRef 目标存在时 carousel/waist 生成可点击离线预览链接', async () => {
  const outputRoot = temporaryDirectory()
  try {
    // 目标落地页原型真实存在：链接可解析；不存在时不产生死链
    fs.mkdirSync(path.join(outputRoot, 'landing-01'), { recursive: true })
    fs.writeFileSync(path.join(outputRoot, 'landing-01', 'prototype.html'), '<html><body>landing</body></html>')
    const result = await designHome({
      brief: validBrief({ id: 'brief-home-preview-link' }),
      outputRoot,
      landingThemes: ['夏日出游租赁', '演唱会租赁'],
      landingPreviewRefs: [{ landingKey: 'landing-01', landingPreviewRef: 'x' }],
    })
    assert.notEqual(result.designPackage, null)
    const html = fs.readFileSync(path.join(outputRoot, 'prototype.html'), 'utf8')
    // carousel（home-banner）与腰封（home-waist-banner）各包一层 <a>（模板单元为 Catalog domTemplate 的 <div>）
    assert.ok(html.includes('<a href="landing-01/prototype.html"><div class="home-banner"'), 'carousel 应生成预览链接')
    assert.ok(html.includes('<a href="landing-01/prototype.html"><div class="home-waist-banner"'), '腰封应生成预览链接')
    // 无死链：所有 href 目标都真实存在
    for (const match of html.matchAll(/href="([^"]+)"/g)) {
      assert.ok(fs.existsSync(path.resolve(outputRoot, match[1])), `href 目标必须存在：${match[1]}`)
    }
    // 仍受既有校验边界约束：validateOutput 通过（交付完成即证明）
    const report = JSON.parse(fs.readFileSync(path.join(outputRoot, 'validation-report.json'), 'utf8'))
    assert.equal(report.passed, true)
    // 素材缺失时状态仍为 completed_with_pending_assets（链接不影响失败语义）
    assert.equal(result.status, 'completed_with_pending_assets')
    // 目标不存在时：不包 <a>、记 warning，交付仍完整
    const missingRoot = temporaryDirectory()
    try {
      const missing = await designHome({
        brief: validBrief({ id: 'brief-home-preview-missing' }),
        outputRoot: missingRoot,
        landingThemes: ['夏日出游租赁', '演唱会租赁'],
        landingPreviewRefs: [{ landingKey: 'landing-01', landingPreviewRef: 'x' }],
      })
      const missingHtml = fs.readFileSync(path.join(missingRoot, 'prototype.html'), 'utf8')
      assert.doesNotMatch(missingHtml, /<a href=/, '目标不存在时不产生死链')
      assert.ok(missing.warnings.some((w) => w.includes('landing-01/prototype.html')), '目标缺失记 warning')
      const missingConfig = JSON.parse(fs.readFileSync(path.join(missingRoot, 'home-config.json'), 'utf8'))
      assert.equal(missingConfig.carousel.find((c) => c.landingKey === 'landing-01').landingPreviewRef, 'landing-01/prototype.html', 'ref 仍保留在配置中')
    } finally {
      fs.rmSync(missingRoot, { recursive: true, force: true })
    }
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true })
  }
})

test('多个成功 landingKey：carousel/waist 各生成独立、不嵌套、可解析的离线链接', async () => {
  const outputRoot = temporaryDirectory()
  try {
    // 两个成功落地页原型均真实存在
    for (const key of ['landing-01', 'landing-02']) {
      fs.mkdirSync(path.join(outputRoot, key), { recursive: true })
      fs.writeFileSync(path.join(outputRoot, key, 'prototype.html'), `<html><body>${key}</body></html>`)
    }
    const result = await designHome({
      brief: validBrief({ id: 'brief-home-preview-multi' }),
      outputRoot,
      landingThemes: ['夏日出游租赁', '演唱会租赁'],
      landingPreviewRefs: [
        { landingKey: 'landing-01', landingPreviewRef: 'x' },
        { landingKey: 'landing-02', landingPreviewRef: 'y' },
      ],
    })
    assert.notEqual(result.designPackage, null)
    // home-config 与原型同源：每个模块中每个 landingKey 恰出现一次 ref
    const homeConfig = JSON.parse(fs.readFileSync(path.join(outputRoot, 'home-config.json'), 'utf8'))
    const expectedRefs = ['landing-01/prototype.html', 'landing-02/prototype.html']
    for (const [module, className] of [['carousel', 'home-banner'], ['waistBanners', 'home-waist-banner']]) {
      const refs = homeConfig[module].map((item) => item.landingPreviewRef).filter(Boolean)
      assert.deepEqual(refs.sort(), expectedRefs, `${module} 每个成功 landingKey 恰有一个 ref`)
    }
    const html = fs.readFileSync(path.join(outputRoot, 'prototype.html'), 'utf8')
    // 每个模块的每个 ref 恰出现一次，两个模块共 4 个独立 <a>
    for (const [module, className] of [['carousel', 'home-banner'], ['waistBanners', 'home-waist-banner']]) {
      for (const ref of expectedRefs) {
        const links = [...html.matchAll(new RegExp(`<a href="${ref.replace(/[/.]/g, '\\$&')}"><div class="${className}"`, 'g'))]
        assert.equal(links.length, 1, `${module} ${ref} 恰有一条链接`)
      }
    }
    assert.equal((html.match(/<a href="landing-/g) || []).length, 4, '共 4 条独立预览链接（2 模块 × 2 key）')
    // 不嵌套：任何 <a> 内部不再包含 <a>
    assert.doesNotMatch(html, /<a href="[^"]*"><[^>]*><a href=/, '禁止 <a> 嵌套 <a>')
    // 与 home-config 同源：waist count 提示按克隆数量更新为 2 条
    assert.ok(html.includes('1 / 2'), '腰封第一条 count 为 1 / 2')
    assert.ok(html.includes('2 / 2'), '腰封第二条 count 为 2 / 2')
    // 链接可解析：无死链
    for (const match of html.matchAll(/href="([^"]+)"/g)) {
      assert.ok(fs.existsSync(path.resolve(outputRoot, match[1])), `href 目标必须存在：${match[1]}`)
    }
    // 无残留未包裹的独立 banner/waist 副本：banner/waist 总数 == 各自被 <a> 包裹数
    const wrappedBanners = (html.match(/<a href="landing-0\d\/prototype\.html"><div class="home-banner"/g) || []).length
    const totalBanners = (html.match(/<div class="home-banner"/g) || []).length
    const wrappedWaists = (html.match(/<a href="landing-0\d\/prototype\.html"><div class="home-waist-banner"/g) || []).length
    const totalWaists = (html.match(/<div class="home-waist-banner"/g) || []).length
    assert.equal(wrappedBanners, 2, 'carousel 重建为 2 个克隆节点')
    assert.equal(totalBanners, wrappedBanners, '每个 banner 都被独立 <a> 包裹，无裸副本')
    assert.equal(wrappedWaists, 2, '腰封重建为 2 个克隆节点')
    assert.equal(totalWaists, wrappedWaists, '每个腰封都被独立 <a> 包裹，无裸副本')
    // 既有校验边界仍通过
    const report = JSON.parse(fs.readFileSync(path.join(outputRoot, 'validation-report.json'), 'utf8'))
    assert.equal(report.passed, true)
    // DesignPackage 完整
    assertValid(result.designPackage, DESIGN_PACKAGE_ID)
    assert.equal(result.status, 'completed_with_pending_assets')
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true })
  }
})

test('一成功一失败 landingKey：两模块各两个视觉节点，仅成功主题链接且预览不可用有说明', async () => {
  const outputRoot = temporaryDirectory()
  try {
    // 仅 landing-01 成功（原型真实存在），landing-02 彻底失败（无 ref、无文件）
    fs.mkdirSync(path.join(outputRoot, 'landing-01'), { recursive: true })
    fs.writeFileSync(path.join(outputRoot, 'landing-01', 'prototype.html'), '<html><body>landing-01</body></html>')
    const result = await designHome({
      brief: validBrief({ id: 'brief-home-preview-partial' }),
      outputRoot,
      homeTheme: '夏日出游租赁',
      landingThemes: [
        { landingKey: 'landing-01', theme: '夏日出游租赁', landingPreviewRef: 'items/item.land.1/attempts/0001' },
        { landingKey: 'landing-02', theme: '演唱会租赁' },
      ],
    })
    assert.notEqual(result.designPackage, null)
    // home-config：失败主题保留视觉条目（无 ref），成功主题有规范 ref
    const homeConfig = JSON.parse(fs.readFileSync(path.join(outputRoot, 'home-config.json'), 'utf8'))
    assert.deepEqual(homeConfig.landingThemes.map((t) => [t.landingKey, t.theme]), [
      ['landing-01', '夏日出游租赁'],
      ['landing-02', '演唱会租赁'],
    ])
    const html = fs.readFileSync(path.join(outputRoot, 'prototype.html'), 'utf8')
    // 两模块各两个视觉节点（失败主题的视觉内容不丢弃）
    const totalBanners = (html.match(/<div class="home-banner"/g) || []).length
    const totalWaists = (html.match(/<div class="home-waist-banner"/g) || []).length
    assert.equal(totalBanners, 2, 'carousel 保留两个主题的视觉容器')
    assert.equal(totalWaists, 2, '腰封保留两个主题的视觉容器')
    // 仅成功主题有链接：每个 ref 恰一条，且不嵌套
    const wrappedBanners = [...html.matchAll(/<a href="landing-01\/prototype\.html"><div class="home-banner"/g)]
    const wrappedWaists = [...html.matchAll(/<a href="landing-01\/prototype\.html"><div class="home-waist-banner"/g)]
    assert.equal(wrappedBanners.length, 1, 'carousel 仅成功主题恰一条链接')
    assert.equal(wrappedWaists.length, 1, '腰封仅成功主题恰一条链接')
    assert.equal((html.match(/<a href=/g) || []).length, 2, '全页仅 2 条链接（2 模块 × 1 成功 key）')
    assert.equal(html.includes('landing-02/prototype.html'), false, '失败主题不产生链接')
    assert.doesNotMatch(html, /<a href="[^"]*"><[^>]*><a href=/, '禁止 <a> 嵌套 <a>')
    // 无死链：全部 href 目标可解析
    for (const match of html.matchAll(/href="([^"]+)"/g)) {
      assert.ok(fs.existsSync(path.resolve(outputRoot, match[1])), `href 目标必须存在：${match[1]}`)
    }
    // 失败主题容器为裸节点（无 <a>），成功主题容器独立 <a> 包裹
    assert.equal(totalBanners, wrappedBanners.length + 1, '失败主题 banner 为裸视觉容器')
    assert.equal(totalWaists, wrappedWaists.length + 1, '失败主题腰封为裸视觉容器')
    // 腰封 count 与全部条目同源（2 条）
    assert.ok(html.includes('1 / 2'), '腰封第一条 count 为 1 / 2')
    assert.ok(html.includes('2 / 2'), '腰封第二条 count 为 2 / 2')
    // 预览不可用在配置指南与 warnings 中说明
    const guide = fs.readFileSync(path.join(outputRoot, 'configuration-guide.md'), 'utf8')
    assert.ok(guide.includes('预览不可用'), '配置指南标记预览不可用')
    assert.ok(result.warnings.some((w) => w.includes('预览不可用') || w.includes('未生成预览链接')), 'warnings 说明预览不可用')
    // 既有校验边界仍通过、DesignPackage 完整
    const report = JSON.parse(fs.readFileSync(path.join(outputRoot, 'validation-report.json'), 'utf8'))
    assert.equal(report.passed, true)
    assertValid(result.designPackage, DESIGN_PACKAGE_ID)
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true })
  }
})

test('两个全部失败主题：每模块各 2 个视觉节点、0 链接、guide/warnings 说明', async () => {
  const outputRoot = temporaryDirectory()
  try {
    // 两个主题都彻底失败（无 ref、无目标文件）：视觉内容仍逐主题保留
    const result = await designHome({
      brief: validBrief({ id: 'brief-home-preview-allfail' }),
      outputRoot,
      homeTheme: '夏日出游租赁',
      landingThemes: [
        { landingKey: 'landing-01', theme: '夏日出游租赁' },
        { landingKey: 'landing-02', theme: '演唱会租赁' },
      ],
    })
    assert.notEqual(result.designPackage, null)
    const html = fs.readFileSync(path.join(outputRoot, 'prototype.html'), 'utf8')
    // 每模块各 2 个视觉节点（全部失败主题各自保留视觉）
    const totalBanners = (html.match(/<div class="home-banner"/g) || []).length
    const totalWaists = (html.match(/<div class="home-waist-banner"/g) || []).length
    assert.equal(totalBanners, 2, 'carousel 两个失败主题各保留 1 个视觉容器')
    assert.equal(totalWaists, 2, '腰封两个失败主题各保留 1 个视觉容器')
    // 0 链接、无嵌套
    assert.equal((html.match(/<a href=/g) || []).length, 0, '全部失败时 0 条链接')
    assert.doesNotMatch(html, /<a href=/, '不产生任何 <a>')
    // 腰封 count 与全部条目同源
    assert.ok(html.includes('1 / 2'), '腰封第一条 count 为 1 / 2')
    assert.ok(html.includes('2 / 2'), '腰封第二条 count 为 2 / 2')
    // guide 与 warnings 对每个不可用主题说明
    assert.ok(result.warnings.some((w) => w.includes('landing-01') && w.includes('预览不可用')), 'warnings 说明 landing-01 预览不可用')
    assert.ok(result.warnings.some((w) => w.includes('landing-02') && w.includes('预览不可用')), 'warnings 说明 landing-02 预览不可用')
    const guide = fs.readFileSync(path.join(outputRoot, 'configuration-guide.md'), 'utf8')
    assert.ok(guide.includes('预览不可用'), '配置指南标记预览不可用')
    // 既有校验边界仍通过、DesignPackage 完整
    const report = JSON.parse(fs.readFileSync(path.join(outputRoot, 'validation-report.json'), 'utf8'))
    assert.equal(report.passed, true)
    assertValid(result.designPackage, DESIGN_PACKAGE_ID)
    assert.equal(result.status, 'completed_with_pending_assets')
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true })
  }
})

test('单条目失败主题兼容源节点：不重建、不产生 <a>、无多余警告', async () => {
  const outputRoot = temporaryDirectory()
  try {
    const result = await designHome({
      brief: validBrief({ id: 'brief-home-preview-single-fail' }),
      outputRoot,
      landingThemes: [{ landingKey: 'landing-01', theme: '夏日出游租赁' }],
    })
    assert.notEqual(result.designPackage, null)
    const html = fs.readFileSync(path.join(outputRoot, 'prototype.html'), 'utf8')
    // 单条目且无链接：保持源节点（section 結構原样），不重建、不包 <a>
    assert.ok(html.includes('<section class="home-banner"'), '单条目保持源节点兼容')
    assert.equal((html.match(/<a href=/g) || []).length, 0, '无链接')
    assert.equal(result.warnings.filter((w) => w.includes('预览不可用')).length, 0, '无多余警告')
    const report = JSON.parse(fs.readFileSync(path.join(outputRoot, 'validation-report.json'), 'utf8'))
    assert.equal(report.passed, true)
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true })
  }
})

test('designHome 缺素材保持失败语义：completed_with_pending_assets 而非伪装成功', async () => {
  const outputRoot = temporaryDirectory()
  try {
    const brief = validBrief({ inputArtifacts: [] })
    const { status, pendingAssetRequests, designPackage } = await designHome({ brief, outputRoot })
    assert.ok(pendingAssetRequests.length >= 1, '缺图槽位应生成 AssetRequest')
    assert.equal(status, 'completed_with_pending_assets', '素材缺失不得返回 succeeded')
    // 交付包仍完整产出（保留默认基础包），但不伪装素材完备
    assert.ok(designPackage)
    const html = fs.readFileSync(path.join(outputRoot, 'prototype.html'), 'utf8')
    assert.doesNotMatch(html, /素材生成失败/, '首页失败语义为任务失败，不使用诊断占位伪装')
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true })
  }
})

test('designHome：failedAssets 显示失败，审阅报告按 assets/page 顺序记录状态与 375 基准提示', async () => {
  const outputRoot = temporaryDirectory()
  try {
    const result = await designHome({
      brief: validBrief({ outputSpec: { width: 390, height: 812, format: 'png' } }),
      outputRoot,
      failedAssets: ['home.carousel.01.image'],
    })
    assert.equal(result.pendingAssetRequests.some((request) => request.usageSlot === 'home.carousel.01.image'), false)
    assert.match(fs.readFileSync(path.join(outputRoot, 'prototype.html'), 'utf8'), /素材生成失败/)
    assert.match(fs.readFileSync(path.join(outputRoot, 'configuration-guide.md'), 'utf8'), /按 375px 基准生成/)
    const review = JSON.parse(fs.readFileSync(path.join(outputRoot, 'visual-review.json'), 'utf8'))
    assert.deepEqual(review.sections.map((section) => section.name), ['assets', 'page'])
    assert.equal(review.sections[0].entries.find((entry) => entry.usageSlot === 'home.carousel.01.image').rules, 'failed')
    assert.equal(review.sections[1].rules, 'pending')
    assert.deepEqual(review.warnings, ['视觉模型未配置，已跳过可选视觉评审'])
    assert.ok(result.designPackage.files.some((file) => file.path === 'visual-review.json'))
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true })
  }
})

test('inputArtifacts 任意 sourceSkill 不直接进入最终 HTML；completedAssets 显式回填', async () => {
  const outputRoot = temporaryDirectory()
  try {
    const fakePath = path.join(outputRoot, 'user-ref.png')
    fs.writeFileSync(fakePath, 'fake-bytes')
    const base = {
      assetRequestId: 'home.carousel.01.image',
      artifactId: 'asset-carousel',
      path: fakePath,
      mimeType: 'image/png',
      sha256: 'a'.repeat(64),
      sourceSkillVersion: '0.1.0',
      strictSizeSatisfied: false,
      notes: [],
    }
    const config = deriveHomeConfig(validBrief())
    assert.equal(config.carousel[0].image, 'assets/home.carousel.01.image.png')
    // 任意 sourceSkill 的 inputArtifacts（比例合格）：不进入最终 HTML、不进素材包，槽位保持待生成
    for (const sourceSkill of ['user-input', 'skill-image-generate']) {
      const pass = await designHome({
        brief: validBrief({ id: `brief-home-input-${sourceSkill}`, inputArtifacts: [{ ...base, width: 1404, height: 600, sourceSkill }] }),
        outputRoot,
      })
      const html = fs.readFileSync(path.join(outputRoot, 'prototype.html'), 'utf8')
      assert.equal(html.includes('user-ref.png'), false, `sourceSkill=${sourceSkill} 图不以原文件名进入最终 HTML`)
      assert.ok(html.includes(`src="${config.carousel[0].image}"`), `sourceSkill=${sourceSkill} 使用槽位命名的 pending 快照预览`)
      assert.equal(fs.existsSync(path.join(outputRoot, 'assets', path.basename(config.carousel[0].image))), true, `sourceSkill=${sourceSkill} 仅复制快照进素材包`)
      assert.equal(pass.pendingAssetRequests.some((r) => r.usageSlot === 'home.carousel.01.image'), true, `sourceSkill=${sourceSkill} 已回填槽位保持待生成`)
    }

    // 超差素材：不进入最终 HTML，槽位回退为生成请求（携带 referenceImages）
    const failRoot = temporaryDirectory()
    try {
      fs.copyFileSync(fakePath, path.join(failRoot, 'user-ref.png'))
      const over = await designHome({
        brief: validBrief({
          id: 'brief-home-user-ref',
          inputArtifacts: [{ ...base, width: 1447, height: 600, sourceSkill: 'skill-image-generate', path: path.join(failRoot, 'user-ref.png') }],
        }),
        outputRoot: failRoot,
      })
      const overHtml = fs.readFileSync(path.join(failRoot, 'prototype.html'), 'utf8')
      assert.equal(overHtml.includes('user-ref.png'), false, '未验收用户图绝不进入最终 HTML')
      const overRequest = over.pendingAssetRequests.find((r) => r.usageSlot === 'home.carousel.01.image')
      assert.ok(overRequest, '超差槽位回退为生成请求')
      assert.deepEqual(overRequest.referenceImages.map((a) => a.assetRequestId), ['home.carousel.01.image'], '用户素材仅作为参考图')
    } finally {
      fs.rmSync(failRoot, { recursive: true, force: true })
    }

    // 编排器二次回填：同一素材经 completedAssets 显式传入，验收通过按槽位路径回填
    const refillRoot = temporaryDirectory()
    try {
      const pass = await designHome({
        brief: validBrief({ id: 'brief-home-completed-assets' }),
        outputRoot: refillRoot,
        completedAssets: [{ ...base, width: 1404, height: 600, sourceSkill: 'skill-image-generate' }],
      })
      const html = fs.readFileSync(path.join(refillRoot, 'prototype.html'), 'utf8')
      assert.equal(html.includes('user-ref.png'), false, '回填产物不以原文件名进入最终 HTML')
      assert.ok(html.includes(`src="${config.carousel[0].image}"`), '回填产物路径与 home-config 素材路径一致')
      assert.ok(fs.existsSync(path.join(refillRoot, 'assets', path.basename(config.carousel[0].image))))
      assert.equal(pass.pendingAssetRequests.some((r) => r.usageSlot === 'home.carousel.01.image'), false, '已回填槽位不建请求')
      assert.equal(pass.status, 'completed_with_pending_assets', '其余槽位仍待补，不伪装 succeeded')
    } finally {
      fs.rmSync(refillRoot, { recursive: true, force: true })
    }
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true })
  }
})

test('designHome 越界主题输入整体失败且不产出残缺交付', async () => {
  const outputRoot = temporaryDirectory()
  try {
    await assert.rejects(
      designHome({ brief: validBrief(), outputRoot, landingThemes: [] }),
      (e) => e.code === 'INVALID_LANDING_THEMES',
    )
    await assert.rejects(
      designHome({ brief: validBrief(), outputRoot, landingPreviewRefs: [{ landingKey: 'bad-key', landingPreviewRef: 'x.html' }] }),
      (e) => e.code === 'INVALID_LANDING_PREVIEW_REFS',
    )
    await assert.rejects(
      designHome({ brief: validBrief(), outputRoot, homeTheme: '  ' }),
      (e) => e.code === 'INVALID_HOMETHEME',
    )
    // 失败时不残缺交付：无 config、无原型、无 DesignPackage
    assert.equal(fs.existsSync(path.join(outputRoot, 'home-config.json')), false)
    assert.equal(fs.existsSync(path.join(outputRoot, 'prototype.html')), false)
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true })
  }
})

test('CLI 接受 --home-theme/--landing-themes 生成同源四项产物', async () => {
  const tmp = temporaryDirectory()
  try {
    const outDir = path.join(tmp, 'out')
    const brief = validBrief()
    const { code, stdout } = await cli([
      'request', '--json', JSON.stringify(brief), '--output', outDir,
      '--home-theme', '夏日出游租赁首页',
      '--landing-themes', JSON.stringify(['夏日出游租赁', '演唱会租赁']),
      '--landing-preview-refs', JSON.stringify([{ landingKey: 'landing-02', landingPreviewRef: 'landing-02/prototype.html' }]),
    ])
    assert.equal(code, 0, stdout)
    const parsed = JSON.parse(stdout)
    assert.equal(parsed.ok, true)
    const homeConfig = JSON.parse(fs.readFileSync(path.join(outDir, 'home-config.json'), 'utf8'))
    assert.equal(homeConfig.homeTheme, '夏日出游租赁首页')
    assert.equal(homeConfig.carousel.find((c) => c.landingKey === 'landing-02').landingPreviewRef, 'landing-02/prototype.html')
    assert.ok(fs.existsSync(path.join(outDir, 'configuration-guide.md')))
    assert.ok(fs.existsSync(path.join(outDir, 'prototype.html')))
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('CLI 非法 --landing-themes JSON 返回稳定错误', async () => {
  const tmp = temporaryDirectory()
  try {
    const outDir = path.join(tmp, 'out')
    const brief = validBrief()
    const { code, stdout } = await cli(['request', '--json', JSON.stringify(brief), '--output', outDir, '--landing-themes', 'not-json'])
    assert.equal(code, 1)
    const parsed = JSON.parse(stdout)
    assert.equal(parsed.code, 'INVALID_JSON')
    assert.equal(fs.existsSync(path.join(outDir, 'home-config.json')), false)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('旧独立调用兼容：designHome 仅传 brief 时仍产出与配置同源的原型', async () => {
  const outputRoot = temporaryDirectory()
  try {
    const brief = validBrief()
    const result = await designHome({ brief, outputRoot })
    assert.equal(result.status, 'completed_with_pending_assets')
    const homeConfig = JSON.parse(fs.readFileSync(path.join(outputRoot, 'home-config.json'), 'utf8'))
    // 缺省主题仍为默认两主题
    assert.deepEqual(homeConfig.landingThemes.map((t) => t.theme), ['夏日出游租赁', '演唱会租赁'])
    // 搜索占位文案由受控默认/主题文案派生，不直接展示设计指令
    const html = fs.readFileSync(path.join(outputRoot, 'prototype.html'), 'utf8')
    assert.ok(html.includes(homeConfig.searchBar.placeholderText))
    assert.equal(homeConfig.searchBar.placeholderText, '搜索热门租赁好物')
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true })
  }
})

test('completedAssets 非数组返回稳定错误：内部参数不进入公共 brief', async () => {
  const outputRoot = temporaryDirectory()
  try {
    await assert.rejects(
      designHome({ brief: validBrief(), outputRoot, completedAssets: 'assets/home.carousel.01.image.png' }),
      (e) => e.code === 'INVALID_COMPLETED_ASSETS',
    )
    // 失败时不产出残缺交付
    assert.equal(fs.existsSync(path.join(outputRoot, 'prototype.html')), false)
    // 公共 DesignBrief 不存在伪造路径：Schema 校验在 normalizeDesignBrief 先行拒绝
    const { normalizeDesignBrief } = await import('../runtime/planner.mjs')
    assert.throws(
      () => normalizeDesignBrief(validBrief({ completedAssets: [] })),
      (e) => e.code === 'INVALID_BRIEF',
    )
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true })
  }
})

test('CLI request 不暴露 completedAssets：传入即被忽略，槽位保持待生成', async () => {
  const tmp = temporaryDirectory()
  try {
    const outDir = path.join(tmp, 'out')
    const brief = validBrief()
    // CLI 不读取 --completed-assets（非公开 flag，被忽略）：不存在经公共入口注入回填的伪造路径
    const { code, stdout } = await cli([
      'request', '--json', JSON.stringify(brief), '--output', outDir,
      '--completed-assets', JSON.stringify([{
        assetRequestId: 'home.carousel.01.image',
        artifactId: 'x', path: 'x.png', mimeType: 'image/png',
        width: 1404, height: 600, sha256: 'a'.repeat(64),
        sourceSkill: 'skill-image-generate', sourceSkillVersion: '0.1.0',
        strictSizeSatisfied: true, notes: [],
      }]),
    ])
    assert.equal(code, 0, stdout)
    const parsed = JSON.parse(stdout)
    assert.equal(parsed.ok, true)
    assert.ok(parsed.pendingAssetRequests.some((r) => r.usageSlot === 'home.carousel.01.image'), '回填参数不生效，槽位保持待生成')
    assert.equal(fs.existsSync(path.join(outDir, 'assets', 'home.carousel.01.image.png')), true, '无素材回填时复制快照用于 pending 预览')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

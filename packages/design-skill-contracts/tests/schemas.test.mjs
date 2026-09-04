// 设计 Skill 公共合同测试。
// 使用 Node 内建 node:test，无外部依赖。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readdirSync, readFileSync } from 'node:fs'
import {
  runConformance,
  validate,
  Registry,
  verifyRefs,
  capabilityFrozen,
} from '../scripts/validate.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const schemasDir = join(here, '..', 'schemas')
const fixturesDir = join(here, '..', 'fixtures')
const CAP_ID = 'http://schemas.design-agent.local/design-skill/v1/capability-manifest.schema.json'
const BASE = 'http://schemas.design-agent.local/design-skill/v1'

test('存在 15 个 schema 文件', () => {
  const files = readdirSync(schemasDir).filter((f) => f.endsWith('.schema.json'))
  assert.equal(files.length, 15)
})

test('schema 可加载、引用可解析、schemaVersion 存在', () => {
  const registry = Registry.fromDirectory(schemasDir)
  assert.equal(registry.byId.size, 15)
  for (const [id, entry] of registry.byId) {
    assert.ok(id, `schema ${entry.fileName} 缺少 $id`)
    assert.ok(entry.schema.schemaVersion, `schema ${entry.fileName} 缺少 schemaVersion`)
  }
  const refs = verifyRefs(registry)
  assert.deepEqual(refs, [])
})

test('valid fixtures 全通过', () => {
  const r = runConformance({ schemasDir, fixturesDir })
  assert.deepEqual(r.loadErrors, [])
  assert.deepEqual(r.refFailures, [])
  assert.deepEqual(r.validFailures, [])
})

test('invalid fixtures 按预期失败', () => {
  const r = runConformance({ schemasDir, fixturesDir })
  assert.deepEqual(r.invalidNotRejected, [])
  // 至少一个未登记 capability 拒绝的 invalid fixture 存在
  const cap = r.fixtures.find(
    (f) => !f.expectPass && f.name.includes('capability-unregistered-id'),
  )
  assert.ok(cap && cap.ok, '未登记 capability 的 invalid fixture 应被拒绝')
})

test('capability ID 冻结且只允许计划中的 9 个', () => {
  const registry = Registry.fromDirectory(schemasDir)
  const frozen = capabilityFrozen(registry)
  assert.equal(frozen.matches, true)
  assert.equal(frozen.ids.length, 9)
  assert.deepEqual(
    [...frozen.ids].sort(),
    [
      'design.guidance',
      'image.crop',
      'image.export',
      'image.generate',
      'image.resize',
      'page.alipay.home.design',
      'page.alipay.landing.design',
      'research.search',
      'workflow.orchestrate',
    ].sort(),
  )
})

test('重复验证确定性', () => {
  const r = runConformance({ schemasDir, fixturesDir })
  assert.deepEqual(r.notDeterministic, [])
  for (const f of r.fixtures) assert.equal(f.deterministic, true, `fixture ${f.name} 结果不一致`)
})

test('未登记 capability 被拒绝', () => {
  const registry = Registry.fromDirectory(schemasDir)
  const entry = registry.byId.get(CAP_ID)
  const bad = {
    id: 'image.generate.custom.impl',
    version: '1.0.0',
    inputSchema: 'asset-request.schema.json',
    outputSchema: 'asset-result.schema.json',
    automatic: true,
    priority: 10,
    availabilityCommand: 'custom capabilities',
  }
  const errors = validate(bad, entry.schema, registry, entry.schema.$id)
  assert.ok(errors.length > 0, '未登记 capability ID 应被拒绝')
})

test('valid fixture 通过的最小断言', () => {
  const registry = Registry.fromDirectory(schemasDir)
  const capSchema = registry.byId.get(CAP_ID).schema
  const valid = {
    id: 'image.generate',
    version: '1.0.0',
    inputSchema: 'asset-request.schema.json',
    outputSchema: 'asset-result.schema.json',
    automatic: true,
    priority: 10,
    availabilityCommand: 'image-generate capabilities',
  }
  assert.deepEqual(validate(valid, capSchema, registry, capSchema.$id), [])
})

test('batch-design-request 不检查 itemId 唯一性（唯一性由 loader 检查）', () => {
  const registry = Registry.fromDirectory(schemasDir)
  const reqSchema = registry.byId.get(
    'http://schemas.design-agent.local/design-skill/v1/batch-design-request.schema.json',
  ).schema
  const brief = {
    id: 'brief-001',
    goal: '设计一个落地页',
    deliverableType: 'alipay.landing',
    audience: '用户',
    brandConstraints: [],
    contentRequirements: [],
    visualConstraints: [],
    outputSpec: { width: 375, height: 812 },
    inputArtifacts: [],
    researchPolicy: 'none',
    forbiddenChanges: [],
  }
  const policy = { default: { source: 'generate', requirement: 'required' }, rules: [] }
  const dup = {
    schemaVersion: '1',
    batchId: 'batch-dup',
    items: [
      { itemId: 'item.same', brief, assetPolicy: policy },
      { itemId: 'item.same', brief, assetPolicy: policy },
    ],
  }
  // Schema 层面放行重复 itemId；唯一性语义由 loader 在加载时检查，避免误解。
  assert.deepEqual(validate(dup, reqSchema, registry, reqSchema.$id), [])
})

test('alipay-home-config 严格 schema：合法配置通过', () => {
  const registry = Registry.fromDirectory(schemasDir)
  const entry = registry.byId.get(`${BASE}/alipay-home-config.schema.json`)
  const fixture = JSON.parse(
    readFileSync(join(fixturesDir, 'valid', 'alipay-home-config.json'), 'utf8'),
  ).fixture
  assert.match(fixture.schemaVersion, /^alipay-home-config\/v1$/)
  assert.deepEqual(validate(fixture, entry.schema, registry, entry.schema.$id), [])
})

test('alipay-home-config 金刚区编号必须连续（06 起连续编号）', () => {
  const registry = Registry.fromDirectory(schemasDir)
  const entry = registry.byId.get(`${BASE}/alipay-home-config.schema.json`)
  const base = JSON.parse(
    readFileSync(join(fixturesDir, 'valid', 'alipay-home-config.json'), 'utf8'),
  ).fixture
  const gap = structuredClone(base)
  gap.quickEntries.entries[5].slot = '07' // 10 项中缺 06
  const errors = validate(gap, entry.schema, registry, entry.schema.$id)
  // Schema 层面只约束编号格式与数量 5–25；连续性语义由 Skill 加载时检查（与 itemId 唯一性同层）。
  // 此处断言：编号不连续时仍然结构合法，避免误解为 Schema 层已覆盖。
  assert.deepEqual(errors, [])
})

test('alipay-home-config 拒绝未声明字段（严格 Schema）', () => {
  const registry = Registry.fromDirectory(schemasDir)
  const entry = registry.byId.get(`${BASE}/alipay-home-config.schema.json`)
  const bad = {
    schemaVersion: 'alipay-home-config/v1',
    homeTheme: '夏日出游租赁',
    landingThemes: [],
    searchBar: {
      placeholderText: '搜索',
      topBarBackgroundColor: '#FFFFFF',
      inputBackgroundColor: '#F5F5F5',
      inputButtonBackgroundColor: '#1677FF',
      topBarCornerRadiusRpx: 44,
      inputCornerRadiusRpx: 34,
    },
    carousel: [],
    quickEntries: { entries: [] },
    tofuBlocks: { slots: [] },
    waistBanners: [],
    productRecommendation: { mode: 'preserve-existing' },
    jumpUrls: ['https://example.com/prod'],
  }
  const errors = validate(bad, entry.schema, registry, entry.schema.$id)
  assert.ok(errors.length > 0, '未声明字段 jumpUrls 应被拒绝')
})

test('landing-config 严格 schema：合法配置通过', () => {
  const registry = Registry.fromDirectory(schemasDir)
  const entry = registry.byId.get(`${BASE}/landing-config.schema.json`)
  const fixture = JSON.parse(
    readFileSync(join(fixturesDir, 'valid', 'landing-config.json'), 'utf8'),
  ).fixture
  assert.match(fixture.schemaVersion, /^landing-schema\/v1$/)
  assert.deepEqual(validate(fixture, entry.schema, registry, entry.schema.$id), [])
})

test('landing-config 非白名单模块被拒绝', () => {
  const registry = Registry.fromDirectory(schemasDir)
  const entry = registry.byId.get(`${BASE}/landing-config.schema.json`)
  const config = {
    schemaVersion: 'landing-schema/v1',
    page: {
      name: '页面',
      navTitle: '标题',
      background: { type: 'color', color: '#FFFFFF' },
      activityTime: { startTime: '', endTime: '' },
    },
    modules: [{ type: 'VIDEO', id: 'video-1', src: 'v.mp4' }],
  }
  const errors = validate(config, entry.schema, registry, entry.schema.$id)
  assert.ok(errors.length > 0, '非白名单模块 VIDEO 应被拒绝')
})

test('landing-config SPACER 高度步长 8rpx（10rpx 被拒绝）', () => {
  const registry = Registry.fromDirectory(schemasDir)
  const entry = registry.byId.get(`${BASE}/landing-config.schema.json`)
  const spacer = entry.schema.$defs.moduleSpacer
  const bad = {
    type: 'SPACER',
    id: 'spacer-1',
    heightRpx: 10,
    background: { mode: 'transparent' },
  }
  const errors = validate(bad, spacer, registry, entry.schema.$id)
  assert.ok(
    errors.some((e) => e.includes('multipleOf')),
    `10rpx 应触发 multipleOf 错误，实际：${JSON.stringify(errors)}`,
  )
})

test('landing-config IMAGE_AD 双图模式必须恰好 2 张图', () => {
  const registry = Registry.fromDirectory(schemasDir)
  const entry = registry.byId.get(`${BASE}/landing-config.schema.json`)
  const ad = entry.schema.$defs.moduleImageAd
  const bad = {
    type: 'IMAGE_AD',
    id: 'ad-1',
    mode: { mode: 'double', count: 2 },
    images: ['assets/a.png'],
    cornerRadiusRpx: 12,
  }
  const errors = validate(bad, ad, registry, entry.schema.$id)
  assert.ok(errors.length > 0, '双图模式配 1 张图应被拒绝')
})

test('landing-config 页面背景纯色/图片二选一（both 被拒绝）', () => {
  const registry = Registry.fromDirectory(schemasDir)
  const entry = registry.byId.get(`${BASE}/landing-config.schema.json`)
  const bg = entry.schema.properties.page.properties.background
  assert.deepEqual(validate({ type: 'color', color: '#FFFFFF' }, bg, registry, entry.schema.$id), [])
  assert.deepEqual(validate({ type: 'image', image: 'assets/bg.png' }, bg, registry, entry.schema.$id), [])
  const both = validate({ type: 'both', color: '#FFFFFF', image: 'assets/bg.png' }, bg, registry, entry.schema.$id)
  assert.ok(both.length > 0, 'both 应被 oneOf 拒绝')
})

test('pageLinkage 存在时 batch-design-request 通过且影响存量批次', () => {
  const registry = Registry.fromDirectory(schemasDir)
  const reqSchema = registry.byId.get(`${BASE}/batch-design-request.schema.json`).schema
  const withLinkage = JSON.parse(
    readFileSync(join(fixturesDir, 'valid', 'batch-design-request-page-linkage.json'), 'utf8'),
  ).fixture
  assert.deepEqual(validate(withLinkage, reqSchema, registry, reqSchema.$id), [])
  // 存量批次（无 pageLinkage）仍通过 —— 由 valid/batch-design-request.json fixture 覆盖。
})

test('design-package 支持页面交付新文件 kind', () => {
  const registry = Registry.fromDirectory(schemasDir)
  const dpSchema = registry.byId.get(`${BASE}/design-package.schema.json`).schema
  const kinds = dpSchema.$defs.packageFile.properties.kind.enum
  for (const k of ['home-config.json', 'landing-config.json', 'configuration-guide.md']) {
    assert.ok(kinds.includes(k), `kind 枚举应包含 ${k}`)
  }
})

// ---- AssetRequest acceptance / retryPolicy（可选请求级执行合同） ----

const ASSET_REQ_ID = `${BASE}/asset-request.schema.json`

function loadAssetRequestFixture(name, dir = 'valid') {
  return JSON.parse(
    readFileSync(join(fixturesDir, dir, name), 'utf8'),
  ).fixture
}

test('asset-request 未声明 acceptance/retryPolicy 时维持旧语义（向后兼容）', () => {
  const registry = Registry.fromDirectory(schemasDir)
  const entry = registry.byId.get(ASSET_REQ_ID)
  const legacy = loadAssetRequestFixture('asset-request.json')
  assert.deepEqual(validate(legacy, entry.schema, registry, entry.schema.$id), [])
})

test('asset-request 比例验收 + 3/2 重试策略通过', () => {
  const registry = Registry.fromDirectory(schemasDir)
  const entry = registry.byId.get(ASSET_REQ_ID)
  const fixture = loadAssetRequestFixture('asset-request-acceptance-retry.json')
  assert.equal(fixture.acceptance.mode, 'aspect-ratio')
  assert.equal(fixture.acceptance.maxAspectRatioError, 0.03)
  assert.deepEqual(validate(fixture, entry.schema, registry, entry.schema.$id), [])
})

test('asset-request 比例模式可省略 maxAspectRatioError；重试下界 1/0 合法', () => {
  const registry = Registry.fromDirectory(schemasDir)
  const entry = registry.byId.get(ASSET_REQ_ID)
  const fixture = loadAssetRequestFixture('asset-request-aspect-no-adapt.json')
  assert.equal('maxAspectRatioError' in fixture.acceptance, false)
  assert.deepEqual(validate(fixture, entry.schema, registry, entry.schema.$id), [])
})

test('asset-request exact-size 模式合法（显式声明等价旧行为）', () => {
  const registry = Registry.fromDirectory(schemasDir)
  const entry = registry.byId.get(ASSET_REQ_ID)
  const fixture = loadAssetRequestFixture('asset-request-exact-size-mode.json')
  assert.equal(fixture.acceptance.mode, 'exact-size')
  assert.deepEqual(validate(fixture, entry.schema, registry, entry.schema.$id), [])
})

test('asset-request maxAspectRatioError 上限 0.03：边界通过、0.05 拒绝、负值拒绝', () => {
  const registry = Registry.fromDirectory(schemasDir)
  const entry = registry.byId.get(ASSET_REQ_ID)
  // 边界值 0.03 通过（design 文档：边界值 0.03 视为通过）
  const atBoundary = structuredClone(loadAssetRequestFixture('asset-request-acceptance-retry.json'))
  assert.deepEqual(validate(atBoundary, entry.schema, registry, entry.schema.$id), [])
  // 超上限被拒（invalid fixture 同步覆盖）
  const over = structuredClone(atBoundary)
  over.acceptance.maxAspectRatioError = 0.05
  const overErrors = validate(over, entry.schema, registry, entry.schema.$id)
  assert.ok(
    overErrors.some((e) => e.includes('maximum')),
    `0.05 应触发 maximum 错误，实际：${JSON.stringify(overErrors)}`,
  )
  // 负值被拒：abs() 相对误差语义下负数恒通过执行，必须在合同层拒绝
  const negative = structuredClone(atBoundary)
  negative.acceptance.maxAspectRatioError = -0.01
  const negativeErrors = validate(negative, entry.schema, registry, entry.schema.$id)
  assert.ok(
    negativeErrors.some((e) => e.includes('minimum')),
    `负 tolerance 应触发 minimum 错误，实际：${JSON.stringify(negativeErrors)}`,
  )
  // invalid fixtures 指向正确 schema 且确实被拒绝
  const overFixture = loadAssetRequestFixture('asset-request-tolerance-over-3pct.json', 'invalid')
  const negFixture = loadAssetRequestFixture('asset-request-tolerance-negative.json', 'invalid')
  assert.ok(validate(overFixture, entry.schema, registry, entry.schema.$id).length > 0)
  assert.ok(validate(negFixture, entry.schema, registry, entry.schema.$id).length > 0)
})

test('asset-request acceptance.mode 仅允许 exact-size / aspect-ratio', () => {
  const registry = Registry.fromDirectory(schemasDir)
  const entry = registry.byId.get(ASSET_REQ_ID)
  assert.deepEqual(
    entry.schema.properties.acceptance.properties.mode.enum,
    ['exact-size', 'aspect-ratio'],
  )
  const bad = loadAssetRequestFixture('asset-request-acceptance-bad-mode.json', 'invalid')
  const errors = validate(bad, entry.schema, registry, entry.schema.$id)
  assert.ok(
    errors.some((e) => e.includes('enum')),
    `mode=fill 应触发 enum 错误，实际：${JSON.stringify(errors)}`,
  )
})

test('asset-request retryPolicy 边界：generate 1-3、adapt 0-2，越界拒绝', () => {
  const registry = Registry.fromDirectory(schemasDir)
  const entry = registry.byId.get(ASSET_REQ_ID)
  const base = loadAssetRequestFixture('asset-request-acceptance-retry.json')
  const cases = [
    { field: 'generateMaxAttempts', min: 1, max: 3, other: 0 },
    { field: 'adaptMaxAttempts', min: 0, max: 2, other: 3 },
  ]
  for (const { field, min, max, other } of cases) {
    const make = (v) => {
      const req = structuredClone(base)
      delete req.acceptance
      req.retryPolicy = field === 'generateMaxAttempts'
        ? { generateMaxAttempts: v, adaptMaxAttempts: other }
        : { generateMaxAttempts: other, adaptMaxAttempts: v }
      return req
    }
    for (const v of [min, max]) {
      assert.deepEqual(validate(make(v), entry.schema, registry, entry.schema.$id), [])
    }
    for (const v of [min - 1, max + 1]) {
      const errors = validate(make(v), entry.schema, registry, entry.schema.$id)
      assert.ok(
        errors.some((e) => e.includes('minimum') || e.includes('maximum')),
        `${field}=${v} 应越界拒绝，实际：${JSON.stringify(errors)}`,
      )
    }
  }
  // invalid fixtures 同步覆盖
  const overGen = loadAssetRequestFixture('asset-request-retry-generate-over-3.json', 'invalid')
  const overAdapt = loadAssetRequestFixture('asset-request-retry-adapt-over-2.json', 'invalid')
  assert.ok(validate(overGen, entry.schema, registry, entry.schema.$id).length > 0)
  assert.ok(validate(overAdapt, entry.schema, registry, entry.schema.$id).length > 0)
})

test('asset-result strictSizeSatisfied 结构未变（仅补充说明）', () => {
  const registry = Registry.fromDirectory(schemasDir)
  const entry = registry.byId.get(`${BASE}/asset-result.schema.json`)
  const prop = entry.schema.properties.strictSizeSatisfied
  assert.equal(prop.type, 'boolean')
  assert.ok(prop.description, 'strictSizeSatisfied 应保留说明')
})

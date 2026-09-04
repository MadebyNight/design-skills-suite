import assert from 'node:assert/strict'
import test from 'node:test'
import {
  derivePlanFromRequest,
  landingContextFor,
  homeContextFor,
  jointReview,
  previewRefFor,
  isLandingKey,
  PageLinkageError,
} from '../../runtime/page-linkage.mjs'

const briefHome = {
  id: 'brief-home',
  goal: '首页',
  deliverableType: 'alipay.home',
  audience: '年轻用户',
  brandConstraints: [],
  contentRequirements: [],
  visualConstraints: [],
  outputSpec: { width: 375, height: 812 },
  inputArtifacts: [],
  researchPolicy: 'none',
  forbiddenChanges: [],
}
const briefLanding = { ...briefHome, id: 'brief-landing', deliverableType: 'alipay.landing' }

function linkedRequest(over = {}) {
  return {
    schemaVersion: '1',
    batchId: 'batch-1',
    pageLinkage: {
      homeTheme: '夏日出游租赁',
      landingThemes: [{ theme: '夏日出游租赁' }, { theme: '演唱会租赁' }],
    },
    items: [
      { itemId: 'landing-a', brief: briefLanding, assetPolicy: { default: { source: 'generate', requirement: 'required' }, rules: [] } },
      { itemId: 'landing-b', brief: { ...briefLanding, id: 'brief-landing-b' }, assetPolicy: { default: { source: 'generate', requirement: 'required' }, rules: [] } },
      { itemId: 'home-a', brief: briefHome, assetPolicy: { default: { source: 'generate', requirement: 'required' }, rules: [] } },
    ],
    ...over,
  }
}

/** 三 landing + 一 home 的请求（homeContextFor 可关联状态表用）。 */
function linked3Request(over = {}) {
  const base = linkedRequest()
  return {
    ...base,
    pageLinkage: {
      homeTheme: '夏日出游租赁',
      landingThemes: [{ theme: '夏日出游租赁' }, { theme: '演唱会租赁' }, { theme: '数码好物' }],
    },
    items: [
      ...base.items.filter((i) => i.brief.deliverableType === 'alipay.landing'),
      { itemId: 'landing-c', brief: { ...briefLanding, id: 'brief-landing-c' }, assetPolicy: { default: { source: 'generate', requirement: 'required' }, rules: [] } },
      ...base.items.filter((i) => i.brief.deliverableType === 'alipay.home'),
    ],
    ...over,
  }
}

test('isLandingKey 仅接受 landing-XX 形态', () => {
  assert.equal(isLandingKey('landing-01'), true)
  assert.equal(isLandingKey('landing-100'), true)
  assert.equal(isLandingKey('landing-1'), false)
  assert.equal(isLandingKey('home-01'), false)
  assert.equal(isLandingKey(1), false)
})

test('derivePlan：无 pageLinkage 返回 null', () => {
  const request = { batchId: 'b', items: [{ itemId: 'x', brief: briefHome }] }
  assert.equal(derivePlanFromRequest(request), null)
})

test('derivePlan：按请求顺序分配 landing-01/02，执行顺序 landing 优先、home 最后', () => {
  const plan = derivePlanFromRequest(linkedRequest())
  assert.equal(plan.homeTheme, '夏日出游租赁')
  assert.deepEqual(plan.entries.map((e) => e.landingKey), ['landing-01', 'landing-02'])
  assert.deepEqual(plan.entries.map((e) => e.theme), ['夏日出游租赁', '演唱会租赁'])
  assert.deepEqual(plan.landingItemIds, ['landing-a', 'landing-b'])
  assert.deepEqual(plan.homeItemIds, ['home-a'])
  assert.deepEqual(plan.order, [
    { itemId: 'landing-a', landingKey: 'landing-01' },
    { itemId: 'landing-b', landingKey: 'landing-02' },
    { itemId: 'home-a', landingKey: null },
  ])
})

test('derivePlan：显式 key 保留，缺失 key 跳过已占用编号', () => {
  const plan = derivePlanFromRequest(linkedRequest({
    pageLinkage: {
      homeTheme: '夏日出游租赁',
      landingThemes: [{ theme: 'A', landingKey: 'landing-02' }, { theme: 'B' }],
    },
  }))
  // entries 按编号升序稳定重排：landing-01 分配给缺失 key 的 B。
  assert.deepEqual(plan.entries.map((e) => e.landingKey), ['landing-01', 'landing-02'])
  assert.deepEqual(plan.entries.map((e) => e.theme), ['B', 'A'])
  // items 与 key 升序后的 entries 一一对应：landing-a → landing-01（B）。
  assert.deepEqual(landingContextFor(plan, 'landing-a'), { landingKey: 'landing-01', theme: 'B' })
  assert.deepEqual(landingContextFor(plan, 'landing-b'), { landingKey: 'landing-02', theme: 'A' })
  assert.deepEqual(landingContextFor(plan, 'home-a'), null)
})

test('derivePlan：landingKey 重复抛 BATCH_REQUEST_INVALID', () => {
  const request = linkedRequest({
    pageLinkage: {
      homeTheme: 'T',
      landingThemes: [{ theme: 'A', landingKey: 'landing-01' }, { theme: 'B', landingKey: 'landing-01' }],
    },
  })
  assert.throws(() => derivePlanFromRequest(request), (e) => e instanceof PageLinkageError && e.code === 'BATCH_REQUEST_INVALID' && /重复/.test(e.message))
})

test('derivePlan：landingKey 非法形态抛 BATCH_REQUEST_INVALID', () => {
  const request = linkedRequest({
    pageLinkage: {
      homeTheme: 'T',
      landingThemes: [{ theme: 'A', landingKey: 'key-01' }],
    },
  })
  assert.throws(() => derivePlanFromRequest(request), (e) => e.code === 'BATCH_REQUEST_INVALID' && /非法/.test(e.message))
})

test('derivePlan：联动批次必须恰好一个 home item', () => {
  const noHome = linkedRequest()
  noHome.items = noHome.items.filter((i) => i.itemId !== 'home-a')
  assert.throws(() => derivePlanFromRequest(noHome), (e) => e.code === 'BATCH_REQUEST_INVALID' && /恰好一个/.test(e.message))

  const twoHomes = linkedRequest()
  twoHomes.items.push({ itemId: 'home-b', brief: { ...briefHome, id: 'brief-home-b' }, assetPolicy: {} })
  assert.throws(() => derivePlanFromRequest(twoHomes), (e) => e.code === 'BATCH_REQUEST_INVALID' && /恰好一个/.test(e.message))
})

test('derivePlan：landing item 数与 landingThemes 数不一致抛错', () => {
  const one = linkedRequest()
  one.items = one.items.filter((i) => i.itemId !== 'landing-b')
  assert.throws(() => derivePlanFromRequest(one), (e) => e.code === 'BATCH_REQUEST_INVALID' && /数量/.test(e.message))
})

test('derivePlan：联动批次禁止其他 deliverableType', () => {
  const other = linkedRequest()
  other.items.push({ itemId: 'other', brief: { ...briefHome, id: 'b-other', deliverableType: 'alipay.other' }, assetPolicy: {} })
  assert.throws(() => derivePlanFromRequest(other), (e) => e.code === 'BATCH_REQUEST_INVALID')
})

test('derivePlan：空主题抛错', () => {
  const bad = linkedRequest()
  bad.pageLinkage.homeTheme = ''
  assert.throws(() => derivePlanFromRequest(bad), (e) => e.code === 'BATCH_REQUEST_INVALID')
  bad.pageLinkage = { homeTheme: 'T', landingThemes: [{ theme: ' ' }] }
  assert.throws(() => derivePlanFromRequest(bad), (e) => e.code === 'BATCH_REQUEST_INVALID')
})

test('landingContextFor：非关联 item 返回 null；无 plan 返回 null', () => {
  const plan = derivePlanFromRequest(linkedRequest())
  assert.deepEqual(landingContextFor(plan, 'home-a'), null)
  assert.equal(landingContextFor(null, 'landing-a'), null)
})

test('homeContextFor：成功与可审阅失败 landing 携带 ref，完全失败 landing 只警告', () => {
  const plan = derivePlanFromRequest(linked3Request())
  const outcomes = new Map([
    // 成功 landing：直接可关联（outcome 携带批次相对 previewPath）。
    ['landing-a', { status: 'succeeded', landingKey: 'landing-01', previewPath: 'items/landing-a/attempts/0001/prototype.html' }],
    // 素材失败但已生成带诊断占位、可审阅原型：可关联（状态仍 failed）。
    ['landing-b', { status: 'failed', reviewable: true, landingKey: 'landing-02', previewPath: 'items/landing-b/attempts/0001/prototype.html' }],
    // 完全失败（无产物）：不可关联。
    ['landing-c', { status: 'failed', landingKey: 'landing-03' }],
  ])
  const { landingThemes, warnings } = homeContextFor(plan, outcomes)
  // ref 与 home CLI 接口对齐：<landingKey>/prototype.html（相对首页交付目录）。
  assert.deepEqual(landingThemes, [
    { landingKey: 'landing-01', theme: '夏日出游租赁', source: 'orchestrator', landingPreviewRef: 'landing-01/prototype.html' },
    { landingKey: 'landing-02', theme: '演唱会租赁', source: 'orchestrator', landingPreviewRef: 'landing-02/prototype.html' },
    { landingKey: 'landing-03', theme: '数码好物', source: 'orchestrator' },
  ])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /landing-03/)
  assert.match(warnings[0], /无可审阅原型/)
})

test('homeContextFor：failed 但 reviewable 缺 previewPath 或未标记 reviewable 均不可关联', () => {
  const plan = derivePlanFromRequest(linkedRequest())
  const outcomes = new Map([
    // reviewable=true 但无 previewPath：不建立关联。
    ['landing-a', { status: 'failed', reviewable: true, landingKey: 'landing-01' }],
    // failed + previewPath 但未标记 reviewable：不建立关联。
    ['landing-b', { status: 'failed', landingKey: 'landing-02', previewPath: 'items/landing-b/attempts/0001/prototype.html' }],
  ])
  const { landingThemes, warnings } = homeContextFor(plan, outcomes)
  assert.ok(landingThemes.every((t) => !('landingPreviewRef' in t)))
  assert.equal(warnings.length, 2)
})

test('homeContextFor：无 plan 返回空', () => {
  const { landingThemes, warnings } = homeContextFor(null, new Map())
  assert.deepEqual(landingThemes, [])
  assert.deepEqual(warnings, [])
})

test('jointReview：无 linkage 直接 ok', () => {
  const review = jointReview(null, new Map(), { status: 'succeeded' })
  assert.deepEqual(review.warnings, [])
  assert.equal(review.ok, true)
})

test('jointReview：可关联 landing 传给首页但 outcome 缺 previewPath 时不误报', () => {
  const plan = derivePlanFromRequest(linkedRequest())
  // 可关联 outcome 携带 previewPath（batch-runner 统一换算为首页相对 prototype.html ref）。
  const outcomes = new Map([
    ['landing-a', { status: 'succeeded', landingKey: 'landing-01', previewPath: 'items/landing-a/attempts/0001/prototype.html' }],
    ['landing-b', { status: 'succeeded', landingKey: 'landing-02', previewPath: 'items/landing-b/attempts/0001/prototype.html' }],
  ])
  const { landingThemes, warnings } = jointReview(plan, outcomes, { status: 'succeeded' })
  assert.deepEqual(landingThemes.map((t) => t.landingPreviewRef), ['landing-01/prototype.html', 'landing-02/prototype.html'])
  assert.deepEqual(warnings, [])
})

test('previewRefFor：指向 attempt 内 prototype.html 的 POSIX 相对路径且无 ..', () => {
  const ref = previewRefFor('E:\\workspace\\out', 'E:\\workspace\\out\\items\\a\\attempts\\0001')
  assert.equal(ref, 'items/a/attempts/0001/prototype.html')
})
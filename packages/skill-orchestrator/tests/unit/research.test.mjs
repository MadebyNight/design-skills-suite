import assert from 'node:assert/strict'
import test from 'node:test'
import { buildResearchPack, validateResearchPack } from '../../runtime/research.mjs'

const catalog = {
  sourceCommit: 'abc123',
  pageType: 'alipay.home',
  components: [
    { id: 'hero', name: 'Hero', domTemplate: '<section>', allowedClasses: ['hero-c'], allowedVariants: ['hero-v'], slots: [] },
    { id: 'grid', name: 'Grid', domTemplate: '<div>', allowedClasses: ['grid-c'], allowedVariants: ['grid-v'], slots: [] },
  ],
}

function brief(policy = 'optional') {
  return {
    id: 'b1',
    goal: '提升首页转化率',
    deliverableType: 'alipay.home',
    audience: '年轻用户',
    brandConstraints: [],
    contentRequirements: ['突出 hero 与 grid 组件'],
    visualConstraints: ['现代配色、清晰布局'],
    outputSpec: { width: 375, height: 812, format: 'png' },
    inputArtifacts: [],
    researchPolicy: policy,
    forbiddenChanges: [],
  }
}

function okSources() {
  return [
    { url: 'https://example.com/a', title: '现代配色实践', snippet: '采用主色与布局网格，强调视觉风格' },
    { url: 'https://example.com/b', title: '首页转化文案', snippet: '信息层次清晰，hero 与 grid 组合' },
  ]
}

test('none：skipped，pack null', async () => {
  const r = await buildResearchPack({ brief: brief('none'), searchBinding: okSources })
  assert.equal(r.status, 'skipped')
  assert.equal(r.pack, null)
  assert.ok(r.warnings.length >= 1)
})

test('optional 且检索缺失（searchBinding 未提供）→ warning，pack null', async () => {
  const r = await buildResearchPack({ brief: brief('optional') })
  assert.equal(r.status, 'warning')
  assert.equal(r.pack, null)
})

test('optional 且检索抛错 → warning，pack null', async () => {
  const r = await buildResearchPack({
    brief: brief('optional'),
    searchBinding: async () => { throw new Error('offline') },
  })
  assert.equal(r.status, 'warning')
  assert.equal(r.pack, null)
  assert.match(r.warnings[0], /offline/)
})

test('optional 且空结果 → warning，pack null', async () => {
  const r = await buildResearchPack({ brief: brief('optional'), searchBinding: async () => [] })
  assert.equal(r.status, 'warning')
  assert.equal(r.pack, null)
})

test('required 且检索失败 → failed，pack null', async () => {
  const r = await buildResearchPack({ brief: brief('required'), searchBinding: async () => [] })
  assert.equal(r.status, 'failed')
  assert.equal(r.pack, null)
})

test('成功：输出通过 ResearchPack Schema，sourceRefs 引用 sources URL', async () => {
  const r = await buildResearchPack({ brief: brief('optional'), searchBinding: okSources, catalog })
  assert.equal(r.status, 'succeeded')
  const pack = r.pack
  const urls = new Set(pack.sources.map((s) => s.url))
  assert.ok(pack.queries.length >= 1)
  assert.equal(pack.sources.length, 2)
  for (const s of pack.sources) {
    assert.ok(s.url && s.title && s.snippet)
    assert.ok(urls.has(s.url))
  }
  for (const signal of pack.signals) {
    assert.ok(['visual', 'color', 'layout', 'content'].includes(signal.kind))
    for (const ref of signal.sourceRefs) assert.ok(urls.has(ref))
  }
  assert.ok(pack.adoptedElements.length >= 1)
  for (const el of pack.adoptedElements) {
    assert.ok(el.element && el.reason)
    assert.ok(el.sourceRefs.length >= 1)
    for (const ref of el.sourceRefs) assert.ok(urls.has(ref))
  }
})

test('成功：adoptedElements 经过 catalog 过滤', async () => {
  const r = await buildResearchPack({ brief: brief('optional'), searchBinding: okSources, catalog })
  const ids = new Set(catalog.components.map((c) => c.id))
  for (const el of r.pack.adoptedElements) assert.ok(ids.has(el.element))
})

test('结果对象通过 ResearchPack Schema 校验（validateResearchPack 不抛错）', async () => {
  const r = await buildResearchPack({ brief: brief('optional'), searchBinding: okSources, catalog })
  assert.doesNotThrow(() => validateResearchPack(r.pack))
})

test('maxQueries 限制派生查询条数', async () => {
  const q = { ...brief('optional'), contentRequirements: ['a', 'b', 'c', 'd'] }
  const r = await buildResearchPack({ brief: q, searchBinding: okSources, maxQueries: 2 })
  assert.ok(r.pack.queries.length <= 2)
})

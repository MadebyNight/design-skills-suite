import assert from 'node:assert/strict'
import test from 'node:test'
import { aggregateGuidance, validateGuidance, allowedTokens } from '../../runtime/guidance.mjs'

const catalog = {
  sourceCommit: 'abc123',
  pageType: 'alipay.home',
  components: [
    { id: 'hero', name: 'Hero', domTemplate: '<section>', allowedClasses: ['hero-c'], allowedVariants: ['hero-v'], slots: [] },
    { id: 'grid', name: 'Grid', domTemplate: '<div>', allowedClasses: ['grid-c'], allowedVariants: ['grid-v'], slots: [] },
  ],
}

const binding = (sourceSkill = 'skill-a', version = '1.0.0', items) => ({
  sourceSkill,
  sourceSkillVersion: version,
  run: async () => items,
})

test('正常合并：accepted 条目带 catalogAccepted=true 与 rejectionReason=null', async () => {
  const { guidance } = await aggregateGuidance({
    brief: {},
    catalog,
    guidanceBindings: [
      binding('skill-a', '1.0.0', [{ kind: 'color', content: 'hero-c 主色强调', tokens: ['hero-c'] }]),
      binding('skill-b', '2.0.0', [{ kind: 'typography', content: 'grid-v 大字号', tokens: ['grid-v'] }]),
    ],
  })
  assert.equal(guidance.items.length, 2)
  for (const item of guidance.items) {
    assert.equal(item.catalogAccepted, true)
    assert.equal(item.rejectionReason, null)
    assert.ok(item.sourceSkill)
    assert.ok(item.sourceSkillVersion)
  }
  assert.equal(guidance.catalogCompatibility.compatible, true)
  assert.equal(guidance.catalogCompatibility.rejectedCount, 0)
  assert.equal(guidance.catalogCompatibility.sourceCommit, 'abc123')
})

test('拒绝未知 class/组件 token 并记录 reason 与 rejectedCount', async () => {
  const { guidance } = await aggregateGuidance({
    catalog,
    guidanceBindings: [
      binding('skill-a', '1.0.0', [
        { kind: 'visualDirection', content: '使用 ghost-btn 未登记按钮', tokens: ['ghost-btn'] },
        { kind: 'color', content: '使用 hero-c 合法按钮', tokens: ['hero-c'] },
      ]),
    ],
  })
  const rejected = guidance.items.filter((i) => i.catalogAccepted === false)
  const accepted = guidance.items.filter((i) => i.catalogAccepted === true)
  assert.equal(rejected.length, 1)
  assert.match(rejected[0].rejectionReason, /ghost-btn/)
  assert.equal(accepted.length, 1)
  assert.equal(guidance.catalogCompatibility.compatible, false)
  assert.equal(guidance.catalogCompatibility.rejectedCount, 1)
})

test('binding 失败非阻断：产生 warning 且不崩溃', async () => {
  const { guidance, warnings } = await aggregateGuidance({
    catalog,
    guidanceBindings: [
      { sourceSkill: 'broken', sourceSkillVersion: '1.0.0', run: async () => { throw new Error('boom') } },
      binding('ok', '1.0.0', [{ kind: 'color', content: 'hero-c 保留', tokens: ['hero-c'] }]),
    ],
  })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /boom/)
  assert.equal(guidance.items.length, 1)
  assert.equal(guidance.items[0].catalogAccepted, true)
})

test('无 binding 时输出空 items 且 compatible=true', async () => {
  const { guidance } = await aggregateGuidance({ catalog })
  assert.equal(guidance.items.length, 0)
  assert.equal(guidance.catalogCompatibility.compatible, true)
  assert.equal(guidance.catalogCompatibility.rejectedCount, 0)
})

test('输出通过 DesignGuidance Schema 校验', async () => {
  const { guidance } = await aggregateGuidance({
    catalog,
    guidanceBindings: [binding('skill-a', '1.0.0', [{ kind: 'qualityReview', content: 'hero-c 检查', tokens: ['hero-c'] }])],
  })
  assert.doesNotThrow(() => validateGuidance(guidance))
})

test('allowedTokens 汇总 component id / allowedClasses / allowedVariants', () => {
  const tokens = allowedTokens(catalog)
  assert.ok(tokens.has('hero'))
  assert.ok(tokens.has('hero-c'))
  assert.ok(tokens.has('hero-v'))
  assert.ok(tokens.has('grid'))
  assert.ok(tokens.has('grid-c'))
  assert.ok(tokens.has('grid-v'))
  assert.ok(!tokens.has('ghost-btn'))
})

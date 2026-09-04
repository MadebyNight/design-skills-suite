import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveAssetPolicy, validateAssetPolicyShape, AssetPolicyError } from '../../runtime/asset-policy.mjs'

const basePolicy = {
  default: { source: 'generate', requirement: 'required' },
  rules: [
    { usageSlot: 'home.hero.image', source: 'reuse', requirement: 'optional' },
    { usageSlot: 'home.*', source: 'generate', requirement: 'required' },
    { usageSlot: 'home.hero.*', source: 'reuse', requirement: 'optional' },
  ],
}

test('精确优先于通配', () => {
  const r = resolveAssetPolicy(basePolicy, 'home.hero.image')
  assert.equal(r.source, 'reuse')
  assert.equal(r.usageSlotPattern, 'home.hero.image')
  assert.equal(r.matchedRuleIndex, 0)
})

test('通配前缀越长越优先', () => {
  // 'home.hero.banner' 同时命中 'home.*' 与 'home.hero.*'，后者前缀更长。
  const r = resolveAssetPolicy(basePolicy, 'home.hero.banner')
  assert.equal(r.source, 'reuse')
  assert.equal(r.usageSlotPattern, 'home.hero.*')
  assert.equal(r.matchedRuleIndex, 2)
})

test('同精度下后声明优先', () => {
  const policy = {
    default: { source: 'generate', requirement: 'required' },
    rules: [
      { usageSlot: 'a.*', source: 'generate', requirement: 'required' },
      { usageSlot: 'a.*', source: 'reuse', requirement: 'optional' },
    ],
  }
  const r = resolveAssetPolicy(policy, 'a.x')
  assert.equal(r.source, 'reuse')
  assert.equal(r.matchedRuleIndex, 1)
})

test('无匹配回退 default', () => {
  const r = resolveAssetPolicy(basePolicy, 'footer.contact')
  assert.equal(r.source, 'generate')
  assert.equal(r.usageSlotPattern, null)
  assert.equal(r.matchedRuleIndex, -1)
})

test('非法中间 * 抛 INVALID_ASSET_POLICY', () => {
  const policy = {
    default: { source: 'generate', requirement: 'required' },
    rules: [{ usageSlot: 'a*b', source: 'generate', requirement: 'required' }],
  }
  assert.throws(() => resolveAssetPolicy(policy, 'axb'), (e) => e.code === 'INVALID_ASSET_POLICY')
  assert.throws(() => validateAssetPolicyShape(policy), (e) => e instanceof AssetPolicyError && e.code === 'INVALID_ASSET_POLICY')
})

test('非法形状：default 缺失 / rules 非数组 / usageSlot 非字符串', () => {
  assert.throws(() => validateAssetPolicyShape({ rules: [] }), (e) => e.code === 'INVALID_ASSET_POLICY')
  assert.throws(() => validateAssetPolicyShape({ default: {}, rules: 'x' }), (e) => e.code === 'INVALID_ASSET_POLICY')
  assert.throws(() => validateAssetPolicyShape({ default: {}, rules: [{ usageSlot: 42, source: 'generate', requirement: 'required' }] }), (e) => e.code === 'INVALID_ASSET_POLICY')
})

test('额外字段被拒绝：policy / default / rule', () => {
  assert.throws(() => validateAssetPolicyShape({ default: { source: 'generate', requirement: 'required' }, rules: [], extra: 1 }), (e) => e.code === 'INVALID_ASSET_POLICY')
  assert.throws(() => validateAssetPolicyShape({ default: { source: 'generate', requirement: 'required', extra: 1 }, rules: [] }), (e) => e.code === 'INVALID_ASSET_POLICY')
  assert.throws(() => validateAssetPolicyShape({ default: { source: 'generate', requirement: 'required' }, rules: [{ usageSlot: 'a', source: 'generate', requirement: 'required', extra: 1 }] }), (e) => e.code === 'INVALID_ASSET_POLICY')
})

test('source / requirement enum 非法被拒绝', () => {
  assert.throws(() => validateAssetPolicyShape({ default: { source: 'bad', requirement: 'required' }, rules: [] }), (e) => e.code === 'INVALID_ASSET_POLICY')
  assert.throws(() => validateAssetPolicyShape({ default: { source: 'generate', requirement: 'bad' }, rules: [] }), (e) => e.code === 'INVALID_ASSET_POLICY')
  assert.throws(() => validateAssetPolicyShape({ default: { source: 'generate', requirement: 'required' }, rules: [{ usageSlot: 'a', source: 'bad', requirement: 'required' }] }), (e) => e.code === 'INVALID_ASSET_POLICY')
})

test('旧 pattern 字段被 INVALID_ASSET_POLICY 拒绝', () => {
  const legacy = {
    default: { source: 'generate', requirement: 'required' },
    rules: [{ pattern: 'home.*', source: 'generate', requirement: 'required' }],
  }
  assert.throws(() => resolveAssetPolicy(legacy, 'home.x'), (e) => e.code === 'INVALID_ASSET_POLICY')
  assert.throws(() => validateAssetPolicyShape(legacy), (e) => e.code === 'INVALID_ASSET_POLICY')
})

test('Schema 合法 fixture 可直接 resolve', () => {
  // 与 design-skill-contracts/fixtures/valid/asset-policy.json 一致。
  const fixture = {
    default: { source: 'generate', requirement: 'required' },
    rules: [
      { usageSlot: 'home.hero.image', source: 'reuse', requirement: 'optional' },
      { usageSlot: 'home.banner*', source: 'generate', requirement: 'required' },
    ],
  }
  assert.doesNotThrow(() => validateAssetPolicyShape(fixture))
  const exact = resolveAssetPolicy(fixture, 'home.hero.image')
  assert.equal(exact.source, 'reuse')
  assert.equal(exact.usageSlotPattern, 'home.hero.image')
  const wild = resolveAssetPolicy(fixture, 'home.banner.primary')
  assert.equal(wild.source, 'generate')
  assert.equal(wild.usageSlotPattern, 'home.banner*')
  const fallback = resolveAssetPolicy(fixture, 'footer.contact')
  assert.equal(fallback.source, 'generate')
  assert.equal(fallback.usageSlotPattern, null)
})

test('不修改输入 policy', () => {
  const policy = structuredClone(basePolicy)
  const snapshot = JSON.stringify(policy)
  resolveAssetPolicy(policy, 'home.hero.image')
  assert.equal(JSON.stringify(policy), snapshot)
})

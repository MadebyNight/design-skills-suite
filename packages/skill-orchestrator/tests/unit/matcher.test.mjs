import assert from 'node:assert/strict'
import test from 'node:test'
import { matchCapability } from '../../runtime/matcher.mjs'

// 基础 Skill manifest。
const mk = (id, over = {}) => ({
  schemaVersion: '1',
  id,
  version: '1.0.0',
  name: id,
  description: 'fixture',
  entrypoint: 'bin/x.mjs',
  inputSchema: 'asset-request.schema.json',
  outputSchema: 'asset-result.schema.json',
  provides: ['image.generate'],
  requires: [],
  automatic: true,
  confirmationPoints: [],
  verifyCommand: 'x capabilities',
  ...over,
})

// 从 manifest 列表构造 discovery 输出。
const diag = (manifests) => ({
  skills: manifests.map((m) => ({ root: `/skills/${m.id}`, manifest: m })),
})

const skillOf = (manifest, root = `/skills/${manifest.id}`) => ({ root, manifest })

test('只从 discovery.skills 且 provides 包含 capability 的候选中选择', () => {
    const a = mk('skill-a', { provides: ['image.generate'] })
    const b = mk('skill-b', { provides: ['image.resize'] })
    const d = diag([a, b])
    const r = matchCapability({ discovery: d, capability: 'image.generate' })
    assert.equal(r.selected.manifest.id, 'skill-a')
    assert.equal(r.alternatives.length, 0)
    assert.deepEqual(r.missing, [])
    assert.equal(r.missingCapability, null)
  })

  test('无候选提供能力时 selected 为 null 并报告缺失', () => {
    const d = diag([mk('skill-a', { provides: ['image.resize'] })])
    const r = matchCapability({ discovery: d, capability: 'image.generate' })
    assert.equal(r.selected, null)
    assert.deepEqual(r.missing, ['image.generate'])
    assert.equal(r.missingCapability, 'image.generate')
  })

  test('显式指定优先选择', () => {
    const a = mk('skill-a', { automatic: false })
    const b = mk('skill-b', { automatic: true })
    const r = matchCapability({ discovery: diag([a, b]), capability: 'image.generate', preferredSkillId: 'skill-a' })
    assert.equal(r.selected.manifest.id, 'skill-a')
    assert.match(r.reason, /skill-a/)
  })

  test('显式指定失败后回退并记录原因', () => {
    const a = mk('skill-a', { automatic: false })
    const b = mk('skill-b', { automatic: true })
    const r = matchCapability({
      discovery: diag([a, b]),
      capability: 'image.generate',
      preferredSkillId: 'skill-x',
      capabilities: [{ id: 'image.generate', priority: 10, skillId: 'skill-b' }],
    })
    assert.equal(r.selected.manifest.id, 'skill-b')
    assert.match(r.reason, /skill-x/)
    assert.match(r.reason, /回退/)
  })

  test('显式指定被过滤时记录排除原因', () => {
    const a = mk('skill-a', { automatic: false })
    const b = mk('skill-b', { automatic: true })
    const r = matchCapability({
      discovery: diag([a, b]),
      capability: 'image.generate',
      request: { requireAutomatic: true },
      preferredSkillId: 'skill-a',
    })
    assert.equal(r.selected.manifest.id, 'skill-b')
    assert.match(r.reason, /skill-a/)
  })

test('request 约束：automatic / confirmation / schema 不兼容被排除', () => {
  const auto = mk('skill-auto', { automatic: true })
  const manual = mk('skill-manual', { automatic: false })
  const confirm = mk('skill-confirm', { automatic: true, confirmationPoints: ['确认生成'] })
  const diffInput = mk('skill-diff-input', { inputSchema: 'other.schema.json' })
  const diffOutput = mk('skill-diff-output', { outputSchema: 'other.schema.json' })

  const all = diag([auto, manual, confirm, diffInput, diffOutput])

  // requireAutomatic
  let r = matchCapability({ discovery: all, capability: 'image.generate', request: { requireAutomatic: true } })
  assert.equal(r.selected.manifest.id, 'skill-auto')

  // allowConfirmation=false 排除有确认点的
  r = matchCapability({ discovery: all, capability: 'image.generate', request: { allowConfirmation: false } })
  assert.notEqual(r.selected.manifest.id, 'skill-confirm')
  assert.ok(r.rejected.some((x) => x.manifest.id === 'skill-confirm' && /确认点/.test(x.reason)))

  // inputSchemaRef 排除不兼容
  r = matchCapability({ discovery: all, capability: 'image.generate', request: { inputSchemaRef: 'asset-request.schema.json' } })
  assert.notEqual(r.selected.manifest.id, 'skill-diff-input')

  // outputSchemaRef 排除不兼容
  r = matchCapability({ discovery: all, capability: 'image.generate', request: { outputSchemaRef: 'asset-result.schema.json' } })
  assert.notEqual(r.selected.manifest.id, 'skill-diff-output')

  // 全部被排除时报告缺失
  const onlyManual = diag([manual])
  r = matchCapability({ discovery: onlyManual, capability: 'image.generate', request: { requireAutomatic: true } })
  assert.equal(r.selected, null)
  assert.deepEqual(r.missing, ['image.generate'])
  assert.equal(r.missingCapability, 'image.generate')
})

test('confirmationPoints 输出选中的确认点', () => {
  const c = mk('skill-confirm', { confirmationPoints: ['生成后需确认'] })
  const r = matchCapability({ discovery: diag([c]), capability: 'image.generate' })
  assert.deepEqual(r.confirmationPoints, ['生成后需确认'])
})

test('capabilities 提供能力级 priority：应用到所有候选（同值回到稳定排序）', () => {
  const a = mk('skill-a')
  const b = mk('skill-b')
  const d = diag([a, b])
  const capMeta = [{ id: 'image.generate', version: '1.0.0', priority: 5 }]
  const r = matchCapability({ discovery: d, capability: 'image.generate', capabilities: capMeta })
  // 能力级条目应用于所有候选 → 两者 priority 相同，回到稳定排序取最小 Skill ID。
  assert.equal(r.selected.priority, 5)
  assert.equal(r.alternatives[0].priority, 5)
  assert.equal(r.selected.manifest.id, 'skill-a')
})

test('capabilities 提供带 skillId 的条目：只影响对应 Skill', () => {
  const a = mk('skill-a')
  const b = mk('skill-b')
  const d = diag([a, b])
  const capMeta = [{ id: 'image.generate', version: '1.0.0', priority: 10, skillId: 'skill-a' }]
  const r = matchCapability({ discovery: d, capability: 'image.generate', capabilities: capMeta })
  assert.equal(r.selected.manifest.id, 'skill-a')
})

test('缺省 priority=0；只匹配冻结 capability ID', () => {
  const a = mk('skill-a', { provides: ['image.generate'] })
  const b = mk('skill-b', { provides: ['image.generate'] })
  const d = diag([a, b])
  // 未提供 capabilities → 均按 priority 0，仅能力 ID 匹配，稳定排序取最小 Skill ID。
  const r = matchCapability({ discovery: d, capability: 'image.generate' })
  assert.equal(r.selected.manifest.id, 'skill-a')
  assert.equal(r.selected.priority, 0)

  // 提供的能力条目不匹配冻结 ID 时应被忽略（等同缺省）。
  const r2 = matchCapability({ discovery: d, capability: 'image.generate', capabilities: [{ id: 'image.resize', priority: 100 }] })
  assert.equal(r2.selected.priority, 0)
})

test('capability version 参与排序（版本高优先，数值与字符串段均可比较）', () => {
  const a = mk('skill-a')
  const b = mk('skill-b')
  const d = diag([a, b])
  const capMeta = [
    { id: 'image.generate', version: '1.0.0', priority: 5, skillId: 'skill-a' },
    { id: 'image.generate', version: '1.2.0', priority: 5, skillId: 'skill-b' },
  ]
  const r = matchCapability({ discovery: d, capability: 'image.generate', capabilities: capMeta })
  assert.equal(r.selected.manifest.id, 'skill-b')
  assert.equal(r.selected.version, '1.2.0')
})

test('capabilities 可传对象形式（skillId 为键）', () => {
  const a = mk('skill-a')
  const b = mk('skill-b')
  const d = diag([a, b])
  const r = matchCapability({
    discovery: d,
    capability: 'image.generate',
    capabilities: { 'skill-a': { id: 'image.generate', version: '1.0.0', priority: 10 } },
  })
  assert.equal(r.selected.manifest.id, 'skill-a')
})

test('同优先级下按 priority 降序、Skill ID、规范化路径稳定排序', () => {
  const a = mk('skill-a')
  const b = mk('skill-b')
  const c = mk('skill-c')
  // 同一 Skill ID 在不同宿主目录 → 路径排序
  const a2 = { root: '/host-b/skill-a', manifest: mk('skill-a') }
  const d = { skills: [skillOf(a, '/host-a/skill-a'), skillOf(b, '/host-a/skill-b'), skillOf(c, '/host-a/skill-c'), a2] }
  const r = matchCapability({ discovery: d, capability: 'image.generate' })
  assert.deepEqual(
    [r.selected, ...r.alternatives].map((x) => x.manifest.id),
    ['skill-a', 'skill-a', 'skill-b', 'skill-c'],
  )
})

test('重复执行结果确定（无随机选择）', () => {
  const a = mk('skill-a')
  const b = mk('skill-b')
  const c = mk('skill-c')
  const d = diag([a, b, c])
  const inputs = [
    { discovery: d, capability: 'image.generate' },
    { discovery: d, capability: 'image.generate', capabilities: [{ id: 'image.generate', priority: 9, skillId: 'skill-b' }] },
    { discovery: d, capability: 'image.generate', preferredSkillId: 'skill-c' },
  ]
  for (const input of inputs) {
    const r1 = matchCapability(input)
    const r2 = matchCapability(input)
    assert.deepEqual(r1, r2)
  }
})

test('rejected 记录所有被过滤的候选及其原因', () => {
  const auto = mk('skill-auto')
  const manual = mk('skill-manual', { automatic: false })
  const r = matchCapability({ discovery: diag([auto, manual]), capability: 'image.generate', request: { requireAutomatic: true } })
  assert.equal(r.selected.manifest.id, 'skill-auto')
  assert.equal(r.rejected.length, 1)
  assert.equal(r.rejected[0].manifest.id, 'skill-manual')
  assert.match(r.rejected[0].reason, /requireAutomatic/)
})

test('discovery.skills 为空或不传入时返回空结果且不崩溃', () => {
  const empty = matchCapability({ discovery: {}, capability: 'image.generate' })
  assert.equal(empty.selected, null)
  assert.deepEqual(empty.alternatives, [])
  assert.deepEqual(empty.missing, ['image.generate'])
  assert.equal(empty.missingCapability, 'image.generate')

  const undef = matchCapability()
  assert.equal(undef.selected, null)
  assert.deepEqual(undef.alternatives, [])
})

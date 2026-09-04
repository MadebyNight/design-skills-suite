import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { discoverSkills, normalizePath } from '../../runtime/discovery.mjs'

const baseManifest = {
  schemaVersion: '1',
  id: 'skill-image-generate',
  version: '0.1.0',
  name: 'Image Generate',
  description: 'fixture',
  entrypoint: 'bin/image-generate.mjs',
  inputSchema: 'asset-request.schema.json',
  outputSchema: 'asset-result.schema.json',
  provides: ['image.generate'],
  requires: [],
  automatic: true,
  confirmationPoints: [],
  verifyCommand: 'image-generate capabilities',
}

async function withTemp(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-discovery-'))
  try { return await fn(root) } finally { fs.rmSync(root, { recursive: true, force: true }) }
}

function makeSkill(root, name, manifest = baseManifest, { skillMd = true } = {}) {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  if (skillMd) fs.writeFileSync(path.join(dir, 'SKILL.md'), '# fixture\n')
  return dir
}

test('同一 manifest 位于三个宿主根时解析为相同身份和 capability', async () => withTemp(async root => {
  const roots = ['opencode', 'claude', 'codex'].map(name => makeSkill(root, name))
  const outputs = []
  for (const skillRoot of roots) outputs.push(await discoverSkills({ skillRoots: [skillRoot] }))
  assert.deepEqual(outputs.map(r => ({
    id: r.skills[0].manifest.id,
    version: r.skills[0].manifest.version,
    provides: r.skills[0].manifest.provides,
  })), Array(3).fill({ id: 'skill-image-generate', version: '0.1.0', provides: ['image.generate'] }))
}))

test('非法 manifest 被排除并记录原因', async () => withTemp(async root => {
  const bad = makeSkill(root, 'bad', { ...baseManifest, provides: ['image.unknown'] })
  const result = await discoverSkills({ skillRoots: [bad] })
  assert.equal(result.skills.length, 0)
  assert.equal(result.unavailable.length, 1)
  assert.match(result.unavailable[0].reason, /enum/)
}))

test('不存在目录和缺 manifest 不导致整体崩溃', async () => withTemp(async root => {
  const empty = path.join(root, 'empty')
  fs.mkdirSync(empty)
  const result = await discoverSkills({ skillRoots: [path.join(root, 'missing'), empty] })
  assert.equal(result.skills.length, 0)
  assert.equal(result.unavailable.length, 2)
}))

test('executor 返回 false 或抛错时记录不可用', async () => withTemp(async root => {
  const a = makeSkill(root, 'a')
  const falseResult = await discoverSkills({ skillRoots: [a], executor: async () => false })
  assert.match(falseResult.unavailable[0].reason, /判定不可用/)
  const errorResult = await discoverSkills({ skillRoots: [a], executor: async () => { throw new Error('offline') } })
  assert.match(errorResult.unavailable[0].reason, /offline/)
}))

test('重复 ID 按规范化路径稳定保留第一个', async () => withTemp(async root => {
  const z = makeSkill(root, 'z-skill')
  const a = makeSkill(root, 'a-skill')
  const result = await discoverSkills({ skillRoots: [z, a] })
  assert.equal(result.skills.length, 1)
  assert.equal(normalizePath(result.skills[0].root), normalizePath(a))
  assert.equal(result.duplicates.length, 1)
  assert.equal(normalizePath(result.duplicates[0].keptRoot), normalizePath(a))
}))

test('输出按 Skill ID 和 capability 稳定排序', async () => withTemp(async root => {
  const b = makeSkill(root, 'b', { ...baseManifest, id: 'skill-b', provides: ['image.resize'] })
  const a = makeSkill(root, 'a', { ...baseManifest, id: 'skill-a', provides: ['image.generate'] })
  const result = await discoverSkills({ skillRoots: [b, a] })
  assert.deepEqual(result.skills.map(item => item.manifest.id), ['skill-a', 'skill-b'])
  assert.deepEqual(Object.keys(result.byCapability), ['image.generate', 'image.resize'])
}))

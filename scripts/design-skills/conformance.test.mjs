import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { runCapabilityConformance } from './capability-conformance.mjs'
import { loadHostTemplates, runLocalConformance } from './conformance.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const mock = path.join(root, 'test-fixtures', 'design-skills', 'mocks', 'mock-image-edit')

test('mock 图片编辑实现可替换并输出合法严格尺寸 AssetResult', async () => {
  const request = { id: 'mock-request', usageSlot: 'slot', theme: 'fixture', targetWidth: 50, targetHeight: 50, aspectRatio: '1:1', format: 'png', fit: 'cover', safeArea: 'center', referenceImages: [], forbiddenContent: [], allowGenerate: false, allowEdit: true }
  const result = await runCapabilityConformance({ skillRoots: [mock], assetRequest: request })
  assert.equal(result.passed, true)
  assert.equal(result.matches['image.resize'].selected.manifest.id, 'mock-image-edit')
  assert.equal(result.assetResult.width, 50)
  assert.equal(result.assetResult.strictSizeSatisfied, true)
})

test('本地 conformance 1-5 层通过，跨宿主未伪造', async () => {
  const result = await runLocalConformance()
  assert.equal(result.passedLocal, true)
  assert.equal(result.layers.crossHost, false)
})

test('宿主模板由外部 JSON 注入', () => {
  const templates = loadHostTemplates(path.join(root, 'scripts', 'design-skills', 'hosts.example.json'))
  assert.deepEqual(templates.map(item => item.name), ['opencode', 'claude', 'codex'])
})

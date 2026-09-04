import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createCheckpointAssetStore } from '../../runtime/checkpoint-asset-store.mjs'
import { loadCheckpoint } from '../../runtime/checkpoint.mjs'
import { fingerprint } from '../../runtime/fingerprint.mjs'

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8AAQv8BD/kD/YURmXYAAAAASUVORK5CYII='

const request = {
  id: 'asset-req-001',
  usageSlot: 'home.hero.image',
  theme: '测试',
  targetWidth: 2,
  targetHeight: 1,
  aspectRatio: '2:1',
  format: 'png',
  fit: 'cover',
  safeArea: '中央',
  referenceImages: [],
  forbiddenContent: [],
  allowGenerate: true,
  allowEdit: true,
}

function makeValidResult(dir) {
  const filePath = path.join(dir, 'asset.png')
  const bytes = Buffer.from(PNG_BASE64, 'base64')
  fs.writeFileSync(filePath, bytes)
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
  return {
    assetRequestId: request.id,
    artifactId: 'gen',
    path: filePath,
    mimeType: 'image/png',
    width: 2,
    height: 1,
    sha256,
    sourceSkill: 'skill-image-generate',
    sourceSkillVersion: '0.1.0',
    strictSizeSatisfied: true,
    notes: [],
  }
}

function makeCheckpoint(root, itemId, assets = []) {
  return {
    schemaVersion: '1.0.0',
    batchId: 'batch-1',
    batchRequest: { batchId: 'batch-1', items: [] },
    requestFingerprint: fingerprint({ batchId: 'batch-1', items: [] }),
    sourceCommit: 'abc',
    provider: { id: 'p', model: 'm', baseUrlFingerprint: fingerprint('api.example.com') },
    status: 'running',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    items: [{ itemId, status: 'running', attempt: 1, attemptRoot: null, assets, resultPath: null, error: null }],
  }
}

test('put 严格校验后更新 checkpoint asset 为 succeeded 并原子写', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-store-put-'))
  const attemptRoot = path.join(root, 'items', 'item-1', 'attempts', '0001')
  fs.mkdirSync(attemptRoot, { recursive: true })
  const result = makeValidResult(attemptRoot)
  let state = makeCheckpoint(root, 'item-1')
  const store = createCheckpointAssetStore({
    checkpointRoot: root,
    getState: () => state,
    setState: (next) => { state = next },
    sourceRoot: attemptRoot,
    itemId: 'item-1',
  })
  try {
    await store.put('key-1', result, { request })
    const loaded = loadCheckpoint(root)
    const asset = loaded.items[0].assets.find((a) => a.assetKey === 'key-1')
    assert.equal(asset.status, 'succeeded')
    assert.equal(asset.result.sha256, result.sha256)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('put 拒绝非法结果且不更新 checkpoint', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-store-put-reject-'))
  const attemptRoot = path.join(root, 'items', 'item-1', 'attempts', '0001')
  fs.mkdirSync(attemptRoot, { recursive: true })
  const result = makeValidResult(attemptRoot)
  let state = makeCheckpoint(root, 'item-1')
  const store = createCheckpointAssetStore({
    checkpointRoot: root,
    getState: () => state,
    setState: (next) => { state = next },
    sourceRoot: attemptRoot,
    itemId: 'item-1',
  })
  try {
    const bad = { ...result, sha256: '0'.repeat(64) }
    await assert.rejects(() => store.put('key-1', bad, { request }))
    // 拒绝写入不应产生 asset 条目（checkpoint 未落盘，loadCheckpoint 返回 null）。
    assert.equal(loadCheckpoint(root), null)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('get 校验失败更新为 invalidated', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-store-get-invalid-'))
  const attemptRoot = path.join(root, 'items', 'item-1', 'attempts', '0001')
  fs.mkdirSync(attemptRoot, { recursive: true })
  const result = makeValidResult(attemptRoot)
  const bad = { ...result, sha256: '0'.repeat(64) }
  let state = makeCheckpoint(root, 'item-1', [{ assetKey: 'key-1', status: 'succeeded', result: bad, error: null }])
  const store = createCheckpointAssetStore({
    checkpointRoot: root,
    getState: () => state,
    setState: (next) => { state = next },
    sourceRoot: attemptRoot,
    itemId: 'item-1',
  })
  try {
    const got = await store.get('key-1', { request })
    assert.equal(got, null)
    const loaded = loadCheckpoint(root)
    assert.equal(loaded.items[0].assets[0].status, 'invalidated')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('get 命中合法条目返回结果', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-store-get-hit-'))
  const attemptRoot = path.join(root, 'items', 'item-1', 'attempts', '0001')
  fs.mkdirSync(attemptRoot, { recursive: true })
  const result = makeValidResult(attemptRoot)
  let state = makeCheckpoint(root, 'item-1', [{ assetKey: 'key-1', status: 'succeeded', result, error: null }])
  const store = createCheckpointAssetStore({
    checkpointRoot: root,
    getState: () => state,
    setState: (next) => { state = next },
    sourceRoot: attemptRoot,
    itemId: 'item-1',
  })
  try {
    const got = await store.get('key-1', { request })
    assert.ok(got)
    assert.equal(got.sha256, result.sha256)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

// ---- shared acceptance：checkpoint store 经由 createAssetStore 支持比例验收 ----

const aspectRequest = {
  ...request,
  id: 'asset-req-aspect',
  targetWidth: 1000,
  targetHeight: 1000,
  aspectRatio: '1:1',
  acceptance: { mode: 'aspect-ratio', maxAspectRatioError: 0.03 },
}

function makeProportionalResult(dir) {
  const filePath = path.join(dir, 'asset-proportional.png')
  const bytes = Buffer.from(PNG_BASE64, 'base64')
  fs.writeFileSync(filePath, bytes)
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
  return {
    assetRequestId: aspectRequest.id,
    artifactId: 'aspect-proportional',
    path: filePath,
    mimeType: 'image/png',
    width: 1030, // 理论恰 3% 边界（epsilon 补偿后通过）
    height: 1000,
    sha256,
    sourceSkill: 'skill-image-generate',
    sourceSkillVersion: '0.1.0',
    strictSizeSatisfied: false,
    notes: [],
  }
}

test('checkpoint store：比例合格非精确尺寸的素材可 put/get（恢复链路）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-store-aspect-put-'))
  const attemptRoot = path.join(root, 'items', 'item-1', 'attempts', '0001')
  fs.mkdirSync(attemptRoot, { recursive: true })
  const result = makeProportionalResult(attemptRoot)
  let state = makeCheckpoint(root, 'item-1')
  const store = createCheckpointAssetStore({
    checkpointRoot: root,
    getState: () => state,
    setState: (next) => { state = next },
    sourceRoot: attemptRoot,
    itemId: 'item-1',
  })
  try {
    await store.put('key-aspect', result, { request: aspectRequest })
    const loaded = loadCheckpoint(root)
    const asset = loaded.items[0].assets.find((a) => a.assetKey === 'key-aspect')
    assert.equal(asset.status, 'succeeded', '比例合格素材必须写入 checkpoint')
    // 重新种子化（模拟批次恢复）：新 store 从 checkpoint 条目读取后 get 应命中。
    const restored = createCheckpointAssetStore({
      checkpointRoot: root,
      getState: () => loaded,
      setState: (next) => { state = next },
      sourceRoot: attemptRoot,
      itemId: 'item-1',
    })
    const got = await restored.get('key-aspect', { request: aspectRequest })
    assert.ok(got, '恢复后比例合格素材必须命中缓存')
    assert.equal(got.width, 1030)
    assert.equal(got.strictSizeSatisfied, false)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('checkpoint store：比例超差素材 put 拒绝且不落盘', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-store-aspect-reject-'))
  const attemptRoot = path.join(root, 'items', 'item-1', 'attempts', '0001')
  fs.mkdirSync(attemptRoot, { recursive: true })
  const over = { ...makeProportionalResult(attemptRoot), width: 1040, artifactId: 'aspect-over' }
  let state = makeCheckpoint(root, 'item-1')
  const store = createCheckpointAssetStore({
    checkpointRoot: root,
    getState: () => state,
    setState: (next) => { state = next },
    sourceRoot: attemptRoot,
    itemId: 'item-1',
  })
  try {
    await assert.rejects(() => store.put('key-over', over, { request: aspectRequest }), /比例超出容差/)
    assert.equal(loadCheckpoint(root), null)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createCheckpoint,
  loadCheckpoint,
  loadCheckpointCandidates,
  promoteRecoveredCheckpoint,
  hasAnyCheckpointFile,
  writeCheckpointAtomic,
  normalizeInterrupted,
  validateCheckpoint,
  assertCompatible,
  touchCheckpoint,
  CheckpointError,
  CHECKPOINT_FILE,
  CHECKPOINT_NEXT_FILE,
  CHECKPOINT_PREVIOUS_FILE,
  CHECKPOINT_RECOVERY_FILE,
} from '../../runtime/checkpoint.mjs'
import { fingerprint } from '../../runtime/fingerprint.mjs'

const providerIdentity = { id: 'openai-compatible', model: 'gpt-image-2', baseURL: 'https://api.example.com/v1' }
const batchRequest = { batchId: 'batch-1', goal: '首页', deliverableType: 'alipay.home' }
const sourceCommit = 'abc123'
const REQUEST_FP = fingerprint(batchRequest)

function baseState(over = {}) {
  return {
    schemaVersion: '1.0.0',
    batchId: 'batch-1',
    batchRequest,
    requestFingerprint: REQUEST_FP,
    sourceCommit,
    provider: { id: 'openai-compatible', model: 'gpt-image-2', baseUrlFingerprint: fingerprint('api.example.com/v1') },
    status: 'running',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    items: [],
    ...over,
  }
}

test('createCheckpoint 生成合法初始状态（batchId 来自 batchRequest.batchId）', () => {
  const state = createCheckpoint({ batchRequest, sourceCommit, providerIdentity })
  assert.equal(state.status, 'running')
  assert.equal(state.batchId, 'batch-1')
  assert.equal(state.requestFingerprint, REQUEST_FP)
  assert.ok(state.createdAt && state.updatedAt)
  assert.deepEqual(state.items, [])
  assert.doesNotThrow(() => validateCheckpoint(state))
})

test('createCheckpoint 缺 batchId 抛 CHECKPOINT_INVALID', () => {
  assert.throws(() => createCheckpoint({ batchRequest: { goal: 'x' }, sourceCommit, providerIdentity }), (e) => e.code === 'CHECKPOINT_INVALID')
  assert.throws(() => createCheckpoint({ batchRequest: null, sourceCommit, providerIdentity }), (e) => e.code === 'CHECKPOINT_INVALID')
})

test('createCheckpoint 支持注入 now', () => {
  const fixed = new Date('2026-05-05T05:05:05.000Z')
  const state = createCheckpoint({ batchRequest, sourceCommit, providerIdentity, now: () => fixed })
  assert.equal(state.createdAt, fixed.toISOString())
  assert.equal(state.updatedAt, fixed.toISOString())
})

test('writeCheckpointAtomic 原子写入并保留 previous', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-atomic-'))
  try {
    const first = baseState({ status: 'running' })
    await writeCheckpointAtomic(root, first)
    assert.ok(fs.existsSync(path.join(root, CHECKPOINT_FILE)))
    assert.equal(fs.existsSync(path.join(root, CHECKPOINT_NEXT_FILE)), false, 'next 文件应被 rename 掉')

    const second = baseState({ status: 'succeeded' })
    await writeCheckpointAtomic(root, second)
    // 第二次写入后 previous 应保留第一次内容。
    const previous = JSON.parse(fs.readFileSync(path.join(root, CHECKPOINT_PREVIOUS_FILE), 'utf8'))
    assert.equal(previous.status, 'running')
    const current = JSON.parse(fs.readFileSync(path.join(root, CHECKPOINT_FILE), 'utf8'))
    assert.equal(current.status, 'succeeded')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('loadCheckpoint 加载合法检查点', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-load-'))
  try {
    await writeCheckpointAtomic(root, baseState())
    const state = loadCheckpoint(root)
    assert.equal(state.batchId, 'batch-1')
    assert.equal(state.requestFingerprint, REQUEST_FP)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('loadCheckpoint 截断 JSON 抛 CHECKPOINT_INVALID', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-truncated-'))
  try {
    fs.writeFileSync(path.join(root, CHECKPOINT_FILE), '{"schemaVersion":"1.0.0","batchId":')
    assert.throws(() => loadCheckpoint(root), (e) => e.code === 'CHECKPOINT_INVALID')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('assertCompatible：requestFingerprint 不匹配抛 CHECKPOINT_INCOMPATIBLE', () => {
  const state = baseState()
  const fp = fingerprint({ batchId: 'batch-1', goal: '不同目标', deliverableType: 'alipay.home' })
  assert.throws(() => assertCompatible(state, { batchId: 'batch-1', fingerprint: fp, sourceCommit, provider: state.provider }), (e) => e.code === 'CHECKPOINT_INCOMPATIBLE')
})

test('assertCompatible：state.batchRequest 被篡改抛 CHECKPOINT_INCOMPATIBLE', () => {
  const state = baseState({ batchRequest: { batchId: 'batch-1', goal: '被篡改' } })
  assert.throws(() => assertCompatible(state, { batchId: 'batch-1', fingerprint: REQUEST_FP, sourceCommit, provider: state.provider }), (e) => e.code === 'CHECKPOINT_INCOMPATIBLE')
})

test('assertCompatible：provider 不匹配抛 CHECKPOINT_INCOMPATIBLE', () => {
  const state = baseState()
  const otherProvider = { id: 'fal', model: 'x', baseUrlFingerprint: fingerprint('fal.example.com') }
  assert.throws(() => assertCompatible(state, { batchId: 'batch-1', fingerprint: REQUEST_FP, sourceCommit, provider: otherProvider }), (e) => e.code === 'CHECKPOINT_INCOMPATIBLE')
})

test('assertCompatible：sourceCommit 不匹配抛 CHECKPOINT_INCOMPATIBLE', () => {
  const state = baseState()
  assert.throws(() => assertCompatible(state, { batchId: 'batch-1', fingerprint: REQUEST_FP, sourceCommit: 'other', provider: state.provider }), (e) => e.code === 'CHECKPOINT_INCOMPATIBLE')
})

test('assertCompatible：current fingerprint 缺失抛 CHECKPOINT_INCOMPATIBLE', () => {
  const state = baseState()
  assert.throws(() => assertCompatible(state, { batchId: 'batch-1', fingerprint: '', sourceCommit, provider: state.provider }), (e) => e.code === 'CHECKPOINT_INCOMPATIBLE')
})

test('assertCompatible：全部匹配通过', () => {
  const state = baseState()
  assert.doesNotThrow(() => assertCompatible(state, { batchId: 'batch-1', fingerprint: REQUEST_FP, sourceCommit, provider: state.provider }))
})

test('touchCheckpoint 纯函数更新 updatedAt 不修改输入', () => {
  const state = baseState()
  const fixed = new Date('2026-06-06T06:06:06.000Z')
  const next = touchCheckpoint(state, () => fixed)
  assert.equal(next.updatedAt, fixed.toISOString())
  assert.equal(state.updatedAt, '2026-01-01T00:00:00.000Z', '输入不应被修改')
  assert.equal(next.requestFingerprint, REQUEST_FP)
  assert.doesNotThrow(() => validateCheckpoint(next))
})

test('normalizeInterrupted：running item 与 asset 转 interrupted 且保留指纹/时间戳', () => {
  const state = baseState({
    items: [{
      itemId: 'i1',
      status: 'running',
      attempt: 1,
      attemptRoot: '/x/items/i1/attempts/0001',
      assets: [{ assetKey: 'k1', status: 'running', result: null, error: null }],
      resultPath: null,
      error: null,
    }],
  })
  const next = normalizeInterrupted(state)
  assert.equal(next.items[0].status, 'interrupted')
  assert.equal(next.items[0].assets[0].status, 'interrupted')
  assert.equal(next.requestFingerprint, REQUEST_FP)
  assert.equal(next.createdAt, state.createdAt)
  assert.equal(next.updatedAt, state.updatedAt)
  // 不修改输入。
  assert.equal(state.items[0].status, 'running')
  assert.doesNotThrow(() => validateCheckpoint(next))
})

test('validateCheckpoint：非法结构抛 CHECKPOINT_INVALID', () => {
  assert.throws(() => validateCheckpoint({ ...baseState(), status: 'bogus' }), (e) => e.code === 'CHECKPOINT_INVALID')
  assert.throws(() => validateCheckpoint({ ...baseState(), items: [{ itemId: 'i1' }] }), (e) => e.code === 'CHECKPOINT_INVALID')
  assert.throws(() => validateCheckpoint({ ...baseState(), requestFingerprint: 'not-a-hash' }), (e) => e.code === 'CHECKPOINT_INVALID')
})

const compatible = { batchId: 'batch-1', fingerprint: REQUEST_FP, sourceCommit, provider: { id: 'openai-compatible', model: 'gpt-image-2', baseUrlFingerprint: fingerprint('api.example.com/v1') } }

test('恢复：current 缺失 + next 完整 → 从 next 恢复', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-recover-missing-'))
  try {
    await writeCheckpointAtomic(root, baseState({ status: 'running' }))
    // 模拟崩溃：current 缺失，只剩 next（与 current 相同内容）。
    fs.copyFileSync(path.join(root, CHECKPOINT_FILE), path.join(root, CHECKPOINT_NEXT_FILE))
    fs.rmSync(path.join(root, CHECKPOINT_FILE))
    const rec = loadCheckpointCandidates(root, compatible)
    assert.equal(rec.source, 'checkpoint.next')
    assert.equal(rec.state.status, 'running')
    // 恢复后提升为当前 checkpoint。
    await promoteRecoveredCheckpoint(root, rec.state, { source: rec.source })
    assert.ok(fs.existsSync(path.join(root, CHECKPOINT_FILE)))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('恢复：current 截断 + next 完整 → 从 next 恢复', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-recover-truncated-'))
  try {
    await writeCheckpointAtomic(root, baseState({ status: 'running' }))
    fs.copyFileSync(path.join(root, CHECKPOINT_FILE), path.join(root, CHECKPOINT_NEXT_FILE))
    fs.writeFileSync(path.join(root, CHECKPOINT_FILE), '{"schemaVersion":"1.0.0","batchId":') // 截断 current
    const rec = loadCheckpointCandidates(root, compatible)
    assert.equal(rec.source, 'checkpoint.next')
    assert.equal(rec.state.status, 'running')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('恢复：next 坏 + previous 完整 → 从 previous 恢复', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-recover-previous-'))
  try {
    await writeCheckpointAtomic(root, baseState({ status: 'running' }))
    // previous 保留第一次内容。
    const second = baseState({ status: 'succeeded' })
    await writeCheckpointAtomic(root, second)
    fs.writeFileSync(path.join(root, CHECKPOINT_NEXT_FILE), '{bad json') // 污染 next
    fs.rmSync(path.join(root, CHECKPOINT_FILE)) // current 缺失
    const rec = loadCheckpointCandidates(root, compatible)
    assert.equal(rec.source, 'checkpoint.previous')
    assert.equal(rec.state.status, 'running')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('恢复：current 合法但不兼容 → 立即 CHECKPOINT_INCOMPATIBLE 不回退', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-recover-incompat-'))
  try {
    const incompatible = baseState({ batchId: 'other-batch' })
    await writeCheckpointAtomic(root, incompatible)
    // next/previous 都有兼容内容，但 current 结构合法却不兼容 → 不得回退。
    fs.copyFileSync(path.join(root, CHECKPOINT_FILE), path.join(root, CHECKPOINT_NEXT_FILE))
    const previous = baseState({ status: 'running' })
    fs.writeFileSync(path.join(root, CHECKPOINT_PREVIOUS_FILE), JSON.stringify(previous, null, 2))
    assert.throws(() => loadCheckpointCandidates(root, compatible), (e) => e.code === 'CHECKPOINT_INCOMPATIBLE')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('恢复：候选全部损坏 → CHECKPOINT_INVALID', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-recover-allbad-'))
  try {
    fs.writeFileSync(path.join(root, CHECKPOINT_FILE), '{bad')
    fs.writeFileSync(path.join(root, CHECKPOINT_NEXT_FILE), 'not-json')
    fs.writeFileSync(path.join(root, CHECKPOINT_PREVIOUS_FILE), '{bad too')
    assert.throws(() => loadCheckpointCandidates(root, compatible), (e) => e.code === 'CHECKPOINT_INVALID')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('恢复：promote 后有效 previous 不被损坏 current 覆盖', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-recover-promote-'))
  try {
    // 第一次写入后，第二次写入使 previous 保留第一次内容。
    await writeCheckpointAtomic(root, baseState({ status: 'running' }))
    await writeCheckpointAtomic(root, baseState({ status: 'succeeded' }))
    const previous = JSON.parse(fs.readFileSync(path.join(root, CHECKPOINT_PREVIOUS_FILE), 'utf8'))
    assert.equal(previous.status, 'running')
    // current 损坏，从 previous 恢复。
    fs.writeFileSync(path.join(root, CHECKPOINT_FILE), 'corrupted')
    const rec = loadCheckpointCandidates(root, compatible)
    assert.equal(rec.source, 'checkpoint.previous')
    // 提升恢复状态时 previous 应保留有效内容，不被损坏 current 覆盖。
    await promoteRecoveredCheckpoint(root, rec.state, { source: rec.source })
    const kept = JSON.parse(fs.readFileSync(path.join(root, CHECKPOINT_PREVIOUS_FILE), 'utf8'))
    assert.equal(kept.status, 'running', '有效 previous 不应被损坏 current 覆盖')
    const current = JSON.parse(fs.readFileSync(path.join(root, CHECKPOINT_FILE), 'utf8'))
    assert.equal(current.status, 'running')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('promoteRecoveredCheckpoint 验证 source 枚举', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-promote-enum-'))
  try {
    await assert.rejects(
      () => promoteRecoveredCheckpoint(root, baseState(), { source: 'checkpoint' }),
      (e) => e.code === 'CHECKPOINT_INVALID' && /恢复来源/.test(e.message),
    )
    await assert.rejects(
      () => promoteRecoveredCheckpoint(root, baseState(), { source: 'bogus' }),
      (e) => e.code === 'CHECKPOINT_INVALID',
    )
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('候选文件全部不存在 → CHECKPOINT_INVALID（message 注明无候选文件）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-recover-none-'))
  try {
    assert.throws(() => loadCheckpointCandidates(root, compatible), (e) => e.code === 'CHECKPOINT_INVALID' && /无检查点候选文件/.test(e.message))
    assert.equal(hasAnyCheckpointFile(root), false)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('promotion rename 失败：next 唯一有效源仍存在且可再次恢复', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-promote-fail-'))
  try {
    await writeCheckpointAtomic(root, baseState({ status: 'running' }))
    fs.copyFileSync(path.join(root, CHECKPOINT_FILE), path.join(root, CHECKPOINT_NEXT_FILE))
    fs.writeFileSync(path.join(root, CHECKPOINT_FILE), 'corrupted') // current 损坏，next 唯一有效
    const rec = loadCheckpointCandidates(root, compatible)
    assert.equal(rec.source, 'checkpoint.next')
    // 注入 rename 失败。
    await assert.rejects(
      () => promoteRecoveredCheckpoint(root, rec.state, { source: rec.source, operations: { rename: () => { throw new Error('rename boom') } } }),
      (e) => e.code === 'CHECKPOINT_IO' && /rename boom/.test(e.message),
    )
    // 恢复源 next 未被破坏，recovery 临时文件被尽力清理。
    assert.ok(fs.existsSync(path.join(root, CHECKPOINT_NEXT_FILE)), 'promotion 失败后 next 必须仍存在')
    assert.equal(fs.existsSync(path.join(root, CHECKPOINT_RECOVERY_FILE)), false)
    // 仍可再次恢复。
    const again = loadCheckpointCandidates(root, compatible)
    assert.equal(again.source, 'checkpoint.next')
    // 二次 promotion 成功。
    await promoteRecoveredCheckpoint(root, again.state, { source: again.source })
    assert.ok(fs.existsSync(path.join(root, CHECKPOINT_FILE)))
    assert.equal(fs.existsSync(path.join(root, CHECKPOINT_NEXT_FILE)), false, '成功 promotion 后 stale next 清理')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('promotion 成功：current 落盘、next 清理、previous 始终保留', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-promote-ok-'))
  try {
    // previous 来源：两次写入使 previous 保留第一次内容，再损坏 current。
    await writeCheckpointAtomic(root, baseState({ status: 'running' }))
    await writeCheckpointAtomic(root, baseState({ status: 'succeeded' }))
    fs.writeFileSync(path.join(root, CHECKPOINT_NEXT_FILE), '{bad') // next 损坏
    fs.writeFileSync(path.join(root, CHECKPOINT_FILE), 'corrupted') // current 损坏
    const rec = loadCheckpointCandidates(root, compatible)
    assert.equal(rec.source, 'checkpoint.previous')
    await promoteRecoveredCheckpoint(root, rec.state, { source: rec.source })
    assert.ok(fs.existsSync(path.join(root, CHECKPOINT_FILE)), '成功 promotion 后 current 存在')
    assert.equal(fs.existsSync(path.join(root, CHECKPOINT_NEXT_FILE)), false, 'stale next 清理')
    assert.ok(fs.existsSync(path.join(root, CHECKPOINT_PREVIOUS_FILE)), 'previous 始终保留')
    const current = JSON.parse(fs.readFileSync(path.join(root, CHECKPOINT_FILE), 'utf8'))
    assert.equal(current.status, 'running')
    // recovery 临时文件不残留。
    assert.equal(fs.existsSync(path.join(root, CHECKPOINT_RECOVERY_FILE)), false)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('next 优先：current running + next succeeded 均兼容 → 选 next', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-next-pref-'))
  try {
    await writeCheckpointAtomic(root, baseState({ status: 'running' }))
    // 模拟 fsync 后 rename 前崩溃：next 比 current 进度新。
    fs.writeFileSync(path.join(root, CHECKPOINT_NEXT_FILE), JSON.stringify(baseState({ status: 'succeeded' }), null, 2))
    const rec = loadCheckpointCandidates(root, compatible)
    assert.equal(rec.source, 'checkpoint.next')
    assert.equal(rec.state.status, 'succeeded')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('next 优先：current 兼容 + next 损坏 → 选 current（stale next 不阻断）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-next-bad-'))
  try {
    await writeCheckpointAtomic(root, baseState({ status: 'succeeded' }))
    fs.writeFileSync(path.join(root, CHECKPOINT_NEXT_FILE), '{bad') // next 损坏
    const rec = loadCheckpointCandidates(root, compatible)
    assert.equal(rec.source, 'checkpoint')
    assert.equal(rec.state.status, 'succeeded')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('next 优先：current 兼容 + next 不兼容 → 选 current', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-next-incompat-'))
  try {
    await writeCheckpointAtomic(root, baseState({ status: 'succeeded' }))
    // next 是另一个批次的合法 checkpoint（结构合法但不兼容）。
    fs.writeFileSync(path.join(root, CHECKPOINT_NEXT_FILE), JSON.stringify(baseState({ batchId: 'other-batch', status: 'succeeded' }), null, 2))
    const rec = loadCheckpointCandidates(root, compatible)
    assert.equal(rec.source, 'checkpoint')
    assert.equal(rec.state.status, 'succeeded')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('next 优先：current 合法但不兼容 + next 兼容 → 立即 INCOMPATIBLE 不回退', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-cur-incompat-next-'))
  try {
    // current 是另一个批次的合法 checkpoint；next 兼容但绝不回退。
    fs.writeFileSync(path.join(root, CHECKPOINT_FILE), JSON.stringify(baseState({ batchId: 'other-batch', status: 'running' }), null, 2))
    fs.writeFileSync(path.join(root, CHECKPOINT_NEXT_FILE), JSON.stringify(baseState({ status: 'succeeded' }), null, 2))
    assert.throws(() => loadCheckpointCandidates(root, compatible), (e) => e.code === 'CHECKPOINT_INCOMPATIBLE')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('恢复：current 存在但读取发生 I/O 错误 → 保留 CHECKPOINT_IO，不回退 previous', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-current-io-'))
  try {
    // 用目录占据 checkpoint.json 路径，readFileSync 会产生 EISDIR/读取错误。
    fs.mkdirSync(path.join(root, CHECKPOINT_FILE))
    fs.writeFileSync(path.join(root, CHECKPOINT_PREVIOUS_FILE), JSON.stringify(baseState({ status: 'succeeded' }), null, 2))
    assert.throws(
      () => loadCheckpointCandidates(root, compatible),
      (e) => e.code === 'CHECKPOINT_IO',
    )
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('恢复：current 合法但 next 读取发生 I/O 错误 → 保留 CHECKPOINT_IO，不使用旧 current', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-next-io-'))
  try {
    await writeCheckpointAtomic(root, baseState({ status: 'running' }))
    fs.mkdirSync(path.join(root, CHECKPOINT_NEXT_FILE))
    assert.throws(
      () => loadCheckpointCandidates(root, compatible),
      (e) => e.code === 'CHECKPOINT_IO',
    )
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('恢复：checkpoint root 是文件而非目录 → 保留 CHECKPOINT_IO，不误报不存在', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-stat-io-'))
  const notDirectory = path.join(root, 'not-a-directory')
  try {
    fs.writeFileSync(notDirectory, 'file')
    assert.throws(
      () => hasAnyCheckpointFile(notDirectory),
      (e) => e.code === 'CHECKPOINT_IO',
    )
    assert.throws(
      () => loadCheckpointCandidates(notDirectory, compatible),
      (e) => e.code === 'CHECKPOINT_IO',
    )
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

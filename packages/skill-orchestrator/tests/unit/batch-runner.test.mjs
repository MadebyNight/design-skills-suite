import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { runBatch, BatchRunnerError } from '../../runtime/batch-runner.mjs'
import { loadCheckpoint } from '../../runtime/checkpoint.mjs'
import { loadBatchRequest } from '../../runtime/batch-request.mjs'
import { fingerprint } from '../../runtime/fingerprint.mjs'
import { assemblePage } from '../../../skill-alipay-pages/scripts/assemble.mjs'
import { validateOutput } from '../../../skill-alipay-pages/scripts/validate.mjs'

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8AAQv8BD/kD/YURmXYAAAAASUVORK5CYII='

const brief = {
  id: 'brief-1',
  goal: '首页',
  deliverableType: 'alipay.home',
  audience: '年轻用户',
  brandConstraints: [],
  contentRequirements: [],
  visualConstraints: [],
  outputSpec: { width: 375, height: 812, format: 'png' },
  inputArtifacts: [],
  researchPolicy: 'none',
  forbiddenChanges: [],
}
const assetPolicy = { default: { source: 'generate', requirement: 'required' }, rules: [] }
const providerIdentity = { id: 'openai-compatible', model: 'gpt-image-2', baseURL: 'https://api.example.com/v1' }
const sourceCommit = 'abc123'

function request(items) {
  return { schemaVersion: '1', batchId: 'batch-1', items }
}
function item(id) {
  return { itemId: id, brief: { ...brief, id: `brief-${id}` }, assetPolicy }
}

function okOrchestration() {
  return { briefId: 'b', status: 'succeeded', selectedCapabilities: ['workflow.orchestrate'], steps: [], deliverable: { packageRoot: '.', designBriefId: 'b', files: [], sourceCommit: 'x' } }
}

/**
 * mock 成功 runItem：为终态发布层落盘最小合法 attempt 产物
 * （prototype.html + 配置 JSON，发布合同要求成功页面二者齐备；
 * 配置文件名按 brief.deliverableType 决定）。
 */
function minimalAttemptFiles(attemptRoot, itemId, deliverableType = 'alipay.home') {
  fs.mkdirSync(attemptRoot, { recursive: true })
  fs.writeFileSync(path.join(attemptRoot, 'prototype.html'), '<!doctype html><html lang="zh"><body>mock page</body></html>')
  const configName = deliverableType === 'alipay.landing' ? 'landing-config.json' : 'home-config.json'
  fs.writeFileSync(path.join(attemptRoot, configName), JSON.stringify({ page: { name: `mock-${itemId}` } }))
}

const succeedAttempt = async ({ item, attemptRoot }) => {
  minimalAttemptFiles(attemptRoot, item.itemId, item.brief?.deliverableType)
  return okOrchestration()
}

/**
 * 模拟「required 素材失败，但页面已生成带诊断占位、可审阅原型」的编排结果：
 * status=failed，deliverable 的 files 含实际落盘的 prototype.html。
 */
function failedOrchestrationWithPrototype(batchRoot, attemptRoot) {
  return {
    briefId: 'b',
    status: 'failed',
    selectedCapabilities: ['workflow.orchestrate'],
    steps: [{ name: 'image-generate', status: 'failed', details: 'required 素材生成失败' }],
    deliverable: {
      packageRoot: attemptRoot,
      designBriefId: 'b',
      files: [{ path: 'prototype.html', kind: 'prototype.html', sha256: 'a'.repeat(64) }],
      sourceCommit: 'x',
    },
  }
}

/**
 * 「素材失败但页面已完成并带诊断占位」的完整证据链 attempt 落盘：
 *  1. 受控组装器落盘 prototype.html（含 styles/assets 依赖）+ passed=true 的
 *     validation-report.json（诊断占位原型本身满足受控校验）；
 *  2. 手写登记非空 pendingAssetRequests 的 asset-manifest.json（素材失败状态
 *     签名——真实链路由 designLanding 产出「素材失败槽位 pending」的同等结构）。
 * 三条证据与 batch-runner isReviewableDiagnosticFailure 对齐。
 */
function makeReviewableDiagnosticAttempt(attemptRoot) {
  assemblePage({ pageType: 'landing', outputRoot: attemptRoot }); fs.writeFileSync(path.join(attemptRoot, 'landing-config.json'), JSON.stringify({ page: { name: 'mock-landing' } }))
  // 诊断占位原型本身通过受控校验：落盘 passed=true 的 validation-report.json
  //（真实链路由 designLanding 的 validateOutput 产出同等签名）。
  validateOutput({ outputRoot: attemptRoot, pageType: 'landing' })
  fs.writeFileSync(path.join(attemptRoot, 'asset-manifest.json'), JSON.stringify({
    pendingAssetRequests: [{ id: 'landing.default.hero.image', usageSlot: 'landing.default.hero.image', status: 'pending' }],
  }, null, 2) + '\n')
}

function makeAsset(attemptRoot, key) {
  const filePath = path.join(attemptRoot, `${key}.png`)
  const bytes = Buffer.from(PNG_BASE64, 'base64')
  fs.writeFileSync(filePath, bytes)
  return {
    assetRequestId: key,
    artifactId: key,
    path: filePath,
    mimeType: 'image/png',
    width: 2,
    height: 1,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    sourceSkill: 'test',
    sourceSkillVersion: '1.0.0',
    strictSizeSatisfied: true,
    notes: [],
  }
}

test('run：两 item 成功 → BatchResult succeeded', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-run-ok-'))
  try {
    const result = await runBatch({
      mode: 'run',
      batchRequest: request([item('a'), item('b')]),
      batchRoot: root,
      sourceCommit,
      providerIdentity,
      runItem: succeedAttempt,
    })
    assert.equal(result.status, 'succeeded')
    assert.equal(result.summary.total, 2)
    assert.equal(result.summary.succeeded, 2)
    assert.equal(result.summary.failed, 0)
    assert.ok(result.items.every((i) => i.status === 'succeeded'))
    assert.ok(fs.existsSync(path.join(root, 'other', 'runtime', 'request.json')))
    assert.ok(fs.existsSync(path.join(root, 'other', 'runtime', 'result.json')))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('run：第一失败第二继续 → partially_failed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-run-partial-'))
  const calls = []
  try {
    const result = await runBatch({
      mode: 'run',
      batchRequest: request([item('a'), item('b')]),
      batchRoot: root,
      sourceCommit,
      providerIdentity,
      runItem: async ({ item, attemptRoot }) => {
        calls.push(item.itemId)
        if (item.itemId === 'a') throw new Error('boom')
        minimalAttemptFiles(attemptRoot, item.itemId)
        return okOrchestration()
      },
    })
    assert.equal(result.status, 'partially_failed')
    assert.equal(result.summary.succeeded, 1)
    assert.equal(result.summary.failed, 1)
    assert.deepEqual(calls, ['a', 'b'], '第一失败后第二继续')
    const a = result.items.find((i) => i.itemId === 'a')
    assert.equal(a.status, 'failed')
    assert.equal(a.error.code, 'BATCH_ITEM_ERROR')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('run：已存在输出抛 BATCH_OUTPUT_EXISTS', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-run-exists-'))
  try {
    // 顶层非空即拒绝（运行时状态位于 other/runtime/ 之下）。
    fs.mkdirSync(path.join(root, 'other', 'runtime'), { recursive: true })
    fs.writeFileSync(path.join(root, 'other', 'runtime', 'checkpoint.json'), '{}')
    await assert.rejects(
      () => runBatch({ mode: 'run', batchRequest: request([item('a')]), batchRoot: root, sourceCommit, providerIdentity, runItem: succeedAttempt }),
      (e) => e.code === 'BATCH_OUTPUT_EXISTS',
    )
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('run：空目录允许', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-run-empty-'))
  try {
    const result = await runBatch({ mode: 'run', batchRequest: request([item('a')]), batchRoot: root, sourceCommit, providerIdentity, runItem: succeedAttempt })
    assert.equal(result.status, 'succeeded')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('resume：只执行 pending/interrupted，succeeded 不重跑', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-resume-'))
  const calls = []
  try {
    await runBatch({ mode: 'run', batchRequest: request([item('a'), item('b')]), batchRoot: root, sourceCommit, providerIdentity, runItem: async ({ item, attemptRoot }) => { calls.push(item.itemId); minimalAttemptFiles(attemptRoot, item.itemId, item.brief?.deliverableType); return okOrchestration() } })
    // 预写：a 成功，b 置为 interrupted（模拟中断）。
    const ck = loadCheckpoint(path.join(root, 'other', 'runtime'))
    ck.items = ck.items.map((i) => (i.itemId === 'b' ? { ...i, status: 'interrupted' } : i))
    fs.writeFileSync(path.join(root, 'other', 'runtime', 'checkpoint.json'), JSON.stringify(ck, null, 2))
    calls.length = 0
    const result = await runBatch({ mode: 'resume', batchRoot: root, sourceCommit, providerIdentity, runItem: async ({ item, attemptRoot }) => { calls.push(item.itemId); minimalAttemptFiles(attemptRoot, item.itemId, item.brief?.deliverableType); return okOrchestration() } })
    assert.deepEqual(calls, ['b'], 'resume 只重跑 interrupted')
    assert.equal(result.status, 'succeeded')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('retry-failed：只执行 failed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-retry-'))
  const calls = []
  try {
    await runBatch({ mode: 'run', batchRequest: request([item('a'), item('b')]), batchRoot: root, sourceCommit, providerIdentity, runItem: async ({ item, attemptRoot }) => { if (item.itemId === 'a') throw new Error('boom'); minimalAttemptFiles(attemptRoot, item.itemId, item.brief?.deliverableType); return okOrchestration() } })
    calls.length = 0
    const result = await runBatch({ mode: 'retry-failed', batchRoot: root, sourceCommit, providerIdentity, runItem: async ({ item, attemptRoot }) => { calls.push(item.itemId); minimalAttemptFiles(attemptRoot, item.itemId, item.brief?.deliverableType); return okOrchestration() } })
    assert.deepEqual(calls, ['a'], 'retry-failed 只重跑 failed')
    assert.equal(result.status, 'succeeded')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('resume：running item 归一化为 interrupted 后重跑', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-resume-running-'))
  const calls = []
  try {
    await runBatch({ mode: 'run', batchRequest: request([item('a')]), batchRoot: root, sourceCommit, providerIdentity, runItem: succeedAttempt })
    const ck = loadCheckpoint(path.join(root, 'other', 'runtime'))
    ck.items[0].status = 'running'
    fs.writeFileSync(path.join(root, 'other', 'runtime', 'checkpoint.json'), JSON.stringify(ck, null, 2))
    const result = await runBatch({ mode: 'resume', batchRoot: root, sourceCommit, providerIdentity, runItem: async ({ item, attemptRoot }) => { calls.push(item.itemId); minimalAttemptFiles(attemptRoot, item.itemId, item.brief?.deliverableType); return okOrchestration() } })
    assert.deepEqual(calls, ['a'])
    assert.equal(result.status, 'succeeded')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('resume：fingerprint 不匹配抛 CHECKPOINT_INCOMPATIBLE', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-resume-fp-'))
  try {
    await runBatch({ mode: 'run', batchRequest: request([item('a')]), batchRoot: root, sourceCommit, providerIdentity, runItem: succeedAttempt })
    // 篡改 request.json 使指纹变化。
    const req = loadBatchRequest(path.join(root, 'other', 'runtime', 'request.json'))
    req.items[0].brief.goal = '被篡改'
    fs.writeFileSync(path.join(root, 'other', 'runtime', 'request.json'), JSON.stringify(req, null, 2))
    await assert.rejects(
      () => runBatch({ mode: 'resume', batchRoot: root, sourceCommit, providerIdentity, runItem: succeedAttempt }),
      (e) => e.code === 'CHECKPOINT_INCOMPATIBLE',
    )
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('resume：provider 不匹配抛 CHECKPOINT_INCOMPATIBLE', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-resume-provider-'))
  try {
    await runBatch({ mode: 'run', batchRequest: request([item('a')]), batchRoot: root, sourceCommit, providerIdentity, runItem: succeedAttempt })
    await assert.rejects(
      () => runBatch({ mode: 'resume', batchRoot: root, sourceCommit, providerIdentity: { id: 'fal', model: 'x', baseURL: 'https://fal.example.com' }, runItem: succeedAttempt }),
      (e) => e.code === 'CHECKPOINT_INCOMPATIBLE',
    )
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('resume：sourceCommit 不匹配抛 CHECKPOINT_INCOMPATIBLE', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-resume-src-'))
  try {
    await runBatch({ mode: 'run', batchRequest: request([item('a')]), batchRoot: root, sourceCommit, providerIdentity, runItem: succeedAttempt })
    await assert.rejects(
      () => runBatch({ mode: 'resume', batchRoot: root, sourceCommit: 'other', providerIdentity, runItem: succeedAttempt }),
      (e) => e.code === 'CHECKPOINT_INCOMPATIBLE',
    )
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('attempt 递增：重跑使用新 attempt 目录', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-attempt-'))
  try {
    await runBatch({ mode: 'run', batchRequest: request([item('a')]), batchRoot: root, sourceCommit, providerIdentity, runItem: async () => { throw new Error('boom') } })
    const ck1 = loadCheckpoint(path.join(root, 'other', 'runtime'))
    assert.equal(ck1.items[0].attempt, 1)
    await runBatch({ mode: 'retry-failed', batchRoot: root, sourceCommit, providerIdentity, runItem: succeedAttempt })
    const ck2 = loadCheckpoint(path.join(root, 'other', 'runtime'))
    assert.equal(ck2.items[0].attempt, 2)
    assert.ok(fs.existsSync(path.join(root, 'other', 'runtime', 'items', 'a', 'attempts', '0001')))
    assert.ok(fs.existsSync(path.join(root, 'other', 'runtime', 'items', 'a', 'attempts', '0002')))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('17 槽素材级：put 若干后抛，resume 用同 store.get 命中已成功 key 不重新 provider', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-cache-17-'))
  const keys = Array.from({ length: 17 }, (_, i) => `slot-${i}`)
  let providerCalls = 0
  const runItem = async ({ item, attemptRoot, assetStore }) => {
    // 第一次：put 前 10 个后抛；第二次：get 验证前 10 个命中，再 put 后 7 个。
    const existing = []
    for (const key of keys) {
      const got = await assetStore.get(key, { request: { id: key, targetWidth: 2, targetHeight: 1, format: 'png' } })
      if (got) existing.push(key)
    }
    if (existing.length === 0) {
      for (let i = 0; i < 10; i++) {
        providerCalls++
        await assetStore.put(keys[i], makeAsset(attemptRoot, keys[i]), { request: { id: keys[i], targetWidth: 2, targetHeight: 1, format: 'png' } })
      }
      throw new Error('interrupted mid-batch')
    }
    // resume：前 10 个已成功，不应再 provider。
    assert.equal(existing.length, 10)
    for (let i = 10; i < 17; i++) {
      providerCalls++
      await assetStore.put(keys[i], makeAsset(attemptRoot, keys[i]), { request: { id: keys[i], targetWidth: 2, targetHeight: 1, format: 'png' } })
    }
    minimalAttemptFiles(attemptRoot, item.itemId)
    return okOrchestration()
  }
  try {
    await runBatch({ mode: 'run', batchRequest: request([item('a')]), batchRoot: root, sourceCommit, providerIdentity, runItem })
    assert.equal(providerCalls, 10, '第一次 run 只 put 前 10 个')
    // 模拟进程中断：把 item 置为 running，resume 才会重跑。
    const ck = loadCheckpoint(path.join(root, 'other', 'runtime'))
    ck.items[0].status = 'running'
    fs.writeFileSync(path.join(root, 'other', 'runtime', 'checkpoint.json'), JSON.stringify(ck, null, 2))
    const result = await runBatch({ mode: 'resume', batchRoot: root, sourceCommit, providerIdentity, runItem })
    assert.equal(result.status, 'succeeded')
    assert.equal(providerCalls, 17, 'resume 后前 10 个已成功 key 不应重新 provider')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('unsupported item 映射为 failed 且 code BATCH_ITEM_UNSUPPORTED', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-unsupported-'))
  try {
    const result = await runBatch({
      mode: 'run',
      batchRequest: request([item('a')]),
      batchRoot: root,
      sourceCommit,
      providerIdentity,
      runItem: async () => ({ briefId: 'b', status: 'unsupported', selectedCapabilities: [], steps: [], deliverable: { packageRoot: '.', designBriefId: 'b', files: [], sourceCommit: 'x' } }),
    })
    assert.equal(result.status, 'failed')
    assert.equal(result.items[0].status, 'failed')
    assert.equal(result.items[0].error.code, 'BATCH_ITEM_UNSUPPORTED')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('resume：runItem 读取磁盘 checkpoint 确认 running 已持久化为 interrupted', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-resume-persist-'))
  try {
    await runBatch({ mode: 'run', batchRequest: request([item('a'), item('b')]), batchRoot: root, sourceCommit, providerIdentity, runItem: succeedAttempt })
    // 把 a、b 都置为 running，模拟中断。
    const ck = loadCheckpoint(path.join(root, 'other', 'runtime'))
    ck.items = ck.items.map((i) => ({ ...i, status: 'running' }))
    fs.writeFileSync(path.join(root, 'other', 'runtime', 'checkpoint.json'), JSON.stringify(ck, null, 2))
    let siblingStatus
    await runBatch({
      mode: 'resume',
      batchRoot: root,
      sourceCommit,
      providerIdentity,
      runItem: async ({ item, attemptRoot }) => {
        // 当 a 执行时，b 尚未被标记 running，应仍是归一化持久化的 interrupted。
        if (item.itemId === 'a') siblingStatus = loadCheckpoint(path.join(root, 'other', 'runtime')).items.find((i) => i.itemId === 'b').status
        minimalAttemptFiles(attemptRoot, item.itemId)
        return okOrchestration()
      },
    })
    assert.equal(siblingStatus, 'interrupted', 'resume 必须先持久化归一化状态')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('retry-failed：存在 pending/running/interrupted 抛 BATCH_RETRY_REQUIRES_RESUME', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-retry-requires-resume-'))
  try {
    await runBatch({ mode: 'run', batchRequest: request([item('a'), item('b')]), batchRoot: root, sourceCommit, providerIdentity, runItem: succeedAttempt })
    // 把 b 置为 interrupted，模拟未完成。
    const ck = loadCheckpoint(path.join(root, 'other', 'runtime'))
    ck.items[1].status = 'interrupted'
    fs.writeFileSync(path.join(root, 'other', 'runtime', 'checkpoint.json'), JSON.stringify(ck, null, 2))
    await assert.rejects(
      () => runBatch({ mode: 'retry-failed', batchRoot: root, sourceCommit, providerIdentity, runItem: succeedAttempt }),
      (e) => e.code === 'BATCH_RETRY_REQUIRES_RESUME' && /resume/.test(e.message),
    )
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('checkpoint 最终 status 与 BatchResult 同名', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-final-status-'))
  try {
    const result = await runBatch({ mode: 'run', batchRequest: request([item('a'), item('b')]), batchRoot: root, sourceCommit, providerIdentity, runItem: async ({ item, attemptRoot }) => { if (item.itemId === 'a') throw new Error('boom'); minimalAttemptFiles(attemptRoot, item.itemId, item.brief?.deliverableType); return okOrchestration() } })
    assert.equal(result.status, 'partially_failed')
    const ck = loadCheckpoint(path.join(root, 'other', 'runtime'))
    assert.equal(ck.status, 'partially_failed')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('resume 已完成批次：不重跑仍返回合法结果且 checkpoint 终态', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-resume-completed-'))
  const calls = []
  try {
    await runBatch({ mode: 'run', batchRequest: request([item('a'), item('b')]), batchRoot: root, sourceCommit, providerIdentity, runItem: async ({ item, attemptRoot }) => { calls.push(item.itemId); minimalAttemptFiles(attemptRoot, item.itemId, item.brief?.deliverableType); return okOrchestration() } })
    calls.length = 0
    const result = await runBatch({ mode: 'resume', batchRoot: root, sourceCommit, providerIdentity, runItem: async ({ item, attemptRoot }) => { calls.push(item.itemId); minimalAttemptFiles(attemptRoot, item.itemId, item.brief?.deliverableType); return okOrchestration() } })
    assert.deepEqual(calls, [], '已完成批次 resume 不应重跑')
    assert.equal(result.status, 'succeeded')
    assert.equal(loadCheckpoint(path.join(root, 'other', 'runtime')).status, 'succeeded')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('旧结构迁移：顶层与运行时根同名且内容等价 → 移除顶层副本，resume 正常', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-legacy-eq-'))
  const calls = []
  try {
    // 跑一个全部完成的批次，然后构造旧结构：把运行时状态复制回顶层
    //（复制而非移动 → 顶层与运行时根内容等价）。
    await runBatch({ mode: 'run', batchRequest: request([item('a')]), batchRoot: root, sourceCommit, providerIdentity, runItem: async ({ item, attemptRoot }) => { calls.push(item.itemId); minimalAttemptFiles(attemptRoot, item.itemId, item.brief?.deliverableType); return okOrchestration() } })
    const runtime = path.join(root, 'other', 'runtime')
    for (const name of ['request.json', 'checkpoint.json', 'result.json', 'items']) {
      fs.cpSync(path.join(runtime, name), path.join(root, name), { recursive: true })
    }
    calls.length = 0
    const result = await runBatch({ mode: 'resume', batchRoot: root, sourceCommit, providerIdentity, runItem: async ({ item, attemptRoot }) => { calls.push(item.itemId); minimalAttemptFiles(attemptRoot, item.itemId, item.brief?.deliverableType); return okOrchestration() } })
    assert.deepEqual(calls, [], '等价冲突消解后 resume 不重跑已完成 item')
    assert.equal(result.status, 'succeeded')
    // 顶层合同：等价旧副本已被移除，只剩四层。
    assert.deepEqual(
      fs.readdirSync(root).sort(),
      ['assets', 'configs', 'index.html', 'other'],
      '等价冲突：顶层旧副本被移除，顶层只有四项',
    )
    assert.ok(fs.existsSync(path.join(runtime, 'checkpoint.json')), '运行时根对象保留')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('旧结构迁移：顶层与运行时根同名但内容不等价 → 抛 BATCH_LEGACY_RUNTIME_CONFLICT 且两侧保留', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-legacy-conf-'))
  const calls = []
  try {
    // 跑一个批次（a 失败中断），然后构造旧结构：把运行时状态复制回顶层，
    // 并篡改顶层 checkpoint（不等价）。
    await runBatch({ mode: 'run', batchRequest: request([item('a')]), batchRoot: root, sourceCommit, providerIdentity, runItem: async () => { throw new Error('boom') } })
    const runtime = path.join(root, 'other', 'runtime')
    for (const name of ['request.json', 'checkpoint.json', 'result.json', 'items']) {
      fs.cpSync(path.join(runtime, name), path.join(root, name), { recursive: true })
    }
    const tampered = JSON.parse(fs.readFileSync(path.join(root, 'checkpoint.json'), 'utf8'))
    tampered.status = 'succeeded'
    fs.writeFileSync(path.join(root, 'checkpoint.json'), JSON.stringify(tampered, null, 2))

    await assert.rejects(
      () => runBatch({ mode: 'resume', batchRoot: root, sourceCommit, providerIdentity, runItem: async ({ item, attemptRoot }) => { calls.push(item.itemId); minimalAttemptFiles(attemptRoot, item.itemId, item.brief?.deliverableType); return okOrchestration() } }),
      (e) => e.code === 'BATCH_LEGACY_RUNTIME_CONFLICT' && /内容不一致/.test(e.message),
    )
    assert.deepEqual(calls, [], '冲突时不得执行任何 item')
    // 不覆盖/不猜测：两侧对象都原样保留，由使用者消除歧义。
    assert.ok(fs.existsSync(path.join(root, 'checkpoint.json')), '顶层不等价副本保留')
    assert.ok(fs.existsSync(path.join(runtime, 'checkpoint.json')), '运行时根对象保留')
    const runtimeCk = JSON.parse(fs.readFileSync(path.join(runtime, 'checkpoint.json'), 'utf8'))
    assert.notEqual(runtimeCk.status, 'succeeded', '运行时根对象未被顶层副本覆盖')
    // 消除歧义（删除顶层不等价副本）后 resume 可正常恢复（a 为 failed，resume 不重跑）。
    fs.rmSync(path.join(root, 'checkpoint.json'), { force: true })
    calls.length = 0
    const result = await runBatch({ mode: 'resume', batchRoot: root, sourceCommit, providerIdentity, runItem: async ({ item, attemptRoot }) => { calls.push(item.itemId); minimalAttemptFiles(attemptRoot, item.itemId, item.brief?.deliverableType); return okOrchestration() } })
    assert.deepEqual(calls, [], 'resume 不重跑 failed item')
    assert.equal(result.status, 'failed')
    assert.deepEqual(fs.readdirSync(root).sort(), ['assets', 'configs', 'index.html', 'other'], '顶层合同恢复')
    // retry-failed 继续重跑 failed item 并修复。
    calls.length = 0
    const retried = await runBatch({ mode: 'retry-failed', batchRoot: root, sourceCommit, providerIdentity, runItem: async ({ item, attemptRoot }) => { calls.push(item.itemId); minimalAttemptFiles(attemptRoot, item.itemId, item.brief?.deliverableType); return okOrchestration() } })
    assert.deepEqual(calls, ['a'], 'retry-failed 重跑 failed item')
    assert.equal(retried.status, 'succeeded')
    assert.deepEqual(fs.readdirSync(root).sort(), ['assets', 'configs', 'index.html', 'other'], '顶层合同恢复')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('resume：current 损坏但 previous 完整 → 从 previous 恢复并正常持久化 current', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-recover-resume-'))
  const calls = []
  try {
    await runBatch({ mode: 'run', batchRequest: request([item('a')]), batchRoot: root, sourceCommit, providerIdentity, runItem: succeedAttempt })
    // 损坏 current（previous 保留合法内容）。
    fs.writeFileSync(path.join(root, 'other', 'runtime', 'checkpoint.json'), 'corrupted')
    const result = await runBatch({ mode: 'resume', batchRoot: root, sourceCommit, providerIdentity, runItem: async ({ item, attemptRoot }) => { calls.push(item.itemId); minimalAttemptFiles(attemptRoot, item.itemId, item.brief?.deliverableType); return okOrchestration() } })
    assert.deepEqual(calls, [], 'previous 记录已完成，resume 不应重跑')
    assert.equal(result.status, 'succeeded')
    // 恢复后 current 被正常持久化（可再次 loadCheckpoint 读取）。
    const ck = loadCheckpoint(path.join(root, 'other', 'runtime'))
    assert.equal(ck.status, 'succeeded')
    assert.equal(ck.items[0].status, 'succeeded')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('resume：current 缺失但 next/previous 损坏 → CHECKPOINT_INVALID 而非 missing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-recover-invalid-'))
  try {
    await runBatch({ mode: 'run', batchRequest: request([item('a')]), batchRoot: root, sourceCommit, providerIdentity, runItem: succeedAttempt })
    fs.rmSync(path.join(root, 'other', 'runtime', 'checkpoint.json')) // current 缺失
    fs.writeFileSync(path.join(root, 'other', 'runtime', 'checkpoint.next.json'), '{bad') // next 损坏
    fs.writeFileSync(path.join(root, 'other', 'runtime', 'checkpoint.previous.json'), '{bad too') // previous 损坏
    await assert.rejects(
      () => runBatch({ mode: 'resume', batchRoot: root, sourceCommit, providerIdentity, runItem: succeedAttempt }),
      (e) => e.code === 'CHECKPOINT_INVALID',
    )
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('resume：current/next/previous 全部缺失 → BATCH_CHECKPOINT_MISSING', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-recover-missing-'))
  try {
    await runBatch({ mode: 'run', batchRequest: request([item('a')]), batchRoot: root, sourceCommit, providerIdentity, runItem: succeedAttempt })
    fs.rmSync(path.join(root, 'other', 'runtime', 'checkpoint.json'))
    fs.rmSync(path.join(root, 'other', 'runtime', 'checkpoint.previous.json'))
    await assert.rejects(
      () => runBatch({ mode: 'resume', batchRoot: root, sourceCommit, providerIdentity, runItem: succeedAttempt }),
      (e) => e.code === 'BATCH_CHECKPOINT_MISSING',
    )
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('resume：current 与 next 并存（next 更新）→ 使用 next，不重跑 next 已完成 item', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-next-pref-'))
  const calls = []
  try {
    await runBatch({ mode: 'run', batchRequest: request([item('a'), item('b')]), batchRoot: root, sourceCommit, providerIdentity, runItem: async ({ item, attemptRoot }) => { calls.push(item.itemId); if (item.itemId === 'b') throw new Error('interrupted'); minimalAttemptFiles(attemptRoot, item.itemId, item.brief?.deliverableType); return okOrchestration() } })
    // 模拟 fsync 后 rename 前崩溃：current=失败终态（旧），next=a succeeded + b running（新）。
    const next = loadCheckpoint(path.join(root, 'other', 'runtime'))
    next.items = next.items.map((i) => (i.itemId === 'a' ? { ...i, status: 'succeeded' } : { ...i, status: 'running' }))
    next.status = 'running'
    fs.writeFileSync(path.join(root, 'other', 'runtime', 'checkpoint.next.json'), JSON.stringify(next, null, 2))
    calls.length = 0
    const result = await runBatch({ mode: 'resume', batchRoot: root, sourceCommit, providerIdentity, runItem: async ({ item, attemptRoot }) => { calls.push(item.itemId); minimalAttemptFiles(attemptRoot, item.itemId, item.brief?.deliverableType); return okOrchestration() } })
    assert.deepEqual(calls, ['b'], '只重跑 next 中 interrupted 的 b，a 不重跑')
    assert.equal(result.status, 'succeeded')
    const ck = loadCheckpoint(path.join(root, 'other', 'runtime'))
    assert.equal(ck.items[0].status, 'succeeded')
    assert.equal(ck.items[1].status, 'succeeded')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

// ---- 页面联动（pageLinkage）执行流程 ----

const landingBrief = { ...brief, id: 'brief-land-1', deliverableType: 'alipay.landing' }
const homeBriefLinkage = { ...brief, id: 'brief-home-link' }
const assetPolicyLinkage = { default: { source: 'generate', requirement: 'required' }, rules: [] }

function linkageRequest(over = {}) {
  return {
    schemaVersion: '1',
    batchId: 'batch-link-1',
    pageLinkage: {
      homeTheme: '夏日出游租赁',
      landingThemes: [{ theme: '夏日出游租赁' }, { theme: '演唱会租赁' }],
    },
    items: [
      { itemId: 'item.home', brief: homeBriefLinkage, assetPolicy: assetPolicyLinkage },
      { itemId: 'item.land.1', brief: landingBrief, assetPolicy: assetPolicyLinkage },
      { itemId: 'item.land.2', brief: { ...landingBrief, id: 'brief-land-2' }, assetPolicy: assetPolicyLinkage },
    ],
    ...over,
  }
}

test('联动批次：landing 优先执行（按 landingKey 稳定），home 最后', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-link-order-'))
  const calls = []
  try {
    const result = await runBatch({
      mode: 'run',
      batchRequest: linkageRequest(),
      batchRoot: root,
      sourceCommit,
      providerIdentity,
      runItem: async ({ item, attemptRoot }) => { calls.push(item.itemId); minimalAttemptFiles(attemptRoot, item.itemId, item.brief?.deliverableType); return okOrchestration() },
    })
    assert.equal(result.status, 'succeeded')
    assert.deepEqual(calls, ['item.land.1', 'item.land.2', 'item.home'], 'landing 先执行，home 最后')
    // checkpoint.item 顺序与执行顺序一致（落盘顺序确定性）。
    const ck = loadCheckpoint(path.join(root, 'other', 'runtime'))
    assert.deepEqual(ck.items.map((i) => i.itemId), ['item.land.1', 'item.land.2', 'item.home'])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('联动批次：runItem 收到 landing/home 联动上下文，home 拿到成功 landing 的相对预览 ref', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-link-ctx-'))
  const seen = []
  try {
    const result = await runBatch({
      mode: 'run',
      batchRequest: linkageRequest(),
      batchRoot: root,
      sourceCommit,
      providerIdentity,
      runItem: async ({ item, linkage, attemptRoot }) => {
        seen.push({ itemId: item.itemId, linkage })
        // 成功 landing 用受控组装器真实落盘原型 + styles/assets 依赖。
        if (item.brief.deliverableType === 'alipay.landing') {
          assemblePage({ pageType: 'landing', outputRoot: attemptRoot }); fs.writeFileSync(path.join(attemptRoot, 'landing-config.json'), JSON.stringify({ page: { name: 'mock-landing' } }))
          const prototypePath = path.join(attemptRoot, 'prototype.html')
          const prototype = fs.readFileSync(prototypePath, 'utf8').replace('</head>', '<link rel="stylesheet" href="styles/theme.css">\n</head>')
          fs.writeFileSync(prototypePath, prototype)
          fs.writeFileSync(path.join(attemptRoot, 'styles', 'theme.css'), '.lp-page { background: url("../assets/page-background.png") center / cover; }\n')
          fs.writeFileSync(path.join(attemptRoot, 'assets', 'page-background.png'), 'page-background-bytes')
        } else {
          minimalAttemptFiles(attemptRoot, item.itemId, item.brief?.deliverableType)
        }
        return okOrchestration()
      },
    })
    assert.equal(result.status, 'succeeded')
    const land1 = seen.find((s) => s.itemId === 'item.land.1')
    const land2 = seen.find((s) => s.itemId === 'item.land.2')
    const home = seen.find((s) => s.itemId === 'item.home')
    assert.deepEqual(land1.linkage, { role: 'landing', landingKey: 'landing-01', theme: '夏日出游租赁' })
    assert.deepEqual(land2.linkage, { role: 'landing', landingKey: 'landing-02', theme: '演唱会租赁' })
    assert.equal(home.linkage.role, 'home')
    assert.equal(home.linkage.homeTheme, '夏日出游租赁')
    assert.deepEqual(
      home.linkage.landingThemes,
      [
        { landingKey: 'landing-01', theme: '夏日出游租赁', source: 'orchestrator', landingPreviewRef: 'landing-01/prototype.html' },
        { landingKey: 'landing-02', theme: '演唱会租赁', source: 'orchestrator', landingPreviewRef: 'landing-02/prototype.html' },
      ],
      'home 必须拿到成功 landing 的首页相对预览 ref（与 home CLI 接口对齐）',
    )
    // 可关联落地页原型必须发布为完整离线预览目录（styles/assets 依赖齐备），
    // 否则首页预览链接会解析失败。
    for (const landingKey of ['landing-01', 'landing-02']) {
      assert.ok(fs.existsSync(path.join(root, 'other', 'runtime', 'items', 'item.home', 'attempts', '0001', landingKey, 'prototype.html')))
      for (const style of ['tokens.css', 'base.css', 'landing.css']) {
        assert.ok(fs.existsSync(path.join(root, 'other', 'runtime', 'items', 'item.home', 'attempts', '0001', landingKey, 'styles', style)), `发布目录缺少样式依赖：${landingKey}/styles/${style}`)
      }
      assert.ok(fs.existsSync(path.join(root, 'other', 'runtime', 'items', 'item.home', 'attempts', '0001', landingKey, 'assets', 'page-background.png')), `发布目录缺少 CSS 背景依赖：${landingKey}/assets/page-background.png`)
      assert.ok(fs.readdirSync(path.join(root, 'other', 'runtime', 'items', 'item.home', 'attempts', '0001', landingKey, 'assets')).length > 0, `发布目录缺少图片依赖：${landingKey}/assets/`)
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('联动批次：部分 landing 失败不阻断首页，失效关联不写入且记 warnings', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-link-partial-'))
  const seen = []
  try {
    const result = await runBatch({
      mode: 'run',
      batchRequest: linkageRequest(),
      batchRoot: root,
      sourceCommit,
      providerIdentity,
      runItem: async ({ item, attemptRoot, linkage }) => {
        seen.push({ itemId: item.itemId, linkage })
        if (item.itemId === 'item.land.2') throw new Error('landing boom')
        // land.1 成功：用受控组装器落盘完整原型 + 依赖。
        if (item.brief.deliverableType === 'alipay.landing') {
          assemblePage({ pageType: 'landing', outputRoot: attemptRoot }); fs.writeFileSync(path.join(attemptRoot, 'landing-config.json'), JSON.stringify({ page: { name: 'mock-landing' } }))
        } else {
          minimalAttemptFiles(attemptRoot, item.itemId, item.brief?.deliverableType)
        }
        return okOrchestration()
      },
    })
    // 失败 landing 只影响自身状态；首页仍执行且批次 partially_failed。
    assert.equal(result.status, 'partially_failed')
    const home = seen.find((s) => s.itemId === 'item.home')
    assert.ok(home, '首页仍被执行（失败不阻断）')
    assert.deepEqual(
      home.linkage.landingThemes,
      [
        { landingKey: 'landing-01', theme: '夏日出游租赁', source: 'orchestrator', landingPreviewRef: 'landing-01/prototype.html' },
        { landingKey: 'landing-02', theme: '演唱会租赁', source: 'orchestrator' },
      ],
      '失败 landing 无 landingPreviewRef（失效关联不写入）',
    )
    // checkpoint.final linkage 摘要含警告。
    const ck = loadCheckpoint(path.join(root, 'other', 'runtime'))
    assert.equal(ck.linkage.homeTheme, '夏日出游租赁')
    assert.ok(ck.linkage.warnings.some((w) => w.includes('landing-02')), 'warnings 必须记录失败 landing')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('联动批次：素材失败但已生成可审阅原型的 landing → 以 failed+reviewable 关联首页，批次仍部分失败', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-link-reviewable-'))
  const seen = []
  try {
    const result = await runBatch({
      mode: 'run',
      batchRequest: linkageRequest(),
      batchRoot: root,
      sourceCommit,
      providerIdentity,
      runItem: async ({ item, attemptRoot, linkage }) => {
        if (item.itemId === 'item.land.2') {
          // 完整证据链 attempt：素材失败（steps 记录、asset-manifest 有 pending
          // 槽位）但页面已完成（受控校验通过的诊断占位原型）。
          makeReviewableDiagnosticAttempt(attemptRoot)
          return failedOrchestrationWithPrototype(root, attemptRoot)
        }
        seen.push({ itemId: item.itemId, linkage })
        minimalAttemptFiles(attemptRoot, item.itemId, item.brief?.deliverableType)
        return okOrchestration()
      },
    })
    // 落地页失败状态语义保持：item failed、批次 partially_failed。
    assert.equal(result.status, 'partially_failed')
    assert.equal(result.items.find((i) => i.itemId === 'item.land.2').status, 'failed')
    assert.equal(result.items.find((i) => i.itemId === 'item.land.2').error.code, 'BATCH_ITEM_FAILED')
    // 首页拿到可审阅失败落地页的 prototype.html 预览 ref。
    const home = seen.find((s) => s.itemId === 'item.home')
    assert.ok(home, '首页仍被执行')
    const failedTheme = home.linkage.landingThemes.find((t) => t.landingKey === 'landing-02')
    assert.equal(
      failedTheme.landingPreviewRef,
      'landing-02/prototype.html',
      '素材失败但可审阅的 landing 必须以 prototype.html 关联首页（首页相对路径）',
    )
    assert.equal(fs.existsSync(path.join(root, 'other', 'runtime', 'items', 'item.land.2', 'attempts', '0001', 'prototype.html')), true)
    // 原型必须发布到首页交付目录，首页预览链接才可离线解析。
    assert.equal(fs.existsSync(path.join(root, 'other', 'runtime', 'items', 'item.home', 'attempts', '0001', 'landing-02', 'prototype.html')), true)
    // checkpoint linkage 摘要同步登记该 ref（终态可审计）。
    const ck = loadCheckpoint(path.join(root, 'other', 'runtime'))
    const recorded = ck.linkage.landingThemes.find((t) => t.landingKey === 'landing-02')
    assert.equal(recorded.landingPreviewRef, 'landing-02/prototype.html')
    assert.ok(ck.linkage.warnings.every((w) => !w.includes('landing-02') || w.includes('关联预览')), 'warnings 不误报可审阅 landing（landing-02 已关联）')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('联动批次：失败且无原型的 landing 不关联首页（完全失败）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-link-hardfail-'))
  const seen = []
  try {
    const result = await runBatch({
      mode: 'run',
      batchRequest: linkageRequest(),
      batchRoot: root,
      sourceCommit,
      providerIdentity,
      runItem: async ({ item, attemptRoot }) => {
        if (item.itemId === 'item.land.2') throw new Error('landing boom')
        minimalAttemptFiles(attemptRoot, item.itemId, item.brief?.deliverableType)
        return okOrchestration()
      },
    })
    assert.equal(result.status, 'partially_failed')
    void seen
    const ck = loadCheckpoint(path.join(root, 'other', 'runtime'))
    assert.equal(ck.linkage.landingThemes.find((t) => t.landingKey === 'landing-02').landingPreviewRef, undefined)
    assert.ok(ck.linkage.warnings.some((w) => w.includes('landing-02') && w.includes('无可审阅原型')))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('联动批次：仅遗留 prototype.html 不构成可审阅——页面步骤失败/校验未过的遗留原型不可关联', async () => {
  const attemptOf = (batchRoot, itemId) => path.join(batchRoot, 'other', 'runtime', 'items', itemId, 'attempts', '0001')
  const runWithLandingAttempt = (batchRoot, { pageStepFailed, validationFailed, runItemThrows }) => runBatch({
    mode: 'run',
    batchRequest: linkageRequest(),
    batchRoot,
    sourceCommit,
    providerIdentity,
    runItem: async ({ item, attemptRoot }) => {
      if (item.itemId === 'item.land.2') {
        // 组装器落盘真实产物（含 prototype/styles/assets + passed=true 报告 + 空 pending）。
        assemblePage({ pageType: 'landing', outputRoot: attemptRoot }); fs.writeFileSync(path.join(attemptRoot, 'landing-config.json'), JSON.stringify({ page: { name: 'mock-landing' } }))
        if (validationFailed) {
          fs.writeFileSync(path.join(attemptRoot, 'validation-report.json'), JSON.stringify({ passed: false, errors: ['CSS 被修改'], assets: [] }, null, 2) + '\n')
        } else if (!runItemThrows) {
          // 非空 pending 才满足诊断占位签名；页面步骤失败场景覆盖后即为「无效遗留」。
          fs.writeFileSync(path.join(attemptRoot, 'asset-manifest.json'), JSON.stringify({ pendingAssetRequests: [{ id: 's', usageSlot: 's', status: 'pending' }] }, null, 2) + '\n')
        }
        if (runItemThrows) throw new Error('runItem 中断')
        const steps = [{ name: 'image-generate', status: 'failed', details: 'required 素材生成失败' }]
        if (pageStepFailed) steps.push({ name: 'page-design-refill', status: 'failed', details: '素材回填页面生成失败' })
        return {
          briefId: 'b', status: 'failed', selectedCapabilities: ['workflow.orchestrate'], steps,
          deliverable: { packageRoot: attemptRoot, designBriefId: 'b', files: [{ path: 'prototype.html', kind: 'prototype.html', sha256: 'a'.repeat(64) }], sourceCommit: 'x' },
        }
      }
      return okOrchestration()
    },
  })
  const assertNotLinkable = async (batchRoot, scenario) => {
    try {
      await scenario
      assert.fail('不应到达（批次执行应成功但 landing 不可关联）')
    } catch (e) {
      void e
    }
    const ck = loadCheckpoint(path.join(batchRoot, 'other', 'runtime'))
    assert.equal(ck.linkage.landingThemes.find((t) => t.landingKey === 'landing-02').landingPreviewRef, undefined, '无效遗留原型必须不可关联')
  }
  // 场景 1：page-design-refill 失败（页面回填失败）但 attempt 遗留了 prototype.html。
  const refillRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-link-invalid-page-'))
  try {
    await assertNotLinkable(refillRoot, runWithLandingAttempt(refillRoot, { pageStepFailed: true, runItemThrows: false }))
  } finally { fs.rmSync(refillRoot, { recursive: true, force: true }) }
  // 场景 2：validation-report passed=false（页面校验失败遗留原型）。
  const invalidRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-link-invalid-report-'))
  try {
    await assertNotLinkable(invalidRoot, runWithLandingAttempt(invalidRoot, { pageStepFailed: false, validationFailed: true, runItemThrows: false }))
  } finally { fs.rmSync(invalidRoot, { recursive: true, force: true }) }
  // 场景 3：runItem 抛错中断，attempt 只遗留手写 prototype.html（证据链不完整）。
  const interruptRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-link-invalid-int-'))
  try {
    await assertNotLinkable(interruptRoot, runBatch({
      mode: 'run',
      batchRequest: linkageRequest(),
      batchRoot: interruptRoot,
      sourceCommit,
      providerIdentity,
      runItem: async ({ item, attemptRoot }) => {
        if (item.itemId === 'item.land.2') {
          const attempt = path.join(attemptRoot)
          fs.writeFileSync(path.join(attempt, 'prototype.html'), '<!doctype html><html lang="zh"><body>残缺遗留</body></html>')
          throw new Error('runItem 中断')
        }
        return okOrchestration()
      },
    }))
  } finally { fs.rmSync(interruptRoot, { recursive: true, force: true }) }
})

test('联动批次 resume：可审阅失败 landing 的预览 ref 从磁盘证据重建', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-link-reviewable-resume-'))
  const calls = []
  try {
    // 第一次 run：land.1 产出完整证据链 attempt 后失败；land.2 中断；home pending。
    await runBatch({
      mode: 'run',
      batchRequest: linkageRequest(),
      batchRoot: root,
      sourceCommit,
      providerIdentity,
      runItem: async ({ item, attemptRoot }) => {
        if (item.itemId === 'item.land.1') {
          makeReviewableDiagnosticAttempt(attemptRoot)
          return failedOrchestrationWithPrototype(root, attemptRoot)
        }
        if (item.itemId === 'item.land.2') throw new Error('interrupted')
        minimalAttemptFiles(attemptRoot, item.itemId, item.brief?.deliverableType)
        return okOrchestration()
      },
    })
    // 模拟中断未落盘终态。
    const ck = loadCheckpoint(path.join(root, 'other', 'runtime'))
    ck.items = ck.items.map((i) => {
      if (i.itemId === 'item.land.2') return { ...i, status: 'running' }
      if (i.itemId === 'item.home') return { ...i, status: 'pending' }
      return i
    })
    fs.writeFileSync(path.join(root, 'other', 'runtime', 'checkpoint.json'), JSON.stringify(ck, null, 2))
    calls.length = 0
    const result = await runBatch({
      mode: 'resume',
      batchRoot: root,
      sourceCommit,
      providerIdentity,
      runItem: async ({ item, linkage, attemptRoot }) => {
        calls.push(item.itemId)
        if (item.itemId === 'item.home') {
          const ref1 = linkage.landingThemes.find((t) => t.landingKey === 'landing-01')
          assert.equal(
            ref1.landingPreviewRef,
            'landing-01/prototype.html',
            'resume 后首页仍从磁盘证据重建可审阅失败 landing 的首页相对预览 ref',
          )
        }
        minimalAttemptFiles(attemptRoot, item.itemId, item.brief?.deliverableType)
        return okOrchestration()
      },
    })
    assert.deepEqual(calls, ['item.land.2', 'item.home'])
    // land.1 仍是 failed（可审阅失败状态语义不变），resume 落地页成功但首页成功 → partially_failed。
    assert.equal(result.status, 'partially_failed')
    assert.equal(result.items.find((i) => i.itemId === 'item.land.1').status, 'failed')
    // resume 重建时同样发布了完整预览目录（styles/assets 依赖齐备）。
    assert.ok(fs.existsSync(path.join(root, 'other', 'runtime', 'items', 'item.home', 'attempts', '0002', 'landing-01', 'prototype.html')))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('联动批次：全部 landing 失败，首页仍执行并按无关联主题跑', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-link-allfail-'))
  const seen = []
  try {
    const result = await runBatch({
      mode: 'run',
      batchRequest: linkageRequest(),
      batchRoot: root,
      sourceCommit,
      providerIdentity,
      runItem: async ({ item, linkage, attemptRoot }) => {
        seen.push({ itemId: item.itemId, linkage })
        if (item.brief.deliverableType === 'alipay.landing') throw new Error('landing boom')
        minimalAttemptFiles(attemptRoot, item.itemId, item.brief?.deliverableType)
        return okOrchestration()
      },
    })
    assert.equal(result.status, 'partially_failed')
    const home = seen.find((s) => s.itemId === 'item.home')
    assert.ok(home.linkage, '首页仍被执行')
    assert.ok(home.linkage.landingThemes.every((t) => !('landingPreviewRef' in t)), '全部失败时无任何预览 ref')
    const ck = loadCheckpoint(path.join(root, 'other', 'runtime'))
    assert.ok(ck.linkage.warnings.some((w) => w.includes('全部落地页均未产生可关联预览')))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('联动批次 checkpoint/resume 可重建：中断后 resume 保持联动顺序且不重跑已成功项', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-link-resume-'))
  const calls = []
  try {
    // 第一次 run：land.1 成功，land.2 抛错。
    await runBatch({
      mode: 'run',
      batchRequest: linkageRequest(),
      batchRoot: root,
      sourceCommit,
      providerIdentity,
      runItem: async ({ item, attemptRoot }) => {
        calls.push(item.itemId)
        if (item.itemId === 'item.land.2') throw new Error('interrupted')
        // 成功 item 落盘 prototype.html 与对应配置，供 resume 后首页预览发布与终态发布层。
        fs.writeFileSync(path.join(attemptRoot, 'prototype.html'), '<!doctype html><html lang="zh"><body>landing</body></html>')
        const configName = item.brief.deliverableType === 'alipay.landing' ? 'landing-config.json' : 'home-config.json'
        fs.writeFileSync(path.join(attemptRoot, configName), JSON.stringify({ page: { name: `mock-${item.itemId}` } }))
        return okOrchestration()
      },
    })
    // 模拟进程中断时未落盘失败状态：land.2 置为 running，home 置回 pending。
    const ck = loadCheckpoint(path.join(root, 'other', 'runtime'))
    ck.items = ck.items.map((i) => {
      if (i.itemId === 'item.land.2') return { ...i, status: 'running' }
      if (i.itemId === 'item.home') return { ...i, status: 'pending' }
      return i
    })
    fs.writeFileSync(path.join(root, 'other', 'runtime', 'checkpoint.json'), JSON.stringify(ck, null, 2))
    calls.length = 0
    const result = await runBatch({
      mode: 'resume',
      batchRoot: root,
      sourceCommit,
      providerIdentity,
    runItem: async ({ item, linkage, attemptRoot }) => {
      calls.push(item.itemId)
      // land.1 已成功不重跑；home 执行时仍能通过已落盘的 request.json 重建联动并拿到 land.1 的 ref。
      if (item.itemId === 'item.home') {
        assert.equal(linkage.role, 'home')
        const ref1 = linkage.landingThemes.find((t) => t.landingKey === 'landing-01')
        assert.equal(ref1.landingPreviewRef, 'landing-01/prototype.html', 'resume 后首页仍拿到已成功 landing 的首页相对预览 ref')
      }
      minimalAttemptFiles(attemptRoot, item.itemId, item.brief?.deliverableType)
      return okOrchestration()
    },
  })
    assert.deepEqual(calls, ['item.land.2', 'item.home'], 'resume 只重跑中断 landing 与 home，且保持顺序')
    // land.2 抛错无 prototype → 失败状态不改；首跑 land.1 已成功并落盘过 prototype。
    assert.equal(result.status, 'succeeded')
    const ck2 = loadCheckpoint(path.join(root, 'other', 'runtime'))
    assert.deepEqual(ck2.items.map((i) => i.itemId), ['item.land.1', 'item.land.2', 'item.home'])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('无 linkage 批次：执行顺序与联动上下文保持存量行为', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-nolink-'))
  const seen = []
  try {
    const result = await runBatch({
      mode: 'run',
      batchRequest: request([item('a'), item('b')]),
      batchRoot: root,
      sourceCommit,
      providerIdentity,
      runItem: async ({ item, linkage, attemptRoot }) => {
        seen.push({ itemId: item.itemId, linkage })
        minimalAttemptFiles(attemptRoot, item.itemId, item.brief?.deliverableType)
        return okOrchestration()
      },
    })
    assert.equal(result.status, 'succeeded')
    assert.deepEqual(seen.map((s) => s.itemId), ['a', 'b'], '存量批次保持请求顺序')
    assert.ok(seen.every((s) => s.linkage === null || s.linkage === undefined), '无 linkage 时不注入联动上下文')
    const ck = loadCheckpoint(path.join(root, 'other', 'runtime'))
    assert.equal(ck.linkage, undefined, '无 linkage 时 checkpoint 不写 linkage 字段')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

// ---- publishLandingPrototypes：完整离线预览目录发布与路径安全 ----

/**
 * 用受控组装器在 attempt 目录落盘真实原型（prototype.html + styles/ + assets/），
 * 可选删除一个被引用的样式，模拟「引用的依赖缺失」的残缺 attempt。
 */
function makeAssembledLandingAttempt(root, itemId, { removeStyle } = {}) {
  const attemptRoot = path.join(root, 'other', 'runtime', 'items', itemId, 'attempts', '0001')
  assemblePage({ pageType: 'landing', outputRoot: attemptRoot }); fs.writeFileSync(path.join(attemptRoot, 'landing-config.json'), JSON.stringify({ page: { name: 'mock-landing' } }))
  if (removeStyle) fs.rmSync(path.join(attemptRoot, 'styles', removeStyle))
  return attemptRoot
}

test('联动批次：原型引用的依赖缺失时发布按 BATCH_PREVIEW_INCOMPLETE 失败（fail fast，不出半成品预览目录）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-link-incomplete-'))
  try {
    await assert.rejects(
      () => runBatch({
        mode: 'run',
        batchRequest: linkageRequest(),
        batchRoot: root,
        sourceCommit,
        providerIdentity,
        runItem: async ({ item, attemptRoot }) => {
          if (item.itemId === 'item.land.1') makeAssembledLandingAttempt(root, 'item.land.1', { removeStyle: 'tokens.css' })
          else minimalAttemptFiles(attemptRoot, item.itemId, item.brief?.deliverableType)
          return okOrchestration()
        },
      }),
      (e) => e.code === 'BATCH_PREVIEW_INCOMPLETE',
    )
    // 半成品发布目录不得存在：首页链接只指向完整可解析的预览。
    assert.equal(fs.existsSync(path.join(root, 'other', 'runtime', 'items', 'item.home', 'attempts', '0001', 'landing-01')), false)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('联动批次：越界或绝对预览引用按 BATCH_PREVIEW_INVALID 拒绝发布', async () => {
  const attemptOf = (batchRoot) => {
    const attempt = path.join(batchRoot, 'other', 'runtime', 'items', 'item.land.1', 'attempts', '0001')
    assemblePage({ pageType: 'landing', outputRoot: attempt }); fs.writeFileSync(path.join(attempt, 'landing-config.json'), JSON.stringify({ page: { name: 'mock-landing' } }))
    return attempt
  }
  const runWithPrototype = (batchRoot, html) => runBatch({
    mode: 'run',
    batchRequest: linkageRequest(),
    batchRoot,
    sourceCommit,
    providerIdentity,
    runItem: async ({ item, attemptRoot }) => {
      if (item.itemId === 'item.land.1') {
        fs.writeFileSync(path.join(attemptOf(batchRoot), 'prototype.html'), html)
      } else {
        minimalAttemptFiles(attemptRoot, item.itemId, item.brief?.deliverableType)
      }
      return okOrchestration()
    },
  })
  // 越界引用：原型 src 指向 attempt 目录之外。
  const escapeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-link-invalid-'))
  try {
    await assert.rejects(
      () => runWithPrototype(escapeRoot, '<!doctype html><html lang="zh"><body><img src="../../../outside.png"></body></html>'),
      (e) => e.code === 'BATCH_PREVIEW_INVALID',
    )
    assert.equal(fs.existsSync(path.join(escapeRoot, 'other', 'runtime', 'items', 'item.home', 'attempts', '0001', 'landing-01')), false, '越界引用不得产出发布目录')
  } finally { fs.rmSync(escapeRoot, { recursive: true, force: true }) }
  // 绝对路径引用同样拒绝。
  const absoluteRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-link-abs-'))
  try {
    await assert.rejects(
      () => runWithPrototype(absoluteRoot, '<!doctype html><html lang="zh"><body><img src="C:\\abs\\path.png"></body></html>'),
      (e) => e.code === 'BATCH_PREVIEW_INVALID',
    )
    assert.equal(fs.existsSync(path.join(absoluteRoot, 'other', 'runtime', 'items', 'item.home', 'attempts', '0001', 'landing-01')), false, '绝对路径引用不得产出发布目录')
  } finally { fs.rmSync(absoluteRoot, { recursive: true, force: true }) }
})

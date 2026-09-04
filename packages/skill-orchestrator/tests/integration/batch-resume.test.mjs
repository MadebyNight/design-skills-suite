import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runBatch } from '../../runtime/batch-runner.mjs'
import { loadCheckpoint } from '../../runtime/checkpoint.mjs'

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
 * （prototype.html + 配置 JSON，发布合同要求成功页面二者齐备）。
 */
function minimalAttemptFiles(attemptRoot, item) {
  fs.mkdirSync(attemptRoot, { recursive: true })
  fs.writeFileSync(path.join(attemptRoot, 'prototype.html'), '<!doctype html><html lang="zh"><body>mock page</body></html>')
  const configName = item.brief?.deliverableType === 'alipay.landing' ? 'landing-config.json' : 'home-config.json'
  fs.writeFileSync(path.join(attemptRoot, configName), JSON.stringify({ page: { name: `mock-${item.itemId}` } }))
}

test('batch 中断后 resume：running item 归一化并重跑，attempt 递增', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-resume-int-'))
  const calls = []
  try {
    // 第一次 run：a 成功，b 抛错（模拟中断，无法正常 finally）。
    await runBatch({
      mode: 'run',
      batchRequest: request([item('a'), item('b')]),
      batchRoot: root,
      sourceCommit,
      providerIdentity,
      runItem: async ({ item, attemptRoot }) => {
        calls.push(item.itemId)
        if (item.itemId === 'b') throw new Error('interrupted')
        minimalAttemptFiles(attemptRoot, item)
        return okOrchestration()
      },
    })
    // 预写：b 置为 running（模拟进程中断时未落盘失败状态）。
    const ck = loadCheckpoint(path.join(root, 'other', 'runtime'))
    ck.items = ck.items.map((i) => (i.itemId === 'b' ? { ...i, status: 'running' } : i))
    fs.writeFileSync(path.join(root, 'other', 'runtime', 'checkpoint.json'), JSON.stringify(ck, null, 2))

    calls.length = 0
    const result = await runBatch({
      mode: 'resume',
      batchRoot: root,
      sourceCommit,
      providerIdentity,
      runItem: async ({ item, attemptRoot }) => { calls.push(item.itemId); minimalAttemptFiles(attemptRoot, item); return okOrchestration() },
    })
    assert.deepEqual(calls, ['b'], 'resume 只重跑 running→interrupted 的 b')
    assert.equal(result.status, 'succeeded')
    const ck2 = loadCheckpoint(path.join(root, 'other', 'runtime'))
    assert.equal(ck2.items[0].attempt, 1, 'a 保持 attempt 1')
    assert.equal(ck2.items[1].attempt, 2, 'b 重跑 attempt 递增到 2')
    assert.ok(fs.existsSync(path.join(root, 'other', 'runtime', 'items', 'b', 'attempts', '0002')))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('batch 全失败后 retry-failed 只重跑失败项', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-retry-int-'))
  const calls = []
  try {
    await runBatch({
      mode: 'run',
      batchRequest: request([item('a'), item('b')]),
      batchRoot: root,
      sourceCommit,
      providerIdentity,
      runItem: async ({ item }) => { calls.push(item.itemId); throw new Error('boom') },
    })
    calls.length = 0
    const result = await runBatch({
      mode: 'retry-failed',
      batchRoot: root,
      sourceCommit,
      providerIdentity,
      runItem: async ({ item, attemptRoot }) => { calls.push(item.itemId); minimalAttemptFiles(attemptRoot, item); return okOrchestration() },
    })
    assert.deepEqual(calls, ['a', 'b'])
    assert.equal(result.status, 'succeeded')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('retry-failed 遇 interrupted 抛 BATCH_RETRY_REQUIRES_RESUME', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-retry-guard-'))
  try {
    await runBatch({
      mode: 'run',
      batchRequest: request([item('a'), item('b')]),
      batchRoot: root,
      sourceCommit,
      providerIdentity,
      runItem: async ({ item, attemptRoot }) => { if (item.itemId === 'a') throw new Error('boom'); minimalAttemptFiles(attemptRoot, item); return okOrchestration() },
    })
    const ck = loadCheckpoint(path.join(root, 'other', 'runtime'))
    ck.items[1].status = 'interrupted'
    fs.writeFileSync(path.join(root, 'other', 'runtime', 'checkpoint.json'), JSON.stringify(ck, null, 2))
    await assert.rejects(
      () => runBatch({ mode: 'retry-failed', batchRoot: root, sourceCommit, providerIdentity, runItem: async () => okOrchestration() }),
      (e) => e.code === 'BATCH_RETRY_REQUIRES_RESUME',
    )
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

// ---- 页面联动（pageLinkage）集成 ----

const landingBrief = { ...brief, id: 'brief-land-int', deliverableType: 'alipay.landing' }

function linkageRequest() {
  return {
    schemaVersion: '1',
    batchId: 'batch-link-int',
    pageLinkage: {
      homeTheme: '夏日出游租赁',
      landingThemes: [{ theme: '夏日出游租赁' }, { theme: '演唱会租赁' }],
    },
    items: [
      { itemId: 'item.home', brief, assetPolicy },
      { itemId: 'item.land.1', brief: landingBrief, assetPolicy },
      { itemId: 'item.land.2', brief: { ...landingBrief, id: 'brief-land-int-2' }, assetPolicy },
    ],
  }
}

test('联动批次：landing 成功后首页拿到预览 ref，中断恢复后执行顺序与联动保持', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-link-int-'))
  const calls = []
  try {
    // 第一次 run：land.1 成功、land.2 抛错（模拟中断后 home 未执行——预写 running/pending）。
    await runBatch({
      mode: 'run',
      batchRequest: linkageRequest(),
      batchRoot: root,
      sourceCommit,
      providerIdentity,
      runItem: async ({ item, attemptRoot }) => {
        calls.push(item.itemId)
        if (item.itemId === 'item.land.2') throw new Error('interrupted')
        // 成功 item 落盘 prototype.html + 配置（页面 Skill 交付物 + 发布合同要求）。
        fs.writeFileSync(path.join(attemptRoot, 'prototype.html'), '<!doctype html><html lang="zh"><body>landing</body></html>')
        const configName = item.brief.deliverableType === 'alipay.landing' ? 'landing-config.json' : 'home-config.json'
        fs.writeFileSync(path.join(attemptRoot, configName), JSON.stringify({ page: { name: `mock-${item.itemId}` } }))
        return okOrchestration()
      },
    })
    assert.deepEqual(calls, ['item.land.1', 'item.land.2', 'item.home'], 'landing 按序优先、home 最后')
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
          assert.equal(ref1.landingPreviewRef, 'landing-01/prototype.html', 'resume 后首页仍拿到已成功 landing 的首页相对预览 ref')
        }
        minimalAttemptFiles(attemptRoot, item)
        return okOrchestration()
      },
    })
    assert.deepEqual(calls, ['item.land.2', 'item.home'], 'resume 只重跑中断 landing 与 home')
    assert.equal(result.status, 'succeeded')
    // 可关联落地页原型发布到首页交付目录（resume 重建路径同样生效）。
    assert.ok(fs.existsSync(path.join(root, 'other', 'runtime', 'items', 'item.home', 'attempts', '0002', 'landing-01', 'prototype.html')))
    const ck2 = loadCheckpoint(path.join(root, 'other', 'runtime'))
    assert.deepEqual(ck2.items.map((i) => i.itemId), ['item.land.1', 'item.land.2', 'item.home'])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('联动批次：landing 失败不阻断首页，warnings 记录失效关联', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-link-fail-int-'))
  try {
    const result = await runBatch({
      mode: 'run',
      batchRequest: linkageRequest(),
      batchRoot: root,
      sourceCommit,
      providerIdentity,
      runItem: async ({ item, attemptRoot, linkage }) => {
        if (item.itemId === 'item.land.2') throw new Error('landing boom')
        if (item.brief.deliverableType === 'alipay.landing') {
          fs.writeFileSync(path.join(attemptRoot, 'prototype.html'), '<!doctype html><html lang="zh"><body>landing</body></html>')
          fs.writeFileSync(path.join(attemptRoot, 'landing-config.json'), JSON.stringify({ page: { name: `mock-${item.itemId}` } }))
        } else {
          minimalAttemptFiles(attemptRoot, item)
        }
        if (item.itemId === 'item.home') {
          assert.equal(linkage.landingThemes.find((t) => t.landingKey === 'landing-02').landingPreviewRef, undefined, '失败 landing 无预览 ref')
          assert.equal(linkage.landingThemes.find((t) => t.landingKey === 'landing-01').landingPreviewRef, 'landing-01/prototype.html')
        }
        return okOrchestration()
      },
    })
    assert.equal(result.status, 'partially_failed')
    const ck = loadCheckpoint(path.join(root, 'other', 'runtime'))
    assert.ok(ck.linkage.warnings.some((w) => w.includes('landing-02')), 'warnings 记录失败 landing')
    assert.ok(ck.items.every((i) => ['succeeded', 'failed'].includes(i.status)))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('联动批次：visual review 标记 failed 素材时，空 pending manifest 的 landing 仍可关联', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-link-review-int-'))
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
          fs.writeFileSync(path.join(attemptRoot, 'prototype.html'), '<!doctype html><html lang="zh"><body>diagnostic landing</body></html>')
          fs.writeFileSync(path.join(attemptRoot, 'landing-config.json'), JSON.stringify({ page: { name: 'diagnostic-landing' } }))
          fs.writeFileSync(path.join(attemptRoot, 'validation-report.json'), JSON.stringify({ passed: true }))
          fs.writeFileSync(path.join(attemptRoot, 'asset-manifest.json'), JSON.stringify({ pendingAssetRequests: [] }))
          fs.writeFileSync(path.join(attemptRoot, 'visual-review.json'), JSON.stringify({ sections: [{ name: 'assets', items: [{ status: 'failed' }] }] }))
          return { ...okOrchestration(), status: 'failed', steps: [{ name: 'image-generate', status: 'failed' }] }
        }
        if (item.itemId === 'item.home') seen.push(linkage)
        minimalAttemptFiles(attemptRoot, item)
        return okOrchestration()
      },
    })
    assert.equal(result.status, 'partially_failed')
    assert.equal(result.items.find((entry) => entry.itemId === 'item.land.2').status, 'failed')
    assert.equal(
      seen[0].landingThemes.find((theme) => theme.landingKey === 'landing-02').landingPreviewRef,
      'landing-02/prototype.html',
    )
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

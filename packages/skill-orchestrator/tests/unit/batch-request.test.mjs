import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadBatchRequest, BatchRequestError } from '../../runtime/batch-request.mjs'

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

function validRequest(over = {}) {
  return {
    schemaVersion: '1',
    batchId: 'batch-1',
    items: [
      { itemId: 'item-1', brief, assetPolicy },
      { itemId: 'item-2', brief: { ...brief, id: 'brief-2' }, assetPolicy },
    ],
    ...over,
  }
}

test('loadBatchRequest 从对象加载并返回深拷贝', () => {
  const request = validRequest()
  const loaded = loadBatchRequest(request)
  assert.equal(loaded.batchId, 'batch-1')
  assert.equal(loaded.items.length, 2)
  // 深拷贝：修改返回对象不影响输入。
  loaded.items[0].itemId = 'mutated'
  assert.equal(request.items[0].itemId, 'item-1')
})

test('loadBatchRequest 从文件加载', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-req-file-'))
  try {
    const file = path.join(root, 'request.json')
    fs.writeFileSync(file, JSON.stringify(validRequest()))
    const loaded = loadBatchRequest(file)
    assert.equal(loaded.batchId, 'batch-1')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('loadBatchRequest 文件不存在抛 BATCH_REQUEST_IO', () => {
  assert.throws(() => loadBatchRequest('C:/nonexistent/request.json'), (e) => e.code === 'BATCH_REQUEST_IO')
})

test('loadBatchRequest 非法 JSON 抛 BATCH_REQUEST_INVALID', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-req-badjson-'))
  try {
    const file = path.join(root, 'request.json')
    fs.writeFileSync(file, '{"batchId":')
    assert.throws(() => loadBatchRequest(file), (e) => e.code === 'BATCH_REQUEST_INVALID')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('loadBatchRequest 结构非法抛 BATCH_REQUEST_INVALID', () => {
  assert.throws(() => loadBatchRequest({ schemaVersion: '1', batchId: 'b' }), (e) => e.code === 'BATCH_REQUEST_INVALID')
  assert.throws(() => loadBatchRequest(null), (e) => e.code === 'BATCH_REQUEST_INVALID')
})

test('loadBatchRequest itemId 重复抛 BATCH_REQUEST_INVALID', () => {
  const dup = validRequest({ items: [
    { itemId: 'item-1', brief, assetPolicy },
    { itemId: 'item-1', brief: { ...brief, id: 'brief-2' }, assetPolicy },
  ] })
  assert.throws(() => loadBatchRequest(dup), (e) => e.code === 'BATCH_REQUEST_INVALID' && /重复/.test(e.message))
})

// ---- pageLinkage 确定性请求校验 ----

const landingBrief = { ...brief, id: 'brief-land', deliverableType: 'alipay.landing' }

function linkageRequest(over = {}) {
  return {
    schemaVersion: '1',
    batchId: 'batch-link',
    pageLinkage: {
      homeTheme: '夏日出游租赁',
      landingThemes: [{ theme: '夏日出游租赁' }, { theme: '演唱会租赁' }],
    },
    items: [
      { itemId: 'landing-a', brief: landingBrief, assetPolicy },
      { itemId: 'landing-b', brief: { ...landingBrief, id: 'brief-land-b' }, assetPolicy },
      { itemId: 'home-a', brief, assetPolicy },
    ],
    ...over,
  }
}

test('loadBatchRequest：合法 pageLinkage 通过校验', () => {
  const loaded = loadBatchRequest(linkageRequest())
  assert.deepEqual(Object.keys(loaded.pageLinkage), ['homeTheme', 'landingThemes'])
})

test('loadBatchRequest：pageLinkage.landingKey 重复抛 BATCH_REQUEST_INVALID', () => {
  const bad = linkageRequest({
    pageLinkage: { homeTheme: 'T', landingThemes: [{ theme: 'A', landingKey: 'landing-01' }, { theme: 'B', landingKey: 'landing-01' }] },
  })
  assert.throws(() => loadBatchRequest(bad), (e) => e.code === 'BATCH_REQUEST_INVALID' && /重复/.test(e.message))
})

test('loadBatchRequest：联动批次缺 home item 抛 BATCH_REQUEST_INVALID', () => {
  const bad = linkageRequest()
  bad.items = bad.items.filter((i) => i.itemId !== 'home-a')
  assert.throws(() => loadBatchRequest(bad), (e) => e.code === 'BATCH_REQUEST_INVALID' && /恰好一个/.test(e.message))
})

test('loadBatchRequest：landing item 数与主题数不一致抛 BATCH_REQUEST_INVALID', () => {
  const bad = linkageRequest()
  bad.items = bad.items.filter((i) => i.itemId !== 'landing-b')
  assert.throws(() => loadBatchRequest(bad), (e) => e.code === 'BATCH_REQUEST_INVALID' && /数量/.test(e.message))
})

test('loadBatchRequest：pageLinkage 非法 key 形态抛 BATCH_REQUEST_INVALID', () => {
  const bad = linkageRequest({ pageLinkage: { homeTheme: 'T', landingThemes: [{ theme: 'A', landingKey: 'x-01' }] } })
  bad.items = [{ itemId: 'landing-a', brief: landingBrief, assetPolicy }, { itemId: 'home-a', brief, assetPolicy }]
  assert.throws(() => loadBatchRequest(bad), (e) => e.code === 'BATCH_REQUEST_INVALID')
})

test('loadBatchRequest：无 pageLinkage 的存量批次不受影响', () => {
  const loaded = loadBatchRequest(validRequest())
  assert.equal(loaded.pageLinkage, undefined)
})

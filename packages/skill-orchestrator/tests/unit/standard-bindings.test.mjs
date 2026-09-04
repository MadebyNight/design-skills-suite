import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStandardBatchRuntime } from '../../runtime/standard-bindings.mjs'

const testProvider = { name: 'test-provider', model: 'test-fixed-png', async generate() { return { bytes: Buffer.alloc(0), mimeType: 'image/png' } } }

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
const assetPolicy = { default: { source: 'reuse', requirement: 'optional' }, rules: [] }

test('providerIdentity：test provider 固定身份', () => {
  const runtime = createStandardBatchRuntime({ provider: testProvider })
  assert.deepEqual(runtime.providerIdentity, { id: 'test-provider', model: 'test-fixed-png', baseURL: 'test://local' })
})

test('providerIdentity：openai-compatible 暴露 baseURL', () => {
  const provider = { name: 'openai-compatible', model: 'gpt-image-2', baseURL: 'https://api.example.com/v1', async generate() {} }
  const runtime = createStandardBatchRuntime({ provider })
  assert.deepEqual(runtime.providerIdentity, { id: 'openai-compatible', model: 'gpt-image-2', baseURL: 'https://api.example.com/v1' })
})

test('runItem 调用 runDesignImpl 并传入正确参数', async () => {
  let captured
  const runDesignImpl = async (args) => { captured = args; return { status: 'succeeded' } }
  const runtime = createStandardBatchRuntime({ provider: testProvider, runDesignImpl })
  const attemptRoot = '/tmp/attempt'
  const assetStore = {}
  await runtime.runItem({ item: { itemId: 'a', brief, assetPolicy }, attemptRoot, assetStore, itemFingerprint: 'fp' })
  assert.equal(captured.brief, brief)
  assert.equal(captured.assetPolicy, assetPolicy)
  assert.equal(captured.outputRoot, attemptRoot)
  assert.equal(captured.assetStore, assetStore)
  assert.equal(captured.itemFingerprint, 'fp')
  assert.equal(typeof captured.bindings['page.alipay.home.design'], 'function')
  assert.equal(typeof captured.bindings['image.generate'], 'function')
  assert.ok(Array.isArray(captured.skillRoots))
  assert.ok(captured.catalog)
})

test('runItem 页面 binding 按 deliverableType 选择', async () => {
  let captured
  const runDesignImpl = async (args) => { captured = args; return { status: 'succeeded' } }
  const runtime = createStandardBatchRuntime({ provider: testProvider, runDesignImpl })
  await runtime.runItem({ item: { itemId: 'a', brief: { ...brief, deliverableType: 'alipay.landing' }, assetPolicy }, attemptRoot: '/tmp', assetStore: {}, itemFingerprint: 'fp' })
  assert.equal(typeof captured.bindings['page.alipay.landing.design'], 'function')
  assert.equal(captured.bindings['page.alipay.home.design'], undefined)
})

test('runItem 注入 searchBinding', async () => {
  let captured
  const searchBinding = async () => ({ status: 'succeeded', pack: null, warnings: [] })
  const runDesignImpl = async (args) => { captured = args; return { status: 'succeeded' } }
  const runtime = createStandardBatchRuntime({ provider: testProvider, runDesignImpl, searchBinding })
  await runtime.runItem({ item: { itemId: 'a', brief, assetPolicy }, attemptRoot: '/tmp', assetStore: {}, itemFingerprint: 'fp' })
  assert.equal(captured.bindings['research.search'], searchBinding)
})

test('页面 binding 透传 ctx.completedAssets 给 designHome（编排器二次回填合同）', async () => {
  const briefWithInput = { ...brief, inputArtifacts: [{ artifactId: 'user-input-1', path: 'x.png', mimeType: 'image/png' }] }
  const completed = [{ assetRequestId: 'home.hero.image', path: 'generated.png', mimeType: 'image/png', width: 10, height: 10 }]
  let captured = null
  const runDesignImpl = async (args) => {
    // 模拟 runner 二次回填调用：brief 原样传入（保留原始 inputArtifacts），
    // 已验收素材经 opts.completedAssets 传入。
    captured = args
    await args.bindings['page.alipay.home.design'](briefWithInput, {
      outputRoot: '/tmp/out',
      completedAssets: completed,
    })
    return { status: 'succeeded' }
  }
  const runtime = createStandardBatchRuntime({ provider: testProvider, runDesignImpl })
  // 页面 binding 内部调用真实 designHome（会读写 outputRoot），指向临时目录。
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'std-binding-refill-'))
  try {
    await runtime.runItem({ item: { itemId: 'a', brief: briefWithInput, assetPolicy }, attemptRoot: outRoot, assetStore: {}, itemFingerprint: 'fp' })
    assert.ok(captured, 'runDesignImpl 应被调用')
  } finally { fs.rmSync(outRoot, { recursive: true, force: true }) }
})

test('页面 binding 透传 researchPack 给 designHome', async () => {
  const researchPack = { signals: [{ type: 'visual', value: '薄荷绿渐变' }] }
  const runDesignImpl = async (args) => {
    const page = await args.bindings['page.alipay.home.design'](brief, {
      outputRoot: args.outputRoot,
      researchPack,
    })
    assert.ok(page.pendingAssetRequests.some(request => request.theme.includes('薄荷绿渐变')), 'researchPack 信号必须进入页面素材规划')
    return { status: 'succeeded' }
  }
  const runtime = createStandardBatchRuntime({ provider: testProvider, runDesignImpl })
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'std-binding-research-'))
  try {
    await runtime.runItem({ item: { itemId: 'a', brief, assetPolicy }, attemptRoot: outRoot, assetStore: {}, itemFingerprint: 'fp' })
  } finally { fs.rmSync(outRoot, { recursive: true, force: true }) }
})

test('close 为兜底空函数', () => {
  const runtime = createStandardBatchRuntime({ provider: testProvider })
  assert.equal(typeof runtime.close, 'function')
})

test('openphotoRoot 优先级：opts > env.OPENPHOTO_SKILL_ROOT > default', async () => {
  // 用注入 runDesignImpl 捕获 skillRoots，验证 openRoot 取值。
  let captured
  const runDesignImpl = async (args) => { captured = args; return { status: 'succeeded' } }

  // opts 最高优先级。
  const opt = createStandardBatchRuntime({ provider: testProvider, openphotoRoot: 'C:/opt/openphoto', runDesignImpl })
  await opt.runItem({ item: { itemId: 'a', brief: { ...brief, deliverableType: 'alipay.home' }, assetPolicy }, attemptRoot: '/tmp', assetStore: {}, itemFingerprint: 'fp' })
  assert.ok(captured.skillRoots.some((r) => path.resolve(r) === path.resolve('C:/opt/openphoto')))

  // env 次之。
  const envRun = createStandardBatchRuntime({ provider: testProvider, env: { OPENPHOTO_SKILL_ROOT: 'C:/env/openphoto' }, runDesignImpl })
  await envRun.runItem({ item: { itemId: 'a', brief: { ...brief, deliverableType: 'alipay.home' }, assetPolicy }, attemptRoot: '/tmp', assetStore: {}, itemFingerprint: 'fp' })
  assert.ok(captured.skillRoots.some((r) => path.resolve(r) === path.resolve('C:/env/openphoto')))

  // opts 优先于 env。
  const both = createStandardBatchRuntime({ provider: testProvider, openphotoRoot: 'C:/opt/openphoto', env: { OPENPHOTO_SKILL_ROOT: 'C:/env/openphoto' }, runDesignImpl })
  await both.runItem({ item: { itemId: 'a', brief: { ...brief, deliverableType: 'alipay.home' }, assetPolicy }, attemptRoot: '/tmp', assetStore: {}, itemFingerprint: 'fp' })
  assert.ok(captured.skillRoots.some((r) => path.resolve(r) === path.resolve('C:/opt/openphoto')))
  assert.equal(captured.skillRoots.some((r) => path.resolve(r) === path.resolve('C:/env/openphoto')), false)
})

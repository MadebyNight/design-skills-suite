import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { deflateSync } from 'node:zlib'
import { designHome } from '../../../skill-alipay-home/bin/home-design.mjs'
import { designLanding } from '../../../skill-alipay-landing/bin/landing-design.mjs'
import { generateAsset, testProvider } from '../../../skill-image-generate/runtime/generator.mjs'
import { createOpenPhotoAdapterBinding, editWithOpenPhoto, stopOpenPhotoDataRoot } from '../../scripts/image-edit-adapter.mjs'
import { createStandardBatchRuntime } from '../../runtime/standard-bindings.mjs'
import { matchCapability } from '../../runtime/matcher.mjs'
import { discoverSkills } from '../../runtime/discovery.mjs'
import { runDesign } from '../../runtime/runner.mjs'
import { createAssetStore, assetKeyFor } from '../../runtime/asset-store.mjs'

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..')
const OPENPHOTO_ROOT = process.env.OPENPHOTO_SKILL_ROOT || path.join(repoRoot, 'packages', 'openphoto', 'dist', 'openphoto')
const HOME_ROOT = path.join(repoRoot, 'packages', 'skill-alipay-home')
const LANDING_ROOT = path.join(repoRoot, 'packages', 'skill-alipay-landing')
const IMAGE_GENERATE_ROOT = path.join(repoRoot, 'packages', 'skill-image-generate')
const MOCK_IMAGE_EDIT_ROOT = path.join(repoRoot, 'test-fixtures', 'design-skills', 'mocks', 'mock-image-edit')
const FIXED_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')

function brief() {
  return { id: 'brief-runner-home', goal: '支付宝首页基础任务', deliverableType: 'alipay.home', audience: '年轻租赁用户', brandConstraints: ['只使用现有组件'], contentRequirements: ['搜索相机和手机'], visualConstraints: ['信息清晰'], outputSpec: { width: 375, height: 812, format: 'png' }, inputArtifacts: [], researchPolicy: 'none', forbiddenChanges: [] }
}

function request(id, { width, height, format = 'png', fit = 'cover', allowGenerate = true, allowEdit = true } = {}) {
  return { id, usageSlot: id, theme: '测试素材', targetWidth: width, targetHeight: height, aspectRatio: `${width}:${height}`, format, fit, safeArea: '居中', referenceImages: [], forbiddenContent: [], allowGenerate, allowEdit }
}

function pageResult(value, pendingAssetRequests, root) {
  return { status: pendingAssetRequests.length ? 'completed_with_pending_assets' : 'succeeded', designPackage: { packageRoot: root, designBriefId: value.id, files: [], sourceCommit: 'fixture' }, pendingAssetRequests, warnings: [] }
}

function sourceAsset(assetRequest, root, strictSizeSatisfied = false) {
  const sourcePath = path.join(root, `${assetRequest.id}.png`)
  fs.writeFileSync(sourcePath, FIXED_PNG)
  return { assetRequestId: assetRequest.id, artifactId: `${assetRequest.id}-generated`, path: sourcePath, mimeType: 'image/png', width: 1, height: 1, sha256: createHash('sha256').update(FIXED_PNG).digest('hex'), sourceSkill: 'test-generator', sourceSkillVersion: '1.0.0', strictSizeSatisfied, notes: ['测试输入像素'] }
}

function outputMetadata(file) {
  const bytes = fs.readFileSync(file)
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { mimeType: 'image/png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  }
  assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xd8], '输出必须是 PNG 或 JPEG')
  for (let index = 2; index + 8 < bytes.length;) {
    while (bytes[index] === 0xff) index++
    const marker = bytes[index++]
    const length = bytes.readUInt16BE(index)
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { mimeType: 'image/jpeg', height: bytes.readUInt16BE(index + 3), width: bytes.readUInt16BE(index + 5) }
    }
    index += length
  }
  throw new Error('JPEG 输出缺少尺寸标记')
}

function roots(extra = []) { return [HOME_ROOT, LANDING_ROOT, IMAGE_GENERATE_ROOT, OPENPHOTO_ROOT, ...extra] }

function crc32(bytes) {
  let value = 0xffffffff
  for (const byte of bytes) {
    value ^= byte
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
  }
  return (value ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const name = Buffer.from(type)
  const chunk = Buffer.alloc(12 + data.length)
  chunk.writeUInt32BE(data.length, 0)
  name.copy(chunk, 4)
  data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length)
  return chunk
}

function rgbaPng(width, height, pixels) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    pixels.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))])
}

function directoryDigest(root) {
  const digest = createHash('sha256')
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(file)
      else if (entry.isFile()) {
        digest.update(path.relative(root, file))
        digest.update(fs.readFileSync(file))
      }
    }
  }
  visit(root)
  return digest.digest('hex')
}

function createMockImageEditAdapter() {
  let sequence = 0
  let browserPromise
  const browser = async () => {
    if (!browserPromise) {
      browserPromise = import('playwright-core').then(({ chromium }) => chromium.launch({ headless: true }))
    }
    return browserPromise
  }
  return {
    providerId: 'mock-image-edit',
    run: async (assetRequest, { asset, outputRoot }) => {
      assert.ok(fs.existsSync(asset.path), 'mock adapter 必须接收 runner 生成的真实输入文件')
      const isPng = assetRequest.format === 'png'
      const page = await (await browser()).newPage()
      const dataUrl = await page.evaluate(({ width, height, mimeType }) => {
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const context = canvas.getContext('2d')
        context.fillStyle = '#2078e0'
        context.fillRect(0, 0, width, height)
        return canvas.toDataURL(mimeType)
      }, {
        width: assetRequest.targetWidth,
        height: assetRequest.targetHeight,
        mimeType: isPng ? 'image/png' : 'image/jpeg',
      })
      await page.close()
      const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')
      const file = path.join(outputRoot, 'mock-image-edit', `${String(++sequence).padStart(2, '0')}-${assetRequest.id}.${isPng ? 'png' : 'jpg'}`)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, bytes)
      return {
        assetRequestId: assetRequest.id,
        artifactId: `mock-image-edit-${sequence}`,
        path: file,
        mimeType: isPng ? 'image/png' : 'image/jpeg',
        width: assetRequest.targetWidth,
        height: assetRequest.targetHeight,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        sourceSkill: 'mock-image-edit',
        sourceSkillVersion: '1.0.0',
        strictSizeSatisfied: true,
        notes: ['确定性 mock 图片适配输出'],
      }
    },
    close: async () => { await browserPromise?.then(value => value.close()) },
  }
}

async function samplePixels(file, points) {
  const [{ chromium }, { locateBrowser }] = await Promise.all([
    import(pathToFileURL(path.join(OPENPHOTO_ROOT, 'node_modules', 'playwright-core', 'index.mjs')).href),
    import(pathToFileURL(path.join(OPENPHOTO_ROOT, 'runtime', 'browser.mjs')).href),
  ])
  const browser = await chromium.launch({ executablePath: (await locateBrowser()).executablePath, headless: true })
  try {
    const page = await browser.newPage()
    const bytes = fs.readFileSync(file)
    return await page.evaluate(async ({ dataUrl, points: requested }) => {
      const image = new Image()
      image.src = dataUrl
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext('2d', { willReadFrequently: true })
      context.drawImage(image, 0, 0)
      return requested.map(({ x, y }) => [...context.getImageData(x, y, 1, 1).data])
    }, { dataUrl: `data:image/${path.extname(file).slice(1) === 'png' ? 'png' : 'jpeg'};base64,${bytes.toString('base64')}`, points })
  } finally {
    await browser.close()
  }
}

function writeSkill(root, id, provides) {
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ schemaVersion: '1', id, version: '1.0.0', name: id, description: id, entrypoint: 'index.mjs', inputSchema: 'fixture/v1', outputSchema: 'fixture/v1', provides, requires: [], automatic: true, confirmationPoints: [], verifyCommand: 'node index.mjs' }))
}

test('真实 OpenPhoto adapter 对 cover 居中裁切、PNG 透明 contain 与 JPEG 白色 matte 输出像素正确', { timeout: 120_000, concurrency: false }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-real-openphoto-'))
  const sourceRelativePath = path.join('fixtures', 'four-colors.png')
  const sourcePath = path.join(root, sourceRelativePath)
  const colors = [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 0, 255]]
  const pixels = Buffer.alloc(20 * 10 * 4)
  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 20; x++) pixels.set(colors[Math.floor(x / 5)], (y * 20 + x) * 4)
  }
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true })
  fs.writeFileSync(sourcePath, rgbaPng(20, 10, pixels))
  const requests = [request('cover-wide', { width: 10, height: 10, fit: 'cover' }), request('contain-png', { width: 20, height: 20, fit: 'contain' }), request('contain-jpeg', { width: 20, height: 20, format: 'jpg', fit: 'contain' })]
  const calls = []
  try {
    const adapter = createOpenPhotoAdapterBinding({ openphotoRoot: OPENPHOTO_ROOT, dataRoot: path.join(root, 'data'), sourceRoot: root })
    const close = adapter.close
    let closeCalls = 0
    adapter.close = async () => { closeCalls++; await close() }
    const result = await runDesign({
      brief: brief(), skillRoots: roots(), outputRoot: root,
      bindings: {
        'page.alipay.home.design': (value, ctx) => { calls.push({ brief: value, completedAssets: ctx.completedAssets }); return pageResult(value, ctx.completedAssets?.length ? [] : requests, root) },
        'image.generate': value => {
          const bytes = fs.readFileSync(sourcePath)
          return { ...sourceAsset(value, root), path: sourceRelativePath, width: 20, height: 10, sha256: createHash('sha256').update(bytes).digest('hex') }
        }, imageAdapter: adapter,
      },
    })
    assert.equal(result.status, 'succeeded')
    assert.equal(calls.length, 2)
    assert.deepEqual(calls[1].completedAssets.map(asset => asset.assetRequestId).sort(), requests.map(item => item.id).sort())
    for (const asset of calls[1].completedAssets) {
      const expected = requests.find(item => item.id === asset.assetRequestId)
      assert.equal(asset.width, expected.targetWidth)
      assert.equal(asset.height, expected.targetHeight)
      assert.equal(asset.mimeType, expected.format === 'png' ? 'image/png' : 'image/jpeg')
      assert.equal(asset.strictSizeSatisfied, true)
      assert.match(asset.sha256, /^[a-f0-9]{64}$/)
      assert.ok(fs.existsSync(asset.path), `OpenPhoto 实际输出不存在：${asset.path}`)
      assert.deepEqual(outputMetadata(asset.path), { mimeType: asset.mimeType, width: expected.targetWidth, height: expected.targetHeight })
    }
    const byId = new Map(calls[1].completedAssets.map(asset => [asset.assetRequestId, asset]))
    assert.deepEqual(await samplePixels(byId.get('cover-wide').path, [{ x: 0, y: 5 }, { x: 9, y: 5 }]), [[0, 255, 0, 255], [0, 0, 255, 255]])
    const [transparent, pngRed, pngYellow] = await samplePixels(byId.get('contain-png').path, [{ x: 0, y: 0 }, { x: 2, y: 10 }, { x: 17, y: 10 }])
    assert.equal(transparent[3], 0, 'PNG contain 边缘必须保持透明')
    assert.deepEqual(pngRed, [255, 0, 0, 255], 'PNG contain 内容区必须保留源红色')
    assert.deepEqual(pngYellow, [255, 255, 0, 255], 'PNG contain 内容区必须保留源黄色')
    const [matte, jpegRed, jpegYellow] = await samplePixels(byId.get('contain-jpeg').path, [{ x: 0, y: 0 }, { x: 2, y: 10 }, { x: 17, y: 10 }])
    assert.ok(matte[0] >= 190 && matte[1] >= 190 && matte[2] >= 190 && matte[3] === 255, `JPEG contain 边缘应为近白 matte，实际 ${matte}`)
    assert.ok(jpegRed[0] > jpegRed[1] && jpegRed[0] > jpegRed[2] && jpegRed[3] === 255, `JPEG contain 内容区必须保留源红色，实际 ${jpegRed}`)
    assert.ok(jpegYellow[0] >= 180 && jpegYellow[1] >= 180 && jpegYellow[2] <= 160 && jpegYellow[3] === 255, `JPEG contain 内容区必须保留源黄色，实际 ${jpegYellow}`)
    assert.equal(closeCalls, 1, 'runner 必须透传并调用真实 imageAdapter binding 的 close')
    assert.equal(fs.existsSync(path.join(root, 'data', 'daemon.json')), false, '真实 binding close 后必须回收本轮共享 daemon')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('图片 provider 从完整 capability 交集选择，即使三项各自首选不同', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-provider-intersection-'))
  const extra = [['crop-first', ['image.crop']], ['resize-first', ['image.resize']], ['export-first', ['image.export']]].map(([id, provides]) => {
    const skillRoot = path.join(root, 'skills', id); writeSkill(skillRoot, id, provides); return skillRoot
  })
  const item = request('one', { width: 1, height: 1 })
  try {
    const capabilities = [{ id: 'image.crop', skillId: 'crop-first', priority: 100 }, { id: 'image.resize', skillId: 'resize-first', priority: 100 }, { id: 'image.export', skillId: 'export-first', priority: 100 }]
    const discovery = await discoverSkills({ skillRoots: roots(extra) })
    assert.deepEqual(['image.crop', 'image.resize', 'image.export'].map(capability => matchCapability({ discovery, capability, capabilities }).selected.manifest.id), ['crop-first', 'resize-first', 'export-first'])
    const result = await runDesign({
      brief: brief(), skillRoots: roots(extra), outputRoot: root, capabilities,
      bindings: {
        'page.alipay.home.design': (value, ctx) => pageResult(value, ctx.completedAssets?.length ? [] : [item], root),
        'image.generate': value => sourceAsset(value, root, true), imageAdapter: { providerId: 'openphoto', run: () => { throw new Error('严格生成结果不应调用 adapter') } },
      },
    })
    assert.equal(result.status, 'succeeded')
    // 生成结果严格满足规格，无需适配 → 不解析 adapter，也不记录适配 capability。
    assert.equal(['image.crop', 'image.resize', 'image.export'].some(cap => result.selectedCapabilities.includes(cap)), false)
    assert.equal(result.steps.some(step => step.status === 'succeeded' && ['image.crop', 'image.resize', 'image.export'].includes(step.capability)), false, '未执行 adapter 不得把适配 capability 记为成功')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('严格尺寸但格式不一致时仍调用 adapter', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-format-mismatch-'))
  const item = request('format-mismatch', { width: 1, height: 1, format: 'jpg' })
  let adapterCalls = 0
  try {
    const result = await runDesign({
      brief: brief(), skillRoots: roots(), outputRoot: root,
      bindings: {
        'page.alipay.home.design': (value, ctx) => pageResult(value, ctx.completedAssets?.length ? [] : [item], root),
        'image.generate': value => sourceAsset(value, root, true),
        imageAdapter: {
          providerId: 'openphoto',
          run: value => {
            adapterCalls++
            return { ...sourceAsset(value, root, true), mimeType: 'image/jpeg', path: path.join(root, `${value.id}.jpg`) }
          },
        },
      },
    })
    assert.equal(result.status, 'succeeded')
    assert.equal(adapterCalls, 1)
    assert.ok(result.steps.some(step => step.name === 'image-adapt' && step.status === 'succeeded'))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('provider ID 不匹配时不调用 adapter 且编排失败', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-provider-mismatch-'))
  const item = request('mismatch', { width: 2, height: 1 })
  let pageCalls = 0; let adapterCalls = 0
  try {
    const result = await runDesign({ brief: brief(), skillRoots: roots(), outputRoot: root, bindings: { 'page.alipay.home.design': value => { pageCalls++; return pageResult(value, [item], root) }, 'image.generate': value => sourceAsset(value, root), imageAdapter: { providerId: 'other-provider', run: () => { adapterCalls++ } } } })
    assert.equal(result.status, 'failed'); assert.equal(pageCalls, 1); assert.equal(adapterCalls, 0)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('allowEdit=false 不调用 adapter', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-no-edit-'))
  const item = request('no-edit', { width: 2, height: 1, allowEdit: false })
  let adapterCalls = 0
  try {
    const result = await runDesign({ brief: brief(), skillRoots: roots(), outputRoot: root, bindings: { 'page.alipay.home.design': value => pageResult(value, [item], root), 'image.generate': value => sourceAsset(value, root), imageAdapter: { providerId: 'openphoto', run: () => { adapterCalls++ } } } })
    assert.equal(result.status, 'failed'); assert.equal(adapterCalls, 0)
    assert.ok(result.steps.some(step => step.name === 'image-adapt' && step.status === 'failed' && step.details.includes('不允许适配')))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('allowGenerate=false 不调用 generator', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-no-generate-'))
  const item = request('no-generate', { width: 2, height: 1, allowGenerate: false })
  let generatorCalls = 0
  try {
    const result = await runDesign({ brief: brief(), skillRoots: roots(), outputRoot: root, bindings: { 'page.alipay.home.design': value => pageResult(value, [item], root), 'image.generate': () => { generatorCalls++ } } })
    assert.equal(result.status, 'failed'); assert.equal(generatorCalls, 0)
    assert.ok(result.steps.some(step => step.name === 'image-generate' && step.status === 'failed' && step.details.includes('不允许生成')))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('同页素材固定最多 5 个并发，结果仍按请求顺序回填', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-image-concurrency-'))
  const requests = Array.from({ length: 7 }, (_, index) => request(`concurrent-${index + 1}`, { width: 1, height: 1 }))
  const releases = []
  let active = 0
  let peak = 0
  let started = 0
  const waitUntil = async predicate => {
    for (let attempt = 0; attempt < 200 && !predicate(); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert.equal(predicate(), true, '等待并发状态超时')
  }
  try {
    const running = runDesign({
      brief: brief(), skillRoots: roots(), outputRoot: root,
      bindings: {
        'page.alipay.home.design': (value, ctx) => pageResult(value, ctx.completedAssets?.length ? [] : requests, root),
        'image.generate': async value => {
          active++
          started++
          peak = Math.max(peak, active)
          await new Promise(resolve => releases.push(resolve))
          active--
          return sourceAsset(value, root, true)
        },
      },
    })

    await waitUntil(() => started === 5)
    assert.equal(active, 5, '首批应同时运行 5 个素材')
    assert.equal(peak, 5)
    // 保持第一个慢请求未完成，只释放第二个；第六个仍应立即补位，不能被
    // “按请求顺序提交”阻塞。
    releases.splice(1, 1)[0]()
    await waitUntil(() => started === 6)
    assert.equal(active, 5, '任一 worker 完成后应立即由后续素材补位')
    releases.splice(0).forEach(resolve => resolve())

    await waitUntil(() => started === 7)
    assert.ok(active <= 1, '最后一个素材应在前序 worker 释放后启动')
    releases.splice(0).forEach(resolve => resolve())

    const result = await running
    assert.equal(result.status, 'succeeded')
    assert.equal(peak, 5, '峰值并发不得超过 5')
    const completedIds = result.steps
      .filter(step => step.name === 'image-validate' && step.status === 'succeeded')
      .map(step => step.details.match(/请求 ([^ ]+)/)?.[1])
    assert.deepEqual(completedIds, requests.map(item => item.id), '并发完成后步骤仍按原请求顺序合并')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('全部素材失败时仅调用一次页面 binding', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-all-failed-'))
  const requests = [request('fail-1', { width: 2, height: 1 }), request('fail-2', { width: 3, height: 1 })]
  let pageCalls = 0
  try {
    const result = await runDesign({ brief: brief(), skillRoots: roots(), outputRoot: root, bindings: { 'page.alipay.home.design': value => { pageCalls++; return pageResult(value, requests, root) }, 'image.generate': async () => { throw new Error('generation failed') } } })
    assert.equal(result.status, 'failed'); assert.equal(pageCalls, 1)
    assert.equal(result.steps.filter(step => step.name === 'image-generate' && step.status === 'failed').length, requests.length)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('部分成功继续处理后回填成功项，但整体仍为 failed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-partial-'))
  const requests = [request('fail-first', { width: 1, height: 1 }), request('succeed-second', { width: 1, height: 1 })]
  const calls = []
  try {
    const result = await runDesign({
      brief: brief(), skillRoots: roots(), outputRoot: root,
      bindings: {
        'page.alipay.home.design': (value, ctx) => { calls.push({ brief: value, completedAssets: ctx.completedAssets }); return pageResult(value, ctx.completedAssets?.length ? [requests[0]] : requests, root) },
        'image.generate': async value => { if (value.id === 'fail-first') throw new Error('generation failed'); return sourceAsset(value, root, true) },
        imageAdapter: { providerId: 'openphoto', run: () => { throw new Error('严格生成结果不应调用 adapter') } },
      },
    })
    assert.equal(result.status, 'failed'); assert.equal(calls.length, 2)
    assert.deepEqual(calls[1].completedAssets.map(asset => asset.assetRequestId), ['succeed-second'])
    assert.ok(result.steps.some(step => step.name === 'image-generate' && step.status === 'failed' && step.details.includes('fail-first')))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('mock 图片适配 provider 可替换 OpenPhoto，完成真实首页全部素材回填', { timeout: 120_000, concurrency: false }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-mock-image-edit-'))
  const outputRoot = path.join(root, 'output')
  const unavailableOpenPhotoRoot = path.join(root, 'openphoto-not-installed')
  const pageSkillDigest = directoryDigest(HOME_ROOT)
  const pageCalls = []
  const pageResults = []
  try {
    assert.equal(fs.existsSync(unavailableOpenPhotoRoot), false, '本用例不得提供 OpenPhoto 可用路径')
    const result = await runDesign({
      brief: realBrief('alipay.home'),
      skillRoots: [HOME_ROOT, MOCK_IMAGE_EDIT_ROOT, unavailableOpenPhotoRoot],
      outputRoot,
      bindings: {
        'page.alipay.home.design': async (value, ctx) => {
          pageCalls.push({ brief: value, completedAssets: ctx.completedAssets })
          const page = await designHome({ brief: value, outputRoot, ...(ctx.completedAssets ? { completedAssets: ctx.completedAssets } : {}) })
          pageResults.push(page)
          return page
        },
        'image.generate': async (value, { artifactRoot }) => generateAsset(value, { provider: testProvider, artifactRoot }),
        imageAdapter: createMockImageEditAdapter(),
      },
    })

    const initialPending = pageResults[0].pendingAssetRequests
    const finalAssets = pageCalls[1].completedAssets
    assert.ok(initialPending.length > 1, '首次真实首页调用必须返回多个待补槽位')
    assert.equal(result.status, 'succeeded')
    assert.equal(pageCalls.length, 2, '必须完成二次页面回填调用')
    assert.equal(pageResults[1].pendingAssetRequests.length, 0)
    assert.equal(finalAssets.length, initialPending.length)
    assert.ok(finalAssets.every(asset => asset.sourceSkill === 'mock-image-edit'))
    for (const asset of finalAssets) {
      const request = initialPending.find(item => item.id === asset.assetRequestId)
      assert.ok(request, `最终素材必须对应首页请求：${asset.assetRequestId}`)
      assert.ok(fs.existsSync(asset.path), `mock adapter 必须落盘真实有效图片：${asset.path}`)
      assert.deepEqual(
        outputMetadata(asset.path),
        {
          mimeType: request.format === 'png' ? 'image/png' : 'image/jpeg',
          width: request.targetWidth,
          height: request.targetHeight,
        },
        `mock adapter 实际文件必须满足槽位 ${request.id} 的 MIME 和尺寸`,
      )
    }
    assert.equal(result.steps.filter(step => step.name === 'image-adapt' && step.status === 'succeeded' && step.details.includes('mock-image-edit')).length, initialPending.length)
    assert.ok(['image.crop', 'image.resize', 'image.export'].every(capability => result.selectedCapabilities.includes(capability)))
    assert.equal(JSON.parse(fs.readFileSync(path.join(outputRoot, 'validation-report.json'), 'utf8')).passed, true)
    assert.equal(JSON.parse(fs.readFileSync(path.join(outputRoot, 'asset-manifest.json'), 'utf8')).pendingAssetRequests.length, 0)
    assert.equal(directoryDigest(HOME_ROOT), pageSkillDigest, '真实回填不得修改页面 Skill 文件')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

function realBrief(deliverableType) {
  return {
    id: `brief-real-${deliverableType.replace('.', '-')}`,
    // 落地页 brief 显式声明模块意图：新 landing-config 派生（deriveLandingConfig）
    // 按 brief 意图选择白名单模块——主图（HERO_IMAGE 1 槽）+ 广告图
    // （IMAGE_AD 双图 2 槽）共 3 个回填槽位；无模块意图时只派生最小合法页面
    // （仅 hero 槽），无法覆盖多槽位回填链路。
    goal: deliverableType === 'alipay.home' ? '为暑期相机租赁设计支付宝首页' : '为演唱会设备租赁设计带主图与双图广告图的支付宝落地页',
    deliverableType,
    audience: '25-35 岁城市年轻用户',
    brandConstraints: ['只使用现有组件'],
    contentRequirements: ['搜索相机和手机', '精选活动设备'],
    visualConstraints: ['信息清晰'],
    outputSpec: { width: 375, height: 812, format: 'png' },
    inputArtifacts: [],
    researchPolicy: 'none',
    forbiddenChanges: [],
  }
}

async function runRealPageChain({ deliverableType, designPage, slotCount }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `runner-real-${deliverableType.replace('.', '-')}-`))
  const outputRoot = path.join(root, 'output')
  const dataRoot = path.join(root, 'openphoto-data')
  let initialPending = 0
  try {
    // 一请求一结果合同不允许同一 artifactId 回填多个槽位。真实 provider 的
    // 每次生成都会产生独立内容；固定 PNG 桩会被 OpenPhoto 按内容去重为同一
    // artifact，因此这里为每个请求生成确定性但不同的测试像素。
    const distinctTestProvider = {
      ...testProvider,
      async generate(value) {
        const digest = createHash('sha256').update(value.id).digest()
        const pair = Buffer.from([digest[0], digest[1], digest[2], 255, digest[3], digest[4], digest[5], 255])
        return {
          // 4x4 保持测试输入足够小，同时避免 1500x2400 页面背景适配超过
          // OpenPhoto 单轴 1000 倍缩放上限；像素仍按请求 ID 确定性区分。
          bytes: rgbaPng(4, 4, Buffer.concat(Array.from({ length: 8 }, () => pair))),
          mimeType: 'image/png',
          providerRequestId: null,
          revisedPrompt: null,
          responseMode: 'test',
        }
      },
    }
    const adapter = createOpenPhotoAdapterBinding({
      openphotoRoot: OPENPHOTO_ROOT,
      dataRoot,
      sourceRoot: IMAGE_GENERATE_ROOT,
    })
    const result = await runDesign({
      brief: realBrief(deliverableType),
      skillRoots: roots(),
      outputRoot,
      bindings: {
        [deliverableType === 'alipay.home' ? 'page.alipay.home.design' : 'page.alipay.landing.design']: (value, ctx) => designPage({ brief: value, outputRoot, ...(ctx.completedAssets ? { completedAssets: ctx.completedAssets } : {}) }),
        'image.generate': async (value, { artifactRoot }) => {
          assert.ok(artifactRoot.startsWith(outputRoot), 'runner 必须提供位于本次 outputRoot 的 artifactRoot')
          const asset = await generateAsset(value, { provider: distinctTestProvider, artifactRoot })
          assert.ok(path.resolve(asset.path).startsWith(`${path.resolve(outputRoot)}${path.sep}`), '生成素材必须落在本次 outputRoot 内')
          return asset
        },
        imageAdapter: adapter,
      },
    })
    assert.equal(result.status, 'succeeded', JSON.stringify(result.steps.filter((step) => step.status === 'failed')))
    assert.equal(result.steps.filter(step => step.name === 'image-generate' && step.status === 'succeeded').length, slotCount)
    initialPending = result.steps.find(step => step.name === 'page-design')?.details.match(/待补 (\d+) 个素材/)?.[1]
    assert.equal(Number(initialPending), slotCount, '首次页面调用必须返回全部待补槽位')
    assert.equal(JSON.parse(fs.readFileSync(path.join(outputRoot, 'validation-report.json'), 'utf8')).passed, true)
    assert.equal(JSON.parse(fs.readFileSync(path.join(outputRoot, 'asset-manifest.json'), 'utf8')).pendingAssetRequests.length, 0)
    const html = fs.readFileSync(path.join(outputRoot, 'prototype.html'), 'utf8')
    if (deliverableType === 'alipay.home') {
      // 新 home-config 派生协议：回填产物按槽位命名（assets/<usageSlot>.png），
      // 与 home-config 的素材路径一致；不再写入 assets/generated/。
      // 轮播/腰封按 landingThemes（默认两主题）克隆，同一槽位可被引用多次，
      // 因此按唯一回填文件数断言。
      const slotRefs = [...new Set([...html.matchAll(/src="([^"]+)"/g)].map(match => match[1]).filter(ref => /^assets\/home\./.test(ref)))]
      assert.equal(slotRefs.length, slotCount, '原型必须引用全部回填槽位')
      for (const ref of slotRefs) {
        assert.ok(fs.existsSync(path.join(outputRoot, ref)), `回填槽位文件缺失：${ref}`)
      }
    } else {
      // 新 landing-config 派生协议：回填产物位于 config 声明的槽位路径
      //（assets/<slotKey>.<slot>.image.png）。页面背景由 CSS 引用，其余素材由
      // 原型 src 引用；两条链路分别验证。
      const slotRefs = [...html.matchAll(/src="([^"]+)"/g)].map(match => match[1]).filter(ref => ref.startsWith('assets/'))
      assert.equal(slotRefs.length, slotCount - 1, '除页面背景外，其余回填槽位必须由原型 src 引用')
      for (const ref of slotRefs) {
        assert.ok(fs.existsSync(path.join(outputRoot, ref)), `回填槽位文件缺失：${ref}`)
      }
      const landingConfig = JSON.parse(fs.readFileSync(path.join(outputRoot, 'landing-config.json'), 'utf8'))
      assert.equal(landingConfig.page.background.type, 'image')
      assert.ok(fs.existsSync(path.join(outputRoot, landingConfig.page.background.image)), '页面背景回填文件必须存在')
      const themeCss = fs.readFileSync(path.join(outputRoot, 'styles', 'theme.css'), 'utf8')
      assert.ok(themeCss.includes(`url("../${landingConfig.page.background.image}")`), '页面背景必须由主题 CSS 引用')
    }
    // runner 透传 close：daemon 由 binding 自有 child 优雅退出，状态文件必须消失且 quiet 后不重现。
    const diagnostics = adapter.diagnostics()
    assert.notEqual(diagnostics.exitCode, null, 'binding 自有的 controlled daemon 必须在 close 后退出')
    assert.equal(fs.existsSync(path.join(dataRoot, 'daemon.json')), false, 'close 后 daemon.json 必须消失')
    assert.equal(fs.existsSync(path.join(dataRoot, 'daemon.lock')), false, 'close 后 daemon.lock 必须消失')
    await new Promise(resolve => setTimeout(resolve, 300))
    assert.equal(fs.existsSync(path.join(dataRoot, 'daemon.json')), false, 'quiet 300ms 后 daemon.json 不得重现')
    assert.equal(fs.existsSync(path.join(dataRoot, 'daemon.lock')), false, 'quiet 300ms 后 daemon.lock 不得重现')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
}

test('真实 runner 首页链路用 testProvider、OpenPhoto adapter 回填全部 12 个槽位', { timeout: 240_000, concurrency: false }, async () => {
  // 默认两个 landingThemes 各派生一个 carousel 和 waistBanner：2 + 5 + 3 + 2。
  await runRealPageChain({ deliverableType: 'alipay.home', designPage: designHome, slotCount: 12 })
})

test('真实 runner 落地页链路用 testProvider、OpenPhoto adapter 回填全部 4 个槽位（背景+hero+双图广告）', { timeout: 180_000, concurrency: false }, async () => {
  await runRealPageChain({ deliverableType: 'alipay.landing', designPage: designLanding, slotCount: 4 })
})

// ---- C2.3 素材策略 / 缓存 / 复用 ----

function policyResult(value, pendingAssetRequests, root) {
  return { status: pendingAssetRequests.length ? 'completed_with_pending_assets' : 'succeeded', designPackage: { packageRoot: root, designBriefId: value.id, files: [], sourceCommit: 'fixture' }, pendingAssetRequests, warnings: [] }
}

function strictAsset(assetRequest, root) {
  const filePath = path.join(root, `${assetRequest.id}.png`)
  fs.writeFileSync(filePath, FIXED_PNG)
  return { assetRequestId: assetRequest.id, artifactId: `${assetRequest.id}-gen`, path: filePath, mimeType: 'image/png', width: assetRequest.targetWidth, height: assetRequest.targetHeight, sha256: createHash('sha256').update(FIXED_PNG).digest('hex'), sourceSkill: 'test-generator', sourceSkillVersion: '1.0.0', strictSizeSatisfied: true, notes: [] }
}

test('generate required 成功：调用 generator 并回填', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-policy-gen-req-ok-'))
  const item = request('gen-req', { width: 1, height: 1 })
  let generatorCalls = 0
  const pageCalls = []
  try {
    const result = await runDesign({
      brief: brief(), skillRoots: roots(), outputRoot: root,
      assetPolicy: { default: { source: 'generate', requirement: 'required' }, rules: [] },
      bindings: {
        'page.alipay.home.design': (value, ctx) => { pageCalls.push({ brief: value, completedAssets: ctx.completedAssets }); return policyResult(value, ctx.completedAssets?.length ? [] : [item], root) },
        'image.generate': value => { generatorCalls++; return strictAsset(value, root) },
      },
    })
    assert.equal(result.status, 'succeeded')
    assert.equal(generatorCalls, 1)
    assert.ok(result.selectedCapabilities.includes('image.generate'), '确实调用过 generator 应记录 image.generate')
    assert.ok(result.steps.some(step => step.name === 'image-generate' && step.status === 'succeeded' && step.details.includes('gen-req')))
    // 首次 pageFn 必须收到空 inputArtifacts（原始输入素材仅留给后续 referenceImages）。
    assert.deepEqual(pageCalls[0].brief.inputArtifacts, [], '首次 pageFn 收到空 inputArtifacts')
    assert.equal(pageCalls[0].completedAssets, undefined, '首次 pageFn 不携带 completedAssets')
    assert.equal(pageCalls.length, 2, '回填成功后执行二次页面调用')
    assert.deepEqual(pageCalls[1].completedAssets.map(asset => asset.assetRequestId), ['gen-req'], '二次回填经 completedAssets 携带已验收素材')
    // 生成结果直接过验收：不解析/调用 adapter，也不产生适配 warning。
    assert.equal(result.steps.some(step => step.name === 'image-adapt'), false, '无需适配时不得调用 adapter')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('generate required 失败：整体 failed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-policy-gen-req-fail-'))
  const item = request('gen-req-fail', { width: 1, height: 1 })
  try {
    const result = await runDesign({
      brief: brief(), skillRoots: roots(), outputRoot: root,
      assetPolicy: { default: { source: 'generate', requirement: 'required' }, rules: [] },
      bindings: {
        'page.alipay.home.design': value => policyResult(value, [item], root),
        'image.generate': async () => { throw new Error('gen boom') },
      },
    })
    assert.equal(result.status, 'failed')
    assert.ok(result.selectedCapabilities.includes('image.generate'), '确实调用过 generator 应记录 image.generate')
    assert.ok(result.steps.some(step => step.name === 'image-generate' && step.status === 'failed' && step.details.includes('gen-req-fail')))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('generate optional 失败：页面成功，pending optional 保留', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-policy-gen-opt-fail-'))
  const item = request('gen-opt', { width: 1, height: 1 })
  let pageCalls = 0
  try {
    const result = await runDesign({
      brief: brief(), skillRoots: roots(), outputRoot: root,
      assetPolicy: { default: { source: 'generate', requirement: 'optional' }, rules: [] },
      bindings: {
        'page.alipay.home.design': (value, ctx) => { pageCalls++; return policyResult(value, ctx.completedAssets?.length ? [item] : [item], root) },
        'image.generate': async () => { throw new Error('gen boom') },
      },
    })
    assert.equal(result.status, 'succeeded')
    assert.equal(pageCalls, 1, '全部 optional 失败时不做第二次页面调用')
    assert.ok(result.selectedCapabilities.includes('image.generate'), '确实调用过 generator 应记录 image.generate')
    assert.ok(result.steps.some(step => step.name === 'image-generate' && step.status === 'warning' && step.details.includes('gen-opt')))
    assert.ok(result.steps.some(step => step.name === 'page-design-refill' && step.status === 'warning' && step.details.includes('保留首次页面默认素材')))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('最终页面调用透传 required 与 optional 的 failedAssets', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-failed-assets-'))
  const required = request('failed-required', { width: 1, height: 1 })
  const optional = request('failed-optional', { width: 1, height: 1 })
  const pageCalls = []
  try {
    const pageBinding = Object.assign((value, context) => {
      pageCalls.push(context)
      return policyResult(value, pageCalls.length === 1 ? [required, optional] : [], root)
    }, { acceptsFailedAssets: true })
    const result = await runDesign({
      brief: brief(), skillRoots: roots(), outputRoot: root,
      assetPolicy: {
        default: { source: 'generate', requirement: 'required' },
        rules: [{ usageSlot: optional.usageSlot, source: 'generate', requirement: 'optional' }],
      },
      bindings: {
        'page.alipay.home.design': pageBinding,
        'image.generate': async () => { throw new Error('gen boom') },
      },
    })
    assert.equal(result.status, 'failed')
    assert.equal(pageCalls.length, 2)
    assert.deepEqual(pageCalls[1].failedAssets, [required.usageSlot, optional.usageSlot])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('brief 输入素材无论 sourceSkill 都不命中 reuse：仅作 referenceImages', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-policy-reuse-brief-'))
  const item = request('reuse-hit', { width: 1, height: 1 })
  // sourceSkill='test-generator'（非 user-input 标记）：原始 brief 输入一律视为
  // 用户输入，不得命中 reuse 路径（spec：仅作 referenceImages）。
  const input = strictAsset(item, root)
  let generatorCalls = 0
  let pageCalls = 0
  try {
    const result = await runDesign({
      brief: { ...brief(), inputArtifacts: [input] }, skillRoots: roots(), outputRoot: root,
      assetPolicy: { default: { source: 'reuse', requirement: 'required' }, rules: [] },
      bindings: {
        'page.alipay.home.design': value => { pageCalls++; return policyResult(value, pageCalls === 1 ? [item] : [], root) },
        'image.generate': () => { generatorCalls++ },
      },
    })
    assert.equal(result.status, 'failed', 'brief 输入素材不得作为复用素材命中 required 槽位')
    assert.equal(pageCalls, 1, '无任何可回填素材时不做第二次页面调用')
    assert.equal(generatorCalls, 0)
    assert.equal(result.selectedCapabilities.includes('image.generate'), false, 'reuse 缺失不记录 image.generate')
    assert.ok(result.steps.some(step => step.name === 'image-reuse' && step.status === 'failed' && step.details.includes('reuse-hit')))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('reuse required 缺失：失败且 generator 0', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-policy-reuse-miss-'))
  const item = request('reuse-miss', { width: 1, height: 1 })
  let generatorCalls = 0
  try {
    const result = await runDesign({
      brief: brief(), skillRoots: roots(), outputRoot: root,
      assetPolicy: { default: { source: 'reuse', requirement: 'required' }, rules: [] },
      bindings: {
        'page.alipay.home.design': value => policyResult(value, [item], root),
        'image.generate': () => { generatorCalls++ },
      },
    })
    assert.equal(result.status, 'failed')
    assert.equal(generatorCalls, 0)
    assert.ok(result.steps.some(step => step.name === 'image-reuse' && step.status === 'failed' && step.details.includes('reuse-miss')))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('reuse optional 缺失：成功且 generator 0', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-policy-reuse-opt-'))
  const item = request('reuse-opt', { width: 1, height: 1 })
  let generatorCalls = 0
  let pageCalls = 0
  try {
    const result = await runDesign({
      brief: brief(), skillRoots: roots(), outputRoot: root,
      assetPolicy: { default: { source: 'reuse', requirement: 'optional' }, rules: [] },
      bindings: {
        'page.alipay.home.design': value => { pageCalls++; return policyResult(value, [item], root) },
        'image.generate': () => { generatorCalls++ },
      },
    })
    assert.equal(result.status, 'succeeded')
    assert.equal(generatorCalls, 0)
    assert.equal(pageCalls, 1, '全部 optional 缺失时不做第二次页面调用')
    assert.equal(result.selectedCapabilities.includes('image.generate'), false, 'reuse 缺失不应记录 image.generate')
    assert.ok(result.steps.some(step => step.name === 'image-reuse' && step.status === 'warning' && step.details.includes('reuse-opt')))
    assert.ok(result.steps.some(step => step.name === 'page-design-refill' && step.status === 'warning' && step.details.includes('保留首次页面默认素材')))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('assetStore 命中使 generate provider 调用 0', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-policy-cache-hit-'))
  const item = request('cache-hit', { width: 1, height: 1 })
  const asset = strictAsset(item, root)
  const store = createAssetStore()
  const key = assetKeyFor('fp', item, 'generate')
  await store.put(key, asset, { request: item })
  let generatorCalls = 0
  const pageCalls = []
  try {
    const result = await runDesign({
      brief: brief(), skillRoots: roots(), outputRoot: root, itemFingerprint: 'fp', assetStore: store,
      assetPolicy: { default: { source: 'generate', requirement: 'required' }, rules: [] },
      bindings: {
        'page.alipay.home.design': (value, ctx) => { pageCalls.push({ brief: value, completedAssets: ctx.completedAssets }); return policyResult(value, ctx.completedAssets?.length ? [] : [item], root) },
        'image.generate': () => { generatorCalls++ },
      },
    })
    assert.equal(result.status, 'succeeded')
    assert.equal(generatorCalls, 0)
    assert.equal(result.selectedCapabilities.includes('image.generate'), false, 'cache 命中不应记录 image.generate')
    assert.ok(result.steps.some(step => step.name === 'image-cache' && step.status === 'succeeded' && step.details.includes('cache-hit')))
    // 问题 2 合同：二次回填只传 asset store 已验收命中（和本轮 completedAssets），
    // 不传任何原始 brief 输入（本例 brief 无输入素材）。
    assert.equal(pageCalls.length, 2, '缓存命中素材也应触发二次回填')
    assert.deepEqual(pageCalls[1].completedAssets, [asset], '二次回填 completedAssets 携带 asset store 已验收命中素材')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('缓存失效后调用 provider', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-policy-cache-miss-'))
  const item = request('cache-miss', { width: 1, height: 1 })
  const store = createAssetStore()
  let generatorCalls = 0
  try {
    const result = await runDesign({
      brief: brief(), skillRoots: roots(), outputRoot: root, itemFingerprint: 'fp', assetStore: store,
      assetPolicy: { default: { source: 'generate', requirement: 'required' }, rules: [] },
      bindings: {
        'page.alipay.home.design': (value, ctx) => policyResult(value, ctx.completedAssets?.length ? [] : [item], root),
        'image.generate': value => { generatorCalls++; return strictAsset(value, root) },
      },
    })
    assert.equal(result.status, 'succeeded')
    assert.equal(generatorCalls, 1)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('精确/通配策略：仅 banner generate，其余 reuse optional 保留', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-policy-home-subset-'))
  const banner = request('home.banner', { width: 1, height: 1 })
  const hero = request('home.hero', { width: 1, height: 1 })
  const policy = {
    default: { source: 'reuse', requirement: 'optional' },
    rules: [{ usageSlot: 'home.banner', source: 'generate', requirement: 'required' }],
  }
  let generatorCalls = 0
  let pageCalls = 0
  try {
    const result = await runDesign({
      brief: brief(), skillRoots: roots(), outputRoot: root, assetPolicy: policy,
      bindings: {
        'page.alipay.home.design': (value, ctx) => {
          pageCalls++
          if (ctx.completedAssets?.length) return policyResult(value, [hero], root)
          return policyResult(value, [banner, hero], root)
        },
        'image.generate': value => { generatorCalls++; return strictAsset(value, root) },
      },
    })
    assert.equal(result.status, 'succeeded')
    assert.equal(generatorCalls, 1, '仅 banner 应调用 generate')
    assert.equal(pageCalls, 2)
    assert.ok(result.steps.some(step => step.name === 'image-generate' && step.status === 'succeeded' && step.details.includes('home.banner')))
    assert.ok(result.steps.some(step => step.name === 'image-reuse' && step.status === 'warning' && step.details.includes('home.hero')))
    assert.ok(result.steps.some(step => step.name === 'page-design-refill' && step.details.includes('可选素材')))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('assetKeyFor 第三参为 source：同 request 不同匹配 pattern 但 source 相同则 key 一致', () => {
  const item = request('home.banner', { width: 1, height: 1 })
  // 精确命中与通配命中可能匹配不同 pattern，但 source 相同 → 缓存键一致，可复用。
  const exactKey = assetKeyFor('fp', item, 'generate')
  const wildKey = assetKeyFor('fp', item, 'generate')
  assert.equal(exactKey, wildKey)
  // source 不同则键不同。
  assert.notEqual(assetKeyFor('fp', item, 'generate'), assetKeyFor('fp', item, 'reuse'))
})

test('全 reuse 不命中 brief 输入素材：required 缺失失败，不要求 adapter / provider 能力', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-policy-all-reuse-'))
  const item = request('reuse-only', { width: 1, height: 1 })
  const input = strictAsset(item, root)
  let generatorCalls = 0
  let pageCalls = 0
  try {
    const result = await runDesign({
      brief: { ...brief(), inputArtifacts: [input] }, skillRoots: roots(), outputRoot: root,
      assetPolicy: { default: { source: 'reuse', requirement: 'required' }, rules: [] },
      bindings: {
        'page.alipay.home.design': value => { pageCalls++; return policyResult(value, pageCalls === 1 ? [item] : [], root) },
        'image.generate': () => { generatorCalls++ },
        // 不提供 imageAdapter，全 reuse 不应要求 adapter 能力。
      },
    })
    assert.equal(result.status, 'failed', 'brief 输入不命中 reuse：required 缺失整体 failed')
    assert.equal(pageCalls, 1, '无任何可回填素材时不做第二次页面调用')
    assert.equal(generatorCalls, 0)
    assert.equal(['image.crop', 'image.resize', 'image.export'].some(cap => result.selectedCapabilities.includes(cap)), false)
    assert.equal(result.selectedCapabilities.includes('image.generate'), false, 'reuse 缺失不记录 image.generate')
    assert.ok(result.steps.some(step => step.name === 'image-reuse' && step.status === 'failed' && step.details.includes('reuse-only')))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

// ---- 统一验收/重试合同（acceptance / retryPolicy）与用户输入边界 ----

/** 比例验收请求构造器：默认 aspect-ratio + 0.03 容差 + 3 生成 / 2 适配重试。 */
function aspectRequest(id, { width, height, maxAspectRatioError = 0.03, generateMaxAttempts = 3, adaptMaxAttempts = 2, allowEdit = true, referenceImages } = {}) {
  return {
    id, usageSlot: id, theme: '测试素材', targetWidth: width, targetHeight: height,
    aspectRatio: `${width}:${height}`, format: 'png', fit: 'cover', safeArea: '居中',
    referenceImages: referenceImages || [],
    forbiddenContent: [], allowGenerate: true, allowEdit,
    acceptance: { mode: 'aspect-ratio', maxAspectRatioError },
    retryPolicy: { generateMaxAttempts, adaptMaxAttempts },
    ...(referenceImages !== undefined ? { referenceImages } : {}),
  }
}

/** 指定宽高的合法 AssetResult（strictSizeSatisfied 按实际宽高推导）。 */
function sizedAsset(assetRequest, root, width, height, { strict = false, sourceSkill = 'test-generator' } = {}) {
  const sourcePath = path.join(root, `${assetRequest.id}-${width}x${height}.png`)
  fs.writeFileSync(sourcePath, FIXED_PNG)
  return { assetRequestId: assetRequest.id, artifactId: `${assetRequest.id}-${width}x${height}`, path: sourcePath, mimeType: 'image/png', width, height, sha256: createHash('sha256').update(FIXED_PNG).digest('hex'), sourceSkill, sourceSkillVersion: '1.0.0', strictSizeSatisfied: strict, notes: [] }
}

test('比例验收：生成结果不同尺寸但比例一致（strict=false）直接通过，不调用 adapter', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-aspect-ok-'))
  // 目标 1404x600；生成 702x300 同比例（2x1 PNG 由 provider 输出时经适配，
  // 这里直接由 binding 返回同比例结果，等价"生成即达标"）。
  const item = request('aspect-ok', { width: 1404, height: 600 })
  item.acceptance = { mode: 'aspect-ratio', maxAspectRatioError: 0.03 }
  item.retryPolicy = { generateMaxAttempts: 3, adaptMaxAttempts: 2 }
  let adapterCalls = 0
  try {
    const result = await runDesign({
      brief: brief(), skillRoots: roots(), outputRoot: root,
      bindings: {
        'page.alipay.home.design': (value, ctx) => policyResult(value, ctx.completedAssets?.length ? [] : [item], root),
        'image.generate': value => ({ ...sizedAsset(value, root, 702, 300), path: path.join(root, `${value.id}.png`) }),
        imageAdapter: { providerId: 'openphoto', run: () => { adapterCalls++; throw new Error('比例达标不应调用 adapter') } },
      },
    })
    assert.equal(result.status, 'succeeded')
    assert.equal(adapterCalls, 0)
    assert.ok(result.steps.some(step => step.name === 'image-validate' && step.status === 'succeeded' && step.details.includes('比例验收')), '应记录比例验收通过')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('比例验收边界：误差 ≤3%（含理论恰 0.03 边界）通过，>3% 触发适配', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-aspect-boundary-'))
  // 1446x600 vs 1404x600：相对误差 ≈2.99%（浮点下 < 0.03）→ 生成即通过。
  const inTolerance = request('edge-in', { width: 1404, height: 600 })
  inTolerance.acceptance = { mode: 'aspect-ratio', maxAspectRatioError: 0.03 }
  // 1030x1000 vs 1000x1000：理论恰 3%（浮点 0.030000000000000027，epsilon 补偿后通过）。
  const edgeExact = request('edge-exact', { width: 1000, height: 1000 })
  edgeExact.acceptance = { mode: 'aspect-ratio', maxAspectRatioError: 0.03 }
  // 1040x1000 vs 1000x1000 = 4% > 3% → 触发适配。
  const over = request('edge-over', { width: 1000, height: 1000 })
  over.acceptance = { mode: 'aspect-ratio', maxAspectRatioError: 0.03 }
  let adapterCalls = 0
  try {
    const result = await runDesign({
      brief: brief(), skillRoots: roots(), outputRoot: root,
      bindings: {
        'page.alipay.home.design': (value, ctx) => policyResult(value, ctx.completedAssets?.length ? [] : [inTolerance, edgeExact, over], root),
        'image.generate': value => {
          if (value.id === over.id) return { ...sizedAsset(value, root, 1040, 1000), path: path.join(root, `${value.id}.png`) }
          if (value.id === edgeExact.id) return { ...sizedAsset(value, root, 1030, 1000), path: path.join(root, `${value.id}.png`) }
          return { ...strictAsset(value, root) }
        },
        imageAdapter: { providerId: 'openphoto', run: (req, { asset }) => { adapterCalls++; return ({ ...asset, width: req.targetWidth, height: req.targetHeight, strictSizeSatisfied: true, artifactId: `${req.id}-adapted` }) } },
      },
    })
    // edge-exact 生成 1030x1000（理论恰 3%，epsilon 补偿后 ≤0.03）→ 直接通过；
    // edge-over 生成 1040x1000（实际 4% > 3%）→ 适配为 1000x1000 后通过；
    // edge-in 生成 1404x600（误差 ≈2.99% < 0.03）→ 直接通过，无需适配。
    assert.equal(result.status, 'succeeded')
    assert.equal(adapterCalls, 1, '仅实际超差请求触发适配')
    assert.ok(result.steps.some(step => step.name === 'image-adapt' && step.status === 'succeeded' && step.details.includes(over.id)), '实际超差请求应由适配满足比例验收')
    assert.ok(result.steps.some(step => step.name === 'image-validate' && step.status === 'succeeded' && step.details.includes(edgeExact.id)), '理论恰好 3% 边界请求直接通过比例验收')
    assert.ok(result.steps.some(step => step.name === 'image-validate' && step.status === 'succeeded' && step.details.includes(inTolerance.id)), '容差内请求直接通过比例验收')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('生成 retryable 失败：generateMaxAttempts=3 时第 2/3 次成功都停止重试', async () => {
  // 第 2 次成功。
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-retry-2nd-'))
  const item2 = request('retry-2nd', { width: 1, height: 1 })
  item2.retryPolicy = { generateMaxAttempts: 3, adaptMaxAttempts: 2 }
  let calls2 = 0
  try {
    const result = await runDesign({
      brief: brief(), skillRoots: roots(), outputRoot: root2,
      bindings: {
        'page.alipay.home.design': (value, ctx) => policyResult(value, ctx.completedAssets?.length ? [] : [item2], root2),
        'image.generate': value => {
          calls2++
          if (calls2 === 1) { const e = new Error('网络抖动'); e.retryable = true; throw e }
          return strictAsset(value, root2)
        },
      },
    })
    assert.equal(result.status, 'succeeded')
    assert.equal(calls2, 2, '第 2 次成功后不再重试')
    assert.ok(result.steps.some(step => step.name === 'image-generate' && step.status === 'succeeded' && step.details.includes('第 2 次')), '应记录第 2 次成功')
  } finally { fs.rmSync(root2, { recursive: true, force: true }) }

  // 第 3 次成功（重试耗尽前）。
  const root3 = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-retry-3rd-'))
  const item3 = request('retry-3rd', { width: 1, height: 1 })
  item3.retryPolicy = { generateMaxAttempts: 3, adaptMaxAttempts: 2 }
  let calls3 = 0
  try {
    const result = await runDesign({
      brief: brief(), skillRoots: roots(), outputRoot: root3,
      bindings: {
        'page.alipay.home.design': (value, ctx) => policyResult(value, ctx.completedAssets?.length ? [] : [item3], root3),
        'image.generate': value => { calls3++; if (calls3 < 3) { const e = new Error('限流'); e.retryable = true; throw e } return strictAsset(value, root3) },
      },
    })
    assert.equal(result.status, 'succeeded')
    assert.equal(calls3, 3, '重试耗尽前第 3 次成功')
    assert.ok(result.steps.some(step => step.name === 'image-generate' && step.status === 'succeeded' && step.details.includes('第 3 次')))
  } finally { fs.rmSync(root3, { recursive: true, force: true }) }
})

test('非 retryable 失败：仅调用一次 generator，不重试', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-non-retryable-'))
  const item = request('no-retry', { width: 1, height: 1 })
  item.retryPolicy = { generateMaxAttempts: 3, adaptMaxAttempts: 2 }
  let generatorCalls = 0
  let pageCalls = 0
  try {
    const result = await runDesign({
      brief: brief(), skillRoots: roots(), outputRoot: root,
      bindings: {
        'page.alipay.home.design': value => { pageCalls++; return policyResult(value, [item], root) },
        'image.generate': () => {
          generatorCalls++
          const e = new Error('认证失败')
          e.retryable = false
          throw e
        },
      },
    })
    assert.equal(result.status, 'failed')
    assert.equal(generatorCalls, 1, '非 retryable 错误不重试')
    assert.equal(pageCalls, 1, '全部失败时仅一次页面调用')
    assert.ok(result.steps.some(step => step.name === 'image-generate' && step.status === 'failed' && step.details.includes('认证失败')))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('retryable 失败耗尽 3 次上限：整体 failed 且 generator 调用 3 次', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-retry-exhaust-'))
  const item = request('retry-exhaust', { width: 1, height: 1 })
  item.retryPolicy = { generateMaxAttempts: 3, adaptMaxAttempts: 2 }
  let generatorCalls = 0
  try {
    const result = await runDesign({
      brief: brief(), skillRoots: roots(), outputRoot: root,
      bindings: {
        'page.alipay.home.design': value => policyResult(value, [item], root),
        'image.generate': () => { generatorCalls++; const e = new Error('服务过载'); e.retryable = true; throw e },
      },
    })
    assert.equal(result.status, 'failed')
    assert.equal(generatorCalls, 3, 'retryable 错误重试至 generateMaxAttempts 上限')
    assert.equal(result.steps.filter(step => step.name === 'image-generate' && step.status === 'failed').length, 1, '耗尽后只记一条 failed 步骤')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('适配 retryable 异常：首次抛错第二次成功，共调用 adapter 两次', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-adapt-retry-'))
  // 生成结果 2x1（比例 2:1），目标 1404x600（比例 2.34:1）→ 不通过比例验收 → 走适配。
  const item = request('adapt-retry', { width: 1404, height: 600 })
  item.acceptance = { mode: 'aspect-ratio', maxAspectRatioError: 0.03 }
  item.retryPolicy = { generateMaxAttempts: 3, adaptMaxAttempts: 2 }
  const generated = () => ({ ...strictAsset(item, root), width: 2, height: 1, strictSizeSatisfied: false })
  let adapterCalls = 0
  try {
    const result = await runDesign({
      brief: brief(), skillRoots: roots(), outputRoot: root,
      bindings: {
        'page.alipay.home.design': (value, ctx) => policyResult(value, ctx.completedAssets?.length ? [] : [item], root),
        'image.generate': () => generated(),
        imageAdapter: { providerId: 'openphoto', run: (req, { asset }) => {
          adapterCalls++
          if (adapterCalls === 1) { const e = new Error('适配瞬时失败'); e.retryable = true; throw e }
          return { ...asset, width: req.targetWidth, height: req.targetHeight, strictSizeSatisfied: true, artifactId: 'adapt-2' }
        } },
      },
    })
    assert.equal(result.status, 'succeeded')
    assert.equal(adapterCalls, 2, 'retryable 异常后重试，第二次成功')
    assert.ok(result.steps.some(step => step.name === 'image-adapt' && step.status === 'warning' && step.details.includes('重试')), '首次 retryable 失败记 warning 重试步骤')
    assert.ok(result.steps.some(step => step.name === 'image-adapt' && step.status === 'succeeded' && step.details.includes('openphoto')))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('适配正常返回不合格：仅调用 adapter 一次且不重试，required 失败', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-adapt-return-'))
  // 生成结果 2x1 不达标 → 走适配；adapter 正常返回（不抛错）但结果不过验收 →
  // 立即终态失败，不会因"返回不合格"消耗重试次数第二次调用。
  const item = request('adapt-return', { width: 1404, height: 600 })
  item.acceptance = { mode: 'aspect-ratio', maxAspectRatioError: 0.03 }
  item.retryPolicy = { generateMaxAttempts: 3, adaptMaxAttempts: 2 }
  let adapterCalls = 0
  try {
    const result = await runDesign({
      brief: brief(), skillRoots: roots(), outputRoot: root,
      bindings: {
        'page.alipay.home.design': value => policyResult(value, [item], root),
        'image.generate': () => ({ ...strictAsset(item, root), width: 2, height: 1, strictSizeSatisfied: false }),
        imageAdapter: { providerId: 'openphoto', run: (req, { asset }) => {
          adapterCalls++
          return { ...asset, width: 700, height: 350, artifactId: 'adapt-return-1' }
        } },
      },
    })
    assert.equal(result.status, 'failed')
    assert.equal(adapterCalls, 1, '返回不合格即终态失败，绝不再次调用 adapter')
    assert.ok(result.steps.some(step => step.name === 'image-adapt' && step.status === 'failed' && step.details.includes('不满足验收合同')), '返回不合格以验收合同语义记 failed')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('适配重试耗尽（adaptMaxAttempts=2 两次都抛 retryable）：required 失败', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-adapt-exhaust-'))
  const item = request('adapt-exhaust', { width: 1404, height: 600 })
  item.acceptance = { mode: 'aspect-ratio', maxAspectRatioError: 0.03 }
  item.retryPolicy = { generateMaxAttempts: 3, adaptMaxAttempts: 2 }
  let adapterCalls = 0
  try {
    const result = await runDesign({
      brief: brief(), skillRoots: roots(), outputRoot: root,
      bindings: {
        'page.alipay.home.design': value => policyResult(value, [item], root),
        'image.generate': () => ({ ...strictAsset(item, root), width: 2, height: 1, strictSizeSatisfied: false }),
        imageAdapter: { providerId: 'openphoto', run: (req, { asset }) => { adapterCalls++; const e = new Error('适配服务过载'); e.retryable = true; e.attempt = adapterCalls; throw e } },
      },
    })
    assert.equal(result.status, 'failed')
    assert.equal(adapterCalls, 2, '适配 retryable 异常重试至 adaptMaxAttempts 上限')
    assert.ok(result.steps.some(step => step.name === 'image-adapt' && step.status === 'warning' && step.details.includes('第 1 次')), '首次 retryable 异常记 warning 重试')
    assert.ok(result.steps.some(step => step.name === 'image-adapt' && step.status === 'failed' && step.details.includes('适配服务过载')), '耗尽后以最后一次异常记 failed')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('首页用户输入素材仅作 reference：不回填、不参与二次回填', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-user-input-'))
  const item = request('user-input-guard', { width: 1, height: 1 })
  const userInput = { ...strictAsset(item, root), sourceSkill: 'user-input' }
  const pageCalls = []
  let generatorCalls = 0
  try {
    const result = await runDesign({
      brief: { ...brief(), inputArtifacts: [userInput] }, skillRoots: roots(), outputRoot: root,
      assetPolicy: { default: { source: 'reuse', requirement: 'required' }, rules: [] },
      bindings: {
        'page.alipay.home.design': value => {
          pageCalls.push(value)
          // 用户输入被剥离后：首次有 pending（reuse 路径不命中），第二次也不应命中。
          return policyResult(value, pageCalls.length === 1 ? [item] : [], root)
        },
        'image.generate': () => { generatorCalls++ },
      },
    })
    // 用户输入不命中复用路径 → reuse required 缺失 → 整体 failed；且二次回填的
    // completedAssets 已剥离用户素材（若未被剥离，reuse 会命中并成功）。
    assert.equal(result.status, 'failed', '用户输入素材不得作为复用素材命中 required 槽位')
    assert.equal(pageCalls.length, 1, '无任何可回填素材时不做第二次页面调用')
    assert.ok(result.steps.some(step => step.name === 'image-reuse' && step.status === 'failed' && step.details.includes('user-input-slot') === false && step.details.includes(item.id)))
    assert.equal(generatorCalls, 0)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('brief 输入素材不进入二次回填 completedAssets；生成素材经 completedAssets 回填', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-refill-filter-'))
  const item = request('refill-check', { width: 1, height: 1 })
  const briefInput = strictAsset(item, root)
  const pageCalls = []
  try {
    const result = await runDesign({
      brief: { ...brief(), inputArtifacts: [briefInput] }, skillRoots: roots(), outputRoot: root,
      bindings: {
        'page.alipay.home.design': (value, ctx) => {
          pageCalls.push({ brief: value, completedAssets: ctx.completedAssets })
          // 首次：pending 为空 → 直接完成（不触发素材循环）。
          return policyResult(value, [], root)
        },
        'image.generate': () => { throw new Error('不应调用 generator') },
      },
    })
    assert.equal(result.status, 'succeeded')
    assert.equal(pageCalls.length, 1)
    assert.deepEqual(pageCalls[0].brief.inputArtifacts, [], '首次页面调用固定收到空 inputArtifacts（用户输入只作生图参考图）')
    assert.equal(pageCalls[0].completedAssets, undefined, '首次页面调用不携带 completedAssets')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }

  // 触发真实回填路径：一次 pending + 生成成功 → 二次回填只含生成素材。
  // brief 输入会被注入 referenceImages，因此 mock binding 需显式声明支持参考图。
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-refill-filter2-'))
  const item2 = request('refill-real', { width: 1, height: 1 })
  const briefInput2 = strictAsset(item2, root2)
  const generated = strictAsset(item2, root2)
  const pageCalls2 = []
  try {
    const result = await runDesign({
      brief: { ...brief(), inputArtifacts: [briefInput2] }, skillRoots: roots(), outputRoot: root2,
      bindings: {
        'page.alipay.home.design': (value, ctx) => {
          pageCalls2.push({ brief: value, completedAssets: ctx.completedAssets })
          if (pageCalls2.length === 1) return policyResult(value, [item2], root2)
          return policyResult(value, [], root2)
        },
        'image.generate': Object.assign(value => strictAsset(value, root2), { capabilities: ['asset.reference-images'] }),
      },
    })
    assert.equal(result.status, 'succeeded')
    assert.equal(pageCalls2.length, 2, '回填成功后执行二次页面调用')
    // brief 原样传入（原始 inputArtifacts 保留），已验收素材只经 completedAssets。
    assert.deepEqual(pageCalls2[1].brief.inputArtifacts, [briefInput2], '二次调用 brief 保留原始 inputArtifacts')
    assert.deepEqual(pageCalls2[1].completedAssets.map(a => a.assetRequestId), [item2.id])
    assert.equal(pageCalls2[1].completedAssets[0].artifactId, generated.artifactId, '回填的是生成素材而非 brief 输入')
  } finally { fs.rmSync(root2, { recursive: true, force: true }) }
})

test('用户输入素材仅按 assetRequestId 精确注入对应 referenceImages', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-ref-inject-'))
  const slotA = { ...request('ref-request-a', { width: 1, height: 1 }), usageSlot: 'ref.slot-a' }
  const slotB = { ...request('ref-request-b', { width: 1, height: 1 }), usageSlot: 'ref.slot-b' }
  const boundByUsageSlot = { ...strictAsset(slotA, root), assetRequestId: slotA.usageSlot, artifactId: 'bound-by-usage-slot', sourceSkill: 'user-input' }
  const boundByRequestId = { ...strictAsset(slotB, root), assetRequestId: slotB.id, artifactId: 'bound-by-request-id', sourceSkill: 'user-input' }
  const unbound = { ...strictAsset(request('ref-unbound', { width: 1, height: 1 }), root), assetRequestId: 'ref.unknown', artifactId: 'unbound', sourceSkill: 'user-input' }
  const seenRequests = []
  let generatorCalls = 0
  try {
    const result = await runDesign({
      brief: { ...brief(), inputArtifacts: [boundByUsageSlot, boundByRequestId, unbound] }, skillRoots: roots(), outputRoot: root,
      bindings: {
        'page.alipay.home.design': (value, ctx) => policyResult(value, ctx.completedAssets?.length ? [] : [slotA, slotB], root),
        'image.generate': Object.assign(value => { seenRequests.push(value); generatorCalls++; return strictAsset(value, root) }, { capabilities: ['asset.reference-images'] }),
      },
    })
    assert.equal(result.status, 'succeeded')
    assert.equal(generatorCalls, 2)
    assert.equal(seenRequests.length, 2, '两个待补请求都应调用 generator')
    const byId = new Map(seenRequests.map(value => [value.id, value]))
    const injectedA = byId.get(slotA.id).referenceImages
    assert.deepEqual(injectedA.map(asset => asset.artifactId), [boundByUsageSlot.artifactId], '仅 assetRequestId 命中 usageSlot 的输入可注入 A')
    const injectedB = byId.get(slotB.id).referenceImages
    assert.deepEqual(injectedB.map(asset => asset.artifactId), [boundByRequestId.artifactId], '仅 assetRequestId 命中 request.id 的输入可注入 B')
    assert.equal([...injectedA, ...injectedB].some(asset => asset.artifactId === unbound.artifactId), false, '未绑定输入不得注入任何槽位')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('用户输入注入进入缓存键：注入与未注入命中不同缓存条目', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-ref-key-'))
  const item = request('ref-key', { width: 1, height: 1 })
  const userInput = { ...strictAsset(item, root), sourceSkill: 'user-input' }
  const store = createAssetStore()
  let generatorCalls = 0
  try {
    // 无输入素材运行：按未注入键写缓存。
    const first = await runDesign({
      brief: brief(), skillRoots: roots(), outputRoot: root, itemFingerprint: 'fp', assetStore: store,
      bindings: {
        'page.alipay.home.design': (value, ctx) => policyResult(value, ctx.completedAssets?.length ? [] : [item], root),
        'image.generate': value => { generatorCalls++; return strictAsset(value, root) },
      },
    })
    assert.equal(first.status, 'succeeded')
    assert.equal(generatorCalls, 1)
    // 带用户输入素材运行同 fingerprint：注入后的键不同 → 必须重新生成而非误命中旧缓存。
    const second = await runDesign({
      brief: { ...brief(), inputArtifacts: [userInput] }, skillRoots: roots(), outputRoot: root, itemFingerprint: 'fp', assetStore: store,
      assetPolicy: { default: { source: 'generate', requirement: 'required' }, rules: [] },
      bindings: {
        'page.alipay.home.design': (value, ctx) => policyResult(value, ctx.completedAssets?.length ? [] : [item], root),
        'image.generate': Object.assign(value => {
          generatorCalls++
          assert.ok(value.referenceImages.some(asset => asset.sourceSkill === 'user-input'), 'generator 收到的请求必须携带注入的用户参考图')
          return strictAsset(value, root)
        }, { capabilities: ['asset.reference-images'] }),
      },
    })
    assert.equal(second.status, 'succeeded')
    assert.equal(generatorCalls, 2, '注入与否的请求键不同，不得误命中旧缓存')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('二次回填不重复注入：用户输入不回填，generator 只收首次注入', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-ref-noref-'))
  const item = request('ref-once', { width: 1, height: 1 })
  const userInput = { ...strictAsset(item, root), sourceSkill: 'user-input' }
  let generateCalls = 0
  try {
    const result = await runDesign({
      brief: { ...brief(), inputArtifacts: [userInput] }, skillRoots: roots(), outputRoot: root,
      bindings: {
        'page.alipay.home.design': (value, ctx) => policyResult(value, ctx.completedAssets?.length ? [] : [item], root),
        'image.generate': Object.assign(value => {
          generateCalls++
          // 每次调用都应恰好携带一份去重后的用户参考图（不随回填迭代累积）。
          const refs = value.referenceImages.filter(asset => asset.sourceSkill === 'user-input')
          assert.equal(refs.length, 1, `用户输入应恰好注入一次：${refs.length}`)
          return strictAsset(value, root)
        }, { capabilities: ['asset.reference-images'] }),
      },
    })
    assert.equal(result.status, 'succeeded')
    assert.equal(generateCalls, 1)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('未声明参考图能力的 provider：清空参考图、warning 后继续文字生成', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-ref-unsupported-'))
  const item = request('ref-unsupported', { width: 1, height: 1 })
  const userInput = { ...strictAsset(item, root), sourceSkill: 'user-input' }
  let generatorCalls = 0
  let pageCalls = 0
  try {
    const result = await runDesign({
      brief: { ...brief(), inputArtifacts: [userInput] }, skillRoots: roots(), outputRoot: root,
      bindings: {
        'page.alipay.home.design': (value, ctx) => { pageCalls++; return policyResult(value, ctx.completedAssets?.length ? [] : [item], root) },
        // 标准 binding 形态：无 capabilities 声明（等价实际 provider 不支持参考图）。
        'image.generate': () => { generatorCalls++; return strictAsset(item, root) },
      },
    })
    assert.equal(result.status, 'succeeded', 'provider 不支持参考图时仍应使用文字约束完成 required 请求')
    assert.equal(generatorCalls, 1, '未声明支持参考图时仍应调用 generator')
    assert.equal(pageCalls, 2, '生成成功后执行二次回填')
    const warningStep = result.steps.find(step => step.name === 'image-reference' && step.status === 'warning')
    assert.ok(warningStep?.details.includes('参考图'), 'warning 应说明参考图被忽略')
    assert.ok(result.steps.some(step => step.name === 'image-generate' && step.status === 'succeeded'), '文字生成必须成功记录')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('同一 artifactId 不能被两个请求重复消费', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-duplicate-artifact-'))
  const first = request('duplicate-first', { width: 1, height: 1 })
  const second = request('duplicate-second', { width: 1, height: 1 })
  const pageCalls = []
  try {
    const result = await runDesign({
      brief: brief(), skillRoots: roots(), outputRoot: root,
      bindings: {
        'page.alipay.home.design': (value, ctx) => {
          pageCalls.push(ctx.completedAssets)
          return policyResult(value, ctx.completedAssets?.length ? [] : [first, second], root)
        },
        'image.generate': value => ({ ...strictAsset(value, root), artifactId: 'one-artifact-only' }),
      },
    })
    assert.equal(result.status, 'failed', 'required 的重复 artifact 必须使编排失败')
    assert.equal(pageCalls.length, 2, '首个结果仍可回填，重复结果不得加入 completedAssets')
    assert.deepEqual(pageCalls[1].map(asset => asset.assetRequestId), [first.id])
    assert.ok(result.steps.some(step => step.name === 'image-validate' && step.status === 'failed' && step.details.includes('重复消费')))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('标准 binding 不为任何 provider 虚假声明参考图能力', async () => {
  const policy = { default: { source: 'reuse', requirement: 'optional' }, rules: [] }
  // test-provider（固定 PNG 桩）：不消费参考图，不得虚假声明 asset.reference-images。
  const testProvider = { name: 'test-provider', model: 'test-fixed-png', async generate() { return { bytes: Buffer.alloc(4), mimeType: 'image/png', responseMode: 'test' } } }
  let capturedBinding = null
  const captureRuntime = createStandardBatchRuntime({
    provider: testProvider,
    runDesignImpl: async (args) => { capturedBinding = args.bindings['image.generate']; return { status: 'succeeded' } },
  })
  await captureRuntime.runItem({ item: { itemId: 'a', brief, assetPolicy: policy }, attemptRoot: '/tmp', assetStore: {}, itemFingerprint: 'fp' })
  assert.ok(capturedBinding, 'standard binding 必须暴露 image.generate 绑定')
  assert.deepEqual(capturedBinding.capabilities, [], 'test-provider 不消费参考图，不得声明支持')

  // 实际不支持参考图的 provider（fal.ai 形态）：同样不声明。
  const falProvider = { name: 'fal.ai', model: 'openai/gpt-image-2', async generate() { return { bytes: Buffer.alloc(4), mimeType: 'image/png', responseMode: 'url' } } }
  let falBinding = null
  const falRuntime = createStandardBatchRuntime({
    provider: falProvider,
    runDesignImpl: async (args) => { falBinding = args.bindings['image.generate']; return { status: 'succeeded' } },
  })
  await falRuntime.runItem({ item: { itemId: 'a', brief, assetPolicy: policy }, attemptRoot: '/tmp', assetStore: {}, itemFingerprint: 'fp' })
  assert.deepEqual(falBinding.capabilities, [], 'fal.ai 当前实现不消费参考图，不得声明支持')

  // openai-compatible：同样不声明。
  const openaiProvider = { name: 'openai-compatible', model: 'gpt-image-2', baseURL: 'https://api.example.com/v1', async generate() { return { bytes: Buffer.alloc(4), mimeType: 'image/png', responseMode: 'b64_json' } } }
  let openaiBinding = null
  const openaiRuntime = createStandardBatchRuntime({
    provider: openaiProvider,
    runDesignImpl: async (args) => { openaiBinding = args.bindings['image.generate']; return { status: 'succeeded' } },
  })
  await openaiRuntime.runItem({ item: { itemId: 'a', brief, assetPolicy: policy }, attemptRoot: '/tmp', assetStore: {}, itemFingerprint: 'fp' })
  assert.deepEqual(openaiBinding.capabilities, [], 'openai-compatible 当前实现不消费参考图，不得声明支持')
})

test('标准 mock provider 链路：用户输入注入后正常生成回填（能力声明路由）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-ref-standard-'))
  const item = request('ref-standard', { width: 1, height: 1 })
  const userInput = { ...strictAsset(item, root), sourceSkill: 'user-input' }
  let generatorCalls = 0
  let pageCalls = 0
  try {
    const result = await runDesign({
      brief: { ...brief(), inputArtifacts: [userInput] }, skillRoots: roots(), outputRoot: root,
      assetPolicy: { default: { source: 'generate', requirement: 'required' }, rules: [] },
      bindings: {
        'page.alipay.home.design': (value, ctx) => { pageCalls++; return policyResult(value, ctx.completedAssets?.length ? [] : [item], root) },
        // 参考图注入链路测试使用明确声明该能力的 mock binding（而非声称某真实
        // provider 支持）→ 请求正常路由到 generator。
        'image.generate': Object.assign(value => { generatorCalls++; return strictAsset(value, root) }, { capabilities: ['asset.reference-images'] }),
      },
    })
    assert.equal(result.status, 'succeeded')
    assert.equal(generatorCalls, 1, '声明支持参考图的 mock binding 正常执行生成')
    assert.equal(pageCalls, 2, '生成成功后执行二次回填')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('回填后仍存在必填待补：refill step 记 failed，整体 failed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-refill-required-remaining-'))
  // 首次 pending 一个 required 槽位；生成成功回填后，二次页面仍返回同名 pending
  //（模拟页面侧回填后仍待补），此时 refill step 必须为 failed 而非 warning。
  const item = request('refill-required', { width: 1, height: 1 })
  const pageCalls = []
  try {
    const result = await runDesign({
      brief: brief(), skillRoots: roots(), outputRoot: root,
      bindings: {
        'page.alipay.home.design': value => { pageCalls.push(value); return policyResult(value, [item], root) },
        'image.generate': value => strictAsset(value, root),
      },
    })
    assert.equal(pageCalls.length, 2, '生成成功应执行二次回填调用')
    assert.equal(result.status, 'failed', '必填素材仍待补时整体 failed')
    const refillStep = result.steps.find(step => step.name === 'page-design-refill')
    assert.equal(refillStep?.status, 'failed', 'required 剩余时 page-design-refill step 记 failed')
    assert.ok(refillStep.details.includes('仍待补'), 'refill step 保留仍待补详情')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

// ---- editWithOpenPhoto cleanup/error propagation ----

function adapterCallMock({ onClose, onMutate }) {
  const calls = []
  const call = async ({ openphotoRoot, dataRoot, value }) => {
    calls.push(value.op)
    if (value.op === 'artifact.import') {
      return { artifactId: 'a'.repeat(64), mimeType: 'image/png', width: 10, height: 10 }
    }
    if (value.op === 'document.open') {
      return { documentId: 'doc-1' }
    }
    if (value.op === 'document.inspect') {
      return {
        descriptor: { objects: [{ type: 'image', objectId: 'obj-1', imageState: {}, bounds: { width: 10, height: 10 } }] },
        revision: 0,
      }
    }
    if (value.op === 'document.mutate') {
      if (onMutate) return onMutate(value)
      return { revision: 1 }
    }
    if (value.op === 'document.renderArtifact') {
      return { artifact: { artifactId: 'b'.repeat(64) } }
    }
    if (value.op === 'artifact.read') {
      return { artifactId: 'b'.repeat(64), path: 'out.png', mimeType: 'image/png', width: 10, height: 10, sha256: 'c'.repeat(64) }
    }
    if (value.op === 'document.close') {
      if (onClose) return onClose(value)
      return { closed: true }
    }
    throw new Error(`unexpected op: ${value.op}`)
  }
  return { call, calls }
}

function adapterAssetRequest() {
  return { id: 'adapter-char', usageSlot: 'adapter-char', theme: '测试', targetWidth: 10, targetHeight: 10, aspectRatio: '1:1', format: 'png', fit: 'cover', safeArea: '居中', referenceImages: [], forbiddenContent: [], allowGenerate: true, allowEdit: true }
}

test('editWithOpenPhoto surfaces a document.close failure after a successful main flow', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-close-throws-'))
  const sourcePath = path.join(root, 'input.png')
  fs.writeFileSync(sourcePath, FIXED_PNG)
  const { call, calls } = adapterCallMock({ onClose: async () => { throw new Error('close cleanup failed') } })
  try {
    await assert.rejects(
      editWithOpenPhoto(adapterAssetRequest(), {
        sourcePath,
        openphotoRoot: OPENPHOTO_ROOT,
        dataRoot: path.join(root, 'data'),
        call,
      }),
      /close cleanup failed/,
      'a document.close failure must not be silently swallowed'
    )
    assert.ok(calls.includes('document.close'), 'document.close must have been attempted')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('editWithOpenPhoto preserves the main error and exposes cleanupError when close also fails', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-main-and-close-fail-'))
  const sourcePath = path.join(root, 'input.png')
  fs.writeFileSync(sourcePath, FIXED_PNG)
  const { call, calls } = adapterCallMock({
    onMutate: async () => { throw new Error('main mutate failed') },
    onClose: async () => { throw new Error('close cleanup failed') },
  })
  try {
    await assert.rejects(
      editWithOpenPhoto(adapterAssetRequest(), {
        sourcePath,
        openphotoRoot: OPENPHOTO_ROOT,
        dataRoot: path.join(root, 'data'),
        call,
      }),
      error => error.message.includes('main mutate failed') && error.cleanupError?.message.includes('close cleanup failed'),
      'the primary failure must be preserved and cleanupError must be exposed'
    )
    assert.ok(calls.includes('document.close'), 'document.close must still be attempted')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('stopOpenPhotoDataRoot removes stale state and lock for a dead pid', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-stop-stale-'))
  fs.writeFileSync(path.join(root, 'daemon.json'), JSON.stringify({ pid: 2147483646 }))
  fs.writeFileSync(path.join(root, 'daemon.lock'), '{}')
  try {
    await stopOpenPhotoDataRoot(root, { timeoutMs: 100, pollMs: 5 })
    assert.equal(fs.existsSync(path.join(root, 'daemon.json')), false)
    assert.equal(fs.existsSync(path.join(root, 'daemon.lock')), false)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('stopOpenPhotoDataRoot reports OPENPHOTO_STOP_TIMEOUT when a lock cannot clear', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-stop-timeout-'))
  fs.writeFileSync(path.join(root, 'daemon.lock'), '{}')
  try {
    await assert.rejects(
      stopOpenPhotoDataRoot(root, { timeoutMs: 20, pollMs: 5 }),
      error => error.code === 'OPENPHOTO_STOP_TIMEOUT' && error.dataRoot === root,
    )
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

// ---- 页面联动端到端：landing required 素材失败仍产出可审阅原型 → 首页关联其 prototype.html ----

test('联动链路：landing 生图失败产出诊断占位原型，批次 partially_failed 且首页拿到 prototype.html 关联', { timeout: 120_000, concurrency: false }, async () => {
  const { runBatch } = await import('../../runtime/batch-runner.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linkage-reviewable-e2e-'))
  const seen = []
  const landingBrief = { ...realBrief('alipay.landing'), id: 'brief-land-e2e' }
  const homeBrief = { ...realBrief('alipay.home'), id: 'brief-home-e2e' }
  const assetPolicy = { default: { source: 'generate', requirement: 'required' }, rules: [] }
  try {
    const result = await runBatch({
      mode: 'run',
      batchRequest: {
        schemaVersion: '1',
        batchId: 'batch-link-e2e',
        pageLinkage: {
          homeTheme: '夏日出游租赁',
          landingThemes: [{ theme: '夏日出游租赁' }],
        },
        items: [
          { itemId: 'item.land', brief: landingBrief, assetPolicy },
          { itemId: 'item.home', brief: homeBrief, assetPolicy },
        ],
      },
      batchRoot: root,
      sourceCommit: 'abc123',
      providerIdentity: { id: 'openai-compatible', model: 'gpt-image-2', baseURL: 'https://api.example.com/v1' },
      runItem: async ({ item, attemptRoot, linkage }) => {
        seen.push({ itemId: item.itemId, linkage })
        if (item.brief.deliverableType === 'alipay.landing') {
          // 真实落地页链路 + 生图必失败：required 素材失败，runDesign 返回 failed，
          // designLanding 已落盘的 prototype.html（默认素材基础包）仍可审阅。
          const orchestration = await runDesign({
            brief: { ...item.brief },
            skillRoots: [HOME_ROOT, LANDING_ROOT, IMAGE_GENERATE_ROOT],
            outputRoot: attemptRoot,
            bindings: {
              'page.alipay.landing.design': Object.assign(
                (value, context) => designLanding({ brief: value, outputRoot: attemptRoot, ...(context.failedAssets ? { failedAssets: context.failedAssets } : {}) }),
                { acceptsFailedAssets: true },
              ),
              'image.generate': async () => { throw new Error('生图服务不可用') },
            },
          })
          assert.equal(orchestration.status, 'failed')
          assert.ok(orchestration.steps.some((step) => step.name === 'image-generate' && step.status === 'failed'), 'required 素材失败必须记入 steps')
          return orchestration
        }
        // home 成功 mock：落盘发布合同要求的最小 attempt 产物（原型 + 配置）。
        fs.writeFileSync(path.join(attemptRoot, 'prototype.html'), '<!doctype html><html lang="zh"><body>mock home</body></html>')
        fs.writeFileSync(path.join(attemptRoot, 'home-config.json'), JSON.stringify({ page: { name: 'mock-home' } }))
        return { briefId: 'b', status: 'succeeded', selectedCapabilities: ['workflow.orchestrate'], steps: [], deliverable: { packageRoot: attemptRoot, designBriefId: 'b', files: [], sourceCommit: 'x' } }
      },
    })

    // 失败状态语义保留：landing failed、批次 partially_failed。
    assert.equal(result.status, 'partially_failed')
    const landingResult = result.items.find((i) => i.itemId === 'item.land')
    assert.equal(landingResult.status, 'failed')
    // 可审阅原型真实落盘（素材失败但基础包原型完整保留，可点击预览）。
    const prototypePath = path.join(root, 'other', 'runtime', 'items', 'item.land', 'attempts', '0001', 'prototype.html')
    assert.equal(fs.existsSync(prototypePath), true, '素材失败的 landing 必须产出可审阅原型')
    // 素材失败状态记录在最小视觉审阅报告（失败槽位不再伪装为 pending）。
    const review = JSON.parse(fs.readFileSync(path.join(root, 'other', 'runtime', 'items', 'item.land', 'attempts', '0001', 'visual-review.json'), 'utf8'))
    assert.ok(review.sections[0].entries.some((entry) => entry.rules === 'failed'), '素材失败槽位以 failed 状态登记')
    // landing item 收到联动上下文；home 拿到可审阅失败 landing 的 prototype.html ref。
    assert.equal(seen.find((s) => s.itemId === 'item.land').linkage.role, 'landing')
    const homeSeen = seen.find((s) => s.itemId === 'item.home')
    assert.equal(homeSeen.linkage.role, 'home')
    assert.deepEqual(
      homeSeen.linkage.landingThemes,
      [{ landingKey: 'landing-01', theme: '夏日出游租赁', source: 'orchestrator', landingPreviewRef: 'landing-01/prototype.html' }],
      '首页必须通过 landingPreviewRef 关联可审阅失败落地页（首页相对 prototype.html）',
    )
    // 原型已发布到首页交付目录（完整离线预览目录）。
    // 素材失败场景：图片槽位全部替换为诊断占位（原型无 img src），styles 依赖齐备；
    // 发布层按原型实际引用复制依赖，无引用即无 assets/ 目录（不产生死链）。
    const publishedDir = path.join(root, 'other', 'runtime', 'items', 'item.home', 'attempts', '0001', 'landing-01')
    const published = path.join(publishedDir, 'prototype.html')
    assert.equal(fs.existsSync(published), true, '可审阅失败落地页原型必须发布到首页交付目录')
    assert.ok(fs.statSync(published).size > 0)
    const publishedHtml = fs.readFileSync(published, 'utf8')
    assert.ok(publishedHtml.includes('素材生成失败'), '发布原型保留诊断占位')
    for (const style of ['tokens.css', 'base.css', 'landing.css']) {
      assert.ok(fs.existsSync(path.join(publishedDir, 'styles', style)), `发布目录缺少样式依赖：styles/${style}`)
    }
    assert.equal(/\b(?:src|href)="(?!#)[^"]+"/.test(publishedHtml.replace(/styles\/[^"]+/g, '')), false, '诊断占位原型不得残留未发布依赖的死链')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { canonicalize, assetKeyFor, createAssetStore } from '../../runtime/asset-store.mjs'

// 固定 2x1 多色 PNG（与 skill-image-generate 测试 provider 一致）。
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8AAQv8BD/kD/YURmXYAAAAASUVORK5CYII='

const request = {
  id: 'asset-req-001',
  usageSlot: 'home.hero.image',
  theme: '绿色蜥蜴猫在公园中',
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

/** 在临时目录写入合法 PNG，返回 { dir, filePath, sha256, result }。 */
function makeValidResult() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-store-test-'))
  const filePath = path.join(dir, 'asset.png')
  const bytes = Buffer.from(PNG_BASE64, 'base64')
  fs.writeFileSync(filePath, bytes)
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
  const result = {
    assetRequestId: request.id,
    artifactId: 'home-hero-image-gen',
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
  return { dir, filePath, result }
}

test('canonicalize 排序 object key 且稳定', () => {
  const a = canonicalize({ b: 1, a: { d: 2, c: 3 } })
  const b = canonicalize({ a: { c: 3, d: 2 }, b: 1 })
  assert.deepEqual(a, { a: { c: 3, d: 2 }, b: 1 })
  assert.deepEqual(a, b)
})

test('canonicalize 不同 array 顺序结果不同', () => {
  const a = canonicalize({ list: [1, 2] })
  const b = canonicalize({ list: [2, 1] })
  assert.notDeepEqual(a, b)
})

test('canonicalize 不同 prompt key 结果不同', () => {
  const a = canonicalize({ prompt: 'cat' })
  const b = canonicalize({ prompt: 'dog' })
  assert.notDeepEqual(a, b)
})

test('assetKeyFor 稳定且不依赖 key 顺序', () => {
  const k1 = assetKeyFor('fp', { a: 1, b: 2 }, 'src')
  const k2 = assetKeyFor('fp', { b: 2, a: 1 }, 'src')
  assert.equal(k1, k2)
  assert.match(k1, /^[a-f0-9]{64}$/)
})

test('assetKeyFor 拒绝空 itemFingerprint', () => {
  assert.throws(() => assetKeyFor('', request, 'src'))
  assert.throws(() => assetKeyFor(null, request, 'src'))
})

test('store 合法复用：get 返回副本且不修改原条目', async () => {
  const { dir, result } = makeValidResult()
  try {
    const store = createAssetStore()
    const key = assetKeyFor('fp', request, 'src')
    await store.put(key, result, { request })
    const got = await store.get(key, { request })
    assert.ok(got)
    assert.equal(got.sha256, result.sha256)
    // 修改返回副本不影响存储。
    got.notes.push('mutated')
    const again = await store.get(key, { request })
    assert.equal(again.notes.length, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('文件缺失自动 invalidate 并返回 null', async () => {
  const { dir, result } = makeValidResult()
  try {
    const store = createAssetStore()
    const key = assetKeyFor('fp', request, 'src')
    await store.put(key, result, { request })
    fs.rmSync(result.path, { force: true })
    const got = await store.get(key, { request })
    assert.equal(got, null)
    // 已 invalidate，再次 get 仍为 null。
    assert.equal(await store.get(key, { request }), null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('sha256 错自动 invalidate', async () => {
  const { dir, result } = makeValidResult()
  try {
    const key = assetKeyFor('fp', request, 'src')
    const bad = { ...result, sha256: '0'.repeat(64) }
    const store = createAssetStore({ entries: { [key]: { status: 'succeeded', result: bad } } })
    assert.equal(await store.get(key, { request }), null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('Schema 错自动 invalidate', async () => {
  const { dir, result } = makeValidResult()
  try {
    const key = assetKeyFor('fp', request, 'src')
    const bad = { ...result, width: 'not-a-number' }
    const store = createAssetStore({ entries: { [key]: { status: 'succeeded', result: bad } } })
    assert.equal(await store.get(key, { request }), null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('assetRequestId / 尺寸 / MIME / strict 错自动 invalidate', async () => {
  const { dir, result } = makeValidResult()
  try {
    const key = assetKeyFor('fp', request, 'src')
    const cases = [
      { ...result, assetRequestId: 'other-id' },
      { ...result, width: 99 },
      { ...result, mimeType: 'image/jpeg' },
      { ...result, strictSizeSatisfied: false },
    ]
    for (const bad of cases) {
      const store = createAssetStore({ entries: { [key]: { status: 'succeeded', result: bad } } })
      assert.equal(await store.get(key, { request }), null, `应拒绝: ${JSON.stringify(bad)}`)
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('put 拒绝非法结果且不写入', async () => {
  const { dir, result } = makeValidResult()
  try {
    const store = createAssetStore()
    const key = assetKeyFor('fp', request, 'src')
    // 文件缺失
    const missing = { ...result, path: path.join(dir, 'nope.png') }
    await assert.rejects(() => store.put(key, missing, { request }))
    assert.equal(await store.get(key, { request }), null)
    // Schema 错
    const badSchema = { ...result, width: 'x' }
    await assert.rejects(() => store.put(key, badSchema, { request }))
    assert.equal(await store.get(key, { request }), null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('相对 path 支持 sourceRoot 解析', async () => {
  const { dir, result } = makeValidResult()
  try {
    const store = createAssetStore({ sourceRoot: dir })
    const key = assetKeyFor('fp', request, 'src')
    const rel = { ...result, path: 'asset.png' }
    await store.put(key, rel, { request })
    const got = await store.get(key, { request })
    assert.ok(got)
    assert.equal(got.sha256, result.sha256)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('invalidate 记录 reason 并返回是否存在', async () => {
  const { dir, result } = makeValidResult()
  try {
    const store = createAssetStore()
    const key = assetKeyFor('fp', request, 'src')
    await store.put(key, result, { request })
    const existed = await store.invalidate(key, '手动失效')
    assert.equal(existed, true)
    assert.equal(await store.get(key, { request }), null)
    assert.equal(await store.invalidate('missing-key'), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ---- shared acceptance：aspect-ratio 请求的比例合格素材可缓存/恢复 ----

const aspectRequest = {
  ...request,
  id: 'asset-req-aspect',
  targetWidth: 1000,
  targetHeight: 1000,
  aspectRatio: '1:1',
  acceptance: { mode: 'aspect-ratio', maxAspectRatioError: 0.03 },
}

function makeAspectResult(dir, { width, height }) {
  const filePath = path.join(dir, `asset-${width}x${height}.png`)
  const bytes = Buffer.from(PNG_BASE64, 'base64')
  fs.writeFileSync(filePath, bytes)
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
  return {
    assetRequestId: aspectRequest.id,
    artifactId: `aspect-${width}x${height}`,
    path: filePath,
    mimeType: 'image/png',
    width,
    height,
    sha256,
    sourceSkill: 'skill-image-generate',
    sourceSkillVersion: '0.1.0',
    strictSizeSatisfied: false,
    notes: [],
  }
}

test('aspect-ratio 请求：比例合格但非精确尺寸的素材可 put/get（缓存与恢复）', async () => {
  const { dir } = makeValidResult()
  try {
    const store = createAssetStore()
    const key = assetKeyFor('fp-aspect', aspectRequest, 'src')
    // 1030x1000 理论恰 3% 边界（shared acceptance 含 epsilon 后通过）；
    // strictSizeSatisfied=false 且宽高不等于 target，旧 store 语义会拒绝。
    const proportional = makeAspectResult(dir, { width: 1030, height: 1000 })
    await store.put(key, proportional, { request: aspectRequest })
    const got = await store.get(key, { request: aspectRequest })
    assert.ok(got, '比例合格素材必须可缓存并恢复')
    assert.equal(got.width, 1030)
    assert.equal(got.height, 1000)
    assert.equal(got.strictSizeSatisfied, false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('aspect-ratio 请求：比例超差素材 put 拒绝、get 自动 invalidate', async () => {
  const { dir } = makeValidResult()
  try {
    // 1040x1000 = 4% 超出容差 → 拒绝缓存。
    const over = makeAspectResult(dir, { width: 1040, height: 1000 })
    const store = createAssetStore()
    const key = assetKeyFor('fp-aspect-over', aspectRequest, 'src')
    await assert.rejects(() => store.put(key, over, { request: aspectRequest }), /比例超出容差/)
    assert.equal(await store.get(key, { request: aspectRequest }), null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('exact-size 请求：非精确尺寸与 strict=false 仍被拒绝（旧语义不回归）', async () => {
  const { dir, result } = makeValidResult()
  try {
    const store = createAssetStore()
    const key = assetKeyFor('fp', request, 'src')
    // 同一文件、比例一致但尺寸不同（target 2x1，实际 4x2）→ exact-size 仍拒绝。
    const scaled = { ...result, width: 4, height: 2 }
    await assert.rejects(() => store.put(key, scaled, { request }), /尺寸不匹配/)
    assert.equal(await store.get(key, { request }), null)
    // 尺寸精确但 strict=false → 仍拒绝。
    const noStrict = { ...result, strictSizeSatisfied: false }
    await assert.rejects(() => store.put(key, noStrict, { request }), /strictSizeSatisfied/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

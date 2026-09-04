// CLI 测试：capabilities、request --file、request --json。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const bin = path.join(here, '..', 'bin', 'image-generate.mjs')
const PACKAGE_ROOT = path.resolve(here, '..')

async function cli(args, env = {}) {
  try {
    const { stdout } = await run(process.execPath, [bin, ...args], {
      cwd: PACKAGE_ROOT,
      env: { ...process.env, ...env },
    })
    return { code: 0, stdout }
  } catch (e) {
    return { code: e.code || 1, stdout: e.stdout || '' }
  }
}

test('capabilities 输出能力清单', async () => {
  const { code, stdout } = await cli(['capabilities'])
  assert.equal(code, 0)
  const parsed = JSON.parse(stdout)
  assert.equal(parsed.skillManifest.id, 'skill-image-generate')
  assert.ok(parsed.capabilities.some((c) => c.id === 'image.generate'))
})

test('request --file 生成并输出 AssetResult', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'image-gen-'))
  const reqFile = path.join(tmp, 'asset-request.json')
  fs.writeFileSync(
    reqFile,
    JSON.stringify({
      id: 'asset-req-cli',
      usageSlot: 'cli.hero',
      theme: '测试主题',
      targetWidth: 100,
      targetHeight: 100,
      aspectRatio: '1:1',
      format: 'png',
      fit: 'cover',
      safeArea: '中央',
      referenceImages: [],
      forbiddenContent: [],
      allowGenerate: true,
      allowEdit: false,
    }),
  )
  try {
    const { code, stdout } = await cli(['request', '--file', reqFile], { IMAGE_GENERATE_PROVIDER: 'test' })
    assert.equal(code, 0)
    const parsed = JSON.parse(stdout)
    assert.equal(parsed.ok, true)
    assert.equal(parsed.result.assetRequestId, 'asset-req-cli')
    assert.equal(parsed.result.mimeType, 'image/png')
    assert.equal(parsed.result.path, 'artifacts/cli-hero-gen.png')
    assert.ok(parsed.result.notes.includes('provider: test-provider'))
    // 清理本次 CLI 落盘
    fs.rmSync(path.join(PACKAGE_ROOT, 'artifacts'), { recursive: true, force: true })
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('request --json 生成并输出 AssetResult', async () => {
  const req = {
    id: 'asset-req-json',
    usageSlot: 'json.hero',
    theme: '测试',
    targetWidth: 64,
    targetHeight: 64,
    aspectRatio: '1:1',
    format: 'png',
    fit: 'cover',
    safeArea: '中央',
    referenceImages: [],
    forbiddenContent: [],
    allowGenerate: true,
    allowEdit: false,
  }
  try {
    const { code, stdout } = await cli(['request', '--json', JSON.stringify(req)], { IMAGE_GENERATE_PROVIDER: 'test' })
    assert.equal(code, 0)
    const parsed = JSON.parse(stdout)
    assert.equal(parsed.ok, true)
    assert.equal(parsed.result.assetRequestId, 'asset-req-json')
    assert.equal(parsed.result.width, 2)
    assert.equal(parsed.result.height, 1)
  } finally {
    fs.rmSync(path.join(PACKAGE_ROOT, 'artifacts'), { recursive: true, force: true })
  }
})

test('request 无参数时输出 USAGE 错误', async () => {
  const { code, stdout } = await cli(['request'])
  assert.equal(code, 1)
  const parsed = JSON.parse(stdout)
  assert.equal(parsed.code, 'USAGE')
})

test('非法 AssetRequest 输出稳定错误', async () => {
  const { code, stdout } = await cli(['request', '--json', '{"id":1}'])
  assert.equal(code, 1)
  const parsed = JSON.parse(stdout)
  assert.equal(parsed.code, 'INVALID_ASSET')
})

test('正常 CLI 缺 API key 时返回稳定错误', async () => {
  const emptyCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'image-gen-no-codex-'))
  const req = {
    id: 'asset-req-no-key', usageSlot: 'hero', theme: '测试', targetWidth: 1, targetHeight: 1,
    aspectRatio: '1:1', format: 'png', fit: 'cover', safeArea: '中央', referenceImages: [],
    forbiddenContent: [], allowGenerate: true, allowEdit: false,
  }
  try {
    const { code, stdout } = await cli(['request', '--json', JSON.stringify(req)], {
      CODEX_HOME: emptyCodexHome, IMAGE_GENERATE_PROVIDER: '', IMAGE_GENERATE_API_KEY: '', FAL_KEY: '',
    })
    assert.equal(code, 1)
    assert.equal(JSON.parse(stdout).code, 'MISSING_API_KEY')
  } finally {
    fs.rmSync(emptyCodexHome, { recursive: true, force: true })
  }
})

test('probe 非 openai-compatible 时返回 PROBE_UNSUPPORTED', async () => {
  const { code, stdout } = await cli(['probe'], { IMAGE_GENERATE_PROVIDER: 'test' })
  assert.equal(code, 1)
  assert.equal(JSON.parse(stdout).code, 'PROBE_UNSUPPORTED')
})

test('probe 缺配置时返回 PROBE_CONFIG_MISSING', async () => {
  const { code, stdout } = await cli(['probe'], { IMAGE_GENERATE_PROVIDER: 'openai-compatible' })
  assert.equal(code, 1)
  assert.equal(JSON.parse(stdout).code, 'PROBE_CONFIG_MISSING')
})

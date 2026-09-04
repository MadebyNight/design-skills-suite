// 生图核心测试：provider 注入、真实元数据、稳定错误。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { inflateSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import {
  generateAsset,
  testProvider,
  MissingApiKeyError,
  ProviderOutputError,
  resolveCodexProviderConfiguration,
  resolveProvider,
  SKILL_NAME,
  SKILL_VERSION,
} from '../runtime/generator.mjs'
import { validateAssetResult } from '../runtime/protocol.mjs'
import { validRequest } from './fixtures/valid-request.mjs'

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

test('testProvider 返回统一契约对象，bytes 为真实 2×1 多色 PNG', async () => {
  const result = await testProvider.generate()
  assert.equal(result.mimeType, 'image/png')
  assert.equal(result.responseMode, 'test')
  assert.equal(result.providerRequestId, null)
  assert.equal(result.revisedPrompt, null)
  const bytes = result.bytes
  assert.equal(bytes.readUInt32BE(16), 2)
  assert.equal(bytes.readUInt32BE(20), 1)
  const idatLength = bytes.readUInt32BE(33)
  const pixels = inflateSync(bytes.subarray(41, 41 + idatLength))
  assert.deepEqual([...pixels], [0, 255, 0, 0, 255, 0, 0, 255, 255])
})

test('注入 testProvider 生成，产出真实元数据', async () => {
  const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'image-generator-'))
  try {
    const result = await generateAsset(validRequest, { provider: testProvider, artifactRoot })

    // 固定 2×1 多色 PNG 的真实数据
    assert.equal(result.assetRequestId, 'asset-req-001')
    assert.equal(result.artifactId, 'home-hero-image-gen')
    assert.equal(result.mimeType, 'image/png')
    assert.equal(result.width, 2)
    assert.equal(result.height, 1)
    assert.match(result.sha256, /^[a-f0-9]{64}$/)
    assert.equal(result.sourceSkill, SKILL_NAME)
    assert.equal(result.sourceSkillVersion, SKILL_VERSION)

    // 目标 1920x380 与真实 2x1 不一致 => strictSizeSatisfied=false
    assert.equal(result.strictSizeSatisfied, false)

    // notes 记录 provider 与 model
    assert.ok(result.notes.includes('provider: test-provider'))
    assert.ok(result.notes.includes('model: test-fixed-png'))
    assert.ok(result.notes.some((n) => n.includes('strictSizeSatisfied=false')))

    // 落盘文件真实存在，且 path 指向它；sha256 与文件一致
    const filePath = result.path
    assert.equal(path.isAbsolute(filePath), true)
    assert.ok(fs.existsSync(filePath))
    const buf = fs.readFileSync(filePath)
    assert.equal(result.sha256, sha256Hex(buf))

    // 满足契约
    assert.deepEqual(validateAssetResult(result), [])
  } finally {
    fs.rmSync(artifactRoot, { recursive: true, force: true })
  }
})

test('目标尺寸等于真实尺寸时 strictSizeSatisfied=true', async () => {
  const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'image-generator-'))
  try {
    const req = { ...validRequest, targetWidth: 2, targetHeight: 1 }
    const result = await generateAsset(req, { provider: testProvider, artifactRoot })
    assert.equal(result.strictSizeSatisfied, true)
    assert.ok(!result.notes.some((n) => n.includes('strictSizeSatisfied=false')))
  } finally {
    fs.rmSync(artifactRoot, { recursive: true, force: true })
  }
})

test('自定义 provider 记录其 name/model 及非空 metadata', async () => {
  const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'image-generator-'))
  try {
    const custom = {
      name: 'fake-real-provider',
      model: 'stable-xl',
      async generate() {
        const { bytes } = await testProvider.generate()
        return {
          bytes,
          mimeType: 'image/png',
          providerRequestId: 'req-123',
          revisedPrompt: 'a refined prompt',
          responseMode: 'url',
        }
      },
    }
    const result = await generateAsset(validRequest, { provider: custom, artifactRoot })
    assert.ok(result.notes.includes('provider: fake-real-provider'))
    assert.ok(result.notes.includes('model: stable-xl'))
    assert.ok(result.notes.includes('providerRequestId: req-123'))
    assert.ok(result.notes.includes('revisedPrompt: a refined prompt'))
    assert.ok(result.notes.includes('responseMode: url'))
  } finally {
    fs.rmSync(artifactRoot, { recursive: true, force: true })
  }
})

test('provider 返回裸 Buffer 时抛稳定 ProviderOutputError', async () => {
  const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'image-generator-'))
  try {
    const bare = {
      name: 'bare',
      model: 'm',
      async generate() {
        const { bytes } = await testProvider.generate()
        return bytes
      },
    }
    await assert.rejects(generateAsset(validRequest, { provider: bare, artifactRoot }), (e) => {
      assert.ok(e instanceof ProviderOutputError)
      assert.equal(e.code, 'INVALID_PROVIDER_OUTPUT')
      return true
    })
    // 失败不落盘
    assert.deepEqual(fs.readdirSync(artifactRoot), [])
  } finally {
    fs.rmSync(artifactRoot, { recursive: true, force: true })
  }
})

test('provider 返回错误 MIME 时抛稳定 ProviderOutputError', async () => {
  const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'image-generator-'))
  try {
    const badMime = {
      name: 'bad-mime',
      model: 'm',
      async generate() {
        const { bytes } = await testProvider.generate()
        return { bytes, mimeType: 'image/jpeg', providerRequestId: null, revisedPrompt: null, responseMode: 'url' }
      },
    }
    await assert.rejects(generateAsset(validRequest, { provider: badMime, artifactRoot }), (e) => {
      assert.equal(e.code, 'INVALID_PROVIDER_OUTPUT')
      return true
    })
    assert.deepEqual(fs.readdirSync(artifactRoot), [])
  } finally {
    fs.rmSync(artifactRoot, { recursive: true, force: true })
  }
})

test('provider 返回非 PNG 字节时由 artifact-store 拒绝且不落盘', async () => {
  const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'image-generator-'))
  try {
    const notPng = {
      name: 'not-png',
      model: 'm',
      async generate() {
        return { bytes: Buffer.from('not a png'), mimeType: 'image/png', providerRequestId: null, revisedPrompt: null, responseMode: 'url' }
      },
    }
    await assert.rejects(generateAsset(validRequest, { provider: notPng, artifactRoot }), (e) => {
      assert.equal(e.code, 'UNSUPPORTED_PROVIDER_OUTPUT')
      return true
    })
    assert.deepEqual(fs.readdirSync(artifactRoot), [])
  } finally {
    fs.rmSync(artifactRoot, { recursive: true, force: true })
  }
})

test('provider 返回非法 responseMode 时抛稳定 ProviderOutputError', async () => {
  const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'image-generator-'))
  try {
    const badMode = {
      name: 'bad-mode',
      model: 'm',
      async generate() {
        const { bytes } = await testProvider.generate()
        return { bytes, mimeType: 'image/png', providerRequestId: null, revisedPrompt: null, responseMode: 'weird' }
      },
    }
    await assert.rejects(generateAsset(validRequest, { provider: badMode, artifactRoot }), (e) => {
      assert.equal(e.code, 'INVALID_PROVIDER_OUTPUT')
      return true
    })
    assert.deepEqual(fs.readdirSync(artifactRoot), [])
  } finally {
    fs.rmSync(artifactRoot, { recursive: true, force: true })
  }
})

test('未注入 provider 时抛稳定错误 MissingApiKeyError', async () => {
  await assert.rejects(generateAsset(validRequest, { env: { CODEX_HOME: path.join(os.tmpdir(), 'missing-codex-home') } }), (e) => {
    assert.ok(e instanceof MissingApiKeyError)
    assert.equal(e.code, 'MISSING_API_KEY')
    return true
  })
})

test('未显式配置生图 provider 时继承当前 Codex Agent 的 URL 与登录态', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'image-codex-config-'))
  try {
    fs.writeFileSync(path.join(codexHome, 'config.toml'), [
      'model_provider = "team"',
      'model = "gpt-5.6-sol"',
      '',
      '[model_providers.team]',
      'base_url = "https://gateway.example.com/v1"',
      'requires_openai_auth = true',
    ].join('\n'))
    fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'agent-key' }))

    const config = resolveCodexProviderConfiguration({ CODEX_HOME: codexHome })
    assert.equal(config.baseURL, 'https://gateway.example.com/v1')
    assert.equal(config.apiKey, 'agent-key')
    assert.equal(config.model, 'gpt-image-2')

    const provider = resolveProvider({ CODEX_HOME: codexHome })
    assert.equal(provider.name, 'openai-compatible')
    assert.equal(provider.baseURL, 'https://gateway.example.com/v1')
    assert.equal(provider.model, 'gpt-image-2')
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true })
  }
})

test('Codex provider 的 env_key 优先于 auth.json，显式 provider 仍优先于 Codex', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'image-codex-env-key-'))
  try {
    fs.writeFileSync(path.join(codexHome, 'config.toml'), [
      'model_provider = "team"',
      '[model_providers.team]',
      'base_url = "https://gateway.example.com"',
      'env_key = "TEAM_API_KEY"',
    ].join('\n'))
    fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'auth-key' }))

    const config = resolveCodexProviderConfiguration({ CODEX_HOME: codexHome, TEAM_API_KEY: 'env-key' })
    assert.equal(config.apiKey, 'env-key')
    assert.equal(resolveProvider({ CODEX_HOME: codexHome, IMAGE_GENERATE_PROVIDER: 'test' }).name, 'test-provider')
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true })
  }
})

test('Codex provider 仅在声明认证来源时复用凭据', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'image-codex-auth-scope-'))
  try {
    fs.writeFileSync(path.join(codexHome, 'config.toml'), [
      'model_provider = "anonymous"',
      '[model_providers.anonymous]',
      'base_url = "https://anonymous.example.com/v1"',
    ].join('\n'))
    fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'unrelated-key' }))
    assert.equal(resolveCodexProviderConfiguration({ CODEX_HOME: codexHome, OPENAI_API_KEY: 'also-unrelated' }), null)

    fs.writeFileSync(path.join(codexHome, 'config.toml'), [
      'model_provider = "openai-auth"',
      '[model_providers.openai-auth]',
      'base_url = "https://gateway.example.com/v1"',
      'requires_openai_auth = true',
    ].join('\n'))
    assert.equal(resolveCodexProviderConfiguration({ CODEX_HOME: codexHome, OPENAI_API_KEY: 'env-openai-key' }).apiKey, 'env-openai-key')
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true })
  }
})

test('显式选择 fal 时解析为 fal.ai provider', () => {
  const provider = resolveProvider({ IMAGE_GENERATE_PROVIDER: 'fal', FAL_KEY: 'configured', FAL_MODEL: 'openai/gpt-image-2' })
  assert.equal(provider.name, 'fal.ai')
  assert.equal(provider.model, 'openai/gpt-image-2')
})

test('Codex 配置不可用时兼容 FAL_KEY 回退', () => {
  const provider = resolveProvider({
    CODEX_HOME: path.join(os.tmpdir(), 'missing-codex-home'),
    FAL_KEY: 'configured',
    FAL_MODEL: 'openai/gpt-image-2',
  })
  assert.equal(provider.name, 'fal.ai')
  assert.equal(provider.model, 'openai/gpt-image-2')
})

test('IMAGE_GENERATE_PROVIDER=openai-compatible 解析为 openai-compatible provider', () => {
  const provider = resolveProvider({
    IMAGE_GENERATE_PROVIDER: 'openai-compatible',
    IMAGE_API_BASE_URL: 'https://api.example.com',
    IMAGE_API_KEY: 'key',
    IMAGE_API_MODEL: 'gpt-image-2',
  })
  assert.equal(provider.name, 'openai-compatible')
  assert.equal(provider.model, 'gpt-image-2')
})

test('openai-compatible 缺 baseURL/key 时抛 MissingApiKeyError', () => {
  assert.throws(
    () => resolveProvider({ IMAGE_GENERATE_PROVIDER: 'openai-compatible' }),
    (e) => e instanceof MissingApiKeyError && e.code === 'MISSING_API_KEY',
  )
})

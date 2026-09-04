import assert from 'node:assert/strict'
import test from 'node:test'
import { createFalProvider, FalProviderError } from '../runtime/fal-provider.mjs'
import { testProvider } from '../runtime/generator.mjs'
import { validRequest } from './fixtures/valid-request.mjs'

test('fal provider 使用官方 subscribe 输入并下载 PNG', async () => {
  const { bytes: png } = await testProvider.generate()
  const calls = []
  const client = {
    config(value) { calls.push({ config: value }) },
    async subscribe(endpoint, options) {
      calls.push({ endpoint, options })
      return { data: { images: [{ url: 'https://example.test/result.png', width: 1, height: 1 }] } }
    },
  }
  const provider = createFalProvider({
    apiKey: 'fal-key',
    endpoint: 'openai/gpt-image-2',
    falClient: client,
    fetchImpl: async url => ({ ok: true, status: 200, arrayBuffer: async () => png, url }),
  })
  const result = await provider.generate(validRequest)
  assert.equal(result.mimeType, 'image/png')
  assert.equal(result.responseMode, 'url')
  assert.equal(result.providerRequestId, null)
  assert.equal(result.revisedPrompt, null)
  assert.deepEqual(result.bytes, png)
  assert.equal(calls[1].endpoint, 'openai/gpt-image-2')
  assert.deepEqual(calls[1].options.input.image_size, { width: 1920, height: 380 })
  assert.equal(calls[1].options.input.output_format, 'png')
  assert.match(calls[1].options.input.prompt, /当前槽位：home\.hero\.image/)
  assert.match(calls[1].options.input.prompt, /只生成当前槽位的一张独立平面素材/)
})

test('fal provider 透传 requestId 与 revised_prompt', async () => {
  const { bytes: png } = await testProvider.generate()
  const client = {
    async subscribe() {
      return {
        requestId: 'fal-req-42',
        data: { images: [{ url: 'https://example.test/result.png' }], revised_prompt: 'refined by fal' },
      }
    },
  }
  const provider = createFalProvider({
    apiKey: 'key',
    falClient: client,
    fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => png }),
  })
  const result = await provider.generate(validRequest)
  assert.equal(result.providerRequestId, 'fal-req-42')
  assert.equal(result.revisedPrompt, 'refined by fal')
})

test('fal provider 缺 key、缺输出和下载失败返回稳定错误', async () => {
  assert.throws(() => createFalProvider(), error => error.code === 'MISSING_API_KEY')
  const noOutput = createFalProvider({ apiKey: 'key', falClient: { subscribe: async () => ({ data: {} }) } })
  await assert.rejects(() => noOutput.generate(validRequest), error => error.code === 'FAL_OUTPUT_INVALID')
  const failedDownload = createFalProvider({
    apiKey: 'key',
    falClient: { subscribe: async () => ({ data: { images: [{ url: 'https://example.test/a.png' }] } }) },
    fetchImpl: async () => ({ ok: false, status: 503 }),
  })
  await assert.rejects(() => failedDownload.generate(validRequest), error => error instanceof FalProviderError && error.code === 'FAL_DOWNLOAD_FAILED')
})

test('fal 模型错误保留机器可读 type/context', async () => {
  const provider = createFalProvider({
    apiKey: 'key',
    falClient: {
      async subscribe() {
        const error = new Error('validation failed')
        error.body = { detail: [{ type: 'image_too_large', msg: 'too large', ctx: { max_width: 1024 } }] }
        throw error
      },
    },
  })
  await assert.rejects(() => provider.generate(validRequest), error => {
    assert.equal(error.code, 'FAL_REQUEST_FAILED')
    assert.equal(error.details[0].type, 'image_too_large')
    assert.equal(error.details[0].context.max_width, 1024)
    return true
  })
})

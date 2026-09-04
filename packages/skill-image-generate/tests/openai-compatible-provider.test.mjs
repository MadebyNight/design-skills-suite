// OpenAI-compatible provider 测试：mock fetch 覆盖 b64_json/url/错误矩阵/secret 不泄漏。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOpenAICompatibleProvider, OpenAICompatibleProviderError, normalizeBaseURL, decodeB64 } from '../runtime/openai-compatible-provider.mjs'
import { testProvider } from '../runtime/generator.mjs'
import { validRequest } from './fixtures/valid-request.mjs'

const SECRET = 'sk-super-secret-key'

function jsonResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  }
}

function makeProvider({ fetchImpl, baseURL = 'https://api.example.com', ...rest } = {}) {
  return createOpenAICompatibleProvider({
    baseURL,
    apiKey: SECRET,
    model: 'gpt-image-2',
    fetchImpl,
    clientRequestIdFactory: () => 'client-id-1',
    ...rest,
  })
}

// 构造真实 Response：headers 立即返回，body 永不结束；signal abort 时以 AbortError 拒绝读取。
// 用于覆盖 response.json / response.arrayBuffer 的完整响应体读取超时。
function neverEndingResponse(signal, status, headers = {}) {
  const stream = new ReadableStream({
    start(controller) {
      signal.addEventListener('abort', () => {
        controller.error(new DOMException('The operation was aborted.', 'AbortError'))
      })
    },
  })
  return new Response(stream, { status, headers })
}

test('normalizeBaseURL 去尾斜杠并兼容 /v1', () => {
  assert.equal(normalizeBaseURL('https://api.example.com/'), 'https://api.example.com/v1')
  assert.equal(normalizeBaseURL('https://api.example.com/v1/'), 'https://api.example.com/v1')
  assert.equal(normalizeBaseURL('https://api.example.com/v1'), 'https://api.example.com/v1')
})

test('b64_json 返回统一 ProviderResult，请求只含 model+prompt', async () => {
  const { bytes: png } = await testProvider.generate()
  let captured
  const provider = makeProvider({
    fetchImpl: async (url, options) => {
      captured = { url, options }
      return jsonResponse(200, { data: [{ b64_json: png.toString('base64'), revised_prompt: 'refined' }] }, { 'x-request-id': 'srv-9' })
    },
  })
  const result = await provider.generate(validRequest)
  assert.equal(result.mimeType, 'image/png')
  assert.equal(result.responseMode, 'b64_json')
  assert.equal(result.providerRequestId, 'srv-9')
  assert.equal(result.revisedPrompt, 'refined')
  assert.deepEqual(result.bytes, png)

  assert.equal(captured.url, 'https://api.example.com/v1/images/generations')
  const body = JSON.parse(captured.options.body)
  assert.deepEqual(Object.keys(body).sort(), ['model', 'prompt'])
  assert.equal(body.model, 'gpt-image-2')
  assert.match(body.prompt, new RegExp(validRequest.theme))
  assert.match(body.prompt, /当前槽位：home\.hero\.image/)
  assert.match(body.prompt, /目标比例：1920:380/)
  assert.match(body.prompt, /安全区：重要内容位于中央安全区/)
  assert.match(body.prompt, /禁止内容：文字水印；logo/)
  assert.equal(captured.options.headers.Authorization, `Bearer ${SECRET}`)
  assert.equal(captured.options.headers['Content-Type'], 'application/json')
  assert.equal(captured.options.headers['X-Client-Request-Id'], 'client-id-1')
})

test('url 模式下载并返回 responseMode=url', async () => {
  const { bytes: png } = await testProvider.generate()
  const provider = makeProvider({
    fetchImpl: async (url, options) => {
      if (url === 'https://api.example.com/v1/images/generations') {
        return jsonResponse(200, { data: [{ url: 'https://cdn.example.com/img.png' }] })
      }
      return { ok: true, status: 200, arrayBuffer: async () => png }
    },
  })
  const result = await provider.generate(validRequest)
  assert.equal(result.responseMode, 'url')
  assert.deepEqual(result.bytes, png)
})

test('providerRequestId 回退到 client id', async () => {
  const { bytes: png } = await testProvider.generate()
  const provider = makeProvider({
    fetchImpl: async () => jsonResponse(200, { data: [{ b64_json: png.toString('base64') }] }),
  })
  const result = await provider.generate(validRequest)
  assert.equal(result.providerRequestId, 'client-id-1')
})

test('401/403 返回 UNAUTHORIZED', async () => {
  for (const status of [401, 403]) {
    const provider = makeProvider({ fetchImpl: async () => jsonResponse(status, {}) })
    await assert.rejects(() => provider.generate(validRequest), (e) => {
      assert.ok(e instanceof OpenAICompatibleProviderError)
      assert.equal(e.code, 'IMAGE_PROVIDER_UNAUTHORIZED')
      assert.equal(e.status, status)
      return true
    })
  }
})

test('404 返回 NOT_FOUND', async () => {
  const provider = makeProvider({ fetchImpl: async () => jsonResponse(404, {}) })
  await assert.rejects(() => provider.generate(validRequest), (e) => {
    assert.equal(e.code, 'IMAGE_PROVIDER_NOT_FOUND')
    return true
  })
})

test('429 返回 RATE_LIMITED 且 retryable', async () => {
  const provider = makeProvider({ fetchImpl: async () => jsonResponse(429, {}) })
  await assert.rejects(() => provider.generate(validRequest), (e) => {
    assert.equal(e.code, 'IMAGE_PROVIDER_RATE_LIMITED')
    assert.equal(e.retryable, true)
    return true
  })
})

test('5xx 返回 SERVER_ERROR 且 retryable', async () => {
  const provider = makeProvider({ fetchImpl: async () => jsonResponse(503, {}) })
  await assert.rejects(() => provider.generate(validRequest), (e) => {
    assert.equal(e.code, 'IMAGE_PROVIDER_SERVER_ERROR')
    assert.equal(e.retryable, true)
    return true
  })
})

test('timeout 返回 TIMEOUT，generation outcomeUnknown=true', async () => {
  const provider = makeProvider({
    timeoutMs: 10,
    fetchImpl: async (url, options) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('should not reach')), 50)
        options.signal.addEventListener('abort', () => {
          clearTimeout(timer)
          const e = new Error('aborted')
          e.name = 'AbortError'
          reject(e)
        })
      })
    },
  })
  await assert.rejects(() => provider.generate(validRequest), (e) => {
    assert.equal(e.code, 'IMAGE_PROVIDER_TIMEOUT')
    assert.equal(e.retryable, true)
    assert.equal(e.outcomeUnknown, true)
    assert.equal(e.phase, 'generation')
    return true
  })
})

test('generation response.json 超时（headers 已返回、body 永不结束）=> TIMEOUT 且保留 requestId', async () => {
  let provider
  provider = makeProvider({
    timeoutMs: 10,
    fetchImpl: async (_url, options) => neverEndingResponse(options.signal, 200, { 'x-request-id': 'srv-timeout' }),
  })
  await assert.rejects(() => provider.generate(validRequest), (e) => {
    assert.equal(e.code, 'IMAGE_PROVIDER_TIMEOUT')
    assert.equal(e.outcomeUnknown, true)
    assert.equal(e.phase, 'generation')
    assert.equal(e.retryable, true)
    assert.equal(e.requestId, 'srv-timeout')
    return true
  })
})

test('generation 非 Abort 网络错误仍返回 SERVER_ERROR，而不是 OUTPUT_INVALID', async () => {
  const provider = makeProvider({
    fetchImpl: async () => { throw new TypeError('socket reset') },
  })
  await assert.rejects(() => provider.generate(validRequest), (e) => {
    assert.equal(e.code, 'IMAGE_PROVIDER_SERVER_ERROR')
    assert.equal(e.retryable, true)
    assert.equal(e.outcomeUnknown, true)
    assert.equal(e.phase, 'generation')
    return true
  })
})

test('generation JSON 语法错误仍返回 OUTPUT_INVALID', async () => {
  const provider = makeProvider({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'srv-invalid-json' },
      async json() { throw new SyntaxError('Unexpected token') },
    }),
  })
  await assert.rejects(() => provider.generate(validRequest), (e) => {
    assert.equal(e.code, 'IMAGE_PROVIDER_OUTPUT_INVALID')
    assert.equal(e.requestId, 'srv-invalid-json')
    return true
  })
})

test('url 下载 arrayBuffer 超时（body 永不结束）=> TIMEOUT、outcomeUnknown=false 且保留 generation requestId', async () => {
  let provider
  provider = makeProvider({
    downloadTimeoutMs: 10,
    fetchImpl: async (url, options) => {
      if (url === 'https://api.example.com/v1/images/generations') {
        return jsonResponse(200, { data: [{ url: 'https://cdn.example.com/img.png' }] }, { 'x-request-id': 'srv-gen' })
      }
      return neverEndingResponse(options.signal, 200)
    },
  })
  await assert.rejects(() => provider.generate(validRequest), (e) => {
    assert.equal(e.code, 'IMAGE_PROVIDER_TIMEOUT')
    assert.equal(e.outcomeUnknown, false)
    assert.equal(e.phase, 'download')
    assert.equal(e.retryable, true)
    assert.equal(e.requestId, 'srv-gen')
    return true
  })
})

test('空 data 返回 OUTPUT_INVALID', async () => {
  const provider = makeProvider({ fetchImpl: async () => jsonResponse(200, { data: [] }) })
  await assert.rejects(() => provider.generate(validRequest), (e) => {
    assert.equal(e.code, 'IMAGE_PROVIDER_OUTPUT_INVALID')
    return true
  })
})

test('decodeB64 安全判定：合法 PNG 通过，空/非法字符/错误 padding 拒绝', async () => {
  const { bytes: png } = await testProvider.generate()
  const valid = png.toString('base64')
  assert.ok(decodeB64(valid))
  assert.equal(decodeB64(''), null)
  assert.equal(decodeB64('A'), null) // 长度非 4 倍数
  assert.equal(decodeB64('!!!not-base64!!!'), null) // 非法字符
  assert.equal(decodeB64('AAAA='), null) // 错误 padding
  assert.equal(decodeB64('AA==='), null) // 多余 padding
  assert.equal(decodeB64('===='), null) // 纯 padding
  assert.equal(decodeB64('AA=A'), null) // padding 不在末尾
})

test('b64_json 为纯 padding 返回 OUTPUT_INVALID', async () => {
  const provider = makeProvider({ fetchImpl: async () => jsonResponse(200, { data: [{ b64_json: '====' }] }) })
  await assert.rejects(() => provider.generate(validRequest), (e) => {
    assert.equal(e.code, 'IMAGE_PROVIDER_OUTPUT_INVALID')
    return true
  })
})

test('url 下载失败返回 DOWNLOAD_FAILED 且 phase=download', async () => {
  const provider = makeProvider({
    fetchImpl: async (url) => {
      if (url === 'https://api.example.com/v1/images/generations') {
        return jsonResponse(200, { data: [{ url: 'https://cdn.example.com/img.png' }] })
      }
      return { ok: false, status: 404 }
    },
  })
  await assert.rejects(() => provider.generate(validRequest), (e) => {
    assert.equal(e.code, 'IMAGE_PROVIDER_DOWNLOAD_FAILED')
    assert.equal(e.phase, 'download')
    return true
  })
})

test('url 下载超时返回 TIMEOUT，outcomeUnknown=false 且 phase=download', async () => {
  const provider = makeProvider({
    fetchImpl: async (url) => {
      if (url === 'https://api.example.com/v1/images/generations') {
        return jsonResponse(200, { data: [{ url: 'https://cdn.example.com/img.png' }] })
      }
      const e = new Error('aborted')
      e.name = 'AbortError'
      throw e
    },
  })
  await assert.rejects(() => provider.generate(validRequest), (e) => {
    assert.equal(e.code, 'IMAGE_PROVIDER_TIMEOUT')
    assert.equal(e.outcomeUnknown, false)
    assert.equal(e.phase, 'download')
    return true
  })
})

test('非 PNG 字节由 generateAsset 拒绝（UNSUPPORTED_PROVIDER_OUTPUT）', async () => {
  const { generateAsset } = await import('../runtime/generator.mjs')
  const provider = makeProvider({
    fetchImpl: async () => jsonResponse(200, { data: [{ b64_json: Buffer.from('not a png').toString('base64') }] }),
  })
  await assert.rejects(() => generateAsset(validRequest, { provider }), (e) => {
    assert.equal(e.code, 'UNSUPPORTED_PROVIDER_OUTPUT')
    return true
  })
})

test('secret 不出现在错误 message 与 JSON', async () => {
  const provider = makeProvider({ fetchImpl: async () => jsonResponse(500, {}) })
  try {
    await provider.generate(validRequest)
    assert.fail('应抛出错误')
  } catch (e) {
    const json = JSON.stringify(e)
    assert.ok(!json.includes(SECRET))
    assert.ok(!e.message.includes(SECRET))
  }
})

test('缺 baseURL/apiKey 返回 CONFIG_MISSING', () => {
  assert.throws(() => createOpenAICompatibleProvider({ apiKey: 'k' }), (e) => e.code === 'IMAGE_PROVIDER_CONFIG_MISSING')
  assert.throws(() => createOpenAICompatibleProvider({ baseURL: 'https://x' }), (e) => e.code === 'IMAGE_PROVIDER_CONFIG_MISSING')
})

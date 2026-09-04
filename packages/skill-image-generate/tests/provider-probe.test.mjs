// Provider 探测测试：默认只调 /models，strong 才调用 generate。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { probeProvider } from '../runtime/provider-probe.mjs'
import { testProvider } from '../runtime/generator.mjs'

const SECRET = 'sk-probe-secret'

function jsonResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  }
}

const config = { baseURL: 'https://api.example.com', apiKey: SECRET, model: 'gpt-image-2' }

test('默认探测只调 /models，模型存在 => ready，含 modelsCheck 与 latency', async () => {
  const calls = []
  const result = await probeProvider({
    providerConfig: config,
    fetchImpl: async (url) => {
      calls.push(url)
      return jsonResponse(200, { data: [{ id: 'gpt-image-2' }] })
    },
  })
  assert.equal(result.status, 'ready')
  assert.equal(result.model, 'gpt-image-2')
  assert.deepEqual(calls, ['https://api.example.com/v1/models'])
  assert.equal(result.modelsCheck.status, 200)
  assert.equal(typeof result.modelsCheck.latencyMs, 'number')
  assert.equal(typeof result.latencyMs, 'number')
})

test('model 缺省默认 gpt-image-2', async () => {
  const result = await probeProvider({
    providerConfig: { baseURL: 'https://api.example.com', apiKey: SECRET },
    fetchImpl: async () => jsonResponse(200, { data: [{ id: 'gpt-image-2' }] }),
  })
  assert.equal(result.model, 'gpt-image-2')
})

test('401/403 => unavailable，含 modelsCheck', async () => {
  for (const status of [401, 403]) {
    const result = await probeProvider({
      providerConfig: config,
      fetchImpl: async () => jsonResponse(status, {}),
    })
    assert.equal(result.status, 'unavailable')
    assert.equal(result.modelsCheck.status, status)
  }
})

test('404/405 models 不支持 => degraded', async () => {
  for (const status of [404, 405]) {
    const result = await probeProvider({
      providerConfig: config,
      fetchImpl: async () => jsonResponse(status, {}),
    })
    assert.equal(result.status, 'degraded')
    assert.equal(result.modelsCheck.status, status)
  }
})

test('模型未列出 => degraded', async () => {
  const result = await probeProvider({
    providerConfig: config,
    fetchImpl: async () => jsonResponse(200, { data: [{ id: 'other-model' }] }),
  })
  assert.equal(result.status, 'degraded')
  assert.equal(result.modelsCheck.status, 200)
})

test('5xx => unavailable', async () => {
  const result = await probeProvider({
    providerConfig: config,
    fetchImpl: async () => jsonResponse(500, {}),
  })
  assert.equal(result.status, 'unavailable')
  assert.equal(result.modelsCheck.status, 500)
})

test('strong=true 才调用 generate 并验证 PNG，含 modelsCheck 与 metadata', async () => {
  const { bytes: png } = await testProvider.generate()
  const calls = []
  const result = await probeProvider({
    providerConfig: config,
    strong: true,
    fetchImpl: async (url) => {
      calls.push(url)
      if (url === 'https://api.example.com/v1/models') {
        return jsonResponse(200, { data: [{ id: 'gpt-image-2' }] })
      }
      return jsonResponse(200, { data: [{ b64_json: png.toString('base64') }] }, { 'x-request-id': 'srv-1' })
    },
  })
  assert.equal(result.status, 'ready')
  assert.equal(result.width, 2)
  assert.equal(result.height, 1)
  assert.match(result.sha256, /^[a-f0-9]{64}$/)
  assert.equal(typeof result.latencyMs, 'number')
  assert.equal(result.modelsCheck.status, 200)
  assert.equal(typeof result.modelsCheck.latencyMs, 'number')
  assert.equal(result.providerRequestId, 'srv-1')
  assert.equal(result.responseMode, 'b64_json')
  assert.equal(calls.length, 2)
})

test('strong 生成失败（models 正常）=> invalid 并保留 code', async () => {
  const result = await probeProvider({
    providerConfig: config,
    strong: true,
    fetchImpl: async (url) => {
      if (url === 'https://api.example.com/v1/models') return jsonResponse(200, { data: [{ id: 'gpt-image-2' }] })
      return jsonResponse(500, {})
    },
  })
  assert.equal(result.status, 'invalid')
  assert.equal(result.code, 'IMAGE_PROVIDER_SERVER_ERROR')
  assert.equal(result.modelsCheck.status, 200)
})

test('strong 返回非 PNG => invalid', async () => {
  const result = await probeProvider({
    providerConfig: config,
    strong: true,
    fetchImpl: async (url) => {
      if (url === 'https://api.example.com/v1/models') return jsonResponse(200, { data: [{ id: 'gpt-image-2' }] })
      return jsonResponse(200, { data: [{ b64_json: Buffer.from('not a png').toString('base64') }] })
    },
  })
  assert.equal(result.status, 'invalid')
})

test('strong 时 models 404 不阻断，生成成功 => ready 并保留 modelsCheck', async () => {
  const { bytes: png } = await testProvider.generate()
  const result = await probeProvider({
    providerConfig: config,
    strong: true,
    fetchImpl: async (url) => {
      if (url === 'https://api.example.com/v1/models') return jsonResponse(404, {})
      return jsonResponse(200, { data: [{ b64_json: png.toString('base64') }] })
    },
  })
  assert.equal(result.status, 'ready')
  assert.equal(result.modelsCheck.status, 404)
})

test('strong 时模型未列出不阻断，生成成功 => ready', async () => {
  const { bytes: png } = await testProvider.generate()
  const result = await probeProvider({
    providerConfig: config,
    strong: true,
    fetchImpl: async (url) => {
      if (url === 'https://api.example.com/v1/models') return jsonResponse(200, { data: [{ id: 'other-model' }] })
      return jsonResponse(200, { data: [{ b64_json: png.toString('base64') }] })
    },
  })
  assert.equal(result.status, 'ready')
  assert.equal(result.modelsCheck.status, 200)
})

test('strong 时 models 5xx 不阻断，生成成功 => ready', async () => {
  const { bytes: png } = await testProvider.generate()
  const result = await probeProvider({
    providerConfig: config,
    strong: true,
    fetchImpl: async (url) => {
      if (url === 'https://api.example.com/v1/models') return jsonResponse(500, {})
      return jsonResponse(200, { data: [{ b64_json: png.toString('base64') }] })
    },
  })
  assert.equal(result.status, 'ready')
  assert.equal(result.modelsCheck.status, 500)
})

test('strong 时 models 5xx 且生成失败 => unavailable 并保留 code', async () => {
  const result = await probeProvider({
    providerConfig: config,
    strong: true,
    fetchImpl: async (url) => {
      if (url === 'https://api.example.com/v1/models') return jsonResponse(500, {})
      return jsonResponse(500, {})
    },
  })
  assert.equal(result.status, 'unavailable')
  assert.equal(result.code, 'IMAGE_PROVIDER_SERVER_ERROR')
  assert.equal(result.modelsCheck.status, 500)
})

test('strong 时 401/403 阻断，不调用 generate', async () => {
  const calls = []
  const result = await probeProvider({
    providerConfig: config,
    strong: true,
    fetchImpl: async (url) => {
      calls.push(url)
      return jsonResponse(401, {})
    },
  })
  assert.equal(result.status, 'unavailable')
  assert.equal(calls.length, 1)
})

test('secret 不出现在结果 JSON', async () => {
  const result = await probeProvider({
    providerConfig: config,
    fetchImpl: async () => jsonResponse(401, {}),
  })
  assert.ok(!JSON.stringify(result).includes(SECRET))
})

test('缺配置 => PROBE_CONFIG_MISSING', async () => {
  await assert.rejects(() => probeProvider({ providerConfig: {} }), (e) => e.code === 'PROBE_CONFIG_MISSING')
})

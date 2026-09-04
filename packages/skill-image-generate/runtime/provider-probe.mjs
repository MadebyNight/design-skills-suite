// Provider 探测：默认只调 GET <baseURL>/models，不产生费用；strong=true 才调用 generate。
//
// 状态语义：
//  - ready：models 可达且模型存在（或 strong 生成成功）
//  - degraded：models 端点不支持（404/405）或模型未列出但端点可达
//  - unavailable：401/403 或网络/超时等不可达
//  - invalid：配置缺失或响应结构非法
//
// strong=true 时，只有 401/403 与配置非法会阻断；404/405、模型未列出、models 5xx、
// network/timeout 均继续真实 generate，生成成功 => ready 并保留 modelsCheck。
//
// 不泄露 API key；错误与结果 JSON 均不含 key/header。
import { createOpenAICompatibleProvider, OpenAICompatibleProviderError, normalizeBaseURL } from './openai-compatible-provider.mjs'
import { readPngDimensions } from './artifact-store.mjs'
import crypto from 'node:crypto'

const MODELS_TIMEOUT_MS = 30_000

export class ProbeError extends Error {
  constructor(code, message, details = []) {
    super(message)
    this.code = code
    this.details = details
  }
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/**
 * 探测 provider 可用性。
 * @param {object} opts { providerConfig, fetchImpl, strong=false, tempRoot? }
 *   providerConfig: { baseURL, apiKey, model? }（model 缺省 gpt-image-2）
 * @returns {Promise<object>} { status, model, modelsCheck?, latencyMs?, ... }
 */
export async function probeProvider({ providerConfig, fetchImpl = globalThis.fetch, strong = false, tempRoot } = {}) {
  if (!providerConfig || typeof providerConfig !== 'object') {
    throw new ProbeError('PROBE_CONFIG_MISSING', '缺少 providerConfig')
  }
  const { baseURL, apiKey } = providerConfig
  const model = providerConfig.model || 'gpt-image-2'
  if (!baseURL || !apiKey) {
    throw new ProbeError('PROBE_CONFIG_MISSING', '缺少 baseURL 或 apiKey')
  }

  let normalizedBaseURL
  try {
    normalizedBaseURL = normalizeBaseURL(baseURL)
  } catch (e) {
    throw new ProbeError('PROBE_CONFIG_MISSING', e.message)
  }

  // 默认探测：GET <baseURL>/models，测量 latency。
  const modelsUrl = `${normalizedBaseURL}/models`
  let modelsStatus
  let modelsLatencyMs
  let modelListed = false
  const modelsStarted = Date.now()
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), MODELS_TIMEOUT_MS)
    let response
    try {
      response = await fetchImpl(modelsUrl, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
    modelsLatencyMs = Date.now() - modelsStarted
    modelsStatus = response.status
    if (response.ok) {
      const data = await response.json()
      const ids = Array.isArray(data?.data) ? data.data.map((m) => m && m.id) : []
      modelListed = ids.includes(model)
    }
  } catch (e) {
    modelsLatencyMs = Date.now() - modelsStarted
    modelsStatus = e && e.name === 'AbortError' ? 'timeout' : 'network'
  }

  const modelsCheck = { status: modelsStatus, reason: null, latencyMs: modelsLatencyMs }

  // 401/403 与配置非法：无论 strong 与否都阻断。
  if (modelsStatus === 401 || modelsStatus === 403) {
    return { status: 'unavailable', model, reason: `models 端点认证失败：HTTP ${modelsStatus}`, modelsCheck }
  }

  // 默认（非 strong）探测语义：不调用 generate。
  if (!strong) {
    if (modelsStatus === 404 || modelsStatus === 405) {
      modelsCheck.reason = 'models 端点不支持'
      return { status: 'degraded', model, reason: `models 端点不支持：HTTP ${modelsStatus}`, modelsCheck }
    }
    if (modelsStatus === 'timeout' || modelsStatus === 'network') {
      modelsCheck.reason = `models 端点不可达：${modelsStatus}`
      return { status: 'unavailable', model, reason: `models 端点不可达：${modelsStatus}`, modelsCheck }
    }
    if (modelsStatus >= 500) {
      modelsCheck.reason = `models 端点服务端错误：HTTP ${modelsStatus}`
      return { status: 'unavailable', model, reason: `models 端点服务端错误：HTTP ${modelsStatus}`, modelsCheck }
    }
    if (modelsStatus !== 200) {
      modelsCheck.reason = `models 端点异常：HTTP ${modelsStatus}`
      return { status: 'unavailable', model, reason: `models 端点异常：HTTP ${modelsStatus}`, modelsCheck }
    }
    if (!modelListed) {
      modelsCheck.reason = '模型未在 models 列表中列出'
      return { status: 'degraded', model, reason: '模型未在 models 列表中列出', modelsCheck }
    }
    return { status: 'ready', model, latencyMs: modelsLatencyMs, modelsCheck }
  }

  // strong：除 401/403 外，models 检查不阻断，继续真实 generate。
  const provider = createOpenAICompatibleProvider({ baseURL, apiKey, model, fetchImpl })
  const started = Date.now()
  let result
  try {
    result = await provider.generate({
      id: 'probe',
      usageSlot: 'probe',
      theme: 'a minimal test image',
      targetWidth: 1,
      targetHeight: 1,
      aspectRatio: '1:1',
      format: 'png',
      fit: 'cover',
      safeArea: 'center',
      referenceImages: [],
      forbiddenContent: [],
      allowGenerate: true,
      allowEdit: false,
    })
  } catch (e) {
    const latencyMs = Date.now() - started
    const code = e && e.code ? e.code : undefined
    // 生成失败：models 检查异常 => unavailable；否则 => invalid。
    const status = modelsStatus !== 200 ? 'unavailable' : 'invalid'
    return {
      status,
      model,
      reason: e && e.message ? e.message : 'strong 探测生成失败',
      code,
      latencyMs,
      modelsCheck,
    }
  }
  const latencyMs = Date.now() - started

  let dims
  try {
    dims = readPngDimensions(result.bytes)
  } catch (e) {
    return {
      status: 'invalid',
      model,
      reason: 'strong 探测返回非 PNG 字节',
      code: e && e.code ? e.code : undefined,
      latencyMs,
      modelsCheck,
    }
  }

  return {
    status: 'ready',
    model,
    latencyMs,
    width: dims.width,
    height: dims.height,
    sha256: sha256Hex(result.bytes),
    providerRequestId: result.providerRequestId,
    responseMode: result.responseMode,
    modelsCheck,
  }
}

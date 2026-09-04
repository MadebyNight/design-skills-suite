// OpenAI-compatible 图片 provider：POST <baseURL>/images/generations。
//
// 遵循官方研究结论：
//  - MVP 请求体只发送 model + prompt，不发送 output_format/response_format/size/quality/n；
//  - 支持 data[0].b64_json 与兼容网关的 data[0].url；
//  - 强制输出 PNG 由 Batch2A 的 artifact-store 校验，本 provider 只产出统一 ProviderResult。
//
// 错误码前缀 IMAGE_PROVIDER_*，错误对象可含 status/requestId/retryable/outcomeUnknown/details，
// 但绝不包含 API key 或请求头。
import crypto from 'node:crypto'
import { buildAssetPrompt } from './protocol.mjs'

const DOWNLOAD_TIMEOUT_MS = 120_000

export class OpenAICompatibleProviderError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.code = code
    if (extra.status !== undefined) this.status = extra.status
    if (extra.requestId !== undefined) this.requestId = extra.requestId
    if (extra.retryable !== undefined) this.retryable = extra.retryable
    if (extra.outcomeUnknown !== undefined) this.outcomeUnknown = extra.outcomeUnknown
    if (extra.phase !== undefined) this.phase = extra.phase
    if (extra.details !== undefined) this.details = extra.details
  }
}

/**
 * 安全解码 base64：拒绝空字节、非法字符、错误 padding 与长度非 4 的倍数。
 * 返回 Buffer（非空）或 null。不校验 PNG magic（由 artifact-store / strong probe 负责）。
 */
export function decodeB64(str) {
  if (typeof str !== 'string' || str.length === 0) return null
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(str)) return null
  if (str.length % 4 !== 0) return null
  const pad = str.indexOf('=')
  if (pad !== -1) {
    const tail = str.slice(pad)
    if (!/^={1,2}$/.test(tail)) return null
    if (tail.length === 2 && pad < 2) return null
  }
  const bytes = Buffer.from(str, 'base64')
  if (bytes.length === 0) return null
  return bytes
}

/** 规范化 baseURL：去尾斜杠，兼容传入 /v1（未带则追加）。 */
export function normalizeBaseURL(baseURL) {
  const raw = String(baseURL || '').trim()
  if (!raw) throw new OpenAICompatibleProviderError('IMAGE_PROVIDER_CONFIG_MISSING', '缺少 baseURL')
  let url = raw.replace(/\/+$/, '')
  if (!/\/v1$/.test(url)) url = `${url}/v1`
  return url
}

function errorFromStatus(status, requestId) {
  if (status === 401 || status === 403) {
    return new OpenAICompatibleProviderError('IMAGE_PROVIDER_UNAUTHORIZED', `认证失败：HTTP ${status}`, { status, requestId })
  }
  if (status === 404) {
    return new OpenAICompatibleProviderError('IMAGE_PROVIDER_NOT_FOUND', `资源不存在：HTTP ${status}`, { status, requestId })
  }
  if (status === 429) {
    return new OpenAICompatibleProviderError('IMAGE_PROVIDER_RATE_LIMITED', `请求被限流：HTTP ${status}`, { status, requestId, retryable: true })
  }
  if (status >= 500) {
    return new OpenAICompatibleProviderError('IMAGE_PROVIDER_SERVER_ERROR', `服务端错误：HTTP ${status}`, { status, requestId, retryable: true })
  }
  return new OpenAICompatibleProviderError('IMAGE_PROVIDER_SERVER_ERROR', `请求失败：HTTP ${status}`, { status, requestId })
}

/**
 * 在单个 AbortController/timer 生命周期内运行 operation(信号)，
 * 使其覆盖「fetch + 状态检查 + 完整响应体读取」整个阶段，ms 为总时限。
 * 超时（AbortError）映射为 IMAGE_PROVIDER_TIMEOUT：
 *  - generation：outcomeUnknown=true；download：outcomeUnknown=false。
 *  - requestId 可为值或函数（函数在超时时求值，以保留到 abort 时已取得的 header）。
 */
async function withTimeout(operation, { ms, phase, requestId }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await operation(controller.signal)
  } catch (e) {
    if (e && e.name === 'AbortError') {
      const resolvedId = typeof requestId === 'function' ? requestId() : requestId
      const extra = { retryable: true, outcomeUnknown: phase === 'generation', phase }
      if (resolvedId !== undefined) extra.requestId = resolvedId
      throw new OpenAICompatibleProviderError('IMAGE_PROVIDER_TIMEOUT', `请求超时（${ms}ms）`, extra)
    }
    throw e
  } finally {
    clearTimeout(timer)
  }
}

export function createOpenAICompatibleProvider({
  baseURL,
  apiKey,
  model = 'gpt-image-2',
  fetchImpl = globalThis.fetch,
  timeoutMs = 300_000,
  downloadTimeoutMs = DOWNLOAD_TIMEOUT_MS,
  clientRequestIdFactory = () => crypto.randomUUID(),
} = {}) {
  if (!baseURL) throw new OpenAICompatibleProviderError('IMAGE_PROVIDER_CONFIG_MISSING', '缺少 baseURL')
  if (!apiKey) throw new OpenAICompatibleProviderError('IMAGE_PROVIDER_CONFIG_MISSING', '缺少 apiKey')
  if (typeof fetchImpl !== 'function') {
    throw new OpenAICompatibleProviderError('IMAGE_PROVIDER_CONFIG_MISSING', '当前 Node 环境缺少 fetch')
  }

  const normalizedBaseURL = normalizeBaseURL(baseURL)

  return {
    name: 'openai-compatible',
    model,
    baseURL: normalizedBaseURL,
    async generate(request) {
      const clientId = clientRequestIdFactory()
      const url = `${normalizedBaseURL}/images/generations`
      const body = { model, prompt: buildAssetPrompt(request) }
      // generation 的 POST fetch + 状态检查 + 完整 JSON 读取在同一个 AbortController/timer
      // 生命周期内，timeoutMs 为总时限；requestId 在超时时求值以保留到 abort 时已取得的 header。
      const requestId = () =>
        (response && response.headers && typeof response.headers.get === 'function' && response.headers.get('x-request-id')) || clientId

      let response
      let data
      try {
        ;({ response, data } = await withTimeout(
          async (signal) => {
            const res = await fetchImpl(url, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'X-Client-Request-Id': clientId,
              },
              body: JSON.stringify(body),
              signal,
            })
            response = res
            if (!res.ok) throw errorFromStatus(res.status, requestId())
            return { response: res, data: await res.json() }
          },
          { ms: timeoutMs, phase: 'generation', requestId },
        ))
      } catch (e) {
        if (e instanceof OpenAICompatibleProviderError) throw e
        if (e instanceof SyntaxError) {
          throw new OpenAICompatibleProviderError('IMAGE_PROVIDER_OUTPUT_INVALID', '响应不是合法 JSON', {
            requestId: requestId(),
            details: [e.message],
          })
        }
        throw new OpenAICompatibleProviderError('IMAGE_PROVIDER_SERVER_ERROR', '请求失败', {
          requestId: requestId(),
          retryable: true,
          outcomeUnknown: true,
          phase: 'generation',
          details: [e && e.message ? e.message : String(e)],
        })
      }

      const item = Array.isArray(data?.data) ? data.data[0] : null
      if (!item || typeof item !== 'object') {
        throw new OpenAICompatibleProviderError('IMAGE_PROVIDER_OUTPUT_INVALID', '响应缺少 data[0]', { requestId: requestId() })
      }
      const revisedPrompt = typeof item.revised_prompt === 'string' ? item.revised_prompt : null

      if (typeof item.b64_json === 'string' && item.b64_json) {
        const bytes = decodeB64(item.b64_json)
        if (!bytes) {
          throw new OpenAICompatibleProviderError('IMAGE_PROVIDER_OUTPUT_INVALID', 'b64_json 解码失败或为空', { requestId: requestId() })
        }
        return { bytes, mimeType: 'image/png', providerRequestId: requestId(), revisedPrompt, responseMode: 'b64_json' }
      }

      if (typeof item.url === 'string' && item.url) {
        let bytes
        try {
          // download 的 GET fetch + 状态检查 + 完整 arrayBuffer 读取在同一个 AbortController/timer
          // 生命周期内，downloadTimeoutMs 为总时限；保留 generation 阶段的 requestId。
          bytes = await withTimeout(
            async (signal) => {
              const resp = await fetchImpl(item.url, { method: 'GET', signal })
              if (!resp.ok) {
                throw new OpenAICompatibleProviderError('IMAGE_PROVIDER_DOWNLOAD_FAILED', `图片下载失败：HTTP ${resp.status}`, { requestId: requestId(), phase: 'download' })
              }
              const buf = Buffer.from(await resp.arrayBuffer())
              if (buf.length === 0) {
                throw new OpenAICompatibleProviderError('IMAGE_PROVIDER_DOWNLOAD_FAILED', '图片下载为空', { requestId: requestId(), phase: 'download' })
              }
              return buf
            },
            { ms: downloadTimeoutMs, phase: 'download', requestId: requestId() },
          )
        } catch (e) {
          if (e instanceof OpenAICompatibleProviderError) throw e
          throw new OpenAICompatibleProviderError('IMAGE_PROVIDER_DOWNLOAD_FAILED', '图片下载失败', {
            requestId: requestId(),
            retryable: true,
            phase: 'download',
            details: [e && e.message ? e.message : String(e)],
          })
        }
        return { bytes, mimeType: 'image/png', providerRequestId: requestId(), revisedPrompt, responseMode: 'url' }
      }

      throw new OpenAICompatibleProviderError('IMAGE_PROVIDER_OUTPUT_INVALID', 'data[0] 缺少 b64_json 或 url', { requestId: requestId() })
    },
  }
}

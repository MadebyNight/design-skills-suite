import { buildAssetPrompt } from './protocol.mjs'

const DEFAULT_ENDPOINT = 'openai/gpt-image-2'

export class FalProviderError extends Error {
  constructor(code, message, details = []) {
    super(message)
    this.code = code
    this.details = details
  }
}

function imageUrlFrom(data) {
  const first = Array.isArray(data?.images) ? data.images[0] : data?.image
  if (typeof first === 'string') return first
  if (first && typeof first === 'object' && typeof first.url === 'string') return first.url
  if (typeof data?.url === 'string') return data.url
  return null
}

function errorDetails(error) {
  const body = error && typeof error === 'object' ? error.body : null
  if (!body || typeof body !== 'object') return []
  if (Array.isArray(body.detail)) {
    return body.detail.map(item => ({
      type: item?.type || 'unknown',
      message: item?.msg || item?.message || String(item),
      context: item?.ctx,
    }))
  }
  if (typeof body.detail === 'string') return [{ type: body.error_type || 'request_error', message: body.detail }]
  return []
}

export function createFalProvider({
  apiKey,
  endpoint = DEFAULT_ENDPOINT,
  falClient,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!apiKey) throw new FalProviderError('MISSING_API_KEY', 'FAL_KEY 未配置')
  if (typeof fetchImpl !== 'function') throw new FalProviderError('FETCH_UNAVAILABLE', '当前 Node 环境缺少 fetch')

  return {
    name: 'fal.ai',
    model: endpoint,
    async generate(request) {
      let client = falClient
      if (!client) {
        const { fal } = await import('@fal-ai/client')
        fal.config({ credentials: apiKey, suppressLocalCredentialsWarning: true })
        client = fal
      } else if (typeof client.config === 'function') {
        client.config({ credentials: apiKey, suppressLocalCredentialsWarning: true })
      }

      let result
      try {
        result = await client.subscribe(endpoint, {
          input: {
            prompt: buildAssetPrompt(request),
            image_size: { width: request.targetWidth, height: request.targetHeight },
            quality: 'high',
            num_images: 1,
            output_format: 'png',
          },
        })
      } catch (error) {
        throw new FalProviderError(
          'FAL_REQUEST_FAILED',
          error instanceof Error ? error.message : 'fal.ai 请求失败',
          errorDetails(error),
        )
      }

      const url = imageUrlFrom(result?.data)
      if (!url) throw new FalProviderError('FAL_OUTPUT_INVALID', 'fal.ai 未返回可识别的图片 URL')
      let response
      try {
        response = await fetchImpl(url)
      } catch (error) {
        throw new FalProviderError('FAL_DOWNLOAD_FAILED', error instanceof Error ? error.message : '图片下载失败')
      }
      if (!response.ok) throw new FalProviderError('FAL_DOWNLOAD_FAILED', `图片下载失败：HTTP ${response.status}`)
      const bytes = Buffer.from(await response.arrayBuffer())

      // 官方 data 中若带 revised_prompt 则透传；否则为 null。
      const revisedPrompt =
        typeof result?.data?.revised_prompt === 'string' ? result.data.revised_prompt : null

      return {
        bytes,
        mimeType: 'image/png',
        providerRequestId: result?.requestId ?? null,
        revisedPrompt,
        responseMode: 'url',
      }
    },
  }
}

export { DEFAULT_ENDPOINT }

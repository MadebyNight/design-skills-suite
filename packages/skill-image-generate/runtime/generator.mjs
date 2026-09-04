// 生图核心：驱动 provider 产出图片字节，落盘并组装 AssetResult。
//
// 边界：
//  - generator 不关心 provider 是真实 API 还是测试桩，只依赖其可注入接口：
//      provider.generate(request) => Promise<ProviderResult>
//  - ProviderResult 统一为 { bytes, mimeType, providerRequestId, revisedPrompt, responseMode }。
//  - generator 不接受裸 Buffer；非法输出抛稳定 ProviderOutputError（code=INVALID_PROVIDER_OUTPUT）。
//  - 提供 testProvider：返回固定 PNG，不依赖真实凭据，仅供显式测试。
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { writeArtifact } from './artifact-store.mjs'
import { PACKAGE_ROOT } from './protocol.mjs'
import { createFalProvider } from './fal-provider.mjs'
import { createOpenAICompatibleProvider } from './openai-compatible-provider.mjs'

const { default: pkg } = await import('../package.json', { with: { type: 'json' } })
export const SKILL_NAME = pkg.name
export const SKILL_VERSION = pkg.version
export const ARTIFACT_OUT_DIR = path.join(PACKAGE_ROOT, 'artifacts')

// 固定 2x1 多色 PNG 的 base64。测试 provider 无论请求尺寸如何都返回该字节，
// 以如实体现 strictSizeSatisfied 的判定（真实尺寸对比目标尺寸），并保持 OpenPhoto
// 适配 1920px 横幅时单轴 scale 不超过 1000。
const FIXED_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8AAQv8BD/kD/YURmXYAAAAASUVORK5CYII='

/** 默认测试 provider：返回固定 PNG，无需 API Key，始终可用。 */
export const testProvider = {
  name: 'test-provider',
  model: 'test-fixed-png',
  async generate(/* request */) {
    return {
      bytes: Buffer.from(FIXED_PNG_BASE64, 'base64'),
      mimeType: 'image/png',
      providerRequestId: null,
      revisedPrompt: null,
      responseMode: 'test',
    }
  },
}

/** provider 输出非法时的稳定错误。 */
export class ProviderOutputError extends Error {
  constructor(message, details = []) {
    super(message)
    this.code = 'INVALID_PROVIDER_OUTPUT'
    this.details = details
  }
}

/** 校验 provider 输出契约对象，非法时抛 ProviderOutputError。 */
function assertProviderResult(result) {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    throw new ProviderOutputError('provider 输出必须是对象', ['期望 { bytes, mimeType, ... }'])
  }
  if (!Buffer.isBuffer(result.bytes)) {
    throw new ProviderOutputError('provider 输出缺少 Buffer 类型的 bytes', ['bytes 必须是 Buffer'])
  }
  if (result.mimeType !== 'image/png') {
    throw new ProviderOutputError(`provider 输出 MIME 类型不受支持: ${result.mimeType}`, ['仅支持 image/png'])
  }
  if (result.providerRequestId !== null && result.providerRequestId !== undefined && typeof result.providerRequestId !== 'string') {
    throw new ProviderOutputError('providerRequestId 必须是字符串或 null')
  }
  if (result.revisedPrompt !== null && result.revisedPrompt !== undefined && typeof result.revisedPrompt !== 'string') {
    throw new ProviderOutputError('revisedPrompt 必须是字符串或 null')
  }
  if (result.responseMode !== 'test' && result.responseMode !== 'url' && result.responseMode !== 'sdk' && result.responseMode !== 'b64_json') {
    throw new ProviderOutputError(`responseMode 不受支持: ${result.responseMode}`, ['仅支持 test|url|sdk|b64_json'])
  }
}

/** 缺失 API key 时的稳定错误。 */
export class MissingApiKeyError extends Error {
  constructor() {
    super('未找到可用生图凭据：请配置当前 Codex Agent，或设置 IMAGE_API_KEY（openai-compatible）/ FAL_KEY（fal）')
    this.code = 'MISSING_API_KEY'
  }
}

function parseTomlValue(raw) {
  const value = raw.trim()
  if (value === 'true') return true
  if (value === 'false') return false
  if (value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value) } catch { return value.slice(1, -1) }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1)
  return value
}

function parseCodexConfig(text) {
  const tables = { '': {} }
  let section = ''
  for (const line of text.split(/\r?\n/)) {
    const table = line.match(/^\s*\[([^\]]+)]\s*(?:#.*)?$/)
    if (table) {
      section = table[1].trim()
      tables[section] ||= {}
      continue
    }
    const pair = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*("(?:\\.|[^"\\])*"|'[^']*'|true|false|[^#\s]+)\s*(?:#.*)?$/)
    if (pair) tables[section][pair[1]] = parseTomlValue(pair[2])
  }
  return tables
}

/**
 * 从当前 Codex Agent 配置继承 provider URL 与认证，不返回或持久化 secret。
 * 仅使用图片模型覆盖项；Codex 当前文本模型不会被误用于生图。
 */
export function resolveCodexProviderConfiguration(env = process.env) {
  const codexHome = env.CODEX_HOME || path.join(os.homedir(), '.codex')
  const configPath = path.join(codexHome, 'config.toml')
  const authPath = path.join(codexHome, 'auth.json')
  if (!fs.existsSync(configPath)) return null

  let tables
  try {
    tables = parseCodexConfig(fs.readFileSync(configPath, 'utf8'))
  } catch {
    return null
  }

  const root = tables[''] || {}
  const profile = typeof root.profile === 'string' ? (tables[`profiles.${root.profile}`] || {}) : {}
  const providerId = profile.model_provider || root.model_provider || 'openai'
  const provider = tables[`model_providers.${providerId}`] || {}
  const baseURL = provider.base_url || profile.openai_base_url || root.openai_base_url || profile.base_url || root.base_url || (providerId === 'openai' ? 'https://api.openai.com/v1' : null)

  let apiKey = provider.env_key ? env[provider.env_key] : null
  if (!apiKey && typeof provider.experimental_bearer_token === 'string') {
    apiKey = provider.experimental_bearer_token
  }
  const usesOpenAIAuth = provider.requires_openai_auth === true || providerId === 'openai'
  if (!apiKey && usesOpenAIAuth) apiKey = env.OPENAI_API_KEY || null
  if (!apiKey && usesOpenAIAuth && fs.existsSync(authPath)) {
    try {
      const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'))
      apiKey = typeof auth.OPENAI_API_KEY === 'string' ? auth.OPENAI_API_KEY : null
    } catch {
      apiKey = null
    }
  }
  if (!baseURL || !apiKey) return null

  return {
    baseURL,
    apiKey,
    model: env.IMAGE_API_MODEL || 'gpt-image-2',
  }
}

export function resolveProvider(env = process.env) {
  const providerName = env.IMAGE_GENERATE_PROVIDER
  if (providerName === 'test') return testProvider
  if (providerName === 'openai-compatible') {
    const baseURL = env.IMAGE_API_BASE_URL
    const apiKey = env.IMAGE_API_KEY
    if (!baseURL || !apiKey) throw new MissingApiKeyError()
    return createOpenAICompatibleProvider({
      baseURL,
      apiKey,
      model: env.IMAGE_API_MODEL || 'gpt-image-2',
    })
  }
  if (!providerName) {
    const codexConfig = resolveCodexProviderConfiguration(env)
    if (codexConfig) return createOpenAICompatibleProvider(codexConfig)
  }
  // 显式 fal，或 Codex 配置不可用时保持现有 FAL_KEY 兼容行为。
  const apiKey = env.FAL_KEY || env.IMAGE_GENERATE_API_KEY
  if (!apiKey) throw new MissingApiKeyError()
  return createFalProvider({ apiKey, endpoint: env.FAL_MODEL || 'openai/gpt-image-2' })
}

/** 用 usageSlot（回退 id）派生稳定 artifactId。 */
function artifactIdFor(request) {
  const base = (request.usageSlot || request.id || 'asset').replace(/[^a-zA-Z0-9_-]/g, '-')
  return `${base}-gen`
}

/**
 * 执行生图并输出 AssetResult。
 *
 * 未注入 provider 时按 resolveProvider 的显式配置 → 当前 Codex Agent → 兼容回退顺序解析；
 * 全部不可用时抛 MissingApiKeyError（稳定错误）。测试可显式注入 testProvider。
 *
 * @param {object} request 已通过校验的 AssetRequest
 * @param {object} options { provider, artifactRoot? } 可注入 provider；缺省表示真实路径。
 * artifactRoot 指向本次生成专用目录时，AssetResult.path 返回绝对路径。
 */
export async function generateAsset(request, options = {}) {
  const provider = options.provider || resolveProvider(options.env)

  const providerResult = await provider.generate(request)
  assertProviderResult(providerResult)

  const fileName = `${artifactIdFor(request)}.png`

  const meta = writeArtifact(providerResult.bytes, {
    fileName,
    mimeType: providerResult.mimeType,
    targetWidth: request.targetWidth,
    targetHeight: request.targetHeight,
    artifactRoot: options.artifactRoot || options.outputDir,
  })

  const notes = []
  notes.push(`provider: ${provider.name}`)
  notes.push(`model: ${provider.model || 'unknown'}`)
  if (providerResult.providerRequestId) {
    notes.push(`providerRequestId: ${providerResult.providerRequestId}`)
  }
  if (providerResult.revisedPrompt) {
    notes.push(`revisedPrompt: ${providerResult.revisedPrompt}`)
  }
  if (providerResult.responseMode) {
    notes.push(`responseMode: ${providerResult.responseMode}`)
  }
  if (request.format.toLowerCase() !== 'png') {
    notes.push(`provider 实际返回 PNG，未满足请求格式 ${request.format}`)
  }
  if (!meta.strictSizeSatisfied) {
    notes.push(
      `真实尺寸 ${meta.width}x${meta.height} 不等于目标 ${request.targetWidth}x${request.targetHeight}，strictSizeSatisfied=false`,
    )
  }

  return {
    assetRequestId: request.id,
    artifactId: artifactIdFor(request),
    path: meta.path,
    mimeType: meta.mimeType,
    width: meta.width,
    height: meta.height,
    sha256: meta.sha256,
    sourceSkill: SKILL_NAME,
    sourceSkillVersion: SKILL_VERSION,
    strictSizeSatisfied: meta.strictSizeSatisfied,
    notes,
  }
}

// 3B：指纹与 provider 身份脱敏。
//
// 纯函数：只做规范化、哈希与脱敏，不做 IO。
// canonicalize 复用 asset-store 的实现，避免循环依赖（asset-store 不 import 本模块）。
import crypto from 'node:crypto'
import { canonicalize } from './asset-store.mjs'

/**
 * 对任意值做稳定 SHA256 指纹：先 canonicalize（object key 排序、array 保序），再 JSON 序列化后哈希。
 * @param {unknown} value
 * @returns {string} 64 位十六进制 SHA256
 */
export function fingerprint(value) {
  const payload = JSON.stringify(canonicalize(value))
  return crypto.createHash('sha256').update(payload).digest('hex')
}

/**
 * 规范化 URL 的 host+path 部分（去掉协议、查询、凭据），用于生成 baseUrlFingerprint。
 * 不保存完整 URL，避免泄露查询参数或凭据。
 * @param {string} baseURL
 * @returns {string} 规范化后的 host+path
 */
export function normalizeBaseUrl(baseURL) {
  if (typeof baseURL !== 'string' || baseURL.length === 0) return ''
  try {
    const url = new URL(baseURL)
    // 去掉协议、查询、hash、端口默认值；保留 host + pathname。
    const host = url.hostname.toLowerCase()
    const port = url.port ? `:${url.port}` : ''
    const pathname = url.pathname.replace(/\/+$/, '') || '/'
    return `${host}${port}${pathname}`
  } catch {
    // 非 URL 字符串：仅取 host:port/path 形态的稳定片段。
    return baseURL.replace(/^[a-z]+:\/\//i, '').split(/[?#]/)[0].replace(/\/+$/, '')
  }
}

/**
 * 脱敏 provider 身份：只保存 id/model 与 baseUrlFingerprint（SHA256 规范化 host+path），
 * 不保存完整 URL、API key 或任何 secret。
 * @param {object} identity { id, model, baseURL }
 * @returns {{ id: string, model: string, baseUrlFingerprint: string }}
 */
export function sanitizeProviderIdentity({ id, model, baseURL } = {}) {
  if (typeof id !== 'string' || id.length === 0) throw new Error('provider id 必须是非空字符串')
  if (typeof model !== 'string' || model.length === 0) throw new Error('provider model 必须是非空字符串')
  const normalized = normalizeBaseUrl(baseURL)
  return {
    id,
    model,
    baseUrlFingerprint: fingerprint(normalized),
  }
}

/**
 * 派生请求指纹：对 request 做稳定 SHA256。
 * @param {object} request
 * @returns {string}
 */
export function requestFingerprint(request) {
  return fingerprint(request)
}

/**
 * 派生 item 指纹：对 item 内容做稳定 SHA256。
 * @param {object} item
 * @returns {string}
 */
export function itemFingerprint(item) {
  return fingerprint(item)
}

export default fingerprint

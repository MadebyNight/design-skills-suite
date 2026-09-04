// C2.2：素材存储层。
//
// 职责：以 assetKey 为键缓存 AssetResult，并在读取/写入前做严格校验。
// 校验项（与 C2.2 计划一致）：entry status=succeeded、AssetResult Schema、
// 文件存在、sha256 匹配；request 约束（assetRequestId/尺寸/MIME/strict）统一
// 复用 shared acceptance（validateAssetResultForRequest），不在此复制验收规则。
// 校验失败自动 invalidate 并返回 null（get）或拒绝写入（put）。
//
// 边界：本层不决定素材内容，只负责缓存与校验；不把 API key / provider secret
// 纳入 assetKey（key 仅由 canonical request + policySource 派生）。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { validateAssetResult } from '../../skill-image-generate/runtime/protocol.mjs'
import { validateAssetResultForRequest } from './asset-acceptance.mjs'

/**
 * 递归规范化：对象 key 排序，数组保序，标量原样返回。
 * 用于生成稳定、可复现的 assetKey。
 * @param {unknown} value
 * @returns {unknown}
 */
export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalize(value[key])
    }
    return out
  }
  return value
}

/**
 * 派生稳定 assetKey：SHA256(canonical(itemFingerprint) + canonical(request) + policySource)。
 * itemFingerprint 必须为非空字符串；request 与 policySource 只取规范化后的内容，
 * 不包含任何 API key / provider secret。
 * @param {string} itemFingerprint
 * @param {object} request
 * @param {string} policySource
 * @returns {string} 64 位十六进制 SHA256
 */
export function assetKeyFor(itemFingerprint, request, policySource) {
  if (typeof itemFingerprint !== 'string' || itemFingerprint.length === 0) {
    throw new Error('itemFingerprint 必须是非空字符串')
  }
  const payload = JSON.stringify({
    itemFingerprint,
    request: canonicalize(request),
    policySource,
  })
  return crypto.createHash('sha256').update(payload).digest('hex')
}

/**
 * 创建内存素材存储。
 * @param {object} [options]
 * @param {object} [options.entries] 初始条目 { assetKey: { status, result, reason? } }
 * @param {Function} [options.validateAssetResult] 自定义 AssetResult 校验器，缺省复用
 *                                                 skill-image-generate 的 validateAssetResult。
 * @param {string} [options.sourceRoot] 相对 path 的解析根目录。
 * @returns {{
 *   get(assetKey, {request?}): Promise<object|null>,
 *   put(assetKey, result, {request?}): Promise<string>,
 *   invalidate(assetKey, reason?): Promise<boolean>,
 * }}
 */
export function createAssetStore({ entries = {}, validateAssetResult: customValidate, sourceRoot } = {}) {
  const store = new Map()
  for (const [key, entry] of Object.entries(entries)) {
    store.set(key, {
      ...entry,
      result: entry.result ? structuredClone(entry.result) : entry.result,
    })
  }
  const validateResult = customValidate || validateAssetResult

  /** 解析产物路径：绝对路径原样返回，相对路径基于 sourceRoot 解析。 */
  function resolvePath(p) {
    if (path.isAbsolute(p)) return p
    if (sourceRoot) return path.resolve(sourceRoot, p)
    return p
  }

  /** 严格校验 AssetResult；返回 null 表示通过，否则返回失败原因字符串。
   * 文件存在与 sha256 由本层负责；request 约束统一走共享验收
   * （validateAssetResultForRequest），exact-size 与 aspect-ratio 行为一致。 */
  function verifyResult(result, request) {
    if (result === null || typeof result !== 'object' || Array.isArray(result)) {
      return 'AssetResult 必须是对象'
    }
    const errors = validateResult(result)
    if (errors && errors.length > 0) {
      return `AssetResult Schema 校验失败: ${errors.join('；')}`
    }
    const filePath = resolvePath(result.path)
    if (!fs.existsSync(filePath)) {
      return `文件不存在: ${result.path}`
    }
    const bytes = fs.readFileSync(filePath)
    const sha = crypto.createHash('sha256').update(bytes).digest('hex')
    if (sha !== result.sha256) {
      return 'sha256 与文件内容不匹配'
    }
    if (request) {
      const requestErrors = validateAssetResultForRequest(request, result)
      if (requestErrors.length > 0) {
        return requestErrors.join('；')
      }
    }
    return null
  }

  /**
   * 读取缓存。校验失败自动 invalidate 并返回 null，同时记录 reason。
   * @param {string} assetKey
   * @param {object} [opts.request] 可选 AssetRequest，用于严格尺寸/MIME 校验。
   * @returns {Promise<object|null>} 通过校验的 AssetResult 副本，否则 null。
   */
  async function get(assetKey, { request } = {}) {
    const entry = store.get(assetKey)
    if (!entry) return null
    if (entry.status !== 'succeeded') {
      await invalidate(assetKey, `status 非 succeeded: ${entry.status}`)
      return null
    }
    const reason = verifyResult(entry.result, request)
    if (reason) {
      await invalidate(assetKey, reason)
      return null
    }
    return structuredClone(entry.result)
  }

  /**
   * 写入缓存。写入前严格校验（含 request 约束），失败抛错且不写入。
   * 成功时存 result 的深拷贝。
   * @param {string} assetKey
   * @param {object} result AssetResult
   * @param {object} [opts.request] 可选 AssetRequest，用于严格尺寸/MIME 校验。
   * @returns {Promise<string>} assetKey
   */
  async function put(assetKey, result, { request } = {}) {
    const reason = verifyResult(result, request)
    if (reason) {
      throw new Error(`put 拒绝: ${reason}`)
    }
    store.set(assetKey, { status: 'succeeded', result: structuredClone(result) })
    return assetKey
  }

  /**
   * 使缓存失效并记录 reason。
   * @param {string} assetKey
   * @param {string} [reason]
   * @returns {Promise<boolean>} 是否存在该条目
   */
  async function invalidate(assetKey, reason) {
    const entry = store.get(assetKey)
    if (entry) {
      store.set(assetKey, { ...entry, status: 'invalidated', reason: reason || 'invalidated' })
    }
    return Boolean(entry)
  }

  return { get, put, invalidate }
}

export default createAssetStore

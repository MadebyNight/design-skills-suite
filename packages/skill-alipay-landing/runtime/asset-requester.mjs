// 支付宝落地页 Skill 素材请求层。
//
// 职责：
//  - 对规划层产出的 AssetRequest 列表做公共 Schema 校验（不复制 Schema，复用 contracts）；
//  - 生成可交付给 image.generate 的 pendingAssetRequests 结构。
//
// 边界：本层不调用生图/编辑 Skill，只负责请求合法化；回填由规划层 + 组装脚本完成。
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Registry, validate } from '../../design-skill-contracts/scripts/validate.mjs'
import { CONTRACT_DIR } from '../../skill-alipay-pages/scripts/build-catalog.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const SCHEMA_DIR = path.join(CONTRACT_DIR, 'schemas')
const ASSET_REQUEST_ID = 'http://schemas.design-agent.local/design-skill/v1/asset-request.schema.json'

export class AssetRequestError extends Error {
  constructor(code, message, details = []) {
    super(message)
    this.code = code
    this.details = details
  }
}

let _registry = null
let _assetRequestSchema = null

function loadContract() {
  if (_registry) return { registry: _registry, schema: _assetRequestSchema }
  const registry = Registry.fromDirectory(SCHEMA_DIR)
  const schema = registry.byId.get(ASSET_REQUEST_ID)?.schema
  if (!schema) throw new AssetRequestError('CONTRACT_MISSING', 'asset-request schema 未加载')
  _registry = registry
  _assetRequestSchema = schema
  return { registry, schema }
}

/**
 * 校验单个 AssetRequest。
 * @param {object} request
 * @returns {object} 校验通过后原样返回
 * @throws {AssetRequestError}
 */
export function validateAssetRequest(request) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw new AssetRequestError('INVALID_REQUEST', 'AssetRequest 必须是对象')
  }
  const { registry, schema } = loadContract()
  const errors = validate(request, schema, registry, schema.$id)
  if (errors.length) {
    throw new AssetRequestError('INVALID_ASSET_REQUEST', 'AssetRequest 不符合契约', errors)
  }
  return request
}

/**
 * 校验并规范化 pendingAssetRequests（列表）。
 * @param {Array<object>} requests
 * @returns {Array<object>} 校验通过的 AssetRequest 列表
 * @throws {AssetRequestError}
 */
export function normalizePendingAssetRequests(requests) {
  if (!Array.isArray(requests)) {
    throw new AssetRequestError('INVALID_REQUEST', 'pendingAssetRequests 必须是数组')
  }
  const ids = new Set()
  for (const request of requests) {
    validateAssetRequest(request)
    if (ids.has(request.id)) throw new AssetRequestError('DUPLICATE_REQUEST', `重复 AssetRequest id：${request.id}`)
    ids.add(request.id)
  }
  return requests
}

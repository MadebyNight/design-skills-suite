// 3C.1：批次请求加载器。
//
// 职责：从文件或对象加载批次请求，用 contracts 的 batch-design-request schema 校验，
// 并做确定性检查（itemId 唯一、pageLinkage 语义）。返回深拷贝，不修改输入。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Registry, validate } from '../../design-skill-contracts/scripts/validate.mjs'
import { derivePlanFromRequest } from './page-linkage.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONTRACTS_ROOT = path.resolve(__dirname, '..', '..', 'design-skill-contracts')
const BATCH_REQUEST_SCHEMA_ID = 'http://schemas.design-agent.local/design-skill/v1/batch-design-request.schema.json'

/** 批次请求错误基类。 */
export class BatchRequestError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

let registry = null
let schema = null

/** 惰性加载 contracts 注册表（含 batch-design-request 及其 $ref 依赖）。 */
function loadSchema() {
  if (schema) return { registry, schema }
  const schemasDir = path.join(CONTRACTS_ROOT, 'schemas')
  registry = Registry.fromDirectory(schemasDir)
  schema = registry.byId.get(BATCH_REQUEST_SCHEMA_ID)?.schema
  if (!schema) throw new BatchRequestError('BATCH_REQUEST_INVALID', 'batch-design-request schema 未加载')
  return { registry, schema }
}

/**
 * 加载批次请求。
 * @param {string|object} input 文件路径或批次请求对象
 * @returns {object} 深拷贝的批次请求
 * @throws {BatchRequestError} code=BATCH_REQUEST_INVALID / BATCH_REQUEST_IO
 */
export function loadBatchRequest(input) {
  let request
  if (typeof input === 'string') {
    let raw
    try {
      raw = fs.readFileSync(input, 'utf8')
    } catch (error) {
      throw new BatchRequestError('BATCH_REQUEST_IO', `读取批次请求失败：${error.message}`)
    }
    try {
      request = JSON.parse(raw)
    } catch (error) {
      throw new BatchRequestError('BATCH_REQUEST_INVALID', `批次请求 JSON 解析失败：${error.message}`)
    }
  } else if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    request = input
  } else {
    throw new BatchRequestError('BATCH_REQUEST_INVALID', '批次请求必须是文件路径或对象')
  }

  const { registry: reg, schema: sch } = loadSchema()
  const errors = validate(request, sch, reg, sch.$id)
  if (errors.length > 0) {
    throw new BatchRequestError('BATCH_REQUEST_INVALID', `批次请求校验失败：${errors.join('；')}`)
  }

  // 确定性检查：itemId 唯一。
  const seen = new Set()
  for (const item of request.items) {
    if (seen.has(item.itemId)) {
      throw new BatchRequestError('BATCH_REQUEST_INVALID', `itemId 重复：${item.itemId}`)
    }
    seen.add(item.itemId)
  }

  // 确定性检查：pageLinkage 语义（唯一 landingKey、恰一 home、landing 数与主题数一致）。
  // 失败按请求错误处理；不再把 plan 写回 request（schema additionalProperties:false 会拒绝）。
  try {
    derivePlanFromRequest(request)
  } catch (error) {
    if (error && error.code === 'BATCH_REQUEST_INVALID') {
      throw new BatchRequestError('BATCH_REQUEST_INVALID', error.message)
    }
    throw error
  }

  return structuredClone(request)
}

export default loadBatchRequest

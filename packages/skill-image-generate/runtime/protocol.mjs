// 生图 Skill 协议层：复用 design-skill-contracts 的 Schema 与最小验证器做输入校验。
//
// 边界：本层不产生业务输出，只负责把外部输入映射到 AssetRequest，并校验其合法性。
// 校验失败时抛出带明确错误码的 ProtocolError，供 CLI 稳定输出。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Registry, validate } from '../../design-skill-contracts/scripts/validate.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 本 package 根目录
export const PACKAGE_ROOT = path.resolve(__dirname, '..')
// design-skill-contracts package 根目录
export const CONTRACTS_ROOT = path.resolve(__dirname, '..', '..', 'design-skill-contracts')

export const ASSET_REQUEST_SCHEMA = 'asset-request.schema.json'
export const ASSET_RESULT_SCHEMA = 'asset-result.schema.json'

let registry = null
let assetRequestSchema = null
let assetResultSchema = null

/** 惰性加载 contracts 的 Schema 注册表，复用同 package 的唯一真相源。 */
export function loadContracts() {
  if (registry) return { registry, assetRequestSchema, assetResultSchema }
  const schemasDir = path.join(CONTRACTS_ROOT, 'schemas')
  registry = Registry.fromDirectory(schemasDir)
  assetRequestSchema = registry.byId.get(
    'http://schemas.design-agent.local/design-skill/v1/asset-request.schema.json',
  )?.schema
  assetResultSchema = registry.byId.get(
    'http://schemas.design-agent.local/design-skill/v1/asset-result.schema.json',
  )?.schema
  if (!assetRequestSchema || !assetResultSchema) {
    throw new Error('design-skill-contracts schema 未加载完整，请检查 packages/design-skill-contracts/schemas')
  }
  return { registry, assetRequestSchema, assetResultSchema }
}

export class ProtocolError extends Error {
  constructor(code, message, details = []) {
    super(message)
    this.code = code
    this.details = details
  }
}

/**
 * 将原始输入（对象或 JSON 字符串）校验并规范化为 AssetRequest。
 * @param {unknown} input
 * @returns {object} 规范化后的 AssetRequest
 * @throws {ProtocolError}
 */
export function normalizeAssetRequest(input) {
  let instance = input
  if (typeof instance === 'string') {
    try {
      instance = JSON.parse(instance)
    } catch (e) {
      throw new ProtocolError('INVALID_JSON', '输入不是合法 JSON', [`解析失败: ${e.message}`])
    }
  }
  if (instance === null || typeof instance !== 'object' || Array.isArray(instance)) {
    throw new ProtocolError('INVALID_ASSET_REQUEST', '输入必须是 AssetRequest 对象')
  }

  const { registry: reg, assetRequestSchema: schema } = loadContracts()
  const errors = validate(instance, schema, reg, schema.$id)
  if (errors.length > 0) {
    throw new ProtocolError('INVALID_ASSET', 'AssetRequest 校验失败', errors)
  }
  return instance
}

/** 校验 AssetResult 是否符合契约，返回错误数组（空数组=通过）。 */
export function validateAssetResult(result) {
  const { registry: reg, assetResultSchema: schema } = loadContracts()
  return validate(result, schema, reg, schema.$id)
}

/** 将结构化素材合同收敛为 provider 使用的单素材提示词。 */
export function buildAssetPrompt(request) {
  const fitText = request.fit === 'contain' ? '完整展示，不裁切主体' : '铺满画面，允许边缘裁切'
  const forbidden = Array.isArray(request.forbiddenContent) && request.forbiddenContent.length
    ? request.forbiddenContent.join('；')
    : '完整页面、手机模型、浏览器框、应用界面、多个模块拼版、重复宫格、画板标注'
  return [
    request.theme,
    `当前槽位：${request.usageSlot}`,
    `目标比例：${request.aspectRatio}（${request.targetWidth}×${request.targetHeight}）`,
    `展示方式：${request.fit}，${fitText}`,
    `构图要求：只生成当前槽位的一张独立平面素材`,
    `安全区：${request.safeArea}`,
    `禁止内容：${forbidden}`,
  ].join('\n')
}

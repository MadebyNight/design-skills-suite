// 统一素材验收与重试合同（素材链路修复设计 2026-09-01 第 3 节）。
//
// 职责：为 runner、asset store 与 OpenPhoto adapter 提供共享的 AssetResult 验收
// 与重试计数解析，验收规则只在本模块实现一次，避免三处各自漂移。
//
// 验收规则（与 asset-request.schema.json 的 acceptance 合同一致）：
//  - 公共校验：AssetResult Schema、assetRequestId 匹配、MIME 匹配 format、
//    正整数宽高；文件存在与 sha256 由 asset store 层负责，不在本模块。
//  - exact-size（缺省，旧语义）：w/h 严格等于 targetWidth/targetHeight 且
//    strictSizeSatisfied=true。
//  - aspect-ratio：仅以 abs((actualRatio / targetRatio) - 1) ≤ maxAspectRatioError
//    为数值目标；边界值（如 0.03）视为通过；不检查 strictSizeSatisfied（仅作
//    兼容信息保留在 AssetResult 中）。
//
// 重试规则（retryPolicy，attempt 计数含首次执行）：
//  - generateMaxAttempts / adaptMaxAttempts 缺省维持旧单次执行语义（1）；
//  - 仅 error.retryable === true 的错误可重试；验收不过的适配输出、契约错误、
//    认证/参数错误均不可重试。
import { validateAssetResult } from '../../skill-image-generate/runtime/protocol.mjs'

export const DEFAULT_ACCEPTANCE_MODE = 'exact-size'
// contracts Schema 上限即缺省值：比例误差 ≤3%，边界值 0.03 通过。
export const DEFAULT_MAX_ASPECT_RATIO_ERROR = 0.03
// 比例误差的数值容差：仅补偿 IEEE754 舍入（如 1030/1000 - 1 = 0.030000000000000027），
// 使理论恰好等于 maxAspectRatioError 的边界通过。整数宽高下可表达的误差步长
// 远大于该量级（万级像素的最小步长 ≥1e-5），不会放宽任何实际 >容差 的比例。
export const ASPECT_RATIO_ERROR_EPSILON = 1e-9
export const DEFAULT_GENERATE_MAX_ATTEMPTS = 1
export const DEFAULT_ADAPT_MAX_ATTEMPTS = 1

/** request.format 对应的 MIME；png→image/png，jpg/jpeg→image/jpeg，其余返回 null。 */
export function expectedMimeTypeOf(format) {
  const normalized = String(format || '').toLowerCase()
  if (normalized === 'png') return 'image/png'
  if (normalized === 'jpg' || normalized === 'jpeg') return 'image/jpeg'
  return null
}

/** 验收模式：未声明 acceptance 时维持旧的精确尺寸语义。 */
export function acceptanceModeOf(request) {
  const mode = request?.acceptance?.mode
  return mode === 'aspect-ratio' ? 'aspect-ratio' : DEFAULT_ACCEPTANCE_MODE
}

/** 比例模式的最大相对误差；缺省 0.03（3%，边界值通过），Schema 上限 0.03。 */
export function maxAspectRatioErrorOf(request) {
  const declared = request?.acceptance?.maxAspectRatioError
  return typeof declared === 'number' && Number.isFinite(declared) && declared >= 0
    ? Math.min(declared, 0.03)
    : DEFAULT_MAX_ASPECT_RATIO_ERROR
}

/** 实际比例相对目标比例的相对误差 abs((actualRatio / targetRatio) - 1)。 */
export function aspectRatioErrorOf(targetWidth, targetHeight, width, height) {
  const targetRatio = targetWidth / targetHeight
  const actualRatio = width / height
  return Math.abs((actualRatio / targetRatio) - 1)
}

/**
 * 共享验收：AssetResult 是否满足 AssetRequest 的数值契约。
 * 公共校验：request ID、MIME、正整数宽高；文件与 SHA-256 校验由 asset store 负责。
 * exact-size：宽高严格相等且 strictSizeSatisfied=true；
 * aspect-ratio：仅比例误差 ≤ maxAspectRatioError（边界值视为通过）。
 * @param {object} request AssetRequest
 * @param {object} asset AssetResult
 * @returns {string[]} 错误消息（空数组 = 通过）
 */
export function validateAssetResultForRequest(request, asset) {
  if (!request || typeof request !== 'object') return ['AssetRequest 非法']
  if (asset === null || typeof asset !== 'object' || Array.isArray(asset)) {
    return ['AssetResult 必须是对象']
  }
  const schemaErrors = validateAssetResult(asset)
  if (schemaErrors && schemaErrors.length > 0) {
    return [`AssetResult Schema 校验失败: ${schemaErrors.join('；')}`]
  }
  const errors = []
  if (asset.assetRequestId !== request.id) {
    errors.push(`assetRequestId 不匹配（期望 ${request.id}）`)
  }
  const expectedMime = expectedMimeTypeOf(request.format)
  if (!expectedMime) {
    errors.push(`不支持的目标图片格式：${request.format}`)
  } else if (asset.mimeType !== expectedMime) {
    errors.push(`MIME 不匹配（期望 ${expectedMime}）`)
  }
  if (!Number.isInteger(asset.width) || asset.width < 1 || !Number.isInteger(asset.height) || asset.height < 1) {
    errors.push('宽高缺失或非正整数')
    return errors
  }
  const mode = acceptanceModeOf(request)
  if (mode === 'aspect-ratio') {
    const ratioError = aspectRatioErrorOf(request.targetWidth, request.targetHeight, asset.width, asset.height)
    // epsilon 仅补偿浮点舍入：理论恰好等于容差的边界（如 1030x1000 vs 1000x1000
    // 的 3%）通过；实际超出容差的比例仍拒绝。
    if (ratioError > maxAspectRatioErrorOf(request) + ASPECT_RATIO_ERROR_EPSILON) {
      errors.push(`比例超出容差：目标 ${request.targetWidth}x${request.targetHeight}，实际 ${asset.width}x${asset.height}`)
    }
    return errors
  }
  // 旧精确尺寸语义（含未声明 acceptance 的存量请求）。
  if (asset.width !== request.targetWidth || asset.height !== request.targetHeight) {
    errors.push(`尺寸不匹配（期望 ${request.targetWidth}x${request.targetHeight}，实际 ${asset.width}x${asset.height}）`)
  }
  if (asset.strictSizeSatisfied !== true) {
    errors.push('strictSizeSatisfied 不满足')
  }
  return errors
}

/** 仅 error.retryable === true 可重试；其余（契约/验收/认证/参数错误）均不可重试。 */
export function isRetryableError(error) {
  return Boolean(error && typeof error === 'object' && error.retryable === true)
}

/** 生成尝试上限：含首次执行；未声明/非法时维持旧单次执行语义（1）。 */
export function generateMaxAttemptsOf(request) {
  const value = request?.retryPolicy?.generateMaxAttempts
  return Number.isInteger(value) && value >= 1 ? value : DEFAULT_GENERATE_MAX_ATTEMPTS
}

/** 适配次数上限：含首次执行；未声明/非法时维持旧单次适配语义（1）。 */
export function adaptMaxAttemptsOf(request) {
  const value = request?.retryPolicy?.adaptMaxAttempts
  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_ADAPT_MAX_ATTEMPTS
}

export default {
  expectedMimeTypeOf,
  acceptanceModeOf,
  maxAspectRatioErrorOf,
  aspectRatioErrorOf,
  validateAssetResultForRequest,
  isRetryableError,
  generateMaxAttemptsOf,
  adaptMaxAttemptsOf,
  ASPECT_RATIO_ERROR_EPSILON,
}
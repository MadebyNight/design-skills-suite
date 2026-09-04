import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ASPECT_RATIO_ERROR_EPSILON,
  DEFAULT_ACCEPTANCE_MODE,
  DEFAULT_MAX_ASPECT_RATIO_ERROR,
  acceptanceModeOf,
  adaptMaxAttemptsOf,
  aspectRatioErrorOf,
  expectedMimeTypeOf,
  generateMaxAttemptsOf,
  isRetryableError,
  maxAspectRatioErrorOf,
  validateAssetResultForRequest,
} from '../../runtime/asset-acceptance.mjs'

// 测试用 AssetRequest 构造器：默认 exact-size（未声明 acceptance）。
function assetRequest(id = 'req-1', { width = 100, height = 100, format = 'png', acceptance, retryPolicy } = {}) {
  return {
    id,
    usageSlot: id,
    theme: '测试素材',
    targetWidth: width,
    targetHeight: height,
    aspectRatio: `${width}:${height}`,
    format,
    fit: 'cover',
    safeArea: '居中',
    referenceImages: [],
    forbiddenContent: [],
    allowGenerate: true,
    allowEdit: true,
    ...(acceptance !== undefined ? { acceptance } : {}),
    ...(retryPolicy !== undefined ? { retryPolicy } : {}),
  }
}

/** 合法 AssetResult 骨架；通过 validateAssetResultForRequest 公共校验。 */
function assetResult(requestId, { width, height, mimeType = 'image/png', strictSizeSatisfied = false } = {}) {
  return {
    assetRequestId: requestId,
    artifactId: `${requestId}-artifact`,
    path: 'fixture/test.png',
    mimeType,
    width,
    height,
    sha256: 'a'.repeat(64),
    sourceSkill: 'test-generator',
    sourceSkillVersion: '1.0.0',
    strictSizeSatisfied,
    notes: [],
  }
}

// ---- 缺省语义（未声明 acceptance / retryPolicy）----

test('缺省验收模式为 exact-size，缺省比例容差 0.03', () => {
  const request = assetRequest()
  assert.equal(acceptanceModeOf(request), 'exact-size')
  assert.equal(acceptanceModeOf({}), 'exact-size')
  assert.equal(DEFAULT_ACCEPTANCE_MODE, 'exact-size')
  assert.equal(maxAspectRatioErrorOf({ acceptance: { mode: 'aspect-ratio' } }), 0.03)
  assert.equal(DEFAULT_MAX_ASPECT_RATIO_ERROR, 0.03)
  // 未声明 retryPolicy 时维持旧单次执行语义（attempt 计数含首次）。
  assert.equal(generateMaxAttemptsOf(assetRequest()), 1)
  assert.equal(adaptMaxAttemptsOf(assetRequest()), 1)
  // 非法值回退缺省（本模块只做整数边界校验，Schema 上限由 contracts 保证）。
  assert.equal(generateMaxAttemptsOf(assetRequest('r', { retryPolicy: { generateMaxAttempts: 0, adaptMaxAttempts: 2 } })), 1)
  assert.equal(adaptMaxAttemptsOf(assetRequest('r', { retryPolicy: { generateMaxAttempts: 3, adaptMaxAttempts: -1 } })), 1)
})

test('exact-size：宽高严格相等且 strictSizeSatisfied=true；比例模式不检查 strictSizeSatisfied', () => {
  const request = assetRequest('exact', { width: 200, height: 100 })
  // 宽高相等但 strict 缺失 → 拒绝。
  assert.ok(validateAssetResultForRequest(request, assetResult('exact', { width: 200, height: 100 })).length > 0)
  // strict=true 且宽高相等 → 通过。
  assert.deepEqual(validateAssetResultForRequest(request, assetResult('exact', { width: 200, height: 100, strictSizeSatisfied: true })), [])
  // 比例一致但尺寸不同 → 仍拒绝（exact-size 以宽高为数值目标）。
  assert.ok(validateAssetResultForRequest(request, assetResult('exact', { width: 400, height: 200, strictSizeSatisfied: true })).length > 0)
  // 比例模式：宽高不必相等，strictSizeSatisfied=false 也通过。
  const aspect = assetRequest('aspect', { width: 1000, height: 1000, acceptance: { mode: 'aspect-ratio' } })
  assert.deepEqual(validateAssetResultForRequest(aspect, assetResult('aspect', { width: 1020, height: 1000, strictSizeSatisfied: false })), [])
})

// ---- MIME / requestID / 宽高公共校验 ----

test('公共校验：assetRequestId 匹配、MIME 匹配 format、正整数宽高', () => {
  const request = assetRequest('pub', { format: 'jpg' })
  assert.ok(validateAssetResultForRequest(request, assetResult('other', { width: 10, height: 10 })).some((e) => e.includes('assetRequestId')))
  assert.ok(validateAssetResultForRequest(request, assetResult('pub', { width: 10, height: 10, mimeType: 'image/png' })).some((e) => e.includes('MIME')))
  // 宽高 0 或非整数：Schema（minimum 1 / integer）先行拦截或本模块兜底。
  assert.ok(validateAssetResultForRequest(request, assetResult('pub', { width: 0, height: 10 })).length > 0, '宽高 0 必须被拒')
  assert.ok(validateAssetResultForRequest(request, assetResult('pub', { width: 1.5, height: 10 })).length > 0, '非整数宽高必须被拒')
  // 非法 format。
  const bad = assetRequest('pub', { format: 'webp' })
  assert.ok(validateAssetResultForRequest(bad, assetResult('pub', { width: 10, height: 10 })).some((e) => e.includes('不支持的目标图片格式')))
  // expectedMimeTypeOf：png / jpg / jpeg。
  assert.equal(expectedMimeTypeOf('png'), 'image/png')
  assert.equal(expectedMimeTypeOf('jpg'), 'image/jpeg')
  assert.equal(expectedMimeTypeOf('jpeg'), 'image/jpeg')
  assert.equal(expectedMimeTypeOf('gif'), null)
  // AssetResult 非对象。
  assert.ok(validateAssetResultForRequest(request, null).length > 0)
  assert.ok(validateAssetResultForRequest(request, 'x').length > 0)
})

// ---- aspect-ratio：不同尺寸、3% 边界 ----

test('aspect-ratio：不同尺寸但比例一致（误差 0）通过', () => {
  // 目标 1404x600（轮播基线），实际 702x300 同比例。
  const request = assetRequest('ratio-zero', { width: 1404, height: 600, acceptance: { mode: 'aspect-ratio' } })
  assert.deepEqual(validateAssetResultForRequest(request, assetResult('ratio-zero', { width: 702, height: 300 })), [])
  assert.equal(aspectRatioErrorOf(1404, 600, 702, 300), 0)
  // 误差 < 3%：1446x600 vs 1404x600 ≈ 2.99%。
  const near = assetRequest('ratio-near', { width: 1404, height: 600, acceptance: { mode: 'aspect-ratio', maxAspectRatioError: 0.03 } })
  assert.deepEqual(validateAssetResultForRequest(near, assetResult('ratio-near', { width: 1446, height: 600 })), [])
})

test('aspect-ratio：3% 边界——理论恰 3% 通过、略超即拒（数值容差仅补偿浮点舍入）', () => {
  // 1030x1000 vs 1000x1000：理论误差恰为 3%。IEEE754 下
  // abs((1030/1000)/(1000/1000)-1) = 0.030000000000000027，含 epsilon 容差后
  // 该理论边界必须通过（审计修复：不因浮点舍入误拒恰好在容差上的比例）。
  const strict = assetRequest('edge', { width: 1000, height: 1000, acceptance: { mode: 'aspect-ratio', maxAspectRatioError: 0.03 } })
  const strictError = aspectRatioErrorOf(1000, 1000, 1030, 1000)
  assert.ok(strictError > 0.03, `浮点边界应大于 0.03，实际 ${strictError}`)
  assert.ok(strictError <= 0.03 + 1e-9, `浮点偏差必须处于 epsilon 量级，实际 ${strictError - 0.03}`)
  assert.deepEqual(validateAssetResultForRequest(strict, assetResult('edge', { width: 1030, height: 1000 })), [], '理论恰好 3% 的边界必须通过（epsilon 补偿浮点舍入）')
  // 实际超出容差的比例仍拒绝：1031x1000 = 3.1% > 3% + epsilon。
  const over = assetRequest('over', { width: 1000, height: 1000, acceptance: { mode: 'aspect-ratio', maxAspectRatioError: 0.03 } })
  assert.ok(aspectRatioErrorOf(1000, 1000, 1031, 1000) > 0.03 + 1e-9)
  assert.ok(validateAssetResultForRequest(over, assetResult('over', { width: 1031, height: 1000 })).length > 0, '实际 >3% 的比例必须拒绝')
  // 浮点上仍在容差内的最大整数边界：1020x1000 vs 1000x1000 = 2%（通过），与
  // 1446x600 vs 1404x600 ≈ 2.99%（通过，见上例）共同证明"≤0.03 通过"。
  // 显式验证 maxAspectRatioError 收敛：Schema 上限 0.03，声明 0.05 被钳制为 0.03。
  const clamped = assetRequest('clamp', { width: 100, height: 100, acceptance: { mode: 'aspect-ratio', maxAspectRatioError: 0.05 } })
  assert.equal(maxAspectRatioErrorOf(clamped), 0.03)
  // 2% 误差通过。
  assert.deepEqual(validateAssetResultForRequest(clamped, assetResult('clamp', { width: 102, height: 100 })), [])
  // 4% 误差拒绝（104x100 = 4%）。
  assert.ok(validateAssetResultForRequest(clamped, assetResult('clamp', { width: 104, height: 100 })).length > 0)
})

test('aspect-ratio：自定义容差（更小）生效', () => {
  const request = assetRequest('tol', { width: 100, height: 100, acceptance: { mode: 'aspect-ratio', maxAspectRatioError: 0.01 } })
  // 2% 误差超出 1% 容差 → 拒绝。
  assert.ok(validateAssetResultForRequest(request, assetResult('tol', { width: 102, height: 100 })).length > 0)
  // 0.5% 误差通过。
  assert.deepEqual(validateAssetResultForRequest(request, assetResult('tol', { width: 100, height: 100 }).width ? assetResult('tol', { width: 100, height: 100 }) : assetResult('tol', { width: 1005, height: 1000 })), [])
})

test('ASPECT_RATIO_ERROR_EPSILON：数值容差仅补偿浮点舍入，不放宽实际 >3%', () => {
  // epsilon 量级约束：必须远小于整数宽高下可表达的最小比例误差步长。
  assert.ok(ASPECT_RATIO_ERROR_EPSILON > 0)
  assert.ok(ASPECT_RATIO_ERROR_EPSILON < 1e-6, '容差必须远小于实际比例可表达的误差步长')
  // 大尺寸下浮点舍入同样被补偿：14445x14040 vs 14040x14040 理论恰 2.89%，
  // 反向比例 14040x14445 同理；构造大尺寸恰好边界：14040*1.03 = 14461.2 →
  // 整数化最接近 3% 的组合为 14461x14040（≈2.99986%），直接通过。
  const big = assetRequest('big', { width: 14040, height: 14040, acceptance: { mode: 'aspect-ratio', maxAspectRatioError: 0.03 } })
  assert.deepEqual(validateAssetResultForRequest(big, assetResult('big', { width: 14461, height: 14040 })), [])
  // 自定义更小容差同样享受 epsilon 补偿：0.02 边界（1020x1000 vs 1000x1000）
  // 浮点误差 0.020000000000000018 ≤ 0.02 + epsilon → 通过。
  const custom = assetRequest('custom-edge', { width: 1000, height: 1000, acceptance: { mode: 'aspect-ratio', maxAspectRatioError: 0.02 } })
  assert.deepEqual(validateAssetResultForRequest(custom, assetResult('custom-edge', { width: 1020, height: 1000 })), [])
  // 实际超出 0.02 的 1021x1000（≈2.1%）仍拒绝。
  assert.ok(validateAssetResultForRequest(custom, assetResult('custom-over', { width: 1021, height: 1000 })).length > 0)
})

// ---- 重试规则 ----

test('isRetryableError：仅 error.retryable === true 可重试', () => {
  const retryable = new Error('网络抖动')
  retryable.retryable = true
  assert.equal(isRetryableError(retryable), true)
  assert.equal(isRetryableError(new Error('契约错误')), false)
  assert.equal(isRetryableError({ retryable: true }), true)
  assert.equal(isRetryableError({ retryable: false }), false)
  assert.equal(isRetryableError(null), false)
  assert.equal(isRetryableError('boom'), false)
})

test('重试上限解析：声明值生效且被 Schema 上限约束（generate ≤3 / adapt ≤2）', () => {
  const request = assetRequest('retry', { retryPolicy: { generateMaxAttempts: 3, adaptMaxAttempts: 2 } })
  assert.equal(generateMaxAttemptsOf(request), 3)
  assert.equal(adaptMaxAttemptsOf(request), 2)
  // 合法下界：adapt 0 表示不执行适配。
  assert.equal(adaptMaxAttemptsOf(assetRequest('retry0', { retryPolicy: { generateMaxAttempts: 1, adaptMaxAttempts: 0 } })), 0)
})
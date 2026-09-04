// C2.2：素材策略解析器。
//
// 纯函数：只基于传入的 policy 与 usageSlot 决定素材来源与要求，不做 IO。
// policy 结构为 { default, rules }（与 asset-policy.schema.json 一致）：
//   - default: { source, requirement }，无规则命中时的兜底；
//   - rules: [{ usageSlot, source, requirement }]，usageSlot 只允许精确或尾部单个 `*`。
//
// 匹配优先级（与 C2.2 计划一致）：
//   1. 精确 usageSlot 优先于通配；
//   2. 通配前缀越长越优先；
//   3. 同精度下后声明（数组靠后）优先；
//   4. 无命中回退 default。
// 返回新对象 { source, requirement, matchedRuleIndex, usageSlotPattern }，不修改输入。

/** 非法 policy 形状时的稳定错误。 */
export class AssetPolicyError extends Error {
  constructor(message) {
    super(message)
    this.code = 'INVALID_ASSET_POLICY'
  }
}

// 与 asset-policy.schema.json 保持一致：usageSlot 仅允许非空字母数字._-，可选仅尾部单个 *。
const USAGE_SLOT_PATTERN = /^[A-Za-z0-9._-]+\*?$/
const SOURCE_ENUM = ['generate', 'reuse']
const REQUIREMENT_ENUM = ['required', 'optional']

/** 校验 decision（default 或 rule 的 source/requirement 部分）无额外字段且 enum 合法。 */
function assertDecision(decision, where) {
  if (decision === null || typeof decision !== 'object' || Array.isArray(decision)) {
    throw new AssetPolicyError(`${where} 必须是对象`)
  }
  const allowed = new Set(['source', 'requirement'])
  for (const key of Object.keys(decision)) {
    if (!allowed.has(key)) throw new AssetPolicyError(`${where} 含未声明字段 "${key}"`)
  }
  if (!SOURCE_ENUM.includes(decision.source)) {
    throw new AssetPolicyError(`${where}.source 非法: ${decision.source}`)
  }
  if (!REQUIREMENT_ENUM.includes(decision.requirement)) {
    throw new AssetPolicyError(`${where}.requirement 非法: ${decision.requirement}`)
  }
}

/** usageSlot 是否合法：非空字符串，且 `*` 只允许出现在末尾（精确或尾部通配）。 */
function isValidUsageSlot(p) {
  return typeof p === 'string' && USAGE_SLOT_PATTERN.test(p)
}

/**
 * 轻量校验 policy 形状，与 asset-policy.schema.json 一致。非法时抛 AssetPolicyError。
 * @param {unknown} policy
 * @returns {true}
 */
export function validateAssetPolicyShape(policy) {
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new AssetPolicyError('policy 必须是对象')
  }
  const allowed = new Set(['default', 'rules'])
  for (const key of Object.keys(policy)) {
    if (!allowed.has(key)) throw new AssetPolicyError(`policy 含未声明字段 "${key}"`)
  }
  if (policy.default === undefined) throw new AssetPolicyError('policy 缺少必填字段 "default"')
  if (policy.rules === undefined) throw new AssetPolicyError('policy 缺少必填字段 "rules"')
  assertDecision(policy.default, 'policy.default')
  if (!Array.isArray(policy.rules)) {
    throw new AssetPolicyError('policy.rules 必须是数组')
  }
  for (const rule of policy.rules) {
    if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
      throw new AssetPolicyError('rule 必须是对象')
    }
    const ruleAllowed = new Set(['usageSlot', 'source', 'requirement'])
    for (const key of Object.keys(rule)) {
      if (!ruleAllowed.has(key)) throw new AssetPolicyError(`rule 含未声明字段 "${key}"`)
    }
    if (rule.usageSlot === undefined) throw new AssetPolicyError('rule 缺少必填字段 "usageSlot"')
    if (!isValidUsageSlot(rule.usageSlot)) {
      throw new AssetPolicyError(`非法 usageSlot: ${rule.usageSlot}`)
    }
    if (!SOURCE_ENUM.includes(rule.source)) {
      throw new AssetPolicyError(`rule.source 非法: ${rule.source}`)
    }
    if (!REQUIREMENT_ENUM.includes(rule.requirement)) {
      throw new AssetPolicyError(`rule.requirement 非法: ${rule.requirement}`)
    }
  }
  return true
}

/** usageSlot 是否命中目标：精确相等，或目标以通配前缀开头。 */
function matchesUsageSlot(pattern, usageSlot) {
  const star = pattern.indexOf('*')
  if (star === -1) return pattern === usageSlot
  return usageSlot.startsWith(pattern.slice(0, star))
}

/** usageSlot 精度：精确为最高，通配取前缀长度（越长越优先）。 */
function usageSlotPrecision(pattern) {
  const star = pattern.indexOf('*')
  if (star === -1) return Number.MAX_SAFE_INTEGER
  return star
}

/**
 * 解析 usageSlot 对应的素材策略。
 * @param {object} policy  { default, rules }
 * @param {string} usageSlot
 * @returns {{ source: string, requirement: string, matchedRuleIndex: number, usageSlotPattern: string|null }}
 */
export function resolveAssetPolicy(policy, usageSlot) {
  validateAssetPolicyShape(policy)
  const rules = policy.rules || []
  let best = null
  for (let i = 0; i < rules.length; i += 1) {
    const rule = rules[i]
    if (!matchesUsageSlot(rule.usageSlot, usageSlot)) continue
    const precision = usageSlotPrecision(rule.usageSlot)
    // 精度更高，或同精度（后声明优先）→ 覆盖当前最优。
    if (!best || precision >= best.precision) {
      best = { index: i, rule, precision }
    }
  }
  if (best) {
    return {
      source: best.rule.source,
      requirement: best.rule.requirement,
      matchedRuleIndex: best.index,
      usageSlotPattern: best.rule.usageSlot,
    }
  }
  return {
    source: policy.default.source,
    requirement: policy.default.requirement,
    matchedRuleIndex: -1,
    usageSlotPattern: null,
  }
}

export default resolveAssetPolicy

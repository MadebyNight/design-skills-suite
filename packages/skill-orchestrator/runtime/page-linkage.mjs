// 3C.4：页面联动（pageLinkage）。
//
// 职责：把批次请求中的可选 pageLinkage 规范化为确定性的执行计划：
//   1. 主题默认/覆盖（首页 homeTheme、落地页 landingThemes）；
//   2. 唯一、稳定的 landingKey 生成与分配（landing-01、landing-02…）；
//   3. 确定性执行顺序（landing 优先、按 landingKey 稳定排序，home 最后）；
//   4. landing 上下文（landingKey + theme）与 home 上下文（landingThemes + 成功落地页预览 ref）；
//   5. 终态联合校验与 warnings（失效关联不写入、不阻断、只警告）。
//
// 边界：本模块是纯函数集合，不做 IO；落盘的只有 batch-request/batch-runner 传入的对象。
import { relative as pathRelative, join as pathJoin } from 'node:path'

/** attempt 目录内可审阅原型的固定文件名（skill-alipay-pages 组装器产物）。 */
const PROTOTYPE_FILE = 'prototype.html'

/** 在 attempt 路径上拼接原型文件名（与平台无关的纯路径计算）。 */
function prototypePath(attemptRoot) {
  return pathJoin(attemptRoot, PROTOTYPE_FILE)
}

/** 页面联动错误基类。 */
export class PageLinkageError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

const LANDING_KEY_PATTERN = /^landing-[0-9]{2,}$/

/** landingKey 是否合法。 */
export function isLandingKey(value) {
  return typeof value === 'string' && LANDING_KEY_PATTERN.test(value)
}

/** 主题是否可用为稳定排序键（非空字符串）。 */
function normalizeTheme(value, context) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new PageLinkageError('BATCH_REQUEST_INVALID', `${context} 必须是非空字符串`)
  }
  return value
}

/** 规范后编号文本（保持两位以上稳定形态）。 */
function keyNumber(key) {
  return Number(key.slice('landing-'.length))
}

/**
 * 从批次请求推导联动计划（纯函数，不修改输入）。
 * @param {object} request 已通过 schema 校验的批次请求
 * @returns {object|null} null=无联动；否则：
 *   {
 *     homeTheme,                        // 首页宽泛主题
 *     entries: [{ landingKey, theme }], // 规范化后的落地页主题表（请求顺序）
 *     landingItemIds, homeItemIds,      // 匹配到的 item
 *     order: [{ itemId, landingKey }],  // 确定性执行顺序：landing 优先（按 key 升序），home 最后（保持请求顺序）
 *   }
 */
export function derivePlanFromRequest(request) {
  if (!request.pageLinkage) return null
  const linkage = request.pageLinkage
  const homeTheme = normalizeTheme(linkage.homeTheme, 'pageLinkage.homeTheme')

  // ---- 规范化 landingThemes：唯一性检查 + 缺失 key 按请求顺序补全 ----
  const entries = []
  const used = new Map() // landingKey -> entry
  linkage.landingThemes.forEach((entry, index) => {
    const theme = normalizeTheme(entry.theme, `pageLinkage.landingThemes[${index}].theme`)
    const label = `pageLinkage.landingThemes[${index}].landingKey`
    if (entry.landingKey !== undefined && entry.landingKey !== null) {
      if (!isLandingKey(entry.landingKey)) {
        throw new PageLinkageError('BATCH_REQUEST_INVALID', `${label} 非法：${JSON.stringify(entry.landingKey)}`)
      }
      if (used.has(entry.landingKey)) {
        throw new PageLinkageError('BATCH_REQUEST_INVALID', `${label} 重复：${entry.landingKey}`)
      }
      const normalized = { landingKey: entry.landingKey, theme }
      used.set(entry.landingKey, normalized)
      entries.push(normalized)
    } else {
      entries.push({ landingKey: null, theme })
    }
  })

  // 为缺失 key 的 entry 顺序分配最小可用编号（跳过已占用编号）。
  let next = 1
  for (const entry of entries) {
    if (entry.landingKey !== null) continue
    let candidate
    do {
      candidate = `landing-${String(next).padStart(2, '0')}`
      next++
    } while (used.has(candidate))
    entry.landingKey = candidate
    used.set(candidate, entry)
  }

  // 稳定性：按编号升序重排 entries，保证派生顺序与 key 数字序一致。
  entries.sort((a, b) => keyNumber(a.landingKey) - keyNumber(b.landingKey))

  // ---- 匹配 items：联动批次必须恰好一个 home item，landing item 数量与 entries 一致 ----
  const homeItems = request.items.filter((item) => item.brief?.deliverableType === 'alipay.home')
  const landingItems = request.items.filter((item) => item.brief?.deliverableType === 'alipay.landing')
  const otherItems = request.items.filter((item) => !['alipay.home', 'alipay.landing'].includes(item.brief?.deliverableType))
  if (homeItems.length !== 1) {
    throw new PageLinkageError('BATCH_REQUEST_INVALID', `联动批次必须恰好一个 alipay.home item，实际 ${homeItems.length}`)
  }
  if (landingItems.length !== entries.length) {
    throw new PageLinkageError(
      'BATCH_REQUEST_INVALID',
      `联动批次 alipay.landing item 数量（${landingItems.length}）必须与 pageLinkage.landingThemes 数量（${entries.length}）一致`,
    )
  }
  if (otherItems.length > 0) {
    throw new PageLinkageError('BATCH_REQUEST_INVALID', `联动批次只允许 home/landing item，发现其他类型：${otherItems.map((i) => i.itemId).join(', ')}`)
  }

  // landing item 按请求顺序与 entries（key 升序）一一对应。
  const landingItemIds = landingItems.map((item) => item.itemId)
  const homeItemIds = homeItems.map((item) => item.itemId)

  // ---- 确定性执行顺序：landing 优先（按 key 升序），home 最后 ----
  const order = [
    ...entries.map((entry) => ({
      itemId: landingItemIds[entries.indexOf(entry)],
      landingKey: entry.landingKey,
    })),
    ...homeItemIds.map((itemId) => ({ itemId, landingKey: null })),
  ]

  return {
    homeTheme,
    entries,
    landingItemIds,
    homeItemIds,
    order,
  }
}

/**
 * 派生单个 landing item 的上下文（供 standard-bindings/runItem 注入页面调用）。
 * @param {object} plan derivePlanFromRequest 输出
 * @param {string} itemId
 * @returns {{ landingKey: string, theme: string }|null} 无联动或非关联 item 返回 null
 */
export function landingContextFor(plan, itemId) {
  if (!plan) return null
  const itemIndex = plan.landingItemIds.indexOf(itemId)
  if (itemIndex === -1) return null
  const entry = plan.entries[itemIndex]
  if (!entry) return null
  return { landingKey: entry.landingKey, theme: entry.theme }
}

/**
 * 汇总首页上下文：landingThemes（规范化表）+ 可关联落地页的首页相对预览 ref。
 * 可关联判定：成功落地页，或「素材失败但页面已完成（受控校验通过）并带未回填
 * 槽位诊断占位」的落地页（reviewable，由 batch-runner 证据链判定后标记）。
 * 完全失败、页面步骤失败或 interrupted 遗留原型的落地页不建立关联。
 * ref 与 home CLI 接口对齐：相对首页交付目录的 <landingKey>/prototype.html
 * 实际文件路径（编排器负责把可关联落地页原型发布到该位置），仅用于离线预览。
 * @param {object} plan
 * @param {Map<string, object>} landingOutcomes itemId -> { status, reviewable?, landingKey, previewPath? }
 *   - status: 'succeeded' | 'failed'（'failed' 需 reviewable=true 才可关联）
 *   - previewPath: 相对批次根目录、指向 attempt 内 prototype.html 的 POSIX 路径
 * @returns {{ landingThemes: Array<{ landingKey, theme, source, landingPreviewRef? }>, warnings: string[] }}
 */
export function homeContextFor(plan, landingOutcomes) {
  if (!plan) return { landingThemes: [], warnings: [] }
  const warnings = []
  const landingThemes = plan.entries.map((entry) => {
    const itemId = plan.order.find((step) => step.landingKey === entry.landingKey)?.itemId
    const outcome = itemId ? landingOutcomes.get(itemId) : null
    const base = { landingKey: entry.landingKey, theme: entry.theme, source: 'orchestrator' }
    const linkable = outcome
      && (outcome.status === 'succeeded' || (outcome.status === 'failed' && outcome.reviewable === true))
      && typeof outcome.previewPath === 'string' && outcome.previewPath.length > 0
    if (linkable) {
      return { ...base, landingPreviewRef: `${entry.landingKey}/${PROTOTYPE_FILE}` }
    }
    if (itemId) {
      warnings.push(`落地页 ${entry.landingKey}（${itemId}）未成功且无可审阅原型，首页不建立其关联预览`)
    } else {
      warnings.push(`落地页 ${entry.landingKey} 无对应 item，首页不建立其关联预览`)
    }
    return base
  })
  return { landingThemes, warnings }
}

/**
 * 汇总联合校验结果与 warnings（终态）。
 * @param {object} plan
 * @param {Map<string, object>} landingOutcomes 同 homeContextFor
 * @returns {{ warnings: string[], ok: boolean }} ok=false 表示有阻断性不一致（当前语义下不发生，预留）
 */
export function jointReview(plan, landingOutcomes, homeOutcome) {
  if (!plan) return { warnings: [], ok: true }
  // 可关联落地页已通过 homeContextFor 注入首页上下文（编排器统一发布原型并
  // 换算 <landingKey>/prototype.html），无需按 established 结果再做二次核对。
  return { ...homeContextFor(plan, landingOutcomes), ok: true }
}

/**
 * 把 attempt 内可预览的原型文件换算为相对批次根目录的 POSIX 路径。
 * 路径指向 attempt 目录内实际存在的 prototype.html（文件而不是目录）。
 * @param {string} batchRoot 批次根目录（绝对）
 * @param {string} attemptRoot item attempt 目录（绝对）
 * @returns {string} 形如 items/<id>/attempts/0001/prototype.html 的 POSIX 相对路径
 */
export function previewRefFor(batchRoot, attemptRoot) {
  const rel = pathRelative(batchRoot, prototypePath(attemptRoot))
  return rel.split(/[\\/]+/).join('/')
}
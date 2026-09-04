// C4：设计软建议合并（DesignGuidance）。
//
// 纯编排：接收多个设计增强 binding 的软建议，按 ComponentCatalog 的
// component id / allowedClasses / allowedVariants 做明确 token 过滤。
//
// 约束：软建议不能突破 ComponentCatalog；被目录拒绝的条目以 rejectionReason 记录。
// binding 失败是非阻断的，仅产生 warning，不使整体崩溃。

import path from 'node:path'
import { Registry, validate } from '../../design-skill-contracts/scripts/validate.mjs'

const GUIDANCE_SCHEMA_ID =
  'http://schemas.design-agent.local/design-skill/v1/design-guidance.schema.json'

function getRegistry() {
  return Registry.fromDirectory(
    path.resolve(import.meta.dirname, '..', '..', 'design-skill-contracts', 'schemas'),
  )
}

/** 校验 DesignGuidance；不合法直接抛错，合法返回原对象。 */
export function validateGuidance(guidance) {
  const registry = getRegistry()
  const schema = registry.byId.get(GUIDANCE_SCHEMA_ID)?.schema
  if (!schema) throw new Error('DesignGuidance schema 未加载')
  const errors = validate(guidance, schema, registry, schema.$id)
  if (errors.length) throw new Error(`DesignGuidance 校验失败：${errors.join('；')}`)
  return guidance
}

/** 归一化 guidanceBindings 为 { sourceSkill, sourceSkillVersion, run } 条目数组。 */
function normalizeBindings(bindings) {
  const list = Array.isArray(bindings) ? bindings : []
  const out = []
  for (const b of list) {
    if (typeof b?.run === 'function') {
      out.push({
        sourceSkill: typeof b.sourceSkill === 'string' && b.sourceSkill ? b.sourceSkill : 'unknown',
        sourceSkillVersion:
          typeof b.sourceSkillVersion === 'string' && b.sourceSkillVersion
            ? b.sourceSkillVersion
            : '0.0.0',
        run: b.run,
      })
    }
  }
  return out
}

/** 归一化单条 binding 输出为 item 数组（{ kind, content, tokens }）。 */
function normalizeItems(raw) {
  if (Array.isArray(raw)) return raw
  if (Array.isArray(raw?.items)) return raw.items
  return []
}

/** 从 catalog 构建允许的 token 集合（component id / allowedClasses / allowedVariants）。 */
export function allowedTokens(catalog) {
  const components = Array.isArray(catalog?.components) ? catalog.components : []
  const set = new Set()
  for (const c of components) {
    if (typeof c.id === 'string' && c.id) set.add(c.id)
    for (const cls of Array.isArray(c.allowedClasses) ? c.allowedClasses : []) {
      if (typeof cls === 'string' && cls) set.add(cls)
    }
    for (const v of Array.isArray(c.allowedVariants) ? c.allowedVariants : []) {
      if (typeof v === 'string' && v) set.add(v)
    }
  }
  return set
}

/** 单条 item 过滤：content 中的 token 必须全部在允许集合内。 */
function filterItem(item, allowed) {
  const kind = typeof item?.kind === 'string' ? item.kind : ''
  const content = typeof item?.content === 'string' ? item.content : ''
  const rawTokens = Array.isArray(item?.tokens) ? item.tokens : [content]
  const tokens = rawTokens.filter((t) => typeof t === 'string' && t.trim())
  const unknown = tokens.filter((t) => !allowed.has(t))
  if (unknown.length === 0) {
    return { ok: true, item: { kind, content, catalogAccepted: true, rejectionReason: null } }
  }
  return {
    ok: false,
    item: {
      kind,
      content,
      catalogAccepted: false,
      rejectionReason: `引用未登记 token：${unknown.join('、')}`,
    },
  }
}

/**
 * 合并设计软建议（C4）。
 *
 * @param {object} input
 * @param {object} input.brief           DesignBrief（用于溯源展示，可选）
 * @param {object} [input.researchPack]  ResearchPack（可选，不影响过滤）
 * @param {object} input.catalog         ComponentCatalog（硬约束来源）
 * @param {Array}  [input.guidanceBindings] [{ sourceSkill, sourceSkillVersion, run }]
 * @returns {Promise<{guidance:object, warnings:string[]}>}
 */
export async function aggregateGuidance({ brief, researchPack, catalog, guidanceBindings = [] } = {}) {
  const warnings = []
  const allowed = allowedTokens(catalog)
  const sourceCommit =
    typeof catalog?.sourceCommit === 'string' && catalog.sourceCommit
      ? catalog.sourceCommit
      : 'unavailable'

  const items = []
  let rejectedCount = 0

  for (const binding of normalizeBindings(guidanceBindings)) {
    let raw
    try {
      raw = await binding.run({ brief, researchPack, catalog })
    } catch (e) {
      warnings.push(`binding ${binding.sourceSkill} 失败（非阻断）：${e.message}`)
      continue
    }
    for (const item of normalizeItems(raw)) {
      const { ok, item: filtered } = filterItem(item, allowed)
      if (!ok) rejectedCount += 1
      items.push({
        sourceSkill: binding.sourceSkill,
        sourceSkillVersion: binding.sourceSkillVersion,
        ...filtered,
      })
    }
  }

  const guidance = validateGuidance({
    items,
    catalogCompatibility: {
      sourceCommit,
      compatible: rejectedCount === 0,
      rejectedCount,
    },
  })
  return { guidance, warnings }
}

export default aggregateGuidance

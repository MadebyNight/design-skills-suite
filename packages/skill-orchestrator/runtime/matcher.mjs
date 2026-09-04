// C2：Capability 匹配器。
//
// 纯函数：只基于传入的 discovery 输出、request、preferredCapabilities 与 capabilities 决定选择，
// 不做 IO、不校验 Schema、不依赖外部注册表。
//
// 选择顺序（与 C2 计划一致）：
//   1. 用户显式指定（preferredSkillId）；
//   2. Schema 与 capability version 兼容（request.inputSchemaRef/outputSchemaRef + capabilities version）；
//   3. 当前环境可用（由 discovery 侧 executor 预先判定，这里仅取 discovery.skills）；
//   4. automatic/confirmation 要求符合任务（requireAutomatic / allowConfirmation）；
//   5. 配置的优先级（priority，数值越大越优先）；
//   6. 稳定排序，避免相同输入随机选择实现（priority 降序 → capability version 降序 → Skill ID → 规范化路径）。
import path from 'node:path'

const DEFAULT_PRIORITY = 0

/** 规范化路径：解析 . / .. 并转小写，用于稳定排序与判重（Windows 大小写不敏感）。 */
export function normalizePath(p) {
  return path.resolve(p).toLowerCase()
}

/** 把版本号切成段；纯数字段转为数值以便数值比较。 */
function versionSegments(v) {
  return String(v == null ? '' : v)
    .split('.')
    .map((seg) => (/^\d+$/.test(seg) ? Number(seg) : seg))
}

/** 版本比较：数值段数值比较，字符串段 localeCompare；缺段者靠后。 */
function compareVersions(a, b) {
  const sa = versionSegments(a)
  const sb = versionSegments(b)
  const n = Math.max(sa.length, sb.length)
  for (let i = 0; i < n; i++) {
    const x = sa[i]
    const y = sb[i]
    if (x === undefined) return y === undefined ? 0 : -1
    if (y === undefined) return 1
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return x - y
    } else if (String(x) !== String(y)) {
      return String(x).localeCompare(String(y))
    }
  }
  return 0
}

/**
 * 把 capabilities 入参归一化为条目数组。
 * 支持：
 *   - 数组：每条为 CapabilityManifest，可选带 `skillId` 绑定到具体 Skill；
 *   - 对象：以 skillId 为键，值为单条 CapabilityManifest 或条目数组。
 * 不带 skillId 的条目视为能力级条目，应用于所有提供该能力的候选 Skill。
 */
function normalizeCapabilities(capabilities) {
  if (capabilities == null) return []
  if (Array.isArray(capabilities)) return capabilities
  if (typeof capabilities === 'object') {
    const out = []
    for (const [key, value] of Object.entries(capabilities)) {
      if (Array.isArray(value)) {
        for (const v of value) out.push({ ...v, skillId: v.skillId ?? key })
      } else if (value && typeof value === 'object') {
        out.push({ ...value, skillId: value.skillId ?? key })
      }
    }
    return out
  }
  return []
}

/**
 * 从 capabilities 入参构建每个候选 Skill 的能力元数据（priority / version）。
 *
 * @param {Array|object} capabilities 可选的 CapabilityManifest 集合
 * @param {string} capability 请求的冻结能力 ID
 * @returns {{ bySkill: Map<string, {priority:number, version:string|null}>, byCapability: object }}
 */
function buildCapabilityMetadata(capabilities, capability) {
  const bySkill = new Map() // skillId -> { priority, version }（取版本最高的一条）
  const byCapability = new Map() // capabilityId -> { priority, version }（能力级默认）
  for (const entry of normalizeCapabilities(capabilities)) {
    // 只匹配冻结能力 ID：条目 id 若存在且不等于请求能力，则忽略。
    if (entry.id != null && entry.id !== capability) continue
    const priority = Number.isFinite(Number(entry.priority)) ? Number(entry.priority) : DEFAULT_PRIORITY
    const version = entry.version != null ? String(entry.version) : null
    const meta = { priority, version }
    if (entry.skillId != null) {
      // capability version 过滤：同一 Skill 注册多条版本时保留版本最高的一条。
      const existing = bySkill.get(entry.skillId)
      if (!existing || compareVersions(meta.version ?? '', existing.version ?? '') > 0) {
        bySkill.set(entry.skillId, meta)
      }
    } else {
      byCapability.set(capability, meta)
    }
  }
  return { bySkill, byCapability }
}

/** 取某候选 Skill 的有效优先级与版本（技能级优先，其次能力级，缺省 0）。 */
function metadataFor(bySkill, byCapability, capability, skillId) {
  const skillMeta = bySkill.get(skillId)
  if (skillMeta) return skillMeta
  const capMeta = byCapability.get(capability)
  if (capMeta) return capMeta
  return { priority: DEFAULT_PRIORITY, version: null }
}

/** 过滤请求约束；返回排除原因数组，为空表示可通过。 */
function buildRejectReasons(manifest, request) {
  const req = request || {}
  const reasons = []
  if (req.requireAutomatic === true && manifest.automatic !== true) {
    reasons.push('不满足 requireAutomatic：Skill 非自动执行')
  }
  if (
    req.allowConfirmation === false &&
    Array.isArray(manifest.confirmationPoints) &&
    manifest.confirmationPoints.length > 0
  ) {
    reasons.push('不满足 allowConfirmation=false：Skill 存在人工确认点')
  }
  if (req.inputSchemaRef && manifest.inputSchema !== req.inputSchemaRef) {
    reasons.push(`输入 Schema 不兼容（期望 ${req.inputSchemaRef}）`)
  }
  if (req.outputSchemaRef && manifest.outputSchema !== req.outputSchemaRef) {
    reasons.push(`输出 Schema 不兼容（期望 ${req.outputSchemaRef}）`)
  }
  return reasons
}

/**
 * Capability 匹配器（纯函数）。
 *
 * @param {object} input
 * @param {object} input.discovery          discoverSkills 的输出（使用其 .skills）
 * @param {string} input.capability         请求的能力冻结 ID
 * @param {object} [input.request]           请求约束，可选：
 *                                           requireAutomatic / inputSchemaRef / outputSchemaRef / allowConfirmation
 * @param {string} [input.preferredSkillId] 用户显式指定优先选择的 Skill ID
 * @param {object|Array} [input.capabilities] 可选的 CapabilityManifest 集合（见 normalizeCapabilities）
 * @returns {{
 *   selected: object|null,          // 选中的 Skill 记录 { root, manifest, priority, version }
 *   alternatives: object[],         // 其余候选，同样结构，稳定排序
 *   reason: string,                 // 选择 / 回退 / 缺失说明
 *   missing: string[],              // 未能满足的能力 ID 列表
 *   missingCapability: string|null, // 缺失的能力 ID（无候选可选时给出）
 *   confirmationPoints: string[],   // 选中 Skill 的人工确认点
 *   rejected: object[],             // 被过滤的候选，含排除原因 { root, manifest, reason }
 * }}
 */
export function matchCapability({ discovery, capability, request, preferredSkillId, capabilities } = {}) {
  const skills = Array.isArray(discovery?.skills) ? discovery.skills : []
  const req = request || {}

  // 1. 候选：仅取 discovery.skills 且 manifest.provides 包含该 capability。
  const candidates = skills
    .filter((s) => s?.manifest && Array.isArray(s.manifest.provides) && s.manifest.provides.includes(capability))
    .map((s) => ({
      root: s.root,
      manifest: s.manifest,
    }))

  const { bySkill, byCapability } = buildCapabilityMetadata(capabilities, capability)

  // 2. 过滤并记录 rejected；通过者保留 enriched 记录。
  const rejected = []
  const available = []
  for (const cand of candidates) {
    const reasons = buildRejectReasons(cand.manifest, req)
    if (reasons.length > 0) {
      rejected.push({ root: cand.root, manifest: cand.manifest, reason: reasons.join('；') })
    } else {
      const meta = metadataFor(bySkill, byCapability, capability, cand.manifest.id)
      available.push({ ...cand, priority: meta.priority, version: meta.version })
    }
  }

  const missing = []
  let missingCapability = null

  // 若该能力根本没有候选（discovery 无 Skill 提供它），视为缺失。
  if (candidates.length === 0) {
    missing.push(capability)
    missingCapability = capability
  }

  // 3. 稳定排序：priority 降序 → capability version 降序 → Skill ID → 规范化路径。
  const ranked = [...available].sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority
    const byVer = compareVersions(a.version ?? '', b.version ?? '')
    if (byVer !== 0) return byVer > 0 ? -1 : 1
    const byId = a.manifest.id.localeCompare(b.manifest.id)
    return byId !== 0 ? byId : normalizePath(a.root).localeCompare(normalizePath(b.root))
  })

  // 4. 显式指定优先；失败后回退到排名选择并记录原因。
  let selected = null
  let reason = ''
  const fallbackNotes = []

  if (preferredSkillId != null && preferredSkillId !== '') {
    const preferred = ranked.find((r) => r.manifest.id === preferredSkillId)
    if (preferred) {
      selected = preferred
      reason = `优先选择显式指定 Skill：${preferredSkillId}`
    } else {
      const wasRejected = rejected.some((r) => r.manifest.id === preferredSkillId)
      if (wasRejected) {
        const rej = rejected.find((r) => r.manifest.id === preferredSkillId)
        fallbackNotes.push(`显式指定 ${preferredSkillId} 被排除：${rej.reason}`)
      } else {
        fallbackNotes.push(`显式指定 ${preferredSkillId} 不在候选内`)
      }
    }
  }

  if (!selected && ranked.length > 0) {
    selected = ranked[0]
    reason = fallbackNotes.length > 0
      ? `${fallbackNotes.join('；')}，回退按优先级排序`
      : '按优先级排序选择'
  }

  if (!selected && candidates.length > 0) {
    // 有候选但全部被过滤。
    missing.push(capability)
    missingCapability = capability
    reason = fallbackNotes.length > 0
      ? `${fallbackNotes.join('；')}，无候选通过过滤`
      : '无候选通过过滤'
  }

  if (!selected && candidates.length === 0) {
    reason = fallbackNotes.length > 0
      ? `${fallbackNotes.join('；')}，无任何候选提供该能力`
      : '无任何候选提供该能力'
  }

  const alternatives = selected ? ranked.filter((r) => r !== selected) : ranked

  return {
    selected,
    alternatives,
    reason,
    missing: [...missing],
    missingCapability,
    confirmationPoints: selected && Array.isArray(selected.manifest.confirmationPoints)
      ? selected.manifest.confirmationPoints
      : [],
    rejected,
  }
}

export default matchCapability

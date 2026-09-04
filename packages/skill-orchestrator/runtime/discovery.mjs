// C1 最小骨架：Skill 发现器。
//
// 范围约束：
//  - 只扫描显式传入的 skillRoots；
//  - 以 manifest.json 为结构化真相源（SKILL.md 仅作为入口标记存在）；
//  - 复用 ../design-skill-contracts/scripts/validate.mjs 校验 SkillManifest，
//    不复制 Schema、不改合同、不安装依赖；
//  - executor 可注入，用于能力可用性探测；
//  - 目录不存在、缺文件、非法 manifest、executor 失败均不使整体崩溃。
import fs from 'node:fs'
import path from 'node:path'
import {
  Registry,
  validate,
  DEFAULT_SCHEMAS_DIR,
} from '../../design-skill-contracts/scripts/validate.mjs'

const SKILL_MANIFEST_ID =
  'http://schemas.design-agent.local/design-skill/v1/skill-manifest.schema.json'

// 单例 registry：整个进程复用同一份 Schema 加载结果。
let schemaRegistry = null
function getRegistry() {
  if (!schemaRegistry) schemaRegistry = Registry.fromDirectory(DEFAULT_SCHEMAS_DIR)
  return schemaRegistry
}

/** 规范化路径：解析 . / .. 并转小写，用于稳定排序与判重（Windows 大小写不敏感）。 */
function normalizePath(p) {
  return path.resolve(p).toLowerCase()
}

/** 读取并解析 manifest.json；返回 { ok, manifest, errors }。 */
function loadManifest(root) {
  const manifestFile = path.join(root, 'manifest.json')
  if (!fs.existsSync(manifestFile)) {
    return { ok: false, errors: [`缺文件 manifest.json（${manifestFile}）`] }
  }
  let raw
  try {
    raw = fs.readFileSync(manifestFile, 'utf8')
  } catch (e) {
    return { ok: false, errors: [`读取 manifest.json 失败：${e.message}`] }
  }
  let manifest
  try {
    manifest = JSON.parse(raw)
  } catch (e) {
    return { ok: false, errors: [`manifest.json 非法 JSON：${e.message}`] }
  }
  return { ok: true, manifest, errors: [] }
}

/**
 * 从单个 Skill 根目录读取一条 Skill。
 * 返回 { kind, ... }，kind 为 'ok' | 'invalid' | 'missing' | 'executor-failed'。
 * 本函数不做崩溃抛出；所有错误都以结构化结果返回。
 */
function readSkill(root) {
  const entry = { root: path.resolve(root) }

  // 目录不存在 / 非目录 → missing
  if (!fs.existsSync(entry.root) || !fs.statSync(entry.root).isDirectory()) {
    return { ...entry, kind: 'missing', reason: `目录不存在（${entry.root}）` }
  }

  // SKILL.md 缺失不视为致命，但记录到 manifest 缺文件信息中仍以 manifest 为准。
  const { ok, manifest, errors } = loadManifest(entry.root)
  if (!ok) return { ...entry, kind: 'invalid', reason: errors.join('；') }

  // 校验 SkillManifest
  const registry = getRegistry()
  const schema = registry.byId.get(SKILL_MANIFEST_ID)?.schema
  if (!schema) {
    return { ...entry, kind: 'invalid', reason: 'skill-manifest schema 未加载', manifest }
  }
  const errs = validate(manifest, schema, registry, schema.$id)
  if (errs.length > 0) {
    return { ...entry, kind: 'invalid', reason: errs.join('；'), manifest }
  }

  return { ...entry, kind: 'ok', manifest }
}

/**
 * 扫描并发现 Skill。
 *
 * @param {object} opts
 * @param {string[]} opts.skillRoots  显式 Skill 根目录列表
 * @param {object} [opts.executor]   可注入可用性探测，async ({ root, manifest }) => boolean；
 *                                    缺省视为可用；抛错或返回 false 记为不可用。
 * @returns {{
 *   skills: Array,        // 可用 Skill，稳定排序（按 id，再按规范化路径）
 *   byCapability: object, // capability ID -> Skill ID 列表
 *   unavailable: Array,   // 不可用 Skill（含 reason）
 *   duplicates: Array,    // 重复 Skill ID 记录
 * }}
 */
export async function discoverSkills({ skillRoots, executor } = {}) {
  const roots = Array.isArray(skillRoots) ? skillRoots : []
  const exec = typeof executor === 'function' ? executor : async () => true

  // 1. 读取全部候选
  const candidates = []
  for (const root of roots) {
    if (typeof root !== 'string' || !root) continue
    candidates.push(readSkill(root))
  }

  // 2. 分组：非法/缺失先进入 unavailable
  const unavailable = []
  const okSkills = []
  for (const c of candidates) {
    if (c.kind === 'ok') okSkills.push(c)
    else unavailable.push({ id: null, root: c.root, reason: c.reason })
  }

  // 3. 去重：按 Skill ID 分组，组内按规范化路径排序，保留第一个，其余记 duplicate
  const byId = new Map() // id -> { skill, normalizedRoot }
  const duplicates = []
  for (const c of [...okSkills].sort(byPathSort)) {
    const id = c.manifest.id
    const norm = normalizePath(c.root)
    const existing = byId.get(id)
    if (!existing) {
      byId.set(id, { skill: c })
      continue
    }
    // 规范化路径排序，保留路径序更靠前的
    if (norm < normalizePath(existing.skill.root)) {
      duplicates.push({
        id,
        root: existing.skill.root,
        duplicateRoot: c.root,
        keptRoot: c.root,
      })
      byId.set(id, { skill: c })
    } else {
      duplicates.push({ id, root: c.root, duplicateRoot: c.root, keptRoot: existing.skill.root })
    }
  }

  // 4. 执行 executor 可用性探测（保留首个；其余重复项不再探测）
  const skills = []
  for (const { skill } of byId.values()) {
    let available = true
    let reason = null
    try {
      available = (await exec({ root: skill.root, manifest: skill.manifest })) === true
      if (!available) reason = 'executor 判定不可用'
    } catch (e) {
      available = false
      reason = `executor 失败：${e.message}`
    }
    if (!available) {
      unavailable.push({ id: skill.manifest.id, root: skill.root, reason: reason || '不可用' })
    } else {
      skills.push(skill)
    }
  }

  // 5. 稳定排序：按 id 排序；同 id 按规范化路径排序
  const sortedSkills = skills
    .map((s) => s)
    .sort((a, b) => {
      const byId = a.manifest.id.localeCompare(b.manifest.id)
      return byId !== 0 ? byId : normalizePath(a.root).localeCompare(normalizePath(b.root))
    })

  // 6. 构建 byCapability
  const byCapability = {}
  for (const s of sortedSkills) {
    for (const cap of s.manifest.provides) {
      if (!byCapability[cap]) byCapability[cap] = []
      byCapability[cap].push(s.manifest.id)
    }
  }
  // capability 键稳定排序
  const orderedByCapability = {}
  for (const key of Object.keys(byCapability).sort()) {
    orderedByCapability[key] = byCapability[key]
  }

  return {
    skills: sortedSkills,
    byCapability: orderedByCapability,
    unavailable: unavailable.sort((a, b) => normalizePath(a.root).localeCompare(normalizePath(b.root))),
    duplicates: duplicates.sort((a, b) => normalizePath(a.root).localeCompare(normalizePath(b.root))),
  }
}

export { normalizePath }

/** 供去重分组前稳定排序使用：先按 id，再按规范化路径。 */
function byPathSort(a, b) {
  const byId = a.manifest.id.localeCompare(b.manifest.id)
  return byId !== 0 ? byId : normalizePath(a.root).localeCompare(normalizePath(b.root))
}

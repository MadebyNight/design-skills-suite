// C3：研究信号包装配（ResearchPack）。
//
// 纯编排：仅基于传入的 brief、searchBinding、catalog 与 maxQueries 构造研究包。
// 不联网、不安装依赖；searchBinding 由调用方注入，返回结构化的检索结果。
//
// 结果对象统一为 { status, pack, warnings }：
//   status: 'skipped' | 'succeeded' | 'warning' | 'failed'
//   pack  : ResearchPack（status 为 succeeded 时非 null）或 null
//   warnings: 字符串数组
//
// 处理规则：
//   - brief.researchPolicy === 'none'    → skipped，pack null；
//   - 'optional' 且 检索缺失/失败/空结果 → warning，pack null；
//   - 'required' 且 检索缺失/失败/空结果 → failed，pack null；
//   - 成功：归一化 url/title/snippet，生成 queries/sources/signals/adoptedElements，
//     输出经 ResearchPack Schema 校验。
import path from 'node:path'
import { Registry, validate } from '../../design-skill-contracts/scripts/validate.mjs'

const RESEARCH_SCHEMA_ID =
  'http://schemas.design-agent.local/design-skill/v1/research-pack.schema.json'

const SIGNAL_KINDS = ['visual', 'color', 'layout', 'content']

// 各 signal kind 的启发式关键词：命中即归为该类，用于从检索文本稳定生成信号。
const SIGNAL_RULES = {
  color: ['配色', '色彩', '色调', 'color', 'palette', 'tone'],
  layout: ['布局', '版式', '栅格', '排版', 'layout', 'grid'],
  content: ['文案', '内容', '信息', '文本', 'content', 'copy'],
  visual: ['视觉', '风格', '质感', '氛围', '强调', 'visual', 'style'],
}

function getRegistry() {
  return Registry.fromDirectory(
    path.resolve(import.meta.dirname, '..', '..', 'design-skill-contracts', 'schemas'),
  )
}

/** 校验 ResearchPack；不合法直接抛错，合法返回原对象。 */
export function validateResearchPack(pack) {
  const registry = getRegistry()
  const schema = registry.byId.get(RESEARCH_SCHEMA_ID)?.schema
  if (!schema) throw new Error('ResearchPack schema 未加载')
  const errors = validate(pack, schema, registry, schema.$id)
  if (errors.length) throw new Error(`ResearchPack 校验失败：${errors.join('；')}`)
  return pack
}

/**
 * 从 brief 派生检索查询；稳定去重并截断到 maxQueries 条。
 * 字段缺失或非字符串时静默跳过，保证最小实现不崩溃。
 */
export function buildQueries(brief = {}, maxQueries = 3) {
  const max = Math.max(1, Number.isFinite(Number(maxQueries)) ? Number(maxQueries) : 3)
  const parts = []
  if (typeof brief.goal === 'string' && brief.goal) parts.push(brief.goal)
  if (Array.isArray(brief.visualConstraints)) parts.push(...brief.visualConstraints)
  if (Array.isArray(brief.contentRequirements)) parts.push(...brief.contentRequirements)
  const unique = [...new Set(parts.filter((p) => typeof p === 'string' && p.trim()))]
  return unique.slice(0, max)
}

/** 归一化单条检索结果；缺 url/title/snippet 的丢弃。 */
function normalizeResult(raw) {
  if (!raw || typeof raw !== 'object') return null
  const url = raw.url || raw.link || raw.href
  const title = raw.title
  const snippet = raw.snippet || raw.description || raw.summary
  if (
    typeof url !== 'string' || !url ||
    typeof title !== 'string' || !title ||
    typeof snippet !== 'string' || !snippet
  ) {
    return null
  }
  let parsed
  try { parsed = new URL(url) } catch { return null }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null
  return { url: parsed.href, title: title.trim(), snippet: snippet.trim() }
}

/** 归一化检索输出：容忍数组或 { results: [...] }，按 url 去重并稳定排序。 */
function normalizeResults(raw) {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.results)
      ? raw.results
      : []
  const seen = new Set()
  const out = []
  for (const item of list) {
    const s = normalizeResult(item)
    if (!s || seen.has(s.url)) continue
    seen.add(s.url)
    out.push(s)
  }
  return out.sort((a, b) => a.url.localeCompare(b.url))
}

/** 生成四类信号（visual/color/layout/content），sourceRefs 指向来源 URL。 */
function buildSignals(sources) {
  const allUrls = sources.map((s) => s.url)
  return SIGNAL_KINDS.map((kind) => {
    const keywords = SIGNAL_RULES[kind]
    const matched = sources.filter((s) =>
      keywords.some((k) => `${s.title} ${s.snippet}`.toLowerCase().includes(k)),
    )
    const refs = matched.length ? matched.map((s) => s.url) : allUrls
    const value = matched.length
      ? `依据「${matched[0].title}」：${matched[0].snippet}`
      : `未检索到明确 ${kind} 信号，沿用基线`
    return { kind, value, sourceRefs: refs }
  })
}

/** 生成采纳元素：仅取 catalog 内组件，sourceRefs 指向来源 URL。 */
function buildAdopted(sources, catalog) {
  const urls = sources.map((s) => s.url)
  const components = Array.isArray(catalog?.components) ? catalog.components : []
  const text = sources.map((s) => `${s.title} ${s.snippet}`.toLowerCase()).join(' ')
  const matched = components.filter((c) => c.id && text.includes(String(c.id).toLowerCase()))
  const pool = matched.length ? matched : components.slice(0, 1)
  return pool.map((c) => ({
    element: c.id,
    reason: matched.length ? `研究确认采用组件「${c.id}」` : `沿用组件基线「${c.id}」`,
    sourceRefs: urls,
  }))
}

/**
 * 构建研究信号包（C3）。
 *
 * @param {object} input
 * @param {object} input.brief          DesignBrief（含 researchPolicy）
 * @param {Function} input.searchBinding async (queries) => source[]，注入不联网
 * @param {object} [input.catalog]      ComponentCatalog，用于 adoptedElements 过滤
 * @param {number} [input.maxQueries=3] 最多派生检索条数
 * @returns {Promise<{status:string, pack:object|null, warnings:string[]}>}
 */
export async function buildResearchPack({ brief = {}, searchBinding, catalog, maxQueries = 3 } = {}) {
  const policy = brief.researchPolicy
  const warnings = []

  if (policy === 'none') {
    return { status: 'skipped', pack: null, warnings: ['研究被跳过（researchPolicy=none）'] }
  }
  if (policy !== 'optional' && policy !== 'required') {
    return { status: 'failed', pack: null, warnings: [`不支持的 researchPolicy：${policy}`] }
  }

  const queries = buildQueries(brief, maxQueries)
  let sources = []
  let error = null
  try {
    const raw = typeof searchBinding === 'function' ? await searchBinding(queries) : null
    sources = normalizeResults(raw)
  } catch (e) {
    error = e
  }

  if (error) warnings.push(`检索失败：${error.message}`)
  else if (sources.length === 0) warnings.push('检索无有效结果')

  if (error || sources.length === 0) {
    if (policy === 'optional') return { status: 'warning', pack: null, warnings }
    return { status: 'failed', pack: null, warnings }
  }

  const pack = validateResearchPack({
    queries,
    sources,
    signals: buildSignals(sources),
    adoptedElements: buildAdopted(sources, catalog),
  })
  return { status: 'succeeded', pack, warnings: [] }
}

export default buildResearchPack

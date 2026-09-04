#!/usr/bin/env node
// 支付宝首页设计 Skill CLI。
//
// 子命令：
//   home-design capabilities
//      输出本 Skill 提供的能力清单
//   home-design request --file <path> [--output <dir>] [--screenshot]
//      [--home-theme <text>] [--landing-themes <json>] [--landing-preview-refs <json>]
//      从 JSON 文件读取 DesignBrief 并设计首页
//   home-design request --json <json> [--output <dir>] [--screenshot]
//      [--home-theme <text>] [--landing-themes <json>] [--landing-preview-refs <json>]
//      从内联 JSON 读取 DesignBrief 并设计首页
//
// 可选主题参数：homeTheme 决定整页风格与搜索占位文案；landingThemes 为落地页主题
// 数组（字符串或 {landingKey, theme, landingPreviewRef?} 对象，兼容编排器 pageLinkage）：
// 对象形的显式 landingKey 原样保留（不重新编号），landingPreviewRef 统一规范为
// prototype.html 文件路径；仅成功落地页登记 ref，失败落地页不写失效引用。
// 原型后处理：carousel（home-banner）与腰封（home-waist-banner）在预览目标
// 位于本交付目录内可解析时包一层 <a>，生成可点击离线预览链接；目标不存在时
// 不产生死链（validateOutput 会拒绝越界/缺失资源），ref 仍保留在配置中并记 warnings。
//
// 输出（JSON）：{ ok, status, designPackage, pendingAssetRequests, warnings }
// 稳定错误：{ ok: false, code, message, details }
//
// 交付（四项同源）：home-config.json（alipay-home-config/v1 唯一配置合同）、
// prototype.html、assets/、configuration-guide.md 均由同一份配置派生并由
// DesignPackage 记录。缺图槽位保留默认素材但 status 为 completed_with_pending_assets，
// 绝不伪装 succeeded；配置派生或交付校验失败时整体失败，不产出残缺交付。
//
// 约束：受控 Node 工具链，不安装依赖；screenshot 复用 skill-alipay-pages 脚本。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assemblePage } from '../../skill-alipay-pages/scripts/assemble.mjs'
import { validateOutput } from '../../skill-alipay-pages/scripts/validate.mjs'
import { buildDesignPackage } from '../../skill-alipay-pages/scripts/package.mjs'
import { planHome, normalizeDesignBrief, HOME_PACKAGE_ROOT, loadHomeCatalog, detectConstraintViolation, deriveHomeConfig, enumerateHomeConfigImageSlots, HOME_CONFIG_SCHEMA_ID } from '../runtime/planner.mjs'
import { normalizePendingAssetRequests } from '../runtime/asset-requester.mjs'
import { CONTRACT_DIR, parseHtml, serialize, collectTags, classesOf } from '../../skill-alipay-pages/scripts/build-catalog.mjs'
import { Registry, validate } from '../../design-skill-contracts/scripts/validate.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const manifest = JSON.parse(fs.readFileSync(path.join(HOME_PACKAGE_ROOT, 'manifest.json'), 'utf8'))
const SCHEMA_DIR = path.join(CONTRACT_DIR, 'schemas')

/**
 * 按公共 Schema 重新校验 home-config（对象形显式 landingKey 校正后使用）。
 */
function assertHomeConfigValid(config) {
  const registry = Registry.fromDirectory(SCHEMA_DIR)
  const schema = registry.byId.get(HOME_CONFIG_SCHEMA_ID)?.schema
  if (!schema) throw new Error('alipay-home-config schema 未加载')
  const errors = validate(config, schema, registry, schema.$id)
  if (errors.length) {
    const error = new Error(`派生的 home config 校验失败：${errors.join('；')}`)
    error.code = 'INVALID_HOME_CONFIG'
    error.details = errors
    throw error
  }
}

/**
 * 对象形显式 landingKey 校正：deriveHomeConfig 只接收字符串数组并按位置分配
 * landing-01…（runtime/planner 不可改），这里把编排器 pageLinkage 传入的显式
 * landingKey（按主题名对齐）写回 config.landingThemes 与 carousel/waistBanners，
 * 再按公共 Schema 重新校验。仅对象形且显式 key 非法（不匹配 ^landing-\d{2,}$）
 * 时按稳定错误码拒绝；合法性终判仍由 Schema 与 normalizeLandingPreviewRefs 保证。
 * @returns {{ themes: Array<{landingKey,theme,source}>, keyByTheme: Map<string,string> }}
 */
function collectExplicitKeys(landingThemes) {
  const keyByTheme = new Map()
  if (landingThemes === undefined || landingThemes === null || !Array.isArray(landingThemes)) return keyByTheme
  landingThemes.forEach((raw, i) => {
    const landingKey = typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      && typeof raw.landingKey === 'string' && raw.landingKey ? raw.landingKey : null
    if (landingKey) keyByTheme.set(String(raw.theme).trim(), landingKey)
  })
  return keyByTheme
}

/** 用显式 key 表校正已派生 config 的 landingThemes/carousel/waistBanners 并重校验。 */
function applyExplicitKeys(homeConfig, keyByTheme) {
  if (!keyByTheme.size) return
  const replaced = new Set()
  homeConfig.landingThemes = homeConfig.landingThemes.map((entry) => {
    if (replaced.has(entry.theme)) return entry
    const key = keyByTheme.get(entry.theme)
    if (!key) return entry
    replaced.add(entry.theme)
    return { ...entry, landingKey: key }
  })
  for (const module of ['carousel', 'waistBanners']) {
    const usedThemes = new Set()
    homeConfig[module] = homeConfig[module].map((item) => {
      if (usedThemes.has(item.contentTheme || '')) return item
      const key = keyByTheme.get(item.contentTheme || '')
      if (!key) return item
      usedThemes.add(item.contentTheme || '')
      return { ...item, landingKey: key }
    })
  }
  assertHomeConfigValid(homeConfig)
}

const CAPABILITIES = [
  {
    id: 'page.alipay.home.design',
    version: '1.0.0',
    inputSchema: 'design-brief.schema.json',
    outputSchema: 'design-package.schema.json',
    automatic: true,
    priority: 10,
    availabilityCommand: 'home-design capabilities',
  },
]

function printCapabilities() {
  console.log(JSON.stringify({ skillManifest: manifest, capabilities: CAPABILITIES }, null, 2))
}

function ok(payload) {
  console.log(JSON.stringify(payload, null, 2))
}

function fail(code, message, details = []) {
  const out = { ok: false, code, message, details }
  console.log(JSON.stringify(out, null, 2))
  process.exitCode = 1
}

/**
 * 从同一份 home-config.json 派生面向运营的配置建议（configuration-guide.md）。
 * 只表达配置事实与待确认事项，不包含生产 jumpUrl、发布或缓存字段。
 */
function renderConfigurationGuide(brief, config, warnings = []) {
  const lines = []
  lines.push('# 首页配置建议')
  lines.push('')
  lines.push(`首页主题：${config.homeTheme}`)
  lines.push('')
  lines.push('本指南由 home-config.json（alipay-home-config/v1）派生，与静态原型、素材包同源。以下仅为视觉设计建议，页面配置不是可直接部署或发布的完整前端配置，真实商品、资源 ID、路由、页面编码、草稿与发布由对应业务系统负责。')
  if (brief.outputSpec?.width !== 375) lines.push('- 预览按 375px 基准生成；请求宽度仅作为交付说明，不改变受控原型基准。')
  lines.push('')
  lines.push('## 顶部搜索栏')
  lines.push('')
  lines.push(`- 提示文案（≤20 字）：${config.searchBar.placeholderText}`)
  lines.push(`- 顶部栏背景色：${config.searchBar.topBarBackgroundColor}；搜索框背景色：${config.searchBar.inputBackgroundColor}；按钮背景色：${config.searchBar.inputButtonBackgroundColor}`)
  lines.push(`- 圆角（rpx）：顶部栏 ${config.searchBar.topBarCornerRadiusRpx}（0–44）、输入框 ${config.searchBar.inputCornerRadiusRpx}（0–34）`)
  lines.push('')
  lines.push('## 轮播图与腰封')
  lines.push('')
  lines.push(`- 轮播图 ${config.carousel.length} 张、腰封 ${config.waistBanners.length} 张，内容主题对应落地页主题；生产目标比例：轮播 1404x600、腰封 1440x328（误差 ≤3%）。`)
  for (const item of config.carousel) {
    const ref = item.landingPreviewRef ? `；本地预览：${item.landingPreviewRef}` : '；关联落地页预览不可用'
    lines.push(`  - carousel ${item.image}（主题：${item.contentTheme || '未指定'}）${ref}`)
  }
  for (const item of config.waistBanners) {
    const ref = item.landingPreviewRef ? `；本地预览：${item.landingPreviewRef}` : '；关联落地页预览不可用'
    lines.push(`  - waist ${item.image}（主题：${item.contentTheme || '未指定'}）${ref}`)
  }
  lines.push('- 固定轮播行为（循环、3 秒、圆点指示）保持既有实现，不输出圆角、切换方式、自动播放或间隔配置。')
  lines.push('')
  lines.push('## 金刚区（home-nav）')
  lines.push('')
  lines.push(`- 槽位 ${config.quickEntries.entries.length} 个（5 列 ${config.quickEntries.entries.length / 5} 行），前 5 项保持样例名称与顺序；新增项只使用连续编号 06–25。`)
  lines.push('- 生产发布上限与方案切换由页面搭建生产系统决定，此处不做兼容性标记。')
  lines.push('')
  lines.push('## 豆腐块')
  lines.push('')
  lines.push('- 固定 3 个图片槽位（左主图 690x640、右上/右下 690x312），不生成文案。')
  lines.push('')
  lines.push('## 商品推荐')
  lines.push('')
  lines.push('- 固定 preserve-existing：保留既有内容，实际商品通过既有商品接口维护，不在本配置内生成或改写。')
  lines.push('')
  if (config.landingThemes.length) {
    lines.push('## 落地页主题关联')
    lines.push('')
    for (const theme of config.landingThemes) {
      lines.push(`- ${theme.landingKey}：${theme.theme}（来源：${theme.source}）`)
    }
    lines.push('- landingPreviewRef 仅指向包内对应落地页原型的相对路径，只用于离线预览，不等同于生产跳转。')
    lines.push('')
  }
  lines.push('## 待确认与素材')
  lines.push('')
  lines.push('- 跳转（jumpUrl）不在此确认；请在业务系统中配置并校验。')
  lines.push('- 素材槽位比例验收以 home-config 中相对路径素材为准；素材原图位于 assets/。')
  for (const warning of warnings) lines.push(`- 注意：${warning}`)
  lines.push('')
  return lines.join('\n')
}

function replaceFailedAssetImages(outputRoot, failedUsageSlots) {
  if (!failedUsageSlots.size) return
  const prototypePath = path.join(outputRoot, 'prototype.html')
  let html = fs.readFileSync(prototypePath, 'utf8')
  for (const usageSlot of failedUsageSlots) {
    const outputPath = `assets/${usageSlot}.png`
    const escaped = outputPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    html = html.replace(new RegExp(`<img\\b[^>]*\\bsrc="${escaped}"[^>]*>`, 'g'), '<span class="home-search__placeholder">素材生成失败</span>')
  }
  fs.writeFileSync(prototypePath, html)
}

function writeVisualReview({ outputRoot, slots, acceptedUsageSlots, failedUsageSlots, visionModelConfigured = false }) {
  const entries = slots.map((slot) => {
    const rules = acceptedUsageSlots.has(slot.usageSlot) ? 'accepted' : (failedUsageSlots.has(slot.usageSlot) ? 'failed' : 'pending')
    const note = rules === 'accepted' ? '已验收素材已回填' : (rules === 'failed' ? '素材生成重试耗尽，原型显示素材生成失败' : '原型暂用组件快照素材')
    return { usageSlot: slot.usageSlot, rules, note }
  })
  const warnings = visionModelConfigured ? [] : ['视觉模型未配置，已跳过可选视觉评审']
  fs.writeFileSync(path.join(outputRoot, 'visual-review.json'), JSON.stringify({
    visionModelConfigured,
    warnings,
    sections: [{ name: 'assets', entries }, { name: 'page', rules: 'pending' }],
  }, null, 2) + '\n')
  return warnings
}

async function runRequest(args) {
  const fileIdx = args.indexOf('--file')
  const jsonIdx = args.indexOf('--json')
  const outputIdx = args.indexOf('--output')
  const wantsScreenshot = args.includes('--screenshot')

  const readJsonFlag = (flagName) => {
    const idx = args.indexOf(flagName)
    if (idx === -1) return { present: false }
    const value = args[idx + 1]
    if (value === undefined) return { present: true, error: () => fail('USAGE', `${flagName} 需要 JSON 字符串`) }
    try {
      return { present: true, value: JSON.parse(value) }
    } catch (e) {
      return { present: true, error: () => fail('INVALID_JSON', `${flagName} 不是合法 JSON`, [e.message]) }
    }
  }
  const homeThemeIdx = args.indexOf('--home-theme')
  const themesFlag = readJsonFlag('--landing-themes')
  const refsFlag = readJsonFlag('--landing-preview-refs')

  let raw = null
  if (fileIdx !== -1) {
    const filePath = args[fileIdx + 1]
    if (!filePath) return fail('USAGE', '--file 需要文件路径')
    if (!fs.existsSync(filePath)) return fail('FILE_NOT_FOUND', `文件不存在: ${filePath}`)
    raw = fs.readFileSync(filePath, 'utf8')
  } else if (jsonIdx !== -1) {
    const json = args[jsonIdx + 1]
    if (!json) return fail('USAGE', '--json 需要 JSON 字符串')
    raw = json
  } else {
    return fail('USAGE', 'request 需要 --file 或 --json')
  }

  let brief
  try {
    brief = normalizeDesignBrief(raw)
  } catch (e) {
    return fail(e.code || 'INVALID_BRIEF', e.message, e.details || [])
  }

  const outputRoot = outputIdx !== -1 ? path.resolve(args[outputIdx + 1]) : null
  if (!outputRoot) return fail('USAGE', '缺少 --output 输出目录')

  if (themesFlag.present && themesFlag.error) return themesFlag.error()
  if (refsFlag.present && refsFlag.error) return refsFlag.error()

  try {
    const result = await designHome({
      brief,
      outputRoot,
      screenshot: wantsScreenshot,
      ...(homeThemeIdx !== -1 ? { homeTheme: args[homeThemeIdx + 1] || '' } : {}),
      ...(themesFlag.present ? { landingThemes: themesFlag.value } : {}),
      ...(refsFlag.present ? { landingPreviewRefs: refsFlag.value } : {}),
    })
    ok({ ok: true, status: result.status, designPackage: result.designPackage, pendingAssetRequests: result.pendingAssetRequests, warnings: result.warnings, ...(result.rejection ? { rejection: result.rejection } : {}) })
  } catch (e) {
    return fail(e.code || 'INTERNAL', e.message, e.details || [])
  }
}

/**
 * 解析页面联动可选参数（编排器/CLI 双入口共用）。
 * landingThemes 兼容编排器 pageLinkage 的对象形 [{landingKey, theme, landingPreviewRef?}]：
 *  - 对象形的显式 landingKey 原样保留（不重新编号）；缺省时按位置派生 landing-01 格式。
 *  - 对象形携带非空 landingPreviewRef 即视为成功落地页；ref 值仅作成功信号，
 *    统一规范为任务内相对路径 <landingKey>/prototype.html（本交付目录下的离线预览）。
 *  - 字符串形主题按序透传；显式空数组透传后由 deriveHomeConfig 稳定拒绝。
 * 显式 landingPreviewRefs 数组同样以 {landingKey, landingPreviewRef} 传入，
 * ref 仅判真即登记，路径统一规范后由 deriveHomeConfig 按 contracts 校验。
 * @returns {{ homeTheme?: string, landingThemes?: Array, landingPreviewRefs?: Array }}
 */
function parseLinkageOptions({ homeTheme, landingThemes, landingPreviewRefs } = {}) {
  if (homeTheme !== undefined && (typeof homeTheme !== 'string' || !homeTheme.trim())) {
    const error = new Error('homeTheme 必须是非空字符串')
    error.code = 'INVALID_HOMETHEME'
    throw error
  }
  const themes = []
  const refs = []
  const seenRefKeys = new Set()
  // 统一规范为 <landingKey>/prototype.html：相对本交付目录的离线预览路径。
  const previewRefOf = (landingKey) => `${landingKey}/prototype.html`
  const pushRef = (landingKey) => {
    if (seenRefKeys.has(landingKey)) {
      const error = new Error(`landingPreviewRefs 重复 landingKey：${landingKey}`)
      error.code = 'INVALID_LANDING_PREVIEW_REFS'
      throw error
    }
    seenRefKeys.add(landingKey)
    refs.push({ landingKey, landingPreviewRef: previewRefOf(landingKey) })
  }
  if (landingThemes !== undefined && landingThemes !== null) {
    if (!Array.isArray(landingThemes)) {
      const error = new Error('landingThemes 必须是数组')
      error.code = 'INVALID_LANDING_THEMES'
      throw error
    }
    for (const [i, raw] of landingThemes.entries()) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        if (typeof raw !== 'string') {
          const error = new Error(`landingThemes[${i}] 必须是非空字符串或 {landingKey, theme} 对象`)
          error.code = 'INVALID_LANDING_THEMES'
          throw error
        }
        themes.push(raw)
        continue
      }
      if (typeof raw.theme !== 'string' || raw.theme.trim() === '') {
        const error = new Error(`landingThemes[${i}].theme 必须是非空字符串`)
        error.code = 'INVALID_LANDING_THEMES'
        throw error
      }
      // 对象形显式 landingKey 原样保留，绝不按位置重新编号。
      const explicitKey = typeof raw.landingKey === 'string' && raw.landingKey ? raw.landingKey : null
      themes.push(raw.theme.trim())
      if (typeof raw.landingPreviewRef === 'string' && raw.landingPreviewRef) {
        pushRef(explicitKey || `landing-${String(i + 1).padStart(2, '0')}`)
      }
    }
  }
  if (landingPreviewRefs !== undefined && landingPreviewRefs !== null) {
    if (!Array.isArray(landingPreviewRefs)) {
      const error = new Error('landingPreviewRefs 必须是数组')
      error.code = 'INVALID_LANDING_PREVIEW_REFS'
      throw error
    }
    for (const raw of landingPreviewRefs) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.landingKey !== 'string' || !raw.landingKey) {
        const error = new Error('landingPreviewRefs 条目必须是 {landingKey, landingPreviewRef} 对象')
        error.code = 'INVALID_LANDING_PREVIEW_REFS'
        throw error
      }
      // ref 值不直接透传：规范为 prototype.html 文件路径（只认 key，ref 仅判真）。
      pushRef(raw.landingKey)
    }
  }
  return {
    ...(homeTheme !== undefined ? { homeTheme } : {}),
    // 显式传入（含空数组）原样透传，空数组由 deriveHomeConfig 按稳定错误码拒绝；
    // 完全未传时省略字段以使用默认两主题。
    ...(landingThemes !== undefined && landingThemes !== null ? { landingThemes: themes } : {}),
    // 对象形内嵌 ref 与显式 landingPreviewRefs 都汇入 refs；无 ref 时不携带该字段。
    ...(refs.length ? { landingPreviewRefs: refs } : {}),
  }
}

// 首页原型中与落地页主题联动的受控视觉模块。
// module：home-config 条目（每 theme 一项，成功与否均保留视觉容器）；
// templateId/className：catalog 已登记的受控模板单元（克隆自 domTemplate，非新增组件或 class）。
const PREVIEW_MODULES = [
  { module: 'carousel', templateId: 'home-banner', className: 'home-banner' },
  { module: 'waistBanners', templateId: 'home-waist-banner', className: 'home-waist-banner' },
]

/**
 * 用 skill-alipay-pages 的受控解析器给单个受控节点外层包 <a href>（仅属性值回填 + 完整子树包裹，
 * 属"受控槽位回填 + Catalog 单元克隆"允许的 DOM 变换，不新增 class/style/script）。
 */
function wrapWithAnchor(node, href) {
  return {
    kind: 'tag',
    tag: 'a',
    attrs: [{ name: 'href', value: href }],
    children: [node],
  }
}

/** 读取受控文本节点的纯文本（用于腰封 count 更新）。 */
function nodeText(node) {
  return collectTags([node], 'span')
    .flatMap((span) => span.children.filter((c) => c.kind === 'text').map((c) => c.text))
    .join('')
    .trim()
}

/**
 * 从 home catalog 取受控 domTemplate（页面 Skill 只读消费 Catalog，不改写快照）。
 */
function controlledTemplate(catalog, templateId) {
  const component = catalog.components.find((c) => c.id === templateId)
  if (!component) throw new Error(`home catalog 缺少受控模板：${templateId}`)
  const doms = parseHtml(component.domTemplate).filter((node) => node.kind === 'tag')
  if (!doms.length) throw new Error(`受控模板缺少 DOM：${templateId}`)
  return doms[0]
}

/**
 * 原型后处理：按 home-config 的条目为 carousel（home-banner）与腰封
 * （home-waist-banner）受控重建视觉容器——每个 landingKey 一个独立节点
 * （基线：失败落地页仍保留该主题的视觉内容），ref 存在且目标文件真实存在
 * 时才额外包一层 <a href> 生成独立、不嵌套的离线预览链接。
 *
 * 受控边界（不修改共享 pages 包，不引入自由组件/CSS/JS）：
 *  - 模板克隆：以 home catalog 的 domTemplate（home-banner / home-waist-banner）
 *    为单元 structuredClone 实例化，与 applyHomeNav 同一克隆原语；
 *  - 腰封 count 文案（受控槽位内文本）按序更新为 "i / N"（与全部条目数同源）；
 *  - 重建条件：模块条目数 >1，或任一条目 ref 有效。多条目且全部失败（无 ref）时
 *    仍按全部条目克隆独立视觉容器（不包 <a>），不再退化为单个源节点；
 *  - 单条目且无链接：保持源节点兼容（旧独立调用不重建、不记多余警告）；
 *  - 无 ref / ref 目标不存在的条目：保留纯视觉容器（不包 <a>、不产生死链），
 *    ref 保留在 home-config 并记 warning，配置指南标记预览不可用；
 *  - 已存在的源节点仅取首个匹配作为图片回填样式来源（其余按 catalog 允许的
 *    "删除完整子树"移除），最终 main 内只有与 config 条目同源的克隆节点；
 *  - 输出仍满足 validateOutput：class 全部来自 Catalog、无新增 script/style、
 *    href 目标必须真实存在。
 * @returns {string[]} 后处理 warnings
 */
function applyOfflinePreviewLinks({ outputRoot, homeConfig, catalog }) {
  const warnings = []
  const prototypePath = path.join(outputRoot, 'prototype.html')
  const { root, main } = (() => {
    const parsed = parseHtml(fs.readFileSync(prototypePath, 'utf8'))
    const mainNode = collectTags(parsed, 'main')[0]
    if (!mainNode) throw new Error('原型缺少 main 容器，无法生成离线预览链接')
    return { root: parsed, main: mainNode }
  })()

  for (const { module, templateId, className } of PREVIEW_MODULES) {
    const items = homeConfig[module] || []
    if (!items.length) continue
    const template = controlledTemplate(catalog, templateId)

    // 每个条目预解析链接合法性：{ ref } 有链接，null 纯视觉。
    // 受控重建条件：模块条目数 >1（即使全部无 ref，也让每个失败主题各自保留视觉），
    // 或任一条目 ref 有效；单条目且无链接时保持源节点兼容（旧独立调用，不记警告）。
    const shouldRebuild = items.length > 1 || items.some((item) => item.landingPreviewRef)
    if (!shouldRebuild) continue
    const rebuildWarnings = []
    const entries = items.map((item) => {
      const ref = item.landingPreviewRef
      if (!ref) {
        rebuildWarnings.push(`关联落地页预览不可用（${item.landingKey}）：保留主题视觉内容，不建立预览链接`)
        return { ref: null, item }
      }
      // 规范层已保证无 .. 与反斜杠，这里防御性跳过越界路径。
      if (ref.includes('..') || ref.includes('\\')) {
        rebuildWarnings.push(`landingPreviewRef 路径非法，未生成预览链接：${ref}`)
        return { ref: null, item }
      }
      if (!fs.existsSync(path.resolve(outputRoot, ref))) {
        rebuildWarnings.push(`关联落地页原型不存在，未生成预览链接：${ref}`)
        return { ref: null, item }
      }
      return { ref, item }
    })
    warnings.push(...rebuildWarnings)

    // 受控重建：源节点仅取第一处匹配（取其图片回填结果），按全部条目生成克隆。
    const sourceNodes = main.children.filter(
      (node) => node.kind === 'tag' && classesOf(node).includes(className),
    )
    if (!sourceNodes.length) {
      warnings.push(`原型缺少受控容器 ${className}，未生成预览链接`)
      continue
    }
    const first = sourceNodes[0]
    const templateText = nodeText(template)
    const sourceCountText = nodeText(first)
    const firstIndex = main.children.indexOf(first)

    const clones = entries.map((entry, i) => {
      const clone = structuredClone(template)
      // 腰封 count 提示（home-waist-banner__count）：受控槽位文本按克隆序号更新。
      if (className === 'home-waist-banner' && templateText && sourceCountText) {
        const countSpan = collectTags([clone], 'span').find((n) => classesOf(n).includes('home-waist-banner__count'))
        if (countSpan) {
          const textIndex = countSpan.children.findIndex((c) => c.kind === 'text')
          if (textIndex !== -1) countSpan.children[textIndex] = { kind: 'text', text: `${i + 1} / ${entries.length}` }
        }
      }
      const img = collectTags([clone], 'img')[0]
      // 每个克隆严格使用配置中自己的交付路径，禁止复用第一张素材。
      if (img) {
        const src = img.attrs.find((a) => a.name === 'src')
        if (src) src.value = entry.item.image
      }
      // 多条内容共享一个版位：初始仅首条参与布局，主轮播脚本每 3 秒切换。
      if (i > 0) clone.attrs.push({ name: 'hidden', value: '' })
      // ref 有效才包 <a>；失败主题保留纯视觉容器。
      return entry.ref ? wrapWithAnchor(clone, entry.ref) : clone
    })
    // 替换首个源节点为克隆序列；其余源节点（如多余的 banner/waist 重复）删除——
    // 与 catalog 允许的"删除完整子树"一致，保证容器数 = config 条目数、不嵌套。
    main.children.splice(firstIndex, 1, ...clones)
    for (const extra of sourceNodes.slice(1)) {
      const idx = main.children.indexOf(extra)
      if (idx !== -1) main.children.splice(idx, 1)
    }
  }
  // 确定性序列化后回写原型（同一解析器原语，格式稳定）。
  fs.writeFileSync(prototypePath, root.map((node) => (node.kind === 'text' ? node.text : serialize(node))).join(''), 'utf8')
  return warnings
}

/**
 * 执行首页设计并输出交付包。
 *
 * brief.inputArtifacts 一律视为用户原始参考图（不信任 sourceSkill）：绝不形成
 * imageChanges，仅作为缺图请求的 referenceImages 候选。编排器二次回填的已验收
 * 素材必须经内部参数 completedAssets 显式传入（AssetResult 列表，AssetResult
 * Schema + assetRequestId 命中槽位 + 槽位比例验收 ≤3% 才回填）；该参数不进入
 * DesignBrief 公共 Schema，CLI 不暴露，避免开放公共 brief 伪造路径。
 *
 * @param {object} opts { brief, outputRoot, screenshot, completedAssets?, homeTheme?, landingThemes?, landingPreviewRefs? }
 * @returns {{ status, designPackage, pendingAssetRequests, warnings }}
 */
export async function designHome({
  brief,
  outputRoot,
  screenshot = false,
  completedAssets,
  failedAssets,
  homeTheme,
  landingThemes,
  landingPreviewRefs,
  researchPack,
  visionModelConfigured = false,
} = {}) {
  if (completedAssets !== undefined && !Array.isArray(completedAssets)) {
    const error = new Error('completedAssets 必须是数组（编排器二次回填的已验收 AssetResult 列表）')
    error.code = 'INVALID_COMPLETED_ASSETS'
    throw error
  }
  if (failedAssets !== undefined && !Array.isArray(failedAssets)) {
    const error = new Error('failedAssets 必须是数组（编排器二次回填的失败素材请求 ID 列表）')
    error.code = 'INVALID_FAILED_ASSETS'
    throw error
  }
  const rejection = detectConstraintViolation(brief)
  if (rejection) {
    return { status: 'rejected', designPackage: null, pendingAssetRequests: [], warnings: [], rejection }
  }
  // 先派生 alipay-home-config/v1 唯一配置合同：越界主题输入在产出任何文件前稳定失败。
  const linkageOptions = parseLinkageOptions({ homeTheme, landingThemes, landingPreviewRefs })
  const homeConfig = deriveHomeConfig(brief, linkageOptions)
  // 编排器对象形的显式 landingKey 不被位置重编号：派生后按主题名对齐写回并重校验。
  applyExplicitKeys(homeConfig, collectExplicitKeys(landingThemes))
  const plan = planHome(brief, { completedAssets, failedAssets, homeConfig, researchPack })
  const pendingAssetRequests = normalizePendingAssetRequests(plan.assetRequests)

  const catalog = loadHomeCatalog()
  fs.mkdirSync(outputRoot, { recursive: true })
  // 记录输入 brief 快照，供 DesignPackage 与审计。
  fs.writeFileSync(path.join(outputRoot, 'design-brief.json'), JSON.stringify(brief, null, 2) + '\n')
  // 配置是四项产物的唯一事实源，先于原型落盘（同源派生起点）。
  fs.writeFileSync(path.join(outputRoot, 'home-config.json'), JSON.stringify(homeConfig, null, 2) + '\n')
  fs.writeFileSync(path.join(outputRoot, 'configuration-guide.md'), renderConfigurationGuide(brief, homeConfig, plan.warnings))
  fs.writeFileSync(
    path.join(outputRoot, 'asset-manifest.json'),
    JSON.stringify({ pendingAssetRequests }, null, 2) + '\n',
  )

  const assembleResult = assemblePage({
    pageType: 'home',
    outputRoot,
    changes: {
      // 配置驱动受控组装：搜索占位文案来自同一份 home-config.json，
      // 金刚区槽位数取自 quickEntries.entries；素材仍走 planHome 槽位链路。
      texts: [{ className: 'home-search__placeholder', value: homeConfig.searchBar.placeholderText, index: 0 }],
      homeNav: { count: homeConfig.quickEntries.entries.length },
      homeCarousel: homeConfig.carousel.length > 1,
      themeTokens: { pageType: 'home', config: homeConfig },
      images: [...plan.imageChanges, ...plan.previewImages],
    },
  })

  const previewWarnings = applyOfflinePreviewLinks({ outputRoot, homeConfig, catalog: loadHomeCatalog() })
  replaceFailedAssetImages(outputRoot, plan.failedUsageSlots)
  const visualReviewWarnings = writeVisualReview({
    outputRoot,
    slots: enumerateHomeConfigImageSlots(homeConfig),
    acceptedUsageSlots: new Set(plan.imageChanges.map((image) => image.usageSlot)),
    failedUsageSlots: plan.failedUsageSlots,
    visionModelConfigured,
  })
  // 预览不可用等后处理警告补写进配置指南（先按 plan.warnings 生成、后合并重写），
  // 保证运营侧同样知晓关联落地页失败主题的预览不可用。
  if (previewWarnings.length) {
    fs.writeFileSync(path.join(outputRoot, 'configuration-guide.md'), renderConfigurationGuide(brief, homeConfig, [...plan.warnings, ...previewWarnings, ...visualReviewWarnings]))
  }

  const validation = validateOutput({ outputRoot })
  if (!validation.passed) {
    const error = new Error(`首页交付校验失败：${validation.errors.join('；')}`)
    error.code = 'VALIDATION_FAILED'
    error.details = validation.errors
    throw error
  }

  let designPackage = buildDesignPackage({
    outputRoot,
    designBriefId: brief.id,
    sourceCommit: assembleResult.catalog.sourceCommit,
    skillDependencies: [
      { id: 'skill-alipay-pages', version: '0.1.0' },
      { id: 'skill-alipay-home', version: manifest.version },
    ],
  })

  if (screenshot) {
    const { screenshotPage } = await import('../../skill-alipay-pages/scripts/screenshot.mjs')
    const prototypePath = path.join(outputRoot, 'prototype.html')
    const pngPath = path.join(outputRoot, 'prototype.png')
    await screenshotPage({ prototypePath, outputPath: pngPath, viewportHeight: 812 })
    // 截图后重新打包以纳入 prototype.png
    designPackage = buildDesignPackage({
      outputRoot,
      designBriefId: brief.id,
      sourceCommit: assembleResult.catalog.sourceCommit,
      skillDependencies: [
        { id: 'skill-alipay-pages', version: '0.1.0' },
        { id: 'skill-alipay-home', version: manifest.version },
      ],
    })
  }

  return {
    status: pendingAssetRequests.length || plan.failedUsageSlots.size ? 'completed_with_pending_assets' : 'succeeded',
    designPackage,
    pendingAssetRequests: plan.assetRequests,
    warnings: [...plan.warnings, ...previewWarnings, ...visualReviewWarnings],
  }
}

async function main(argv) {
  const cmd = argv[0]
  if (cmd === 'capabilities') {
    printCapabilities()
    return
  }
  if (cmd === 'request') {
    await runRequest(argv.slice(1))
    return
  }
  fail('USAGE', `未知命令: ${cmd || '(空)'}`, ['支持: capabilities | request'])
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main(process.argv.slice(2)).catch((e) => {
    fail(e.code || 'INTERNAL', e.message || String(e))
  })
}

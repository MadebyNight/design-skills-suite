// 支付宝首页 Skill 规划层。
//
// 职责（受控工具链，不做自由视觉设计）：
//  1. 读取并只消费 home catalog；
//  2. 校验 DesignBrief（deliverableType 必须为 alipay.home）；
//  3. 基于 goal/contentRequirements 做最小自然中文文本替换；
//  4. brief.inputArtifacts 一律视为用户原始参考图（不信任 sourceSkill）：绝不形成
//     imageChanges，仅进入待补请求 referenceImages；编排器二次回填素材经内部参数
//     completedAssets 显式传入，仅当通过槽位验收（比例 ≤3%）时回填；
//     缺图槽位生成合法 AssetRequest（aspect-ratio 验收 + 3 生成 / 2 适配重试）；
//  5. 派生 alipay-home-config/v1 合法首页配置（deriveHomeConfig）：
//     固定六内容模块，素材槽位命名 home.<module>.<item>.<role>，
//     越界请求（jumpUrl、生产发布、商品生成、直播等）统一拒绝。
//
// 输出规划结果，交给 assemble/validate/package 复用现有受控脚本。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Registry, validate } from '../../design-skill-contracts/scripts/validate.mjs'
import { COMPONENT_LIB, CONTRACT_DIR, PACKAGE_ROOT as PAGES_ROOT } from '../../skill-alipay-pages/scripts/build-catalog.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const HOME_PACKAGE_ROOT = path.resolve(__dirname, '..')
export const HOME_CATALOG_PATH = path.join(PAGES_ROOT, 'catalog', 'home.catalog.json')
export const HOME_PAGE_SOURCE = path.join(COMPONENT_LIB, 'pages', 'home.html')

export const HOME_PAGE_TYPE = 'alipay.home'
export const HOME_CONFIG_SCHEMA_ID = 'http://schemas.design-agent.local/design-skill/v1/alipay-home-config.schema.json'
export const HOME_CONFIG_SCHEMA_VERSION = 'alipay-home-config/v1'
const HOME_SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40}$/

const SCHEMA_DIR = path.join(CONTRACT_DIR, 'schemas')
const DESIGN_BRIEF_ID = 'http://schemas.design-agent.local/design-skill/v1/design-brief.schema.json'

export class ProtocolError extends Error {
  constructor(code, message, details = []) {
    super(message)
    this.code = code
    this.details = details
  }
}

const CONSTRAINT_RULES = [
  { pattern: /(修改|调整|改).{0,8}(圆角|radius)|圆角.{0,8}(改为|调整为|变成)/i, reason: '现有组件圆角由组件库 CSS 固定，不能修改', alternative: '保留现有按钮样式，通过已有文案和图片槽强化活动信息' },
  { pattern: /(新增|增加|创建|加入).{0,8}(组件|倒计时|模块)/i, reason: '页面 Skill 只能使用 ComponentCatalog 已登记组件，不能新增组件', alternative: '使用现有 Banner、腰封或栏目标题表达倒计时/活动提醒' },
  { pattern: /(修改|调整|替换).{0,8}(token|tokens|设计变量)/i, reason: '设计 tokens 是只读硬约束', alternative: '在现有 variant、文案和素材槽范围内完成调整' },
  { pattern: /(新增|增加|创建).{0,8}(class|样式类)/i, reason: '不允许新增 class', alternative: '仅使用 Catalog 已登记 class 与 variant' },
  { pattern: /(引入|使用|加载).{0,8}(远程资源|外链资源|cdn)/i, reason: '交付包必须离线可用，不能引入远程资源', alternative: '复制已有本地素材或提供 AssetResult' },
  { pattern: /jumpUrl|jump_url|跳转链接|跳转地址/i, reason: '不生成、不确认或直写生产 jumpUrl，跳转最终由业务系统或运营确认', alternative: '如用户明确要求，可在配置中记录待确认 jumpIntent，跳转地址留待业务系统确认' },
  { pattern: /(发布|上线|保存草稿|提审|提交审核|刷新缓存|缓存刷新|真机|生效)/i, reason: '首页 Skill 不负责生产草稿、发布、缓存刷新或真机验收', alternative: '交付静态原型、home-config.json、素材包与配置建议，由业务系统执行生产发布' },
  { pattern: /(生成|创建|新建|添加|推荐|挑选|更换).{0,12}(商品|产品|货品|商品图|推荐位)|商品推荐.{0,8}(改为|换成|更新|增加|删除)|preserve-existing/i, reason: '商品推荐固定保留既有内容，不生成或改写商品、商品图、文案或排序', alternative: '实际商品内容继续通过既有商品接口维护' },
  { pattern: /直播|live|聚合页|活动栏目/i, reason: '直播、活动栏目、聚合页等非首页搭建器内容不属于本 Skill', alternative: '移交对应业务系统处理' },
]

export function detectConstraintViolation(brief) {
  const text = [brief?.goal, ...(brief?.contentRequirements || []), ...(brief?.visualConstraints || [])]
    .filter(value => typeof value === 'string')
    .join('\n')
  const violations = CONSTRAINT_RULES.filter(rule => rule.pattern.test(text))
  if (!violations.length) return null
  return {
    type: 'component-constraint',
    reasons: violations.map(item => item.reason),
    alternatives: [...new Set(violations.map(item => item.alternative))],
    sourceCommit: loadHomeCatalog().sourceCommit,
  }
}

/**
 * 可生成素材槽位的稳定映射（docs/superpowers/specs/2026-09-01 设计 §页面请求迁移）：
 *   槽位统一为 home.<module>.<item>.<role>，并采用能力基线尺寸：
 *   轮播 1404x600、金刚区 200x200、豆腐块 690x640 / 690x312、腰封 1440x328。
 * 搜索图标、固定 TabBar 与商品推荐不建素材请求（保持快照内容），不在映射内。
 * 键为源页面 assets/home/ 下的文件名，值定义该图槽的尺寸与 usageSlot。
 */
export const DEFAULT_IMAGE_SLOTS = {
  'banner-concert.png': { usage: 'home.carousel.01.image', width: 1404, height: 600 },
  'nav-action-camera.png': { usage: 'home.quickEntries.01.image', width: 200, height: 200 },
  'nav-photography.png': { usage: 'home.quickEntries.02.image', width: 200, height: 200 },
  'nav-concert.png': { usage: 'home.quickEntries.03.image', width: 200, height: 200 },
  'nav-ccd.png': { usage: 'home.quickEntries.04.image', width: 200, height: 200 },
  'nav-subsidy.png': { usage: 'home.quickEntries.05.image', width: 200, height: 200 },
  'tofu-travel.png': { usage: 'home.tofuBlocks.01.large', width: 690, height: 640 },
  'tofu-computer.png': { usage: 'home.tofuBlocks.02.image', width: 690, height: 312 },
  'tofu-camera.png': { usage: 'home.tofuBlocks.03.image', width: 690, height: 312 },
  'waist.png': { usage: 'home.waistBanners.01.image', width: 1440, height: 328 },
}

/** 固定快照集合：不建素材请求（保持快照内容），但允许验收素材按槽位回填。 */
export const FIXED_IMAGE_SLOTS = {
  'search.png': { usage: 'home.searchBar.01.icon' },
  'home_b.png': { usage: 'home.tabbar.01.icon' },
  'classify.png': { usage: 'home.searchBar.02.icon', fixed: true, tabbar: true },
  'mine.png': { usage: 'home.searchBar.03.icon', fixed: true, tabbar: true },
  'product-osmo.jpg': { usage: 'home.productRecommendation.01.snapshot' },
  'product-vivo.jpg': { usage: 'home.productRecommendation.02.snapshot' },
  'product-fuji.png': { usage: 'home.productRecommendation.03.snapshot' },
}

function fileExtension(file) {
  const e = path.extname(file).toLowerCase().replace('.', '')
  return e === 'jpg' || e === 'jpeg' ? 'jpg' : (e || 'png')
}

function fitFor(file) {
  if (/^(tofu|banner|waist)/.test(file)) return 'cover'
  return 'contain'
}

let _catalog = null

/** 读取并缓存 home catalog（只消费 home catalog，禁止跨页面）。 */
export function loadHomeCatalog() {
  if (_catalog) return _catalog
  const catalog = JSON.parse(fs.readFileSync(HOME_CATALOG_PATH, 'utf8'))
  if (catalog.pageType !== HOME_PAGE_TYPE) {
    throw new Error(`catalog 页面类型非 ${HOME_PAGE_TYPE}：${catalog.pageType}`)
  }
  if (!HOME_SOURCE_COMMIT_PATTERN.test(catalog.sourceCommit)) {
    throw new Error(`home catalog sourceCommit 非法：${catalog.sourceCommit}`)
  }
  _catalog = catalog
  return catalog
}

/**
 * 校验并规范化 DesignBrief。
 * @param {unknown} input 对象或 JSON 字符串
 * @returns {object} 规范化后的 DesignBrief
 * @throws {ProtocolError} 校验失败或 deliverableType 非 home
 */
export function normalizeDesignBrief(input) {
  let instance = input
  if (typeof instance === 'string') {
    try {
      instance = JSON.parse(instance)
    } catch (e) {
      throw new ProtocolError('INVALID_JSON', '输入不是合法 JSON', [`解析失败: ${e.message}`])
    }
  }
  if (instance === null || typeof instance !== 'object' || Array.isArray(instance)) {
    throw new ProtocolError('INVALID_BRIEF', '输入必须是 DesignBrief 对象')
  }
  const registry = Registry.fromDirectory(SCHEMA_DIR)
  const schema = registry.byId.get(DESIGN_BRIEF_ID)?.schema
  if (!schema) throw new ProtocolError('CONTRACT_MISSING', 'design-brief schema 未加载')
  const errors = validate(instance, schema, registry, schema.$id)
  if (errors.length) throw new ProtocolError('INVALID_BRIEF', 'DesignBrief 校验失败', errors)
  if (instance.deliverableType !== HOME_PAGE_TYPE) {
    throw new ProtocolError(
      'UNSUPPORTED_DELIVERABLE',
      `deliverableType 必须为 ${HOME_PAGE_TYPE}`,
      [`实际：${instance.deliverableType}`],
    )
  }
  return instance
}

/**
 * 从源页面 pages/home.html 枚举所有缺图槽位（img src）。
 * 返回 [{ file, href, usageSlot, targetWidth, targetHeight, format, fit, safeArea }]。
 * 搜索图标、固定 TabBar 与商品推荐属于固定快照集合：不生成 AssetRequest，
 * 除非用户素材通过其槽位验收（比例 ≤3%）。未知文件名跳过并计入 warnings。
 */
export function enumerateImageSlots() {
  const html = fs.readFileSync(HOME_PAGE_SOURCE, 'utf8')
  const slots = []
  const seen = new Set()
  const unknown = []
  for (const match of html.matchAll(/\bsrc="\.\.\/assets\/home\/([^"]+)"/g)) {
    const file = match[1]
    const defaultSlot = DEFAULT_IMAGE_SLOTS[file]
    const fixedSlot = FIXED_IMAGE_SLOTS[file]
    const slotDef = defaultSlot || fixedSlot
    if (!slotDef) {
      unknown.push(file)
      continue
    }
    if (seen.has(file)) continue // 同名素材只规划一次（组装按 src 全局替换）
    seen.add(file)
    slots.push({
      file,
      href: `../assets/home/${file}`,
      usageSlot: slotDef.usage,
      targetWidth: slotDef.width,
      targetHeight: slotDef.height,
      format: fileExtension(file),
      fit: fitFor(file),
      fixedSlot: !defaultSlot,
      safeArea: '重要内容居中，避免被裁切',
    })
  }
  slots.sort((a, b) => a.href.localeCompare(b.href))
  return { slots, unknown }
}

const DEFAULT_SEARCH_PLACEHOLDER = '搜索热门租赁好物'

/**
 * 搜索栏只使用简短的主题文案，避免把“突出优惠”等设计指令直接渲染到页面。
 * 主题含页面/设计指令或过长时回退到受控默认文案。
 */
function searchPlaceholderFor(theme) {
  const candidate = String(theme || '').trim().replace(/\s+/g, ' ')
  if (!candidate || candidate.length > 12 || /(设计|页面|首页|突出|优惠|文案|搜索|改|新增)/.test(candidate)) {
    return DEFAULT_SEARCH_PLACEHOLDER
  }
  return `搜索${candidate}`.slice(0, 20)
}

/** 由首页主题派生搜索栏三段配色，使用现有可编辑字段，不扩展配置合同。 */
function searchPaletteFor(theme) {
  const text = String(theme || '')
  if (/蓝.{0,3}金|金.{0,3}蓝/.test(text)) {
    return { top: '#EAF2FF', input: '#FFF8E1', button: '#175CD3' }
  }
  if (/紫|薰衣草/.test(text)) {
    return { top: '#F2ECFF', input: '#FFFFFF', button: '#6D28D9' }
  }
  if (/绿|森林|自然/.test(text)) {
    return { top: '#EAF7F0', input: '#FFFFFF', button: '#147A55' }
  }
  if (/金|秋|暖黄/.test(text)) {
    return { top: '#FFF4DA', input: '#FFFDF7', button: '#9A6700' }
  }
  if (/蓝|海洋|科技/.test(text)) {
    return { top: '#EAF3FF', input: '#FFFFFF', button: '#175CD3' }
  }
  if (/红|橙|暖色/.test(text)) {
    return { top: '#FFF0E8', input: '#FFFFFF', button: '#C2410C' }
  }
  return { top: '#FFFFFF', input: '#F5F5F5', button: '#1677FF' }
}

/**
 * 构造合法 AssetRequest（schema 字段见 asset-requester.mjs）。
 * 生产素材请求统一采用比例验收（误差 ≤3%）与 3 生成 / 2 适配重试策略。
 */
function buildAssetRequestFromSlot(slot, brief, researchPack) {
  const researchSignals = Array.isArray(researchPack?.signals)
    ? researchPack.signals.map((signal) => signal?.value).filter((value) => typeof value === 'string' && value.trim())
    : []
  const forbiddenContent = [...new Set([
    '完整首页或落地页', '手机模型或浏览器框', '应用界面、搜索栏或底部导航',
    '多个页面模块拼版', '素材说明板或设计稿展示板', '重复宫格', '画面外白边或尺寸标注',
    ...(Array.isArray(brief.forbiddenChanges) ? brief.forbiddenChanges.filter((x) => typeof x === 'string') : []),
    ...(slot.forbiddenContent || []),
  ])]
  return {
    id: slot.usageSlot,
    usageSlot: slot.usageSlot,
    theme: `${brief.goal || '首页素材'}；${slot.promptPurpose || slot.usageSlot}；仅生成当前单一平面素材，不生成整页或应用界面${researchSignals.length ? `；研究建议：${researchSignals.join('；')}` : ''}`,
    targetWidth: slot.targetWidth,
    targetHeight: slot.targetHeight,
    aspectRatio: `${slot.targetWidth}:${slot.targetHeight}`,
    format: slot.format,
    fit: slot.fit,
    safeArea: slot.safeArea,
    referenceImages: [],
    forbiddenContent,
    allowGenerate: true,
    allowEdit: true,
    acceptance: { mode: 'aspect-ratio', maxAspectRatioError: 0.03 },
    retryPolicy: { generateMaxAttempts: 3, adaptMaxAttempts: 2 },
  }
}

// ---------------------------------------------------------------------------
// alipay-home-config/v1 配置派生
// ---------------------------------------------------------------------------

// 固定六内容模块（顺序不可新增、删除或重排），派生自 docs 基线第 1 节。
// category-tabs 与 tabbar 为固定展示骨架，不属于可配置内容模块。
export const HOME_MODULES = ['searchBar', 'carousel', 'quickEntries', 'tofuBlocks', 'waistBanners', 'productRecommendation']

/** 金刚区前 5 项样例名称与顺序（与 pages composition 采样一致，不可改写）。 */
const QUICK_ENTRY_SAMPLES = ['运动相机', '相机摄影', '演唱会神器', 'CCD专区', '超级补贴']

/** 未传入 landingThemes 时的默认落地页主题（docs 基线第 3 节）。 */
const DEFAULT_LANDING_THEMES = [
  { theme: '夏日出游租赁', source: 'default' },
  { theme: '演唱会租赁', source: 'default' },
]

/** 首页素材槽位的目标比例依据（docs 基线第 4 节）。 */
const HOME_ASSET_SPEC = {
  searchBar: { width: 24, height: 24, format: 'png', fit: 'contain' },
  carousel: { width: 1404, height: 600, format: 'png', fit: 'cover' },
  quickEntries: { width: 200, height: 200, format: 'png', fit: 'contain' },
  tofuBlocks: [
    { width: 690, height: 640, format: 'png', fit: 'cover' },
    { width: 690, height: 312, format: 'png', fit: 'cover' },
    { width: 690, height: 312, format: 'png', fit: 'cover' },
  ],
  waistBanners: { width: 1440, height: 328, format: 'png', fit: 'cover' },
}

function assetPath(module, item, role) {
  return `assets/home.${module}.${item}.${role}.png`
}

const HOME_SOURCE_ASSET_DIR = path.join(COMPONENT_LIB, 'assets', 'home')

/** 从最终首页配置枚举独立素材槽位；快照只提供 DOM marker 与 pending 预览图。 */
export function enumerateHomeConfigImageSlots(config) {
  const slots = []
  const push = ({ usageSlot, outputPath, currentSrc, sourceFile, targetWidth, targetHeight, fit, promptPurpose, safeArea, forbiddenContent = [], copyOnly = false }) => {
    slots.push({
      file: sourceFile,
      href: currentSrc,
      currentSrc,
      outputPath,
      defaultSourcePath: path.join(HOME_SOURCE_ASSET_DIR, sourceFile),
      usageSlot,
      targetWidth,
      targetHeight,
      format: 'png',
      fit,
      safeArea,
      promptPurpose,
      forbiddenContent,
      copyOnly,
    })
  }
  config.carousel.forEach((item, index) => push({
    usageSlot: `home.carousel.${String(index + 1).padStart(2, '0')}.image`,
    outputPath: item.image,
    currentSrc: '../assets/home/banner-concert.png',
    sourceFile: 'banner-concert.png',
    targetWidth: 1404, targetHeight: 600, fit: 'cover',
    promptPurpose: `首页第 ${index + 1} 张轮播横幅，主题“${item.contentTheme}”，单幅横向活动主视觉`,
    safeArea: '主体与短标题位于中央 80% 安全区，四周保留裁切余量',
    forbiddenContent: ['其他首页模块', '商品列表'],
    copyOnly: index > 0,
  }))
  const quickSources = ['nav-action-camera.png', 'nav-photography.png', 'nav-concert.png', 'nav-ccd.png', 'nav-subsidy.png']
  config.quickEntries.entries.forEach((item, index) => push({
    usageSlot: `home.quickEntries.${item.slot}.image`, outputPath: item.image,
    currentSrc: `../assets/home/${quickSources[index] || 'nav-subsidy.png'}`,
    sourceFile: quickSources[index] || 'nav-subsidy.png',
    targetWidth: 200, targetHeight: 200, fit: 'contain',
    promptPurpose: `首页金刚区“${item.name}”单一品类图标`,
    safeArea: '单一物体居中，轮廓完整，四周保留 12% 留白',
    forbiddenContent: ['文字', '文字卡片', '多个物品宫格'],
  }))
  const tofuDefs = [
    ['tofu-travel.png', 690, 640, '首页豆腐块左侧主入口，单块竖向运营视觉'],
    ['tofu-computer.png', 690, 312, '首页豆腐块右上入口，单块横向运营视觉'],
    ['tofu-camera.png', 690, 312, '首页豆腐块右下入口，单块横向运营视觉'],
  ]
  config.tofuBlocks.slots.forEach((item, index) => {
    const [sourceFile, targetWidth, targetHeight, promptPurpose] = tofuDefs[index]
    push({ usageSlot: `home.tofuBlocks.${item.slot}.${index === 0 ? 'large' : 'image'}`, outputPath: item.image,
      currentSrc: `../assets/home/${sourceFile}`, sourceFile, targetWidth, targetHeight, fit: 'cover',
      promptPurpose, safeArea: '一个主题入口的核心主体位于中央 75% 安全区', forbiddenContent: ['多个入口拼版'] })
  })
  config.waistBanners.forEach((item, index) => push({
    usageSlot: `home.waistBanners.${String(index + 1).padStart(2, '0')}.image`, outputPath: item.image,
    currentSrc: '../assets/home/waist.png', sourceFile: 'waist.png',
    targetWidth: 1440, targetHeight: 328, fit: 'cover',
    promptPurpose: `首页第 ${index + 1} 张腰封，主题“${item.contentTheme}”，单幅窄横向营销图`,
    safeArea: '核心主体和短标题位于中央 85% 安全区', forbiddenContent: ['三栏布局', '整页布局'],
    copyOnly: index > 0,
  }))
  return slots
}

/** 规范化 landingThemes：接受省略（取默认两主题）或字符串数组。 */
function normalizeLandingThemes(landingThemes) {
  if (landingThemes === undefined || landingThemes === null) {
    return DEFAULT_LANDING_THEMES.map((entry, i) => ({ landingKey: `landing-0${i + 1}`, ...entry }))
  }
  if (!Array.isArray(landingThemes)) {
    throw new ProtocolError('INVALID_LANDING_THEMES', 'landingThemes 必须是数组')
  }
  if (!landingThemes.length) {
    throw new ProtocolError('INVALID_LANDING_THEMES', 'landingThemes 不能为空数组', ['未传入时省略该字段以使用默认主题'])
  }
  const result = []
  for (const [i, raw] of landingThemes.entries()) {
    if (typeof raw !== 'string' || !raw.trim()) {
      throw new ProtocolError('INVALID_LANDING_THEMES', `landingThemes[${i}] 必须是非空字符串`)
    }
    result.push({
      landingKey: `landing-${String(i + 1).padStart(2, '0')}`,
      theme: raw.trim(),
      source: (i < DEFAULT_LANDING_THEMES.length ? 'orchestrator' : 'default'),
    })
  }
  return result
}

/** 规范化成功落地页集合：每项 {landingKey, theme, landingPreviewRef}。 */
function normalizeLandingPreviewRefs(landingPreviewRefs) {
  if (landingPreviewRefs === undefined || landingPreviewRefs === null) return []
  if (!Array.isArray(landingPreviewRefs)) {
    throw new ProtocolError('INVALID_LANDING_PREVIEW_REFS', 'landingPreviewRefs 必须是数组')
  }
  const result = []
  const seen = new Set()
  for (const [i, raw] of landingPreviewRefs.entries()) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ProtocolError('INVALID_LANDING_PREVIEW_REFS', `landingPreviewRefs[${i}] 必须是 {landingKey, landingPreviewRef} 对象`)
    }
    const { landingKey, landingPreviewRef } = raw
    if (typeof landingKey !== 'string' || !/^landing-[0-9]{2,}$/.test(landingKey)) {
      throw new ProtocolError('INVALID_LANDING_PREVIEW_REFS', `landingPreviewRefs[${i}].landingKey 非法，须为 landing-01 格式`, [`实际：${landingKey}`])
    }
    if (typeof landingPreviewRef !== 'string' || !landingPreviewRef) {
      throw new ProtocolError('INVALID_LANDING_PREVIEW_REFS', `landingPreviewRefs[${i}].landingPreviewRef 必须是非空字符串`)
    }
    if (/\\|\.\.(\/|\\|$)/.test(landingPreviewRef)) {
      throw new ProtocolError('INVALID_LANDING_PREVIEW_REFS', `landingPreviewRefs[${i}].landingPreviewRef 禁止反斜杠与 .. 路径段`, [`实际：${landingPreviewRef}`])
    }
    if (seen.has(landingKey)) throw new ProtocolError('INVALID_LANDING_PREVIEW_REFS', `landingPreviewRefs 重复 landingKey：${landingKey}`)
    seen.add(landingKey)
    result.push({ landingKey, landingPreviewRef })
  }
  return result
}

/**
 * 从 DesignBrief 与可选 { homeTheme, landingThemes, landingPreviewRefs }
 * 派生合法的 alipay-home-config/v1 首页配置。
 *
 * 固定边界（docs 基线）：
 *  - 固定六内容模块：searchBar / carousel / quickEntries / tofuBlocks / waistBanners / productRecommendation；
 *  - searchBar placeholderText ≤ 20 字，颜色 #RRGGBB，圆角 0–44 / 0–34 rpx；
 *  - quickEntries 至少 5 项（前 5 项样例名称与顺序锁定）；
 *  - 素材路径与槽位统一为 home.<module>.<item>.<role>；
 *  - productRecommendation 固定 preserve-existing；
 *  - landingThemes 缺省时取默认两主题；landingPreviewRefs 仅登记任务内成功落地页；
 *  - 每个 landingKey 至多登记一次，carousel 与 waistBanners 各取一次 ref。
 *
 * @param {object} brief 已校验的 DesignBrief
 * @param {object} [options] { homeTheme, landingThemes, landingPreviewRefs }
 * @returns {object} alipay-home-config/v1 合法配置
 * @throws {ProtocolError} 越界或非法输入
 */
export function deriveHomeConfig(brief, options = {}) {
  if (brief === null || typeof brief !== 'object' || Array.isArray(brief)) {
    throw new ProtocolError('INVALID_BRIEF', 'DesignBrief 必须是对象')
  }
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new ProtocolError('INVALID_OPTIONS', 'options 必须是对象')
  }
  const { homeTheme, landingThemes, landingPreviewRefs } = options

  // 宽泛首页主题：决定整页视觉风格，同时作为搜索占位文案默认来源。
  const theme = typeof homeTheme === 'string' && homeTheme.trim()
    ? homeTheme.trim()
    : String(brief.goal || '').trim().replace(/\s+/g, ' ')
  if (!theme) throw new ProtocolError('INVALID_BRIEF', '无法派生 homeTheme：brief.goal 为空')

  // 搜索占位文案只使用受控默认/主题文案，不复述 contentRequirements 中的设计指令。
  const placeholder = searchPlaceholderFor(theme)
  const searchPalette = searchPaletteFor(theme)

  const themes = normalizeLandingThemes(landingThemes)
  const previews = normalizeLandingPreviewRefs(landingPreviewRefs)
  const previewByLandingKey = new Map(previews.map((p) => [p.landingKey, p.landingPreviewRef]))

  // 轮播图：数量与主题分配由 Skill 决定；默认每个落地页主题一张轮播图。
  // 仅成功落地页携带 landingPreviewRef（carousel 与 waistBanners 各取一次）。
  const carousel = themes.map((entry) => {
    const item = {
      image: assetPath('carousel', entry.landingKey.replace(/^landing-/, ''), 'image'),
      contentTheme: entry.theme,
      landingKey: entry.landingKey,
    }
    if (previewByLandingKey.has(entry.landingKey)) {
      item.landingPreviewRef = previewByLandingKey.get(entry.landingKey)
    }
    return item
  })

  // 金刚区：至少 5 项（前 5 项名称与顺序锁定），素材槽位 home.quickEntries.<slot>.image。
  const quickEntries = {
    entries: QUICK_ENTRY_SAMPLES.map((name, i) => ({
      slot: `0${i + 1}`,
      name,
      image: assetPath('quickEntries', `0${i + 1}`, 'image'),
    })),
  }

  // 豆腐块：固定恰好 3 个槽位（左主图 + 右上 + 右下），只生成图片。
  // 槽位 01 为左主图（role=large，690x640），02/03 为右上、右下（role=image，690x312）。
  const tofuBlocks = {
    slots: HOME_ASSET_SPEC.tofuBlocks.map((size, i) => ({
      slot: `0${i + 1}`,
      image: assetPath('tofuBlocks', `0${i + 1}`, i === 0 ? 'large' : 'image'),
    })),
  }

  // 腰封：默认每个落地页主题一张，仅成功落地页携带 landingPreviewRef。
  const waistBanners = themes.map((entry, i) => {
    const item = {
      image: assetPath('waistBanners', `0${i + 1}`, 'image'),
      contentTheme: entry.theme,
      landingKey: entry.landingKey,
    }
    if (previewByLandingKey.has(entry.landingKey)) {
      item.landingPreviewRef = previewByLandingKey.get(entry.landingKey)
    }
    return item
  })

  const config = {
    schemaVersion: HOME_CONFIG_SCHEMA_VERSION,
    homeTheme: theme,
    landingThemes: themes.map(({ landingKey, theme: t, source }) => ({ landingKey, theme: t, source })),
    searchBar: {
      placeholderText: placeholder,
      topBarBackgroundColor: searchPalette.top,
      inputBackgroundColor: searchPalette.input,
      inputButtonBackgroundColor: searchPalette.button,
      topBarCornerRadiusRpx: 44,
      inputCornerRadiusRpx: 34,
    },
    carousel,
    quickEntries,
    tofuBlocks,
    waistBanners,
    productRecommendation: { mode: 'preserve-existing' },
  }

  // 交付前对结果按 contracts 的 alipay-home-config/v1 schema 严格自校验。
  const registry = Registry.fromDirectory(SCHEMA_DIR)
  const schema = registry.byId.get(HOME_CONFIG_SCHEMA_ID)?.schema
  if (!schema) throw new ProtocolError('CONTRACT_MISSING', 'alipay-home-config schema 未加载')
  const errors = validate(config, schema, registry, schema.$id)
  if (errors.length) throw new ProtocolError('INVALID_HOME_CONFIG', '派生的 home config 校验失败', errors)
  return config
}

/** 供派生层复用的受控槽位规格；不对外承诺超出 schema 的能力。 */
export const HOME_DERIVED_ASSET_SLOTS = Object.freeze({
  moduleItemRoles: Object.freeze({
    carousel: Object.freeze(['image']),
    quickEntries: Object.freeze(['image']),
    tofuBlocks: Object.freeze(['large', 'image']),
    waistBanners: Object.freeze(['image']),
  }),
  landingPreviewRefs: Object.freeze({ carousel: 1, waistBanners: 1 }),
})

/** 槽位验收允许的最大相对比例误差（3%，边界值 0.03 视为通过）。 */
const MAX_ASPECT_RATIO_ERROR = 0.03
// 比例浮点噪声容差：与 orchestrator shared acceptance（skill-orchestrator/runtime/
// asset-acceptance.mjs 的 ASPECT_RATIO_ERROR_EPSILON = 1e-9）语义一致。两包不能互相
// import（依赖方向：orchestrator → 页面包），故此处保留同值最小 epsilon 常量：
// 理论恰好 3% 的比例（如 206x200 vs 200x200、1030x1000 vs 1:1）在 IEEE754 下为
// 0.030000000000000027，无 epsilon 会被误拒；真实超差（≥0.03 + 噪声以上）仍拒绝。
const ASPECT_RATIO_ERROR_EPSILON = 1e-9

/** 素材实际比例相对槽位目标比例的相对误差 ≤ 3% 才可回填。 */
function slotAspectRatioError(slot, asset) {
  const targetRatio = slot.targetWidth / slot.targetHeight
  const actualRatio = asset.width / asset.height
  return targetRatio > 0 ? Math.abs((actualRatio / targetRatio) - 1) : Number.POSITIVE_INFINITY
}

/** 检查输入素材是否满足槽位比例验收；通过返回 null，否则返回原因。 */
function slotAcceptanceError(slot, asset) {
  const expectedMime = slot.format === 'jpg' ? 'image/jpeg' : `image/${slot.format}`
  if (asset.mimeType !== expectedMime) return `MIME 不符：期望 ${expectedMime}，实际 ${asset.mimeType || '未知'}`
  if (!Number.isInteger(asset.width) || !Number.isInteger(asset.height) || asset.width < 1 || asset.height < 1) {
    return '宽高缺失或非法'
  }
  const error = slotAspectRatioError(slot, asset)
  if (error > MAX_ASPECT_RATIO_ERROR + ASPECT_RATIO_ERROR_EPSILON) {
    return `比例超出 ${(MAX_ASPECT_RATIO_ERROR * 100).toFixed(0)}% 容差：目标 ${slot.targetWidth}x${slot.targetHeight}，实际 ${asset.width}x${asset.height}`
  }
  return null
}

/**
 * 规划整页设计变更与素材需求。
 *
 *   素材链路（docs/superpowers/specs/2026-09-01 设计）：
 *  - brief.inputArtifacts 一律视为用户原始参考图（不信任 sourceSkill）：绝不形成
 *    imageChanges，也不命中 reuse；仅作为缺图请求的 referenceImages 候选；
 *  - 编排器二次回填素材经内部参数 completedAssets 显式传入（AssetResult 列表）：
 *    仅当 usageSlot 匹配槽位且通过比例验收（≤3%）时才回填；未匹配/未通过验收的
 *    素材只作为 referenceImages 候选，绝不把素材原样写入最终页面；
 *  - 缺图槽位生成 AssetRequest（aspect-ratio 验收 + 3 生成 / 2 适配重试），
 *    搜索图标、固定 TabBar 与商品推荐固定快照不建请求；
 *  - imageChanges outputPath 统一为 assets/<usageSlot>.png，与 home-config
 *    的素材路径 assets/home.<module>.<item>.<role>.png 一致。
 *
 * @param {object} brief 已校验的 DesignBrief
 * @param {object} [options] { completedAssets?: Array<object> } 编排器二次回填素材
 * @returns {{
 *   catalog: object,
 *   texts: Array<{className,value,index}>,
 *   imageChanges: Array<{currentSrc,sourcePath,outputPath}>,
 *   assetRequests: Array<object>,
 *   warnings: Array<string>
 * }}
 */
export function planHome(brief, { completedAssets, failedAssets, homeConfig, researchPack } = {}) {
  const catalog = loadHomeCatalog()
  const warnings = []

  const inputArtifacts = Array.isArray(brief.inputArtifacts) ? brief.inputArtifacts : []
  const acceptedAssets = Array.isArray(completedAssets) ? completedAssets : []
  const resolvedConfig = homeConfig || deriveHomeConfig(brief)
  const texts = [{ className: 'home-search__placeholder', value: resolvedConfig.searchBar.placeholderText, index: 0 }]
  const slots = enumerateHomeConfigImageSlots(resolvedConfig)
  const knownUsageSlots = new Set(slots.map((slot) => slot.usageSlot))
  const failedUsageSlots = new Set((Array.isArray(failedAssets) ? failedAssets : [])
    .filter((id) => typeof id === 'string' && knownUsageSlots.has(id)))

  // 编排器已验收素材通过 assetRequestId 关联 AssetRequest.usageSlot。
  const byUsage = new Map()
  const artifactIds = new Set()
  for (const artifact of acceptedAssets) {
    if (!artifact?.assetRequestId) continue
    if (artifact.artifactId && artifactIds.has(artifact.artifactId)) {
      throw new ProtocolError('DUPLICATE_COMPLETED_ASSET', `同一 completedAssets.artifactId 不能回填多个槽位：${artifact.artifactId}`)
    }
    if (artifact.artifactId) artifactIds.add(artifact.artifactId)
    if (byUsage.has(artifact.assetRequestId)) {
      throw new ProtocolError('DUPLICATE_COMPLETED_ASSET', `同一素材请求返回多个结果：${artifact.assetRequestId}`)
    }
    byUsage.set(artifact.assetRequestId, artifact)
  }

  const imageChanges = []
  const previewImages = []
  const assetRequests = []
  const usedUsage = new Set()

  for (const slot of slots) {
    const artifact = byUsage.get(slot.usageSlot)
    if (artifact) {
      // 编排器二次回填素材保持槽位验收回填；brief.inputArtifacts 是用户参考图，
      // 永远不进这条路径（独立调用不传 completedAssets 即天然关闭直出）。
      const rejectionReason = slotAcceptanceError(slot, artifact)
      if (!rejectionReason) {
        usedUsage.add(slot.usageSlot)
        // 回填产物按槽位命名，与 home-config 的素材路径一致。
        imageChanges.push({ currentSrc: slot.currentSrc, sourcePath: artifact.path, outputPath: slot.outputPath, usageSlot: slot.usageSlot, copyOnly: slot.copyOnly })
        continue
      }
      warnings.push(`回填素材未通过槽位 ${slot.usageSlot} 验收，已跳过：${rejectionReason}`)
    }
    // 缺图 → 生成合法 AssetRequest；原型先复制当前槽位快照，状态保持 pending。
    previewImages.push({ currentSrc: slot.currentSrc, sourcePath: slot.defaultSourcePath, outputPath: slot.outputPath, usageSlot: slot.usageSlot, copyOnly: slot.copyOnly })
    if (failedUsageSlots.has(slot.usageSlot)) continue
    const request = buildAssetRequestFromSlot(slot, brief, researchPack)
    // 用户原始参考图（brief.inputArtifacts，无论 sourceSkill 如何标记）只作为
    // 参考图候选，绝不直接回填最终页面。
    const reference = inputArtifacts.find((a) => a.assetRequestId === slot.usageSlot)
    if (reference) {
      request.referenceImages = [reference]
    }
    assetRequests.push(request)
  }

  // 用户参考图中未匹配任何槽位的 usageSlot 记入 warning，但保留默认素材仍可完成基础包。
  const slotKeySet = new Set(slots.map((s) => s.usageSlot))
  for (const artifact of inputArtifacts) {
    const key = artifact.assetRequestId
    if (key && !usedUsage.has(key) && !slotKeySet.has(key)) {
      warnings.push(`用户参考图未匹配首页槽位：${key}`)
    }
  }

  return { catalog, texts, imageChanges, previewImages, assetRequests, failedUsageSlots, warnings }
}

// 支付宝落地页 Skill 规划层。
//
// 职责（受控工具链，不做自由视觉设计）：
//  1. 读取并只消费 landing catalog；
//  2. 校验 DesignBrief（deliverableType 必须为 alipay.landing）；
//  3. 基于 contentRequirements 做最小自然中文文本替换（仅前两个区块标题）；
//  4. 按 inputArtifacts 的 usageSlot 映射回填图片，
//     否则为缺图槽位生成合法 AssetRequest；
//  5. deriveLandingConfig：从 DesignBrief 与可选 { theme, landingKey } 派生
//     landing-schema/v1 合法落页配置——默认/覆盖主题、landingKey、七类
//     白名单模块、≤20 字标题、页面级配置、pendingResourceRequests、失败
//     素材诊断占位状态数据；拒绝 jumpUrl/pageCode 与白名单外越界请求。
//
// 输出规划结果，交给 assemble/validate/package 复用现有受控脚本。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Registry, validate } from '../../design-skill-contracts/scripts/validate.mjs'
import { COMPONENT_LIB, CONTRACT_DIR, PACKAGE_ROOT as PAGES_ROOT } from '../../skill-alipay-pages/scripts/build-catalog.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const LANDING_PACKAGE_ROOT = path.resolve(__dirname, '..')
export const LANDING_CATALOG_PATH = path.join(PAGES_ROOT, 'catalog', 'landing.catalog.json')
export const LANDING_PAGE_SOURCE = path.join(COMPONENT_LIB, 'pages', 'landing.html')

export const LANDING_PAGE_TYPE = 'alipay.landing'
const LANDING_SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40}$/

// landing-schema/v1 中间配置合同；主题默认值来自能力基线（docs/2026-08-28）。
const LANDING_CONFIG_ID = 'http://schemas.design-agent.local/design-skill/v1/landing-config.schema.json'
export const LANDING_SCHEMA_VERSION = 'landing-schema/v1'
export const DEFAULT_LANDING_THEMES = ['夏日出游租赁', '演唱会租赁']

const SCHEMA_DIR = path.join(CONTRACT_DIR, 'schemas')
const DESIGN_BRIEF_ID = 'http://schemas.design-agent.local/design-skill/v1/design-brief.schema.json'

export class ProtocolError extends Error {
  constructor(code, message, details = []) {
    super(message)
    this.code = code
    this.details = details
  }
}

/**
 * 缺尺寸槽的稳定默认映射（spec 约定）：
 *   hero 375x180；image-ad 375x120；product.1/.2/.3 184x152。
 * 键为源页面 assets/landing/ 下的文件名，值定义该图槽的尺寸与 usageSlot。
 */
export const DEFAULT_IMAGE_SLOTS = {
  'hero.png': { usage: 'landing.slot.hero', width: 375, height: 180 },
  'image-ad.png': { usage: 'landing.slot.image-ad', width: 375, height: 120 },
  'product-osmo.jpg': { usage: 'landing.slot.product.1', width: 184, height: 152 },
  'product-vivo.jpg': { usage: 'landing.slot.product.2', width: 184, height: 152 },
  'product-fuji.png': { usage: 'landing.slot.product.3', width: 184, height: 152 },
}

function fileExtension(file) {
  const e = path.extname(file).toLowerCase().replace('.', '')
  return e === 'jpg' || e === 'jpeg' ? 'jpg' : (e || 'png')
}

function fitFor(file) {
  if (/^product-/.test(file)) return 'contain'
  return 'cover'
}

let _catalog = null

/** 读取并缓存 landing catalog（只消费 landing catalog，禁止跨页面）。 */
export function loadLandingCatalog() {
  if (_catalog) return _catalog
  const catalog = JSON.parse(fs.readFileSync(LANDING_CATALOG_PATH, 'utf8'))
  if (catalog.pageType !== LANDING_PAGE_TYPE) {
    throw new Error(`catalog 页面类型非 ${LANDING_PAGE_TYPE}：${catalog.pageType}`)
  }
  if (!LANDING_SOURCE_COMMIT_PATTERN.test(catalog.sourceCommit)) {
    throw new Error(`landing catalog sourceCommit 非法：${catalog.sourceCommit}`)
  }
  _catalog = catalog
  return catalog
}

/**
 * 校验并规范化 DesignBrief。
 * @param {unknown} input 对象或 JSON 字符串
 * @returns {object} 规范化后的 DesignBrief
 * @throws {ProtocolError} 校验失败或 deliverableType 非 landing
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
  if (instance.deliverableType !== LANDING_PAGE_TYPE) {
    throw new ProtocolError(
      'UNSUPPORTED_DELIVERABLE',
      `deliverableType 必须为 ${LANDING_PAGE_TYPE}`,
      [`实际：${instance.deliverableType}`],
    )
  }
  return instance
}

/**
 * 从源页面 pages/landing.html 枚举所有缺图槽位（img src）。
 * 返回 [{ file, href, usageSlot, targetWidth, targetHeight, format, fit, safeArea }]。
 * 未知文件名的素材（不在稳定默认映射内）被跳过并计入 warnings。
 */
export function enumerateImageSlots() {
  const html = fs.readFileSync(LANDING_PAGE_SOURCE, 'utf8')
  const slots = []
  const seen = new Set()
  const unknown = []
  for (const match of html.matchAll(/\bsrc="\.\.\/assets\/landing\/([^"]+)"/g)) {
    const file = match[1]
    const defaultSlot = DEFAULT_IMAGE_SLOTS[file]
    if (!defaultSlot) {
      unknown.push(file)
      continue
    }
    if (seen.has(file)) continue // 同名素材只规划一次（组装按 src 全局替换）
    seen.add(file)
    slots.push({
      file,
      href: `../assets/landing/${file}`,
      usageSlot: defaultSlot.usage,
      targetWidth: defaultSlot.width,
      targetHeight: defaultSlot.height,
      format: fileExtension(file),
      fit: fitFor(file),
      safeArea: '重要内容居中，避免被裁切',
    })
  }
  slots.sort((a, b) => a.href.localeCompare(b.href))
  return { slots, unknown }
}

/** 从 contentRequirements 前两条派生最小自然中文区块标题（截断 16 字）。 */
function planTexts(brief) {
  const texts = []
  const requirements = Array.isArray(brief.contentRequirements)
    ? brief.contentRequirements.filter((x) => typeof x === 'string' && x.trim())
    : []
  // 文本首版只替换前两个 lp-section-title，对应页面中前两个区块标题。
  const count = Math.min(requirements.length, 2)
  for (let i = 0; i < count; i++) {
    let value = requirements[i].trim().replace(/\s+/g, ' ')
    if (value.length > 16) value = value.slice(0, 16)
    if (value) texts.push({ className: 'lp-section-title', value, index: i })
  }
  return texts
}

/**
 * 构造合法 AssetRequest（schema 字段见 asset-requester.mjs）。
 */
function buildAssetRequestFromSlot(slot, brief) {
  const forbiddenContent = Array.isArray(brief.forbiddenChanges)
    ? brief.forbiddenChanges.filter((x) => typeof x === 'string')
    : []
  return {
    id: slot.usageSlot,
    usageSlot: slot.usageSlot,
    theme: brief.goal || '落地页素材',
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
  }
}

/**
 * 规划整页设计变更与素材需求。
 * @param {object} brief 已校验的 DesignBrief
 * @returns {{
 *   catalog: object,
 *   texts: Array<{className,value,index}>,
 *   imageChanges: Array<{currentSrc,sourcePath,outputPath}>,
 *   assetRequests: Array<object>,
 *   warnings: Array<string>
 * }}
 */
export function planLanding(brief) {
  const catalog = loadLandingCatalog()
  const warnings = []
  const texts = planTexts(brief)

  const inputArtifacts = Array.isArray(brief.inputArtifacts) ? brief.inputArtifacts : []
  const { slots, unknown } = enumerateImageSlots()
  if (unknown.length) warnings.push(`未识别素材已跳过：${unknown.join(', ')}`)

  // 公共 AssetResult 通过 assetRequestId 关联 AssetRequest.usageSlot。
  const byUsage = new Map()
  for (const artifact of inputArtifacts) {
    if (artifact.assetRequestId) byUsage.set(artifact.assetRequestId, artifact)
  }

  const imageChanges = []
  const assetRequests = []
  const usedUsage = new Set()

  for (const slot of slots) {
    const artifact = byUsage.get(slot.usageSlot)
    if (artifact) {
      usedUsage.add(slot.usageSlot)
      imageChanges.push({
        currentSrc: slot.href,
        sourcePath: artifact.path,
        outputPath: `assets/generated/${slot.file}`,
      })
      continue
    }
    // 缺图 → 生成合法 AssetRequest，保留默认素材完成基础包。
    assetRequests.push(buildAssetRequestFromSlot(slot, brief))
  }

  // 输入素材中未消费的 usageSlot 记入 warning，但保留默认素材仍可完成基础包。
  for (const artifact of inputArtifacts) {
    const key = artifact.assetRequestId
    if (key && !usedUsage.has(key)) {
      warnings.push(`输入素材未匹配落地页槽位：${key}`)
    }
  }

  return { catalog, texts, imageChanges, assetRequests, warnings }
}

// ---------------------------------------------------------------------------
// landing config 派生：DesignBrief + 可选 { theme, landingKey } → landing-schema/v1
// ---------------------------------------------------------------------------

const LANDING_KEY_PATTERN = /^landing-[0-9]{2,}$/
const SECTION_TITLE_MAX_LENGTH = 20 // 生产上限 20 字，取代旧 16 字截断
const MODULE_TYPE_LIMITS = {
  HERO_IMAGE: { max: 1 },
  COUPON_GROUP: { max: 6 },
}
const MODULE_ID_PATTERN = /^[A-Za-z0-9._-]+$/

/** 索材请求槽位命名（usageSlot/id）：landing.<key>.<slot>.image，key 非法时回退 default。 */
function slotKeyFor(landingKey) {
  const key = landingKey || 'default'
  return LANDING_KEY_PATTERN.test(key) || key === 'default' ? key : 'default'
}

function safeText(briefList, fallback) {
  const value = (Array.isArray(briefList) ? briefList : [])
    .find((x) => typeof x === 'string' && x.trim())
  const text = (value || fallback || '').trim().replace(/\s+/g, ' ')
  return text.slice(0, SECTION_TITLE_MAX_LENGTH)
}

function hexColor(value) {
  return /^#[0-9A-Fa-f]{6}$/.test(String(value || '')) ? value : '#1677FF'
}

/** 由页面主题派生受控模块配色，不扩展 Schema 或组件边界。 */
function paletteForTheme(theme) {
  const text = String(theme || '')
  if (/演唱会/.test(text)) {
    return {
      pageBackground: '#071C3A',
      sectionText: '#F6D98F', sectionBackground: '#071C3A',
      couponOverall: '#DCEAFF', couponAmount: '#175CD3', couponContent: '#F7FAFF',
      productBackground: '#EAF2FF',
    }
  }
  if (/开学|校园/.test(text)) {
    return {
      pageBackground: '#EEF5FF',
      sectionText: '#0B3D91', sectionBackground: '#FFF2C2',
      couponOverall: '#E7F0FF', couponAmount: '#C99518', couponContent: '#FFFDF5',
      productBackground: '#EEF5FF',
    }
  }
  if (/金秋|秋|金色/.test(text)) {
    return {
      pageBackground: '#FFF4D6',
      sectionText: '#6E4300', sectionBackground: '#FFE9A8',
      couponOverall: '#FFF1C7', couponAmount: '#B9740B', couponContent: '#FFFDF3',
      productBackground: '#FFF4D6',
    }
  }
  return {
    pageBackground: '#EEF7FF',
    sectionText: '#222222', sectionBackground: '#FFFFFF',
    couponOverall: '#FFFFFF', couponAmount: '#FF4D4F', couponContent: '#FFFFFF',
    productBackground: '#FFFFFF',
  }
}

/** 从 brief 判断白名单内模块偏好；白名单外条目丢弃并通过 warnings 提示。 */
function requestedBlocks(brief, warnings) {
  const patterns = [
    { type: 'HERO_IMAGE', re: /主图|hero|头图|banner/i },
    { type: 'SECTION_TITLE', re: /标题|title|文案区/i },
    { type: 'IMAGE_AD', re: /(?:图片)?广告|image.?ad|双图|banner图/i },
    { type: 'COUPON_GROUP', re: /优惠券|coupon|领券|券/i },
    { type: 'PRODUCT_COLLECTION', re: /商品|产品|product|集合/i },
    // “领取”常出现在优惠券文案中，不代表用户要求额外的 ACTION_BUTTON。
    { type: 'ACTION_BUTTON', re: /按钮|跳转|button|报名/i },
    { type: 'SPACER', re: /留白|间距|间隔|spacer/i },
  ]
  const text = [
    brief?.goal,
    ...(Array.isArray(brief?.contentRequirements) ? brief.contentRequirements : []),
    ...(Array.isArray(brief?.visualConstraints) ? brief.visualConstraints : []),
  ].filter((x) => typeof x === 'string').join('\n')
  const whitelist = new Set(['HERO_IMAGE', 'IMAGE_AD', 'SECTION_TITLE', 'COUPON_GROUP', 'PRODUCT_COLLECTION', 'ACTION_BUTTON', 'SPACER'])
  const requested = []
  for (const { type, re } of patterns) {
    if (re.test(text) && whitelist.has(type)) requested.push(type)
  }
  // 白名单外模块请求（视频/表单/倒计时/公告/锚点/悬浮等）显式拒绝并提示替代。
  const forbiddenModule = text.match(/(视频|表单|倒计时|公告|锚点|悬浮|video|form|countdown|anchor|sticky)/i)
  if (forbiddenModule) {
    warnings.push(`拒绝白名单外模块请求：${forbiddenModule[0]}；可用替代：${[...whitelist].join(', ')}`)
  }
  return requested
}

/** brief 是否明确双图广告诉求（goal/contentRequirements/visualConstraints 文本判断）。 */
function wantsDoubleImageAd(brief) {
  const text = [
    brief?.goal,
    ...(Array.isArray(brief?.contentRequirements) ? brief.contentRequirements : []),
    ...(Array.isArray(brief?.visualConstraints) ? brief.visualConstraints : []),
  ].filter((x) => typeof x === 'string').join('\n')
  return /双图|双banner|两(?:张|个|幅)(?:广告)?(?:大)?图/i.test(text)
}

function briefText(brief) {
  return [brief?.goal, ...(brief?.contentRequirements || []), ...(brief?.visualConstraints || [])]
    .filter(value => typeof value === 'string').join('\n')
}

/** 页面背景默认由 Agent 主动设计；只有明确要求纯色时才不创建背景图素材。 */
function pageBackgroundFor(intent, slotKey, palette) {
  if (/纯色(?:页面)?背景|页面(?:使用)?纯色背景|不(?:要|使用).{0,4}(?:背景图|图片背景)|禁用背景图/i.test(intent)) {
    return { type: 'color', color: palette.pageBackground }
  }
  return { type: 'image', image: `assets/${slotKey}.pageBackground.image.png` }
}

/**
 * 从 DesignBrief 派生 landing-schema/v1 合法落地页配置。
 * @param {object} brief 已校验的 DesignBrief（deliverableType 必须为 alipay.landing）
 * @param {object} [options]
 * @param {string} [options.theme] 用户显式主题，完全替换默认主题
 * @param {string} [options.landingKey] 任务内稳定标识 landing-01/landing-02…
   * @returns {{ config: object, pendingResourceRequests: Array, assetRequests: Array, diagnostics: Array, warnings: Array<string> }}
   *   assetRequests 为真实素材请求的状态数据：usageSlot 命名 landing.<landingKey>.<slot>.image，
   *   验收采用比例模式（误差 ≤3%）+ 生成 3 次/适配 2 次重试合同（页面能力基线）。
   *   IMAGE_AD 模式按 brief 派生：明确双图诉求（“双图”等）→ double 两图
   *   （单张 686×480）；默认单图 1404×480。
 * @throws {ProtocolError} landingKey 越界或含禁用生产字段
 */
export function deriveLandingConfig(brief, { theme, landingKey, ...unknownOptions } = {}) {
  if (brief === null || typeof brief !== 'object' || Array.isArray(brief)) {
    throw new ProtocolError('INVALID_BRIEF', 'DesignBrief 必须是对象')
  }
  if (brief.deliverableType !== LANDING_PAGE_TYPE) {
    throw new ProtocolError('UNSUPPORTED_DELIVERABLE', `deliverableType 必须为 ${LANDING_PAGE_TYPE}`, [`实际：${brief.deliverableType}`])
  }
  const unknownKeys = Object.keys(unknownOptions)
  if (unknownKeys.length) {
    throw new ProtocolError('INVALID_OPTIONS', `未知 options：${unknownKeys.join(', ')}`, ['仅支持 theme 与 landingKey'])
  }

  const warnings = []
  // 禁用生产字段：Skill 不伪造 pageCode / 生产跳转 / 自由路由。
  // 同时拦两类请求：字段式（{"jumpUrl": ...}）与文本式（文案里直接要求 jumpUrl/pageCode）。
  const forbiddenFieldProbe = JSON.stringify([
    brief?.forbiddenChanges,
    brief?.contentRequirements,
    brief?.visualConstraints,
    brief?.goal,
  ] || [])
  if (/"(?:jumpUrl|pageCode)"\s*:/.test(forbiddenFieldProbe) || /(?:jumpUrl|pageCode)/i.test(forbiddenFieldProbe)) {
    throw new ProtocolError('FORBIDDEN_FIELD', '禁止 jumpUrl/pageCode 等生产字段', ['跳转由业务系统确认，页面编码由服务端生成'])
  }

  // 主题：用户显式提供则完全替换；否则取默认主题表首位。
  const resolvedTheme = typeof theme === 'string' && theme.trim() ? theme.trim() : DEFAULT_LANDING_THEMES[0]
  if (theme !== undefined && (typeof theme !== 'string' || !theme.trim())) {
    throw new ProtocolError('INVALID_OPTIONS', 'theme 必须是非空字符串')
  }

  // landingKey：联合任务标识，仅接受 ^landing-[0-9]{2,}$；独立交付省略该字段。
  if (landingKey !== undefined) {
    if (typeof landingKey !== 'string' || !LANDING_KEY_PATTERN.test(landingKey)) {
      throw new ProtocolError('INVALID_LANDING_KEY', 'landingKey 必须匹配 ^landing-[0-9]{2,}$', [`实际：${JSON.stringify(landingKey)}`])
    }
  }
  const slotKey = slotKeyFor(landingKey)
  const intent = briefText(brief)
  const palette = paletteForTheme(resolvedTheme)

  // 页面级配置：name/navTitle 未提供时派生；背景由 Agent 默认主动设计，
  // 仅用户明确要求纯色时使用主题纯色；活动时间按基线留空。
  const pageName = safeText([resolvedTheme], '支付宝落地页活动').slice(0, 40)
  const navTitle = (resolvedTheme.length <= 15 ? resolvedTheme : resolvedTheme.slice(0, 15)) || '活动页'
  const page = {
    name: pageName,
    navTitle,
    background: pageBackgroundFor(intent, slotKey, palette),
    activityTime: { startTime: '', endTime: '' },
  }

  // 模块规划：七类白名单内按 brief 意图选择；仅主题时采用完整基线页面。
  const requested = requestedBlocks(brief, warnings)
  const moduleTypes = requested.length
    ? ['HERO_IMAGE', ...requested.filter((t) => t !== 'HERO_IMAGE')]
    : ['HERO_IMAGE', 'SPACER', 'COUPON_GROUP', 'SECTION_TITLE', 'IMAGE_AD', 'SECTION_TITLE', 'PRODUCT_COLLECTION', 'SPACER']
  // COUPON_GROUP/PRODUCT_COLLECTION 涉及真实资源：
  // 引用 ID 仅接受用户/上游显式提供的待确认值；未提供时复用参考样例固定展示
  // 引用（仅视觉设计，不指向真实资源），并通过 pendingResourceRequests 待补。
  const SAMPLE_COUPON_TEMPLATE_ID = 'cpt-1001'
  const SAMPLE_PRODUCT_ID = 'itm-2001'
  const coupon = (Array.isArray(brief?.inputArtifacts) ? brief.inputArtifacts : [])
    .find((a) => typeof a?.couponTemplateId === 'string' && a.couponTemplateId)
  const product = (Array.isArray(brief?.inputArtifacts) ? brief.inputArtifacts : [])
    .find((a) => typeof a?.productId === 'string' && a.productId)

  const modules = []
  /** 稳定模块 ID：type 小写驼峰 + 序号，如 heroImage-1。 */
  const idOf = (type, idx) => {
    const head = type.toLowerCase().replace(/_([a-z])/g, (_, c) => c.toUpperCase())
    return `${head}-${idx}`
  }
  const counters = {}
  const nextId = (type) => {
    counters[type] = (counters[type] || 0) + 1
    return idOf(type, counters[type])
  }
  const assertModuleId = (id) => {
    if (!MODULE_ID_PATTERN.test(id)) {
      throw new ProtocolError('INVALID_MODULE_ID', `模块 ID 非法：${id}`, [`允许字符：${MODULE_ID_PATTERN}`])
    }
    return id
  }

  const sections = [] // section title 依次消费 contentRequirements（≤20 字）
  for (const type of moduleTypes) {
    switch (type) {
      case 'HERO_IMAGE':
        // 单页最多 1 个；跳转不自动生成。
        modules.push({
          type,
          id: assertModuleId(nextId(type)),
          image: `assets/${slotKey}.hero.image.png`,
          cornerRadiusRpx: 16,
          marginTopRpx: 24,
          marginBottomRpx: 16,
        })
        break
      case 'IMAGE_AD':
        // 模块模式按 brief 诉求派生：明确双图诉求 → double（恰好 2 张，
        // 单张 686x480）；否则默认单图（恰好 1 张，1404x480）。
        modules.push(
          wantsDoubleImageAd(brief)
            ? {
                type,
                id: assertModuleId(nextId(type)),
                mode: { mode: 'double', count: 2 },
                images: [`assets/${slotKey}.imageAd.1.image.png`, `assets/${slotKey}.imageAd.2.image.png`],
                cornerRadiusRpx: 12,
              }
            : {
                type,
                id: assertModuleId(nextId(type)),
                mode: { mode: 'single', count: 1 },
                images: [`assets/${slotKey}.imageAd.1.image.png`],
                cornerRadiusRpx: 12,
              },
        )
        break
      case 'SECTION_TITLE': {
        const defaultSectionTitles = ['领券专区', '精选好物']
        const text = safeText([brief?.contentRequirements?.[sections.length]], '') || defaultSectionTitles[sections.length] || '活动精选'
        sections.push(text)
        const id = assertModuleId(nextId(type))
        modules.push({ type, id, mode: /图片标题/i.test(intent)
          ? { mode: 'image', image: `assets/${slotKey}.sectionTitle.${sections.length}.image.png`, displayWidthRpx: 360, align: 'center', marginTopRpx: 8, marginBottomRpx: 8 }
          : { mode: 'text', text, fontSizeRpx: 32, bold: true, textColor: palette.sectionText, backgroundColor: palette.sectionBackground, align: 'center', marginTopRpx: 8, marginBottomRpx: 8 } })
        break
      }
      case 'COUPON_GROUP': {
        const couponIndex = counters.COUPON_GROUP || 1
        const couponBackgroundImage = (name, pattern) => (
          pattern.test(intent)
            ? { mode: 'image', image: `assets/${slotKey}.couponGroup.${couponIndex}.${name}.image.png` }
            : null
        )
        modules.push({
          type,
          id: assertModuleId(nextId(type)),
          coupons: [{ couponTemplateId: coupon?.couponTemplateId || SAMPLE_COUPON_TEMPLATE_ID }],
          overallBackground: couponBackgroundImage('overallBackground', /优惠券(?:整体|区域)?背景图|券区.{0,8}背景图/i) || { mode: 'color', color: palette.couponOverall },
          amountAreaBackground: couponBackgroundImage('amountAreaBackground', /金额(?:区|区域)?背景图|券面金额背景图/i) || { mode: 'color', color: palette.couponAmount },
          contentAreaBackground: couponBackgroundImage('contentAreaBackground', /内容(?:区|区域)?背景图|文案(?:区|区域)?背景图/i) || { mode: 'color', color: palette.couponContent },
        })
        break
      }
      case 'PRODUCT_COLLECTION':
        modules.push({
          type,
          id: assertModuleId(nextId(type)),
          products: [{ productId: product?.productId || SAMPLE_PRODUCT_ID }],
          spacingRpx: 16,
          background: /商品.{0,8}背景图|商品集合.{0,8}背景图/i.test(intent)
            ? { mode: 'image', image: `assets/${slotKey}.productCollection.${(counters.PRODUCT_COLLECTION || 1)}.background.image.png` }
            : { mode: 'color', color: palette.productBackground },
        })
        break
      case 'ACTION_BUTTON': {
        const text = safeText([brief?.contentRequirements?.[sections.length]], '立即参与').slice(0, 8)
        modules.push({
          type,
          id: assertModuleId(nextId(type)),
          text: text.length >= 2 ? text : '立即参与',
          cornerRadiusRpx: 12,
          jumpIntent: { targetType: 'pending', params: {} },
        })
        break
      }
      case 'SPACER':
        modules.push({
          type,
          id: assertModuleId(nextId(type)),
          heightRpx: 24,
          background: { mode: 'transparent' },
        })
        break
      default:
        break
    }
  }

  // 单页模块数上限 80（含全部类型累计）。
  if (modules.length > 80) {
    throw new ProtocolError('MODULE_LIMIT_EXCEEDED', '落地页模块总数不能超过 80', [`实际：${modules.length}`])
  }
  for (const [type, { max }] of Object.entries(MODULE_TYPE_LIMITS)) {
    const count = modules.filter((m) => m.type === type).length
    if (count > max) {
      throw new ProtocolError('MODULE_LIMIT_EXCEEDED', `${type} 单页最多 ${max} 个`, [`实际：${count}`])
    }
  }

  // pendingResourceRequests：资源引用缺失或带占位时登记结构化待补请求。
  const pendingResourceRequests = []
  for (const module of modules) {
    if (module.type === 'COUPON_GROUP' && !coupon) {
      pendingResourceRequests.push({
        resourceType: 'coupon',
        criteria: `${resolvedTheme}活动优惠券，1–6 张；请补充营销中心模板引用 ID`,
        purpose: 'COUPON_GROUP 模块券面展示',
        moduleRef: module.id,
      })
    }
    if (module.type === 'PRODUCT_COLLECTION' && !product) {
      pendingResourceRequests.push({
        resourceType: 'product',
        criteria: `${resolvedTheme}相关在售商品，每模块 1–40 个；请补充商品中心资源引用 ID`,
        purpose: 'PRODUCT_COLLECTION 模块商品展示',
        moduleRef: module.id,
      })
    }
  }

  // 未回填素材保持 pending；只有执行重试耗尽后的 failed 才可显示失败占位。
  // 槽位尺寸按页面能力基线：hero 1500×720；IMAGE_AD 单图 1404×480、双图单张 686×480；
  // 不为商品图片创建素材请求（商品保持快照引用 ID，由业务系统维护）。
  const imageAssetRequests = []
  if (page.background.type === 'image') imageAssetRequests.push({ slot: 'pageBackground', targetWidth: 1500, targetHeight: 2400, moduleRef: 'page' })
  for (const module of modules) {
    if (module.type === 'HERO_IMAGE') {
      imageAssetRequests.push({ slot: 'hero', targetWidth: 1500, targetHeight: 720, moduleRef: module.id })
    }
    if (module.type === 'IMAGE_AD') {
      const width = module.mode.mode === 'single' ? 1404 : 686
      module.images.forEach((_, idx) => {
        imageAssetRequests.push({ slot: `imageAd.${idx + 1}`, targetWidth: width, targetHeight: 480, moduleRef: module.id })
      })
    }
    if (module.type === 'SECTION_TITLE' && module.mode.mode === 'image') {
      imageAssetRequests.push({ slot: `sectionTitle.${counters.SECTION_TITLE ? modules.filter(m => m.type === 'SECTION_TITLE').indexOf(module) + 1 : 1}`, targetWidth: 720, targetHeight: 120, moduleRef: module.id })
    }
    if (module.type === 'COUPON_GROUP') {
      for (const [name, background] of [['overallBackground', module.overallBackground], ['amountAreaBackground', module.amountAreaBackground], ['contentAreaBackground', module.contentAreaBackground]]) {
        if (background.mode === 'image') imageAssetRequests.push({ slot: `couponGroup.${modules.filter(m => m.type === 'COUPON_GROUP').indexOf(module) + 1}.${name}`, targetWidth: 1404, targetHeight: 480, moduleRef: module.id })
      }
    }
    if (module.type === 'PRODUCT_COLLECTION' && module.background.mode === 'image') {
      imageAssetRequests.push({ slot: `productCollection.${modules.filter(m => m.type === 'PRODUCT_COLLECTION').indexOf(module) + 1}.background`, targetWidth: 1404, targetHeight: 1200, moduleRef: module.id })
    }
  }
  const assetRequests = imageAssetRequests.map(({ slot, targetWidth, targetHeight, moduleRef }) => ({
    id: `landing.${slotKey}.${slot}.image`,
    usageSlot: `landing.${slotKey}.${slot}.image`,
    moduleRef,
    slot,
    status: 'pending',
    targetWidth,
    targetHeight,
    aspectRatio: `${targetWidth}:${targetHeight}`,
  }))

  const config = { schemaVersion: LANDING_SCHEMA_VERSION, page, modules }
  if (landingKey) config.landingKey = landingKey
  if (pendingResourceRequests.length) config.pendingResourceRequests = pendingResourceRequests

  // 派生结果必须整体满足 landing-config 严格 Schema（含 oneOf/步长/相对路径约束）。
  const registry = Registry.fromDirectory(SCHEMA_DIR)
  const schema = registry.byId.get(LANDING_CONFIG_ID)?.schema
  if (!schema) throw new ProtocolError('CONTRACT_MISSING', 'landing-config schema 未加载')
  const errors = validate(config, schema, registry, schema.$id)
  if (errors.length) throw new ProtocolError('INVALID_LANDING_CONFIG', '派生 landing config 校验失败', errors)

  return { config, pendingResourceRequests, assetRequests, warnings }
}

// 受控页面重组核心：在既有 ComponentCatalog 边界内支持
// 1) 首页金刚区 home-nav 的 5–25 个受控槽位（五列多行，前五项保留样例顺序）；
// 2) 落地页基于 Catalog 七类白名单组件的实例选择、增删与排序；
// 3) 首页 category-tabs 与 tabbar 保持不可配置的固定骨架。
//
// 约束：不改写组件快照、不引入自由 HTML/CSS/JS。所有 DOM 变换只能：
//  - 以 Catalog domTemplate 为单元实例化/克隆；
//  - 在受控槽位回填文本与图片 src；
//  - 通过删除 Catalog 允许的完整子树实现“删”；
//  - 通过移动 Catalog 允许的完整子树实现“排序”。
// class 只能来自 Catalog allowedClasses/allowedVariants，src 只能指向包内相对路径。
import path from 'node:path'
import { collectTags, classesOf, parseHtml, serialize } from '../build-catalog.mjs'

export const HOME_NAV_LIMITS = { min: 5, max: 25 }
export const LANDING_BLOCKS = ['lp-hero', 'lp-image-ad', 'lp-section-title', 'lp-coupons', 'lp-products', 'lp-action', 'lp-spacer']
// 固定展示骨架：不属于金刚区与落地页模块白名单，不参与受控重组。
export const HOME_FIXED_SKELETON = ['home-category-tabs', 'home-tabbar']

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
function assertPlainObject(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} 必须是对象`)
  }
}

/** 从受控原型 HTML 解析 DOM 树（与 build-catalog 相同解析器）。 */
function parsePage(html) {
  const root = parseHtml(html)
  const main = collectTags(root, 'main')[0]
  if (!main) throw new Error('页面缺少 main 容器')
  return { root, main }
}

function serializePage(root) {
  return root.map(node => (node.kind === 'text' ? node.text : serialize(node))).join('')
}

// ---------------------------------------------------------------------------
// home-nav 金刚区：5–25 项、五列多行
// ---------------------------------------------------------------------------

// 前 5 项样例（名称 + 顺序 + 图标）与源页面保持一致，不可改写。
const HOME_NAV_SAMPLE = [
  { label: '运动相机', icon: '../assets/home/nav-action-camera.png' },
  { label: '相机摄影', icon: '../assets/home/nav-photography.png' },
  { label: '演唱会神器', icon: '../assets/home/nav-concert.png' },
  { label: 'CCD专区', icon: '../assets/home/nav-ccd.png' },
  { label: '超级补贴', icon: '../assets/home/nav-subsidy.png' },
]
const HOME_NAV_SAMPLE_ICONS = HOME_NAV_SAMPLE.map(entry => entry.icon)

/**
 * 生成金刚区首页导航受控槽位描述。
 * @param {object} input
 * @param {number} [input.count=5] 5–25 且为 5 的倍数
 * @param {Array<{slot?:string, sourcePath?:string}>} [input.icons] 受控图片回填
 */
export function planHomeNav({ count = 5, icons = [] } = {}) {
  if (!Number.isInteger(count) || count < HOME_NAV_LIMITS.min || count > HOME_NAV_LIMITS.max) {
    throw new Error(`金刚区数量必须在 ${HOME_NAV_LIMITS.min}–${HOME_NAV_LIMITS.max} 之间`)
  }
  if (count % 5 !== 0) throw new Error('金刚区数量必须是 5 的倍数（五列多行）')
  if (!Array.isArray(icons)) throw new Error('icons 必须是数组')
  const entries = []
  for (let i = 0; i < count; i++) {
    const index = i + 1
    if (index <= 5) {
      // 前 5 项保留样例名称与顺序，不改写已有名称。
      entries.push({ index, label: HOME_NAV_SAMPLE[i].label, icon: HOME_NAV_SAMPLE[i].icon })
    } else {
      // 新增项只使用连续编号 06–25，不生成名称。
      entries.push({ index, label: String(index).padStart(2, '0'), icon: '../assets/home/nav-subsidy.png' })
    }
  }
  const seen = new Set()
  for (const change of icons) {
    assertPlainObject(change, 'icons 条目')
    const { slot, sourcePath } = change
    if (typeof slot !== 'string' || !HOME_NAV_SAMPLE_ICONS.includes(slot)) {
      throw new Error(`icons.slot 必须引用样例金刚区图标，如 ${HOME_NAV_SAMPLE_ICONS[0]}`)
    }
    if (seen.has(slot)) throw new Error(`icons.slot 重复：${slot}`)
    seen.add(slot)
    if (typeof sourcePath !== 'string' || sourcePath.length === 0) {
      throw new Error(`icons[${slot}] 缺少 sourcePath`)
    }
    const entry = entries.find(e => e.icon === slot)
    if (!entry) throw new Error(`icons.slot 未命中样例槽位：${slot}`)
    entry.iconInput = sourcePath
  }
  return { count, rows: count / 5, columns: 5, entries }
}

/**
 * 受控重建 home-nav：按 catalog domTemplate 生成 5–25 个 home-nav__item，
 * 覆盖源页面金刚区。返回 { html, imageMarkers, rows }；imageMarkers 描述
 * 需要回填的受控图片（仍走既有 images 校验链路）。
 */
export function applyHomeNav(html, { count, icons }) {
  const navPlan = planHomeNav({ count, icons })
  const { root, main } = parsePage(html)
  const nav = main.children.find(node => node.kind === 'tag' && classesOf(node).includes('home-nav'))
  if (!nav) throw new Error('源页面不存在金刚区 home-nav')
  const template = nav.children.find(node => node.kind === 'tag' && classesOf(node).includes('home-nav__item'))
  if (!template) throw new Error('金刚区缺少 home-nav__item 模板')

  // 计划受控图片替换：槽位合法性已由 planHomeNav（样例图标白名单）保证，
  // 回填复用 assemblePage 的 images 链路（currentSrc 指向重建后的样例图标原位）。
  const imageMarkers = []
  for (const entry of navPlan.entries) {
    if (!entry.iconInput) continue
    imageMarkers.push({ currentSrc: entry.icon, sourcePath: entry.iconInput })
  }

  const items = navPlan.entries.map((entry) => {
    const clone = structuredClone(template)
    const label = collectTags([clone], 'div').find(node => classesOf(node).includes('home-nav__label'))
    if (!label) throw new Error('金刚区模板缺少 home-nav__label')
    const textIndex = label.children.findIndex(node => node.kind === 'text')
    if (textIndex === -1) throw new Error('金刚区标签缺少文本节点')
    label.children[textIndex] = { kind: 'text', text: entry.label }
    const img = collectTags([clone], 'img')[0]
    if (!img) throw new Error('金刚区模板缺少图标')
    const src = img.attrs.find(a => a.name === 'src')
    if (!src) throw new Error('金刚区图标缺少 src')
    src.value = entry.icon
    return clone
  })
  nav.children = items

  // 收集多行场景需要的受控布局补丁（写成静态样式文件，非内联 style）。
  const rows = navPlan.rows
  return { html: serializePage(root), imageMarkers, rows }
}

/**
 * 生成多行金刚区受控布局样式（五列多行）。
 * 仅在 count > 5 时由 assemblePage 写入 styles/home-nav.grid.css 并在 prototype 引用；
 * 内容为固定受控补丁，不修改组件快照 CSS。
 */
export function homeNavGridCss() {
  return [
    '/* skill-alipay-pages 受控金刚区多行布局补丁（五列多行）；组件快照样式保持只读。 */',
    '.home-nav { flex-wrap: wrap; align-items: flex-start; }',
    '.home-nav__item { width: 20%; min-width: 0; }',
    '',
  ].join('\n')
}

/** 固定首页轮播脚本：仅切换现有 .home-banner 的 hidden 状态。 */
export function homeCarouselScript() {
  return [
    "const slides = [...document.querySelectorAll('.home-banner')]",
    "slides.forEach((slide, index) => { slide.hidden = index !== 0 })",
    "if (slides.length > 1) {",
    "  let current = 0",
    "  setInterval(() => {",
    "    slides[current].hidden = true",
    "    current = (current + 1) % slides.length",
    "    slides[current].hidden = false",
    "  }, 3000)",
    "}",
    "",
  ].join('\n')
}

const px = value => `${Number(value) / 2}px`
const cssBackground = background => {
  if (!background || background.mode === 'transparent' || background.mode === 'none') return 'transparent'
  if (background.type === 'color' || background.mode === 'color') return background.color
  return `url("../${background.image}") center / cover no-repeat`
}

/** 由已校验页面配置生成固定选择器主题样式。 */
export function pageThemeCss({ pageType, config }) {
  const lines = ['/* skill-alipay-pages 受控主题样式；由页面配置确定性生成。 */']
  if (pageType === 'home') {
    const search = config.searchBar
    lines.push(`.home-top { background: ${search.topBarBackgroundColor}; border-radius: 0 0 ${px(search.topBarCornerRadiusRpx)} ${px(search.topBarCornerRadiusRpx)}; }`)
    lines.push(`.home-search { background: ${search.inputBackgroundColor}; border-radius: ${px(search.inputCornerRadiusRpx)}; }`)
    lines.push(`.home-search__button { background: ${search.inputButtonBackgroundColor}; border-radius: ${px(search.inputCornerRadiusRpx)}; }`)
  } else if (pageType === 'landing') {
    lines.push(`main.lp-page { background: ${cssBackground(config.page.background)}; }`)
    config.modules.forEach((module, index) => {
      const selector = `.lp-page > :nth-child(${index + 1})`
      if (module.type === 'HERO_IMAGE') lines.push(`${selector} { margin-top: ${px(module.marginTopRpx)}; margin-bottom: ${px(module.marginBottomRpx)}; border-radius: ${px(module.cornerRadiusRpx)}; }`)
      if (module.type === 'IMAGE_AD') lines.push(`${selector} .lp-image-ad-item { border-radius: ${px(module.cornerRadiusRpx)}; }`)
      if (module.type === 'SECTION_TITLE' && module.mode.mode === 'text') lines.push(`${selector} { margin-top: ${px(module.mode.marginTopRpx || 0)}; margin-bottom: ${px(module.mode.marginBottomRpx || 0)}; color: ${module.mode.textColor}; background: ${module.mode.backgroundColor}; font-size: ${px(module.mode.fontSizeRpx)}; font-weight: ${module.mode.bold ? 700 : 400}; text-align: ${module.mode.align}; }`)
      if (module.type === 'COUPON_GROUP') {
        lines.push(`${selector} { background: ${cssBackground(module.overallBackground)}; }`)
        lines.push(`${selector} .lp-coupon-value { background: ${cssBackground(module.amountAreaBackground)}; }`)
        lines.push(`${selector} .lp-coupon-copy { background: ${cssBackground(module.contentAreaBackground)}; }`)
        if (module.amountAreaBackground?.mode === 'color') {
          lines.push(`${selector} .lp-coupon { border-color: ${module.amountAreaBackground.color}; }`)
          lines.push(`${selector} .lp-coupon-value { color: #FFFFFF; }`)
          lines.push(`${selector} .lp-coupon-action { background: ${module.amountAreaBackground.color}; }`)
          lines.push(`${selector} .lp-coupon-action.is-disabled { color: #8A8F96; background: #ECEEEF; }`)
        }
        lines.push(`${selector} .lp-coupon-title { font-size: 12px; }`)
        lines.push(`${selector} .lp-coupon-note, ${selector} .lp-coupon-action { font-size: 10px; }`)
      }
      if (module.type === 'PRODUCT_COLLECTION') {
        const gap = px(module.spacingRpx)
        const accent = config.modules.find(item => item.type === 'COUPON_GROUP')?.amountAreaBackground
        lines.push(`${selector} { gap: ${gap}; background: ${cssBackground(module.background)}; }`)
        lines.push(`${selector} .lp-product { width: calc((100% - ${gap}) / 2); margin-right: 0; margin-bottom: 0; }`)
        lines.push(`${selector} .lp-product-title { font-size: 14px; }`)
        lines.push(`${selector} .lp-product-shop, ${selector} .lp-product-price small { font-size: 10px; }`)
        if (accent?.mode === 'color') lines.push(`${selector} .lp-product-price { color: ${accent.color}; }`)
      }
      if (module.type === 'ACTION_BUTTON') lines.push(`${selector} .lp-action-button { border-radius: ${px(module.cornerRadiusRpx)}; }`)
      if (module.type === 'SPACER') lines.push(`${selector} { height: ${px(module.heightRpx)}; background: ${cssBackground(module.background)}; }`)
    })
  } else throw new Error(`不支持的主题页面类型：${pageType}`)
  return `${lines.join('\n')}\n`
}

// ---------------------------------------------------------------------------
// 落地页白名单模块：实例选择、增删、排序
// ---------------------------------------------------------------------------

function catalogBlocks(catalog) {
  const byId = new Map()
  for (const component of catalog.components) {
    if (!LANDING_BLOCKS.includes(component.id)) continue
    if (byId.has(component.id)) throw new Error(`Catalog 存在重复组件：${component.id}`)
    byId.set(component.id, component)
  }
  if (LANDING_BLOCKS.some(id => !byId.has(id))) {
    throw new Error('落地页 Catalog 缺少白名单组件，拒绝受控重组')
  }
  return byId
}

/**
 * 解析落地页受控模块布局。
 * @param {object} input
 * @param {Array<{ component:string, repeat?:number, texts?:Array, images?:Array, variants?:Array }>} input.blocks
 */
export function planLandingBlocks({ blocks }) {
  if (!Array.isArray(blocks) || blocks.length === 0) throw new Error('落地页 blocks 必须是非空数组（禁止空页面）')
  if (blocks.length > 80) throw new Error('落地页模块总数不能超过 80')
  const plan = []
  for (const block of blocks) {
    assertPlainObject(block, 'blocks 条目')
    const { component, repeat = 1, texts = [], images = [], variants = [], double = false, sectionTitleImage = false } = block
    if (typeof component !== 'string' || !LANDING_BLOCKS.includes(component)) {
      throw new Error(`落地页模块必须在组件白名单内：${LANDING_BLOCKS.join(', ')}`)
    }
    if (!Number.isInteger(repeat) || repeat < 1 || repeat > 80) throw new Error('repeat 必须是 1–80 的整数')
    if (!Array.isArray(texts) || !Array.isArray(images) || !Array.isArray(variants)) {
      throw new Error('texts/images/variants 必须是数组')
    }
    if (typeof double !== 'boolean' || (double && component !== 'lp-image-ad')) throw new Error('double 仅支持 lp-image-ad')
    if (typeof sectionTitleImage !== 'boolean' || (sectionTitleImage && component !== 'lp-section-title')) throw new Error('sectionTitleImage 仅支持 lp-section-title')
    plan.push({ component, repeat, texts, images, variants, double, sectionTitleImage })
  }
  const total = plan.reduce((sum, block) => sum + block.repeat, 0)
  if (total > 80) throw new Error('落地页模块总数不能超过 80')
  return plan
}

function replaceControlledText(node, change) {
  const { className, value, index = 0 } = change
  if (typeof value !== 'string') throw new Error('texts 条目缺少 value')
  if (className !== undefined && typeof className !== 'string') throw new Error('texts.className 必须是字符串')
  let hits = 0
  const visit = (current) => {
    if (current.kind !== 'tag') return false
    if ((className === undefined || classesOf(current).includes(className))) {
      if (hits++ === index) {
        const textIndex = current.children.findIndex(child => child.kind === 'text')
        if (textIndex === -1) throw new Error(`目标缺少文本节点：${className}`)
        current.children[textIndex] = { kind: 'text', text: value }
        return true
      }
    }
    for (const child of current.children) {
      if (visit(child)) return true
    }
    return false
  }
  if (!visit(node)) throw new Error(`文本目标不存在：${className ?? '(首个文本)'}`)
}

function replaceControlledImage(node, change) {
  const { currentSrc, sourcePath, outputPath } = change
  if (typeof currentSrc !== 'string' || !currentSrc.startsWith('../assets/')) {
    throw new Error('images.currentSrc 必须是源页面已有 ../assets/ 路径')
  }
  let hits = 0
  const visit = (current) => {
    if (current.kind === 'tag' && current.tag === 'img') {
      const src = current.attrs.find(a => a.name === 'src')
      if (src && src.value === currentSrc && hits++ === (change.index ?? 0)) {
        // 实际替换由 assemblePage 复制素材后完成，这里先登记再统一处理。
        return true
      }
    }
    for (const child of current.children) if (visit(child)) return true
    return false
  }
  if (!visit(node)) throw new Error(`图片槽位不存在：${currentSrc}`)
  return { currentSrc, sourcePath, outputPath }
}

function applyControlledVariants(node, change, allowedVariants) {
  const { className, add = [], remove = [], index = 0 } = change
  for (const variant of [...add, ...remove]) {
    if (!allowedVariants.has(variant)) throw new Error(`未登记 variant：${variant}`)
  }
  let hits = 0
  const visit = (current) => {
    if (current.kind === 'tag' && classesOf(current).includes(className)) {
      if (hits++ === index) {
        const classes = new Set(classesOf(current))
        for (const variant of add) classes.add(variant)
        for (const variant of remove) classes.delete(variant)
        const cls = current.attrs.find(a => a.name === 'class')
        cls.value = [...classes].join(' ')
        return true
      }
    }
    for (const child of current.children) if (visit(child)) return true
    return false
  }
  if (!visit(node)) throw new Error(`variant 目标不存在：${className}`)
}

/**
 * 受控实例化 Catalog 模块。所有 DOM 均来自 catalog domTemplate。
 * 文本/variant 的 index 相对当前重复实例序号递增，因此 repeat 产生的每个
 * 实例都能按调用方给出的受控槽位定位（同槽位跨实例按 index 累计）。
 */
function instantiateCatalogTemplate(component, block) {
  const doms = parseHtml(component.domTemplate).filter(node => node.kind === 'tag')
  if (doms.length === 0) throw new Error(`组件模板缺少 DOM：${component.id}`)
  const allowedVariants = new Set(component.allowedVariants)
  const instances = []
  for (let i = 0; i < block.repeat; i++) {
    const instance = structuredClone(doms[0])
    if (component.id === 'lp-image-ad' && block.double) {
      const item = instance.children.find(node => node.kind === 'tag' && classesOf(node).includes('lp-image-ad-item'))
      if (!item) throw new Error('双图广告模板缺少 lp-image-ad-item')
      instance.children.push(structuredClone(item))
      const classAttr = instance.attrs.find(attr => attr.name === 'class')
      classAttr.value = classAttr.value.split(/\s+/).filter(name => name !== 'is-single').concat('is-double').join(' ')
    }
    if (component.id === 'lp-section-title' && block.sectionTitleImage) {
      instance.children = [{ kind: 'tag', tag: 'img', attrs: [
        { name: 'class', value: 'lp-section-title-image' },
        { name: 'src', value: '../assets/landing/image-ad.png' },
        { name: 'alt', value: '' },
      ], children: [] }]
    }
    for (const change of block.texts) {
      replaceControlledText(instance, { ...change, index: (change.index ?? 0) + i })
    }
    const images = []
    for (const change of block.images) images.push(replaceControlledImage(instance, change))
    for (const change of block.variants) {
      applyControlledVariants(instance, { ...change, index: (change.index ?? 0) + i }, allowedVariants)
    }
    instances.push({ node: instance, images })
  }
  return instances
}

/**
 * 受控重建落地页模块序列：只从 Catalog 白名单组件实例化，替换源页面全部模块。
 * 返回 { html, imageChanges }；imageChanges 统一交给 assemblePage images 链路执行。
 */
export function applyLandingBlocks(html, { blocks }, catalog) {
  const plan = planLandingBlocks({ blocks })
  const byId = catalogBlocks(catalog)
  const { root, main } = parsePage(html)
  const imageChanges = []
  const children = []
  for (const block of plan) {
    const component = byId.get(block.component)
    for (const instance of instantiateCatalogTemplate(component, block)) {
      children.push(instance.node)
      imageChanges.push(...instance.images)
    }
  }
  main.children = children
  return { html: serializePage(root), imageChanges }
}

/**
 * 校验受控落地页模块清单（供 validate/派生层复用）：
 * 返回错误数组；空数组即通过。
 */
export function validateLandingBlocks(blocks) {
  try {
    planLandingBlocks({ blocks })
    return []
  } catch (error) {
    return [error.message]
  }
}

/** 校验首页金刚区受控输入。返回错误数组；空数组即通过。 */
export function validateHomeNav(homeNav) {
  try {
    planHomeNav(homeNav ?? {})
    return []
  } catch (error) {
    return [error.message]
  }
}

export { escapeHtml as __forTests }

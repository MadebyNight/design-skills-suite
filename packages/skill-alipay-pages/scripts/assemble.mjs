import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { COMPONENT_LIB, PACKAGE_ROOT } from './build-catalog.mjs'
import { applyHomeNav, applyLandingBlocks, homeCarouselScript, homeNavGridCss, pageThemeCss } from './catalog/composition.mjs'

const PAGE_CONFIG = {
  home: { source: 'pages/home.html', styles: ['tokens.css', 'base.css', 'home.css'] },
  landing: { source: 'pages/landing.html', styles: ['tokens.css', 'base.css', 'landing.css'] },
}

// 固定受控样式补丁文件名（内容来自 composition.homeNavGridCss，非组件快照 CSS）。
const HOME_NAV_GRID_STYLE = 'home-nav.grid.css'
const HOME_CAROUSEL_SCRIPT = 'home-carousel.js'
const PAGE_THEME_STYLE = 'theme.css'

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function replaceNth(source, regex, index, replacement) {
  let current = 0
  let found = false
  const output = source.replace(regex, (...args) => {
    if (current++ !== index) return args[0]
    found = true
    return replacement(...args)
  })
  if (!found) throw new Error(`未找到第 ${index + 1} 个目标`)
  return output
}

function replaceText(html, { className, value, index = 0 }) {
  const cls = escapeRegExp(className)
  const regex = new RegExp(`(<([a-zA-Z0-9-]+)[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>)([\\s\\S]*?)(<\\/\\2>)`, 'g')
  return replaceNth(html, regex, index, (_all, open, _tag, _old, close) => `${open}${escapeHtml(value)}${close}`)
}

function changeVariant(html, { className, add = [], remove = [], index = 0 }, allowedVariants) {
  for (const variant of [...add, ...remove]) {
    if (!allowedVariants.has(variant)) throw new Error(`未登记 variant：${variant}`)
  }
  const cls = escapeRegExp(className)
  const regex = new RegExp(`(<[a-zA-Z0-9-]+[^>]*class=")([^"]*\\b${cls}\\b[^"]*)("[^>]*>)`, 'g')
  return replaceNth(html, regex, index, (_all, start, value, end) => {
    const classes = new Set(value.split(/\s+/).filter(Boolean))
    for (const variant of add) classes.add(variant)
    for (const variant of remove) classes.delete(variant)
    return `${start}${[...classes].join(' ')}${end}`
  })
}

function copyFile(source, outputRoot, relative) {
  const target = path.join(outputRoot, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(source, target)
}

export function assemblePage({ pageType = 'home', outputRoot, changes = {} }) {
  const config = PAGE_CONFIG[pageType]
  if (!config) throw new Error(`不支持的页面类型：${pageType}`)
  if (!outputRoot) throw new Error('缺少 outputRoot')
  const catalog = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'catalog', `${pageType}.catalog.json`), 'utf8'))
  const allowedVariants = new Set(catalog.components.flatMap(component => component.allowedVariants))
  let html = fs.readFileSync(path.join(COMPONENT_LIB, config.source), 'utf8')

  // 受控重组输入：home-nav 金刚区（仅首页）、blocks 白名单模块序列（仅落地页）。
  const { homeNav, blocks, docTitle, homeCarousel = false, themeTokens, ...standardChanges } = changes
  if (homeNav !== undefined && pageType !== 'home') throw new Error('homeNav 仅支持首页')
  if (blocks !== undefined && pageType !== 'landing') throw new Error('blocks 仅支持落地页')
  if (homeCarousel && pageType !== 'home') throw new Error('homeCarousel 仅支持首页')
  if (typeof docTitle !== 'undefined' && (typeof docTitle !== 'string' || !docTitle.trim())) {
    throw new Error('docTitle 必须是非空字符串')
  }
  if (themeTokens !== undefined && (themeTokens?.pageType !== pageType || !themeTokens?.config)) throw new Error('themeTokens 必须包含匹配页面类型的已校验配置')

  for (const change of standardChanges.texts || []) html = replaceText(html, change)
  for (const change of standardChanges.variants || []) html = changeVariant(html, change, allowedVariants)

  let extraStyles = []
  if (homeNav !== undefined) {
    const result = applyHomeNav(html, homeNav)
    html = result.html
    extraStyles = result.rows > 1 ? [HOME_NAV_GRID_STYLE] : []
    if (result.imageMarkers.length) {
      for (const marker of result.imageMarkers) {
        if (!standardChanges.images) standardChanges.images = []
        standardChanges.images.push(marker)
      }
    }
  }
  if (blocks !== undefined) {
    const result = applyLandingBlocks(html, { blocks }, catalog)
    html = result.html
    if (result.imageChanges.length) {
      for (const change of result.imageChanges) {
        if (!standardChanges.images) standardChanges.images = []
        standardChanges.images.push(change)
      }
    }
  }

  for (const style of config.styles) copyFile(path.join(COMPONENT_LIB, 'styles', style), outputRoot, path.join('styles', style))
  const defaultAssets = [...html.matchAll(/(?:src|href)="\.\.\/assets\/([^"]+)"/g)].map(match => match[1])
  for (const relative of [...new Set(defaultAssets)].sort()) {
    copyFile(path.join(COMPONENT_LIB, 'assets', relative), outputRoot, path.join('assets', relative))
  }

  for (const change of standardChanges.images || []) {
    const outputPath = (change.outputPath || `assets/generated/${path.basename(change.sourcePath)}`).replace(/\\/g, '/')
    if (path.isAbsolute(outputPath) || outputPath.split('/').includes('..')) throw new Error('outputPath 必须位于交付目录内')
    copyFile(path.resolve(change.sourcePath), outputRoot, outputPath)
    if (change.copyOnly) continue
    if (!change.currentSrc?.startsWith('../assets/')) throw new Error('currentSrc 必须是源页面已有 ../assets/ 路径')
    const marker = `src="${change.currentSrc}"`
    if (!html.includes(marker)) throw new Error(`源页面不存在图片：${change.currentSrc}`)
    html = html.replace(marker, `src="${outputPath}"`)
  }

  html = html.replaceAll('../styles/', 'styles/').replaceAll('../assets/', 'assets/')
  if (docTitle !== undefined) {
    html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(docTitle)}</title>`)
  }
  if (extraStyles.includes(HOME_NAV_GRID_STYLE)) {
    if (!html.includes('</head>')) throw new Error('页面缺少 head，无法引用金刚区多行样式')
    html = html.replace('</head>', `  <link rel="stylesheet" href="styles/${HOME_NAV_GRID_STYLE}">\n</head>`)
  }
  if (themeTokens) html = html.replace('</head>', `  <link rel="stylesheet" href="styles/${PAGE_THEME_STYLE}">\n</head>`)
  if (homeCarousel) {
    if (!html.includes('</body>')) throw new Error('页面缺少 body，无法引用首页轮播脚本')
    html = html.replace('</body>', `  <script src="scripts/${HOME_CAROUSEL_SCRIPT}"></script>\n</body>`)
  }
  if (themeTokens) fs.writeFileSync(path.join(outputRoot, 'styles', PAGE_THEME_STYLE), pageThemeCss(themeTokens), 'utf8')
  fs.mkdirSync(outputRoot, { recursive: true })
  const prototypePath = path.join(outputRoot, 'prototype.html')
  fs.writeFileSync(prototypePath, html, 'utf8')
  for (const style of extraStyles) {
    if (style === HOME_NAV_GRID_STYLE) {
      fs.writeFileSync(path.join(outputRoot, 'styles', HOME_NAV_GRID_STYLE), homeNavGridCss(), 'utf8')
    }
  }
  if (homeCarousel) {
    fs.mkdirSync(path.join(outputRoot, 'scripts'), { recursive: true })
    fs.writeFileSync(path.join(outputRoot, 'scripts', HOME_CAROUSEL_SCRIPT), homeCarouselScript(), 'utf8')
  }
  const componentUsage = {
    pageType: catalog.pageType,
    sourceCommit: catalog.sourceCommit,
    components: catalog.components.map(component => component.id),
    changes,
  }
  fs.writeFileSync(path.join(outputRoot, 'component-usage.json'), JSON.stringify(componentUsage, null, 2) + '\n')
  return { prototypePath, catalog, componentUsage }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputRoot = process.argv[2]
  assemblePage({ outputRoot })
  console.log(path.resolve(outputRoot))
}

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { COMPONENT_LIB, PACKAGE_ROOT } from './build-catalog.mjs'
import { homeCarouselScript, homeNavGridCss, pageThemeCss } from './catalog/composition.mjs'

// 允许出现在 prototype 引用里的受控样式补丁（白名单，内容由此 package 生成）。
const CONTROLLED_STYLESHEETS = new Map([['home-nav.grid.css', homeNavGridCss]])
const CONTROLLED_SCRIPTS = new Map([['home-carousel.js', homeCarouselScript]])

function hash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function classNames(html) {
  return [...html.matchAll(/\bclass="([^"]*)"/g)].flatMap(match => match[1].split(/\s+/).filter(Boolean))
}

export function validateOutput({ outputRoot, pageType = 'home' }) {
  const prototype = path.join(outputRoot, 'prototype.html')
  const errors = []
  if (!fs.existsSync(prototype)) return { passed: false, errors: ['缺少 prototype.html'], assets: [] }
  const html = fs.readFileSync(prototype, 'utf8')
  const usagePath = path.join(outputRoot, 'component-usage.json')
  const usage = fs.existsSync(usagePath) ? JSON.parse(fs.readFileSync(usagePath, 'utf8')) : null
  const source = fs.readFileSync(path.join(COMPONENT_LIB, 'pages', `${pageType}.html`), 'utf8')
  const catalog = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'catalog', `${pageType}.catalog.json`), 'utf8'))
  const allowedClasses = new Set([...classNames(source), ...catalog.components.flatMap(component => component.allowedVariants), ...(pageType === 'landing' ? ['is-double', 'lp-section-title-image'] : [])])
  for (const name of classNames(html)) if (!allowedClasses.has(name)) errors.push(`未登记 class：${name}`)
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  for (const match of scripts) {
    const src = match[1].match(/\bsrc="([^"]+)"/)?.[1]
    const name = src?.replace(/^scripts\//, '')
    const isFixedHomeCarousel = pageType === 'home'
      && match[0] === '<script src="scripts/home-carousel.js"></script>'
      && src === 'scripts/home-carousel.js'
      && !match[2].trim()
    if (!isFixedHomeCarousel || !CONTROLLED_SCRIPTS.has(name)) {
      errors.push(`未登记 script：${src || 'inline'}`)
      continue
    }
    const file = path.join(outputRoot, src)
    if (!fs.existsSync(file)) errors.push(`资源不存在：${src}`)
    else if (fs.readFileSync(file, 'utf8') !== CONTROLLED_SCRIPTS.get(name)()) errors.push(`受控脚本内容被修改：${name}`)
  }
  if (pageType === 'home' && scripts.length > 1) errors.push('首页轮播脚本只能引用一次')
  if (pageType === 'home' && scripts.length === 1 && !/<script src="scripts\/home-carousel\.js"><\/script>\s*<\/body>/i.test(html)) {
    errors.push('首页轮播脚本必须位于 body 末尾')
  }
  if (/<style\b/i.test(html)) errors.push('禁止 style 标签')
  if (/\sstyle\s*=/i.test(html)) errors.push('禁止内联 style')

  const assets = []
  for (const match of html.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
    const ref = match[1]
    if (/^(?:https?:|\/\/|data:)/i.test(ref)) { errors.push(`禁止远程或内联资源：${ref}`); continue }
    if (ref.startsWith('#')) continue
    const absolute = path.resolve(outputRoot, ref)
    if (!absolute.startsWith(path.resolve(outputRoot) + path.sep)) errors.push(`资源越界：${ref}`)
    else if (!fs.existsSync(absolute)) errors.push(`资源不存在：${ref}`)
    else assets.push({ path: ref.replace(/\\/g, '/'), sha256: hash(absolute) })
  }

  const pageCss = pageType === 'home' ? 'home.css' : 'landing.css'
  for (const name of ['tokens.css', 'base.css', pageCss]) {
    const output = path.join(outputRoot, 'styles', name)
    if (!fs.existsSync(output)) errors.push(`缺少 CSS：${name}`)
    else if (hash(output) !== hash(path.join(COMPONENT_LIB, 'styles', name))) errors.push(`CSS 被修改：${name}`)
  }

  // 受控样式补丁：只接受白名单文件，且内容必须与受控生成结果一致。
  const referencedControlled = new Set([...html.matchAll(/<link rel="stylesheet" href="styles\/([^"]+)">/g)]
    .map(match => match[1])
    .filter(name => CONTROLLED_STYLESHEETS.has(name)))
  for (const name of referencedControlled) {
    const output = path.join(outputRoot, 'styles', name)
    if (!fs.existsSync(output)) { errors.push(`缺少受控样式：${name}`); continue }
    if (fs.readFileSync(output, 'utf8') !== CONTROLLED_STYLESHEETS.get(name)()) {
      errors.push(`受控样式内容被修改：${name}`)
    }
  }
  const themeReferences = [...html.matchAll(/<link rel="stylesheet" href="styles\/theme\.css">/g)]
  if (themeReferences.length > 0) {
    const output = path.join(outputRoot, 'styles', 'theme.css')
    const tokens = usage?.changes?.themeTokens
    if (themeReferences.length !== 1 || !tokens || !fs.existsSync(output)) errors.push('缺少受控主题样式或配置')
    else if (fs.readFileSync(output, 'utf8') !== pageThemeCss(tokens)) errors.push('受控主题样式内容被修改')
  }
  if (usage?.changes?.themeTokens && themeReferences.length !== 1) errors.push('受控主题样式必须引用一次')
  // 未在白名单或快照样式内的额外 stylesheet 引用视为越界。
  for (const match of html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)) {
    const ref = match[1]
    const name = ref.replace(/^styles\//, '')
    const snapshotNames = new Set(['styles/tokens.css', 'styles/base.css', pageType === 'home' ? 'styles/home.css' : 'styles/landing.css'])
    if (!snapshotNames.has(ref) && !CONTROLLED_STYLESHEETS.has(name) && name !== 'theme.css') {
      errors.push(`未登记样式引用：${ref}`)
    }
  }
  const report = { passed: errors.length === 0, errors, assets: assets.sort((a, b) => a.path.localeCompare(b.path)) }
  fs.writeFileSync(path.join(outputRoot, 'validation-report.json'), JSON.stringify(report, null, 2) + '\n')
  return report
}

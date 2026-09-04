// B1 最小 ComponentCatalog 生成器。
//
// 输入：支付宝组件库快照（只读）的 components/*.html、styles/*.css 与 sourceCommit。
// 输出：符合 design-skill-contracts/schemas/component-catalog.schema.json 的
//       catalog/home.catalog.json 与 catalog/landing.catalog.json。
//
// 约束：只用 Node 内建能力；不得安装依赖；不得修改组件库；重复运行 byte-identical。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const PACKAGE_ROOT = path.resolve(here, '..')
export const REPO_ROOT = path.resolve(here, '..', '..', '..')
export const CONTRACT_DIR = path.join(REPO_ROOT, 'packages', 'design-skill-contracts')
export const SCHEMA_FILE = path.join(CONTRACT_DIR, 'schemas', 'component-catalog.schema.json')
export const COMPONENT_LIB = process.env.ALIPAY_COMPONENT_LIB
  ? path.resolve(process.env.ALIPAY_COMPONENT_LIB)
  : path.join(REPO_ROOT, 'examples', 'alipay-components')

const PAGES = [
  { file: 'home',    pageType: 'alipay.home',    componentHtml: 'components/home.html',    css: 'styles/home.css' },
  { file: 'landing', pageType: 'alipay.landing', componentHtml: 'components/landing.html', css: 'styles/landing.css' },
]
const VARIANT_PREFIX = 'is-'

// ---------------------------------------------------------------------------
// Git 辅助
// ---------------------------------------------------------------------------
function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}
// 读取 sourceCommit：若组件库目录含 .git 则验证 clean 并取 HEAD；
// 否则回退到快照目录中的 SOURCE.json（记录原始仓库与 commit）。
function componentLibCommit() {
  const cwd = COMPONENT_LIB
  if (fs.existsSync(path.join(cwd, '.git'))) {
    const dirty = git(['status', '--porcelain'], cwd)
    if (dirty) throw new Error(`组件库 Git 不干净，拒绝生成：\n${dirty}`)
    return git(['rev-parse', 'HEAD'], cwd)
  }
  const sourceFile = path.join(cwd, 'SOURCE.json')
  if (!fs.existsSync(sourceFile)) {
    throw new Error(`组件库既非 git 仓库也没有 SOURCE.json 快照记录：${cwd}`)
  }
  const record = JSON.parse(fs.readFileSync(sourceFile, 'utf8'))
  if (!record.originalCommit) {
    throw new Error(`SOURCE.json 缺少 originalCommit：${sourceFile}`)
  }
  return record.originalCommit
}

// ---------------------------------------------------------------------------
// 最小 HTML 解析器（确定性，仅覆盖本项目组件 HTML 语法子集）
// ---------------------------------------------------------------------------
const VOID_TAGS = new Set(['img', 'br', 'hr', 'meta', 'link', 'input', 'wbr'])

function parseHtml(source) {
  const root = []
  const stack = [{ children: root }]
  let i = 0
  const len = source.length

  while (i < len) {
    if (source[i] !== '<') {
      const start = i
      while (i < len && source[i] !== '<') i++
      const text = source.slice(start, i)
      if (text.trim()) stack[stack.length - 1].children.push({ kind: 'text', text })
      continue
    }
    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i)
      i = end === -1 ? len : end + 3
      continue
    }
    if (source.startsWith('<!', i)) {
      const end = source.indexOf('>', i)
      i = end === -1 ? len : end + 1
      continue
    }
    const isClose = source[i + 1] === '/'
    const nameEnd = source.indexOf('>', i)
    if (nameEnd === -1) break
    const raw = source.slice(i + (isClose ? 2 : 1), nameEnd)
    i = nameEnd + 1
    const nameMatch = raw.match(/^[a-zA-Z0-9-]+/)
    if (!nameMatch) continue
    const tag = nameMatch[0].toLowerCase()

    if (isClose) {
      if (stack.length > 1) stack.pop()
      continue
    }
    const attrs = []
    const attrRe = /([a-zA-Z_:][a-zA-Z0-9_:.-]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
    let am
    while ((am = attrRe.exec(raw.slice(nameMatch[0].length)))) {
      attrs.push({ name: am[1].toLowerCase(), value: am[3] ?? am[4] ?? am[5] ?? '' })
    }
    const selfClose = /\/\s*>$/.test(raw)
    const node = { kind: 'tag', tag, attrs, children: [] }
    stack[stack.length - 1].children.push(node)
    if (selfClose || VOID_TAGS.has(tag)) continue
    stack.push(node)
  }
  return root
}

function attrOf(node, name) {
  const a = node.attrs.find((x) => x.name === name)
  return a ? a.value : ''
}
function classesOf(node) {
  return attrOf(node, 'class').split(/\s+/).filter(Boolean)
}
function serialize(node) {
  if (node.kind === 'text') return node.text
  const open = `<${node.tag}` + node.attrs.map((a) => ` ${a.name}="${escapeAttr(a.value)}"`).join('') + (VOID_TAGS.has(node.tag) ? '>' : '>')
  if (VOID_TAGS.has(node.tag)) return open
  return open + node.children.map(serialize).join('') + `</${node.tag}>`
}
function escapeAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
function collectTags(nodes, tag, out = []) {
  for (const n of nodes) {
    if (n.kind === 'tag') {
      if (n.tag === tag) out.push(n)
      collectTags(n.children, tag, out)
    }
  }
  return out
}
function collectClasses(nodes, out = []) {
  for (const n of nodes) {
    if (n.kind === 'tag') {
      out.push(...classesOf(n))
      collectClasses(n.children, out)
    }
  }
  return out
}

// 解析组件案例：返回 [{ id, label, canvas }]
// 递归收集任意层级下 class 含 component-case 的 <section>（组件挂载于 <main> 内）。
function parseSections(html) {
  const root = parseHtml(html)
  return collectTags(root, 'section').filter((n) => classesOf(n).includes('component-case'))
}

function extractCase(section) {
  const id = attrOf(section, 'id')
  let label = ''
  let canvas = null
  for (const child of section.children) {
    if (child.kind !== 'tag') continue
    if (child.tag === 'div' && classesOf(child).includes('component-case__label')) {
      label = child.children.filter((x) => x.kind === 'text').map((x) => x.text).join('').replace(/\s+/g, ' ').trim()
    } else if (child.tag === 'div' && classesOf(child).includes('component-case__canvas')) {
      canvas = child
    }
  }
  if (!canvas) throw new Error(`section #${id} 缺少 component-case__canvas`)
  return { id, label, canvas }
}

// ---------------------------------------------------------------------------
// CSS 解析
// ---------------------------------------------------------------------------
function parseCss(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules = []
  let i = 0
  while (true) {
    const brace = clean.indexOf('{', i)
    if (brace === -1) break
    const selector = clean.slice(i, brace).trim()
    const close = clean.indexOf('}', brace)
    if (close === -1) break
    const body = clean.slice(brace + 1, close)
    const decls = {}
    for (const decl of body.split(';')) {
      const idx = decl.indexOf(':')
      if (idx === -1) continue
      const k = decl.slice(0, idx).trim()
      const v = decl.slice(idx + 1).trim()
      if (k) decls[k] = v
    }
    rules.push({ selector, decls })
    i = close + 1
  }
  return rules
}
function pxOf(v) {
  if (v === undefined) return null
  const m = String(v).trim().match(/^([\d.]+)px$/i)
  if (!m) return null
  return Math.round(parseFloat(m[1]))
}

// selector 单段（无后代/伪类）是否匹配节点
function tokenMatches(token, node) {
  if (token.includes(':')) return false
  const m = token.match(/^([a-zA-Z][\w-]*)?((?:\.[\w-]+)+)?$/)
  if (!m) return false
  if (m[1] && m[1].toLowerCase() !== node.tag) return false
  if (m[2]) {
    const need = m[2].slice(1).split('.')
    const cls = classesOf(node)
    for (const n of need) if (!cls.includes(n)) return false
  }
  return true
}
function findParentNode(node, roots) {
  for (const r of roots) {
    if (r.kind !== 'tag') continue
    if (r.children.includes(node)) return r
    const hit = findParentNode(node, r.children)
    if (hit) return hit
  }
  return null
}
// 后代选择器（空格）匹配
function selectorMatches(selector, node, root) {
  const parts = selector.split(/\s+/).filter(Boolean)
  if (parts.length === 0) return false
  if (!tokenMatches(parts[parts.length - 1], node)) return false
  let remaining = parts.slice(0, -1)
  let anc = findParentNode(node, root)
  while (anc && remaining.length > 0) {
    if (tokenMatches(remaining[remaining.length - 1], anc)) remaining.pop()
    anc = findParentNode(anc, root)
  }
  return remaining.length === 0
}

// 计算 img 的宽/高/objectFit：先看命中 img 的规则，再看父容器固定高度
function resolveImg(node, root, rules) {
  const out = { width: null, height: null, objectFit: null }
  for (const rule of rules) {
    if (!selectorMatches(rule.selector, node, root)) continue
    const w = pxOf(rule.decls.width)
    const h = pxOf(rule.decls.height)
    if (w !== null) out.width = w
    if (h !== null) out.height = h
    if (rule.decls['object-fit']) out.objectFit = rule.decls['object-fit']
  }
  if (out.height === null) {
    const parent = findParentNode(node, root)
    if (parent) {
      for (const rule of rules) {
        if (selectorMatches(rule.selector, parent, root)) {
          const h = pxOf(rule.decls.height)
          if (h !== null) { out.height = h; break }
        }
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 生成
// ---------------------------------------------------------------------------
export function buildPage(page, lib, sourceCommit = componentLibCommit()) {
  const html = fs.readFileSync(path.join(lib, page.componentHtml), 'utf8')
  const css = fs.readFileSync(path.join(lib, page.css), 'utf8')
  const rules = parseCss(css)
  const root = parseHtml(html)

  const components = parseSections(html).map((section) => {
    const { id, label, canvas } = extractCase(section)
    const domTemplate = canvas.children.map(serialize).join('')

    const imgs = collectTags(canvas.children, 'img')
    const slots = imgs.map((img) => {
      const res = resolveImg(img, root, rules)
      const cls = classesOf(img)
      const slot = { type: 'image', name: cls[0] || 'image' }
      if (res.width !== null) slot.width = res.width
      if (res.height !== null) slot.height = res.height
      if (res.objectFit) slot.objectFit = res.objectFit
      return slot
    })
    const seen = {}
    for (const s of slots) {
      const n = (seen[s.name] = (seen[s.name] || 0) + 1)
      if (n > 1) s.name = `${s.name}-${n}`
    }
    slots.sort((a, b) => a.name.localeCompare(b.name))

    const variantClasses = []
    const allowedClasses = []
    const seenCls = new Set()
    for (const c of collectClasses(canvas.children)) {
      if (seenCls.has(c)) continue
      seenCls.add(c)
      if (c.startsWith(VARIANT_PREFIX)) variantClasses.push(c)
      else allowedClasses.push(c)
    }
    allowedClasses.sort()
    variantClasses.sort()

    return { id, name: label, domTemplate, allowedClasses, allowedVariants: variantClasses, slots }
  })
  components.sort((a, b) => a.id.localeCompare(b.id))

  return { sourceCommit, pageType: page.pageType, components }
}

export function writeCatalog() {
  if (!fs.existsSync(COMPONENT_LIB)) throw new Error(`组件库不存在：${COMPONENT_LIB}`)
  const sourceCommit = componentLibCommit()
  fs.mkdirSync(path.join(PACKAGE_ROOT, 'catalog'), { recursive: true })
  for (const page of PAGES) {
    const catalog = buildPage(page, COMPONENT_LIB, sourceCommit)
    const outPath = path.join(PACKAGE_ROOT, 'catalog', `${page.file}.catalog.json`)
    fs.writeFileSync(outPath, JSON.stringify(catalog, null, 2) + '\n', 'utf8')
    console.log(`生成 ${path.relative(PACKAGE_ROOT, outPath)} (${catalog.components.length} 组件)`)
  }
}

export { PAGES, parseCss, parseSections }
// 供同包受控组装器复用的解析器原语（只读解析，不修改组件快照）。
export { parseHtml, serialize, collectTags, classesOf }

// ---- CLI ----
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeCatalog()
}

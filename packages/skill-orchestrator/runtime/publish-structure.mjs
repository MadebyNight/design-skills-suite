// 批次交付发布层（docs/superpowers/specs/2026-09-02-batch-delivery-structure-design.md）。
//
// 职责：runBatch 终态自动把成功 item 的交付物发布为面向使用者的四层结构：
//   <batchRoot>/index.html          统一离线入口（列出所有成功页面）
//   <batchRoot>/assets/<itemId>/    该页面原型实际引用的最终素材
//   <batchRoot>/configs/<itemId>.config.json  配置发布副本
//   <batchRoot>/other/<itemId>/     原型 HTML、styles、配置指南、brief、manifest、
//                                   package、component usage、validation report 等
//
// 顶层合同：公开 batchRoot 顶层最终只允许 index.html / assets/ / configs/ / other/
// 四项；全部运行时状态（request/checkpoint/result/items/attempts）物理位于
// other/runtime/（由 batch-runner 写入），本层不再复制运行时文件。
//
// 边界：
//  - attempt/运行时目录保持原样（不删不改），本层只读取与复制；
//  - 不复制 generated-assets/ 与 openphoto-data/（生成中间图与 daemon 工作目录）；
//  - 只发布终态 BatchResult 中 status=succeeded 的 item；可审阅失败落地页不发布、
//    不进入入口 index、首页引用一律删除（纯视觉），运行时证据保留在 other/runtime；
//  - 发布幂等：重建发布区时先清空再落盘，重复发布结果一致；
//  - assets/configs/other 总是创建（零成功批次同样存在，入口素材链接不缺目录）；
//  - 成功页即使无素材引用也创建 assets/<itemId>/ 目录（入口素材链接不缺目录）；
//  - 发布错误以 BatchRunnerError 明确抛出（BATCH_PUBLISH_*），不静默吞掉。
import fs from 'node:fs'
import path from 'node:path'
import { BatchRunnerError } from './batch-runner.mjs'
import { renderBatchDeliveryIndex } from './delivery-index.mjs'
import { derivePlanFromRequest } from './page-linkage.mjs'
import { runtimeRootFor } from './runtime-root.mjs'

/** attempt 内原型文件名（页面 Skill 交付物）。 */
const PROTOTYPE_FILE = 'prototype.html'
/** 发布区目录名。 */
const ASSETS_DIR = 'assets'
const CONFIGS_DIR = 'configs'
const OTHER_DIR = 'other'
const RUNTIME_DIR = 'runtime'

/** other/<itemId>/ 内原样复制的页面产物文件（不同页面产物集合不同，缺失跳过）。 */
const PAGE_FILES = [
  'prototype.png',
  'configuration-guide.md',
  'design-brief.json',
  'asset-manifest.json',
  'component-usage.json',
  'validation-report.json',
  'design-package.json',
]

/**
 * 收集原型 HTML 内本地引用（src/href 属性），返回 [{ ref, absolute }]。
 * 绝对路径（Windows 盘符 / POSIX 根）标记 absolute=true——发布层必须拒绝，
 * 在 scheme 判定之前识别，避免 `C:\…` 被当作 `C:` 协议跳过；
 * 远程/内联（http:、data: 等 scheme、//）与锚点（#）跳过。
 */
function prototypeLocalRefs(html) {
  const refs = []
  for (const match of html.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
    const ref = match[1]
    if (path.win32.isAbsolute(ref) || path.posix.isAbsolute(ref)) {
      refs.push({ ref, absolute: true })
      continue
    }
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref)) continue
    refs.push({ ref, absolute: false })
  }
  return refs
}

/** 收集样式表 url(...) 中的本地依赖，远程、内联与锚点引用不进入发布集合。 */
function stylesheetLocalRefs(css) {
  const refs = []
  for (const match of css.matchAll(/url\(\s*(?:(['"])(.*?)\1|([^)'"\s][^)]*?))\s*\)/gi)) {
    const ref = String(match[2] || match[3] || '').trim()
    if (!ref) continue
    if (path.win32.isAbsolute(ref) || path.posix.isAbsolute(ref)) {
      refs.push({ ref, absolute: true })
      continue
    }
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref)) continue
    refs.push({ ref, absolute: false })
  }
  return refs
}

/**
 * 发布单个成功页面：
 *  1. 复制原型到 other/<itemId>/prototype.html；
 *  2. 原型引用的本地依赖：styles/ 同目录复制；assets/（最终素材）复制到
 *     assets/<itemId>/ 并把原型引用改写为 ../../assets/<itemId>/...；
 *     无素材引用时也创建空 assets/<itemId>/ 目录（入口素材链接不缺目录）；
 *  3. 落地页预览目录（attempt 内 <landingKey>/，由联动发布层落盘）原样
 *     复制到 other/<itemId>/<landingKey>/（含其 styles/assets，链接离线可解析）；
 *  4. 其他页面产物文件原样复制到 other/<itemId>/。
 * landingRefRewrites：首页原型的 landingPreviewRef（attempt 内相对路径
 * <landingKey>/prototype.html）→ 发布层相对路径（../<landingItemId>/prototype.html），
 * 保证发布层内首页—落地页离线链接可点击。
 * unlinkableLandingRefs：首页原型内指向不可发布落地页（failed 等）的
 * <landingKey>/prototype.html 引用——发布 HTML 剥离 href（保留纯视觉容器），
 * 且不把该落地页的预览目录/ref 文件复制进交付区。
 * 路径安全：绝对路径或越出 attempt 的引用、缺失依赖按 BATCH_PUBLISH_INCOMPLETE /
 * BATCH_PUBLISH_INVALID 抛出（fail fast）。
 */
function publishPage({ batchRoot, itemId, attemptRoot, landingRefRewrites = new Map(), unlinkableLandingRefs = new Set() }) {
  const pageOther = path.join(batchRoot, OTHER_DIR, itemId)
  const pageAssets = path.join(batchRoot, ASSETS_DIR, itemId)
  const prototypeSource = path.join(attemptRoot, PROTOTYPE_FILE)
  if (!fs.existsSync(prototypeSource)) {
    throw new BatchRunnerError('BATCH_PUBLISH_INCOMPLETE', `item ${itemId} attempt 缺少 ${PROTOTYPE_FILE}，无法发布`)
  }
  const attemptDir = path.resolve(attemptRoot)
  const html = fs.readFileSync(prototypeSource, 'utf8')

  // 先完整校验引用，再统一落盘：失败时不产生半成品发布目录。
  /** files: [sourceAbsolute, targetRelativeWithinPageOther] */
  const files = [[prototypeSource, PROTOTYPE_FILE]]
  /** assets: [sourceAbsolute, fileNameWithinAssetsItemId] */
  const assets = []
  /** 引用改写表：原始 ref → 发布后 ref */
  const rewrites = new Map()
  /** 发布样式内容：CSS 素材引用改写为顶层 assets/<itemId>/。 */
  const stylesheetBodies = new Map()
  for (const { ref, absolute } of prototypeLocalRefs(html)) {
    if (absolute) {
      throw new BatchRunnerError('BATCH_PUBLISH_INVALID', `item ${itemId} 原型引用必须为相对路径：${ref}`)
    }
    // 不可发布落地页引用：不复制、不校验存在性，发布 HTML 中剥离 href（纯视觉）。
    if (unlinkableLandingRefs.has(ref)) {
      rewrites.set(ref, '')
      continue
    }
    const source = path.resolve(attemptDir, ref)
    if (!source.startsWith(attemptDir + path.sep)) {
      throw new BatchRunnerError('BATCH_PUBLISH_INVALID', `item ${itemId} 原型引用越界（必须位于 attempt 目录内）：${ref}`)
    }
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
      throw new BatchRunnerError('BATCH_PUBLISH_INCOMPLETE', `item ${itemId} 原型引用的本地依赖缺失，无法发布：${ref}`)
    }
    // 素材引用（assets/…）发布到 assets/<itemId>/ 并改写；styles/ 等同目录复制。
    if (ref === 'assets' || ref.startsWith('assets/')) {
      const fileName = ref.slice('assets/'.length)
      if (!fileName || fileName.endsWith('/')) {
        throw new BatchRunnerError('BATCH_PUBLISH_INVALID', `item ${itemId} 原型素材引用非法：${ref}`)
      }
      assets.push([source, fileName])
      rewrites.set(ref, `../../${ASSETS_DIR}/${itemId}/${fileName}`)
    } else if (landingRefRewrites.has(ref)) {
      // 首页 landingPreviewRef：发布层改写为指向 other/<landingItemId>/prototype.html。
      // 目标由调用方保证已发布（首页最后执行，联动 plan 已保证顺序）；此处不复制
      // 该 ref 指向的 attempt 内预览目录（依赖复制走下面的 previewDirs 整目录复制），
      // 只改写引用并保留原文件复制语义（landingKey 目录仍复制，供发布层内冗余预览）。
      rewrites.set(ref, landingRefRewrites.get(ref))
      files.push([source, ref])
    } else {
      files.push([source, ref])
    }
  }

  // HTML 只直接引用样式表；页面背景等素材只出现在 CSS url(...) 中。
  // 发布前读取已收集样式，校验其本地依赖，并把 attempt/assets 下的素材加入
  // 顶层素材包，同时将 CSS 引用改写为从发布样式文件可解析的相对路径。
  for (const [stylesheetSource, stylesheetRelative] of [...files]) {
    if (path.extname(stylesheetSource).toLowerCase() !== '.css') continue
    let css = fs.readFileSync(stylesheetSource, 'utf8')
    for (const { ref, absolute } of stylesheetLocalRefs(css)) {
      if (absolute) {
        throw new BatchRunnerError('BATCH_PUBLISH_INVALID', `item ${itemId} 样式引用必须为相对路径：${ref}`)
      }
      const source = path.resolve(path.dirname(stylesheetSource), ref)
      if (!source.startsWith(attemptDir + path.sep)) {
        throw new BatchRunnerError('BATCH_PUBLISH_INVALID', `item ${itemId} 样式引用越界（必须位于 attempt 目录内）：${ref}`)
      }
      if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
        throw new BatchRunnerError('BATCH_PUBLISH_INCOMPLETE', `item ${itemId} 样式引用的本地依赖缺失，无法发布：${ref}`)
      }

      const attemptAssets = path.join(attemptDir, ASSETS_DIR)
      const assetRelative = path.relative(attemptAssets, source)
      const isAttemptAsset = assetRelative
        && !assetRelative.startsWith(`..${path.sep}`)
        && assetRelative !== '..'
        && !path.isAbsolute(assetRelative)
      if (isAttemptAsset) {
        const fileName = assetRelative.split(path.sep).join('/')
        assets.push([source, fileName])
        const publishedStylesheet = path.join(pageOther, stylesheetRelative)
        const publishedAsset = path.join(pageAssets, fileName)
        const publishedRef = path.relative(path.dirname(publishedStylesheet), publishedAsset).split(path.sep).join('/')
        css = css.replaceAll(ref, publishedRef)
      } else {
        files.push([source, path.relative(attemptDir, source)])
      }
    }
    stylesheetBodies.set(stylesheetRelative, css)
  }

  // 落地页预览目录（联动批次首页 attempt 内 <landingKey>/ 完整离线预览目录）。
  // 原型引用 landing-XX/prototype.html 属于目录引用，不在 assets/ 前缀内，
  // 按目录整体复制到 other/<itemId>/<landingKey>/；不可发布落地页的预览目录
  // 不复制（可审阅失败页不进入交付区）。
  const unlinkableLandingKeyDirs = new Set([...unlinkableLandingRefs]
    .map((ref) => (/^(landing-\d{2,})\//.exec(ref)?.[1])).filter(Boolean))
  const previewDirs = []
  for (const entry of fs.existsSync(attemptDir) ? fs.readdirSync(attemptDir, { withFileTypes: true }) : []) {
    if (entry.isDirectory() && /^landing-\d{2,}$/.test(entry.name) && !unlinkableLandingKeyDirs.has(entry.name)) {
      previewDirs.push(path.join(attemptDir, entry.name))
    }
  }

  fs.mkdirSync(pageOther, { recursive: true })
  for (const [source, relative] of files) {
    const target = path.join(pageOther, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    if (stylesheetBodies.has(relative)) fs.writeFileSync(target, stylesheetBodies.get(relative), 'utf8')
    else fs.copyFileSync(source, target)
  }
  // 素材目录总是创建：无素材引用的成功页同样保证入口素材链接目录存在。
  fs.mkdirSync(pageAssets, { recursive: true })
  for (const [source, fileName] of assets) {
    fs.mkdirSync(path.dirname(path.join(pageAssets, fileName)), { recursive: true })
    fs.copyFileSync(source, path.join(pageAssets, fileName))
  }
  for (const dir of previewDirs) {
    copyDirectory(dir, path.join(pageOther, path.basename(dir)))
  }

  // 原型引用改写：素材 → ../../assets/<itemId>/；可发布落地页预览 → 发布层相对
  // 路径；不可发布落地页 ref → 剥离 href 属性（<a> 保留为纯视觉容器）。
  const published = fs.readFileSync(path.join(pageOther, PROTOTYPE_FILE), 'utf8')
  let rewritten = published
  for (const [from, to] of rewrites) {
    rewritten = to === ''
      ? rewritten.replaceAll(` href="${from}"`, '')
      : rewritten.replaceAll(`"${from}"`, `"${to}"`)
  }
  fs.writeFileSync(path.join(pageOther, PROTOTYPE_FILE), rewritten, 'utf8')

  // 发布后的原型本地 src/href 均必须存在（不含死链）。
  assertPublishedPrototypeLinks({ itemId, pageOther, html: rewritten })
  assertPublishedStylesheetLinks({ itemId, pageOther, files })

  return { pageOther, pageAssets, rewritten }
}

/** 递归复制目录（发布层内部使用，目标目录先清空语义由调用方保证）。 */
function copyDirectory(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true })
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const source = path.join(sourceDir, entry.name)
    const target = path.join(targetDir, entry.name)
    if (entry.isDirectory()) copyDirectory(source, target)
    else fs.copyFileSync(source, target)
  }
}

/**
 * 校验发布后原型的全部本地引用（src/href）都指向存在的文件：
 * other/<itemId>/ 内（styles/、<landingKey>/ 预览目录）或 assets/<itemId>/。
 * 任何死链都按 BATCH_PUBLISH_INCOMPLETE 抛出（fail fast，交付入口不得损坏）。
 */
function assertPublishedPrototypeLinks({ itemId, pageOther, html }) {
  for (const match of html.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
    const ref = match[1]
    if (path.win32.isAbsolute(ref) || path.posix.isAbsolute(ref)) {
      throw new BatchRunnerError('BATCH_PUBLISH_INVALID', `item ${itemId} 发布原型存在绝对路径引用：${ref}`)
    }
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref)) continue
    const target = path.resolve(pageOther, ref)
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      throw new BatchRunnerError('BATCH_PUBLISH_INCOMPLETE', `item ${itemId} 发布原型存在死链：${ref}`)
    }
  }
}

/** 校验发布样式中的本地 url(...) 依赖，避免背景图仅配置成功但交付目录缺图。 */
function assertPublishedStylesheetLinks({ itemId, pageOther, files }) {
  const stylesheets = new Set(files
    .map(([, relative]) => relative)
    .filter((relative) => path.extname(relative).toLowerCase() === '.css'))
  for (const relative of stylesheets) {
    const stylesheet = path.join(pageOther, relative)
    const css = fs.readFileSync(stylesheet, 'utf8')
    for (const { ref, absolute } of stylesheetLocalRefs(css)) {
      if (absolute) {
        throw new BatchRunnerError('BATCH_PUBLISH_INVALID', `item ${itemId} 发布样式存在绝对路径引用：${ref}`)
      }
      const target = path.resolve(path.dirname(stylesheet), ref)
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        throw new BatchRunnerError('BATCH_PUBLISH_INCOMPLETE', `item ${itemId} 发布样式存在死链：${ref}`)
      }
    }
  }
}

/**
 * 发布批次交付四层结构（幂等：先清空发布区再重建）。
 * 顶层合同：batchRoot 顶层最终只允许 index.html / assets/ / configs/ / other/。
 * @param {object} opts
 * @param {string} opts.batchRoot 批次根目录（绝对）
 * @param {object} opts.request 已校验批次请求（取 items 的 brief.deliverableType 与 pageLinkage）
 * @param {object} opts.checkpoint 终态检查点（items[].status/attemptRoot；运行时状态由
 *   batch-runner 维护在 other/runtime/，本层不复制运行时文件）
 * @param {string} [opts.title] 入口标题，缺省用 batchId
 * @returns {{ published: number, pages: Array, runtimeDir: string }}
 * @throws {BatchRunnerError} code=BATCH_PUBLISH_*（fail fast）
 */
export function publishBatchDelivery({ batchRoot, request, checkpoint }) {
  const root = path.resolve(batchRoot)
  if (!checkpoint || !Array.isArray(checkpoint.items)) {
    throw new BatchRunnerError('BATCH_PUBLISH_INVALID', '发布需要终态 checkpoint（含 items）')
  }
  const briefTypeByItemId = new Map((request?.items || []).map((item) => [item.itemId, item.brief?.deliverableType || '']))
  const succeededItems = checkpoint.items.filter((item) => item.status === 'succeeded' && item.attemptRoot)

  // ---- landingKey → landingItemId 确定性映射（来自 batchRequest.pageLinkage 的 plan）----
  // derivePlanFromRequest 保证：landing item 按请求顺序与 entries（landingKey 升序）
  // 一一对应，绝不按成功 item 顺序猜测。
  const linkagePlan = request ? derivePlanFromRequest(request) : null
  const itemIdByLandingKey = new Map()
  if (linkagePlan) {
    for (const step of linkagePlan.order) {
      if (step.landingKey) itemIdByLandingKey.set(step.landingKey, step.itemId)
    }
  }

  // ---- 可发布（succeeded）落地页集合 ----
  // 交付区只发布 status=succeeded 的 item；可审阅失败落地页不发布、不进入入口，
  // 首页对其引用一律剥离（纯视觉），运行时证据保留在 other/runtime。
  // 判定来源：终态 checkpoint item 状态（linkage.landingThemes 摘要只是 attempt 内
  // ref 的记录；发布层按 item 终态权威判定，绝不链接失败页）。
  const publishedLandingKeys = new Set()
  if (linkagePlan) {
    for (const [landingKey, landingItemId] of itemIdByLandingKey) {
      const itemState = checkpoint.items.find((i) => i.itemId === landingItemId)
      if (itemState?.status === 'succeeded' && itemState.attemptRoot) {
        publishedLandingKeys.add(landingKey)
      }
    }
  }

  // 幂等重建：先清空既有发布区，运行时目录 other/runtime 物理位于 other/ 之下，
  // 必须原样保留（只删除 other/ 内除 runtime 外的条目与 assets/configs/index.html）。
  fs.rmSync(path.join(root, ASSETS_DIR), { recursive: true, force: true })
  fs.rmSync(path.join(root, CONFIGS_DIR), { recursive: true, force: true })
  const otherPath = path.join(root, OTHER_DIR)
  if (fs.existsSync(otherPath)) {
    for (const entry of fs.readdirSync(otherPath)) {
      if (entry === RUNTIME_DIR) continue
      fs.rmSync(path.join(otherPath, entry), { recursive: true, force: true })
    }
  }
  fs.rmSync(path.join(root, 'index.html'), { force: true })

  // ---- 0. 四层骨架总是创建：零成功批次同样存在 assets/configs/other ----
  fs.mkdirSync(path.join(root, ASSETS_DIR), { recursive: true })
  fs.mkdirSync(path.join(root, CONFIGS_DIR), { recursive: true })
  fs.mkdirSync(path.join(root, OTHER_DIR), { recursive: true })

  const pages = []
  for (const item of succeededItems) {
    const itemId = item.itemId
    // checkpoint item.attemptRoot 是 createAttemptRoot 返回的绝对路径（位于
    // <batchRoot>/other/runtime/ 下）；兼容相对路径（相对运行时根）与旧批次
    // 绝对路径 <batchRoot>/items/...：迁移已把 items/ 物理移入运行时根，旧绝对
    // 路径在磁盘不存在时回退为运行时根下的对应目录（迁移后位置）。
    const runtimeRoot = runtimeRootFor(root)
    let attemptRoot
    if (path.isAbsolute(item.attemptRoot)) {
      attemptRoot = path.resolve(item.attemptRoot)
      if (!fs.existsSync(attemptRoot)) {
        const relativeToRoot = path.relative(root, attemptRoot)
        if (relativeToRoot && !relativeToRoot.startsWith('..') && !path.isAbsolute(relativeToRoot)) {
          const migrated = path.resolve(runtimeRoot, relativeToRoot)
          if (fs.existsSync(migrated)) attemptRoot = migrated
        }
      }
    } else {
      attemptRoot = [
        path.resolve(runtimeRoot, ...item.attemptRoot.split(/[\\/]+/)),
        path.resolve(root, ...item.attemptRoot.split(/[\\/]+/)),
      ].find((candidate) => fs.existsSync(candidate)) || path.resolve(runtimeRoot, ...item.attemptRoot.split(/[\\/]+/))
    }
    if (!fs.existsSync(attemptRoot)) {
      throw new BatchRunnerError('BATCH_PUBLISH_INCOMPLETE', `item ${itemId} 的 attempt 目录不存在：${item.attemptRoot}`)
    }
    const pageOther = path.join(root, OTHER_DIR, itemId)
    fs.mkdirSync(pageOther, { recursive: true })

    // 首页原型内 landingPreviewRef 分类：
    //  - 可发布落地页（succeeded）：<landingKey>/prototype.html → ../<landingItemId>/prototype.html；
    //  - 不可发布落地页（failed/中断，含可审阅失败）：从发布 HTML 剥离 href
    //    （保留纯视觉容器），不复制其预览目录与 ref 文件到交付区。
    // plan/终态权威判定：任何 landingKey 无 plan 关联都视为不可发布（只剥离）。
    let unlinkableLandingRefs = new Set()
    const landingRefRewrites = new Map()
    if (briefTypeByItemId.get(itemId) === 'alipay.home') {
      for (const { ref, absolute } of prototypeLocalRefs(fs.readFileSync(path.join(attemptRoot, PROTOTYPE_FILE), 'utf8'))) {
        if (absolute) continue
        const match = /^(landing-\d{2,})\/prototype\.html$/.exec(ref)
        if (!match) continue
        const landingKey = match[1]
        const landingItemId = itemIdByLandingKey.get(landingKey)
        if (landingItemId && publishedLandingKeys.has(landingKey)) {
          landingRefRewrites.set(ref, `../${landingItemId}/${PROTOTYPE_FILE}`)
        } else {
          // 不可发布：剥离 href（纯视觉），不发布该落地页预览到交付区。
          unlinkableLandingRefs.add(ref)
        }
      }
    }

    // 1. 原型 + 依赖 + 素材发布（含引用改写、不可发布 ref 剥离与死链校验；无素材
    //    引用也创建 assets/<itemId>/ 目录）。
    const { rewritten } = publishPage({ batchRoot: root, itemId, attemptRoot, landingRefRewrites, unlinkableLandingRefs })

    // 2. 其他页面产物文件（原样复制；缺失跳过——不同页面产物集合不同）。
    for (const name of PAGE_FILES) {
      const source = path.join(attemptRoot, name)
      if (fs.existsSync(source) && fs.statSync(source).isFile()) {
        fs.copyFileSync(source, path.join(pageOther, name))
      }
    }

    // 3. 配置发布副本（home-config.json / landing-config.json 二选一）。
    //    首页配置发布前重写 carousel/waistBanners 的 landingPreviewRef：
    //    '<landingKey>/prototype.html'（attempt 内相对路径）→
    //    '../other/<landingItemId>/prototype.html'（从 configs/ 目录解析的有效相对路径）；
    //    landingKey 不可链接（无 plan 关联或目标非 succeeded）→ 删除该条目 ref 字段
    //    （明确只保留视觉/无 ref，绝不保留死链、误连或链接失败页）。
    const configName = briefTypeByItemId.get(itemId) === 'alipay.home' ? 'home-config.json' : 'landing-config.json'
    const configSource = path.join(attemptRoot, configName)
    if (!fs.existsSync(configSource)) {
      throw new BatchRunnerError('BATCH_PUBLISH_INCOMPLETE', `item ${itemId} 缺少配置文件 ${configName}，无法发布`)
    }
    const configTarget = path.join(root, CONFIGS_DIR, `${itemId}.config.json`)
    if (briefTypeByItemId.get(itemId) === 'alipay.home') {
      rewriteHomeConfigPreviewRefs({ configSource, configTarget, itemIdByLandingKey, publishedLandingKeys })
    } else {
      fs.copyFileSync(configSource, configTarget)
    }

    pages.push({
      itemId,
      type: briefTypeByItemId.get(itemId) || 'page',
      title: readPageTitle(configSource, itemId),
      prototypeRef: `${OTHER_DIR}/${itemId}/${PROTOTYPE_FILE}`,
      configRef: `${CONFIGS_DIR}/${itemId}.config.json`,
      assetsRef: `${ASSETS_DIR}/${itemId}/`,
      screenshotRef: fs.existsSync(path.join(pageOther, 'prototype.png')) ? `${OTHER_DIR}/${itemId}/prototype.png` : undefined,
      rewritten,
    })
  }

  // 4. 入口 HTML：设计模板（蓝金响应式）渲染，列出所有成功页面的
  //    原型、配置、素材与截图入口（无成功页面时仍产出空态入口）。
  const indexHtml = renderBatchDeliveryIndex({
    batchId: checkpoint.batchId || request?.batchId || 'batch',
    pages: pages.map((page) => ({
      itemId: page.itemId,
      title: page.title,
      type: page.type,
      prototypePath: page.prototypeRef,
      configPath: page.configRef,
      assetsPath: page.assetsRef,
      ...(page.screenshotRef ? { screenshotPath: page.screenshotRef } : {}),
    })),
  })
  fs.writeFileSync(path.join(root, 'index.html'), indexHtml, 'utf8')

  // 5. 禁区校验：generated-assets/ 与 openphoto-data/ 不得进入发布区
  //（other/runtime 属运行时追溯，attempt 内禁区不算发布区）。
  for (const forbidden of ['generated-assets', 'openphoto-data']) {
    for (const dir of [ASSETS_DIR, OTHER_DIR]) {
      const dirRoot = path.join(root, dir)
      if (!fs.existsSync(dirRoot)) continue
      const walk = (current) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
          if (entry.name === forbidden) {
            throw new BatchRunnerError('BATCH_PUBLISH_INVALID', `发布区不得包含 ${forbidden}/：${path.join(current, entry.name)}`)
          }
          if (entry.isDirectory()) walk(path.join(current, entry.name))
        }
      }
      if (dir === OTHER_DIR) {
        // other/<itemId>/ 逐页校验，跳过 other/runtime/。
        for (const entry of fs.readdirSync(dirRoot, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.name === RUNTIME_DIR) continue
          walk(path.join(dirRoot, entry.name))
        }
      } else {
        walk(dirRoot)
      }
    }
  }

  return { published: pages.length, pages: pages.map((p) => ({ itemId: p.itemId, prototypeRef: p.prototypeRef, configRef: p.configRef, assetsRef: p.assetsRef })), runtimeDir: `${OTHER_DIR}/${RUNTIME_DIR}` }
}

/** 从配置文件派生入口标题（theme/page name），失败回退 itemId。 */
function readPageTitle(configSource, itemId) {
  try {
    const config = JSON.parse(fs.readFileSync(configSource, 'utf8'))
    const name = config?.page?.name || config?.searchBar?.placeholderText
    return typeof name === 'string' && name.trim() ? name.trim() : itemId
  } catch {
    return itemId
  }
}

/**
 * 发布首页配置副本前重写 carousel/waistBanners 的 landingPreviewRef：
 *  - '<landingKey>/prototype.html'（attempt 内相对路径）→
 *    '../other/<landingItemId>/prototype.html'（从 configs/ 目录解析的有效相对路径）；
 *  - landingKey 不可链接（无 plan 关联或该落地页 item 非 succeeded/未发布）→ 删除
 *    该条目 landingPreviewRef 字段（明确只保留视觉/无 ref，绝不保留死链、误连
 *    或链接失败页）。
 * 其余配置内容原样保留；非对象/缺字段的条目原样保留（宽容读取）。
 */
function rewriteHomeConfigPreviewRefs({ configSource, configTarget, itemIdByLandingKey, publishedLandingKeys }) {
  let config
  try {
    config = JSON.parse(fs.readFileSync(configSource, 'utf8'))
  } catch (error) {
    throw new BatchRunnerError('BATCH_PUBLISH_INVALID', `首页配置 JSON 解析失败：${error.message}`)
  }
  const previewRefPattern = /^(landing-\d{2,})\/prototype\.html$/
  for (const module of ['carousel', 'waistBanners']) {
    if (!Array.isArray(config?.[module])) continue
    for (const entry of config[module]) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
      const ref = entry.landingPreviewRef
      if (typeof ref !== 'string' || !ref) continue
      const match = previewRefPattern.exec(ref)
      const landingKey = match?.[1]
      const landingItemId = landingKey ? itemIdByLandingKey.get(landingKey) : null
      if (landingKey && landingItemId && publishedLandingKeys.has(landingKey)) {
        entry.landingPreviewRef = `../${OTHER_DIR}/${landingItemId}/${PROTOTYPE_FILE}`
      } else {
        // 不可链接：删除 ref 字段（纯视觉），绝不发布指向不存在目标或失败页的引用。
        delete entry.landingPreviewRef
      }
    }
  }
  fs.writeFileSync(configTarget, JSON.stringify(config, null, 2), 'utf8')
}

/** 发布层目录布局常量（测试与调用方共用）。 */
export const PUBLISH_LAYOUT = { ASSETS_DIR, CONFIGS_DIR, OTHER_DIR, RUNTIME_DIR, PROTOTYPE_FILE }

export default publishBatchDelivery

#!/usr/bin/env node
// 支付宝落地页设计 Skill CLI。
//
// 子命令：
//   landing-design capabilities
//      输出本 Skill 提供的能力清单
//   landing-design request --file <path> [--output <dir>] [--screenshot]
//      [--theme <text>] [--landing-key <text>]
//      从 JSON 文件读取 DesignBrief 并设计落地页
//   landing-design request --json <json> [--output <dir>] [--screenshot]
//      [--theme <text>] [--landing-key <text>]
//      从内联 JSON 读取 DesignBrief 并设计落地页
//
// 可选主题参数：theme 决定整页主题与页面名/导航标题（未提供时用默认主题
// 夏日出游租赁）；landingKey 为联合任务内非生产稳定标识
// （landing-01/landing-02…），独立交付省略。两者均可由编排器
// standard-bindings 以 pageOptions 形式直接传入 designLanding。
//
// 输出（JSON）：{ ok, status, designPackage, pendingAssetRequests, warnings }
// 稳定错误：{ ok: false, code, message, details }
//
// 交付（四项同源）：landing-config.json（landing-schema/v1 唯一配置合同）、
// prototype.html、assets/、configuration-guide.md 均由同一份配置派生：
//  - config.modules 按 Catalog 白名单映射为 assemblePage 的受控 blocks 重组；
//  - 未回填素材保持 pending，继续显示快照素材供设计评审；
//  - configuration-guide.md 标注未完成槽位与发布前必填项。
//
// 约束：受控 Node 工具链，不安装依赖；screenshot 复用 skill-alipay-pages 脚本。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assemblePage } from '../../skill-alipay-pages/scripts/assemble.mjs'
import { validateOutput } from '../../skill-alipay-pages/scripts/validate.mjs'
import { buildDesignPackage } from '../../skill-alipay-pages/scripts/package.mjs'
import { COMPONENT_LIB } from '../../skill-alipay-pages/scripts/build-catalog.mjs'
import {
  deriveLandingConfig,
  loadLandingCatalog,
  normalizeDesignBrief,
  LANDING_PACKAGE_ROOT,
} from '../runtime/planner.mjs'
import { normalizePendingAssetRequests } from '../runtime/asset-requester.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const manifest = JSON.parse(fs.readFileSync(path.join(LANDING_PACKAGE_ROOT, 'manifest.json'), 'utf8'))

const CAPABILITIES = [
  {
    id: 'page.alipay.landing.design',
    version: '1.0.0',
    inputSchema: 'design-brief.schema.json',
    outputSchema: 'design-package.schema.json',
    automatic: true,
    priority: 10,
    availabilityCommand: 'landing-design capabilities',
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
 * 从同一份 landing-config.json（landing-schema/v1）把 modules 映射为
 * assemblePage blocks 输入。映射是纯转换：不产生新事实，也不写回 config。
 *
 * - HERO_IMAGE     → lp-hero，槽位 ../assets/landing/hero.png；输出路径取
 *                    config 声明的 module.image；回填/占位由 designLanding 决定。
 * - IMAGE_AD       → 单图保留 is-single；双图在同一 is-double 容器横向并排。
 * - SECTION_TITLE  → lp-section-title，文本取 mode.text（校验已保证 ≤20 字）。
 * - ACTION_BUTTON  → lp-action-button，文本取 module.text。
 * - COUPON_GROUP / PRODUCT_COLLECTION / SPACER 直接实例化模板；
 *                    商品图片不产生素材请求（商品保持快照引用，由业务系统维护）。
 * @returns {{ blocks: Array, assetRequests: Array }} 槽位请求含
 *   id/moduleRef/slot/currentSrc/outputPath/targetWidth/targetHeight，
 *   id 与设计包素材请求一一对应（回填按 id 匹配）。
 */
export function blocksFromConfig(config) {
  const blockByType = {
    HERO_IMAGE: 'lp-hero',
    IMAGE_AD: 'lp-image-ad',
    SECTION_TITLE: 'lp-section-title',
    COUPON_GROUP: 'lp-coupons',
    PRODUCT_COLLECTION: 'lp-products',
    ACTION_BUTTON: 'lp-action',
    SPACER: 'lp-spacer',
  }
  const blocks = []
  const assetRequests = []
  if (config.page.background.type === 'image') {
    assetRequests.push({ id: 'page.pageBackground.image', moduleRef: 'page', slot: 'pageBackground', outputPath: config.page.background.image, targetWidth: 1500, targetHeight: 2400, copyOnly: true })
  }
  for (const module of config.modules) {
    const component = blockByType[module.type]
    if (!component) throw new Error(`landing config 含白名单外模块：${module.type}`)
    if (module.type === 'IMAGE_AD') {
      // 单图模式恰好 1 张（1404x480，is-single 默认容器）；双图模式恰好 2 张
      // （单张 686x480）在同一个 is-double 容器内横向排列。
      const width = module.mode.mode === 'single' ? 1404 : 686
      blocks.push({ component, double: module.mode.mode === 'double' })
      assetRequests.push({
        id: `${module.id}.imageAd.1.image`,
        moduleRef: module.id,
        slot: 'imageAd.1',
        currentSrc: '../assets/landing/image-ad.png',
        outputPath: module.images[0],
        targetWidth: width,
        targetHeight: 480,
      })
      for (let i = 1; i < module.images.length; i++) {
        assetRequests.push({
          id: `${module.id}.imageAd.${i + 1}.image`,
          moduleRef: module.id,
          slot: `imageAd.${i + 1}`,
          currentSrc: '../assets/landing/image-ad.png',
          outputPath: module.images[i],
          targetWidth: width,
          targetHeight: 480,
        })
      }
      continue
    }
    const block = { component }
    if (module.type === 'SECTION_TITLE') {
      if (module.mode.mode === 'text') block.texts = [{ className: 'lp-section-title', value: module.mode.text }]
      else {
        block.sectionTitleImage = true
        assetRequests.push({ id: `${module.id}.sectionTitle.image`, moduleRef: module.id, slot: `sectionTitle.${config.modules.filter(m => m.type === 'SECTION_TITLE').indexOf(module) + 1}`, currentSrc: '../assets/landing/image-ad.png', outputPath: module.mode.image, targetWidth: 720, targetHeight: 120 })
      }
    }
    if (module.type === 'ACTION_BUTTON') {
      block.texts = [{ className: 'lp-action-button', value: module.text }]
    }
    blocks.push(block)
    if (module.type === 'HERO_IMAGE') {
      assetRequests.push({
        id: `${module.id}.hero.image`,
        moduleRef: module.id,
        slot: 'hero',
        currentSrc: '../assets/landing/hero.png',
        outputPath: module.image,
        targetWidth: 1500,
        targetHeight: 720,
      })
    }
    if (module.type === 'COUPON_GROUP') {
      for (const [name, background] of [['overallBackground', module.overallBackground], ['amountAreaBackground', module.amountAreaBackground], ['contentAreaBackground', module.contentAreaBackground]]) {
        if (background.mode === 'image') assetRequests.push({ id: `${module.id}.${name}.image`, moduleRef: module.id, slot: `couponGroup.${config.modules.filter(m => m.type === 'COUPON_GROUP').indexOf(module) + 1}.${name}`, outputPath: background.image, targetWidth: 1404, targetHeight: 480, copyOnly: true })
      }
    }
    if (module.type === 'PRODUCT_COLLECTION' && module.background.mode === 'image') {
      assetRequests.push({ id: `${module.id}.background.image`, moduleRef: module.id, slot: `productCollection.${config.modules.filter(m => m.type === 'PRODUCT_COLLECTION').indexOf(module) + 1}.background`, outputPath: module.background.image, targetWidth: 1404, targetHeight: 1200, copyOnly: true })
    }
  }
  return { blocks, assetRequests }
}

function landingSlotPrompt(req, theme) {
  const delivery = `目标比例 ${req.targetWidth}:${req.targetHeight}，展示方式 cover，单一平面素材`
  if (req.slot === 'hero') return `${theme}；${delivery}；落地页活动头图，单幅活动封面，主体与短标题留在中央安全区；不包含下方优惠券、商品区或按钮`
  if (req.slot.startsWith('imageAd')) return `${theme}；${delivery}；落地页广告位 ${req.slot}，只生成该广告位的一幅横向广告素材，与其他广告位使用不同构图`
  if (req.slot === 'pageBackground') return `${theme}；${delivery}；落地页低信息密度背景纹理，可大面积裁切；不含正文或可点击模块`
  if (req.slot.startsWith('sectionTitle')) return `${theme}；${delivery}；落地页单一区块标题素材，透明或纯净背景；不含相邻模块`
  if (req.slot.includes('Background')) return `${theme}；${delivery}；落地页模块低干扰背景纹理；不生成卡片、价格、按钮或商品列表`
  return `${theme}；${delivery}；落地页当前素材槽位 ${req.slot}`
}

function researchPromptHint(researchPack) {
  const signals = Array.isArray(researchPack?.signals) ? researchPack.signals : []
  const values = signals
    .filter((signal) => ['visual', 'color', 'layout', 'content'].includes(signal?.kind) && typeof signal.value === 'string')
    .map((signal) => signal.value.trim())
    .filter(Boolean)
  return values.length ? `；研究建议：${values.join('；')}` : ''
}

/**
 * 从同一份 landing-config.json（landing-schema/v1）派生面向运营的配置建议
 * （configuration-guide.md）。只表达配置事实与待确认事项，不包含生产
 * jumpUrl、发布或缓存字段；未回填素材槽位与待补资源显式标注，不伪装完整。
 */
function renderConfigurationGuide(brief, config, derived, { acceptedUsageSlots = new Set(), failedUsageSlots = new Set() } = {}) {
  const lines = []
  lines.push('# 落地页配置建议')
  lines.push('')
  lines.push(`主题：${config.page.name}`)
  if (config.landingKey) lines.push(`landingKey：${config.landingKey}（联合任务内标识，非生产跳转）`)
  lines.push('')
  lines.push('本指南由 landing-config.json（landing-schema/v1）派生，与静态原型、素材包同源。页面配置仅表达设计意图，不是可直接部署或发布的完整前端配置；真实商品、优惠券、资源 ID、路由、页面编码、草稿与发布由对应业务系统负责。')
  if (brief.outputSpec?.width !== 375) lines.push('- 预览按 375px 基准生成；请求宽度仅作为交付说明，不改变受控原型基准。')
  lines.push('')
  lines.push('## 页面级配置')
  lines.push('')
  lines.push(`- 导航标题（≤15 字）：${config.page.navTitle}`)
  lines.push(`- 页面背景：${config.page.background.type === 'color' ? `纯色 ${config.page.background.color}` : config.page.background.image}`)
  lines.push('- 活动时间：当前留空，由用户在业务系统填写（发布前必填）。')
  lines.push('')
  lines.push('## 模块清单（受控白名单）')
  lines.push('')
  for (const module of config.modules) {
    lines.push(`- ${module.type}（${module.id}）`)
  }
  lines.push('')
  if (derived.assetRequests.length) {
    lines.push('## 素材槽位')
    lines.push('')
    for (const req of derived.assetRequests) {
      const status = acceptedUsageSlots.has(req.usageSlot)
        ? '；已生成并通过比例验收'
        : (failedUsageSlots.has(req.usageSlot) ? '；生成失败，原型显示诊断占位' : '；待生成，原型暂用快照素材预览，发布前必填')
      lines.push(`- ${req.usageSlot}：${req.targetWidth}x${req.targetHeight}${status}`)
    }
    lines.push('')
  }
  if (config.pendingResourceRequests?.length) {
    lines.push('## 待确认资源')
    lines.push('')
    for (const req of config.pendingResourceRequests) {
      lines.push(`- ${req.resourceType}（${req.moduleRef}）：${req.criteria}`)
    }
    lines.push('')
  }
  lines.push('## 边界提醒')
  lines.push('')
  lines.push('- 跳转（jumpUrl）与页面编码（pageCode）不在本配置内；请在业务系统中配置并校验。')
  for (const warning of derived.warnings) lines.push(`- 注意：${warning}`)
  lines.push('')
  return lines.join('\n')
}

function insertFailedAssetPlaceholder(html, className, index = 0) {
  const escapedClass = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`(<[a-zA-Z0-9-]+\\b[^>]*\\bclass="[^"]*\\b${escapedClass}\\b[^"]*"[^>]*>)`, 'g')
  let current = 0
  let inserted = false
  const result = html.replace(pattern, (open) => {
    if (current++ !== index) return open
    inserted = true
    return `${open}<span class="lp-section-title">素材生成失败</span>`
  })
  if (!inserted) {
    const error = new Error(`原型缺少失败素材诊断位置：${className}`)
    error.code = 'PROTOTYPE_SLOT_MISSING'
    throw error
  }
  return result
}

function replaceFailedAssetImages(outputRoot, requestsByUsageSlot, blocks, failedUsageSlots) {
  if (!failedUsageSlots.size) return
  const prototypePath = path.join(outputRoot, 'prototype.html')
  let html = fs.readFileSync(prototypePath, 'utf8')
  for (const usageSlot of failedUsageSlots) {
    const request = requestsByUsageSlot.get(usageSlot)
    if (request?.copyOnly) {
      if (request.slot === 'pageBackground') {
        const topBlock = blocks.find((block) => block.component !== 'lp-spacer') || blocks[0]
        html = insertFailedAssetPlaceholder(html, topBlock.component)
      } else if (request.slot.startsWith('couponGroup.')) {
        const couponIndex = Number(request.slot.split('.')[1]) - 1
        html = insertFailedAssetPlaceholder(html, 'lp-coupons', couponIndex)
      } else if (request.slot.startsWith('productCollection.')) {
        const productIndex = Number(request.slot.split('.')[1]) - 1
        html = insertFailedAssetPlaceholder(html, 'lp-products', productIndex)
      }
      continue
    }
    const outputPath = `assets/${usageSlot.replace(/^landing\./, '')}.png`
    const escaped = outputPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    html = html.replace(new RegExp(`<img\\b[^>]*\\bsrc="${escaped}"[^>]*>`, 'g'), '<span class="lp-section-title">素材生成失败</span>')
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
  const themeIdx = args.indexOf('--theme')
  const keyIdx = args.indexOf('--landing-key')
  const wantsScreenshot = args.includes('--screenshot')

  if (themeIdx !== -1 && args[themeIdx + 1] === undefined) return fail('USAGE', '--theme 需要主题名')
  if (keyIdx !== -1 && args[keyIdx + 1] === undefined) return fail('USAGE', '--landing-key 需要标识')

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

  try {
    const result = await designLanding({
      brief,
      outputRoot,
      screenshot: wantsScreenshot,
      ...(themeIdx !== -1 ? { theme: args[themeIdx + 1] } : {}),
      ...(keyIdx !== -1 ? { landingKey: args[keyIdx + 1] } : {}),
    })
    ok({ ok: true, status: result.status, designPackage: result.designPackage, pendingAssetRequests: result.pendingAssetRequests, warnings: result.warnings })
  } catch (e) {
    return fail(e.code || 'INTERNAL', e.message, e.details || [])
  }
}

/**
 * 执行落地页设计并输出交付包（四项同源，均由 landing-config.json 派生）。
 * 真实素材请求统一采用 landing.<landingKey>.<slot>.image 命名、比例验收
 * （误差 ≤3%）与生成 3 次/适配 2 次重试合同。
 *
 * 回填边界（独立设计入口防伪造）：
 *  - brief.inputArtifacts 一律视为用户原始参考图：不信任 sourceSkill 标记，
 *    绝不直接形成 imageChanges，只作为 pendingAssetRequests.referenceImages 候选；
 *  - 已验收素材只能通过内部参数 completedAssets 显式传入（编排器 runDesign
 *    二次回填专用，非 brief 公共路径）；命中槽位命名且比例 ≤3% 才复制回填。
 * @param {object} opts { brief, outputRoot, screenshot?, theme?, landingKey?, completedAssets? }
 * @returns {{ status, designPackage, pendingAssetRequests, warnings }}
 */
export async function designLanding({ brief, outputRoot, screenshot = false, theme, landingKey, completedAssets, failedAssets, researchPack, visionModelConfigured = false } = {}) {
  if (failedAssets !== undefined && !Array.isArray(failedAssets)) {
    const error = new Error('failedAssets 必须是数组（编排器二次回填的失败素材请求 ID 列表）')
    error.code = 'INVALID_FAILED_ASSETS'
    throw error
  }
  // 唯一配置合同：越界 theme/landingKey 输入在产出任何文件前稳定失败。
  const derived = deriveLandingConfig(brief, { theme, landingKey })
  const config = derived.config
  const warnings = [...derived.warnings]

  // 槽位命名/尺寸/对齐与 derive 状态数据一致（landing.<slotKey>.<slot>.image）。
  const derivedByModuleSlot = new Map(derived.assetRequests.map((r) => [`${r.moduleRef}.${r.slot}`, r]))
  const forbiddenContent = (Array.isArray(brief.forbiddenChanges) ? brief.forbiddenChanges : [])
    .filter((x) => typeof x === 'string')

  // config.modules → 受控 blocks + 真实素材槽位（尺寸按模块 mode：
  // IMAGE_AD 单图 1404x480 / 双图单张 686x480；双图按序实例化两个受控
  // 容器，不新增 class/variant）。
  const { blocks, assetRequests } = blocksFromConfig(config)

  loadLandingCatalog()
  fs.mkdirSync(outputRoot, { recursive: true })
  // 记录输入 brief 快照，供 DesignPackage 与审计。
  fs.writeFileSync(path.join(outputRoot, 'design-brief.json'), JSON.stringify(brief, null, 2) + '\n')
  // 配置是四项产物的唯一事实源，先于原型落盘（同源派生起点）。
  fs.writeFileSync(path.join(outputRoot, 'landing-config.json'), JSON.stringify(config, null, 2) + '\n')

  // 回填边界（spec：brief.inputArtifacts 一律为用户原始参考图）：
  //  - inputArtifacts 不参与页面回填（不信任 sourceSkill 标记），仅作为
  //    pendingAssetRequests.referenceImages 候选进入生图请求；
  //  - 已验收素材仅经内部参数 completedAssets（编排器二次回填专用）进入
  //    imageChanges：按 usageSlot 命名匹配槽位，比例 ≤3% 才复制。
  const completedByRequestId = new Map()
  for (const asset of (Array.isArray(completedAssets) ? completedAssets : [])) {
    if (!asset || typeof asset.assetRequestId !== 'string' || typeof asset.path !== 'string') continue
    if (completedByRequestId.has(asset.assetRequestId)) {
      const error = new Error(`同一素材请求返回多个结果：${asset.assetRequestId}`)
      error.code = 'DUPLICATE_COMPLETED_ASSET'
      throw error
    }
    completedByRequestId.set(asset.assetRequestId, asset)
  }
  /** 槽位比例验收（与生成素材同标准，≤3%）；不满足则该素材不作为最终素材。 */
  // 比例浮点噪声容差：与 orchestrator shared acceptance（skill-orchestrator/runtime/
  // asset-acceptance.mjs 的 ASPECT_RATIO_ERROR_EPSILON = 1e-9）语义一致。两包不能
  // 互相 import（依赖方向：orchestrator → 页面包），故保留同值最小 epsilon 常量：
  // 理论恰好 3% 的比例（如 1545x720 vs 1500x720、1030x1000 vs 1:1）在 IEEE754 下为
  // 0.030000000000000027，无 epsilon 会被误拒；真实超差（≥0.03 + 噪声以上）仍拒绝。
  const ASPECT_RATIO_ERROR_EPSILON = 1e-9
  const slotAcceptanceError = (slotReq, asset) => {
    if (!Number.isInteger(asset.width) || !Number.isInteger(asset.height) || asset.width < 1 || asset.height < 1) {
      return '宽高缺失或非法'
    }
    const targetRatio = slotReq.targetWidth / slotReq.targetHeight
    const actualRatio = asset.width / asset.height
    if (Math.abs((actualRatio / targetRatio) - 1) > 0.03 + ASPECT_RATIO_ERROR_EPSILON) {
      return `比例超出 3% 容差：目标 ${slotReq.targetWidth}x${slotReq.targetHeight}，实际 ${asset.width}x${asset.height}`
    }
    return null
  }
  const imageChanges = []
  const pendingCandidates = []
  const acceptedUsageSlots = new Set()
  const knownUsageSlots = new Set(derived.assetRequests.map((request) => request.usageSlot))
  const failedUsageSlots = new Set((Array.isArray(failedAssets) ? failedAssets : [])
    .filter((id) => typeof id === 'string' && knownUsageSlots.has(id)))
  for (const req of assetRequests) {
    const derivedReq = derivedByModuleSlot.get(`${req.moduleRef}.${req.slot}`)
    const usageSlot = derivedReq?.usageSlot || req.id
    // 仅 completedAssets（显式内部参数）可回填；brief.inputArtifacts 永不参与。
    const candidate = completedByRequestId.get(req.id) || completedByRequestId.get(usageSlot)
    if (candidate) {
      const rejectionReason = slotAcceptanceError(req, candidate)
      if (!rejectionReason) {
        imageChanges.push({ currentSrc: req.currentSrc, sourcePath: candidate.path, outputPath: req.outputPath, copyOnly: req.copyOnly })
        acceptedUsageSlots.add(usageSlot)
        continue
      }
      // 已验收素材与槽位比例不符：不回填（不作为最终页面素材），仅作参考图。
      warnings.push(`已验收素材未通过槽位 ${usageSlot} 验收，仅作参考图：${rejectionReason}`)
    }
    // pending 仍使用快照素材以维持完整原型；它不是已验收的生成结果。
    const fallbackFile = req.slot === 'hero' ? 'hero.png' : 'image-ad.png'
    imageChanges.push({
      currentSrc: req.currentSrc,
      sourcePath: path.join(COMPONENT_LIB, 'assets', 'landing', fallbackFile),
      outputPath: req.outputPath,
      copyOnly: req.copyOnly,
    })
    if (failedUsageSlots.has(usageSlot)) continue
    pendingCandidates.push({
      id: usageSlot,
      usageSlot,
      theme: `${landingSlotPrompt({ ...req, slot: derivedReq?.slot || req.slot }, config.page.name)}${researchPromptHint(researchPack)}`,
      targetWidth: req.targetWidth,
      targetHeight: req.targetHeight,
      aspectRatio: `${req.targetWidth}:${req.targetHeight}`,
      format: 'png',
      fit: 'cover',
      safeArea: req.slot === 'hero' ? '主体与短标题位于中央 80% 安全区，四周保留裁切余量' : '重要内容位于中央 85% 安全区，避免被裁切',
      // 用户输入图只作参考候选，不直接作为最终页面素材（spec：禁止用户输入直接回填）。
      referenceImages: (Array.isArray(brief.inputArtifacts) ? brief.inputArtifacts : [])
        .filter((a) => a && a.assetRequestId === usageSlot && typeof a.path === 'string' && a.mimeType)
        .map((a) => ({ assetRequestId: a.assetRequestId || req.id, artifactId: a.artifactId || `input-${path.basename(String(a.path))}`, path: String(a.path), mimeType: String(a.mimeType), width: Number(a.width) || 1, height: Number(a.height) || 1, sha256: /^[a-f0-9]{64}$/.test(String(a.sha256)) ? a.sha256 : '0'.repeat(64), sourceSkill: a.sourceSkill || 'user-input', sourceSkillVersion: a.sourceSkillVersion || '0.0.0', strictSizeSatisfied: Boolean(a.strictSizeSatisfied), notes: Array.isArray(a.notes) ? a.notes : [] })),
      forbiddenContent: [...new Set([
        '完整首页或落地页', '手机模型或浏览器框', '应用界面、搜索栏或底部导航',
        '多个页面模块拼版', '素材说明板或设计稿展示板', '重复宫格', '画面外白边或尺寸标注',
        ...forbiddenContent,
      ])],
      allowGenerate: true,
      allowEdit: true,
      // 请求级执行合同：比例验收（误差 ≤3%）+ 有限重试（生成 3 次/适配 2 次）。
      acceptance: { mode: 'aspect-ratio', maxAspectRatioError: 0.03 },
      retryPolicy: { generateMaxAttempts: 3, adaptMaxAttempts: 2 },
    })
  }
  const pendingAssetRequests = normalizePendingAssetRequests(pendingCandidates)
  // 未回填槽位（含验收未通过的输入素材）保持 pending，输入图只保留在
  // referenceImages 候选中；只有外部执行器显式传入 failed 状态时才可展示失败。

  fs.writeFileSync(
    path.join(outputRoot, 'asset-manifest.json'),
    JSON.stringify({ pendingAssetRequests }, null, 2) + '\n',
  )
  fs.writeFileSync(
    path.join(outputRoot, 'configuration-guide.md'),
    renderConfigurationGuide(brief, config, derived, { acceptedUsageSlots, failedUsageSlots }),
  )

  const assembleResult = assemblePage({
    pageType: 'landing',
    outputRoot,
    changes: {
      // config 驱动受控重组：modules 白名单映射为 blocks；文本/图片槽位同源。
      blocks,
      images: imageChanges,
      docTitle: config.page.name,
      themeTokens: { pageType: 'landing', config },
    },
  })
  replaceFailedAssetImages(
    outputRoot,
    new Map(assetRequests.map((request) => [
      derivedByModuleSlot.get(`${request.moduleRef}.${request.slot}`)?.usageSlot || request.id,
      request,
    ])),
    blocks,
    failedUsageSlots,
  )
  const visualReviewWarnings = writeVisualReview({
    outputRoot,
    slots: derived.assetRequests,
    acceptedUsageSlots,
    failedUsageSlots,
    visionModelConfigured,
  })
  warnings.push(...visualReviewWarnings)

  const validation = validateOutput({ outputRoot, pageType: 'landing' })
  if (!validation.passed) {
    const error = new Error(`落地页交付校验失败：${validation.errors.join('；')}`)
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
      { id: 'skill-alipay-landing', version: manifest.version },
    ],
  })

  if (screenshot) {
    const { screenshotPage } = await import('../../skill-alipay-pages/scripts/screenshot.mjs')
    const prototypePath = path.join(outputRoot, 'prototype.html')
    const pngPath = path.join(outputRoot, 'prototype.png')
    await screenshotPage({
      prototypePath,
      outputPath: pngPath,
      viewportHeight: brief.outputSpec?.height || 1334,
    })
    // 截图后重新打包以纳入 prototype.png
    designPackage = buildDesignPackage({
      outputRoot,
      designBriefId: brief.id,
      sourceCommit: assembleResult.catalog.sourceCommit,
      skillDependencies: [
        { id: 'skill-alipay-pages', version: '0.1.0' },
        { id: 'skill-alipay-landing', version: manifest.version },
      ],
    })
  }

  return {
    status: pendingAssetRequests.length || failedUsageSlots.size ? 'completed_with_pending_assets' : 'succeeded',
    designPackage,
    pendingAssetRequests,
    warnings,
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

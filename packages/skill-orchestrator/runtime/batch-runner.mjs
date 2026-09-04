// 3C.2：批次执行器。
//
// 职责：驱动一批 item 的编排执行，维护 checkpoint 持久化与最终 BatchResult。
// 页面联动（pageLinkage）：可选；存在时 landing 优先执行、按 plan 注入联动上下文、
// 汇总联合校验 warnings；失败落地页只产生 warnings，不阻断首页。required 素材
// 失败但页面已完成（受控校验通过）且带未回填槽位诊断占位的落地页，会以
// 「failed + reviewable」传给首页作为可关联预览（ref 指向 attempt 内
// prototype.html）；仅凭 prototype.html 存在不可判定——页面组装/校验/打包失败
// 或 runItem 中断遗留的原型不可关联。item/批次状态语义（failed/partially_failed）
// 不因此改变。
// 边界：本层不执行业务（业务由注入的 runItem 完成），只负责批次生命周期、状态机与落盘。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Registry, validate } from '../../design-skill-contracts/scripts/validate.mjs'
import { loadBatchRequest } from './batch-request.mjs'
import {
  createCheckpoint,
  writeCheckpointAtomic,
  normalizeInterrupted,
  assertCompatible,
  touchCheckpoint,
  loadCheckpointCandidates,
  promoteRecoveredCheckpoint,
  hasAnyCheckpointFile,
  CheckpointError,
} from './checkpoint.mjs'
import { createCheckpointAssetStore } from './checkpoint-asset-store.mjs'
import { createAttemptRoot, nextAttempt } from './attempt-root.mjs'
import { fingerprint, sanitizeProviderIdentity } from './fingerprint.mjs'
import { derivePlanFromRequest, homeContextFor, jointReview, landingContextFor, previewRefFor } from './page-linkage.mjs'
import { publishBatchDelivery } from './publish-structure.mjs'
import { runtimeRootFor } from './runtime-root.mjs'

/** attempt 目录内可审阅原型的固定文件名（页面 Skill 交付物）。 */
const PROTOTYPE_FILE = 'prototype.html'

/**
 * 解析 checkpoint 内的 attemptRoot 为绝对路径。
 * 新结构：绝对路径（createAttemptRoot 返回，位于运行时根下）或相对运行时根
 * （other/runtime/items/...）；旧结构兼容：旧批次绝对路径 <batchRoot>/items/...
 * 或相对 batchRoot 的 items/<id>/attempts/<000N>（迁移前批次）。
 * 旧绝对路径在磁盘不存在时，若运行时根下的对应目录存在（迁移已归位）则回退
 * 使用迁移后的位置，保证旧批次 resume/retry/发布可定位 attempt。
 */
function resolveAttemptDir(batchRoot, attemptRoot) {
  if (path.isAbsolute(attemptRoot)) {
    const resolved = path.resolve(attemptRoot)
    if (fs.existsSync(resolved)) return resolved
    // 旧结构迁移回退：<batchRoot>/items/... → <batchRoot>/other/runtime/items/...
    const runtimeRoot = runtimeRootFor(batchRoot)
    const relativeToRoot = path.relative(batchRoot, resolved)
    if (relativeToRoot && !relativeToRoot.startsWith('..') && !path.isAbsolute(relativeToRoot)) {
      const migrated = path.resolve(runtimeRoot, relativeToRoot)
      if (fs.existsSync(migrated)) return migrated
    }
    return resolved
  }
  const runtimeRoot = runtimeRootFor(batchRoot)
  const asRuntime = path.resolve(runtimeRoot, ...attemptRoot.split(/[\\/]+/))
  if (fs.existsSync(asRuntime)) return asRuntime
  const asLegacy = path.resolve(batchRoot, ...attemptRoot.split(/[\\/]+/))
  if (fs.existsSync(asLegacy)) return asLegacy
  return asRuntime
}

/** 旧结构运行时文件名/目录名（batchRoot 顶层 → 运行时根迁移对象）。 */
const LEGACY_RUNTIME_ENTRIES = [
  'request.json',
  'result.json',
  'checkpoint.json',
  'checkpoint.next.json',
  'checkpoint.previous.json',
  'checkpoint.recovery.json',
  'items',
]

/** 递归收集目录内全部文件（绝对路径，稳定排序）。 */
function listFilesUnder(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFilesUnder(full))
    else if (entry.isFile()) out.push(full)
  }
  return out.sort()
}

/** 两个文件字节等价（同长 + 逐字节比较，避免大文件全量读入）。 */
function filesEqual(a, b) {
  const sa = fs.statSync(a)
  const sb = fs.statSync(b)
  if (!sa.isFile() || !sb.isFile() || sa.size !== sb.size) return false
  const fa = fs.openSync(a, 'r')
  const fb = fs.openSync(b, 'r')
  try {
    const bufferA = Buffer.alloc(64 * 1024)
    const bufferB = Buffer.alloc(64 * 1024)
    for (;;) {
      const na = fs.readSync(fa, bufferA, 0, bufferA.length, null)
      const nb = fs.readSync(fb, bufferB, 0, bufferB.length, null)
      if (na !== nb) return false
      if (na === 0) return true
      if (!bufferA.subarray(0, na).equals(bufferB.subarray(0, nb))) return false
    }
  } finally {
    fs.closeSync(fa)
    fs.closeSync(fb)
  }
}

/** 两个目录等价：相对路径集合一致且逐文件字节等价（不比较 mtime）。 */
function directoriesEqual(a, b) {
  const rel = (dir) => listFilesUnder(dir).map((file) => path.relative(dir, file))
  const filesA = rel(a)
  const filesB = rel(b)
  if (filesA.length !== filesB.length) return false
  if (filesA.some((f, i) => f !== filesB[i])) return false
  return filesA.every((f) => filesEqual(path.join(a, f), path.join(b, f)))
}

/** 旧顶层对象与运行时根同名对象是否内容等价（文件或目录）。 */
function legacyEntryEquivalent(source, target) {
  const sourceStat = fs.statSync(source)
  const targetStat = fs.statSync(target)
  if (sourceStat.isDirectory() !== targetStat.isDirectory()) return false
  return sourceStat.isDirectory() ? directoriesEqual(source, target) : filesEqual(source, target)
}

/**
 * 旧结构迁移：resume/retry-failed 在 batchRoot 顶层发现旧运行时文件时，
 * 将其整体移动到运行时根（<batchRoot>/other/runtime/），随后按新结构读取。
 *
 * 同名冲突策略（不覆盖、不猜测）：
 *  - 目标不存在：直接移动（旧位置归位，顶层合同恢复）；
 *  - 目标存在且两者内容等价（文件字节等价 / 目录递归等价）：移除旧顶层副本，
 *    保留运行时根对象——顶层不残留同名对象；
 *  - 目标存在且内容不等价：抛稳定错误 BATCH_LEGACY_RUNTIME_CONFLICT（两侧
 *    对象都原样保留），由使用者消除歧义后重试；绝不静默选择任何一侧。
 */
function migrateLegacyRuntimeFiles(batchRoot, runtimeRoot) {
  const moved = []
  for (const name of LEGACY_RUNTIME_ENTRIES) {
    const source = path.join(batchRoot, name)
    if (!fs.existsSync(source)) continue
    const target = path.join(runtimeRoot, name)
    if (fs.existsSync(target)) {
      if (!legacyEntryEquivalent(source, target)) {
        throw new BatchRunnerError(
          'BATCH_LEGACY_RUNTIME_CONFLICT',
          `旧结构迁移冲突：顶层与 other/runtime 的 ${name} 内容不一致，拒绝覆盖。请人工核对并删除其一后重试`
            + `（顶层：${source}；运行时根：${target}）`,
        )
      }
      // 等价：移除旧顶层副本，保留运行时根对象。
      fs.rmSync(source, { recursive: true, force: true })
      continue
    }
    fs.mkdirSync(runtimeRoot, { recursive: true })
    fs.renameSync(source, target)
    moved.push(name)
  }
  return moved
}

/**
 * 旧批次 checkpoint 的 attemptRoot 路径重映射（纯函数，不修改输入）。
 *
 * migrateLegacyRuntimeFiles 把顶层 items/ 物理移入运行时根后，旧 checkpoint 内
 * 指向 <batchRoot>/items/... 的绝对 attemptRoot（旧 run 直接落盘 createAttemptRoot
 * 返回值）在磁盘上已不存在，发布层会按 attempt 目录缺失抛错。本函数把这些
 * 指向旧 batchRoot 之下、且迁移后运行时根对应目录存在的路径改写为运行时根
 * 位置；resultPath 历史上只写相对路径，若出现旧绝对形态同样重映射。
 * 仅当目标目录/文件真实存在时才重写（不猜测、不伪造路径）。
 */
function remapLegacyAttemptRoots(batchRoot, runtimeRoot, state) {
  const remap = (value) => {
    if (typeof value !== 'string' || !path.isAbsolute(value)) return value
    const resolved = path.resolve(value)
    if (fs.existsSync(resolved)) return value
    const relativeToRoot = path.relative(batchRoot, resolved)
    if (!relativeToRoot || relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) return value
    const migrated = path.resolve(runtimeRoot, relativeToRoot)
    return fs.existsSync(migrated) ? migrated : value
  }
  let changed = false
  const items = (state.items || []).map((item) => {
    const attemptRoot = remap(item.attemptRoot)
    const resultPath = remap(item.resultPath)
    if (attemptRoot !== item.attemptRoot || resultPath !== item.resultPath) changed = true
    return { ...item, attemptRoot, resultPath }
  })
  return changed ? { ...state, items } : state
}

// runDesign 页面执行步骤名（本包 runtime/runner.mjs 协议）：这些步骤失败说明
// 页面组装/回填/校验失败，此时遗留的 prototype.html 不可作为可审阅交付。
const PAGE_STEP_NAMES = new Set(['page-design', 'page-design-refill'])

/**
 * 判断 failed attempt 是否为「素材失败但页面已完成并带诊断占位」的可审阅交付。
 *
 * 判定证据（三份 attempt 内磁盘产物 + 编排结果，全部持久、resume 可重建，
 * 不依赖 checkpoint 新增字段）：
 *  1. validation-report.json 且 passed===true——页面通过受控组装与校验
 *     （诊断占位原型本身满足校验；组装/校验/打包失败时不会有完整通过的报告）；
 *  2. asset-manifest.json 的 pendingAssetRequests.length>=1（旧产物），或
 *     visual-review.json 的 assets section 含 failed 素材（新产物）——存在
 *     素材失败的诊断占位状态签名；
 *  3. 编排结果 status==='failed' 且 steps 无 page-design/page-design-refill
 *     失败——failure 源自素材生成，而非页面本身；runItem 中断/抛错的 attempt
 *     不具备完整证据链，不判可审阅。
 * 仅凭 prototype.html 存在不足以判定：页面组装/校验/打包失败可能遗留残缺原型。
 */
function isReviewableDiagnosticFailure(attemptRoot, orchestration) {
  if (!attemptRoot) return false
  if (!fs.existsSync(path.join(attemptRoot, PROTOTYPE_FILE))) return false
  // 证据 1：页面受控校验通过。
  const reportPath = path.join(attemptRoot, 'validation-report.json')
  if (!fs.existsSync(reportPath)) return false
  let report = null
  try {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
  } catch {
    return false
  }
  if (report?.passed !== true) return false
  // 证据 2：旧 manifest 的待回填槽位，或新 visual review 的失败素材。
  const manifestPath = path.join(attemptRoot, 'asset-manifest.json')
  let hasPendingAssets = false
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      hasPendingAssets = Array.isArray(manifest?.pendingAssetRequests) && manifest.pendingAssetRequests.length > 0
    } catch {
      // 新产物可仅以 visual-review.json 表达失败素材。
    }
  }
  const reviewPath = path.join(attemptRoot, 'visual-review.json')
  let hasFailedReviewedAsset = false
  if (fs.existsSync(reviewPath)) {
    try {
      const review = JSON.parse(fs.readFileSync(reviewPath, 'utf8'))
      const assetSection = review?.sections?.find((section) => section?.name === 'assets')
      const assets = Array.isArray(assetSection?.items) ? assetSection.items : assetSection?.entries
      hasFailedReviewedAsset = Array.isArray(assets) && assets.some((asset) => asset?.status === 'failed' || asset?.rules === 'failed')
    } catch {
      // 保留旧 manifest 证据，不因可选 review 文件损坏而放宽其他条件。
    }
  }
  if (!hasPendingAssets && !hasFailedReviewedAsset) return false
  // 证据 3：编排结果为正常返回的 failed，且页面步骤无失败（素材级失败）。
  if (!orchestration || orchestration.status !== 'failed') return false
  const steps = Array.isArray(orchestration.steps) ? orchestration.steps : []
  if (steps.some((step) => PAGE_STEP_NAMES.has(step?.name) && step?.status === 'failed')) return false
  return true
}

/**
 * 收集原型 HTML 内本地引用（src/href 属性），用于发布完整离线预览目录。
 * 返回 [{ ref, absolute }]：
 *  - absolute=true：绝对路径（Windows 盘符 / POSIX 根）——发布层必须拒绝，
 *    注意在 scheme 判定之前识别，避免 `C:\…` 被当作 `C:` 协议跳过；
 *  - absolute=false：其余引用；远程/内联（http:、data: 等 scheme、//）与
 *    锚点（#）在收集层跳过（设计态允许，无需复制）。
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

/** 收集样式表 url(...) 中的本地依赖，判定规则与 HTML 本地引用一致。 */
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
 * 把单个可预览原型发布为完整的离线预览目录：
 *   <targetDir>/prototype.html + 原型引用的全部本地依赖（styles/、assets/ 等）。
 * 依赖从源 attempt 目录按原型及其样式表声明的相对路径复制；CSS url(...)
 * 依赖递归加入发布集合，确保页面背景等只在样式表出现的素材仍可离线解析。
 * 路径安全：绝对路径或越出源 attempt 目录的引用、缺失依赖均按批次错误抛出
 * （fail fast）：半成品预览目录会让首页链接指向解析不了的引用。
 */
function publishPrototypeDirectory(sourcePrototype, targetDir) {
  const attemptDir = path.dirname(path.resolve(sourcePrototype))
  const html = fs.readFileSync(sourcePrototype, 'utf8')
  // 先完整校验全部引用，再统一落盘：失败时不产生半成品预览目录。
  const files = new Map([[PROTOTYPE_FILE, path.resolve(sourcePrototype)]])
  const pending = prototypeLocalRefs(html).map((entry) => ({ ...entry, baseDir: attemptDir }))
  while (pending.length) {
    const { ref, absolute, baseDir } = pending.shift()
    if (absolute) {
      throw new BatchRunnerError('BATCH_PREVIEW_INVALID', `预览引用必须为相对路径：${ref}`)
    }
    const source = path.resolve(baseDir, ref)
    if (!source.startsWith(attemptDir + path.sep)) {
      throw new BatchRunnerError('BATCH_PREVIEW_INVALID', `预览引用越界（必须位于 attempt 目录内）：${ref}`)
    }
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
      throw new BatchRunnerError('BATCH_PREVIEW_INCOMPLETE', `原型引用的本地依赖缺失，无法发布完整离线预览：${ref}`)
    }
    const relative = path.relative(attemptDir, source)
    if (files.has(relative)) continue
    files.set(relative, source)
    if (path.extname(source).toLowerCase() === '.css') {
      pending.push(...stylesheetLocalRefs(fs.readFileSync(source, 'utf8'))
        .map((entry) => ({ ...entry, baseDir: path.dirname(source) })))
    }
  }
  fs.mkdirSync(targetDir, { recursive: true })
  for (const [relative, source] of files) {
    const target = path.join(targetDir, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(source, target)
  }
}

/**
 * 把可关联落地页的原型发布为首页交付目录内的实际文件。
 * home CLI 的预览链接按 <landingKey>/prototype.html（相对首页交付目录）解析，
 * 编排器负责把批次内对应落地页 attempt 的原型发布为完整离线预览目录：
 *   <homeAttemptRoot>/<landingKey>/{prototype.html, styles/, assets/, ...}
 * 只复制 prototype.html 会让预览丢失 CSS/图片依赖，必须按原型引用发布完整目录。
 * 落盘失败按批次错误抛出（fail fast）：首页可能拿到解析不了的引用。
 */
function publishLandingPrototypes(batchRoot, homeAttemptRoot, plan, landingOutcomes) {
  for (const entry of plan.entries) {
    const step = plan.order.find((s) => s.landingKey === entry.landingKey)
    const outcome = step ? landingOutcomes.get(step.itemId) : null
    if (!outcome || typeof outcome.previewPath !== 'string' || !outcome.previewPath) continue
    const source = path.join(batchRoot, ...outcome.previewPath.split('/'))
    if (!fs.existsSync(source)) continue
    publishPrototypeDirectory(source, path.join(homeAttemptRoot, entry.landingKey))
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONTRACTS_ROOT = path.resolve(__dirname, '..', '..', 'design-skill-contracts')
const BATCH_RESULT_SCHEMA_ID = 'http://schemas.design-agent.local/design-skill/v1/batch-design-result.schema.json'
const REQUEST_FILE = 'request.json'
const RESULT_FILE = 'result.json'

/** 批次执行错误基类。 */
export class BatchRunnerError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

let resultRegistry = null
let resultSchema = null

function loadResultSchema() {
  if (resultSchema) return { resultRegistry, resultSchema }
  const schemasDir = path.join(CONTRACTS_ROOT, 'schemas')
  resultRegistry = Registry.fromDirectory(schemasDir)
  resultSchema = resultRegistry.byId.get(BATCH_RESULT_SCHEMA_ID)?.schema
  if (!resultSchema) throw new BatchRunnerError('BATCH_RESULT_INVALID', 'batch-design-result schema 未加载')
  return { resultRegistry, resultSchema }
}

/** 校验最终 BatchResult，非法抛 BatchRunnerError。 */
function validateBatchResult(result) {
  const { resultRegistry: reg, resultSchema: sch } = loadResultSchema()
  const errors = validate(result, sch, reg, sch.$id)
  if (errors.length > 0) {
    throw new BatchRunnerError('BATCH_RESULT_INVALID', `BatchResult 校验失败：${errors.join('；')}`)
  }
  return result
}

/** 结构化异常为 checkpoint/BatchResult 的 error 对象。 */
function toError(error) {
  return {
    code: error?.code || 'BATCH_ITEM_ERROR',
    message: error?.message || String(error),
    retryable: error?.retryable === true,
    outcomeUnknown: error?.outcomeUnknown === true,
  }
}

/**
 * 执行批次。
 * @param {object} opts
 * @param {'run'|'resume'|'retry-failed'} opts.mode
 * @param {object} [opts.batchRequest] run 模式必传；resume/retry 缺省从 batchRoot/request.json 加载
 * @param {string} opts.batchRoot 批次根目录
 * @param {string} opts.sourceCommit
 * @param {object} opts.providerIdentity { id, model, baseURL }
 * @param {Function} opts.runItem async ({ item, attemptRoot, assetStore, itemFingerprint, checkpoint, linkage }) => OrchestrationResult
 * @param {Function} [opts.now] 可注入时间函数
 * @returns {object} 校验通过的 BatchResult
 */
export async function runBatch({ mode, batchRequest, batchRoot, sourceCommit, providerIdentity, runItem, now }) {
  if (!['run', 'resume', 'retry-failed'].includes(mode)) {
    throw new BatchRunnerError('BATCH_MODE_INVALID', `非法 mode：${mode}`)
  }
  if (typeof runItem !== 'function') throw new BatchRunnerError('BATCH_RUN_ITEM_INVALID', 'runItem 必须是函数')
  const root = path.resolve(batchRoot)
  const nowFn = now || (() => new Date())

  // ---- 加载批次请求 ----
  // 运行时状态物理位于 <batchRoot>/other/runtime/；resume/retry 从该位置加载
  // request.json。旧结构（运行时文件在 batchRoot 顶层）在 resume/retry-failed
  // 时先迁移到运行时根后再读取，保证向后兼容。
  // 注意：迁移发生在 request 读取之前——旧根的 request.json 先搬入运行时根，
  // loadBatchRequest 再从新位置读取；旧位置残留文件在无同名目标时才会移动。
  let request
  if (mode === 'run') {
    if (!batchRequest) throw new BatchRunnerError('BATCH_REQUEST_MISSING', 'run 模式必须提供 batchRequest')
    request = loadBatchRequest(batchRequest)
  } else {
    migrateLegacyRuntimeFiles(root, runtimeRootFor(root))
    request = loadBatchRequest(path.join(runtimeRootFor(root), REQUEST_FILE))
  }

  // ---- 页面联动计划（无 pageLinkage 时为 null，走存量批次路径）----
  // run/resume/retry-failed 均从请求的 pageLinkage 确定性派生，保证恢复兼容。
  const linkagePlan = derivePlanFromRequest(request)

  // ---- 状态管理 ----
  // 全部运行时状态（checkpoint/request/result/items）位于 <batchRoot>/other/runtime/。
  const runtimeRoot = runtimeRootFor(root)
  let state = null
  const getState = () => state
  const setState = (next) => { state = next }
  const persist = async (next) => {
    setState(next)
    await writeCheckpointAtomic(runtimeRoot, next)
  }

  // ---- 执行顺序：联动批次按 plan.order（landing 优先、按 key 稳定），存量批次保持请求顺序 ----
  const linkageOrder = linkagePlan ? linkagePlan.order.map((step) => step.itemId) : null
  const byId = new Map(request.items.map((item) => [item.itemId, item]))

  // ---- run 模式：初始化 ----
  if (mode === 'run') {
    // 新 run 只允许创建四层顶层（index.html/assets/configs/other）：
    // batchRoot 顶层已存在任何运行时状态或发布区产物 → 拒绝覆盖。
    if (fs.existsSync(root) && fs.readdirSync(root).length > 0) {
      throw new BatchRunnerError('BATCH_OUTPUT_EXISTS', `批次根目录已存在输出：${root}`)
    }
    fs.mkdirSync(runtimeRoot, { recursive: true })
    fs.writeFileSync(path.join(runtimeRoot, REQUEST_FILE), JSON.stringify(request, null, 2), 'utf8')
    const initial = createCheckpoint({
      batchRequest: request,
      sourceCommit,
      providerIdentity,
      now: nowFn,
    })
    initial.items = (linkageOrder || request.items.map((item) => item.itemId)).map((itemId) => ({
      itemId,
      status: 'pending',
      attempt: 0,
      attemptRoot: null,
      assets: [],
      resultPath: null,
      error: null,
    }))
    await persist(initial)
  } else {
    // ---- resume / retry-failed：加载并校验（候选恢复） ----
    // 旧结构迁移已在请求加载前完成（request.json/checkpoint*/items/ 均已归位）。
    if (!hasAnyCheckpointFile(runtimeRoot)) {
      throw new BatchRunnerError('BATCH_CHECKPOINT_MISSING', '批次根目录缺少 checkpoint（current/next/previous 均不存在）')
    }
    const provider = sanitizeProviderIdentity(providerIdentity)
    // 候选损坏/不兼容时保留 CHECKPOINT_INVALID / CHECKPOINT_INCOMPATIBLE，不映射为 missing。
    const recovered = loadCheckpointCandidates(runtimeRoot, {
      batchId: request.batchId,
      fingerprint: fingerprint(request),
      sourceCommit,
      provider,
    })
    const loaded = recovered.state
    // 旧结构迁移后路径归位：checkpoint 内指向旧顶层 items/... 的绝对 attemptRoot
    // 改写为运行时根位置（迁移已把 items/ 物理移动），并随归一化状态一并持久化。
    const remapped = remapLegacyAttemptRoots(root, runtimeRoot, loaded)
    // 若从 next/previous 恢复，安全提升为当前 checkpoint，保留有效 previous。
    if (recovered.source !== 'checkpoint') {
      await promoteRecoveredCheckpoint(runtimeRoot, remapped, { source: recovered.source })
    }
    // 归一化 running→interrupted 并立即持久化，供后续选择与外部读取。
    state = normalizeInterrupted(remapped)
    await persist(touchCheckpoint(state, nowFn))

    if (mode === 'retry-failed') {
      const nonTerminal = state.items.filter((i) => ['pending', 'running', 'interrupted'].includes(i.status))
      if (nonTerminal.length > 0) {
        throw new BatchRunnerError('BATCH_RETRY_REQUIRES_RESUME', `存在未完成 item（${nonTerminal.map((i) => i.itemId).join(', ')}），请先 resume`)
      }
    }
  }

  // ---- 选择要执行的 item（联动批次按 linkage 顺序遍历，存量批次按 checkpoint 顺序）----
  const selectable = (itemState) => {
    if (mode === 'run' || mode === 'resume') {
      return itemState.status === 'pending' || itemState.status === 'interrupted'
    }
    if (mode === 'retry-failed') {
      return itemState.status === 'failed'
    }
    return false
  }
  const toRun = linkageOrder
    ? linkageOrder.map((itemId) => state.items.find((i) => i.itemId === itemId)).filter((i) => i && selectable(i))
    : state.items.filter(selectable)

  // ---- 逐 item 执行 ----
  // landingOutcomes：itemId -> 落地页执行结果（供首页构建关联预览）。
  // 可关联范围：成功落地页，或 required 素材失败但已产出可审阅原型（reviewable）
  // 的落地页——与能力基线「失败落地页显示诊断占位、其他页面继续」一致。
  // previewPath 是相对批次根、指向 attempt 内 prototype.html 的 POSIX 路径；
  // 注入首页上下文时会按 home CLI 接口换算为 <landingKey>/prototype.html。
  const landingOutcomes = new Map()
  const linkageWarnings = []
  /**
   * 可关联判定（与 run/resume 统一）：
   *  - succeeded：直接可关联（prototype.html 存在才记录）；
   *  - failed：必须通过 isReviewableDiagnosticFailure（素材失败但页面已完成
   *    并带诊断占位）；runItem 抛错（无编排结果）或页面步骤失败的遗留原型
   *    不可关联。
   */
  const attemptDirFor = (itemState) => resolveAttemptDir(root, itemState.attemptRoot)
  const recordLandingOutcome = (itemId, landingContext, attemptRoot, itemStatus, orchestration) => {
    if (itemStatus === 'succeeded') {
      if (!fs.existsSync(path.join(attemptRoot, PROTOTYPE_FILE))) return
      landingOutcomes.set(itemId, {
        status: 'succeeded',
        landingKey: landingContext.landingKey,
        previewPath: previewRefFor(root, attemptRoot),
      })
      return
    }
    if (itemStatus !== 'failed') return
    if (!isReviewableDiagnosticFailure(attemptRoot, orchestration)) return
    landingOutcomes.set(itemId, {
      status: 'failed',
      reviewable: true,
      landingKey: landingContext.landingKey,
      previewPath: previewRefFor(root, attemptRoot),
    })
  }
  // resume/retry-failed：从 checkpoint 终态重建可关联 landing 的 outcome。
  // 编排结果从磁盘 result.json 读回（run 时已落盘完整 orchestration 或失败摘要），
  // 证据链与 run 模式一致、resume 确定性可重建，不依赖 checkpoint 摘要字段。
  if (linkagePlan && mode !== 'run') {
    for (const itemId of linkagePlan.landingItemIds) {
      const itemState = state.items.find((i) => i.itemId === itemId)
      if (!itemState || !['succeeded', 'failed'].includes(itemState.status) || !itemState.attemptRoot || toRun.some((s) => s.itemId === itemId)) continue
      const context = landingContextFor(linkagePlan, itemId)
      if (!context) continue
      // runItem 抛错中断时 attempt 的 result.json 只含失败摘要（无 steps），
      // isReviewableDiagnosticFailure 据此判不可关联，语义与 run 模式一致。
      let orchestration = null
      if (itemState.resultPath && fs.existsSync(path.join(runtimeRoot, ...itemState.resultPath.split('/')))) {
        try {
          orchestration = JSON.parse(fs.readFileSync(path.join(runtimeRoot, ...itemState.resultPath.split('/')), 'utf8'))
        } catch {
          orchestration = null
        }
      }
      recordLandingOutcome(itemId, context, attemptDirFor(itemState), itemState.status, orchestration)
    }
  }
  for (const itemState of toRun) {
    const item = byId.get(itemState.itemId)
    const attempt = nextAttempt(root, itemState.itemId)
    const attemptRoot = createAttemptRoot(root, itemState.itemId, attempt)
    const itemFingerprint = fingerprint(item)

    // 标记 running 并落盘。
    const runningState = {
      ...state,
      items: state.items.map((i) => (i.itemId === itemState.itemId
        ? { ...i, status: 'running', attempt, attemptRoot, resultPath: null, error: null }
        : i)),
    }
    await persist(touchCheckpoint(runningState, nowFn))

    const assetStore = createCheckpointAssetStore({
      checkpointRoot: runtimeRoot,
      getState,
      setState,
      sourceRoot: attemptRoot,
      itemId: itemState.itemId,
      itemFingerprint,
      now: nowFn,
    })

    // 页面联动上下文：landing item 注入 landingKey/theme；home item 注入
    // landingThemes（含成功落地页与可审阅失败落地页的首页相对预览 ref），
    // 并把可关联落地页原型发布到首页交付目录（ref 才可离线解析）。
    let linkageContext = null
    const landingContext = landingContextFor(linkagePlan, itemState.itemId)
    if (landingContext) {
      linkageContext = { role: 'landing', landingKey: landingContext.landingKey, theme: landingContext.theme }
    } else if (linkagePlan && linkagePlan.homeItemIds.includes(itemState.itemId)) {
      publishLandingPrototypes(root, attemptRoot, linkagePlan, landingOutcomes)
      const { landingThemes, warnings } = homeContextFor(linkagePlan, landingOutcomes)
      linkageContext = { role: 'home', homeTheme: linkagePlan.homeTheme, landingThemes }
      linkageWarnings.push(...warnings)
    }

    let orchestration
    let itemError = null
    try {
      orchestration = await runItem({ item, attemptRoot, assetStore, itemFingerprint, checkpoint: getState(), linkage: linkageContext })
    } catch (error) {
      itemError = toError(error)
    }

    // 写 attempt 的 result.json。
    const resultFile = path.join(attemptRoot, RESULT_FILE)
    if (orchestration) {
      fs.writeFileSync(resultFile, JSON.stringify(orchestration, null, 2), 'utf8')
    } else {
      fs.writeFileSync(resultFile, JSON.stringify({ status: 'failed', error: itemError }, null, 2), 'utf8')
    }

    // 映射 item 状态。
    let itemStatus
    let itemFailureFromError = false
    if (itemError) {
      itemStatus = 'failed'
      itemFailureFromError = true
    } else if (orchestration.status === 'succeeded') {
      itemStatus = 'succeeded'
    } else if (orchestration.status === 'unsupported') {
      itemStatus = 'unsupported'
      itemError = { code: 'BATCH_ITEM_UNSUPPORTED', message: 'item 编排返回 unsupported', retryable: false, outcomeUnknown: false }
    } else {
      itemStatus = 'failed'
      itemError = { code: 'BATCH_ITEM_FAILED', message: `item 编排返回 ${orchestration.status}`, retryable: false, outcomeUnknown: false }
    }

    const resultPath = path.relative(runtimeRoot, resultFile)
    // 联动批次：successful landing 或「素材失败但页面完成带诊断占位」的 failed
    // landing 记录相对预览 ref；runItem 抛错（无编排结果）或页面步骤失败时
    // 遗留原型不可关联，item 状态语义不变。
    if (landingContext) {
      // itemFailureFromError=true 表示 runItem 抛错中断（无完整编排结果），
      // 其 attempt 遗留的原型不可信；编排正常返回（含 status=failed）时传完整
      // 结果供证据链判定。
      recordLandingOutcome(itemState.itemId, landingContext, attemptRoot, itemStatus, itemFailureFromError ? null : orchestration)
    }
    const nextState = {
      ...state,
      items: state.items.map((i) => (i.itemId === itemState.itemId
        ? { ...i, status: itemStatus, attempt, attemptRoot, resultPath, error: itemError }
        : i)),
    }
    await persist(touchCheckpoint(nextState, nowFn))
  }

  // ---- 汇总最终 BatchResult ----
  // 任何非 terminal item 都不应被偷偷填默认值；run/resume 正常不会发生。
  const nonTerminal = state.items.filter((i) => ['pending', 'running', 'interrupted'].includes(i.status))
  if (nonTerminal.length > 0) {
    throw new BatchRunnerError('BATCH_STATE_INCOMPLETE', `存在未完成 item：${nonTerminal.map((i) => i.itemId).join(', ')}`)
  }
  const finalItems = state.items.map((i) => {
    const status = i.status === 'succeeded' ? 'succeeded' : 'failed'
    const error = i.status === 'unsupported'
      ? { code: 'BATCH_ITEM_UNSUPPORTED', message: 'item 编排返回 unsupported', retryable: false, outcomeUnknown: false }
      : (i.error || null)
    // terminal item 必须已落盘 attemptRoot/resultPath；succeeded 的 error 必须为 null。
    if (!i.attemptRoot || !i.resultPath) {
      throw new BatchRunnerError('BATCH_STATE_INVALID', `item ${i.itemId} 缺少 attemptRoot/resultPath`)
    }
    if (status === 'succeeded' && error !== null) {
      throw new BatchRunnerError('BATCH_STATE_INVALID', `item ${i.itemId} succeeded 但 error 非 null`)
    }
    return {
      itemId: i.itemId,
      status,
      attempt: i.attempt,
      outputRoot: path.relative(runtimeRoot, i.attemptRoot),
      resultPath: i.resultPath,
      error,
    }
  })
  const succeeded = finalItems.filter((i) => i.status === 'succeeded').length
  const total = finalItems.length
  const batchStatus = succeeded === total ? 'succeeded' : (succeeded > 0 ? 'partially_failed' : 'failed')

  // ---- 联合校验与 warnings（仅联动批次）----
  // 失败落地页不阻断：只产生 warnings，不改变 batchStatus。
  let linkage = null
  if (linkagePlan) {
    const homeItemId = linkagePlan.homeItemIds[0]
    const homeItem = state.items.find((i) => i.itemId === homeItemId)
    const review = jointReview(linkagePlan, landingOutcomes, {
      status: homeItem?.status ?? null,
      linkageResult: { established: [] },
    })
    linkage = {
      homeTheme: linkagePlan.homeTheme,
      landingThemes: homeContextFor(linkagePlan, landingOutcomes).landingThemes,
      warnings: [...linkageWarnings, ...review.warnings],
    }
    if (landingOutcomes.size === 0) {
      linkage.warnings.push('全部落地页均未产生可关联预览，首页按无关联主题执行')
    }
  }

  const result = {
    schemaVersion: '1',
    batchId: request.batchId,
    status: batchStatus,
    summary: { total, succeeded, failed: total - succeeded, skipped: 0 },
    items: finalItems,
  }
  validateBatchResult(result)

  // 写 root/result.json 前，把 checkpoint.status 置为与 BatchResult 同名并持久化。
  // 联动批次同时持久化 linkage 摘要，保证 resume 可重建且终态可审计。
  const finalState = { ...state, status: batchStatus, ...(linkage ? { linkage } : {}) }
  await persist(touchCheckpoint(finalState, nowFn))

  fs.writeFileSync(path.join(runtimeRoot, RESULT_FILE), JSON.stringify(result, null, 2), 'utf8')

  // ---- 终态自动发布：面向使用者的四层交付结构（run/resume/retry-failed 统一）----
  // 只发布成功 item；部分失败批次仍发布已成功页面；发布失败按明确错误抛出，
  // 不能静默报告批次成功但交付入口损坏。attempt 记录保持原样。
  publishBatchDelivery({ batchRoot: root, request, checkpoint: finalState })

  return result
}

export default runBatch

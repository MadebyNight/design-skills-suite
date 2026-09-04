// 3B：批次检查点持久化。
//
// 职责：创建、校验、原子写入与加载批次检查点。
// 边界：本层只负责检查点的持久化与结构校验，不执行业务；provider 只存脱敏身份。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Registry, validate } from '../../design-skill-contracts/scripts/validate.mjs'
import { fingerprint, sanitizeProviderIdentity } from './fingerprint.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const CHECKPOINT_SCHEMA_ID = 'http://schemas.design-agent.local/design-skill/v1/batch-checkpoint.schema.json'
export const CHECKPOINT_FILE = 'checkpoint.json'
export const CHECKPOINT_NEXT_FILE = 'checkpoint.next.json'
export const CHECKPOINT_PREVIOUS_FILE = 'checkpoint.previous.json'
export const CHECKPOINT_RECOVERY_FILE = 'checkpoint.recovery.json'

/** 检查点错误基类。 */
export class CheckpointError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

let registry = null
let schema = null

/** 惰性加载内部 batch-checkpoint schema 到 contracts 最小验证器注册表。 */
function loadSchema() {
  if (schema) return { registry, schema }
  const schemaPath = path.join(__dirname, '..', 'schemas', 'batch-checkpoint.schema.json')
  const raw = JSON.parse(fs.readFileSync(schemaPath, 'utf8'))
  registry = new Registry()
  registry.add(raw, 'batch-checkpoint.schema.json')
  schema = raw
  return { registry, schema }
}

/**
 * 校验检查点结构。非法时抛 CheckpointError（code=CHECKPOINT_INVALID）。
 * @param {unknown} state
 * @returns {true}
 */
export function validateCheckpoint(state) {
  const { registry: reg, schema: sch } = loadSchema()
  const errors = validate(state, sch, reg, sch.$id)
  if (errors.length > 0) {
    throw new CheckpointError('CHECKPOINT_INVALID', `检查点结构非法：${errors.join('；')}`)
  }
  return true
}

/**
 * 断言检查点与当前批次兼容。不兼容时抛 CheckpointError（code=CHECKPOINT_INCOMPATIBLE）。
 * 直接比较 state.requestFingerprint 与传入 fp，并额外验证 state.batchRequest 的指纹
 * 等于 state.requestFingerprint，避免 state 内部被篡改。
 * @param {object} state 已加载的检查点
 * @param {object} current { batchId, fingerprint, sourceCommit, provider }
 */
export function assertCompatible(state, { batchId, fingerprint: fp, sourceCommit, provider }) {
  if (state.batchId !== batchId) {
    throw new CheckpointError('CHECKPOINT_INCOMPATIBLE', `batchId 不匹配（期望 ${batchId}，实际 ${state.batchId}）`)
  }
  if (typeof fp !== 'string' || fp.length === 0) {
    throw new CheckpointError('CHECKPOINT_INCOMPATIBLE', 'current fingerprint 必须是非空字符串')
  }
  if (state.requestFingerprint !== fp) {
    throw new CheckpointError('CHECKPOINT_INCOMPATIBLE', 'requestFingerprint 不匹配')
  }
  // 防内部篡改：state.batchRequest 的指纹必须等于 state.requestFingerprint。
  if (state.batchRequest && fingerprint(state.batchRequest) !== state.requestFingerprint) {
    throw new CheckpointError('CHECKPOINT_INCOMPATIBLE', 'state.batchRequest 与 requestFingerprint 不一致')
  }
  if (state.sourceCommit !== sourceCommit) {
    throw new CheckpointError('CHECKPOINT_INCOMPATIBLE', `sourceCommit 不匹配（期望 ${sourceCommit}，实际 ${state.sourceCommit}）`)
  }
  if (state.provider.id !== provider.id || state.provider.model !== provider.model || state.provider.baseUrlFingerprint !== provider.baseUrlFingerprint) {
    throw new CheckpointError('CHECKPOINT_INCOMPATIBLE', 'provider 身份不匹配')
  }
  return true
}

/**
 * 创建初始检查点状态（不落盘）。
 * batchId 必须来自 batchRequest.batchId，缺失时抛 CHECKPOINT_INVALID。
 * @param {object} opts { batchRequest, sourceCommit, providerIdentity, now? }
 * @param {Function} [opts.now] 可注入时间函数，缺省 new Date()。
 * @returns {object} 校验通过的检查点状态
 */
export function createCheckpoint({ batchRequest, sourceCommit, providerIdentity, now }) {
  if (batchRequest === null || typeof batchRequest !== 'object' || Array.isArray(batchRequest)) {
    throw new CheckpointError('CHECKPOINT_INVALID', 'batchRequest 必须是对象')
  }
  if (typeof batchRequest.batchId !== 'string' || batchRequest.batchId.length === 0) {
    throw new CheckpointError('CHECKPOINT_INVALID', 'batchRequest.batchId 必须是非空字符串')
  }
  if (typeof sourceCommit !== 'string' || sourceCommit.length === 0) {
    throw new CheckpointError('CHECKPOINT_INVALID', 'sourceCommit 必须是非空字符串')
  }
  const provider = sanitizeProviderIdentity(providerIdentity)
  const timestamp = (now ? now() : new Date()).toISOString()
  const state = {
    schemaVersion: '1.0.0',
    batchId: batchRequest.batchId,
    batchRequest,
    requestFingerprint: fingerprint(batchRequest),
    sourceCommit,
    provider,
    status: 'running',
    createdAt: timestamp,
    updatedAt: timestamp,
    items: [],
  }
  validateCheckpoint(state)
  return state
}

/**
 * 纯函数：返回更新了 updatedAt 的新检查点状态，不修改输入。
 * 供 runner 在写入前调用，writeCheckpointAtomic 只写传入状态。
 * @param {object} state
 * @param {Function} [now] 可注入时间函数，缺省 new Date()。
 * @returns {object} 新状态
 */
export function touchCheckpoint(state, now) {
  const timestamp = (now ? now() : new Date()).toISOString()
  const next = { ...state, updatedAt: timestamp }
  validateCheckpoint(next)
  return next
}

/**
 * 将 running 状态的 item 与 asset 归一化为 interrupted（崩溃恢复语义）。
 * 返回新状态，不修改输入。
 * @param {object} state
 * @returns {object}
 */
export function normalizeInterrupted(state) {
  const items = (state.items || []).map((item) => {
    const next = { ...item }
    if (item.status === 'running') next.status = 'interrupted'
    if (Array.isArray(item.assets)) {
      next.assets = item.assets.map((asset) => {
        if (asset.status === 'running') return { ...asset, status: 'interrupted' }
        return asset
      })
    }
    return next
  })
  const next = { ...state, items }
  validateCheckpoint(next)
  return next
}

/**
 * 原子写入检查点：先写 checkpoint.next.json（fsync + close），再 rename 为 checkpoint.json。
 * 若已存在 checkpoint.json 且未跳过备份，先将其复制/重命名为 checkpoint.previous.json（Windows 兼容）。
 * @param {string} root 批次根目录
 * @param {object} state 校验通过的检查点状态
 * @param {object} [opts] { skipBackup } skipBackup=true 时跳过备份，避免把损坏 current 覆盖到 previous
 * @returns {Promise<string>} 写入的 checkpoint.json 绝对路径
 */
export async function writeCheckpointAtomic(root, state, { skipBackup = false } = {}) {
  validateCheckpoint(state)
  const dir = path.resolve(root)
  fs.mkdirSync(dir, { recursive: true })
  const target = path.join(dir, CHECKPOINT_FILE)
  const next = path.join(dir, CHECKPOINT_NEXT_FILE)
  const previous = path.join(dir, CHECKPOINT_PREVIOUS_FILE)

  // 已有 checkpoint：先复制为 previous（Windows 下 rename 覆盖已存在文件可能失败，故先删再 rename）。
  if (!skipBackup && fs.existsSync(target)) {
    if (fs.existsSync(previous)) fs.rmSync(previous, { force: true })
    fs.copyFileSync(target, previous)
  }

  const fd = fs.openSync(next, 'w')
  try {
    fs.writeFileSync(fd, JSON.stringify(state, null, 2), 'utf8')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  // Windows 下 rename 覆盖已存在目标可能抛 EEXIST/EPERM，先删除目标再 rename。
  if (fs.existsSync(target)) fs.rmSync(target, { force: true })
  fs.renameSync(next, target)
  return target
}

/**
 * 加载检查点。文件不存在返回 null；存在则解析并校验，非法抛 CheckpointError。
 * 注意：本函数只读 current 文件，不做候选恢复；恢复入口是 loadCheckpointCandidates。
 * @param {string} root 批次根目录
 * @returns {object|null} 检查点状态
 */
export function loadCheckpoint(root) {
  const dir = path.resolve(root)
  if (!checkpointRootExists(dir)) return null
  const target = path.join(dir, CHECKPOINT_FILE)
  if (!checkpointPathExists(target)) return null
  return readAndValidate(target)
}

/** 校验 checkpoint root：不存在返回 false，存在但非目录或 stat 失败则保留为 I/O 错误。 */
function checkpointRootExists(dir) {
  try {
    const stat = fs.statSync(dir)
    if (!stat.isDirectory()) throw new Error(`checkpoint root 不是目录：${dir}`)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw new CheckpointError('CHECKPOINT_IO', `检查 checkpoint root 失败：${error.message}`)
  }
}

/** 仅将明确 ENOENT 视为不存在；stat 的其他 I/O 错误必须保留。 */
function checkpointPathExists(file) {
  try {
    fs.statSync(file)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw new CheckpointError('CHECKPOINT_IO', `检查检查点路径失败：${error.message}`)
  }
}

/** 读取单个候选文件并做 JSON + Schema 校验；物理损坏/结构非法抛 CheckpointError。 */
function readAndValidate(file) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    throw new CheckpointError('CHECKPOINT_IO', `读取检查点失败：${error.message}`)
  }
  let state
  try {
    state = JSON.parse(raw)
  } catch (error) {
    throw new CheckpointError('CHECKPOINT_INVALID', `检查点 JSON 解析失败：${error.message}`)
  }
  validateCheckpoint(state)
  return state
}

/** 判断 root 下是否存在任一 checkpoint 候选文件（current/next/previous）。 */
export function hasAnyCheckpointFile(root) {
  const dir = path.resolve(root)
  if (!checkpointRootExists(dir)) return false
  for (const file of [CHECKPOINT_FILE, CHECKPOINT_NEXT_FILE, CHECKPOINT_PREVIOUS_FILE]) {
    if (checkpointPathExists(path.join(dir, file))) return true
  }
  return false
}

/**
 * 加载检查点候选并按精确规则选择：
 *
 * writeCheckpointAtomic 在 next fsync 后、替换 current 前崩溃时，current 与 next 都合法兼容，
 * 但 next 进度更新 → 必须优先 next，否则丢进度。规则：
 *   1. current 结构合法 → 先 assertCompatible；不兼容立即 CHECKPOINT_INCOMPATIBLE，绝不看 next/previous；
 *   2. current 合法兼容后检查 next：next 结构合法且兼容 → 选 next；
 *      next 损坏或不兼容 → 选 current（stale next 不阻断）；
 *   3. current 缺失/结构损坏 → 按 next → previous 选第一个结构合法且兼容的候选；
 *      候选不兼容可继续下一个，最终无可用候选抛 CHECKPOINT_INVALID；
 *   4. previous 只在 current 损坏/缺失且 next 不可用时使用；
 *   5. 所有候选文件缺失时抛 CHECKPOINT_INVALID（message 注明无候选文件）。
 *
 * @param {string} root 批次根目录
 * @param {object} current { batchId, fingerprint, sourceCommit, provider }
 * @returns {{ state: object, source: string }}
 */
export function loadCheckpointCandidates(root, current) {
  const dir = path.resolve(root)
  if (!checkpointRootExists(dir)) {
    throw new CheckpointError('CHECKPOINT_INVALID', '无检查点候选文件（checkpoint root 不存在）')
  }
  const files = {
    checkpoint: path.join(dir, CHECKPOINT_FILE),
    'checkpoint.next': path.join(dir, CHECKPOINT_NEXT_FILE),
    'checkpoint.previous': path.join(dir, CHECKPOINT_PREVIOUS_FILE),
  }
  /** 结构读取；JSON/Schema 损坏返回 null，真实 I/O 错误必须保留并停止恢复。 */
  const load = (source) => {
    if (!checkpointPathExists(files[source])) return null
    try {
      return readAndValidate(files[source])
    } catch (error) {
      if (error?.code === 'CHECKPOINT_IO') throw error
      return null
    }
  }
  /** 结构合法且兼容；否则返回错误对象。 */
  const pick = (state) => {
    try {
      assertCompatible(state, current)
      return null
    } catch (error) {
      return error
    }
  }

  const cur = load('checkpoint')
  if (cur !== null) {
    // 规则 1：current 结构合法 → 不兼容立即失败，绝不回退。
    const err = pick(cur)
    if (err) {
      throw new CheckpointError('CHECKPOINT_INCOMPATIBLE', `当前 checkpoint 与批次不兼容：${err.message}`)
    }
    // 规则 2：next 合法且兼容 → 用 next（进度更新）；损坏或不兼容 → 用 current。
    const nxt = load('checkpoint.next')
    if (nxt !== null && pick(nxt) === null) {
      return { state: nxt, source: 'checkpoint.next' }
    }
    return { state: cur, source: 'checkpoint' }
  }

  // 规则 3：current 缺失/结构损坏 → next → previous，跳过不兼容候选，无可用候选抛错。
  const errors = []
  for (const source of ['checkpoint.next', 'checkpoint.previous']) {
    const state = load(source)
    if (state === null) continue
    const err = pick(state)
    if (err === null) return { state, source }
    errors.push(`${source}: ${err.message}`)
  }
  if (errors.length === 0) {
    throw new CheckpointError('CHECKPOINT_INVALID', '无检查点候选文件（checkpoint/next/previous 均不存在）')
  }
  throw new CheckpointError('CHECKPOINT_INVALID', `无可用检查点候选：${errors.join('；')}`)
}

/**
 * 把从 next/previous 恢复的 checkpoint 状态安全提升为当前 checkpoint。
 *
 * 安全顺序（保证恢复源在 promotion 成功前不被破坏）：
 *   1. 写独立临时文件 checkpoint.recovery.json（fsync + close），不动 next/previous；
 *   2. 删除损坏 current（Windows rename 覆盖需要）——此时 next/previous 仍存在；
 *   3. rename recovery → current（失败时恢复源完整保留）；
 *   4. 成功后再清理 stale next 与 recovery；previous 始终保留。
 * 注意：source=checkpoint.next 时不能用 writeCheckpointAtomic（其会先写/truncate next）。
 * @param {string} root 批次根目录
 * @param {object} state 校验通过的恢复状态
 * @param {object} opts { source, operations? }
 * @param {string} opts.source 只允许 'checkpoint.next' | 'checkpoint.previous'
 * @param {object} [opts.operations] 测试注入：{ rename?, rmSync? } 覆盖对应 fs 操作
 * @returns {Promise<string>} 写入的 checkpoint.json 绝对路径
 */
export async function promoteRecoveredCheckpoint(root, state, { source, operations = {} } = {}) {
  if (source !== 'checkpoint.next' && source !== 'checkpoint.previous') {
    throw new CheckpointError('CHECKPOINT_INVALID', `promoteRecoveredCheckpoint 只接受恢复来源 checkpoint.next/checkpoint.previous，实际 ${source}`)
  }
  validateCheckpoint(state)
  const dir = path.resolve(root)
  fs.mkdirSync(dir, { recursive: true })
  const target = path.join(dir, CHECKPOINT_FILE)
  const next = path.join(dir, CHECKPOINT_NEXT_FILE)
  const recovery = path.join(dir, CHECKPOINT_RECOVERY_FILE)
  const rename = operations.rename || ((from, to) => fs.renameSync(from, to))
  const rm = operations.rmSync || ((p) => fs.rmSync(p, { force: true }))
  try {
    // 1. 独立 recovery 临时文件：JSON + fsync + close；不动恢复源。
    const fd = fs.openSync(recovery, 'w')
    try {
      fs.writeFileSync(fd, JSON.stringify(state, null, 2), 'utf8')
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    // 2. 删除损坏 current（rename 覆盖需要）；next/previous 仍存在。
    if (fs.existsSync(target)) rm(target)
    // 3. rename recovery → current；此窗口恢复源完整。
    rename(recovery, target)
    // 4. 成功后清理 stale next 与 recovery；previous 始终保留。
    rm(next)
    if (fs.existsSync(recovery)) rm(recovery)
    return target
  } catch (error) {
    // promotion 失败：不删除恢复源（next/previous 未被本函数修改）；
    // recovery 临时文件尽力清理，可保留供诊断。
    try { fs.rmSync(recovery, { force: true }) } catch {}
    const failure = new CheckpointError('CHECKPOINT_IO', `checkpoint 恢复提升失败：${error.message}`)
    failure.cause = error
    throw failure
  }
}

export default {
  createCheckpoint,
  loadCheckpoint,
  loadCheckpointCandidates,
  promoteRecoveredCheckpoint,
  writeCheckpointAtomic,
  normalizeInterrupted,
  validateCheckpoint,
  assertCompatible,
  touchCheckpoint,
}

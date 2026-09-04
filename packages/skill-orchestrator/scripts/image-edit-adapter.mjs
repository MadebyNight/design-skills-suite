import { execFile, spawn as nodeSpawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { Registry, validate } from '../../design-skill-contracts/scripts/validate.mjs'
import { validateAssetResultForRequest } from '../runtime/asset-acceptance.mjs'

const exec = promisify(execFile)
const PROTOCOL = 'openphoto/v1'

/** 仅在底层错误携带布尔 retryable 时透传，不凭空发明重试语义。 */
function preserveRetryable(target, source) {
  if (typeof source?.retryable === 'boolean') target.retryable = source.retryable
}

function renderFormat(format) {
  const normalized = String(format || '').toLowerCase()
  if (normalized === 'png') return 'png'
  if (normalized === 'jpg' || normalized === 'jpeg') return 'jpeg'
  throw new Error(`不支持的目标图片格式：${format}`)
}

function expectedMimeType(format) {
  return renderFormat(format) === 'png' ? 'image/png' : 'image/jpeg'
}

function adaptationCommands(assetRequest, inspected) {
  const image = inspected?.descriptor?.objects?.find(object => object.type === 'image' && object.imageState)
  const sourceWidth = image?.bounds?.width
  const sourceHeight = image?.bounds?.height
  if (!image?.objectId || !Number.isFinite(sourceWidth) || sourceWidth <= 0 || !Number.isFinite(sourceHeight) || sourceHeight <= 0) {
    throw new Error('OpenPhoto document.inspect 未返回可适配的图片原始 bounds')
  }
  if (!['cover', 'contain'].includes(assetRequest.fit)) throw new Error(`不支持的图片适配 fit：${assetRequest.fit}`)
  const ratio = assetRequest.fit === 'cover'
    ? Math.max(assetRequest.targetWidth / sourceWidth, assetRequest.targetHeight / sourceHeight)
    : Math.min(assetRequest.targetWidth / sourceWidth, assetRequest.targetHeight / sourceHeight)
  const width = sourceWidth * ratio
  const height = sourceHeight * ratio
  return [
    { id: 'canvas.resize', args: { width: assetRequest.targetWidth, height: assetRequest.targetHeight } },
    {
      id: 'object.transform.set',
      args: {
        objectId: image.objectId,
        left: (assetRequest.targetWidth - width) / 2,
        top: (assetRequest.targetHeight - height) / 2,
        scaleX: ratio,
        scaleY: ratio,
        angle: 0,
        flipX: false,
        flipY: false,
      },
    },
  ]
}

function request(op, payload = {}, extra = {}) {
  return { protocol: PROTOCOL, requestId: randomUUID(), op, payload, ...extra }
}

export async function callOpenPhoto({ openphotoRoot, dataRoot, value, noStart = false }) {
  const bin = path.join(openphotoRoot, 'bin', 'openphoto.mjs')
  const args = noStart
    ? ['request', '--no-start', '--json', JSON.stringify(value)]
    : ['request', '--json', JSON.stringify(value)]
  let stdout
  try {
    ({ stdout } = await exec(process.execPath, [bin, ...args], {
      cwd: openphotoRoot,
      env: { ...process.env, OPENPHOTO_DATA_DIR: dataRoot },
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    }))
  } catch (error) {
    const parsed = parseDaemonStderr(error?.stderr)
    const failure = new Error(parsed?.message || error?.message || `OpenPhoto ${value.op} 调用失败`)
    failure.code = parsed?.code || error?.code || 'OPENPHOTO_FAILED'
    failure.op = value.op
    if (parsed?.details !== undefined) failure.details = parsed.details
    // retryable 透传优先级：daemon stderr JSON > execFile 原始错误；仅在
    // 底层明确携带布尔值时保留，供上游 shared 重试合同判定。
    preserveRetryable(failure, parsed)
    if (parsed?.retryable === undefined) preserveRetryable(failure, error)
    throw failure
  }
  const response = JSON.parse(stdout.trim())
  if (!response.ok) {
    const error = new Error(response.error?.message || `OpenPhoto ${value.op} 失败`)
    error.code = response.error?.code || 'OPENPHOTO_FAILED'
    error.details = response.error?.details
    error.op = value.op
    preserveRetryable(error, response.error)
    throw error
  }
  return response.result
}

function parseDaemonStderr(stderr) {
  if (typeof stderr !== 'string') return null
  const line = stderr.split(/\r?\n/u).map(item => item.trim()).find(item => item.startsWith('{'))
  if (!line) return null
  try {
    const parsed = JSON.parse(line)
    if (parsed && typeof parsed === 'object' && typeof parsed.message === 'string') return parsed
  } catch {
    // 非 JSON 的 stderr 直接忽略，回退到 execFile 原始错误
  }
  return null
}

/** AssetResult 的 strictSizeSatisfied：宽高严格等于请求目标时为 true（兼容信息）。 */
function strictSizeSatisfiedOf(assetRequest, output) {
  return output.width === assetRequest.targetWidth && output.height === assetRequest.targetHeight
}

export async function editWithOpenPhoto(assetRequest, {
  sourcePath,
  openphotoRoot,
  dataRoot,
  call = callOpenPhoto,
} = {}) {
  if (!sourcePath || !openphotoRoot || !dataRoot) throw new Error('缺少 sourcePath/openphotoRoot/dataRoot')
  const manifest = JSON.parse(fs.readFileSync(path.join(openphotoRoot, 'manifest.json'), 'utf8'))
  const imported = await call({ openphotoRoot, dataRoot, value: request('artifact.import', { sourcePath: path.resolve(sourcePath) }) })
  const input = imported
  const opened = await call({ openphotoRoot, dataRoot, value: request('document.open', { artifactId: input.artifactId }) })
  const documentId = opened.documentId
  let primaryError = null
  let result
  try {
    const inspected = await call({ openphotoRoot, dataRoot, value: request('document.inspect', {}, { documentId }) })
    const commands = adaptationCommands(assetRequest, inspected)
    const mutated = await call({
      openphotoRoot,
      dataRoot,
      value: request('document.mutate', { commands }, { documentId, expectedRevision: inspected.revision }),
    })
    const rendered = await call({
      openphotoRoot,
      dataRoot,
      value: request('document.renderArtifact', {
        format: renderFormat(assetRequest.format),
        ...(renderFormat(assetRequest.format) === 'jpeg' ? { matte: '#ffffff' } : {}),
      }, { documentId, expectedRevision: mutated.revision }),
    })
    const output = await call({ openphotoRoot, dataRoot, value: request('artifact.read', { artifactId: rendered.artifact.artifactId }) })
    // 验收规则统一走 shared acceptance：exact-size 请求仍要求精确宽高，
    // aspect-ratio 请求按比例容差验收（不再硬编码精确尺寸检查）。
    const acceptanceErrors = validateAssetResultForRequest(assetRequest, {
      assetRequestId: assetRequest.id,
      artifactId: output.artifactId,
      path: output.path,
      mimeType: output.mimeType,
      width: output.width,
      height: output.height,
      sha256: output.sha256,
      sourceSkill: manifest.id,
      sourceSkillVersion: manifest.version,
      strictSizeSatisfied: strictSizeSatisfiedOf(assetRequest, output),
      notes: [],
    })
    if (acceptanceErrors.length > 0) {
      throw new Error(`OpenPhoto 输出不满足 AssetRequest 验收合同：${acceptanceErrors.join('；')}`)
    }
    result = {
      assetRequestId: assetRequest.id,
      artifactId: output.artifactId,
      path: output.path,
      mimeType: output.mimeType,
      width: output.width,
      height: output.height,
      sha256: output.sha256,
      sourceSkill: manifest.id,
      sourceSkillVersion: manifest.version,
      strictSizeSatisfied: strictSizeSatisfiedOf(assetRequest, output),
      notes: [
        `openphoto/v1 commands: ${commands.map(command => command.id).join(', ')}`,
        `input ${input.width}x${input.height} -> output ${output.width}x${output.height}`,
        `revision ${inspected.revision} -> ${mutated.revision}`,
      ],
    }
    const schemas = path.resolve(import.meta.dirname, '..', '..', 'design-skill-contracts', 'schemas')
    const registry = Registry.fromDirectory(schemas)
    const schema = registry.byId.get('http://schemas.design-agent.local/design-skill/v1/asset-result.schema.json').schema
    const errors = validate(result, schema, registry, schema.$id)
    if (errors.length) throw new Error(`AssetResult 校验失败：${errors.join('；')}`)
  } catch (error) {
    primaryError = error
    preserveRetryable(primaryError, error)
  }
  let cleanupError = null
  try {
    await call({ openphotoRoot, dataRoot, value: request('document.close', {}, { documentId }) })
  } catch (error) {
    cleanupError = error
    preserveRetryable(cleanupError, error)
  }
  if (cleanupError) {
    const failure = new Error(`OpenPhoto document.close 清理失败：${cleanupError.message}`)
    failure.code = cleanupError.code || 'OPENPHOTO_CLEANUP_FAILED'
    failure.op = 'document.close'
    failure.cause = cleanupError
    preserveRetryable(failure, cleanupError)
    if (primaryError) {
      primaryError.cleanupError = failure
      throw primaryError
    }
    throw failure
  }
  if (primaryError) throw primaryError
  return result
}

export function createOpenPhotoAdapterBinding({ openphotoRoot, dataRoot, sourceRoot, spawnImpl = nodeSpawn, callImpl = callOpenPhoto, waitPollMs = 100, closeQuietMs = 200, startupTimeoutMs = 30_000, stopTimeoutMs = 30_000 } = {}) {
  if (!openphotoRoot || !dataRoot) throw new Error('缺少 openphotoRoot/dataRoot')
  const manifest = JSON.parse(fs.readFileSync(path.join(openphotoRoot, 'manifest.json'), 'utf8'))
  const resolvedSourceRoot = path.resolve(sourceRoot || process.cwd())

  const statePath = path.join(dataRoot, 'daemon.json')
  const lockPath = path.join(dataRoot, 'daemon.lock')
  const bin = path.join(openphotoRoot, 'bin', 'openphoto.mjs')

  let child = null
  let exitCode = null
  let startupStarted = false
  let startupPromise = null
  let closing = false
  let closePromise = null
  const inFlight = new Set()

  function failStartup(message) {
    const failure = new Error(message)
    failure.code = 'OPENPHOTO_START_FAILED'
    return failure
  }

  function readDaemonPid() {
    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
      return Number.isInteger(state?.pid) ? state.pid : null
    } catch {
      return null
    }
  }

  async function waitUntilHealthy({ timeoutMs, pollMs = waitPollMs }) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (exitCode !== null) throw failStartup(`OpenPhoto controlled daemon 在启动期间退出（code ${exitCode}）`)
      const pid = readDaemonPid()
      if (pid !== null && pid === child.pid) {
        try {
          await callImpl({ openphotoRoot, dataRoot, value: request('runtime.health', {}), noStart: true })
          return
        } catch {
          // pid 匹配但 health 未就绪，继续轮询。
        }
      }
      await new Promise(resolve => setTimeout(resolve, pollMs))
    }
    throw failStartup(`OpenPhoto controlled daemon 未能在 ${timeoutMs}ms 内就绪`)
  }

  function ensureStarted() {
    if (startupPromise) return startupPromise
    startupStarted = true
    startupPromise = (async () => {
      const started = spawnImpl(process.execPath, [bin, 'serve', '--controlled'], {
        cwd: openphotoRoot,
        env: { ...process.env, OPENPHOTO_DATA_DIR: dataRoot },
        stdio: ['pipe', 'ignore', 'pipe'],
        windowsHide: true,
      })
      child = started
      started.once('exit', (code, signal) => {
        exitCode = code === null ? signal : code
      })
      await waitUntilHealthy({ timeoutMs: startupTimeoutMs })
      return started
    })()
    return startupPromise
  }

  async function stopOwnedChild({ timeoutMs = stopTimeoutMs, pollMs = waitPollMs } = {}) {
    const deadline = Date.now() + timeoutMs
    try {
      child.stdin.write('openphoto-shutdown\n')
    } catch {}
    child.stdin.end()
    while (Date.now() < deadline && exitCode === null) {
      await new Promise(resolve => setTimeout(resolve, pollMs))
    }
    if (exitCode === null) {
      try { child.kill() } catch {}
      const failure = new Error(`OpenPhoto controlled daemon 未能在 ${timeoutMs}ms 内退出`)
      failure.code = 'OPENPHOTO_STOP_TIMEOUT'
      throw failure
    }
  }

  async function waitForStateClear({ quietMs = closeQuietMs, pollMs = waitPollMs } = {}) {
    const deadline = Date.now() + quietMs
    while (Date.now() < deadline) {
      if (fs.existsSync(statePath) || fs.existsSync(lockPath)) return false
      await new Promise(resolve => setTimeout(resolve, pollMs))
    }
    return !fs.existsSync(statePath) && !fs.existsSync(lockPath)
  }

  async function performClose() {
    if (startupPromise) {
      try {
        await startupPromise
      } catch (error) {
        // 启动失败不影响收尾，记录后继续关闭。
        console.warn(`[image-edit-adapter] startup failure ignored during close: ${error?.message || error}`)
      }
    }
    if (inFlight.size) await Promise.allSettled([...inFlight])
    if (child && exitCode === null) await stopOwnedChild()
    if (!(await waitForStateClear())) {
      const failure = new Error(`OpenPhoto daemon 状态在关闭后仍存在：${dataRoot}`)
      failure.code = 'OPENPHOTO_STOP_FAILED'
      throw failure
    }
  }

  return {
    providerId: manifest.id,
    async run(assetRequest, { asset } = {}) {
      if (closing) {
        const failure = new Error('OpenPhoto adapter 已关闭，无法执行新的适配')
        failure.code = 'OPENPHOTO_ADAPTER_CLOSED'
        throw failure
      }
      if (!asset?.path) throw new Error('待适配 AssetResult 缺少 path')
      const sourcePath = path.isAbsolute(asset.path)
        ? asset.path
        : path.resolve(resolvedSourceRoot, asset.path)
      const promise = (async () => {
        await ensureStarted()
        return editWithOpenPhoto(assetRequest, {
          sourcePath,
          openphotoRoot,
          dataRoot,
          call: callArgs => callImpl({ ...callArgs, noStart: true }),
        })
      })()
      inFlight.add(promise)
      try {
        return await promise
      } finally {
        inFlight.delete(promise)
      }
    },
    close() {
      if (closePromise) return closePromise
      closing = true
      closePromise = performClose()
      return closePromise
    },
    diagnostics() {
      return {
        pid: child?.pid ?? null,
        exitCode,
        closing,
        inFlight: inFlight.size,
        startupStarted,
      }
    },
  }
}

export async function stopOpenPhotoDataRoot(dataRoot, { timeoutMs = 10_000, pollMs = 100 } = {}) {
  const statePath = path.join(dataRoot, 'daemon.json')
  const lockPath = path.join(dataRoot, 'daemon.lock')
  if (!fs.existsSync(statePath) && !fs.existsSync(lockPath)) return
  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : null
  const pid = Number.isInteger(state?.pid) ? state.pid : null
  if (Number.isInteger(state?.pid)) {
    try { process.kill(state.pid, 'SIGTERM') } catch {}
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && (fs.existsSync(statePath) || fs.existsSync(lockPath))) {
    if (pid) {
      try { process.kill(pid, 0) } catch {
        fs.rmSync(statePath, { force: true })
        fs.rmSync(lockPath, { force: true })
        return
      }
    }
    await new Promise(resolve => setTimeout(resolve, pollMs))
  }
  if (fs.existsSync(statePath) || fs.existsSync(lockPath)) {
    const failure = new Error(`OpenPhoto data root 未能在 ${timeoutMs}ms 内停止：${dataRoot}`)
    failure.code = 'OPENPHOTO_STOP_TIMEOUT'
    failure.dataRoot = dataRoot
    throw failure
  }
}

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createOpenPhotoAdapterBinding, editWithOpenPhoto } from '../../scripts/image-edit-adapter.mjs'

const OPENPHOTO_ROOT = process.env.OPENPHOTO_SKILL_ROOT || path.resolve(import.meta.dirname, '..', '..', '..', '..', 'packages', 'openphoto', 'skill', 'openphoto')

// ---- fake child：模拟 controlled daemon 子进程 ----

function createFakeChild({ pid = 4242, onStdinWrite, onKill, stateFile = null, shutdownMs = 10 } = {}) {
  const exitListeners = []
  const child = {
    pid,
    killed: false,
    once(event, listener) {
      if (event === 'exit') exitListeners.push(listener)
      return child
    },
    emitExit(code, signal) {
      exitListeners.forEach(listener => listener(code, signal))
    },
    stdin: {
      write(data) {
        const text = String(data)
        onStdinWrite?.(text)
        if (text.includes('openphoto-shutdown')) {
          if (!Number.isFinite(shutdownMs)) return true
          setTimeout(() => {
            if (stateFile) { try { fs.rmSync(stateFile, { force: true }) } catch {} }
            child.emitExit(0)
          }, shutdownMs)
        }
        return true
      },
      end() {},
    },
    kill() {
      child.killed = true
      onKill?.()
      child.emitExit(null, 'SIGTERM')
    },
  }
  return child
}

// ---- fake spawn：默认写入 pid 匹配的 daemon.json ----

function createFakeSpawn({ children = [], spawnCount = { value: 0 }, stateFile, writeState = true, shutdownMs = 10 } = {}) {
  return (_cmd, args, options) => {
    spawnCount.value++
    const child = children.shift() || createFakeChild({ pid: 4200 + spawnCount.value, stateFile, shutdownMs: Number.isFinite(shutdownMs) ? shutdownMs : false })
    child.spawnOptions = options
    child.spawnArgs = args
    if (writeState) {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true })
      fs.writeFileSync(stateFile, JSON.stringify({ pid: child.pid, port: 0, instanceId: 'fake' }))
    }
    return child
  }
}

// ---- fake call：按 op 返回 editWithOpenPhoto 所需的最小结构 ----

function fakeOpResult(value) {
  if (value?.op === 'artifact.import') return { artifactId: 'a'.repeat(64), mimeType: 'image/png', width: 10, height: 10 }
  if (value?.op === 'document.open') return { documentId: 'doc-1' }
  if (value?.op === 'document.inspect') return { descriptor: { objects: [{ type: 'image', objectId: 'obj-1', imageState: {}, bounds: { width: 10, height: 10 } }] }, revision: 0 }
  if (value?.op === 'document.mutate') return { revision: 1 }
  if (value?.op === 'document.renderArtifact') return { artifact: { artifactId: 'b'.repeat(64) } }
  if (value?.op === 'artifact.read') return { artifactId: 'b'.repeat(64), path: 'out.png', mimeType: 'image/png', width: 10, height: 10, sha256: 'c'.repeat(64) }
  if (value?.op === 'document.close') return { closed: true }
  return { ok: true }
}

function createFakeCall({ callLog = [], healthOk = true, gateOp = null, gate = null } = {}) {
  return ({ value, noStart }) => {
    callLog.push({ op: value?.op, noStart })
    if (value?.op === 'runtime.health') {
      if (!healthOk) {
        const failure = new Error('daemon not ready')
        failure.code = 'DAEMON_UNAVAILABLE'
        throw failure
      }
      return { ok: true }
    }
    if (gateOp && gate && value?.op === gateOp) return gate
    return fakeOpResult(value)
  }
}

// ---- 公共夹具 ----

const ADAPTER_ASSET_REQUEST = { id: 'req-1', usageSlot: 'req-1', theme: '测试', targetWidth: 10, targetHeight: 10, aspectRatio: '1:1', format: 'png', fit: 'cover', safeArea: '居中', referenceImages: [], forbiddenContent: [], allowGenerate: true, allowEdit: true }
const FAKE_ASSET = { path: 'fixture.png' }

// ---- 用例 ----

test('并发首次 run 只 spawn 一次 controlled daemon（共享 startupPromise）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-lifecycle-concurrent-'))
  const spawnCount = { value: 0 }
  const callLog = []
  const pending = []
  const callImpl = ({ value, noStart }) => {
    callLog.push({ op: value?.op, noStart })
    if (value?.op === 'runtime.health') return { ok: true }
    if (value?.op === 'document.mutate') {
      // 挂起所有 mutate，制造并发窗口。
      return new Promise(resolve => pending.push(() => resolve({ revision: 1 })))
    }
    return fakeOpResult(value)
  }
  const spawnImpl = createFakeSpawn({ spawnCount, stateFile: path.join(root, 'data', 'daemon.json') })
  const adapter = createOpenPhotoAdapterBinding({ openphotoRoot: OPENPHOTO_ROOT, dataRoot: path.join(root, 'data'), spawnImpl, callImpl, waitPollMs: 10, closeQuietMs: 30 })
  try {
    const first = adapter.run(ADAPTER_ASSET_REQUEST, { asset: FAKE_ASSET })
    const second = adapter.run(ADAPTER_ASSET_REQUEST, { asset: FAKE_ASSET })
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(spawnCount.value, 1, '并发 run 必须共享 startupPromise，只 spawn 一次')
    assert.equal(adapter.diagnostics().inFlight, 2, '两个 run 都应在 inFlight 中')
    pending.forEach(resolve => resolve({ revision: 1 }))
    await Promise.all([first, second])
    assert.equal(spawnCount.value, 1)
    assert.ok(callLog.filter(item => item.op === 'runtime.health' && item.noStart).length >= 1, '启动等待必须通过 noStart health 确认可用')
    assert.equal(callLog.filter(item => item.op !== 'runtime.health').every(item => item.noStart === true), true, 'edit 流程所有调用必须 noStart=true')
  } finally {
    await adapter.close().catch(() => {})
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('close 等待所有 inFlight run 完成后再停止 daemon', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-lifecycle-close-wait-'))
  let releaseRun
  const gate = new Promise(resolve => { releaseRun = () => resolve({ revision: 1 }) })
  const callImpl = createFakeCall({ gateOp: 'document.mutate', gate })
  const spawnImpl = createFakeSpawn({ stateFile: path.join(root, 'data', 'daemon.json') })
  const adapter = createOpenPhotoAdapterBinding({ openphotoRoot: OPENPHOTO_ROOT, dataRoot: path.join(root, 'data'), spawnImpl, callImpl, waitPollMs: 10, closeQuietMs: 30 })
  try {
    const running = adapter.run(ADAPTER_ASSET_REQUEST, { asset: FAKE_ASSET })
    await new Promise(resolve => setTimeout(resolve, 20))
    const closing = adapter.close()
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(adapter.diagnostics().closing, true, 'close 立即标记 closing')
    assert.equal(adapter.diagnostics().exitCode, null, 'inFlight 未完成时 daemon 不得提前退出')
    releaseRun()
    await Promise.all([running, closing])
    assert.notEqual(adapter.diagnostics().exitCode, null, 'inFlight 完成后 daemon 必须退出')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('close 后 run 拒绝并抛 OPENPHOTO_ADAPTER_CLOSED', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-lifecycle-closed-run-'))
  const spawnCount = { value: 0 }
  const spawnImpl = createFakeSpawn({ spawnCount, stateFile: path.join(root, 'data', 'daemon.json') })
  const adapter = createOpenPhotoAdapterBinding({ openphotoRoot: OPENPHOTO_ROOT, dataRoot: path.join(root, 'data'), spawnImpl, callImpl: createFakeCall(), waitPollMs: 10, closeQuietMs: 30 })
  try {
    await adapter.close()
    await assert.rejects(
      () => adapter.run(ADAPTER_ASSET_REQUEST, { asset: FAKE_ASSET }),
      error => error.code === 'OPENPHOTO_ADAPTER_CLOSED',
    )
    assert.equal(spawnCount.value, 0, 'close 后不得再 spawn daemon')
    assert.equal(adapter.diagnostics().closing, true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('close 幂等：多次调用共享同一次关闭过程', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-lifecycle-close-idempotent-'))
  const stateFile = path.join(root, 'data', 'daemon.json')
  const shutdownWrites = []
  let killCount = 0
  const child = createFakeChild({
    pid: 5555,
    onStdinWrite: data => { if (data.includes('openphoto-shutdown')) shutdownWrites.push(data) },
    onKill: () => { killCount++ },
    stateFile,
    shutdownMs: 10,
  })
  const spawnCount = { value: 0 }
  const spawnImpl = createFakeSpawn({ children: [child], spawnCount, stateFile })
  const adapter = createOpenPhotoAdapterBinding({ openphotoRoot: OPENPHOTO_ROOT, dataRoot: path.join(root, 'data'), spawnImpl, callImpl: createFakeCall(), waitPollMs: 10, closeQuietMs: 30 })
  try {
    await adapter.run(ADAPTER_ASSET_REQUEST, { asset: FAKE_ASSET })
    assert.equal(spawnCount.value, 1)
    const first = adapter.close()
    const second = adapter.close()
    assert.equal(first, second, 'close 必须返回同一个 closePromise')
    await Promise.all([first, second])
    assert.equal(shutdownWrites.length, 1, '必须只发送一次 openphoto-shutdown')
    assert.equal(killCount, 0, 'daemon 正常退出时不得调用 kill')
    assert.notEqual(adapter.diagnostics().exitCode, null)
    assert.equal(fs.existsSync(stateFile), false, '关闭后 daemon.json 必须消失')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('child 提前 exit 时启动失败抛 OPENPHOTO_START_FAILED', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-lifecycle-start-failed-'))
  const spawnCount = { value: 0 }
  const spawnImpl = () => {
    spawnCount.value++
    const child = createFakeChild({ pid: 6666 })
    setTimeout(() => child.emitExit(1), 10)
    return child
  }
  const adapter = createOpenPhotoAdapterBinding({ openphotoRoot: OPENPHOTO_ROOT, dataRoot: path.join(root, 'data'), spawnImpl, callImpl: createFakeCall({ healthOk: false }), startupTimeoutMs: 500, stopTimeoutMs: 200 })
  try {
    await assert.rejects(
      () => adapter.run(ADAPTER_ASSET_REQUEST, { asset: FAKE_ASSET }),
      error => error.code === 'OPENPHOTO_START_FAILED',
    )
    assert.equal(spawnCount.value, 1)
    assert.equal(adapter.diagnostics().startupStarted, true)
  } finally {
    await adapter.close().catch(() => {})
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('daemon.json pid 与 child 不匹配时继续等待，匹配后 health 通过即就绪', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-lifecycle-pid-match-'))
  const stateFile = path.join(root, 'data', 'daemon.json')
  const child = createFakeChild({ pid: 7777, stateFile })
  let writes = 0
  const spawnImpl = () => {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true })
    fs.writeFileSync(stateFile, JSON.stringify({ pid: 1 }))
    const timer = setInterval(() => {
      writes++
      if (writes >= 2) {
        clearInterval(timer)
        fs.writeFileSync(stateFile, JSON.stringify({ pid: child.pid }))
      }
    }, 20)
    return child
  }
  const adapter = createOpenPhotoAdapterBinding({ openphotoRoot: OPENPHOTO_ROOT, dataRoot: path.join(root, 'data'), spawnImpl, callImpl: createFakeCall(), waitPollMs: 10, closeQuietMs: 30 })
  try {
    await adapter.run(ADAPTER_ASSET_REQUEST, { asset: FAKE_ASSET })
    assert.equal(adapter.diagnostics().pid, 7777)
  } finally {
    await adapter.close().catch(() => {})
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('启动超时抛 OPENPHOTO_START_FAILED', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-lifecycle-start-timeout-'))
  const spawnImpl = () => createFakeChild({ pid: 8888 })
  const adapter = createOpenPhotoAdapterBinding({ openphotoRoot: OPENPHOTO_ROOT, dataRoot: path.join(root, 'data'), spawnImpl, callImpl: createFakeCall({ healthOk: false }), startupTimeoutMs: 150, stopTimeoutMs: 100, closeQuietMs: 10 })
  try {
    await assert.rejects(
      () => adapter.run(ADAPTER_ASSET_REQUEST, { asset: FAKE_ASSET }),
      error => error.code === 'OPENPHOTO_START_FAILED',
    )
    assert.equal(adapter.diagnostics().exitCode, null, 'fake child 未退出时 exitCode 保持 null')
  } finally {
    await adapter.close().catch(() => {})
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('close 超时未退出时 kill 并抛 OPENPHOTO_STOP_TIMEOUT', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-lifecycle-stop-timeout-'))
  const stateFile = path.join(root, 'data', 'daemon.json')
  let killCount = 0
  const child = createFakeChild({ pid: 9999, onKill: () => killCount++, shutdownMs: false })
  const spawnImpl = () => {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true })
    fs.writeFileSync(stateFile, JSON.stringify({ pid: child.pid }))
    return child
  }
  const adapter = createOpenPhotoAdapterBinding({
    openphotoRoot: OPENPHOTO_ROOT,
    dataRoot: path.join(root, 'data'),
    spawnImpl,
    callImpl: createFakeCall(),
    waitPollMs: 5,
    stopTimeoutMs: 100,
    closeQuietMs: 10,
  })
  try {
    await adapter.run(ADAPTER_ASSET_REQUEST, { asset: FAKE_ASSET })
    await assert.rejects(
      () => adapter.close(),
      error => error.code === 'OPENPHOTO_STOP_TIMEOUT',
    )
    assert.equal(killCount, 1, '超时后必须对自有 child 调用 kill')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// ---- shared acceptance 与 retryable 透传（editWithOpenPhoto 直接用例）----

function acceptanceAssetRequest(acceptance) {
  return {
    ...ADAPTER_ASSET_REQUEST,
    ...(acceptance !== undefined ? { acceptance } : {}),
  }
}

/** call mock：document.mutate 前正常，artifact.read 返回指定尺寸输出。 */
function createAcceptanceCall({ outputWidth, outputHeight, mimeType = 'image/png' }) {
  return async ({ value }) => {
    if (value?.op === 'artifact.import') return { artifactId: 'a'.repeat(64), mimeType, width: 10, height: 10 }
    if (value?.op === 'document.open') return { documentId: 'doc-1' }
    if (value?.op === 'document.inspect') return { descriptor: { objects: [{ type: 'image', objectId: 'obj-1', imageState: {}, bounds: { width: 10, height: 10 } }] }, revision: 0 }
    if (value?.op === 'document.mutate') return { revision: 1 }
    if (value?.op === 'document.renderArtifact') return { artifact: { artifactId: 'b'.repeat(64) } }
    if (value?.op === 'artifact.read') return { artifactId: 'b'.repeat(64), path: 'out.png', mimeType, width: outputWidth, height: outputHeight, sha256: 'c'.repeat(64) }
    if (value?.op === 'document.close') return { closed: true }
    throw new Error(`unexpected op: ${value?.op}`)
  }
}

test('editWithOpenPhoto：exact-size 请求非精确输出仍被拒（旧行为不回归）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-accept-exact-'))
  try {
    await assert.rejects(
      () => editWithOpenPhoto(acceptanceAssetRequest(undefined), {
        sourcePath: path.join(root, 'in.png'),
        openphotoRoot: OPENPHOTO_ROOT,
        dataRoot: path.join(root, 'data'),
        call: createAcceptanceCall({ outputWidth: 12, outputHeight: 12 }),
      }),
      /尺寸不匹配|不满足 AssetRequest 验收合同/,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('editWithOpenPhoto：aspect-ratio 请求比例合格输出直接通过验收', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-accept-aspect-'))
  try {
    const result = await editWithOpenPhoto(acceptanceAssetRequest({ mode: 'aspect-ratio', maxAspectRatioError: 0.03 }), {
      sourcePath: path.join(root, 'in.png'),
      openphotoRoot: OPENPHOTO_ROOT,
      dataRoot: path.join(root, 'data'),
      // 目标 10x10，输出 1020x1000 同比例（2% 误差）且尺寸非精确 → 比例模式通过。
      call: createAcceptanceCall({ outputWidth: 1020, outputHeight: 1000 }),
    })
    assert.equal(result.width, 1020)
    assert.equal(result.height, 1000)
    assert.equal(result.strictSizeSatisfied, false, '非精确输出的 strictSizeSatisfied 必须如实推导为 false')
    assert.equal(result.assetRequestId, acceptanceAssetRequest(undefined).id)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('editWithOpenPhoto：精确输出时 strictSizeSatisfied=true；超差输出拒绝', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-accept-strict-'))
  try {
    const exact = await editWithOpenPhoto(acceptanceAssetRequest(undefined), {
      sourcePath: path.join(root, 'in.png'),
      openphotoRoot: OPENPHOTO_ROOT,
      dataRoot: path.join(root, 'data'),
      call: createAcceptanceCall({ outputWidth: 10, outputHeight: 10 }),
    })
    assert.equal(exact.strictSizeSatisfied, true, '精确输出必须推导 strictSizeSatisfied=true')
    await assert.rejects(
      () => editWithOpenPhoto(acceptanceAssetRequest({ mode: 'aspect-ratio', maxAspectRatioError: 0.03 }), {
        sourcePath: path.join(root, 'in.png'),
        openphotoRoot: OPENPHOTO_ROOT,
        dataRoot: path.join(root, 'data'),
        call: createAcceptanceCall({ outputWidth: 1100, outputHeight: 1000 }),
      }),
      /比例超出容差/,
      '比例超差的 adapter 输出必须被拒',
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('editWithOpenPhoto：主流程错误透传 retryable', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-retryable-main-'))
  const call = async ({ value }) => {
    if (value?.op === 'artifact.import') return { artifactId: 'a'.repeat(64), mimeType: 'image/png', width: 10, height: 10 }
    if (value?.op === 'document.open') return { documentId: 'doc-1' }
    if (value?.op === 'document.inspect') {
      const failure = new Error('daemon busy')
      failure.code = 'BUSY'
      failure.retryable = true
      throw failure
    }
    throw new Error(`unexpected op: ${value?.op}`)
  }
  try {
    await assert.rejects(
      () => editWithOpenPhoto(acceptanceAssetRequest(undefined), {
        sourcePath: path.join(root, 'in.png'),
        openphotoRoot: OPENPHOTO_ROOT,
        dataRoot: path.join(root, 'data'),
        call,
      }),
      error => error.message.includes('daemon busy') && error.retryable === true,
      '底层 retryable=true 必须保留在主流程错误上',
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('editWithOpenPhoto：cleanup 失败错误透传 retryable；cleanup 成功时主错误保留 retryable', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-retryable-cleanup-'))
  // cleanup 失败 + 主流程失败：主错误保留且透传 retryable。
  const failCall = async ({ value }) => {
    if (value?.op === 'artifact.import') return { artifactId: 'a'.repeat(64), mimeType: 'image/png', width: 10, height: 10 }
    if (value?.op === 'document.open') return { documentId: 'doc-1' }
    if (value?.op === 'document.inspect') throw new Error('inspect failed')
    if (value?.op === 'document.close') {
      const failure = new Error('close failed')
      failure.retryable = true
      throw failure
    }
    throw new Error(`unexpected op: ${value?.op}`)
  }
  try {
    await assert.rejects(
      () => editWithOpenPhoto(acceptanceAssetRequest(undefined), {
        sourcePath: path.join(root, 'in.png'),
        openphotoRoot: OPENPHOTO_ROOT,
        dataRoot: path.join(root, 'data'),
        call: failCall,
      }),
      error => error.message.includes('inspect failed') && error.cleanupError?.retryable === true,
      'cleanupError 必须保留底层 retryable',
    )
    // 仅 cleanup 失败：failure 对象透传 retryable。
    const closeOnlyCall = async ({ value }) => {
      if (value?.op === 'artifact.import') return { artifactId: 'a'.repeat(64), mimeType: 'image/png', width: 10, height: 10 }
      if (value?.op === 'document.open') return { documentId: 'doc-1' }
      if (value?.op === 'document.inspect') return { descriptor: { objects: [{ type: 'image', objectId: 'obj-1', imageState: {}, bounds: { width: 10, height: 10 } }] }, revision: 0 }
      if (value?.op === 'document.mutate') return { revision: 1 }
      if (value?.op === 'document.renderArtifact') return { artifact: { artifactId: 'b'.repeat(64) } }
      if (value?.op === 'artifact.read') return { artifactId: 'b'.repeat(64), path: 'out.png', mimeType: 'image/png', width: 10, height: 10, sha256: 'c'.repeat(64) }
      if (value?.op === 'document.close') {
        const failure = new Error('close failed')
        failure.retryable = true
        throw failure
      }
      throw new Error(`unexpected op: ${value?.op}`)
    }
    await assert.rejects(
      () => editWithOpenPhoto(acceptanceAssetRequest(undefined), {
        sourcePath: path.join(root, 'in.png'),
        openphotoRoot: OPENPHOTO_ROOT,
        dataRoot: path.join(root, 'data'),
        call: closeOnlyCall,
      }),
      error => error.code === 'OPENPHOTO_CLEANUP_FAILED' && error.retryable === true,
      'cleanup 失败错误必须透传 retryable',
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
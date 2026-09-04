import { test, expect } from '@playwright/test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

async function fileExists(path) {
  try {
    await readFile(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

const skillRoot = resolve(import.meta.dirname, '../..')
const entry = resolve(skillRoot, 'bin/openphoto.mjs')

function runCli(args, env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { cwd: skillRoot, env, windowsHide: true })
    const stdout = []
    const stderr = []
    child.stdout.on('data', chunk => stdout.push(chunk))
    child.stderr.on('data', chunk => stderr.push(chunk))
    child.once('error', reject)
    child.once('exit', code => code === 0
      ? resolveRun(JSON.parse(Buffer.concat(stdout).toString('utf8')))
      : reject(new Error(Buffer.concat(stderr).toString('utf8'))))
  })
}

function runCliCapture(args, env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { cwd: skillRoot, env, windowsHide: true })
    const stdout = []
    const stderr = []
    child.stdout.on('data', chunk => stdout.push(chunk))
    child.stderr.on('data', chunk => stderr.push(chunk))
    child.once('error', reject)
    child.once('exit', code => resolveRun({
      code,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8')
    }))
  })
}

function startServe(env, args = ['serve']) {
  const child = spawn(process.execPath, [entry, ...args], { cwd: skillRoot, env: { ...env, NODE_ENV: 'test' }, stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true })
  const exited = new Promise(resolveExit => child.once('exit', resolveExit))
  return { child, exited }
}

async function waitForState(path, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  throw new Error(`daemon state was not published: ${path}`)
}

async function waitForMissing(path, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await readFile(path)
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  throw new Error(`state file remained after shutdown: ${path}`)
}

test('CLI health uses one loopback daemon and cleans up its lease', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'openphoto-cli-'))
  const env = { ...process.env, OPENPHOTO_DATA_DIR: dataRoot }
  const statePath = join(dataRoot, 'daemon.json')
  const lockPath = join(dataRoot, 'daemon.lock')
  let serve
  try {
    const capability = await runCli(['capabilities'], env)
    expect(capability.ok).toBe(true)
    expect(capability.result.operations).toEqual([
      'runtime.health', 'runtime.capabilities', 'artifact.import', 'artifact.read',
      'document.open', 'document.inspect', 'document.mutate', 'document.renderArtifact', 'document.applyArtifact', 'document.close',
      'ai.analyze.start', 'ai.job.get',
      'model.status', 'model.install', 'model.install.cancel'
    ])
    expect(capability.result.commands).toEqual([
      'canvas.resize', 'canvas.crop', 'canvas.rotate', 'canvas.flip', 'canvas.flatten',
      'object.transform.set', 'object.rotate', 'object.flip', 'image.adjust', 'filter.apply'
    ])
    serve = startServe(env)
    const state = await waitForState(statePath)
    const healthRequest = JSON.stringify({ protocol: 'openphoto/v1', requestId: 'health', op: 'runtime.health', payload: {} })
    const [first, second] = await Promise.all([
      runCli(['request', '--json', healthRequest], env),
      runCli(['request', '--json', healthRequest], env)
    ])
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(first.result.instanceId).toBe(second.result.instanceId)
    expect(state.instanceId).toBe(first.result.instanceId)
    await runCli(['capabilities'], env)
    expect(JSON.parse(await readFile(statePath, 'utf8')).instanceId).toBe(state.instanceId)
    if (process.platform === 'win32') serve.child.stdin.write('openphoto-test-shutdown\n')
    else process.kill(state.pid, 'SIGTERM')
    await serve.exited
    await waitForMissing(statePath)
    await waitForMissing(lockPath)
  } finally {
    if (serve && serve.child.exitCode === null) {
      try {
        if (process.platform === 'win32') serve.child.stdin.write('openphoto-test-shutdown\n')
        else process.kill(serve.child.pid, 'SIGTERM')
      } catch {}
      await serve.exited
    }
    await rm(dataRoot, { recursive: true, force: true })
  }
})

test('request --no-start 在无 daemon 时以稳定错误退出且不产生 daemon.json/lock', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'openphoto-nostart-'))
  const env = { ...process.env, OPENPHOTO_DATA_DIR: dataRoot }
  const healthRequest = JSON.stringify({ protocol: 'openphoto/v1', requestId: 'health', op: 'runtime.health', payload: {} })
  try {
    const result = await runCliCapture(['request', '--no-start', '--json', healthRequest], env)
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('DAEMON_UNAVAILABLE')
    await new Promise(resolveWait => setTimeout(resolveWait, 200))
    expect(await fileExists(join(dataRoot, 'daemon.json'))).toBe(false)
    expect(await fileExists(join(dataRoot, 'daemon.lock'))).toBe(false)
  } finally {
    await rm(dataRoot, { recursive: true, force: true })
  }
})

test('controlled serve 响应 stdin 的 openphoto-shutdown 并清理 state 与 lock', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'openphoto-controlled-'))
  const env = { ...process.env, OPENPHOTO_DATA_DIR: dataRoot, NODE_ENV: 'test' }
  const statePath = join(dataRoot, 'daemon.json')
  const lockPath = join(dataRoot, 'daemon.lock')
  let serve
  try {
    serve = startServe(env, ['serve', '--controlled'])
    const state = await waitForState(statePath)
    serve.child.stdin.write('openphoto-shutdown\n')
    await serve.exited
    await waitForMissing(statePath)
    await waitForMissing(lockPath)
    expect(state.port).toBeGreaterThan(0)
  } finally {
    if (serve && serve.child.exitCode === null) {
      try { serve.child.stdin.write('openphoto-shutdown\n') } catch {}
      await serve.exited
    }
    await rm(dataRoot, { recursive: true, force: true })
  }
})

test('CLI 拒绝多余参数并返回非零退出码', async () => {
  const env = { ...process.env, OPENPHOTO_DATA_DIR: await mkdtemp(join(tmpdir(), 'openphoto-usage-')) }
  try {
    const extraServe = await runCliCapture(['serve', '--controlled', 'extra'], env)
    expect(extraServe.code).not.toBe(0)
    expect(extraServe.stderr).toContain('usage:')
    const extraCapabilities = await runCliCapture(['capabilities', 'extra'], env)
    expect(extraCapabilities.code).not.toBe(0)
    const unknownFlag = await runCliCapture(['request', '--json', '{}', 'extra'], env)
    expect(unknownFlag.code).not.toBe(0)
  } finally {
    await rm(env.OPENPHOTO_DATA_DIR, { recursive: true, force: true })
  }
})

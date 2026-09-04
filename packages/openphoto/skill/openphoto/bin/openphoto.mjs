#!/usr/bin/env node
import { readFile, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OpenPhotoDaemon } from '../runtime/daemon.mjs'
import { DaemonLock, resolveDataRoot } from '../runtime/daemon-lock.mjs'
import { healthyDaemon, requestDaemon, timeoutForOperation, waitForHealthyDaemon } from '../runtime/client.mjs'
import { PROTOCOL } from '../runtime/protocol.mjs'

const entryPath = fileURLToPath(import.meta.url)

function print(value) {
  process.stdout.write(JSON.stringify(value) + '\n')
}

function diagnostic(error) {
  process.stderr.write(JSON.stringify({ code: error.code ?? 'RUNTIME_CRASH', message: error.message }) + '\n')
}

async function readState(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function serve({ controlled = false } = {}) {
  const dataRoot = resolveDataRoot()
  const statePath = resolve(dataRoot, 'daemon.json')
  const lock = new DaemonLock({ dataRoot })
  const existingHealthy = async record => {
    const state = await healthyDaemon(dataRoot)
    return state?.instanceId === record.instanceId
  }
  await lock.acquire({ isHealthy: existingHealthy })
  const daemon = new OpenPhotoDaemon({
    dataRoot,
    instanceId: lock.instanceId,
    assertLease: () => lock.assertLease(),
    onLeaseLost: () => { void shutdown().catch(diagnostic) }
  })
  let heartbeat
  let heartbeatQueue = Promise.resolve()
  let shutdownPromise
  const shutdown = async ({ fromHeartbeat = false } = {}) => {
    if (shutdownPromise) return fromHeartbeat ? undefined : shutdownPromise
    shutdownPromise = (async () => {
      const failures = []
      clearInterval(heartbeat)
      if (process.env.NODE_ENV === 'test') process.stdin.destroy()
      if (!fromHeartbeat) {
        try {
          await heartbeatQueue
        } catch (error) {
          failures.push(error)
        }
      }
      try {
        await daemon.close()
      } catch (error) {
        failures.push(error)
      }
      try {
        const state = await readState(statePath)
        if (state?.instanceId === lock.instanceId) await rm(statePath, { force: true })
      } catch (error) {
        failures.push(error)
      }
      try {
        await lock.release()
      } catch (error) {
        failures.push(error)
      }
      if (failures.length) throw new AggregateError(failures, 'OpenPhoto daemon shutdown failed')
    })()
    return shutdownPromise
  }
  try {
    const address = await daemon.listen()
    await lock.assertLease()
    const publish = async () => {
      await lock.assertLease()
      await writeFile(statePath, JSON.stringify({ port: address.port, instanceId: lock.instanceId, pid: process.pid }) + '\n')
    }
    await publish()
    heartbeat = setInterval(() => {
      heartbeatQueue = heartbeatQueue.catch(() => {}).then(async () => {
        if (shutdownPromise) return
        try {
          await lock.renew()
          await publish()
        } catch (error) {
          diagnostic(error)
          try {
            await shutdown({ fromHeartbeat: true })
          } catch (shutdownError) {
            diagnostic(shutdownError)
          }
        }
      })
    }, 10_000)
    await new Promise(resolveSignal => {
      process.once('SIGINT', resolveSignal)
      process.once('SIGTERM', resolveSignal)
      const testMode = process.env.NODE_ENV === 'test'
      if (controlled || testMode) {
        process.stdin.setEncoding('utf8')
        process.stdin.on('data', value => {
          const line = value.trim()
          if (line === 'openphoto-shutdown' || line === 'openphoto-test-shutdown') resolveSignal()
        })
      }
    })
    await shutdown()
  } catch (error) {
    await shutdown()
    throw error
  }
}

async function request(request, { autoStart = true } = {}) {
  const dataRoot = resolveDataRoot()
  let state = await healthyDaemon(dataRoot)
  if (!state) {
    if (!autoStart) {
      throw Object.assign(new Error('no healthy OpenPhoto daemon is running'), { code: 'DAEMON_UNAVAILABLE' })
    }
    const child = spawn(process.execPath, [entryPath, 'serve'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, OPENPHOTO_DATA_DIR: dataRoot }
    })
    child.unref()
    state = await waitForHealthyDaemon(dataRoot)
  }
  return requestDaemon(state, request, { timeoutMs: timeoutForOperation(request.op) })
}

async function capabilities() {
  const daemon = new OpenPhotoDaemon()
  try {
    return await daemon.dispatch({ protocol: PROTOCOL, requestId: randomUUID(), op: 'runtime.capabilities', payload: {} })
  } finally {
    await daemon.close()
  }
}

function usageError() {
  return new Error('usage: openphoto capabilities | openphoto serve [--controlled] | openphoto request [--no-start] --file request.json | openphoto request [--no-start] --json JSON')
}

async function main(argumentsList) {
  const args = argumentsList.slice()
  if (args.length === 0) throw usageError()
  const command = args.shift()
  if (command === 'capabilities') {
    if (args.length !== 0) throw usageError()
    return print(await capabilities())
  }
  if (command === 'serve') {
    if (args.length === 0) return serve()
    if (args.length === 1 && args[0] === '--controlled') return serve({ controlled: true })
    throw usageError()
  }
  if (command === 'request') {
    let autoStart = true
    if (args[0] === '--no-start') {
      autoStart = false
      args.shift()
    }
    if (args.length !== 2) throw usageError()
    const [flag, value] = args
    if (flag === '--json') return print(await request(JSON.parse(value), { autoStart }))
    if (flag === '--file') return print(await request(JSON.parse(await readFile(resolve(value), 'utf8')), { autoStart }))
    throw usageError()
  }
  throw usageError()
}

main(process.argv.slice(2)).catch(error => {
  diagnostic(error)
  process.exitCode = 1
})

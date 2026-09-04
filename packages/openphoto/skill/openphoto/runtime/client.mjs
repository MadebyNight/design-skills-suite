import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PROTOCOL } from './protocol.mjs'
import { resolveDataRoot } from './daemon-lock.mjs'

export async function readDaemonState(dataRoot = resolveDataRoot()) {
  const path = resolve(dataRoot, 'daemon.json')
  try {
    const state = JSON.parse(await readFile(path, 'utf8'))
    if (!Number.isSafeInteger(state.port) || state.port < 1 || state.port > 65535 || typeof state.instanceId !== 'string' || state.instanceId.length === 0) return null
    return state
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

export class OpenPhotoClientError extends Error {
  constructor(code, message, options) {
    super(message, options)
    this.name = 'OpenPhotoClientError'
    this.code = code
  }
}

export const OPERATION_TIMEOUTS = Object.freeze({
  'runtime.health': 5_000,
  'runtime.capabilities': 5_000,
  'artifact.import': 10_000,
  'artifact.read': 10_000,
  'document.inspect': 15_000,
  'document.mutate': 15_000,
  'document.open': 30_000,
  'document.renderArtifact': 30_000,
  'document.close': 30_000,
  'document.applyArtifact': 30_000,
  'ai.analyze.start': 30_000,
  'ai.job.get': 15_000,
  'model.status': 10_000,
  'model.install': 30_000,
  'model.install.cancel': 10_000
})

export function timeoutForOperation(op) {
  return OPERATION_TIMEOUTS[op] ?? 5_000
}

export async function requestDaemon(state, request, { timeoutMs = timeoutForOperation(request?.op) } = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`http://127.0.0.1:${state.port}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-ndjson' },
      body: JSON.stringify(request) + '\n',
      signal: controller.signal
    })
    if (!response.ok) throw new Error(`daemon RPC failed with HTTP ${response.status}`)
    const line = (await response.text()).trim()
    return JSON.parse(line)
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new OpenPhotoClientError('TIMEOUT', `daemon request timed out after ${timeoutMs}ms`, { cause: error })
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

export async function healthyDaemon(dataRoot = resolveDataRoot()) {
  const state = await readDaemonState(dataRoot)
  if (!state) return null
  try {
    const response = await requestDaemon(state, { protocol: PROTOCOL, requestId: randomUUID(), op: 'runtime.health', payload: {} })
    return response.ok && response.result.instanceId === state.instanceId ? state : null
  } catch {
    return null
  }
}

export async function waitForHealthyDaemon(dataRoot = resolveDataRoot(), timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await healthyDaemon(dataRoot)
    if (state) return state
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  throw Object.assign(new Error('daemon did not become healthy within 10 seconds'), { code: 'BUSY' })
}

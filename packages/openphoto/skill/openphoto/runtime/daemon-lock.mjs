import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'

export const LEASE_TIMEOUT_MS = 30_000

export function resolveDataRoot(value = process.env.OPENPHOTO_DATA_DIR) {
  const localAppData = process.env.LOCALAPPDATA
  if (!value && !localAppData) throw new Error('OPENPHOTO_DATA_DIR or LOCALAPPDATA is required')
  return resolve(value || join(localAppData, 'OpenPhoto'))
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

export class DaemonLock {
  constructor({ dataRoot = resolveDataRoot(), instanceId = randomUUID(), now = () => Date.now() } = {}) {
    this.dataRoot = resolve(dataRoot)
    this.path = resolve(this.dataRoot, 'daemon.lock')
    this.instanceId = instanceId
    this.now = now
    this.owned = false
  }

  record() {
    return { instanceId: this.instanceId, pid: process.pid, heartbeatAt: this.now() }
  }

  async acquire({ isHealthy = async () => false } = {}) {
    await mkdir(this.dataRoot, { recursive: true })
    try {
      const handle = await open(this.path, 'wx')
      await handle.writeFile(JSON.stringify(this.record()) + '\n')
      await handle.close()
      this.owned = true
      return this.record()
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
    const existing = await readJson(this.path)
    if (existing && await isHealthy(existing)) throw Object.assign(new Error('a healthy daemon already owns this data root'), { code: 'BUSY' })
    if (!existing || this.now() - Number(existing.heartbeatAt) > LEASE_TIMEOUT_MS) {
      await rm(this.path, { force: true })
      return this.acquire({ isHealthy })
    }
    throw Object.assign(new Error('a daemon is starting or its lease is still fresh'), { code: 'BUSY' })
  }

  async assertLease() {
    const current = await readJson(this.path)
    if (!this.owned || current?.instanceId !== this.instanceId) {
      this.owned = false
      throw Object.assign(new Error('daemon lease ownership was lost'), { code: 'RUNTIME_CRASH' })
    }
  }

  async renew() {
    await this.assertLease()
    await writeFile(this.path, JSON.stringify(this.record()) + '\n')
    await this.assertLease()
  }

  async release() {
    const current = await readJson(this.path)
    if (this.owned && current?.instanceId === this.instanceId) await rm(this.path, { force: true })
    this.owned = false
  }
}

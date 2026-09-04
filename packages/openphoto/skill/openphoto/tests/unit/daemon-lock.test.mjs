import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DaemonLock, LEASE_TIMEOUT_MS } from '../../runtime/daemon-lock.mjs'

test('only an unhealthy expired lease is reclaimable and fences its old owner', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'openphoto-lock-'))
  try {
    const old = new DaemonLock({ dataRoot, instanceId: 'old-owner', now: () => 0 })
    await old.acquire()

    const fresh = new DaemonLock({ dataRoot, instanceId: 'fresh-contender', now: () => 1 })
    await assert.rejects(() => fresh.acquire({ isHealthy: async () => false }), { code: 'BUSY' })

    const healthy = new DaemonLock({ dataRoot, instanceId: 'healthy-contender', now: () => LEASE_TIMEOUT_MS + 1 })
    await assert.rejects(() => healthy.acquire({ isHealthy: async () => true }), { code: 'BUSY' })

    const successor = new DaemonLock({ dataRoot, instanceId: 'new-owner', now: () => LEASE_TIMEOUT_MS + 1 })
    await successor.acquire({ isHealthy: async () => false })
    await assert.rejects(() => old.assertLease(), { code: 'RUNTIME_CRASH' })
  } finally {
    await rm(dataRoot, { recursive: true, force: true })
  }
})

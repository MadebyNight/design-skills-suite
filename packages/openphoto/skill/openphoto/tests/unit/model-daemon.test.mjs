import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { OpenPhotoDaemon } from '../../runtime/daemon.mjs'
import { PROTOCOL } from '../../runtime/protocol.mjs'

const FIXTURE_LOCK = resolve(import.meta.dirname, '../fixtures/models.fixture.lock.json')
const PRODUCTION_LOCK = resolve(import.meta.dirname, '../../manifests/models.lock.json')
const MODEL_ID = 'Xenova/modnet'

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function wait(milliseconds) {
  return new Promise(resolveWait => setTimeout(resolveWait, milliseconds))
}

async function recursiveFiles(root) {
  const entries = await readdir(root, { recursive: true })
  return entries.map(entry => String(entry))
}

async function waitForFile(root, predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await recursiveFiles(root)).some(predicate)) return
    await wait(10)
  }
  throw new Error('timed out waiting for model installer output')
}

async function waitForInstall(daemon, installId, status = 'installed') {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await rpc(daemon, 'model.status', { installId })
    if (!response.ok) throw new Error(`model status failed: ${response.error.code}`)
    const install = response.result.installs[0]
    if (install.status === status) return install
    await wait(10)
  }
  throw new Error(`timed out waiting for model install to become ${status}`)
}

function rpc(daemon, op, payload) {
  return daemon.dispatch({ protocol: PROTOCOL, requestId: randomUUID(), op, payload })
}

function seedWaitingAnalysisJob(daemon, jobId, modelId = MODEL_ID) {
  daemon.jobs.create({
    kind: 'analysis',
    jobId,
    documentId: 'document-fixture',
    sourceRevision: 0,
    targetObjectId: 'object-fixture',
    inputArtifactId: 'a'.repeat(64),
    capability: 'background-remove',
    modelId,
    status: 'waiting_for_model'
  })
}

async function createFixtureModelServer({ slowModelId } = {}) {
  const template = JSON.parse(await readFile(FIXTURE_LOCK, 'utf8'))
  const fileResponses = new Map()
  for (const [modelId, entry] of Object.entries(template.models)) {
    for (const file of entry.files) {
      const path = `/${file.path.split('/').map(encodeURIComponent).join('/')}`
      fileResponses.set(path, {
        modelId,
        bytes: Buffer.from(`openphoto fixture model ${modelId} ${file.path}\n`)
      })
    }
  }

  const requests = []
  const slowResponses = new Map()
  let resolveSlowStart
  const slowStarted = slowModelId === undefined ? null : new Promise(resolveStart => { resolveSlowStart = resolveStart })
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://127.0.0.1').pathname
    const file = fileResponses.get(path)
    if (!file) {
      response.writeHead(404).end()
      return
    }
    requests.push(path)
    response.writeHead(200, { 'content-length': file.bytes.byteLength, 'content-type': 'application/octet-stream' })
    if (file.modelId === slowModelId) {
      const firstChunkLength = Math.max(1, Math.floor(file.bytes.byteLength / 2))
      response.write(file.bytes.subarray(0, firstChunkLength))
      slowResponses.set(response, file.bytes.subarray(firstChunkLength))
      resolveSlowStart()
      return
    }
    response.end(file.bytes)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture model server did not bind a TCP port')
  const origin = `http://127.0.0.1:${address.port}`
  const manifest = {
    ...template,
    models: Object.fromEntries(Object.entries(template.models).map(([modelId, entry]) => [modelId, {
      ...entry,
      source: entry.source.replaceAll('__ORIGIN__', origin),
      files: entry.files.map(file => {
        const bytes = fileResponses.get(`/${file.path.split('/').map(encodeURIComponent).join('/')}`).bytes
        return {
          ...file,
          url: file.url.replaceAll('__ORIGIN__', origin),
          bytes: bytes.byteLength,
          sha256: sha256(bytes)
        }
      })
    }]))
  }

  return {
    manifest,
    requests,
    waitForSlowStart: async () => slowStarted,
    releaseSlowResponses() {
      for (const [response, remainder] of slowResponses) {
        if (!response.destroyed && !response.writableEnded) response.end(remainder)
      }
      slowResponses.clear()
    },
    async close() {
      this.releaseSlowResponses()
      await new Promise(resolveClose => server.close(resolveClose))
    }
  }
}

async function closeDaemonAndFixture({ daemon, fixture, dataRoot }) {
  await daemon?.close().catch(() => {})
  await fixture?.close().catch(() => {})
  await rm(dataRoot, { recursive: true, force: true })
}

test('daemon shares one install and requeues the original waiting analysis job', async t => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'openphoto-model-daemon-'))
  const fixture = await createFixtureModelServer({ slowModelId: MODEL_ID })
  const daemon = new OpenPhotoDaemon({ dataRoot, modelManifest: fixture.manifest })
  t.after(() => closeDaemonAndFixture({ daemon, fixture, dataRoot }))
  const waitingJobId = 'analysis-waiting-fixture'
  seedWaitingAnalysisJob(daemon, waitingJobId)

  const [first, second] = await Promise.all([
    rpc(daemon, 'model.install', { modelId: MODEL_ID }),
    rpc(daemon, 'model.install', { modelId: MODEL_ID })
  ])
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(first.result.status, 'installing')
  assert.equal(second.result.status, 'installing')
  assert.equal(first.result.installId, second.result.installId)
  await fixture.waitForSlowStart()
  fixture.releaseSlowResponses()

  assert.equal((await waitForInstall(daemon, first.result.installId)).status, 'installed')
  assert.equal(daemon.jobs.get(waitingJobId).jobId, waitingJobId)
  assert.equal(daemon.jobs.get(waitingJobId).status, 'queued')
  assert.equal(fixture.requests.filter(path => path === '/modnet.bin').length, 1)
})

test('daemon cancellation cleans the shared partial download and keeps analysis jobs waiting', async t => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'openphoto-model-daemon-'))
  const fixture = await createFixtureModelServer({ slowModelId: MODEL_ID })
  const daemon = new OpenPhotoDaemon({ dataRoot, modelManifest: fixture.manifest })
  t.after(() => closeDaemonAndFixture({ daemon, fixture, dataRoot }))
  const waitingJobId = 'analysis-cancelled-fixture'
  seedWaitingAnalysisJob(daemon, waitingJobId)

  const [first, second] = await Promise.all([
    rpc(daemon, 'model.install', { modelId: MODEL_ID }),
    rpc(daemon, 'model.install', { modelId: MODEL_ID })
  ])
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(first.result.installId, second.result.installId)
  await fixture.waitForSlowStart()
  await waitForFile(dataRoot, path => path.endsWith('.part'))

  const cancelled = await rpc(daemon, 'model.install.cancel', { installId: first.result.installId })
  assert.equal(cancelled.ok, true)
  assert.equal(cancelled.result.installId, first.result.installId)
  assert.equal(cancelled.result.status, 'cancelled')
  assert.equal(cancelled.result.error.code, 'CANCELLED')
  const repeatedCancel = await rpc(daemon, 'model.install.cancel', { installId: first.result.installId })
  assert.equal(repeatedCancel.ok, true)
  assert.equal(repeatedCancel.result.status, 'cancelled')
  assert.equal(daemon.jobs.get(waitingJobId).status, 'waiting_for_model')
  const files = await recursiveFiles(dataRoot)
  assert.equal(files.some(path => path.endsWith('.part')), false)
  assert.equal(files.some(path => path.endsWith('installed.json')), false)
})

test('daemon reuses a verified cache after restart while old install IDs expire', async t => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'openphoto-model-daemon-'))
  const fixture = await createFixtureModelServer()
  const firstDaemon = new OpenPhotoDaemon({ dataRoot, modelManifest: fixture.manifest })
  let secondDaemon
  t.after(async () => {
    await secondDaemon?.close().catch(() => {})
    await closeDaemonAndFixture({ daemon: firstDaemon, fixture, dataRoot })
  })

  const firstInstall = await rpc(firstDaemon, 'model.install', { modelId: MODEL_ID })
  assert.equal(firstInstall.ok, true)
  await waitForInstall(firstDaemon, firstInstall.result.installId)
  const requestsBeforeRestart = fixture.requests.length
  await firstDaemon.close()
  secondDaemon = new OpenPhotoDaemon({ dataRoot, modelManifest: fixture.manifest })

  const expired = await rpc(secondDaemon, 'model.status', { installId: firstInstall.result.installId })
  assert.equal(expired.ok, false)
  assert.equal(expired.error.code, 'NOT_FOUND')
  const cached = await rpc(secondDaemon, 'model.status', { modelId: MODEL_ID })
  assert.equal(cached.ok, true)
  assert.deepEqual(cached.result.cache, [{
    modelId: MODEL_ID,
    revision: fixture.manifest.models[MODEL_ID].revision,
    status: 'installed'
  }])
  assert.deepEqual(cached.result.installs, [])
  const reused = await rpc(secondDaemon, 'model.install', { modelId: MODEL_ID })
  assert.equal(reused.ok, true)
  assert.equal(reused.result.status, 'installed')
  assert.equal(fixture.requests.length, requestsBeforeRestart)
})

test('an incomplete production-shaped model lock rejects before any HTTP request', async t => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'openphoto-model-daemon-'))
  const productionLock = structuredClone(JSON.parse(await readFile(PRODUCTION_LOCK, 'utf8')))
  productionLock.models[MODEL_ID] = { ...productionLock.models[MODEL_ID], source: '', files: [] }
  const daemon = new OpenPhotoDaemon({ dataRoot, modelManifest: productionLock })
  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  globalThis.fetch = async () => {
    fetchCalls += 1
    throw new Error('model installation must not fetch an incomplete manifest')
  }
  t.after(async () => {
    globalThis.fetch = originalFetch
    await daemon.close().catch(() => {})
    await rm(dataRoot, { recursive: true, force: true })
  })

  const response = await rpc(daemon, 'model.install', { modelId: MODEL_ID })
  assert.equal(response.ok, false)
  assert.equal(response.error.code, 'MODEL_MANIFEST_INCOMPLETE')
  assert.equal(fetchCalls, 0)
})

test('an unknown model ID is rejected before the installer can open a request', async t => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'openphoto-model-daemon-'))
  const fixture = await createFixtureModelServer()
  const daemon = new OpenPhotoDaemon({ dataRoot, modelManifest: fixture.manifest })
  t.after(async () => {
    await daemon.close().catch(() => {})
    await fixture.close().catch(() => {})
    await rm(dataRoot, { recursive: true, force: true })
  })

  const response = await rpc(daemon, 'model.install', { modelId: 'Xenova/not-a-locked-model' })
  assert.equal(response.ok, false)
  assert.equal(response.error.code, 'MODEL_MANIFEST_INCOMPLETE')
  assert.equal(fixture.requests.length, 0)
})

test('daemon does not register a new installer after close begins during lease verification', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'openphoto-model-daemon-'))
  const fixture = await createFixtureModelServer()
  let leaseChecks = 0
  let releaseLeaseCheck
  const leaseCheckBlocked = new Promise(resolve => { releaseLeaseCheck = resolve })
  let leaseCheckStarted
  const secondLeaseCheck = new Promise(resolve => { leaseCheckStarted = resolve })
  let installerCalls = 0
  const daemon = new OpenPhotoDaemon({
    dataRoot,
    modelManifest: fixture.manifest,
    assertLease: async () => {
      leaseChecks += 1
      if (leaseChecks === 3) {
        leaseCheckStarted()
        await leaseCheckBlocked
      }
    },
    modelInstaller: async () => {
      installerCalls += 1
      throw new Error('installer must not start after close')
    }
  })
  try {
    const installing = rpc(daemon, 'model.install', { modelId: MODEL_ID })
    await secondLeaseCheck
    await daemon.close()
    releaseLeaseCheck()
    const response = await installing
    assert.equal(response.ok, false)
    assert.equal(response.error.code, 'RUNTIME_CRASH')
    assert.equal(installerCalls, 0)
  } finally {
    await fixture.close().catch(() => {})
    await daemon.close().catch(() => {})
    await rm(dataRoot, { recursive: true, force: true })
  }
})

test('daemon aborts a preparation slot when close begins during stale-cache cleanup', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'openphoto-model-daemon-'))
  const fixture = await createFixtureModelServer()
  const revision = fixture.manifest.models[MODEL_ID].revision
  let statusCalls = 0
  let cleanupCalls = 0
  let installerCalls = 0
  let releaseFinalStatus
  const finalStatusBlocked = new Promise(resolve => { releaseFinalStatus = resolve })
  let finalStatusStarted
  const finalStatusReady = new Promise(resolve => { finalStatusStarted = resolve })
  const modelStore = {
    cacheRoot: join(dataRoot, 'models'),
    async status(modelId, currentRevision) {
      statusCalls += 1
      assert.equal(modelId, MODEL_ID)
      assert.equal(currentRevision, revision)
      if (statusCalls === 1) return { modelId, revision: currentRevision, status: 'missing' }
      if (statusCalls === 2) return { modelId, revision: currentRevision, status: 'installing', installToken: 'stale-token' }
      finalStatusStarted()
      await finalStatusBlocked
      return { modelId, revision: currentRevision, status: 'missing' }
    },
    async cleanupFailedInstall(modelId, currentRevision, token) {
      cleanupCalls += 1
      assert.equal(modelId, MODEL_ID)
      assert.equal(currentRevision, revision)
      assert.equal(token, 'stale-token')
    }
  }
  const daemon = new OpenPhotoDaemon({
    dataRoot,
    modelManifest: fixture.manifest,
    modelStore,
    modelInstaller: async () => {
      installerCalls += 1
      throw new Error('installer must not start after close')
    }
  })
  try {
    const installing = rpc(daemon, 'model.install', { modelId: MODEL_ID })
    await finalStatusReady
    await daemon.close()
    releaseFinalStatus()
    const response = await installing
    assert.equal(response.ok, false)
    assert.equal(response.error.code, 'RUNTIME_CRASH')
    assert.equal(cleanupCalls, 1)
    assert.equal(installerCalls, 0)
    assert.equal(daemon.jobs.list(job => job.kind === 'model-install').length, 0)
  } finally {
    releaseFinalStatus()
    await fixture.close().catch(() => {})
    await daemon.close().catch(() => {})
    await rm(dataRoot, { recursive: true, force: true })
  }
})

test('daemon rejects stale install recovery after close clears jobs', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'openphoto-model-daemon-'))
  const fixture = await createFixtureModelServer()
  let statusCalls = 0
  let installerCalls = 0
  let releaseCleanup
  let cleanupStartedResolve
  const cleanupStarted = new Promise(resolveStarted => { cleanupStartedResolve = resolveStarted })
  const cleanupGate = new Promise(resolveCleanup => { releaseCleanup = resolveCleanup })
  const modelStore = {
    cacheRoot: join(dataRoot, 'models'),
    async status(modelId, revision) {
      statusCalls += 1
      if (statusCalls === 1) return { modelId, revision, status: 'missing' }
      if (statusCalls === 2) return { modelId, revision, status: 'installing', installToken: 'stale-token' }
      if (statusCalls === 3) return { modelId, revision, status: 'installed' }
      throw new Error(`unexpected model status call ${statusCalls}`)
    },
    async cleanupFailedInstall() {
      cleanupStartedResolve()
      await cleanupGate
    }
  }
  const daemon = new OpenPhotoDaemon({
    dataRoot,
    modelManifest: fixture.manifest,
    modelStore,
    modelInstaller: async () => {
      installerCalls += 1
    }
  })
  const installing = rpc(daemon, 'model.install', { modelId: MODEL_ID })
  try {
    await cleanupStarted
    await daemon.close()
    releaseCleanup()
    const response = await installing
    assert.equal(response.ok, false)
    assert.equal(response.error.code, 'RUNTIME_CRASH')
    assert.equal(installerCalls, 0)
    assert.deepEqual(daemon.jobs.list(), [])
  } finally {
    releaseCleanup()
    await installing.catch(() => {})
    await daemon.close().catch(() => {})
    await fixture.close().catch(() => {})
    await rm(dataRoot, { recursive: true, force: true })
  }
})

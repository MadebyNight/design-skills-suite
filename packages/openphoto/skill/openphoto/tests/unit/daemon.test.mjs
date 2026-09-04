import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OpenPhotoDaemon } from '../../runtime/daemon.mjs'
import { requestDaemon, OpenPhotoClientError } from '../../runtime/client.mjs'

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitFor(value) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const result = await value()
    if (result) return result
    await new Promise(resolveWait => setTimeout(resolveWait, 5))
  }
  throw new Error('timed out waiting for asynchronous job')
}

test('daemon returns a capability response without opening a document', async () => {
  const daemon = new OpenPhotoDaemon({ driverFactory: () => { throw new Error('not used') } })
  const response = await daemon.dispatch({ protocol: 'openphoto/v1', requestId: 'req-1', op: 'runtime.capabilities', payload: {} })
  assert.equal(response.ok, true)
  assert.ok(response.result.operations.includes('artifact.import'))
  assert.ok(response.result.operations.includes('document.open'))
  assert.ok(response.result.operations.includes('document.applyArtifact'))
  assert.ok(response.result.operations.includes('ai.analyze.start'))
  assert.ok(response.result.operations.includes('ai.job.get'))
  assert.equal(response.result.commands.length, 10)
})

test('daemon applies a raster artifact only through the explicit application operation', async () => {
  const artifact = { artifactId: 'a'.repeat(64), mimeType: 'image/png', width: 1, height: 1, path: 'artifact.png' }
  let applied
  const daemon = new OpenPhotoDaemon()
  const document = {
    revision: 0,
    queue: Promise.resolve(),
    closing: false,
    closePromise: null,
    driver: {
      async applyArtifact(value) {
        applied = value
        return { revision: 1, descriptor: { revision: 1 } }
      },
      async close() {}
    }
  }
  daemon.documents.set('doc-1', document)
  daemon.artifacts.describe = async artifactId => {
    assert.equal(artifactId, artifact.artifactId)
    return artifact
  }

  const response = await daemon.dispatch({
    protocol: 'openphoto/v1', requestId: 'req-2', op: 'document.applyArtifact', documentId: 'doc-1', expectedRevision: 0,
    payload: { artifactId: artifact.artifactId, targetObjectId: 'object-1', placement: 'replace-target' }
  })

  assert.equal(response.ok, true)
  assert.equal(document.revision, 1)
  assert.deepEqual(applied, {
    expectedRevision: 0,
    artifact,
    targetObjectId: 'object-1',
    placement: 'replace-target'
  })
  await daemon.close()
})

test('daemon gates analysis on a model, resumes the same job, and does not mutate the document', async () => {
  const modelId = 'Xenova/modnet'
  const entry = {
    revision: 'fixture-revision',
    source: 'https://fixture.invalid/models/modnet',
    license: 'fixture-license',
    files: [{ path: 'modnet.bin', url: 'https://fixture.invalid/models/modnet.bin', bytes: 1, sha256: 'a'.repeat(64) }]
  }
  const modelManifest = { schemaVersion: 1, models: { [modelId]: entry } }
  const modelRouteManifest = {
    schemaVersion: 1,
    observations: { [modelId]: { revision: entry.revision, paths: ['/models/Xenova/modnet/modnet.bin'] } }
  }
  let installed = false
  const modelStore = {
    cacheRoot: 'C:\\openphoto-model-cache',
    async status() { return { status: installed ? 'installed' : 'missing' } }
  }
  let analyzed
  const daemon = new OpenPhotoDaemon({
    modelManifest,
    modelStore,
    modelRouting: { manifest: modelRouteManifest, lock: modelManifest, modelStore },
    modelInstaller: async () => { installed = true }
  })
  const document = {
    revision: 0,
    queue: Promise.resolve(),
    closing: false,
    closePromise: null,
    driver: {
      modelLocalPath: 'http://127.0.0.1:12345/models/',
      async captureAnalysisInput({ objectId, assertLease }) {
        assert.equal(objectId, 'object-1')
        assert.equal(typeof assertLease, 'function')
        return { artifactId: 'c'.repeat(64), mimeType: 'image/png', width: 1, height: 1, path: 'input.png' }
      },
      async analyze(value) {
        analyzed = value
        return {
          kind: 'raster',
          artifact: { artifactId: 'd'.repeat(64), mimeType: 'image/png', width: 1, height: 1, path: 'result.png' },
          targetObjectId: 'object-1',
          placement: 'replace-target'
        }
      },
      async close() {}
    }
  }
  daemon.documents.set('doc-1', document)

  try {
    const started = await daemon.dispatch({
      protocol: 'openphoto/v1', requestId: 'analysis-start', op: 'ai.analyze.start', documentId: 'doc-1',
      payload: { capability: 'background-remove', objectId: 'object-1', sourceRevision: 0 }
    })
    assert.equal(started.ok, false)
    assert.equal(started.error.code, 'MODEL_DOWNLOAD_REQUIRED')
    assert.deepEqual(started.error.details, {
      jobId: started.error.details.jobId,
      modelId,
      revision: entry.revision,
      source: entry.source,
      license: entry.license,
      totalBytes: 1,
      cacheRoot: modelStore.cacheRoot
    })
    const waiting = await daemon.dispatch({
      protocol: 'openphoto/v1', requestId: 'analysis-waiting', op: 'ai.job.get', payload: { jobId: started.error.details.jobId }
    })
    assert.deepEqual(waiting.result, { jobId: started.error.details.jobId, status: 'waiting_for_model' })

    const install = await daemon.dispatch({
      protocol: 'openphoto/v1', requestId: 'model-install', op: 'model.install', payload: { modelId }
    })
    assert.equal(install.ok, true)
    const completed = await waitFor(async () => {
      const response = await daemon.dispatch({
        protocol: 'openphoto/v1', requestId: `analysis-completed-${Math.random()}`, op: 'ai.job.get', payload: { jobId: started.error.details.jobId }
      })
      return response.result?.status === 'completed' ? response : null
    })

    assert.deepEqual({ ...analyzed, assertLease: typeof analyzed.assertLease }, {
      capability: 'background-remove',
      inputArtifact: { artifactId: 'c'.repeat(64), mimeType: 'image/png', width: 1, height: 1, path: 'input.png' },
      model: { id: modelId, revision: entry.revision, localModelPath: 'http://127.0.0.1:12345/models/' },
      assertLease: 'function'
    })
    assert.deepEqual(completed.result.result, {
      kind: 'raster',
      artifact: { artifactId: 'd'.repeat(64), mimeType: 'image/png', width: 1, height: 1, path: 'result.png' },
      targetObjectId: 'object-1',
      placement: 'replace-target'
    })
    assert.equal(document.revision, 0)
  } finally {
    await daemon.close()
  }
})

test('daemon fails a waiting analysis when its document closes before installation', async () => {
  const daemon = new OpenPhotoDaemon()
  const document = {
    revision: 0,
    queue: Promise.resolve(),
    closing: false,
    closePromise: null,
    driver: { async close() {} }
  }
  daemon.documents.set('doc-1', document)
  daemon.jobs.create({
    kind: 'analysis',
    jobId: 'analysis-waiting',
    documentId: 'doc-1',
    modelId: 'Xenova/modnet',
    status: 'waiting_for_model'
  })

  try {
    const closed = await daemon.dispatch({
      protocol: 'openphoto/v1', requestId: 'close-analysis-document', op: 'document.close', documentId: 'doc-1', payload: {}
    })
    assert.deepEqual(closed, { requestId: 'close-analysis-document', ok: true, result: { closed: true } })

    daemon.resumeWaitingAnalysis('Xenova/modnet')
    const job = await daemon.dispatch({
      protocol: 'openphoto/v1', requestId: 'closed-analysis-job', op: 'ai.job.get', payload: { jobId: 'analysis-waiting' }
    })
    assert.deepEqual(job.result, {
      jobId: 'analysis-waiting',
      status: 'failed',
      error: { code: 'NOT_FOUND', message: 'document not found' }
    })
  } finally {
    await daemon.close()
  }
})

test('daemon returns RUNTIME_CRASH after lease ownership is lost', async () => {
  const daemon = new OpenPhotoDaemon({
    assertLease: async () => { throw Object.assign(new Error('daemon lease ownership was lost'), { code: 'RUNTIME_CRASH' }) }
  })
  const response = await daemon.dispatch({ protocol: 'openphoto/v1', requestId: 'req-3', op: 'runtime.capabilities', payload: {} })
  assert.equal(response.error.code, 'RUNTIME_CRASH')
})

test('daemon discards an opened document when the lease is lost before it is committed', async () => {
  let checks = 0
  let closed = false
  const daemon = new OpenPhotoDaemon({
    assertLease: async () => {
      checks += 1
      if (checks === 2) throw Object.assign(new Error('daemon lease ownership was lost'), { code: 'RUNTIME_CRASH' })
    },
    driverFactory: async () => ({
      async open() { return { revision: 0, canvas: { width: 1, height: 1 }, objects: [] } },
      async close() { closed = true }
    })
  })
  daemon.artifacts.describe = async () => ({ artifactId: 'a'.repeat(64), mimeType: 'image/png', width: 1, height: 1 })

  const response = await daemon.dispatch({
    protocol: 'openphoto/v1', requestId: 'req-open', op: 'document.open', payload: { artifactId: 'a'.repeat(64) }
  })

  assert.equal(response.error.code, 'RUNTIME_CRASH')
  assert.equal(closed, true)
  assert.equal(daemon.documents.size, 0)
  await daemon.close()
})

test('daemon discards an uncommitted mutation when the lease is lost after the driver returns', async () => {
  let checks = 0
  let closed = false
  const daemon = new OpenPhotoDaemon({
    assertLease: async () => {
      checks += 1
      if (checks === 3) throw Object.assign(new Error('daemon lease ownership was lost'), { code: 'RUNTIME_CRASH' })
    }
  })
  const document = {
    revision: 0,
    queue: Promise.resolve(),
    closing: false,
    closePromise: null,
    driver: {
      async mutate() { return { revision: 1, descriptor: { revision: 1 } } },
      async close() { closed = true }
    }
  }
  daemon.documents.set('document-1', document)

  const response = await daemon.dispatch({
    protocol: 'openphoto/v1', requestId: 'req-mutate', op: 'document.mutate', documentId: 'document-1', expectedRevision: 0,
    payload: { commands: [{ id: 'canvas.flip', args: { axis: 'h' } }] }
  })

  assert.equal(response.error.code, 'RUNTIME_CRASH')
  assert.equal(document.revision, 0)
  assert.equal(closed, true)
  assert.equal(daemon.documents.size, 0)
  await daemon.close()
})

test('daemon does not persist a render when the lease is lost after the driver returns', async () => {
  let checks = 0
  let closed = false
  let artifactWrites = 0
  const daemon = new OpenPhotoDaemon({
    assertLease: async () => {
      checks += 1
      if (checks === 3) throw Object.assign(new Error('daemon lease ownership was lost'), { code: 'RUNTIME_CRASH' })
    }
  })
  daemon.artifacts.put = async () => { artifactWrites += 1 }
  const document = {
    revision: 0,
    queue: Promise.resolve(),
    closing: false,
    closePromise: null,
    driver: {
      async render() {
        return {
          bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
          metadata: { mimeType: 'image/png', width: 1, height: 1 }
        }
      },
      async close() { closed = true }
    }
  }
  daemon.documents.set('document-1', document)

  const response = await daemon.dispatch({
    protocol: 'openphoto/v1', requestId: 'req-render', op: 'document.renderArtifact', documentId: 'document-1', expectedRevision: 0,
    payload: { format: 'png' }
  })

  assert.equal(response.error.code, 'RUNTIME_CRASH')
  assert.equal(artifactWrites, 0)
  assert.equal(closed, true)
  assert.equal(daemon.documents.size, 0)
  await daemon.close()
})

test('daemon close releases every document and its HTTP server after a driver close failure', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'openphoto-daemon-'))
  let healthyDriverClosed = false
  const daemon = new OpenPhotoDaemon({ dataRoot })
  daemon.documents.set('broken', {
    revision: 0, queue: Promise.resolve(), closing: false, closePromise: null,
    driver: { async close() { throw new Error('browser profile cleanup failed') } }
  })
  daemon.documents.set('healthy', {
    revision: 0, queue: Promise.resolve(), closing: false, closePromise: null,
    driver: { async close() { healthyDriverClosed = true } }
  })

  try {
    await daemon.listen()
    await assert.rejects(() => daemon.close(), AggregateError)
    assert.equal(healthyDriverClosed, true)
    assert.equal(daemon.documents.size, 0)
    assert.equal(daemon.server, null)
  } finally {
    await rm(dataRoot, { recursive: true, force: true })
  }
})

test('daemon forwards the verified model routing object to its document driver', async () => {
  const modelRouting = { manifest: {}, lock: {}, modelStore: {} }
  let received
  const daemon = new OpenPhotoDaemon({
    modelRouting,
    driverFactory: async options => {
      received = options.modelRouting
      return {
        async open() { return { revision: 0, canvas: { width: 1, height: 1 }, objects: [] } },
        async close() {}
      }
    }
  })
  daemon.artifacts.describe = async () => ({ artifactId: 'a'.repeat(64), mimeType: 'image/png', width: 1, height: 1 })
  const response = await daemon.dispatch({
    protocol: 'openphoto/v1', requestId: 'req-routing', op: 'document.open', payload: { artifactId: 'a'.repeat(64) }
  })
  assert.equal(response.ok, true)
  assert.equal(received, modelRouting)
  await daemon.close()
})

test('characterization: dispatch continues after the HTTP client aborts on a slow driver open', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'openphoto-daemon-timeout-'))
  let openResolve
  const openGate = new Promise(resolve => { openResolve = resolve })
  let startedResolve
  const openStarted = new Promise(resolve => { startedResolve = resolve })
  let gateReleased = false
  let opened = 0
  let closed = 0
  const daemon = new OpenPhotoDaemon({
    dataRoot,
    driverFactory: async () => ({
      async open() {
        opened += 1
        startedResolve()
        await openGate
        return { revision: 0, canvas: { width: 1, height: 1 }, objects: [] }
      },
      async close() { closed += 1 }
    })
  })
  daemon.artifacts.describe = async () => ({ artifactId: 'a'.repeat(64), mimeType: 'image/png', width: 1, height: 1 })

  try {
    const { port } = await daemon.listen()
    const state = { port, instanceId: daemon.instanceId }
    const request = { protocol: 'openphoto/v1', requestId: 'req-slow-open', op: 'document.open', payload: { artifactId: 'a'.repeat(64) } }

    // 先确认服务端 dispatch 已进入 driver.open，再验证客户端 timeout 不会取消服务端工作。
    const requestPromise = requestDaemon(state, request, { timeoutMs: 500 })
    await Promise.race([
      openStarted,
      requestPromise.then(
        () => { throw new Error('request unexpectedly completed before driver.open started') },
        error => { throw error },
      ),
      delay(2_000).then(() => { throw new Error('driver.open did not start within 2s') }),
    ])
    assert.equal(opened, 1, 'dispatch must start driver.open before the client timeout')
    await assert.rejects(
      requestPromise,
      error => error instanceof OpenPhotoClientError && error.code === 'TIMEOUT'
    )

    // Release the driver open; the server-side dispatch must still complete.
    openResolve()
    gateReleased = true
    await delay(20)
    assert.equal(daemon.documents.size, 1, 'dispatch must still commit the opened document after the client aborted')

    // A subsequent close must succeed, proving the daemon was not torn down by the abort.
    const [documentId] = daemon.documents.keys()
    const closedResponse = await requestDaemon(state, { protocol: 'openphoto/v1', requestId: 'req-close', op: 'document.close', documentId, payload: {} })
    assert.equal(closedResponse.ok, true)
    assert.equal(closed, 1)
    assert.equal(daemon.documents.size, 0)
  } finally {
    if (!gateReleased) openResolve()
    await daemon.close()
    await rm(dataRoot, { recursive: true, force: true })
  }
})

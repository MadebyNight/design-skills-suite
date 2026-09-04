import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installModel } from '../../runtime/model-installer.mjs'
import { ModelStore } from '../../runtime/model-store.mjs'

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function manifestFor(origin, bytes, sha = sha256(bytes)) {
  return {
    schemaVersion: 1,
    models: {
      fixture: {
        revision: 'fixture-revision',
        license: 'fixture-license',
        source: origin,
        files: [{ path: 'nested/model.bin', url: `${origin}/model.bin`, bytes: bytes.byteLength, sha256: sha }]
      }
    }
  }
}

async function listFiles(root) {
  const entries = await readdir(root, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...await listFiles(path))
    else files.push(path)
  }
  return files
}

async function waitForPart(root) {
  for (let attempts = 0; attempts < 100; attempts += 1) {
    if ((await listFiles(root)).some(path => path.endsWith('.part'))) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('installer did not create a temporary file')
}

async function startServer(handler) {
  const server = createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port')
  return { server, origin: `http://127.0.0.1:${address.port}` }
}

async function closeServer(server) {
  await new Promise(resolve => server.close(() => resolve()))
}

test('installModel verifies the declared SHA-256 before marking a model installed', async t => {
  const bytes = Buffer.from('openphoto-model-fixture')
  let requests = 0
  const { server, origin } = await startServer((_, response) => {
    requests += 1
    response.end(bytes)
  })
  const cacheRoot = await mkdtemp(join(tmpdir(), 'openphoto-model-'))
  t.after(async () => {
    await closeServer(server)
    await rm(cacheRoot, { recursive: true, force: true })
  })

  const installed = await installModel({ manifest: manifestFor(origin, bytes), modelId: 'fixture', cacheRoot })

  assert.equal(installed.modelId, 'fixture')
  assert.equal(installed.status, 'installed')
  assert.equal(installed.revision, 'fixture-revision')
  assert.deepEqual(installed.files, [{ path: 'nested/model.bin', bytes: bytes.byteLength, sha256: sha256(bytes) }])
  const files = await listFiles(cacheRoot)
  const modelPath = files.find(path => path.endsWith('model.bin'))
  assert.ok(modelPath)
  assert.deepEqual(await readFile(modelPath), bytes)
  assert.equal(files.filter(path => path.endsWith('installed.json')).length, 1)
  assert.equal(files.some(path => path.endsWith('.part')), false)

  await writeFile(modelPath, Buffer.from('x'.repeat(bytes.byteLength)))
  const manifest = manifestFor(origin, bytes)
  const repaired = await installModel({ manifest, modelId: 'fixture', cacheRoot })
  assert.equal(repaired.status, 'installed')
  assert.equal(requests, 2)
  assert.deepEqual(await readFile(modelPath), bytes)
})

test('installModel replaces a cache whose recorded files do not match the current lock', async t => {
  const modelBytes = Buffer.from('openphoto-model-fixture')
  const configBytes = Buffer.from('{"fixture":true}\n')
  const payloads = new Map([
    ['/model.bin', modelBytes],
    ['/config.json', configBytes]
  ])
  const { server, origin } = await startServer((request, response) => {
    const bytes = payloads.get(new URL(request.url, 'http://127.0.0.1').pathname)
    if (!bytes) {
      response.writeHead(404).end()
      return
    }
    response.end(bytes)
  })
  const cacheRoot = await mkdtemp(join(tmpdir(), 'openphoto-model-'))
  t.after(async () => {
    await closeServer(server)
    await rm(cacheRoot, { recursive: true, force: true })
  })
  const modelFile = {
    path: 'nested/model.bin',
    url: `${origin}/model.bin`,
    bytes: modelBytes.byteLength,
    sha256: sha256(modelBytes)
  }
  const configFile = {
    path: 'metadata/config.json',
    url: `${origin}/config.json`,
    bytes: configBytes.byteLength,
    sha256: sha256(configBytes)
  }
  const initial = {
    schemaVersion: 1,
    models: {
      fixture: {
        revision: 'fixture-revision',
        license: 'fixture-license',
        source: origin,
        files: [modelFile]
      }
    }
  }
  const current = {
    ...initial,
    models: {
      fixture: { ...initial.models.fixture, files: [modelFile, configFile] }
    }
  }

  await installModel({ manifest: initial, modelId: 'fixture', cacheRoot })
  const installed = await installModel({ manifest: current, modelId: 'fixture', cacheRoot })

  assert.deepEqual(installed.files, [
    { path: modelFile.path, bytes: modelFile.bytes, sha256: modelFile.sha256 },
    { path: configFile.path, bytes: configFile.bytes, sha256: configFile.sha256 }
  ])
  const files = await listFiles(cacheRoot)
  const configPath = files.find(path => path.endsWith(join('metadata', 'config.json')))
  assert.ok(configPath)
  assert.deepEqual(await readFile(configPath), configBytes)
})

test('installModel rejects a file whose SHA-256 does not match and cleans its temporary files', async t => {
  const bytes = Buffer.from('openphoto-model-fixture')
  const { server, origin } = await startServer((_, response) => response.end(bytes))
  const cacheRoot = await mkdtemp(join(tmpdir(), 'openphoto-model-'))
  t.after(async () => {
    await closeServer(server)
    await rm(cacheRoot, { recursive: true, force: true })
  })

  await assert.rejects(
    () => installModel({ manifest: manifestFor(origin, bytes, '0'.repeat(64)), modelId: 'fixture', cacheRoot }),
    { code: 'MODEL_DOWNLOAD_FAILED' }
  )
  const files = await listFiles(cacheRoot)
  assert.equal(files.some(path => path.endsWith('installed.json')), false)
  assert.equal(files.some(path => path.endsWith('.part')), false)
})

test('installModel preserves a checksum failure that wins before cancellation', async t => {
  const bytes = Buffer.from('openphoto-model-fixture')
  const { server, origin } = await startServer((_, response) => response.end(bytes))
  const cacheRoot = await mkdtemp(join(tmpdir(), 'openphoto-model-'))
  const store = new ModelStore({ cacheRoot })
  const cleanupFailedInstall = store.cleanupFailedInstall.bind(store)
  let releaseCleanup = () => {}
  const cleanupGate = new Promise(resolve => { releaseCleanup = resolve })
  let cleanupStarted
  const cleanupStartedPromise = new Promise(resolve => { cleanupStarted = resolve })
  store.cleanupFailedInstall = async (...args) => {
    cleanupStarted()
    await cleanupGate
    return cleanupFailedInstall(...args)
  }
  t.after(async () => {
    releaseCleanup()
    await closeServer(server)
    await rm(cacheRoot, { recursive: true, force: true })
  })

  const controller = new AbortController()
  const installing = installModel({
    manifest: manifestFor(origin, bytes, '0'.repeat(64)),
    modelId: 'fixture',
    cacheRoot,
    modelStore: store,
    signal: controller.signal
  })
  await cleanupStartedPromise
  controller.abort()
  releaseCleanup()

  await assert.rejects(installing, { code: 'MODEL_DOWNLOAD_FAILED' })
  const files = await listFiles(cacheRoot)
  assert.equal(files.some(path => path.endsWith('installed.json')), false)
  assert.equal(files.some(path => path.endsWith('.part')), false)
})

test('installModel reports cancellation and removes the in-progress download', async t => {
  const bytes = Buffer.from('openphoto-model-fixture')
  let response
  let resolveFirstChunk
  const firstChunk = new Promise(resolve => { resolveFirstChunk = resolve })
  const { server, origin } = await startServer((_, currentResponse) => {
    response = currentResponse
    currentResponse.write(bytes.subarray(0, 4))
    resolveFirstChunk()
  })
  const cacheRoot = await mkdtemp(join(tmpdir(), 'openphoto-model-'))
  t.after(async () => {
    response?.end()
    await closeServer(server)
    await rm(cacheRoot, { recursive: true, force: true })
  })

  const controller = new AbortController()
  const installing = installModel({ manifest: manifestFor(origin, bytes), modelId: 'fixture', cacheRoot, signal: controller.signal })
  await firstChunk
  await waitForPart(cacheRoot)
  controller.abort()

  await assert.rejects(installing, { code: 'CANCELLED' })
  const files = await listFiles(cacheRoot)
  assert.equal(files.some(path => path.endsWith('installed.json')), false)
  assert.equal(files.some(path => path.endsWith('.part')), false)
})

test('installModel removes the owner marker when cancellation wins right after beginInstall', async t => {
  const bytes = Buffer.from('openphoto-model-fixture')
  const { server, origin } = await startServer((_, response) => response.end(bytes))
  const cacheRoot = await mkdtemp(join(tmpdir(), 'openphoto-model-'))
  const controller = new AbortController()
  let leaseChecks = 0
  const assertLease = async () => {
    leaseChecks += 1
    if (leaseChecks === 3) controller.abort()
  }
  t.after(async () => {
    await closeServer(server)
    await rm(cacheRoot, { recursive: true, force: true })
  })

  await assert.rejects(
    () => installModel({ manifest: manifestFor(origin, bytes), modelId: 'fixture', cacheRoot, signal: controller.signal, assertLease }),
    { code: 'CANCELLED' }
  )
  const files = await listFiles(cacheRoot)
  assert.equal(files.some(path => path.endsWith('.openphoto-installing')), false)
})

test('installModel never publishes a model after its daemon lease is lost', async t => {
  const bytes = Buffer.from('openphoto-model-fixture')
  let response
  let resolveFirstChunk
  const firstChunk = new Promise(resolve => { resolveFirstChunk = resolve })
  const { server, origin } = await startServer((_, currentResponse) => {
    response = currentResponse
    currentResponse.write(bytes.subarray(0, 4))
    resolveFirstChunk()
  })
  const cacheRoot = await mkdtemp(join(tmpdir(), 'openphoto-model-'))
  t.after(async () => {
    response?.end()
    await closeServer(server)
    await rm(cacheRoot, { recursive: true, force: true })
  })

  let leaseLost = false
  const assertLease = async () => {
    if (leaseLost) throw Object.assign(new Error('daemon lease ownership was lost'), { code: 'RUNTIME_CRASH' })
  }
  const installing = installModel({ manifest: manifestFor(origin, bytes), modelId: 'fixture', cacheRoot, assertLease })
  await firstChunk
  await waitForPart(cacheRoot)
  leaseLost = true
  response.end(bytes.subarray(4))

  await assert.rejects(installing, { code: 'RUNTIME_CRASH' })
  const files = await listFiles(cacheRoot)
  assert.equal(files.some(path => path.endsWith('installed.json')), false)
  assert.equal(files.some(path => path.endsWith('.part')), false)
})

test('model-store cleanup is fenced to the installation token that owns it', async t => {
  const cacheRoot = await mkdtemp(join(tmpdir(), 'openphoto-model-'))
  const store = new ModelStore({ cacheRoot })
  t.after(() => rm(cacheRoot, { recursive: true, force: true }))

  const first = await store.beginInstall('fixture', 'fixture-revision', 'first-owner')
  const second = await store.beginInstall('fixture', 'fixture-revision', 'second-owner')
  await store.cleanupFailedInstall('fixture', 'fixture-revision', first.installToken)
  await access(join(second.installDir, '.openphoto-installing'))
  await store.cleanupFailedInstall('fixture', 'fixture-revision', second.installToken)
})

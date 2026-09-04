import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { OpenPhotoDaemon } from '../../../runtime/daemon.mjs'
import { PROTOCOL } from '../../../runtime/protocol.mjs'

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function encodedPath(path) {
  return `/${path.split('/').map(encodeURIComponent).join('/')}`
}

function routeManifest(lock) {
  return {
    schemaVersion: 1,
    transformersVersion: 'fixture',
    localModelPathTemplate: '{origin}/models/',
    requestPathTemplate: '/models/{modelId}/{path}',
    modelIdEncoding: 'path-segments',
    observations: Object.fromEntries(Object.entries(lock.models).map(([modelId, entry]) => [modelId, {
      revision: entry.revision,
      paths: entry.files.map(file => `/models/${modelId}/${file.path}`)
    }]))
  }
}

async function createFixtureModelServer(name) {
  const template = JSON.parse(await readFile(resolve(import.meta.dirname, '../../fixtures', name), 'utf8'))
  const files = new Map()
  for (const [modelId, entry] of Object.entries(template.models)) {
    for (const file of entry.files) {
      files.set(encodedPath(file.path), Buffer.from(`openphoto e2e fixture ${modelId} ${file.path}\n`))
    }
  }

  const server = createServer((request, response) => {
    const bytes = files.get(new URL(request.url, 'http://127.0.0.1').pathname)
    if (!bytes) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { 'content-length': bytes.byteLength, 'content-type': 'application/octet-stream' })
    response.end(request.method === 'HEAD' ? undefined : bytes)
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
        const bytes = files.get(encodedPath(file.path))
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
    route: routeManifest(manifest),
    async close() {
      await new Promise((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose()))
    }
  }
}

export async function createOpenPhotoTestClient({ modelLockFixture, testPipeline, dataRoot: suppliedDataRoot, cleanupDataRoot = suppliedDataRoot === undefined, modelStore } = {}) {
  const dataRoot = suppliedDataRoot ?? await mkdtemp(join(tmpdir(), 'openphoto-e2e-'))
  let fixture
  let daemon
  try {
    fixture = modelLockFixture === undefined ? undefined : await createFixtureModelServer(modelLockFixture)
    daemon = new OpenPhotoDaemon({
      dataRoot,
      ...(fixture === undefined ? {} : { modelManifest: fixture.manifest, modelRouteManifest: fixture.route }),
      ...(modelStore === undefined ? {} : { modelStore }),
      ...(testPipeline === undefined ? {} : { testPipeline })
    })
    await daemon.listen()
    return {
      dataRoot,
      async request(op, payload = {}, extras = {}) {
        const request = typeof op === 'object'
          ? { protocol: PROTOCOL, requestId: randomUUID(), ...op }
          : { protocol: PROTOCOL, requestId: randomUUID(), op, payload, ...extras }
        return daemon.dispatch(request)
      },
      async importFixture(name) {
        return this.request('artifact.import', { sourcePath: resolve(import.meta.dirname, '../../fixtures', name) })
      },
      async openFixture(name) {
        const imported = await this.importFixture(name)
        return this.request('document.open', { artifactId: imported.result.artifactId })
      },
      async readBytes(artifactId) {
        return daemon.artifacts.read(artifactId)
      },
      async close() {
        try {
          await daemon.close()
        } finally {
          await fixture?.close()
          if (cleanupDataRoot) await rm(dataRoot, { recursive: true, force: true })
        }
      }
    }
  } catch (error) {
    await daemon?.close().catch(() => {})
    await fixture?.close().catch(() => {})
    if (cleanupDataRoot) await rm(dataRoot, { recursive: true, force: true })
    throw error
  }
}

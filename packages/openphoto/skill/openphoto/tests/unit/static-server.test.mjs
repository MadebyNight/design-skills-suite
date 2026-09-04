import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { join, resolve } from 'node:path'
import { deriveModelRouteManifest, FIXED_MODELS, observationsFromRequests } from '../../../../scripts/probe-transformers-model-route.mjs'
import { createStaticServer, parseModelRoutePath } from '../../runtime/static-server.mjs'

test('static server serves rooted assets and rejects encoded traversal', async () => {
  const instance = createStaticServer({ assetRoot: resolve(import.meta.dirname, '../../assets') })
  const address = await instance.listen()
  try {
    assert.equal((await fetch(`${address.url}/openshop/index.html?openphoto=1`)).status, 200)
    assert.equal((await fetch(`${address.url}/..%2fpackage.json`)).status, 403)
  } finally {
    await instance.close()
  }
})

test('static server only exposes a verified installed model through the observed local route', async t => {
  const root = await mkdtemp(join(tmpdir(), 'openphoto-static-server-'))
  const assetRoot = join(root, 'assets')
  const installedDir = join(root, 'cache', 'installed')
  const bytes = Buffer.from('{"fixture":true}\n')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const observations = Object.fromEntries(Object.entries(FIXED_MODELS).map(([modelId, revision]) => [
    modelId,
    {
      revision,
      paths: [`/models/${modelId}/config.json`, `/models/${modelId}/preprocessor_config.json`]
    }
  ]))
  const manifest = deriveModelRouteManifest({ observations, transformersVersion: '4.0.0' })
  assert.equal(manifest.requestPathTemplate, '/models/{modelId}/{path}')
  assert.equal(manifest.modelIdEncoding, 'path-segments')
  const lock = {
    schemaVersion: 1,
    models: Object.fromEntries(Object.entries(FIXED_MODELS).map(([modelId, revision]) => [modelId, {
      revision,
      files: [
        { path: 'config.json', bytes: bytes.byteLength, sha256 },
        { path: 'preprocessor_config.json', bytes: bytes.byteLength, sha256 }
      ]
    }]))
  }
  const modelId = 'Xenova/modnet'
  const revision = FIXED_MODELS[modelId]
  await mkdir(assetRoot, { recursive: true })
  await mkdir(installedDir, { recursive: true })
  await Promise.all([
    writeFile(join(assetRoot, 'asset.txt'), 'asset stays available\n'),
    writeFile(join(installedDir, 'config.json'), bytes),
    writeFile(join(installedDir, 'preprocessor_config.json'), bytes),
    writeFile(join(installedDir, 'installed.json'), `${JSON.stringify({
      modelId,
      revision,
      files: lock.models[modelId].files
    })}\n`)
  ])
  const modelStore = {
    pathsFor(requestedModelId, requestedRevision) {
      assert.equal(requestedModelId, modelId)
      assert.equal(requestedRevision, revision)
      return { installedDir }
    }
  }
  const instance = createStaticServer({ assetRoot, modelRouting: { manifest, lock, modelStore } })
  const address = await instance.listen()
  t.after(async () => {
    await instance.close()
    await rm(root, { recursive: true, force: true })
  })

  assert.equal(address.modelLocalPath, `${address.url}/models/`)
  assert.deepEqual(parseModelRoutePath({ manifest, pathname: `/models/${modelId}/config.json` }), {
    modelId,
    revision,
    path: 'config.json'
  })
  assert.equal((await fetch(`${address.url}/asset.txt`)).status, 200)
  const modelResponse = await fetch(`${address.url}/models/${modelId}/config.json`)
  assert.equal(modelResponse.status, 200)
  assert.deepEqual(Buffer.from(await modelResponse.arrayBuffer()), bytes)
  const modelHead = await fetch(`${address.url}/models/${modelId}/config.json`, { method: 'HEAD' })
  assert.equal(modelHead.status, 200)
  assert.equal(modelHead.headers.get('content-length'), String(bytes.byteLength))
  assert.equal((await fetch(`${address.url}/models/${modelId}/preprocessor_config.json`)).status, 200)
  assert.equal((await fetch(`${address.url}/models/${modelId}/..%2fconfig.json`)).status, 404)

  await writeFile(join(installedDir, 'config.json'), Buffer.alloc(bytes.byteLength, 'x'))
  assert.equal((await fetch(`${address.url}/models/${modelId}/config.json`)).status, 404)

  await writeFile(join(installedDir, 'installed.json'), `${JSON.stringify({ modelId, revision: 'wrong-revision', files: lock.models[modelId].files })}\n`)
  assert.equal((await fetch(`${address.url}/models/${modelId}/config.json`)).status, 404)
})

test('static server rejects a route observation that is absent from the model lock', () => {
  const observations = Object.fromEntries(Object.entries(FIXED_MODELS).map(([modelId, revision]) => [
    modelId,
    { revision, paths: [`/models/${modelId}/config.json`, `/models/${modelId}/preprocessor_config.json`] }
  ]))
  const manifest = deriveModelRouteManifest({ observations, transformersVersion: '4.0.0' })
  const lock = {
    schemaVersion: 1,
    models: Object.fromEntries(Object.entries(FIXED_MODELS).map(([modelId, revision]) => [modelId, {
      revision,
      files: [{ path: 'config.json', bytes: 1, sha256: 'a'.repeat(64) }]
    }]))
  }
  assert.throws(() => createStaticServer({
    assetRoot: resolve(import.meta.dirname, '../../assets'),
    modelRouting: { manifest, lock, modelStore: { pathsFor() { return { installedDir: 'unused' } } } }
  }), /model route manifest does not match/)
})

test('route derivation records a revision only when the runtime observed one', () => {
  const observations = Object.fromEntries(Object.entries(FIXED_MODELS).map(([modelId, revision]) => [
    modelId,
    {
      revision,
      paths: [
        `/models/${modelId}/resolve/${revision}/config.json`,
        `/models/${modelId}/resolve/${revision}/preprocessor_config.json`
      ]
    }
  ]))
  const manifest = deriveModelRouteManifest({ observations, transformersVersion: 'fixture-version' })
  assert.equal(manifest.requestPathTemplate, '/models/{modelId}/resolve/{revision}/{path}')
  assert.deepEqual(parseModelRoutePath({
    manifest,
    pathname: `/models/Xenova/detr-resnet-50-panoptic/resolve/${FIXED_MODELS['Xenova/detr-resnet-50-panoptic']}/config.json`
  }), {
    modelId: 'Xenova/detr-resnet-50-panoptic',
    revision: FIXED_MODELS['Xenova/detr-resnet-50-panoptic'],
    path: 'config.json'
  })
})

test('route derivation supports placeholders before and between static route segments', () => {
  const observations = Object.fromEntries(Object.entries(FIXED_MODELS).map(([modelId, revision]) => [
    modelId,
    {
      revision,
      paths: [
        `/runtime/config.json/${modelId}/rev/${revision}`,
        `/runtime/preprocessor_config.json/${modelId}/rev/${revision}`
      ]
    }
  ]))
  const manifest = deriveModelRouteManifest({ observations, transformersVersion: 'fixture-version' })
  assert.equal(manifest.requestPathTemplate, '/runtime/{path}/{modelId}/rev/{revision}')
})

test('route probe classifies observed model IDs without assuming slash encoding', () => {
  const modelId = 'Xenova/modnet'
  const revision = FIXED_MODELS[modelId]
  const observations = observationsFromRequests([
    `/models/${encodeURIComponent(modelId)}/config.json`,
    `/models/${encodeURIComponent(modelId)}/preprocessor_config.json`,
    `/models/${encodeURIComponent('Xenova/depth-anything-small-hf')}/config.json`,
    `/models/${encodeURIComponent('Xenova/depth-anything-small-hf')}/preprocessor_config.json`,
    `/models/${encodeURIComponent('Xenova/detr-resnet-50')}/config.json`,
    `/models/${encodeURIComponent('Xenova/detr-resnet-50')}/preprocessor_config.json`,
    `/models/${encodeURIComponent('Xenova/detr-resnet-50-panoptic')}/config.json`,
    `/models/${encodeURIComponent('Xenova/detr-resnet-50-panoptic')}/preprocessor_config.json`
  ])
  assert.equal(observations[modelId].revision, revision)
  assert.deepEqual(observations[modelId].paths, [
    `/models/${encodeURIComponent(modelId)}/config.json`,
    `/models/${encodeURIComponent(modelId)}/preprocessor_config.json`
  ])
})

test('route probe ignores unrelated loopback asset requests while classifying model requests', () => {
  const modelId = 'Xenova/modnet'
  const revision = FIXED_MODELS[modelId]
  const observations = observationsFromRequests([
    '/probe.html',
    '/probe.mjs',
    '/transformers.min.js',
    `/models/${encodeURIComponent(modelId)}/config.json`,
    `/models/${encodeURIComponent(modelId)}/preprocessor_config.json`,
    `/models/${encodeURIComponent('Xenova/depth-anything-small-hf')}/config.json`,
    `/models/${encodeURIComponent('Xenova/depth-anything-small-hf')}/preprocessor_config.json`,
    `/models/${encodeURIComponent('Xenova/detr-resnet-50')}/config.json`,
    `/models/${encodeURIComponent('Xenova/detr-resnet-50')}/preprocessor_config.json`,
    `/models/${encodeURIComponent('Xenova/detr-resnet-50-panoptic')}/config.json`,
    `/models/${encodeURIComponent('Xenova/detr-resnet-50-panoptic')}/preprocessor_config.json`
  ])
  assert.equal(observations[modelId].revision, revision)
})

test('route probe rejects an unrecognized local model request', () => {
  const modelRequests = Object.keys(FIXED_MODELS).flatMap(modelId => [
    `/models/${encodeURIComponent(modelId)}/config.json`,
    `/models/${encodeURIComponent(modelId)}/preprocessor_config.json`
  ])
  assert.throws(
    () => observationsFromRequests([...modelRequests, '/models/unexpected-model/config.json']),
    /unknown model requests/
  )
})

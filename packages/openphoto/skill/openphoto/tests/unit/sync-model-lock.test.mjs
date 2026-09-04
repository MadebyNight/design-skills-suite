import assert from 'node:assert/strict'
import test from 'node:test'
import { collectModelLock, digestRuntimeFile, FIXED_MODELS } from '../../../../scripts/sync-model-lock.mjs'

function metadataResponse(value) {
  return { ok: true, status: 200, async json() { return value } }
}

function metadataFetch({ missingDigest = false, configWithoutDigest = false, missingLicense = false } = {}) {
  const requests = []
  const digestRequests = []
  const fetchImpl = async url => {
    requests.push(url)
    const repository = Object.keys(FIXED_MODELS).find(modelId => url.includes(`/models/${modelId}/`))
    if (repository && url.includes('/revision/')) {
      return metadataResponse({ cardData: { license: missingLicense && repository !== 'Xenova/modnet' ? undefined : 'apache-2.0' } })
    }
    if (repository && url.includes('/tree/')) {
      return metadataResponse([
        { type: 'file', path: '.gitattributes', size: 12 },
        { type: 'file', path: 'README.md', size: 12 },
        {
          type: 'file', path: 'config.json', size: 12,
          ...(configWithoutDigest ? {} : { lfs: { size: 12, oid: 'b'.repeat(64) } })
        },
        {
          type: 'file', path: 'preprocessor_config.json', size: 12,
          ...(configWithoutDigest ? {} : { lfs: { size: 12, oid: 'c'.repeat(64) } })
        },
        {
          type: 'file',
          path: 'onnx/model.onnx',
          size: 12,
          lfs: missingDigest ? { size: 12 } : { size: 12, oid: 'a'.repeat(64) }
        }
      ])
    }
    if (['LiheYoung/depth-anything-small-hf', 'facebook/detr-resnet-50', 'facebook/detr-resnet-50-panoptic']
      .some(modelId => url.endsWith(`/models/${modelId}`))) {
      return metadataResponse({ cardData: { license: 'apache-2.0' } })
    }
    throw new Error(`unexpected metadata URL: ${url}`)
  }
  const digestImpl = async ({ url, bytes }) => {
    digestRequests.push({ url, bytes })
    return 'd'.repeat(64)
  }
  return { fetchImpl, requests, digestImpl, digestRequests }
}

test('collectModelLock reads only repository metadata and derives explicit file URLs', async () => {
  const { fetchImpl, requests } = metadataFetch()
  const lock = await collectModelLock({ fetchImpl })

  assert.deepEqual(Object.keys(lock.models), Object.keys(FIXED_MODELS))
  assert.equal(requests.length, Object.keys(FIXED_MODELS).length * 2)
  assert.equal(requests.some(url => url.includes('/resolve/')), false)
  for (const [modelId, revision] of Object.entries(FIXED_MODELS)) {
    const model = lock.models[modelId]
    assert.equal(model.revision, revision)
    assert.equal(model.license, 'apache-2.0')
    assert.match(model.source, new RegExp(`/tree/${revision}$`))
    assert.deepEqual(model.files, [
      {
        path: 'config.json',
        bytes: 12,
        sha256: 'b'.repeat(64),
        url: `https://huggingface.co/${modelId}/resolve/${revision}/config.json`
      },
      {
        path: 'preprocessor_config.json',
        bytes: 12,
        sha256: 'c'.repeat(64),
        url: `https://huggingface.co/${modelId}/resolve/${revision}/preprocessor_config.json`
      },
      {
        path: 'onnx/model.onnx',
        bytes: 12,
        sha256: 'a'.repeat(64),
        url: `https://huggingface.co/${modelId}/resolve/${revision}/onnx/model.onnx`
      }
    ])
  }
})

test('collectModelLock refuses repository entries without a SHA-256', async () => {
  const { fetchImpl } = metadataFetch({ missingDigest: true })
  await assert.rejects(() => collectModelLock({ fetchImpl }), /SHA-256/)
})

test('collectModelLock refuses required runtime metadata without a SHA-256', async () => {
  const { fetchImpl, digestImpl } = metadataFetch({ configWithoutDigest: true })
  await assert.rejects(() => collectModelLock({
    fetchImpl,
    digestImpl: async args => {
      await digestImpl(args)
      return 'not-a-sha256'
    }
  }), /SHA-256/)
})

test('collectModelLock hashes only runtime JSON files when tree metadata lacks their digest', async () => {
  const { fetchImpl, digestImpl, digestRequests } = metadataFetch({ configWithoutDigest: true })
  const lock = await collectModelLock({ fetchImpl, digestImpl })

  assert.equal(digestRequests.length, Object.keys(FIXED_MODELS).length * 2)
  assert.ok(digestRequests.every(({ url }) => /\/(?:config|preprocessor_config)\.json$/u.test(url)))
  for (const model of Object.values(lock.models)) {
    assert.equal(model.files.find(file => file.path === 'config.json').sha256, 'd'.repeat(64))
    assert.equal(model.files.find(file => file.path === 'preprocessor_config.json').sha256, 'd'.repeat(64))
  }
})

test('collectModelLock resolves missing licenses from the documented upstream model metadata', async () => {
  const { fetchImpl } = metadataFetch({ missingLicense: true })
  const lock = await collectModelLock({ fetchImpl })
  assert.deepEqual(Object.values(lock.models).map(model => model.license), ['apache-2.0', 'apache-2.0', 'apache-2.0', 'apache-2.0'])
})

test('digestRuntimeFile cancels a response body when its declared size is exceeded', async () => {
  let cancelCalls = 0
  let releaseCalls = 0
  const body = {
    getReader() {
      return {
        async read() { return { done: false, value: Buffer.from('too-large') } },
        async cancel() { cancelCalls += 1 },
        releaseLock() { releaseCalls += 1 }
      }
    }
  }
  await assert.rejects(() => digestRuntimeFile({
    url: 'https://huggingface.co/Xenova/modnet/resolve/revision/config.json',
    bytes: 1,
    fetchImpl: async () => ({ ok: true, status: 200, body })
  }), /exceeds declared byte size/)
  assert.equal(cancelCalls, 1)
  assert.equal(releaseCalls, 1)
})

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { ModelStore } from '../../runtime/model-store.mjs'
import { createOpenPhotoTestClient } from './support/client.mjs'

const REQUIRED_MODELS = [
  ['background-remove', 'Xenova/modnet', {}],
  ['depth', 'Xenova/depth-anything-small-hf', {}],
  ['detect', 'Xenova/detr-resnet-50', {}],
  ['segment', 'Xenova/detr-resnet-50-panoptic', { point: { x: 0.5, y: 0.5 } }],
  ['upscale', null, { factor: 2 }]
]

function sleep(milliseconds) {
  return new Promise(resolveSleep => setTimeout(resolveSleep, milliseconds))
}

async function waitForAnalysis(client, jobId) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const response = await client.request('ai.job.get', { jobId })
    if (response.result?.status === 'completed') return response.result
    if (response.result?.status === 'failed') throw new Error(response.result.error?.message ?? 'local AI analysis failed')
    await sleep(100)
  }
  throw new Error('local AI analysis timed out')
}

test('real local AI adapters use only an already installed model cache', async () => {
  test.setTimeout(300_000)
  const cacheRoot = process.env.OPENPHOTO_REAL_AI_CACHE_ROOT
  test.skip(process.env.OPENPHOTO_REAL_AI !== '1', 'set OPENPHOTO_REAL_AI=1 to opt into real local AI verification')
  test.skip(!cacheRoot, 'set OPENPHOTO_REAL_AI_CACHE_ROOT to a cache containing all four locked models')

  const dataRoot = await mkdtemp(join(tmpdir(), 'openphoto-real-ai-'))
  let client
  try {
    const modelStore = new ModelStore({ dataRoot, cacheRoot })
    client = await createOpenPhotoTestClient({ dataRoot, cleanupDataRoot: true, modelStore })
    const status = await client.request('model.status')
    const missing = status.result.cache.filter(model => model.status !== 'installed').map(model => model.modelId)
    test.skip(missing.length > 0, `install locked models before this test: ${missing.join(', ')}`)

    for (const [capability, , extra] of REQUIRED_MODELS) {
      const opened = await client.openFixture('rgba-2x2.png')
      expect(opened.ok).toBeTruthy()
      const target = opened.result.descriptor.objects.find(object => object.type === 'image')
      expect(target).toBeTruthy()
      try {
        const started = await client.request({
          op: 'ai.analyze.start',
          documentId: opened.result.documentId,
          payload: { capability, objectId: target.objectId, sourceRevision: opened.result.revision, ...extra }
        })
        expect(started).toMatchObject({ ok: true, result: { jobId: expect.any(String) } })
        const completed = await waitForAnalysis(client, started.result.jobId)
        if (capability === 'detect') {
          expect(completed.result).toMatchObject({ kind: 'json', value: { boxes: expect.any(Array) } })
        } else {
          expect(completed.result).toMatchObject({ kind: 'raster', artifact: { artifactId: expect.any(String) } })
        }
        expect(completed.status).toBe('completed')
      } finally {
        await client.request({ op: 'document.close', documentId: opened.result.documentId, payload: {} })
      }
    }
  } finally {
    if (client) await client.close()
    else await rm(dataRoot, { recursive: true, force: true })
  }
})

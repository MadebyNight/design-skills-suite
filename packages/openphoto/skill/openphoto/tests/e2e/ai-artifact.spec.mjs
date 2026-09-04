import { withOpenPhoto } from './support/openphoto-test.mjs'

const MODEL_FOR_CAPABILITY = {
  'background-remove': 'Xenova/modnet',
  depth: 'Xenova/depth-anything-small-hf',
  detect: 'Xenova/detr-resnet-50',
  segment: 'Xenova/detr-resnet-50-panoptic'
}

const testPipeline = async ({ capability, input, point, factor }) => {
  const image = new Image()
  image.src = input.dataUrl
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = input.width
  canvas.height = input.height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('test canvas is unavailable')
  context.drawImage(image, 0, 0)

  if (capability === 'detect') {
    return { kind: 'json', value: { boxes: [{ label: 'fixture', score: 0.9, box: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } }] } }
  }
  if (capability === 'upscale') {
    if (factor !== 2 && factor !== 4) throw new Error('unexpected upscale factor')
    const output = document.createElement('canvas')
    output.width = input.width * factor
    output.height = input.height * factor
    const outputContext = output.getContext('2d')
    if (!outputContext) throw new Error('test output canvas is unavailable')
    outputContext.imageSmoothingEnabled = true
    outputContext.drawImage(canvas, 0, 0, output.width, output.height)
    return { kind: 'raster', dataUrl: output.toDataURL('image/png'), placement: 'replace-target' }
  }

  const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
  for (let index = 0; index < pixels.data.length; index += 4) {
    if (capability === 'background-remove') pixels.data[index + 3] = index === 0 ? 0 : 255
    if (capability === 'depth') {
      const value = 32 + index / 4 * 32
      pixels.data[index] = value
      pixels.data[index + 1] = value
      pixels.data[index + 2] = value
      pixels.data[index + 3] = 255
    }
    if (capability === 'segment') {
      const value = index === 0 ? 255 : 0
      pixels.data[index] = value
      pixels.data[index + 1] = value
      pixels.data[index + 2] = value
      pixels.data[index + 3] = 255
    }
  }
  context.putImageData(pixels, 0, 0)
  return {
    kind: 'raster',
    dataUrl: canvas.toDataURL('image/png'),
    placement: capability === 'depth' || capability === 'segment' ? 'add-above-target' : 'replace-target'
  }
}

const { test, expect } = withOpenPhoto({
  modelLockFixture: 'models.fixture.lock.json',
  testPipeline
})

function sleep(milliseconds) {
  return new Promise(resolveSleep => setTimeout(resolveSleep, milliseconds))
}

async function waitForInstall(client, installId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await client.request('model.status', { installId })
    expect(response.ok).toBeTruthy()
    const install = response.result.installs[0]
    if (install.status === 'installed') return install
    if (install.status === 'failed' || install.status === 'cancelled') {
      throw new Error(`fixture model installation ended as ${install.status}`)
    }
    await sleep(20)
  }
  throw new Error('fixture model installation did not finish')
}

async function waitForAnalysis(client, jobId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await client.request('ai.job.get', { jobId })
    expect(response.ok).toBeTruthy()
    if (response.result.status === 'completed') return response.result
    if (response.result.status === 'failed') throw new Error(`analysis failed: ${response.result.error?.message ?? 'unknown error'}`)
    await sleep(20)
  }
  throw new Error('analysis job did not finish')
}

async function openImageDocument(client) {
  const opened = await client.openFixture('rgba-2x2.png')
  expect(opened.ok).toBeTruthy()
  const target = opened.result.descriptor.objects.find(object => object.type === 'image')
  expect(target).toBeTruthy()
  return { ...opened.result, target }
}

async function rasterInfo(page, bytes) {
  return page.evaluate(async dataUrl => {
    const image = new Image()
    image.src = dataUrl
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('raster inspection canvas is unavailable')
    context.drawImage(image, 0, 0)
    return { width: canvas.width, height: canvas.height, pixels: [...context.getImageData(0, 0, canvas.width, canvas.height).data] }
  }, `data:image/png;base64,${bytes.toString('base64')}`)
}

test('AI artifacts require installed local models, remain immutable until explicit application, and preserve typed results', async ({ client, page }) => {
  test.setTimeout(120_000)
  const cases = [
    { capability: 'background-remove', expectedPlacement: 'replace-target' },
    { capability: 'depth', expectedPlacement: 'add-above-target' },
    { capability: 'detect' },
    { capability: 'segment', point: { x: 0.5, y: 0.5 }, expectedPlacement: 'add-above-target' },
    { capability: 'upscale', factor: 2, expectedPlacement: 'replace-target' },
    { capability: 'upscale', factor: 4, expectedPlacement: 'replace-target' }
  ]

  for (const item of cases) {
    const { documentId, revision, descriptor, target } = await openImageDocument(client)
    try {
      const stale = await client.request({
        op: 'ai.analyze.start', documentId,
        payload: { capability: 'upscale', objectId: target.objectId, sourceRevision: revision + 1, factor: 2 }
      })
      expect(stale.error?.code).toBe('REVISION_CONFLICT')

      const started = await client.request({
        op: 'ai.analyze.start', documentId,
        payload: {
          capability: item.capability,
          objectId: target.objectId,
          sourceRevision: revision,
          ...(item.point === undefined ? {} : { point: item.point }),
          ...(item.factor === undefined ? {} : { factor: item.factor })
        }
      })
      let jobId
      const modelId = MODEL_FOR_CAPABILITY[item.capability]
      if (modelId) {
        expect(started.ok).toBeFalsy()
        expect(started.error.code).toBe('MODEL_DOWNLOAD_REQUIRED')
        expect(started.error.details).toMatchObject({ jobId: expect.stringMatching(/^analysis-/u), modelId, revision: expect.stringMatching(/^fixture-/u) })
        jobId = started.error.details.jobId
        const waiting = await client.request('ai.job.get', { jobId })
        expect(waiting).toMatchObject({ ok: true, result: { jobId, status: 'waiting_for_model' } })
        const beforeInstall = await client.request({ op: 'document.inspect', documentId, payload: {} })
        expect(beforeInstall).toMatchObject({ ok: true, result: { revision } })
        const installation = await client.request('model.install', { modelId })
        expect(installation).toMatchObject({ ok: true, result: { modelId, installId: expect.any(String) } })
        await waitForInstall(client, installation.result.installId)
      } else {
        expect(started).toMatchObject({ ok: true, result: { jobId: expect.stringMatching(/^analysis-/u) } })
        jobId = started.result.jobId
      }

      const completed = await waitForAnalysis(client, jobId)
      expect(completed.jobId).toBe(jobId)
      const beforeApply = await client.request({ op: 'document.inspect', documentId, payload: {} })
      expect(beforeApply).toMatchObject({ ok: true, result: { revision } })

      if (item.capability === 'detect') {
        expect(completed.result).toEqual({
          kind: 'json',
          value: { boxes: [{ label: 'fixture', score: 0.9, box: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } }] }
        })
        expect(completed.result.artifact).toBeUndefined()
        continue
      }

      expect(completed.result).toMatchObject({
        kind: 'raster',
        artifact: { artifactId: expect.any(String), mimeType: 'image/png' },
        targetObjectId: target.objectId,
        placement: item.expectedPlacement
      })
      const output = await rasterInfo(page, await client.readBytes(completed.result.artifact.artifactId))
      if (item.capability === 'background-remove') expect(output.pixels[3]).toBe(0)
      if (item.capability === 'depth') {
        for (let index = 0; index < output.pixels.length; index += 4) {
          expect(output.pixels.slice(index, index + 3)[0]).toBe(output.pixels[index + 1])
          expect(output.pixels[index + 1]).toBe(output.pixels[index + 2])
          expect(output.pixels[index + 3]).toBe(255)
        }
      }
      if (item.capability === 'segment') {
        const values = new Set()
        for (let index = 0; index < output.pixels.length; index += 4) {
          expect(output.pixels[index]).toBe(output.pixels[index + 1])
          expect(output.pixels[index + 1]).toBe(output.pixels[index + 2])
          values.add(output.pixels[index])
        }
        expect([...values].sort()).toEqual([0, 255])
      }
      if (item.capability === 'upscale') {
        expect(output).toMatchObject({ width: 2 * item.factor, height: 2 * item.factor })
      }

      const applied = await client.request({
        op: 'document.applyArtifact', documentId, expectedRevision: revision,
        payload: {
          artifactId: completed.result.artifact.artifactId,
          targetObjectId: target.objectId,
          placement: completed.result.placement
        }
      })
      expect(applied).toMatchObject({ ok: true, result: { revision: revision + 1 } })
      const afterApply = await client.request({ op: 'document.inspect', documentId, payload: {} })
      const retained = afterApply.result.descriptor.objects.find(object => object.objectId === target.objectId)
      if (item.capability === 'upscale') {
        expect(retained?.bounds).toEqual({
          x: target.bounds.x,
          y: target.bounds.y,
          width: target.bounds.width * item.factor,
          height: target.bounds.height * item.factor
        })
      } else {
        expect(retained?.bounds).toEqual(target.bounds)
      }
      if (item.expectedPlacement === 'replace-target') {
        expect(afterApply.result.descriptor.objects).toHaveLength(descriptor.objects.length)
      } else {
        expect(afterApply.result.descriptor.objects).toHaveLength(descriptor.objects.length + 1)
      }
    } finally {
      await client.request({ op: 'document.close', documentId, payload: {} })
    }
  }
})

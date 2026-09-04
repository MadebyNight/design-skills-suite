import { inflateSync } from 'node:zlib'
import { withOpenPhoto } from './support/openphoto-test.mjs'

const { test, expect } = withOpenPhoto()

const OPERATIONS = [
  'runtime.health', 'runtime.capabilities', 'artifact.import', 'artifact.read',
  'document.open', 'document.inspect', 'document.mutate', 'document.renderArtifact', 'document.applyArtifact', 'document.close',
  'ai.analyze.start', 'ai.job.get',
  'model.status', 'model.install', 'model.install.cancel'
]

const COMMANDS = [
  'canvas.resize', 'canvas.crop', 'canvas.rotate', 'canvas.flip', 'canvas.flatten',
  'object.transform.set', 'object.rotate', 'object.flip', 'image.adjust', 'filter.apply'
]

function paeth(left, above, upperLeft) {
  const estimate = left + above - upperLeft
  const leftDistance = Math.abs(estimate - left)
  const aboveDistance = Math.abs(estimate - above)
  const upperLeftDistance = Math.abs(estimate - upperLeft)
  return leftDistance <= aboveDistance && leftDistance <= upperLeft ? left : aboveDistance <= upperLeft ? above : upperLeft
}

function pngHasTransparentPixel(bytes) {
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const chunks = []
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.subarray(offset + 4, offset + 8).toString('ascii')
    const start = offset + 8
    const end = start + length
    if (end + 4 > bytes.length) throw new Error('truncated PNG')
    if (type === 'IHDR') {
      width = bytes.readUInt32BE(start)
      height = bytes.readUInt32BE(start + 4)
      bitDepth = bytes[start + 8]
      colorType = bytes[start + 9]
      if (bytes[start + 12] !== 0) throw new Error('interlaced PNG is not supported by this test')
    } else if (type === 'IDAT') {
      chunks.push(bytes.subarray(start, end))
    }
    offset = end + 4
  }
  if (bitDepth !== 8 || ![4, 6].includes(colorType)) throw new Error('expected an 8-bit PNG with alpha')
  const channels = colorType === 6 ? 4 : 2
  const bytesPerPixel = channels
  const rowLength = width * channels
  const encoded = inflateSync(Buffer.concat(chunks))
  let cursor = 0
  let previous = Buffer.alloc(rowLength)
  for (let y = 0; y < height; y += 1) {
    const filter = encoded[cursor]
    cursor += 1
    const row = Buffer.from(encoded.subarray(cursor, cursor + rowLength))
    cursor += rowLength
    for (let x = 0; x < rowLength; x += 1) {
      const left = x >= bytesPerPixel ? row[x - bytesPerPixel] : 0
      const above = previous[x]
      const upperLeft = x >= bytesPerPixel ? previous[x - bytesPerPixel] : 0
      if (filter === 1) row[x] = (row[x] + left) & 0xff
      else if (filter === 2) row[x] = (row[x] + above) & 0xff
      else if (filter === 3) row[x] = (row[x] + Math.floor((left + above) / 2)) & 0xff
      else if (filter === 4) row[x] = (row[x] + paeth(left, above, upperLeft)) & 0xff
      else if (filter !== 0) throw new Error(`unsupported PNG filter ${filter}`)
    }
    for (let pixel = channels - 1; pixel < row.length; pixel += channels) {
      if (row[pixel] < 255) return true
    }
    previous = row
  }
  return false
}

async function firstFullyTransparentPixel(page, bytes) {
  return page.evaluate(async dataUrl => {
    const image = new Image()
    image.src = dataUrl
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const context = canvas.getContext('2d', { willReadFrequently: true })
    context.drawImage(image, 0, 0)
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        if (pixels[(y * canvas.width + x) * 4 + 3] === 0) return { x, y, width: canvas.width }
      }
    }
    throw new Error('source image has no transparent pixel')
  }, `data:image/png;base64,${bytes.toString('base64')}`)
}

async function imagePixel(page, bytes, x, y) {
  return page.evaluate(async ({ dataUrl, x, y }) => {
    const image = new Image()
    image.src = dataUrl
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const context = canvas.getContext('2d', { willReadFrequently: true })
    context.drawImage(image, 0, 0)
    return [...context.getImageData(x, y, 1, 1).data]
  }, { dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}`, x, y })
}

async function openFixture(client) {
  const input = await client.importFixture('rgba-2x2.png')
  expect(input.ok).toBeTruthy()
  const opened = await client.request({ op: 'document.open', payload: { artifactId: input.result.artifactId } })
  expect(opened.ok).toBeTruthy()
  const image = opened.result.descriptor.objects.find(object => object.imageState)
  expect(image).toBeTruthy()
  return { input: input.result, opened: opened.result, objectId: image.objectId }
}

async function closeDocument(client, documentId) {
  const closed = await client.request({ op: 'document.close', documentId, payload: {} })
  expect(closed).toMatchObject({ ok: true, result: { closed: true } })
}

test('document mutations require current revision and render PNG/JPEG artifacts', async ({ client, page }) => {
  const { input, opened } = await openFixture(client)
  try {
    const inspected = await client.request({ op: 'document.inspect', documentId: opened.documentId, payload: {} })
    const mutated = await client.request({
      op: 'document.mutate',
      documentId: opened.documentId,
      expectedRevision: inspected.result.revision,
      payload: { commands: [{ id: 'canvas.flip', args: { axis: 'h' } }] }
    })
    expect(mutated.ok).toBeTruthy()

    const png = await client.request({
      op: 'document.renderArtifact', documentId: opened.documentId, expectedRevision: mutated.result.revision, payload: { format: 'png' }
    })
    const jpg = await client.request({
      op: 'document.renderArtifact', documentId: opened.documentId, expectedRevision: mutated.result.revision, payload: { format: 'jpg' }
    })
    const explicitWhiteJpeg = await client.request({
      op: 'document.renderArtifact', documentId: opened.documentId, expectedRevision: mutated.result.revision,
      payload: { format: 'jpeg', quality: 0.92, matte: '#ffffff' }
    })
    const readBack = await client.request({ op: 'artifact.read', payload: { artifactId: png.result.artifact.artifactId } })
    expect(png.result.artifact.mimeType).toBe('image/png')
    expect(readBack.result.artifactId).toBe(png.result.artifact.artifactId)
    expect(jpg.result.artifact.mimeType).toBe('image/jpeg')
    expect(jpg.result.artifact.path).toMatch(/\.jpg$/iu)
    expect(explicitWhiteJpeg.result.artifact.artifactId).toBe(jpg.result.artifact.artifactId)
    expect(pngHasTransparentPixel(await client.readBytes(png.result.artifact.artifactId))).toBeTruthy()
    expect((await client.readBytes(jpg.result.artifact.artifactId)).subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]))
    const transparent = await firstFullyTransparentPixel(page, await client.readBytes(input.artifactId))
    const cropped = await client.request({
      op: 'document.mutate', documentId: opened.documentId, expectedRevision: mutated.result.revision,
      payload: { commands: [{ id: 'canvas.crop', args: { x: transparent.width - 1 - transparent.x, y: transparent.y, width: 1, height: 1 } }] }
    })
    expect(cropped.ok).toBeTruthy()
    const transparentJpeg = await client.request({
      op: 'document.renderArtifact', documentId: opened.documentId, expectedRevision: cropped.result.revision, payload: { format: 'jpeg' }
    })
    const jpegPixel = await imagePixel(page, await client.readBytes(transparentJpeg.result.artifact.artifactId), 0, 0)
    expect(jpegPixel[0]).toBeGreaterThanOrEqual(250)
    expect(jpegPixel[1]).toBeGreaterThanOrEqual(250)
    expect(jpegPixel[2]).toBeGreaterThanOrEqual(250)
    expect(jpegPixel[3]).toBe(255)

    const concurrent = await Promise.all([
      client.request({
        op: 'document.mutate', documentId: opened.documentId, expectedRevision: cropped.result.revision,
        payload: { commands: [{ id: 'canvas.flip', args: { axis: 'v' } }] }
      }),
      client.request({
        op: 'document.mutate', documentId: opened.documentId, expectedRevision: cropped.result.revision,
        payload: { commands: [{ id: 'canvas.flip', args: { axis: 'v' } }] }
      })
    ])
    expect(concurrent.filter(response => response.ok)).toHaveLength(1)
    expect(concurrent.filter(response => response.error?.code === 'REVISION_CONFLICT')).toHaveLength(1)

    const currentRevision = concurrent.find(response => response.ok).result.revision
    const missingObject = await client.request({
      op: 'document.mutate', documentId: opened.documentId, expectedRevision: currentRevision,
      payload: { commands: [{ id: 'object.rotate', args: { objectId: 'object-does-not-exist', degrees: 1 } }] }
    })
    expect(missingObject.error.code).toBe('NOT_FOUND')

    const staleMutation = await client.request({
      op: 'document.mutate', documentId: opened.documentId, expectedRevision: inspected.result.revision,
      payload: { commands: [{ id: 'canvas.flip', args: { axis: 'v' } }] }
    })
    const staleRender = await client.request({
      op: 'document.renderArtifact', documentId: opened.documentId, expectedRevision: inspected.result.revision, payload: { format: 'png' }
    })
    expect(staleMutation.error.code).toBe('REVISION_CONFLICT')
    expect(staleRender.error.code).toBe('REVISION_CONFLICT')
  } finally {
    await closeDocument(client, opened.documentId)
  }

  const inspectedAfterClose = await client.request({ op: 'document.inspect', documentId: opened.documentId, payload: {} })
  expect(inspectedAfterClose.error.code).toBe('NOT_FOUND')
})

test('document mutations expose only the white-listed OpenPhoto commands', async ({ client }) => {
  test.setTimeout(120_000)
  const capabilities = await client.request('runtime.capabilities')
  expect(capabilities.result.operations).toEqual(OPERATIONS)
  expect(capabilities.result.commands).toEqual(COMMANDS)

  const canvasCommands = [
    { id: 'canvas.resize', args: { width: 3, height: 3 } },
    { id: 'canvas.crop', args: { x: 0, y: 0, width: 1, height: 1 } },
    { id: 'canvas.rotate', args: { degrees: 90 } },
    { id: 'canvas.rotate', args: { degrees: -90 } },
    { id: 'canvas.rotate', args: { degrees: 180 } },
    { id: 'canvas.rotate', args: { degrees: -180 } },
    { id: 'canvas.flip', args: { axis: 'h' } },
    { id: 'canvas.flip', args: { axis: 'v' } },
    { id: 'canvas.flatten', args: {} }
  ]

  for (const command of canvasCommands) {
    const { opened } = await openFixture(client)
    try {
      const mutated = await client.request({
        op: 'document.mutate', documentId: opened.documentId, expectedRevision: opened.revision, payload: { commands: [command] }
      })
      expect(mutated.ok, command.id).toBeTruthy()
    } finally {
      await closeDocument(client, opened.documentId)
    }
  }

  const { opened, objectId } = await openFixture(client)
  try {
    const objectCommands = [
      { id: 'object.transform.set', args: { objectId, left: 2, top: 3, scaleX: 1, scaleY: 1, angle: 0, flipX: false, flipY: false } },
      { id: 'object.rotate', args: { objectId, degrees: 15 } },
      { id: 'object.flip', args: { objectId, axis: 'h' } },
      { id: 'object.flip', args: { objectId, axis: 'v' } },
      { id: 'image.adjust', args: { objectId, brightness: 0, contrast: 0, saturation: 0, hue: 0, blur: 0 } }
    ]
    let revision = opened.revision
    for (const command of objectCommands) {
      const mutated = await client.request({ op: 'document.mutate', documentId: opened.documentId, expectedRevision: revision, payload: { commands: [command] } })
      expect(mutated.ok, command.id).toBeTruthy()
      revision = mutated.result.revision
    }
    for (const name of ['Grayscale', 'Invert', 'Sepia', 'BlackWhite', 'Sharpen', 'Emboss']) {
      const mutated = await client.request({
        op: 'document.mutate', documentId: opened.documentId, expectedRevision: revision,
        payload: { commands: [{ id: 'filter.apply', args: { objectId, name } }] }
      })
      expect(mutated.ok, name).toBeTruthy()
      revision = mutated.result.revision
    }

    const malformed = await client.request({
      op: 'document.mutate', documentId: opened.documentId, expectedRevision: revision,
      payload: { commands: [{ id: 'image.adjust', args: { objectId, brightness: 101, contrast: 0, saturation: 0, hue: 0, blur: 0 } }] }
    })
    expect(malformed.error.code).toBe('INVALID_REQUEST')
    for (const id of ['layer.add', 'frame.add', 'macro.sequence', 'export.png', 'javascript.evaluate']) {
      const unsupported = await client.request({
        op: 'document.mutate', documentId: opened.documentId, expectedRevision: revision, payload: { commands: [{ id, args: {} }] }
      })
      expect(unsupported.error.code, id).toBe('UNSUPPORTED_CAPABILITY')
    }
  } finally {
    await closeDocument(client, opened.documentId)
  }
})

test('rasterizing canvas commands retain the primary image ID for later commands in one batch', async ({ client }) => {
  const { opened, objectId } = await openFixture(client)
  const rotateObject = () => ({ id: 'object.rotate', args: { objectId, degrees: 1 } })
  try {
    const mutated = await client.request({
      op: 'document.mutate',
      documentId: opened.documentId,
      expectedRevision: opened.revision,
      payload: {
        commands: [
          { id: 'canvas.crop', args: { x: 0, y: 0, width: 1, height: 1 } },
          rotateObject(),
          { id: 'canvas.rotate', args: { degrees: 90 } },
          rotateObject(),
          { id: 'canvas.flip', args: { axis: 'h' } },
          rotateObject(),
          { id: 'canvas.flatten', args: {} },
          rotateObject()
        ]
      }
    })
    expect(mutated.ok).toBeTruthy()
    expect(mutated.result.descriptor.objects).toEqual(expect.arrayContaining([
      expect.objectContaining({ objectId, type: 'image' })
    ]))
  } finally {
    await closeDocument(client, opened.documentId)
  }
})

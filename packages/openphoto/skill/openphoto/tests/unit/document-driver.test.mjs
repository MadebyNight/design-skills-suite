import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { DocumentDriver } from '../../runtime/document-driver.mjs'

const PNG = Buffer.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0,
  73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1
])
const DATA_URL = `data:image/png;base64,${PNG.toString('base64')}`

function artifactFor(bytes) {
  const artifactId = createHash('sha256').update(bytes).digest('hex')
  return { artifactId, sha256: artifactId, mimeType: 'image/png', byteSize: bytes.byteLength, width: 1, height: 1, path: `/${artifactId}.png` }
}

function createArtifacts() {
  const contents = new Map()
  const puts = []
  return {
    contents,
    puts,
    async read(artifactId) { return contents.get(artifactId) },
    async put(bytes, metadata, options) {
      const copy = Buffer.from(bytes)
      const artifact = artifactFor(copy)
      contents.set(artifact.artifactId, copy)
      puts.push({ bytes: copy, metadata, options, artifact })
      return artifact
    }
  }
}

test('DocumentDriver transfers analysis inputs and raster outputs through artifacts', async () => {
  const previous = process.env.NODE_ENV
  process.env.NODE_ENV = 'test'
  try {
    const artifacts = createArtifacts()
    const inputArtifact = artifactFor(PNG)
    artifacts.contents.set(inputArtifact.artifactId, PNG)
    const calls = []
    let browserOptions
    const page = {
      async waitForFunction() {},
      async evaluate(_callback, { method, value }) {
        calls.push({ method, value })
        const result = {
          open: { revision: 0 },
          captureInput: { dataUrl: DATA_URL, targetObjectId: 'image-1', width: 1, height: 1 },
          analyze: value.capability === 'detect'
            ? { kind: 'json', value: { boxes: [] } }
            : { kind: 'raster', dataUrl: DATA_URL, targetObjectId: 'image-1', placement: 'replace-target' },
          apply: { revision: 1, descriptor: { revision: 1 } }
        }[method]
        return { ok: true, result }
      }
    }
    const driver = new DocumentDriver({
      artifacts,
      createServer: () => ({
        async listen() { return { url: 'http://127.0.0.1:1234', modelLocalPath: 'http://127.0.0.1:1234/models/' } },
        async close() {}
      }),
      openBrowser: async options => {
        browserOptions = options
        return { page, async close() {} }
      },
      testPipeline: async () => ({ kind: 'json', value: { boxes: [] } })
    })

    await driver.open({ inputArtifact })
    const assertLease = async () => {}
    const captured = await driver.captureAnalysisInput({ objectId: 'image-1', assertLease })
    const raster = await driver.analyze({ capability: 'background-remove', inputArtifact: captured, model: { id: 'Xenova/modnet', revision: 'main', localModelPath: driver.modelLocalPath }, assertLease })
    const json = await driver.analyze({ capability: 'detect', inputArtifact: captured })
    const applied = await driver.applyArtifact({ expectedRevision: 0, artifact: raster.artifact, targetObjectId: raster.targetObjectId, placement: raster.placement })

    assert.equal(browserOptions.baseUrl, 'http://127.0.0.1:1234')
    assert.match(browserOptions.initScript, /__OPENPHOTO_TEST_PIPELINE__/u)
    assert.equal(driver.modelLocalPath, 'http://127.0.0.1:1234/models/')
    assert.deepEqual(calls.find(call => call.method === 'captureInput').value, { objectId: 'image-1' })
    assert.deepEqual(captured, { ...artifactFor(PNG), targetObjectId: 'image-1' })
    assert.deepEqual(calls.find(call => call.method === 'analyze').value.input, {
      dataUrl: DATA_URL,
      width: 1,
      height: 1,
      targetObjectId: 'image-1'
    })
    assert.equal(artifacts.puts.length, 2)
    assert.equal(artifacts.puts[0].options.assertLease, assertLease)
    assert.equal(artifacts.puts[1].options.assertLease, assertLease)
    assert.equal(raster.kind, 'raster')
    assert.deepEqual(json, { kind: 'json', value: { boxes: [] } })
    assert.deepEqual(calls.find(call => call.method === 'apply').value, {
      expectedRevision: 0,
      dataUrl: DATA_URL,
      targetObjectId: 'image-1',
      placement: 'replace-target'
    })
    assert.deepEqual(applied, { revision: 1, descriptor: { revision: 1 } })
    await driver.close()
    assert.equal(driver.modelLocalPath, null)
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previous
  }
})

test('DocumentDriver rejects testPipeline outside test mode', () => {
  const previous = process.env.NODE_ENV
  try {
    delete process.env.NODE_ENV
    assert.throws(
      () => new DocumentDriver({ artifacts: {}, testPipeline: async () => ({ kind: 'json', value: {} }) }),
      { code: 'INVALID_REQUEST' }
    )
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previous
  }
})

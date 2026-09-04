import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArtifactStore } from '../../runtime/artifact-store.mjs'

const TINY_PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

function artifactIdFor(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function assertNoPublishedArtifact(store, directory, artifactId) {
  await assert.rejects(() => store.describe(artifactId), /NOT_FOUND: artifact not found/u)
  assert.equal((await readdir(directory)).some(name => name.endsWith('.part')), false)
}

test('ArtifactStore returns content-addressed PNG metadata', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openphoto-artifacts-'))
  try {
    const store = new ArtifactStore(dir)
    const artifact = await store.put(TINY_PNG, { mimeType: 'image/png', width: 1, height: 1 })
    assert.equal(artifact.mimeType, 'image/png')
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/)
    assert.deepEqual(await store.describe(artifact.artifactId), artifact)
    assert.deepEqual(await store.read(artifact.artifactId), TINY_PNG)

    const png = Buffer.alloc(24)
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png)
    png.write('IHDR', 12, 'ascii')
    png.writeUInt32BE(2, 16)
    png.writeUInt32BE(3, 20)
    const sourcePath = join(dir, 'input.png')
    await writeFile(sourcePath, png)
    const imported = await store.import(sourcePath)
    assert.deepEqual({ width: imported.width, height: imported.height, mimeType: imported.mimeType }, { width: 2, height: 3, mimeType: 'image/png' })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('ArtifactStore removes an incomplete content write when its lease is lost', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openphoto-artifacts-'))
  try {
    const store = new ArtifactStore(dir)
    let checks = 0
    const assertLease = async () => {
      checks += 1
      if (checks === 3) throw Object.assign(new Error('daemon lease ownership was lost'), { code: 'RUNTIME_CRASH' })
    }

    await assert.rejects(
      () => store.put(TINY_PNG, {
        mimeType: 'image/png', width: 1, height: 1
      }, { assertLease }),
      { code: 'RUNTIME_CRASH' }
    )
    await assertNoPublishedArtifact(store, dir, artifactIdFor(TINY_PNG))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('ArtifactStore never publishes metadata when its lease is lost after writing it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openphoto-artifacts-'))
  try {
    const store = new ArtifactStore(dir)
    let checks = 0
    const assertLease = async () => {
      checks += 1
      if (checks === 5) throw Object.assign(new Error('daemon lease ownership was lost'), { code: 'RUNTIME_CRASH' })
    }

    await assert.rejects(
      () => store.put(TINY_PNG, {
        mimeType: 'image/png', width: 1, height: 1
      }, { assertLease }),
      { code: 'RUNTIME_CRASH' }
    )
    await assertNoPublishedArtifact(store, dir, artifactIdFor(TINY_PNG))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('ArtifactStore preserves a published artifact when its lease is lost after publication', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openphoto-artifacts-'))
  try {
    const oldStore = new ArtifactStore(dir)
    const newStore = new ArtifactStore(dir)
    let checks = 0
    let releaseFinalFence
    let finalFenceReached
    const finalFence = new Promise(resolve => { releaseFinalFence = resolve })
    const reached = new Promise(resolve => { finalFenceReached = resolve })
    const assertLease = async () => {
      checks += 1
      if (checks === 6) {
        finalFenceReached()
        await finalFence
        throw Object.assign(new Error('daemon lease ownership was lost'), { code: 'RUNTIME_CRASH' })
      }
    }

    const oldPut = oldStore.put(TINY_PNG, {
      mimeType: 'image/png', width: 1, height: 1
    }, { assertLease })
    await reached
    const newArtifact = await newStore.put(TINY_PNG, { mimeType: 'image/png', width: 1, height: 1 })
    releaseFinalFence()
    await assert.rejects(oldPut, { code: 'RUNTIME_CRASH' })
    assert.deepEqual(await newStore.describe(newArtifact.artifactId), newArtifact)
    assert.equal((await readdir(dir)).some(name => name.endsWith('.part')), false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('ArtifactStore serializes simultaneous writes for the same content hash', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openphoto-artifacts-'))
  try {
    const store = new ArtifactStore(dir)
    let checks = 0
    let releaseContentFence
    let contentFenceReached
    const contentFence = new Promise(resolve => { releaseContentFence = resolve })
    const reached = new Promise(resolve => { contentFenceReached = resolve })
    const assertLease = async () => {
      checks += 1
      if (checks === 3) {
        contentFenceReached()
        await contentFence
      }
    }

    const first = store.put(TINY_PNG, { mimeType: 'image/png', width: 1, height: 1 }, { assertLease })
    await reached
    const second = store.put(TINY_PNG, { mimeType: 'image/png', width: 1, height: 1 }, { assertLease })
    releaseContentFence()

    const [firstArtifact, secondArtifact] = await Promise.all([first, second])
    assert.deepEqual(secondArtifact, firstArtifact)
    assert.deepEqual(await store.describe(firstArtifact.artifactId), firstArtifact)
    assert.equal((await readdir(dir)).some(name => name.endsWith('.part')), false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

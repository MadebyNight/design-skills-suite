import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { importOpenShop } from '../../../../scripts/import-openshop.mjs'

const fixture = resolve(import.meta.dirname, '../fixtures/upstream/openshop')

test('importOpenShop copies the approved shell and records its source', async () => {
  const output = await mkdtemp(join(tmpdir(), 'openphoto-import-'))
  try {
    await importOpenShop({ sourceDir: fixture, outputDir: output, revision: 'fixture-revision', entries: ['index.html', 'LICENSE'] })
    assert.match(await readFile(join(output, 'index.html'), 'utf8'), /fixture shell/)
    assert.match(await readFile(join(output, 'LICENSE'), 'utf8'), /MIT/)
    assert.match(await readFile(join(output, 'UPSTREAM.json'), 'utf8'), /fixture-revision/)
  } finally {
    await rm(output, { recursive: true, force: true })
  }
})

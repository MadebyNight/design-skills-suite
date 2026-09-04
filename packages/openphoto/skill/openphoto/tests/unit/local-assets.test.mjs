import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const remote = /(cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com|huggingface\.co|\.hf\.co)/iu

test('OpenPhoto shell contains no runtime network origin', async () => {
  const files = ['assets/openshop/index.html', 'assets/openshop/sw.js']
  for (const relative of files) {
    const body = await readFile(resolve(root, relative), 'utf8')
    assert.doesNotMatch(body, remote, relative)
  }
})

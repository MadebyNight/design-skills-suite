import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  DEFAULT_SOURCE,
  auditReleaseFiles,
  copyRelease,
  listReleaseFiles,
  shouldInclude,
} from '../../../../scripts/package-skill.mjs'

test('发布列表包含入口并排除测试、缓存、浏览器、模型和临时文件', () => {
  const files = listReleaseFiles(DEFAULT_SOURCE)
  const audit = auditReleaseFiles(files)
  assert.equal(audit.ok, true, JSON.stringify(audit))
  assert.ok(files.includes('manifest.json'))
  assert.ok(files.every(shouldInclude))
  assert.ok(files.every(file => !/(^|\/)tests(\/|$)/.test(file)))
})

test('发布筛选规则拒绝已知非发布内容', () => {
  for (const file of [
    'node_modules/a.js', 'tests/a.mjs', 'test-results/a.json', '.openphoto/daemon.json',
    'playwright-report/index.html', 'browser-profile/Default', 'user-data/state.json',
    'models-cache/model.bin', 'models/model.onnx', 'models/model.safetensors', 'download.part',
    'chromium/chrome.exe',
  ]) assert.equal(shouldInclude(file), false, file)
})

test('复制到临时发布目录后可独立审计且自动清理', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openphoto-release-'))
  const output = path.join(tempRoot, 'openphoto')
  try {
    const result = copyRelease({ output })
    assert.equal(result.audit.ok, true)
    const copied = listReleaseFiles(output)
    assert.deepEqual(copied, result.files)
    assert.ok(fs.existsSync(path.join(output, 'bin', 'openphoto.mjs')))
    assert.ok(fs.existsSync(path.join(output, 'manifest.json')))
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

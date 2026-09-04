import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAttemptRoot, nextAttempt, isSafeItemId } from '../../runtime/attempt-root.mjs'

test('createAttemptRoot 创建 other/runtime/items/<id>/attempts/0001 并递增', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attempt-root-'))
  try {
    const a1 = createAttemptRoot(root, 'item-1', 1)
    assert.equal(a1, path.join(path.resolve(root), 'other', 'runtime', 'items', 'item-1', 'attempts', '0001'))
    assert.ok(fs.existsSync(a1))
    const a2 = createAttemptRoot(root, 'item-1', 2)
    assert.equal(a2, path.join(path.resolve(root), 'other', 'runtime', 'items', 'item-1', 'attempts', '0002'))
    assert.ok(fs.existsSync(a2))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('createAttemptRoot 已存在拒绝覆盖', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attempt-root-exists-'))
  try {
    createAttemptRoot(root, 'item-1', 1)
    assert.throws(() => createAttemptRoot(root, 'item-1', 1), /拒绝覆盖/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('createAttemptRoot 拒绝非法 itemId 与 attempt', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attempt-root-invalid-'))
  try {
    assert.throws(() => createAttemptRoot(root, '../escape', 1), /itemId 非法/)
    assert.throws(() => createAttemptRoot(root, 'a/b', 1), /itemId 非法/)
    assert.throws(() => createAttemptRoot(root, 'item-1', 0), /attempt 必须 >=1/)
    assert.throws(() => createAttemptRoot(root, 'item-1', 1.5), /attempt 必须 >=1/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('nextAttempt 计算已有最大 +1', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attempt-root-next-'))
  try {
    assert.equal(nextAttempt(root, 'item-1'), 1)
    createAttemptRoot(root, 'item-1', 1)
    createAttemptRoot(root, 'item-1', 3)
    assert.equal(nextAttempt(root, 'item-1'), 4)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('isSafeItemId 拒绝路径逃逸', () => {
  assert.equal(isSafeItemId('item-1'), true)
  assert.equal(isSafeItemId('a.b_c'), true)
  assert.equal(isSafeItemId('../escape'), false)
  assert.equal(isSafeItemId('a/b'), false)
  assert.equal(isSafeItemId(''), false)
  assert.equal(isSafeItemId('a b'), false)
})

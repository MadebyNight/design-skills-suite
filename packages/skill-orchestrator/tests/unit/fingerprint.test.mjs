import assert from 'node:assert/strict'
import test from 'node:test'
import { fingerprint, sanitizeProviderIdentity, normalizeBaseUrl, requestFingerprint, itemFingerprint } from '../../runtime/fingerprint.mjs'

test('fingerprint 稳定且不依赖 object key 顺序', () => {
  const a = fingerprint({ b: 1, a: { d: 2, c: 3 } })
  const b = fingerprint({ a: { c: 3, d: 2 }, b: 1 })
  assert.equal(a, b)
  assert.match(a, /^[a-f0-9]{64}$/)
})

test('fingerprint 不同内容结果不同', () => {
  assert.notEqual(fingerprint({ prompt: 'cat' }), fingerprint({ prompt: 'dog' }))
})

test('sanitizeProviderIdentity 不保存 URL / key / secret', () => {
  const identity = sanitizeProviderIdentity({
    id: 'openai-compatible',
    model: 'gpt-image-2',
    baseURL: 'https://user:secret@api.example.com:8443/v1?token=abc',
  })
  assert.equal(identity.id, 'openai-compatible')
  assert.equal(identity.model, 'gpt-image-2')
  assert.match(identity.baseUrlFingerprint, /^[a-f0-9]{64}$/)
  const serialized = JSON.stringify(identity)
  assert.equal(serialized.includes('secret'), false, '不得序列化 secret')
  assert.equal(serialized.includes('api.example.com'), false, '不得保存完整 URL')
  assert.equal(serialized.includes('token'), false, '不得保存查询参数')
})

test('baseUrlFingerprint 对协议/查询/尾斜杠不敏感，对 host/path 敏感', () => {
  const a = sanitizeProviderIdentity({ id: 'x', model: 'm', baseURL: 'https://api.example.com/v1?token=1' })
  const b = sanitizeProviderIdentity({ id: 'x', model: 'm', baseURL: 'http://api.example.com/v1/' })
  assert.equal(a.baseUrlFingerprint, b.baseUrlFingerprint)
  const c = sanitizeProviderIdentity({ id: 'x', model: 'm', baseURL: 'https://other.example.com/v1' })
  assert.notEqual(a.baseUrlFingerprint, c.baseUrlFingerprint)
})

test('requestFingerprint / itemFingerprint 稳定', () => {
  const req = { id: 'r1', theme: 'cat' }
  assert.equal(requestFingerprint(req), requestFingerprint({ theme: 'cat', id: 'r1' }))
  assert.equal(itemFingerprint({ itemId: 'i1' }), itemFingerprint({ itemId: 'i1' }))
})

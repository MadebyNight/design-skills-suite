// 协议层测试：输入校验与稳定错误码。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeAssetRequest, ProtocolError, validateAssetResult } from '../runtime/protocol.mjs'
import { validRequest } from './fixtures/valid-request.mjs'

test('合法对象输入通过', () => {
  const req = normalizeAssetRequest(validRequest)
  assert.equal(req.id, 'asset-req-001')
  assert.equal(req.targetWidth, 1920)
})

test('合法 JSON 字符串输入通过', () => {
  const req = normalizeAssetRequest(JSON.stringify(validRequest))
  assert.equal(req.id, 'asset-req-001')
})

test('非法 JSON 抛出 INVALID_JSON', () => {
  assert.throws(() => normalizeAssetRequest('{not json'), (e) => {
    assert.ok(e instanceof ProtocolError)
    assert.equal(e.code, 'INVALID_JSON')
    return true
  })
})

test('非对象输入抛出 INVALID_ASSET_REQUEST', () => {
  assert.throws(() => normalizeAssetRequest(42), (e) => e.code === 'INVALID_ASSET_REQUEST')
  assert.throws(() => normalizeAssetRequest(null), (e) => e.code === 'INVALID_ASSET_REQUEST')
})

test('缺少必填字段抛出 INVALID_ASSET', () => {
  const bad = { ...validRequest }
  delete bad.targetWidth
  assert.throws(() => normalizeAssetRequest(bad), (e) => {
    assert.equal(e.code, 'INVALID_ASSET')
    assert.ok(e.details.length > 0)
    return true
  })
})

test('未声明字段被拒绝（additionalProperties）', () => {
  const bad = { ...validRequest, extra: 'x' }
  assert.throws(() => normalizeAssetRequest(bad), (e) => e.code === 'INVALID_ASSET')
})

test('AssetResult 契约校验接口可用', () => {
  const good = {
    assetRequestId: 'asset-req-001',
    artifactId: 'home-hero-gen',
    path: 'artifacts/home-hero-gen.png',
    mimeType: 'image/png',
    width: 1,
    height: 1,
    sha256: 'a'.repeat(64),
    sourceSkill: 'skill-image-generate',
    sourceSkillVersion: '0.1.0',
    strictSizeSatisfied: false,
    notes: ['provider: test-provider'],
  }
  assert.deepEqual(validateAssetResult(good), [])
  const bad = { ...good, sha256: 'short' }
  assert.ok(validateAssetResult(bad).length > 0)
})

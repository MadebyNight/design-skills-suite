import assert from 'node:assert/strict'
import test from 'node:test'
import { requestSchema, responseError } from '../../runtime/protocol.mjs'

test('mutation requires document id and expected revision', () => {
  assert.throws(() => requestSchema({ protocol: 'openphoto/v1', requestId: 'req-1', op: 'document.mutate', payload: {} }), /documentId/)
  assert.throws(() => requestSchema({ protocol: 'openphoto/v1', requestId: 'req-1', op: 'document.mutate', documentId: 'doc-1', payload: {} }), /expectedRevision/)
})

test('errors have a stable machine code', () => {
  assert.deepEqual(responseError('req-1', 'REVISION_CONFLICT', 'document changed').error.code, 'REVISION_CONFLICT')
})

test('model payloads reject unknown fields and conflicting selectors', () => {
  assert.throws(() => requestSchema({
    protocol: 'openphoto/v1', requestId: 'req-model-1', op: 'model.install', payload: { modelId: 'Xenova/modnet', extra: true }
  }), /unknown fields/)
  assert.throws(() => requestSchema({
    protocol: 'openphoto/v1', requestId: 'req-model-2', op: 'model.status', payload: { modelId: 'Xenova/modnet', installId: 'install-1' }
  }), /mutually exclusive/)
})

test('analysis and explicit artifact application have constrained payloads', () => {
  assert.throws(() => requestSchema({
    protocol: 'openphoto/v1', requestId: 'req-ai-no-document', op: 'ai.analyze.start',
    payload: { capability: 'depth', objectId: 'object-1', sourceRevision: 0 }
  }), /documentId/)
  assert.doesNotThrow(() => requestSchema({
    protocol: 'openphoto/v1', requestId: 'req-ai-1', op: 'ai.analyze.start', documentId: 'doc-1',
    payload: { capability: 'segment', objectId: 'object-1', sourceRevision: 0, point: { x: 0.5, y: 0.25 } }
  }))
  assert.throws(() => requestSchema({
    protocol: 'openphoto/v1', requestId: 'req-ai-2', op: 'ai.analyze.start', documentId: 'doc-1',
    payload: { capability: 'upscale', objectId: 'object-1', sourceRevision: 0, factor: 3 }
  }), /factor/)
  assert.throws(() => requestSchema({
    protocol: 'openphoto/v1', requestId: 'req-ai-3', op: 'ai.analyze.start', documentId: 'doc-1',
    payload: { capability: 'depth', objectId: 'object-1', sourceRevision: 0, extra: true }
  }), /unknown fields/)
  assert.throws(() => requestSchema({
    protocol: 'openphoto/v1', requestId: 'req-apply-1', op: 'document.applyArtifact', documentId: 'doc-1', expectedRevision: 0,
    payload: { artifactId: 'a'.repeat(64), targetObjectId: 'object-1' }
  }), /placement/)
})

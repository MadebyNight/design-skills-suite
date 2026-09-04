import assert from 'node:assert/strict'
import test from 'node:test'
import { COMMAND_IDS, normalizeCommand, normalizeCommands } from '../../runtime/command-schema.mjs'

const accepted = [
  { id: 'canvas.resize', args: { width: 2, height: 3 } },
  { id: 'canvas.crop', args: { x: 0, y: 0, width: 2, height: 3 } },
  { id: 'canvas.rotate', args: { degrees: 90 } },
  { id: 'canvas.flip', args: { axis: 'h' } },
  { id: 'canvas.flatten', args: {} },
  { id: 'object.transform.set', args: { objectId: 'object-1', left: 1, top: 2, scaleX: 1, scaleY: 1, angle: 0, flipX: false, flipY: false } },
  { id: 'object.rotate', args: { objectId: 'object-1', degrees: -12.5 } },
  { id: 'object.flip', args: { objectId: 'object-1', axis: 'v' } },
  { id: 'image.adjust', args: { objectId: 'object-1', brightness: 0, contrast: 0, saturation: 0, hue: 0, blur: 0 } },
  { id: 'filter.apply', args: { objectId: 'object-1', name: 'Sharpen' } }
]

function throwsCode(callback, code) {
  assert.throws(callback, error => error?.code === code)
}

test('command schema exposes and normalizes exactly the ten allowed commands', () => {
  assert.deepEqual(COMMAND_IDS, accepted.map(command => command.id))
  assert.deepEqual(normalizeCommands(accepted), accepted)
})

test('command schema rejects invalid canvas arguments and command fields', () => {
  throwsCode(() => normalizeCommand({ id: 'canvas.resize', args: { width: 0, height: 1 } }), 'INVALID_REQUEST')
  throwsCode(() => normalizeCommand({ id: 'canvas.resize', args: { width: 1.5, height: 1 } }), 'INVALID_REQUEST')
  throwsCode(() => normalizeCommand({ id: 'canvas.resize', args: { width: 30_001, height: 1 } }), 'INVALID_REQUEST')
  throwsCode(() => normalizeCommand({ id: 'canvas.resize', args: { width: 30_000, height: 30_000 } }), 'INVALID_REQUEST')
  throwsCode(() => normalizeCommand({ id: 'canvas.crop', args: { x: 0, y: 0, width: -1, height: 1 } }), 'INVALID_REQUEST')
  throwsCode(() => normalizeCommand({ id: 'canvas.crop', args: { x: -30_001, y: 0, width: 1, height: 1 } }), 'INVALID_REQUEST')
  throwsCode(() => normalizeCommand({ id: 'canvas.crop', args: { x: 0, y: 0, width: 30_001, height: 1 } }), 'INVALID_REQUEST')
  throwsCode(() => normalizeCommand({ id: 'canvas.crop', args: { x: 0, y: 0, width: 30_000, height: 30_000 } }), 'INVALID_REQUEST')
  throwsCode(() => normalizeCommand({ id: 'canvas.rotate', args: { degrees: 45 } }), 'INVALID_REQUEST')
  throwsCode(() => normalizeCommand({ id: 'canvas.flip', args: { axis: 'diagonal' } }), 'INVALID_REQUEST')
  throwsCode(() => normalizeCommand({ id: 'canvas.flatten', args: { ignored: true } }), 'INVALID_REQUEST')
  throwsCode(() => normalizeCommand({ id: 'canvas.flip', args: { axis: 'h' }, arbitrary: true }), 'INVALID_REQUEST')
})

test('command schema rejects invalid object, adjustment, and filter arguments', () => {
  throwsCode(() => normalizeCommand({ id: 'object.transform.set', args: { objectId: 'object-1', left: 0, top: 0, scaleX: 0, scaleY: 1, angle: 0, flipX: false, flipY: false } }), 'INVALID_REQUEST')
  throwsCode(() => normalizeCommand({ id: 'object.transform.set', args: { objectId: 'object-1', left: 0, top: 0, scaleX: 1, scaleY: -1, angle: 0, flipX: false, flipY: false } }), 'INVALID_REQUEST')
  throwsCode(() => normalizeCommand({ id: 'object.transform.set', args: { objectId: 'object-1', left: 300_001, top: 0, scaleX: 1, scaleY: 1, angle: 0, flipX: false, flipY: false } }), 'INVALID_REQUEST')
  throwsCode(() => normalizeCommand({ id: 'object.transform.set', args: { objectId: 'object-1', left: 0, top: 0, scaleX: 1_001, scaleY: 1, angle: 0, flipX: false, flipY: false } }), 'INVALID_REQUEST')
  throwsCode(() => normalizeCommand({ id: 'object.transform.set', args: { objectId: 'object-1', left: 0, top: 0, scaleX: 1, scaleY: 1, angle: 36_001, flipX: false, flipY: false } }), 'INVALID_REQUEST')
  throwsCode(() => normalizeCommand({ id: 'object.rotate', args: { objectId: '', degrees: 1 } }), 'INVALID_REQUEST')
  throwsCode(() => normalizeCommand({ id: 'object.rotate', args: { objectId: 'object-1', degrees: 3_601 } }), 'INVALID_REQUEST')
  throwsCode(() => normalizeCommand({ id: 'object.flip', args: { objectId: 'object-1', axis: 'x' } }), 'INVALID_REQUEST')
  throwsCode(() => normalizeCommand({ id: 'image.adjust', args: { objectId: 'object-1', brightness: 0, contrast: 0, saturation: 0, hue: 0 } }), 'INVALID_REQUEST')
  throwsCode(() => normalizeCommand({ id: 'image.adjust', args: { objectId: 'object-1', brightness: 101, contrast: 0, saturation: 0, hue: 0, blur: 0 } }), 'INVALID_REQUEST')
  throwsCode(() => normalizeCommand({ id: 'image.adjust', args: { objectId: 'object-1', brightness: 0, contrast: 0, saturation: 0, hue: -181, blur: 0 } }), 'INVALID_REQUEST')
  throwsCode(() => normalizeCommand({ id: 'filter.apply', args: { objectId: 'object-1', name: 'Blur' } }), 'INVALID_REQUEST')
  throwsCode(() => normalizeCommand({ id: 'filter.apply', args: { objectId: 'object-1', name: 'Invert', extra: true } }), 'INVALID_REQUEST')
})

test('command schema keeps unsupported capabilities out of the bridge input', () => {
  for (const id of ['layer.add', 'frame.add', 'macro.sequence', 'export.png', 'javascript.evaluate']) {
    throwsCode(() => normalizeCommand({ id, args: {} }), 'UNSUPPORTED_CAPABILITY')
  }
  throwsCode(() => normalizeCommands([]), 'INVALID_REQUEST')
  throwsCode(() => normalizeCommands(Array.from({ length: 21 }, () => accepted[0])), 'INVALID_REQUEST')
})

test('command schema accepts the OpenShop numeric boundaries', () => {
  assert.deepEqual(normalizeCommand({ id: 'canvas.resize', args: { width: 30_000, height: 1 } }).args, { width: 30_000, height: 1 })
  assert.deepEqual(normalizeCommand({ id: 'canvas.crop', args: { x: -30_000, y: 30_000, width: 30_000, height: 1 } }).args, {
    x: -30_000, y: 30_000, width: 30_000, height: 1
  })
  assert.deepEqual(normalizeCommand({ id: 'object.transform.set', args: {
    objectId: 'object-1', left: -300_000, top: 300_000, scaleX: 1_000, scaleY: 1_000, angle: -36_000, flipX: false, flipY: false
  }}).args, {
    objectId: 'object-1', left: -300_000, top: 300_000, scaleX: 1_000, scaleY: 1_000, angle: -36_000, flipX: false, flipY: false
  })
  assert.equal(normalizeCommand({ id: 'object.rotate', args: { objectId: 'object-1', degrees: 3_600 } }).args.degrees, 3_600)
})

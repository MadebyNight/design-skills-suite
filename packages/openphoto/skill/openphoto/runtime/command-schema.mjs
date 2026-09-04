export const COMMAND_IDS = Object.freeze([
  'canvas.resize', 'canvas.crop', 'canvas.rotate', 'canvas.flip', 'canvas.flatten',
  'object.transform.set', 'object.rotate', 'object.flip',
  'image.adjust', 'filter.apply'
])

const COMMAND_SET = new Set(COMMAND_IDS)
const FILTER_NAMES = new Set(['Grayscale', 'Invert', 'Sepia', 'BlackWhite', 'Sharpen', 'Emboss'])
const MAX_IMAGE_DIMENSION = 30_000
const MAX_IMAGE_PIXELS = 80_000_000
const MAX_OBJECT_POSITION = MAX_IMAGE_DIMENSION * 10
const MAX_OBJECT_SCALE = 1_000
const MAX_OBJECT_ANGLE = 36_000
const MAX_OBJECT_ROTATION = 3_600

function schemaError(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code })
}

function invalid(message) {
  throw schemaError('INVALID_REQUEST', message)
}

function unsupported(message) {
  throw schemaError('UNSUPPORTED_CAPABILITY', message)
}

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}

function exactObject(value, required, label) {
  if (!isPlainObject(value)) invalid(`${label} must be a plain object`)
  const keys = Object.keys(value)
  if (!required.every(key => Object.hasOwn(value, key)) || keys.some(key => !required.includes(key))) {
    invalid(`${label} has missing or unknown fields`)
  }
  return value
}

function finiteNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(`${label} must be a finite number`)
  return value
}

function positiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) invalid(`${label} must be a positive safe integer`)
  return value
}

function positiveNumber(value, label) {
  finiteNumber(value, label)
  if (value <= 0) invalid(`${label} must be greater than zero`)
  return value
}

function boundedPositiveNumber(value, label, max) {
  positiveNumber(value, label)
  if (value > max) invalid(`${label} must be at most ${max}`)
  return value
}

function boundedPositiveSafeInteger(value, label, max) {
  positiveSafeInteger(value, label)
  if (value > max) invalid(`${label} must be at most ${max}`)
  return value
}

function boundedRasterSize(width, height, label) {
  if (Math.round(width) * Math.round(height) > MAX_IMAGE_PIXELS) {
    invalid(`${label} must not exceed ${MAX_IMAGE_PIXELS} pixels`)
  }
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) invalid(`${label} is required`)
  return value
}

function boolean(value, label) {
  if (typeof value !== 'boolean') invalid(`${label} must be a boolean`)
  return value
}

function axis(value, label = 'axis') {
  if (value !== 'h' && value !== 'v') invalid(`${label} must be h or v`)
  return value
}

function bounded(value, label, min, max) {
  finiteNumber(value, label)
  if (value < min || value > max) invalid(`${label} must be between ${min} and ${max}`)
  return value
}

function objectId(value) {
  return nonEmptyString(value, 'objectId')
}

function normalizeArgs(id, args) {
  switch (id) {
    case 'canvas.resize': {
      exactObject(args, ['width', 'height'], 'canvas.resize.args')
      const width = boundedPositiveSafeInteger(args.width, 'width', MAX_IMAGE_DIMENSION)
      const height = boundedPositiveSafeInteger(args.height, 'height', MAX_IMAGE_DIMENSION)
      boundedRasterSize(width, height, 'canvas.resize')
      return { width, height }
    }
    case 'canvas.crop': {
      exactObject(args, ['x', 'y', 'width', 'height'], 'canvas.crop.args')
      const x = bounded(args.x, 'x', -MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION)
      const y = bounded(args.y, 'y', -MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION)
      const width = boundedPositiveNumber(args.width, 'width', MAX_IMAGE_DIMENSION)
      const height = boundedPositiveNumber(args.height, 'height', MAX_IMAGE_DIMENSION)
      boundedRasterSize(width, height, 'canvas.crop')
      return { x, y, width, height }
    }
    case 'canvas.rotate': {
      exactObject(args, ['degrees'], 'canvas.rotate.args')
      if (![90, -90, 180, -180].includes(args.degrees)) invalid('degrees must be 90, -90, 180, or -180')
      return { degrees: args.degrees }
    }
    case 'canvas.flip': {
      exactObject(args, ['axis'], 'canvas.flip.args')
      return { axis: axis(args.axis) }
    }
    case 'canvas.flatten':
      exactObject(args, [], 'canvas.flatten.args')
      return {}
    case 'object.transform.set': {
      exactObject(args, ['objectId', 'left', 'top', 'scaleX', 'scaleY', 'angle', 'flipX', 'flipY'], 'object.transform.set.args')
      return {
        objectId: objectId(args.objectId),
        left: bounded(args.left, 'left', -MAX_OBJECT_POSITION, MAX_OBJECT_POSITION),
        top: bounded(args.top, 'top', -MAX_OBJECT_POSITION, MAX_OBJECT_POSITION),
        scaleX: boundedPositiveNumber(args.scaleX, 'scaleX', MAX_OBJECT_SCALE),
        scaleY: boundedPositiveNumber(args.scaleY, 'scaleY', MAX_OBJECT_SCALE),
        angle: bounded(args.angle, 'angle', -MAX_OBJECT_ANGLE, MAX_OBJECT_ANGLE),
        flipX: boolean(args.flipX, 'flipX'),
        flipY: boolean(args.flipY, 'flipY')
      }
    }
    case 'object.rotate': {
      exactObject(args, ['objectId', 'degrees'], 'object.rotate.args')
      return { objectId: objectId(args.objectId), degrees: bounded(args.degrees, 'degrees', -MAX_OBJECT_ROTATION, MAX_OBJECT_ROTATION) }
    }
    case 'object.flip': {
      exactObject(args, ['objectId', 'axis'], 'object.flip.args')
      return { objectId: objectId(args.objectId), axis: axis(args.axis) }
    }
    case 'image.adjust': {
      exactObject(args, ['objectId', 'brightness', 'contrast', 'saturation', 'hue', 'blur'], 'image.adjust.args')
      return {
        objectId: objectId(args.objectId),
        brightness: bounded(args.brightness, 'brightness', -100, 100),
        contrast: bounded(args.contrast, 'contrast', -100, 100),
        saturation: bounded(args.saturation, 'saturation', -100, 100),
        hue: bounded(args.hue, 'hue', -180, 180),
        blur: bounded(args.blur, 'blur', 0, 100)
      }
    }
    case 'filter.apply': {
      exactObject(args, ['objectId', 'name'], 'filter.apply.args')
      const name = nonEmptyString(args.name, 'name')
      if (!FILTER_NAMES.has(name)) invalid('name is not a supported filter')
      return { objectId: objectId(args.objectId), name }
    }
    default:
      unsupported(`command is not supported: ${id}`)
  }
}

export function normalizeCommand(command) {
  if (!isPlainObject(command)) invalid('command must be a plain object')
  if (!Object.hasOwn(command, 'id') || !Object.hasOwn(command, 'args') || Object.keys(command).some(key => !['id', 'args'].includes(key))) {
    invalid('command has missing or unknown fields')
  }
  if (typeof command.id !== 'string' || !COMMAND_SET.has(command.id)) unsupported(`command is not supported: ${String(command.id)}`)
  return { id: command.id, args: normalizeArgs(command.id, command.args) }
}

export function normalizeCommands(commands) {
  if (!Array.isArray(commands) || commands.length < 1 || commands.length > 20) {
    invalid('commands must contain 1 to 20 entries')
  }
  return commands.map(normalizeCommand)
}

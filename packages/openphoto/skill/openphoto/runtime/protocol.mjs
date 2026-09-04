export const PROTOCOL = 'openphoto/v1'
export const OPERATIONS = new Set([
  'runtime.health', 'runtime.capabilities',
  'artifact.import', 'artifact.read',
  'document.open', 'document.inspect', 'document.mutate', 'document.renderArtifact', 'document.applyArtifact', 'document.close',
  'ai.analyze.start', 'ai.job.get',
  'model.status', 'model.install', 'model.install.cancel'
])
export const ERROR_CODES = new Set([
  'INVALID_REQUEST', 'UNSUPPORTED_CAPABILITY', 'NOT_FOUND', 'REVISION_CONFLICT',
  'BUSY', 'CANCELLED', 'TIMEOUT', 'RESOURCE_LIMIT', 'RUNTIME_CRASH',
  'BROWSER_NOT_FOUND', 'BROWSER_UNSUPPORTED', 'MODEL_DOWNLOAD_REQUIRED',
  'MODEL_DOWNLOAD_FAILED', 'MODEL_MANIFEST_INCOMPLETE', 'MODEL_NOT_INSTALLED_OFFLINE',
  'ARTIFACT_INVALID', 'FORMAT_UNSUPPORTED'
])

const MUTATION_OPERATIONS = new Set(['document.mutate', 'document.renderArtifact', 'document.applyArtifact'])
const DOCUMENT_OPERATIONS = new Set(['document.inspect', 'document.mutate', 'document.renderArtifact', 'document.applyArtifact', 'document.close', 'ai.analyze.start'])

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

function nonEmptyString(value, field) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${field} is required`)
}

function artifactId(value, field = 'artifactId') {
  nonEmptyString(value, field)
}

function onlyFields(payload, fields) {
  if (Object.keys(payload).some(field => !fields.includes(field))) {
    throw new Error('payload contains unknown fields')
  }
}

export function responseError(requestId, code, message, details) {
  if (!ERROR_CODES.has(code)) throw new Error(`unknown error code: ${code}`)
  return { requestId, ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } }
}

export function requestSchema(value) {
  if (!isPlainObject(value) || value.protocol !== PROTOCOL || typeof value.requestId !== 'string' || value.requestId.length === 0 || typeof value.op !== 'string') {
    throw new Error('protocol, requestId and op are required')
  }
  if (!OPERATIONS.has(value.op)) throw new Error(`unsupported operation: ${value.op}`)
  if (!isPlainObject(value.payload)) throw new Error('payload must be a plain object')
  if (DOCUMENT_OPERATIONS.has(value.op)) nonEmptyString(value.documentId, 'documentId')
  if (MUTATION_OPERATIONS.has(value.op) && (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0)) {
    throw new Error('expectedRevision is required')
  }

  const { payload } = value
  switch (value.op) {
    case 'artifact.import':
      nonEmptyString(payload.sourcePath, 'sourcePath')
      break
    case 'artifact.read':
    case 'document.open':
      artifactId(payload.artifactId)
      break
    case 'document.mutate':
      if (!Array.isArray(payload.commands)) throw new Error('commands is required')
      break
    case 'document.renderArtifact':
      nonEmptyString(payload.format, 'format')
      break
    case 'document.applyArtifact':
      onlyFields(payload, ['artifactId', 'targetObjectId', 'placement'])
      artifactId(payload.artifactId)
      nonEmptyString(payload.targetObjectId, 'targetObjectId')
      if (!['replace-target', 'add-above-target'].includes(payload.placement)) {
        throw new Error('placement is invalid')
      }
      break
    case 'ai.analyze.start':
      onlyFields(payload, ['capability', 'objectId', 'sourceRevision', 'point', 'factor'])
      nonEmptyString(payload.capability, 'capability')
      nonEmptyString(payload.objectId, 'objectId')
      if (!Number.isSafeInteger(payload.sourceRevision) || payload.sourceRevision < 0) throw new Error('sourceRevision is required')
      if (payload.point !== undefined) {
        if (!isPlainObject(payload.point) || Object.keys(payload.point).some(field => !['x', 'y'].includes(field))
          || !Number.isFinite(payload.point.x) || !Number.isFinite(payload.point.y)
          || payload.point.x < 0 || payload.point.x > 1 || payload.point.y < 0 || payload.point.y > 1) {
          throw new Error('point must contain normalized x and y coordinates')
        }
      }
      if (payload.factor !== undefined && (![2, 4].includes(payload.factor))) throw new Error('factor must be 2 or 4')
      break
    case 'ai.job.get':
      onlyFields(payload, ['jobId'])
      nonEmptyString(payload.jobId, 'jobId')
      break
    case 'model.install':
      onlyFields(payload, ['modelId'])
      nonEmptyString(payload.modelId, 'modelId')
      break
    case 'model.install.cancel':
      onlyFields(payload, ['installId'])
      nonEmptyString(payload.installId, 'installId')
      break
    case 'model.status': {
      onlyFields(payload, ['modelId', 'installId'])
      const selectors = ['modelId', 'installId'].filter(key => payload[key] !== undefined)
      if (selectors.length > 1) throw new Error('modelId and installId are mutually exclusive')
      if (selectors.length === 1) nonEmptyString(payload[selectors[0]], selectors[0])
      break
    }
    default:
      break
  }
  return value
}

import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { locateBrowser } from '../skill/openphoto/runtime/browser.mjs'
import { parseModelRoutePath } from '../skill/openphoto/runtime/static-server.mjs'

export const FIXED_MODELS = Object.freeze({
  'Xenova/modnet': 'fa2fa546052fba4c08921230a26cc69a333fca12',
  'Xenova/depth-anything-small-hf': '2e942621ab9f2371c1df9eb223291b5ac31475e6',
  'Xenova/detr-resnet-50': '8be7ab59ff663484ee9ba2e8d8f267330d5ad03e',
  'Xenova/detr-resnet-50-panoptic': 'ea24b2d4e0bfae31f0a1299ba3fb892a2df064de'
})

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function encodeModelId(modelId, encoding) {
  if (encoding === 'path-segments') return modelId.split('/').map(encodeURIComponent).join('/')
  if (encoding === 'url-component') return encodeURIComponent(modelId)
  throw new Error('unsupported model ID encoding')
}

function encodePath(path) {
  if (typeof path !== 'string' || !path || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..' || part.includes('\\'))) {
    throw new Error('invalid model file path')
  }
  return path.split('/').map(encodeURIComponent).join('/')
}

function decodePath(path) {
  if (typeof path !== 'string' || !path) return null
  let parts
  try {
    parts = path.split('/').map(part => decodeURIComponent(part))
  } catch {
    return null
  }
  if (parts.some(part => !part || part === '.' || part === '..' || part.includes('/') || part.includes('\\'))) return null
  return parts.join('/')
}

function countOccurrences(value, needle) {
  let count = 0
  let index = value.indexOf(needle)
  while (index >= 0) {
    count += 1
    index = value.indexOf(needle, index + needle.length)
  }
  return count
}

function pathForTemplate({ requestPathTemplate, modelIdEncoding, modelId, revision, path }) {
  return requestPathTemplate
    .replace('{modelId}', encodeModelId(modelId, modelIdEncoding))
    .replace('{revision}', encodeURIComponent(revision))
    .replace('{path}', encodePath(path))
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\[\]\\]/gu, '\\$&')
}

function occurrences(value, needle) {
  const result = []
  let offset = value.indexOf(needle)
  while (offset >= 0) {
    result.push({ start: offset, end: offset + needle.length })
    offset = value.indexOf(needle, offset + needle.length)
  }
  return result
}

function pathBoundaries(pathname) {
  const boundaries = new Set([0, pathname.length])
  for (let index = 0; index < pathname.length; index += 1) {
    if (pathname[index] === '/') {
      boundaries.add(index)
      boundaries.add(index + 1)
    }
  }
  return [...boundaries].sort((left, right) => left - right)
}

function replaceIntervals(pathname, intervals) {
  const sorted = [...intervals].sort((left, right) => left.start - right.start)
  let cursor = 0
  let result = ''
  for (const interval of sorted) {
    if (interval.start < cursor || interval.end <= interval.start) return null
    result += pathname.slice(cursor, interval.start)
    result += interval.token
    cursor = interval.end
  }
  return result + pathname.slice(cursor)
}

function templateMatcher(template, { modelId, revision, modelIdEncoding }) {
  let cursor = 0
  let pattern = '^'
  let pathGroups = 0
  const tokenPattern = /\{modelId\}|\{revision\}|\{path\}/gu
  for (const match of template.matchAll(tokenPattern)) {
    pattern += escapeRegExp(template.slice(cursor, match.index))
    if (match[0] === '{modelId}') pattern += escapeRegExp(encodeModelId(modelId, modelIdEncoding))
    else if (match[0] === '{revision}') pattern += escapeRegExp(encodeURIComponent(revision))
    else {
      pathGroups += 1
      pattern += '(.+)'
    }
    cursor = match.index + match[0].length
  }
  pattern += escapeRegExp(template.slice(cursor))
  if (pathGroups !== 1) return null
  return new RegExp(`${pattern}$`, 'u')
}

function validateTemplate(template, observations, modelIdEncoding) {
  if (countOccurrences(template, '{modelId}') !== 1 || countOccurrences(template, '{path}') !== 1) return null
  const revisionObserved = Object.entries(observations).some(([modelId, observation]) => {
    const encodedRevision = encodeURIComponent(observation.revision)
    return observation.paths.some(pathname => pathname.includes(encodedRevision))
  })
  if (revisionObserved !== template.includes('{revision}')) return null

  let capturedLength = 0
  for (const [modelId, observation] of Object.entries(observations)) {
    const matcher = templateMatcher(template, { modelId, revision: observation.revision, modelIdEncoding })
    if (!matcher) return null
    for (const pathname of observation.paths) {
      const match = matcher.exec(pathname)
      if (!match) return null
      const path = decodePath(match[1])
      if (!path || pathForTemplate({ requestPathTemplate: template, modelIdEncoding, modelId, revision: observation.revision, path }) !== pathname) return null
      capturedLength += match[1].length
    }
  }
  return { capturedLength }
}

function templateForEncoding(observations, modelIdEncoding) {
  const candidates = new Map()
  for (const [anchorModelId, anchorObservation] of Object.entries(observations)) {
    const encodedModelId = encodeModelId(anchorModelId, modelIdEncoding)
    const encodedRevision = encodeURIComponent(anchorObservation.revision)
    for (const pathname of anchorObservation.paths) {
      const modelIntervals = occurrences(pathname, encodedModelId)
      const revisionIntervals = occurrences(pathname, encodedRevision)
      if (modelIntervals.length !== 1 || revisionIntervals.length > 1) continue
      const tokenIntervals = [
        { ...modelIntervals[0], token: '{modelId}' },
        ...(revisionIntervals.length ? [{ ...revisionIntervals[0], token: '{revision}' }] : [])
      ]
      const boundaries = pathBoundaries(pathname)
      for (const start of boundaries) {
        for (const end of boundaries) {
          if (end <= start || tokenIntervals.some(interval => start < interval.end && end > interval.start)) continue
          const template = replaceIntervals(pathname, [...tokenIntervals, { start, end, token: '{path}' }])
          if (!template) continue
          const validation = validateTemplate(template, observations, modelIdEncoding)
          if (validation) candidates.set(template, validation.capturedLength)
        }
      }
    }
  }
  if (!candidates.size) return null
  // The variable must represent the complete relative file path. Choosing the
  // shortest valid capture keeps shared route prefixes/suffixes out of it.
  const bestLength = Math.min(...candidates.values())
  const best = [...candidates.entries()].filter(([, capturedLength]) => capturedLength === bestLength)
  if (best.length !== 1) return null
  return { requestPathTemplate: best[0][0], modelIdEncoding }
}

export function deriveModelRouteManifest({ observations, transformersVersion }) {
  if (!isPlainObject(observations)) throw new Error('model route observations are required')
  if (typeof transformersVersion !== 'string' || !transformersVersion) throw new Error('Transformers.js version is required')
  const expectedIds = Object.keys(FIXED_MODELS)
  if (Object.keys(observations).length !== expectedIds.length || expectedIds.some(modelId => !isPlainObject(observations[modelId]))) {
    throw new Error('model route observations do not cover the fixed models')
  }
  for (const [modelId, revision] of Object.entries(FIXED_MODELS)) {
    const observation = observations[modelId]
    if (observation.revision !== revision || !Array.isArray(observation.paths) || observation.paths.length === 0
      || observation.paths.some(path => typeof path !== 'string' || !path.startsWith('/'))) {
      throw new Error(`model route observation is incomplete: ${modelId}`)
    }
  }

  const candidates = ['path-segments', 'url-component']
    .map(modelIdEncoding => templateForEncoding(observations, modelIdEncoding))
    .filter(Boolean)
  if (candidates.length !== 1) throw new Error('could not uniquely derive the Transformers.js model route')

  const manifest = {
    schemaVersion: 1,
    transformersVersion,
    localModelPathTemplate: '{origin}/models/',
    requestPathTemplate: candidates[0].requestPathTemplate,
    modelIdEncoding: candidates[0].modelIdEncoding,
    observations
  }
  for (const [modelId, observation] of Object.entries(observations)) {
    for (const pathname of observation.paths) {
      const parsed = parseModelRoutePath({ manifest, pathname })
      if (!parsed || parsed.modelId !== modelId || parsed.revision !== observation.revision) {
        throw new Error(`could not parse observed model route: ${pathname}`)
      }
      const regenerated = pathForTemplate({
        requestPathTemplate: manifest.requestPathTemplate,
        modelIdEncoding: manifest.modelIdEncoding,
        modelId: parsed.modelId,
        revision: parsed.revision,
        path: parsed.path
      })
      if (regenerated !== pathname) throw new Error(`could not regenerate observed model route: ${pathname}`)
    }
  }
  return manifest
}

function probeModuleSource() {
  return `import { AutoModel, AutoProcessor, env } from './transformers.min.js'

env.allowLocalModels = true
env.allowRemoteModels = false
env.localModelPath = location.origin + '/models/'
env.useBrowserCache = false

const models = ${JSON.stringify(Object.entries(FIXED_MODELS))}
for (const [modelId, revision] of models) {
  for (const loader of [AutoModel, AutoProcessor]) {
    try {
      await loader.from_pretrained(modelId, { revision })
    } catch {
      // Every model route deliberately returns 404. The request itself is the probe result.
    }
  }
}
window.__openphotoRouteProbeDone = { transformersVersion: env.version }
`
}

async function closeServer(server) {
  if (!server?.listening) return
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()))
}

async function prepareProbeRoot({ root, aiRuntimeDir }) {
  await mkdir(root, { recursive: true })
  await Promise.all([
    copyFile(resolve(aiRuntimeDir, 'transformers.min.js'), resolve(root, 'transformers.min.js')),
    writeFile(resolve(root, 'probe.html'), '<!doctype html><script type="module" src="/probe.mjs"></script>\n'),
    writeFile(resolve(root, 'probe.mjs'), probeModuleSource())
  ])
}

function createProbeServer({ root, requests }) {
  const files = new Map([
    ['/probe.html', 'probe.html'],
    ['/probe.mjs', 'probe.mjs'],
    ['/transformers.min.js', 'transformers.min.js']
  ])
  return createServer(async (request, response) => {
    if (!request.url || request.method !== 'GET') {
      response.writeHead(405).end('method not allowed')
      return
    }
    let pathname
    try {
      pathname = new URL(request.url, 'http://127.0.0.1').pathname
    } catch {
      response.writeHead(400).end('bad request')
      return
    }
    requests.push(pathname)
    if (pathname.startsWith('/models/')) {
      response.writeHead(404).end('missing model fixture')
      return
    }
    const file = files.get(pathname)
    if (!file) {
      response.writeHead(404).end('not found')
      return
    }
    try {
      const bytes = await readFile(resolve(root, file))
      response.writeHead(200, { 'content-type': file.endsWith('.mjs') || file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8' })
      response.end(bytes)
    } catch {
      response.writeHead(500).end('probe asset unavailable')
    }
  })
}

function modelIdMatchesPath(pathname, modelId, encoding) {
  const encoded = encodeModelId(modelId, encoding)
  if (encoding === 'path-segments') {
    return pathname === `/${encoded}` || pathname.startsWith(`/${encoded}/`) || pathname.includes(`/${encoded}/`)
  }
  return pathname.split('/').some(segment => {
    try {
      return decodeURIComponent(segment) === modelId
    } catch {
      return false
    }
  })
}

export function observationsFromRequests(requests) {
  if (!Array.isArray(requests) || requests.some(path => typeof path !== 'string' || !path.startsWith('/'))) {
    throw new Error('model route probe requests are invalid')
  }
  const modelRequests = requests.filter(pathname => Object.keys(FIXED_MODELS).some(modelId =>
    ['path-segments', 'url-component'].some(encoding => modelIdMatchesPath(pathname, modelId, encoding))))
  const unknownModelRequests = requests.filter(pathname => pathname.startsWith('/models/') && !modelRequests.includes(pathname))
  if (unknownModelRequests.length) {
    throw new Error(`model route probe observed unknown model requests: ${unknownModelRequests.join(', ')}`)
  }
  if (!modelRequests.length) throw new Error('model route probe observed no fixed model requests')
  const candidates = ['path-segments', 'url-component'].map(encoding => {
    const observations = Object.fromEntries(Object.entries(FIXED_MODELS).map(([modelId, revision]) => [modelId, { revision, paths: [] }]))
    const unmatched = []
    for (const pathname of modelRequests) {
      const matches = Object.keys(FIXED_MODELS).filter(modelId => modelIdMatchesPath(pathname, modelId, encoding))
      if (matches.length !== 1) unmatched.push(pathname)
      else observations[matches[0]].paths.push(pathname)
    }
    if (unmatched.length || Object.values(observations).some(observation => observation.paths.length === 0)) return null
    for (const observation of Object.values(observations)) observation.paths = [...new Set(observation.paths)]
    return { encoding, observations }
  }).filter(Boolean)
  if (candidates.length !== 1) throw new Error('model route probe could not uniquely classify model requests')
  return candidates[0].observations
}

export async function probeTransformersModelRoute({ aiRuntimeDir, outputPath }) {
  const runtimeDir = resolve(aiRuntimeDir)
  const manifestPath = resolve(outputPath)
  const skillRoot = resolve(runtimeDir, '../..')
  const requireFromSkill = createRequire(resolve(skillRoot, 'package.json'))
  const { chromium } = requireFromSkill('playwright-core')
  const profileRoot = await mkdtemp(join(tmpdir(), 'openphoto-route-probe-'))
  if (!basename(profileRoot).startsWith('openphoto-route-probe-')) throw new Error('invalid probe temporary directory')

  let server
  let browser
  try {
    await prepareProbeRoot({ root: profileRoot, aiRuntimeDir: runtimeDir })
    const requests = []
    server = createProbeServer({ root: profileRoot, requests })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('model route probe did not bind a TCP port')
    const origin = `http://127.0.0.1:${address.port}`
    const browserInfo = await locateBrowser()
    browser = await chromium.launch({ executablePath: browserInfo.executablePath, headless: true })
    const page = await browser.newPage()
    const externalRequests = []
    page.on('request', request => {
      const url = new URL(request.url())
      if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== origin) externalRequests.push(url.href)
    })
    await page.goto(`${origin}/probe.html`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => Boolean(window.__openphotoRouteProbeDone), undefined, { timeout: 30_000 })
    if (externalRequests.length) throw new Error(`model route probe attempted external requests: ${externalRequests.join(', ')}`)

    const transformersVersion = await page.evaluate(() => window.__openphotoRouteProbeDone?.transformersVersion)
    const manifest = deriveModelRouteManifest({ observations: observationsFromRequests(requests), transformersVersion })
    await mkdir(dirname(manifestPath), { recursive: true })
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    return manifest
  } finally {
    try {
      await browser?.close()
    } finally {
      try {
        await closeServer(server)
      } finally {
        await rm(profileRoot, { recursive: true, force: true })
      }
    }
  }
}

async function main() {
  const [aiRuntimeDir, outputPath] = process.argv.slice(2)
  if (!aiRuntimeDir || !outputPath) throw new Error('usage: probe-transformers-model-route <ai-runtime-dir> <model-route.json>')
  const manifest = await probeTransformersModelRoute({ aiRuntimeDir, outputPath })
  console.log(`model route manifest verified (${Object.keys(manifest.observations).length} models)`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) void main()

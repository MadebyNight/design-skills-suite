import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve, sep } from 'node:path'

const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.wasm', 'application/wasm'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.woff2', 'font/woff2']
])

function contentType(path) {
  const extension = path.slice(path.lastIndexOf('.')).toLowerCase()
  return MIME_TYPES.get(extension) ?? 'application/octet-stream'
}

function isInside(root, candidate) {
  return candidate.startsWith(`${root}${sep}`) || candidate === root
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertRelativeModelPath(value) {
  if (typeof value !== 'string' || !value) throw new Error('model file path is required')
  const parts = value.split('/')
  if (parts.some(part => !part || part === '.' || part === '..' || part.includes('\\') || part.includes('/'))) {
    throw new Error('model file path is invalid')
  }
  return value
}

function encodePath(value) {
  return assertRelativeModelPath(value).split('/').map(encodeURIComponent).join('/')
}

function encodeModelId(modelId, encoding) {
  if (typeof modelId !== 'string' || !modelId) throw new Error('modelId is required')
  if (encoding === 'path-segments') return modelId.split('/').map(encodeURIComponent).join('/')
  if (encoding === 'url-component') return encodeURIComponent(modelId)
  throw new Error('unsupported model ID encoding')
}

function assertRouteManifest(manifest) {
  if (!isPlainObject(manifest) || manifest.schemaVersion !== 1) throw new Error('model route manifest is invalid')
  if (typeof manifest.transformersVersion !== 'string' || !manifest.transformersVersion) {
    throw new Error('model route manifest has no Transformers.js version')
  }
  if (typeof manifest.localModelPathTemplate !== 'string' || !manifest.localModelPathTemplate.includes('{origin}')) {
    throw new Error('model route manifest has no local model path template')
  }
  if (typeof manifest.requestPathTemplate !== 'string' || !manifest.requestPathTemplate.startsWith('/')) {
    throw new Error('model route manifest has no request path template')
  }
  for (const field of ['{modelId}', '{path}']) {
    if (manifest.requestPathTemplate.split(field).length !== 2) {
      throw new Error(`model route template must contain one ${field}`)
    }
  }
  if (manifest.requestPathTemplate.split('{revision}').length > 2) {
    throw new Error('model route template contains multiple revisions')
  }
  if (!['path-segments', 'url-component'].includes(manifest.modelIdEncoding)) {
    throw new Error('model route manifest has an unsupported model ID encoding')
  }
  if (!isPlainObject(manifest.observations) || Object.keys(manifest.observations).length === 0) {
    throw new Error('model route manifest has no observations')
  }
  for (const [modelId, observation] of Object.entries(manifest.observations)) {
    if (!modelId || !isPlainObject(observation) || typeof observation.revision !== 'string' || !observation.revision
      || !Array.isArray(observation.paths) || observation.paths.length === 0
      || observation.paths.some(path => typeof path !== 'string' || !path.startsWith('/'))) {
      throw new Error('model route manifest observation is invalid')
    }
  }
  return manifest
}

function expandRouteTemplate(manifest, { modelId, revision, path }) {
  const route = assertRouteManifest(manifest)
  if (route.observations[modelId]?.revision !== revision) throw new Error('model route revision is not observed')
  return route.requestPathTemplate
    .replace('{modelId}', encodeModelId(modelId, route.modelIdEncoding))
    .replace('{revision}', encodeURIComponent(revision))
    .replace('{path}', encodePath(path))
}

function decodeModelPath(value) {
  if (typeof value !== 'string' || !value) return null
  let decoded
  try {
    decoded = value.split('/').map(segment => decodeURIComponent(segment))
  } catch {
    return null
  }
  if (decoded.some(segment => !segment || segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\'))) {
    return null
  }
  return decoded.join('/')
}

function requestTemplatePrefix(manifest) {
  const tokens = ['{modelId}', '{revision}', '{path}']
    .map(token => manifest.requestPathTemplate.indexOf(token))
    .filter(index => index >= 0)
  return manifest.requestPathTemplate.slice(0, Math.min(...tokens))
}

export function parseModelRoutePath({ manifest, pathname }) {
  const route = assertRouteManifest(manifest)
  if (typeof pathname !== 'string' || !pathname.startsWith('/')) return null
  const matches = []
  for (const [modelId, observation] of Object.entries(route.observations)) {
    const marker = '__openphoto_model_path__'
    const pattern = expandRouteTemplate(route, { modelId, revision: observation.revision, path: marker })
    const markerIndex = pattern.indexOf(marker)
    if (markerIndex < 0 || pattern.indexOf(marker, markerIndex + marker.length) >= 0) {
      throw new Error('model route template cannot be parsed')
    }
    const prefix = pattern.slice(0, markerIndex)
    const suffix = pattern.slice(markerIndex + marker.length)
    if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) continue
    const rawPath = pathname.slice(prefix.length, pathname.length - suffix.length)
    const relativePath = decodeModelPath(rawPath)
    if (!relativePath) continue
    if (expandRouteTemplate(route, { modelId, revision: observation.revision, path: relativePath }) !== pathname) continue
    matches.push({ modelId, revision: observation.revision, path: relativePath })
  }
  return matches.length === 1 ? matches[0] : null
}

export function localModelPathFor({ manifest, origin }) {
  const route = assertRouteManifest(manifest)
  const serverOrigin = new URL(origin)
  const localPath = new URL(route.localModelPathTemplate.replaceAll('{origin}', serverOrigin.origin))
  if (serverOrigin.protocol !== 'http:' || localPath.protocol !== 'http:' || localPath.origin !== serverOrigin.origin) {
    throw new Error('model route must resolve to the loopback HTTP server')
  }
  return localPath.href.endsWith('/') ? localPath.href : `${localPath.href}/`
}

function isCompleteModelFile(file) {
  return isPlainObject(file)
    && typeof file.path === 'string'
    && Number.isSafeInteger(file.bytes)
    && file.bytes > 0
    && typeof file.sha256 === 'string'
    && /^[a-f0-9]{64}$/u.test(file.sha256)
}

function hasMatchingFile(files, expected) {
  return Array.isArray(files) && files.some(file => isCompleteModelFile(file)
    && file.path === expected.path
    && file.bytes === expected.bytes
    && file.sha256 === expected.sha256)
}

function assertModelRouting(modelRouting) {
  if (!isPlainObject(modelRouting) || !isPlainObject(modelRouting.lock) || !isPlainObject(modelRouting.lock.models)
    || !modelRouting.modelStore || typeof modelRouting.modelStore.pathsFor !== 'function') {
    throw new Error('model routing requires a lock and model store')
  }
  const manifest = assertRouteManifest(modelRouting.manifest)
  for (const [modelId, observation] of Object.entries(manifest.observations)) {
    const locked = modelRouting.lock.models[modelId]
    if (!isPlainObject(locked) || locked.revision !== observation.revision || !Array.isArray(locked.files)
      || locked.files.length === 0 || locked.files.some(file => !isCompleteModelFile(file))) {
      throw new Error('model routing lock does not match the route manifest')
    }
    const lockedPaths = new Set(locked.files.map(file => file.path))
    for (const pathname of observation.paths) {
      const parsed = parseModelRoutePath({ manifest, pathname })
      if (!parsed || parsed.modelId !== modelId || parsed.revision !== observation.revision || !lockedPaths.has(parsed.path)) {
        throw new Error('model route manifest does not match its probe observations')
      }
    }
  }
  return modelRouting
}

async function modelFileForRequest({ modelRouting, pathname }) {
  const routing = assertModelRouting(modelRouting)
  const route = parseModelRoutePath({ manifest: routing.manifest, pathname })
  if (!route) return null
  const locked = routing.lock.models[route.modelId]
  if (!locked || locked.revision !== route.revision) return null
  const expected = locked.files.find(file => file.path === route.path)
  if (!expected) return null

  let installedDir
  let installed
  try {
    ({ installedDir } = routing.modelStore.pathsFor(route.modelId, route.revision))
    installed = JSON.parse(await readFile(resolve(installedDir, 'installed.json'), 'utf8'))
  } catch {
    return null
  }
  if (!isPlainObject(installed) || installed.modelId !== route.modelId || installed.revision !== route.revision
    || !locked.files.every(file => hasMatchingFile(installed.files, file))) {
    return null
  }

  const file = resolve(installedDir, route.path)
  if (!isInside(resolve(installedDir), file)) return null
  try {
    const info = await stat(file)
    if (!info.isFile() || info.size !== expected.bytes) return null
  } catch {
    return null
  }
  return { file, expected }
}

async function serveFile({ request, response, file, expectedModelFile = null }) {
  const body = await readFile(file)
  if (expectedModelFile !== null && (body.byteLength !== expectedModelFile.bytes
    || createHash('sha256').update(body).digest('hex') !== expectedModelFile.sha256)) {
    throw Object.assign(new Error('model file changed'), { code: 'ENOENT' })
  }
  response.writeHead(200, {
    'content-type': contentType(file),
    'cache-control': 'no-store',
    'content-length': body.byteLength
  })
  response.end(request.method === 'HEAD' ? undefined : body)
}

export function createStaticServer({ assetRoot, modelRouting = null, host = '127.0.0.1', port = 0 }) {
  const root = resolve(assetRoot)
  if (modelRouting && host !== '127.0.0.1') throw new Error('model routing requires the loopback host')
  const routing = modelRouting ? assertModelRouting(modelRouting) : null
  const server = createServer(async (request, response) => {
    if (!request.url || !['GET', 'HEAD'].includes(request.method ?? 'GET')) {
      response.writeHead(405).end('method not allowed')
      return
    }
    let rawPathname
    try {
      rawPathname = new URL(request.url, `http://${host}`).pathname
    } catch {
      response.writeHead(400).end('bad request')
      return
    }
    if (routing && rawPathname.startsWith(requestTemplatePrefix(routing.manifest))) {
      try {
        const modelFile = await modelFileForRequest({ modelRouting: routing, pathname: rawPathname })
        if (!modelFile) {
          response.writeHead(404).end('not found')
          return
        }
        await serveFile({ request, response, file: modelFile.file, expectedModelFile: modelFile.expected })
      } catch {
        response.writeHead(404).end('not found')
      }
      return
    }
    let pathname
    try {
      pathname = decodeURIComponent(rawPathname)
    } catch {
      response.writeHead(400).end('bad request')
      return
    }
    const candidate = resolve(root, `.${pathname}`)
    if (!isInside(root, candidate)) {
      response.writeHead(403).end('forbidden')
      return
    }
    try {
      const info = await stat(candidate)
      const file = info.isDirectory() ? resolve(candidate, 'index.html') : candidate
      if (!isInside(root, file)) throw Object.assign(new Error('forbidden'), { code: 'EACCES' })
      await serveFile({ request, response, file })
    } catch (error) {
      if (error?.code === 'EACCES') response.writeHead(403).end('forbidden')
      else if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') response.writeHead(404).end('not found')
      else response.writeHead(500).end('server error')
    }
  })

  return {
    server,
    async listen() {
      await new Promise((resolveListen, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => {
          server.off('error', reject)
          resolveListen()
        })
      })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('static server did not bind a TCP port')
      const url = `http://${host}:${address.port}`
      return {
        host,
        port: address.port,
        url,
        ...(routing ? { modelLocalPath: localModelPathFor({ manifest: routing.manifest, origin: url }) } : {})
      }
    },
    async close() {
      await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()))
    }
  }
}

async function main() {
  const [assetRoot, portValue = '0'] = process.argv.slice(2)
  const port = Number.parseInt(portValue, 10)
  if (!assetRoot || !Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('usage: static-server <assetRoot> [port]')
  const instance = createStaticServer({ assetRoot, port })
  const address = await instance.listen()
  console.log(address.url)
  const shutdown = async () => {
    await instance.close()
    process.exitCode = 0
  }
  process.once('SIGINT', () => void shutdown())
  process.once('SIGTERM', () => void shutdown())
}

if (process.argv[1] === fileURLToPath(import.meta.url)) void main()

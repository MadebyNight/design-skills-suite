import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { requestDaemon, timeoutForOperation, OPERATION_TIMEOUTS, OpenPhotoClientError } from '../../runtime/client.mjs'

const CLIENT_SOURCE = fileURLToPath(new URL('../../runtime/client.mjs', import.meta.url))

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function withDelayedRpcServer({ delayMs, handler }) {
  const server = createServer(async (request, response) => {
    await delay(delayMs)
    response.writeHead(200, { 'content-type': 'application/x-ndjson' })
    response.end(JSON.stringify(handler()) + '\n')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { port, close: () => new Promise(resolve => server.close(resolve)) }
}

test('requestDaemon aborts with a stable TIMEOUT error when the server exceeds the explicit timeout', async () => {
  const { port, close } = await withDelayedRpcServer({
    delayMs: 100,
    handler: () => ({ requestId: 'req', ok: true, result: {} })
  })
  try {
    const state = { port, instanceId: 'test' }
    const started = Date.now()
    await assert.rejects(
      requestDaemon(
        state,
        { protocol: 'openphoto/v1', requestId: 'req', op: 'runtime.health', payload: {} },
        { timeoutMs: 50 }
      ),
      error => error instanceof OpenPhotoClientError && error.code === 'TIMEOUT'
    )
    const elapsed = Date.now() - started
    assert.ok(elapsed < 100, `client must abort before the 100ms server delay, elapsed=${elapsed}ms`)
  } finally {
    await close()
  }
})

test('requestDaemon defaults to an op-aware timeout and keeps health at 5000ms', async () => {
  const source = await readFile(CLIENT_SOURCE, 'utf8')
  assert.match(source, /timeoutMs\s*=\s*timeoutForOperation\(request\?\.op\)/, 'requestDaemon must default to an op-aware timeout')
  assert.equal(OPERATION_TIMEOUTS['runtime.health'], 5_000)
})

test('timeoutForOperation maps operations to the required durations', () => {
  assert.equal(timeoutForOperation('runtime.health'), 5_000)
  assert.equal(timeoutForOperation('runtime.capabilities'), 5_000)
  assert.equal(timeoutForOperation('artifact.import'), 10_000)
  assert.equal(timeoutForOperation('artifact.read'), 10_000)
  assert.equal(timeoutForOperation('document.inspect'), 15_000)
  assert.equal(timeoutForOperation('document.mutate'), 15_000)
  assert.equal(timeoutForOperation('document.open'), 30_000)
  assert.equal(timeoutForOperation('document.renderArtifact'), 30_000)
  assert.equal(timeoutForOperation('document.close'), 30_000)
  assert.equal(timeoutForOperation('unknown.op'), 5_000)
})

test('slow document.open is not constrained by the 5s health timeout', () => {
  // 映射逻辑单测：document.open 必须使用 30s 而非 5s 默认值，避免慢 open 被误杀。
  assert.equal(timeoutForOperation('document.open'), 30_000)
  assert.notEqual(timeoutForOperation('document.open'), timeoutForOperation('runtime.health'))
})

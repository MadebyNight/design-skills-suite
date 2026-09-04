import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const CLI_SOURCE = fileURLToPath(new URL('../../bin/openphoto.mjs', import.meta.url))

const source = await readFile(CLI_SOURCE, 'utf8')

test('serve 接受可选的 --controlled 参数并透传给 serve()', () => {
  assert.match(source, /async function serve\(\{ controlled = false \} = \{\}\)/, 'serve 必须支持 controlled 选项')
  assert.match(source, /serve\(\{ controlled: true \}\)/, '--controlled 必须映射为 controlled: true')
  assert.match(source, /args\.length === 1 && args\[0\] === '--controlled'/, 'serve 只允许零个或一个 --controlled 参数')
})

test('controlled serve 的 stdin 监听 openphoto-shutdown 并保留 SIGINT/SIGTERM 与旧 test 信号', () => {
  assert.match(source, /process\.once\('SIGINT', resolveSignal\)/)
  assert.match(source, /process\.once\('SIGTERM', resolveSignal\)/)
  assert.match(source, /line === 'openphoto-shutdown' \|\| line === 'openphoto-test-shutdown'/, 'controlled 模式监听 openphoto-shutdown，普通 serve 在 test 模式兼容旧 openphoto-test-shutdown')
  assert.match(source, /if \(controlled \|\| testMode\)/, 'stdin 监听仅在 controlled 或 NODE_ENV=test 下挂载')
})

test('request 支持 --no-start 且仅在 autoStart=false 时抛 DAEMON_UNAVAILABLE', () => {
  assert.match(source, /if \(!autoStart\) \{\s*\n\s*throw Object\.assign\(new Error\('no healthy OpenPhoto daemon is running'\), \{ code: 'DAEMON_UNAVAILABLE' \}\)/, 'no-start 且无健康 daemon 时必须抛 code=DAEMON_UNAVAILABLE')
  assert.match(source, /autoStart = true/, 'request 默认保持 autoStart 行为不变')
  assert.match(source, /args\[0\] === '--no-start'/, 'request 识别 --no-start 前缀开关')
})

test('request 在无 daemon 且 autoStart=false 时绝不 spawn', () => {
  const requestBlock = /async function request\(request, \{ autoStart = true \} = \{\}\) \{[\s\S]*?\n\}/.exec(source)?.[0]
  assert.ok(requestBlock, '必须存在 request 实现')
  const spawnIndex = requestBlock.indexOf("spawn(")
  const guardIndex = requestBlock.indexOf("DAEMON_UNAVAILABLE")
  assert.ok(spawnIndex >= 0, 'autoStart 路径保留 daemon 拉起')
  assert.ok(guardIndex >= 0, 'no-start 必须有 DAEMON_UNAVAILABLE 守卫')
  assert.ok(guardIndex < spawnIndex, 'DAEMON_UNAVAILABLE 守卫必须先于 spawn 判断，确保无 daemon 时绝不 spawn')
})

test('参数解析拒绝多余参数并更新 usage 文案', () => {
  assert.match(source, /usage: openphoto capabilities \| openphoto serve \[--controlled\] \| openphoto request \[--no-start\] --file request\.json \| openphoto request \[--no-start\] --json JSON/)
  assert.match(source, /if \(args\.length !== 0\) throw usageError\(\)/, 'capabilities 拒绝任何多余参数')
  assert.match(source, /if \(args\.length !== 2\) throw usageError\(\)/, 'request 恰好接受一对 flag/value')
  assert.match(source, /if \(command === 'serve'\) \{\s*\n\s*if \(args\.length === 0\) return serve\(\)\s*\n\s*if \(args\.length === 1 && args\[0\] === '--controlled'\) return serve\(\{ controlled: true \}\)\s*\n\s*throw usageError\(\)/, 'serve 只允许零个或 --controlled 一个参数')
})

test('controlled serve 的 stdin 监听不因 NODE_ENV=test 被销毁，保证 shutdown 指令可达', () => {
  const waitForSignalBlock = /await new Promise\(resolveSignal => \{[\s\S]*?\n    \}\)/.exec(source)?.[0]
  assert.ok(waitForSignalBlock, '必须存在信号等待块')
  assert.ok(waitForSignalBlock.includes('controlled || testMode'), 'controlled 与 test 模式都必须保持 stdin 可读')
  assert.ok(!waitForSignalBlock.includes('process.stdin.destroy()'), '等待信号期间不得销毁 stdin')
})

test('普通 serve 不操作 ignored stdin，只依赖 SIGINT/SIGTERM', () => {
  const waitForSignalBlock = source.slice(source.indexOf('await new Promise(resolveSignal'), source.indexOf('await shutdown()', source.indexOf('await new Promise(resolveSignal')))
  assert.ok(!waitForSignalBlock.includes('process.stdin.unref()'))
  assert.ok(!waitForSignalBlock.includes('process.stdin.destroy()'))
})

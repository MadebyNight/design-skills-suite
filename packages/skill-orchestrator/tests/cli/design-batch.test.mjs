import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const exec = promisify(execFile)
const CLI = fileURLToPath(new URL('../../bin/design-batch.mjs', import.meta.url))
const FIXTURE = fileURLToPath(new URL('../fixtures/cli-batch-request.json', import.meta.url))

function runCli(args, env = {}) {
  return exec(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, IMAGE_GENERATE_PROVIDER: 'test', ...env },
  })
}

function todayStamp(now = new Date()) {
  return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('')
}

test('帮助入口：无 provider、请求或输出参数时成功返回单行 JSON', async () => {
  for (const arg of ['--help', '-h', 'help']) {
    const { stdout, stderr } = await runCli([arg], { IMAGE_GENERATE_PROVIDER: 'invalid-provider' })
    const parsed = JSON.parse(stdout)
    assert.equal(parsed.ok, true)
    assert.equal(typeof parsed.result.usage, 'string')
    assert.ok(parsed.result.usage.includes('run --request'))
    assert.equal(stdout.trim().split('\n').length, 1)
    assert.equal(stderr, '')
  }
})

test('帮助入口不吞掉混入的执行参数', async () => {
  await assert.rejects(
    () => runCli(['--help', '--request', 'missing.json']),
    (error) => error.code === 2 && JSON.parse(error.stdout).code === 'BATCH_USAGE',
  )
})

test('name：日期在前、主题缩写居中，目录与请求文件共享版本并自动递增', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-name-'))
  const date = todayStamp()
  try {
    fs.mkdirSync(path.join(root, `${date}-bg4-v1`))
    fs.writeFileSync(path.join(root, `${date}-bg4-v2-request.json`), '{}')
    const { stdout } = await runCli(['name', '--output-root', root, '--theme-abbr', 'BG4'])
    const naming = JSON.parse(stdout).result
    assert.equal(naming.baseName, `${date}-bg4-v3`)
    assert.equal(naming.outputPath, path.join(root, `${date}-bg4-v3`))
    assert.equal(naming.requestPath, path.join(root, `${date}-bg4-v3-request.json`))
    assert.equal(fs.existsSync(naming.outputPath), false, 'name 只计算名称，不创建目录')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('name：拒绝冗长或含分隔符的主题缩写', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-name-invalid-'))
  try {
    await assert.rejects(
      () => runCli(['name', '--output-root', root, '--theme-abbr', 'blue-gold-campaign']),
      (e) => e.code === 2 && JSON.parse(e.stdout).code === 'BATCH_USAGE',
    )
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('run：两 item 成功，退出 0，产物齐全', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-run-ok-'))
  try {
    const { stdout, stderr } = await runCli(['run', '--request', FIXTURE, '--output', root, '--source-commit', 'test-commit'])
    const parsed = JSON.parse(stdout)
    assert.equal(parsed.ok, true)
    assert.equal(parsed.result.status, 'succeeded')
    assert.equal(parsed.result.summary.total, 2)
    assert.equal(parsed.result.summary.succeeded, 2)
    assert.ok(fs.existsSync(path.join(root, 'other', 'runtime', 'request.json')))
    assert.ok(fs.existsSync(path.join(root, 'other', 'runtime', 'checkpoint.json')))
    assert.ok(fs.existsSync(path.join(root, 'other', 'runtime', 'result.json')))
    assert.equal(stderr, '')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('run：位置参数兼容', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-run-pos-'))
  try {
    const { stdout } = await runCli(['run', FIXTURE, '--output', root, '--source-commit', 'test-commit'])
    const parsed = JSON.parse(stdout)
    assert.equal(parsed.ok, true)
    assert.equal(parsed.result.status, 'succeeded')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('run：--request 与位置参数冲突退出 2', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-run-conflict-'))
  try {
    await assert.rejects(
      () => runCli(['run', '--request', FIXTURE, FIXTURE, '--output', path.join(root, 'out'), '--source-commit', 'test-commit']),
      (e) => {
        const parsed = JSON.parse(e.stdout)
        return e.code === 2 && parsed.code === 'BATCH_USAGE'
      },
    )
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('run：缺 --request 值退出 2', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-run-noreq-'))
  try {
    await assert.rejects(
      () => runCli(['run', '--request', '--output', path.join(root, 'out'), '--source-commit', 'test-commit']),
      (e) => {
        const parsed = JSON.parse(e.stdout)
        return e.code === 2 && parsed.code === 'BATCH_USAGE'
      },
    )
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('run：多余位置参数退出 2', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-run-extra-'))
  try {
    await assert.rejects(
      () => runCli(['run', FIXTURE, 'extra', '--output', path.join(root, 'out'), '--source-commit', 'test-commit']),
      (e) => {
        const parsed = JSON.parse(e.stdout)
        return e.code === 2 && parsed.code === 'BATCH_USAGE'
      },
    )
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('resume：禁止 --request 退出 2', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-resume-req-'))
  try {
    await runCli(['run', '--request', FIXTURE, '--output', root, '--source-commit', 'test-commit'])
    await assert.rejects(
      () => runCli(['resume', '--request', FIXTURE, '--output', root, '--source-commit', 'test-commit']),
      (e) => {
        const parsed = JSON.parse(e.stdout)
        return e.code === 2 && parsed.code === 'BATCH_USAGE'
      },
    )
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('run：重复 run 退出 5 BATCH_OUTPUT_EXISTS', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-run-exists-'))
  try {
    await runCli(['run', '--request', FIXTURE, '--output', root, '--source-commit', 'test-commit'])
    await assert.rejects(
      () => runCli(['run', '--request', FIXTURE, '--output', root, '--source-commit', 'test-commit']),
      (e) => {
        const parsed = JSON.parse(e.stdout)
        return e.code === 5 && parsed.code === 'BATCH_OUTPUT_EXISTS'
      },
    )
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('run：非法请求退出 2', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-run-invalid-'))
  const bad = path.join(root, 'bad.json')
  fs.writeFileSync(bad, '{"schemaVersion":"1","batchId":"b"}')
  try {
    await assert.rejects(
      () => runCli(['run', '--request', bad, '--output', path.join(root, 'out'), '--source-commit', 'test-commit']),
      (e) => {
        const parsed = JSON.parse(e.stdout)
        return e.code === 2 && parsed.code === 'BATCH_REQUEST_INVALID'
      },
    )
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('run：缺 --output 退出 2', async () => {
  await assert.rejects(
    () => runCli(['run', '--request', FIXTURE, '--source-commit', 'test-commit']),
    (e) => {
      const parsed = JSON.parse(e.stdout)
      return e.code === 2 && parsed.code === 'BATCH_USAGE'
    },
  )
})

test('run：缺 provider 配置退出 3 MISSING_API_KEY', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-run-noprovider-'))
  const cleanEnv = {}
  for (const key of Object.keys(process.env)) {
    if (!/^(IMAGE_GENERATE_PROVIDER|FAL_KEY|IMAGE_GENERATE_API_KEY|IMAGE_API_)/.test(key)) cleanEnv[key] = process.env[key]
  }
  cleanEnv.CODEX_HOME = path.join(root, 'empty-codex-home')
  try {
    await assert.rejects(
      () => exec(process.execPath, [CLI, 'run', '--request', FIXTURE, '--output', path.join(root, 'out'), '--source-commit', 'test-commit'], { encoding: 'utf8', windowsHide: true, env: cleanEnv }),
      (e) => {
        const parsed = JSON.parse(e.stdout)
        return e.code === 3 && parsed.code === 'MISSING_API_KEY'
      },
    )
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('run：非法/不存在请求且无 provider 配置 → 退出 2（请求校验优先）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-run-order-'))
  const cleanEnv = {}
  for (const key of Object.keys(process.env)) {
    if (!/^(IMAGE_GENERATE_PROVIDER|FAL_KEY|IMAGE_GENERATE_API_KEY|IMAGE_API_)/.test(key)) cleanEnv[key] = process.env[key]
  }
  cleanEnv.CODEX_HOME = path.join(root, 'empty-codex-home')
  const bad = path.join(root, 'bad.json')
  fs.writeFileSync(bad, '{"schemaVersion":"1","batchId":"b"}')
  try {
    await assert.rejects(
      () => exec(process.execPath, [CLI, 'run', '--request', bad, '--output', path.join(root, 'out'), '--source-commit', 'test-commit'], { encoding: 'utf8', windowsHide: true, env: cleanEnv }),
      (e) => {
        const parsed = JSON.parse(e.stdout)
        return e.code === 2 && parsed.code === 'BATCH_REQUEST_INVALID'
      },
    )
    // 不存在的请求文件同样优先退出 2。
    await assert.rejects(
      () => exec(process.execPath, [CLI, 'run', '--request', path.join(root, 'missing.json'), '--output', path.join(root, 'out'), '--source-commit', 'test-commit'], { encoding: 'utf8', windowsHide: true, env: cleanEnv }),
      (e) => {
        const parsed = JSON.parse(e.stdout)
        return e.code === 2 && parsed.code === 'BATCH_REQUEST_IO'
      },
    )
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('resume：已完成批次不重跑，attempt 保持', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-resume-'))
  try {
    await runCli(['run', '--request', FIXTURE, '--output', root, '--source-commit', 'test-commit'])
    const { stdout } = await runCli(['resume', '--output', root, '--source-commit', 'test-commit'])
    const parsed = JSON.parse(stdout)
    assert.equal(parsed.ok, true)
    assert.equal(parsed.result.status, 'succeeded')
    const ck = JSON.parse(fs.readFileSync(path.join(root, 'other', 'runtime', 'checkpoint.json'), 'utf8'))
    assert.ok(ck.items.every((i) => i.attempt === 1))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('retry-failed：required reuse 缺失仍 failed，attempt 递增，退出 4', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-retry-'))
  const req = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
  req.items[0].assetPolicy = { default: { source: 'reuse', requirement: 'required' }, rules: [] }
  const file = path.join(root, 'req.json')
  fs.writeFileSync(file, JSON.stringify(req))
  try {
    await assert.rejects(
      () => runCli(['run', '--request', file, '--output', path.join(root, 'out'), '--source-commit', 'test-commit']),
      (e) => {
        const parsed = JSON.parse(e.stdout)
        return e.code === 4 && parsed.ok === true && parsed.result.status === 'partially_failed'
      },
    )
    const out = path.join(root, 'out')
    const ck1 = JSON.parse(fs.readFileSync(path.join(out, 'other', 'runtime', 'checkpoint.json'), 'utf8'))
    assert.equal(ck1.items[0].attempt, 1)
    await assert.rejects(
      () => runCli(['retry-failed', '--output', out, '--source-commit', 'test-commit']),
      (e) => {
        const parsed = JSON.parse(e.stdout)
        return e.code === 4 && parsed.ok === true && parsed.result.status === 'partially_failed'
      },
    )
    const ck2 = JSON.parse(fs.readFileSync(path.join(out, 'other', 'runtime', 'checkpoint.json'), 'utf8'))
    assert.equal(ck2.items[0].attempt, 2)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

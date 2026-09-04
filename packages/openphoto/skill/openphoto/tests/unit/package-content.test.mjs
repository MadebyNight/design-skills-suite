import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import test from 'node:test'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const execFile = promisify(execFileCallback)
const npm = process.platform === 'win32'
  ? { command: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', 'npm pack --dry-run --json'] }
  : { command: 'npm', args: ['pack', '--dry-run', '--json'] }

async function packedPaths() {
  const { stdout } = await execFile(npm.command, npm.args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1024 * 1024
  })
  const [archive] = JSON.parse(stdout)
  assert.ok(archive?.files, 'npm pack did not return a file manifest')
  return archive.files.map(file => file.path.replaceAll('\\', '/'))
}

test('npm pack contains only the OpenPhoto runtime package surface', async () => {
  const paths = await packedPaths()
  const included = [
    'SKILL.md',
    'manifest.json',
    'agents/openai.yaml',
    'bin/openphoto.mjs',
    'runtime/daemon.mjs',
    'assets/openshop/index.html',
    'assets/ai-runtime/transformers.min.js',
    'manifests/models.lock.json',
    'references/protocol.md',
    'package.json'
  ]
  for (const path of included) assert.ok(paths.includes(path), `npm package is missing ${path}`)

  for (const path of paths) {
    assert.doesNotMatch(path, /^(?:tests|test-results|node_modules|\.openphoto|playwright-report)\//u, path)
    assert.doesNotMatch(path, /\.(?:onnx|safetensors|part)$/iu, path)
    assert.doesNotMatch(path, /(?:^|\/)(?:model|pytorch_model)(?:[-_.].*)?\.bin$/iu, path)
  }
})

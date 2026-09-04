import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = path.resolve(here, '..')
export const DEFAULT_SOURCE = path.join(REPO_ROOT, 'skill', 'openphoto')
export const DEFAULT_OUTPUT = path.join(REPO_ROOT, 'dist', 'openphoto')

const EXCLUDED_SEGMENTS = new Set([
  'node_modules', 'tests', 'test-results', '.openphoto', 'playwright-report',
  'browser-profile', 'user-data', 'models-cache',
])
const EXCLUDED_EXTENSIONS = new Set(['.onnx', '.safetensors', '.part'])

export function shouldInclude(relativePath) {
  const normalized = relativePath.replace(/\\/g, '/')
  const segments = normalized.split('/').filter(Boolean)
  if (segments.some(segment => EXCLUDED_SEGMENTS.has(segment.toLowerCase()))) return false
  const lower = normalized.toLowerCase()
  if (EXCLUDED_EXTENSIONS.has(path.extname(lower))) return false
  if (/(^|\/)(chrome|chromium|msedge)(\.exe)?($|\/)/i.test(normalized)) return false
  return true
}

export function listReleaseFiles(source = DEFAULT_SOURCE) {
  const files = []
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(current, entry.name)
      const relative = path.relative(source, absolute)
      if (!shouldInclude(relative)) continue
      if (entry.isDirectory()) walk(absolute)
      else if (entry.isFile()) files.push(relative.replace(/\\/g, '/'))
    }
  }
  walk(source)
  return files.sort()
}

export function auditReleaseFiles(files) {
  const required = ['SKILL.md', 'manifest.json', 'bin/openphoto.mjs', 'package.json']
  const missing = required.filter(file => !files.includes(file))
  const forbidden = files.filter(file => !shouldInclude(file))
  return { ok: missing.length === 0 && forbidden.length === 0, missing, forbidden }
}

export function copyRelease({ source = DEFAULT_SOURCE, output = DEFAULT_OUTPUT, replace = false } = {}) {
  const files = listReleaseFiles(source)
  const audit = auditReleaseFiles(files)
  if (!audit.ok) throw new Error(`发布内容审计失败：${JSON.stringify(audit)}`)
  if (fs.existsSync(output)) {
    if (!replace) throw new Error(`输出目录已存在：${output}；显式传入 replace 才能替换`)
    fs.rmSync(output, { recursive: true, force: true })
  }
  for (const relative of files) {
    const target = path.join(output, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(path.join(source, relative), target)
  }
  return { source, output, files, audit }
}

export function installProductionDependencies(output = DEFAULT_OUTPUT) {
  execFileSync('npm', ['ci', '--omit=dev'], { cwd: output, stdio: 'inherit', shell: process.platform === 'win32' })
}

export function createZip(output = DEFAULT_OUTPUT, zipFile = path.join(path.dirname(output), 'OpenPhoto.zip')) {
  if (process.platform !== 'win32') throw new Error('首版 ZIP 命令仅支持 Windows PowerShell Compress-Archive')
  execFileSync('pwsh', ['-NoProfile', '-Command', `Compress-Archive -LiteralPath '${output.replace(/'/g, "''")}' -DestinationPath '${zipFile.replace(/'/g, "''")}' -Force`], { stdio: 'inherit' })
  return zipFile
}

function parseArgs(argv) {
  return {
    build: argv.includes('--build'),
    replace: argv.includes('--replace'),
    install: argv.includes('--install'),
    zip: argv.includes('--zip'),
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2))
  const files = listReleaseFiles()
  const audit = auditReleaseFiles(files)
  console.log(JSON.stringify({ mode: options.build ? 'build' : 'dry-run', files: files.length, audit }, null, 2))
  if (!audit.ok) process.exitCode = 1
  else if (options.build) {
    const result = copyRelease({ replace: options.replace })
    if (options.install) installProductionDependencies(result.output)
    if (options.zip) createZip(result.output)
  }
}

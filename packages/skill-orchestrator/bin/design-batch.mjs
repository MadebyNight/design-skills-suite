#!/usr/bin/env node
// 3C.3：批次编排 CLI。
//
// 命令：
//   design-batch name --output-root DIR --theme-abbr SLUG
//   design-batch run --request FILE --output DIR [--screenshot] [--source-commit X]
//   design-batch resume --output DIR [--screenshot] [--source-commit X]
//   design-batch retry-failed --output DIR [--screenshot] [--source-commit X]
//
// 输出约定：stdout 仅单行最终 JSON；成功 { ok:true, result }，错误 { ok:false, code, message }。
// 退出码：0 成功；2 请求/schema/用法；3 provider 配置；4 批次部分失败/失败；5 checkpoint/不兼容/输出已存在/内部。
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadBatchRequest } from '../runtime/batch-request.mjs'
import { runBatch } from '../runtime/batch-runner.mjs'
import { createStandardBatchRuntime } from '../runtime/standard-bindings.mjs'

const exec = promisify(execFile)

const USAGE = `用法:
  design-batch --help
  design-batch name --output-root DIR --theme-abbr SLUG
  design-batch run --request FILE --output DIR [--screenshot] [--source-commit X]
  design-batch resume --output DIR [--screenshot] [--source-commit X]
  design-batch retry-failed --output DIR [--screenshot] [--source-commit X]`

export function parseArgs(argv) {
  const args = [...argv]
  const command = args.shift()
  const positional = []
  const flags = {}
  while (args.length) {
    const arg = args.shift()
    if (arg === '--output') flags.output = args.shift()
    else if (arg === '--output-root') flags.outputRoot = args.shift()
    else if (arg === '--theme-abbr') flags.themeAbbr = args.shift()
    else if (arg === '--request') flags.request = args.shift()
    else if (arg === '--screenshot') flags.screenshot = true
    else if (arg === '--source-commit') flags.sourceCommit = args.shift()
    else if (arg.startsWith('--')) { flags.unknown = arg; break }
    else positional.push(arg)
  }
  return { command, positional, flags }
}

function localDateStamp(now = new Date()) {
  const year = String(now.getFullYear()).padStart(4, '0')
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}${month}${day}`
}

/** 计算下一组统一名称；只读目录，不创建或移动任何文件。 */
export function resolveOutputNaming({ outputRoot, themeAbbr, now = new Date() } = {}) {
  if (typeof outputRoot !== 'string' || !outputRoot.trim()) {
    throw Object.assign(new Error('name 需要 --output-root DIR'), { code: 'BATCH_USAGE' })
  }
  const slug = String(themeAbbr || '').trim().toLowerCase()
  if (!/^[a-z0-9]{2,20}$/.test(slug)) {
    throw Object.assign(new Error('主题缩写必须是 2-20 位英文字母或数字'), { code: 'BATCH_USAGE' })
  }

  const date = localDateStamp(now)
  const prefix = `${date}-${slug}-v`
  let maxVersion = 0
  if (fs.existsSync(outputRoot)) {
    for (const entry of fs.readdirSync(outputRoot, { withFileTypes: true })) {
      const match = entry.name.match(new RegExp(`^${prefix}(\\d+)(?:-request\\.json)?$`))
      if (match) maxVersion = Math.max(maxVersion, Number(match[1]))
    }
  }
  const baseName = `${prefix}${maxVersion + 1}`
  return {
    baseName,
    outputPath: path.join(outputRoot, baseName),
    requestPath: path.join(outputRoot, `${baseName}-request.json`),
  }
}

async function resolveSourceCommit(provided) {
  if (provided) return provided
  try {
    const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true })
    return stdout.trim()
  } catch {
    const error = new Error('无法获取 git HEAD，请用 --source-commit 显式指定')
    error.code = 'SOURCE_COMMIT_UNAVAILABLE'
    throw error
  }
}

export function exitCodeFor(code) {
  // provider 配置类 → 3
  if (code === 'MISSING_API_KEY' || code === 'OPENPHOTO_RELEASE_MISSING' || /^(IMAGE_PROVIDER_|FAL_|PROBE_)/.test(code)) {
    return 3
  }
  // 请求/schema/用法 → 2
  if (code === 'BATCH_REQUEST_INVALID' || code === 'BATCH_REQUEST_IO' || code === 'BATCH_MODE_INVALID' || code === 'BATCH_RUN_ITEM_INVALID' || code === 'BATCH_REQUEST_MISSING' || code === 'BATCH_USAGE') {
    return 2
  }
  // 交付发布层错误 → 5（批次可能已成功但交付入口损坏，必须明确暴露）。
  if (/^BATCH_PUBLISH_/.test(code)) {
    return 5
  }
  // checkpoint/输出已存在/旧结构迁移冲突/内部 → 5
  return 5
}

export async function main() {
  const argv = process.argv.slice(2)
  if (argv.length === 1 && ['--help', '-h', 'help'].includes(argv[0])) {
    return {
      description: '支付宝页面视觉设计批次：自动生成与回填素材、多页交付、离线预览和失败恢复；不负责生产发布。',
      usage: USAGE,
      guide: 'docs/usage/design-skills-user-guide.md',
      input: 'run 接收结构化请求 JSON；自然语言需求由 Agent 按 SKILL.md 整理。',
      output: '交付后打开结果返回的 index.html，并查看各页面 configuration-guide.md。',
    }
  }
  const { command, positional, flags } = parseArgs(process.argv.slice(2))
  if (flags.unknown) {
    throw Object.assign(new Error(`未知参数 ${flags.unknown}`), { code: 'BATCH_USAGE' })
  }
  if (!['name', 'run', 'resume', 'retry-failed'].includes(command)) {
    throw Object.assign(new Error(USAGE), { code: 'BATCH_USAGE' })
  }
  if (command === 'name') {
    if (positional.length > 0 || flags.output || flags.request || flags.screenshot || flags.sourceCommit) {
      throw Object.assign(new Error('name 只接受 --output-root 与 --theme-abbr'), { code: 'BATCH_USAGE' })
    }
    return resolveOutputNaming({ outputRoot: flags.outputRoot, themeAbbr: flags.themeAbbr })
  }
  if (flags.outputRoot || flags.themeAbbr) {
    throw Object.assign(new Error(`${command} 不接受 --output-root 或 --theme-abbr`), { code: 'BATCH_USAGE' })
  }
  if (!flags.output) {
    throw Object.assign(new Error('缺少 --output DIR'), { code: 'BATCH_USAGE' })
  }

  // run：--request 为主，位置参数兼容；两者同时给出则冲突。
  if (command === 'run') {
    if (flags.request && positional.length > 0) {
      throw Object.assign(new Error('--request 与位置参数冲突，请只使用 --request'), { code: 'BATCH_USAGE' })
    }
    if (!flags.request && positional.length === 0) {
      throw Object.assign(new Error('run 需要 --request FILE'), { code: 'BATCH_USAGE' })
    }
    if (!flags.request && positional.length > 1) {
      throw Object.assign(new Error('run 只接受一个请求文件'), { code: 'BATCH_USAGE' })
    }
  } else {
    // resume / retry-failed 禁止 --request 与位置参数。
    if (flags.request || positional.length > 0) {
      throw Object.assign(new Error(`${command} 不接受 --request 或位置参数`), { code: 'BATCH_USAGE' })
    }
  }

  // run：先加载并校验请求（请求/不存在错误优先于 provider 配置错误）。
  let batchRequest
  if (command === 'run') {
    batchRequest = loadBatchRequest(flags.request || positional[0])
  }

  const sourceCommit = await resolveSourceCommit(flags.sourceCommit)
  const runtime = createStandardBatchRuntime({ env: process.env, screenshot: flags.screenshot === true })

  try {
    const result = await runBatch({
      mode: command,
      batchRequest,
      batchRoot: flags.output,
      sourceCommit,
      providerIdentity: runtime.providerIdentity,
      runItem: runtime.runItem,
    })
    return result
  } finally {
    await runtime.close()
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMain) {
  main()
    .then((result) => {
      process.stdout.write(JSON.stringify({ ok: true, result }) + '\n')
      process.exitCode = result.status === undefined || result.status === 'succeeded' ? 0 : 4
    })
    .catch((error) => {
      const code = error?.code || 'BATCH_INTERNAL'
      process.stdout.write(JSON.stringify({ ok: false, code, message: error?.message || String(error) }) + '\n')
      process.exitCode = exitCodeFor(code)
    })
}

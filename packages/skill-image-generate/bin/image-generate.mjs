#!/usr/bin/env node
// 生图 Skill CLI。
//
// 子命令：
//   image-generate capabilities            输出本 Skill 提供的能力清单
//   image-generate request --file <path>   从 JSON 文件读取 AssetRequest 并生图
//   image-generate request --json <json>   从内联 JSON 读取 AssetRequest 并生图
//   image-generate probe [--generate]      探测 provider 可用性（--generate 才产生图片与费用）
//
// request 优先使用显式 provider 配置；未显式配置时继承当前 Codex Agent，再走兼容回退。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeAssetRequest, validateAssetResult } from '../runtime/protocol.mjs'
import { generateAsset } from '../runtime/generator.mjs'
import { probeProvider } from '../runtime/provider-probe.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = path.resolve(__dirname, '..')

const { default: pkg } = await import('../package.json', { with: { type: 'json' } })
const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'manifest.json'), 'utf8'))

const CAPABILITIES = [
  {
    id: 'image.generate',
    version: '1.0.0',
    inputSchema: 'asset-request.schema.json',
    outputSchema: 'asset-result.schema.json',
    automatic: true,
    priority: 10,
    availabilityCommand: 'image-generate capabilities',
  },
]

function printCapabilities() {
  const out = {
    skillManifest: manifest,
    capabilities: CAPABILITIES,
  }
  console.log(JSON.stringify(out, null, 2))
}

function fail(code, message, details = []) {
  const out = { ok: false, code, message, details }
  console.log(JSON.stringify(out, null, 2))
  process.exitCode = 1
}

async function main(argv) {
  const cmd = argv[0]

  if (cmd === 'capabilities') {
    printCapabilities()
    return
  }

  if (cmd === 'request') {
    const args = argv.slice(1)
    const fileIdx = args.indexOf('--file')
    const jsonIdx = args.indexOf('--json')

    let raw = null
    if (fileIdx !== -1) {
      const filePath = args[fileIdx + 1]
      if (!filePath) return fail('USAGE', '--file 需要文件路径')
      if (!fs.existsSync(filePath)) return fail('FILE_NOT_FOUND', `文件不存在: ${filePath}`)
      raw = fs.readFileSync(filePath, 'utf8')
    } else if (jsonIdx !== -1) {
      const json = args[jsonIdx + 1]
      if (!json) return fail('USAGE', '--json 需要 JSON 字符串')
      raw = json
    } else {
      return fail('USAGE', 'request 需要 --file 或 --json')
    }

    let request
    try {
      request = normalizeAssetRequest(raw)
    } catch (e) {
      return fail(e.code || 'INVALID_ASSET', e.message, e.details || [])
    }

    const result = await generateAsset(request)

    const errors = validateAssetResult(result)
    if (errors.length > 0) {
      return fail('OUTPUT_INVALID', '生成的 AssetResult 不符合契约', errors)
    }

    console.log(JSON.stringify({ ok: true, result }, null, 2))
    return
  }

  if (cmd === 'probe') {
    const args = argv.slice(1)
    const strong = args.includes('--generate')
    const providerName = process.env.IMAGE_GENERATE_PROVIDER
    if (providerName !== 'openai-compatible') {
      return fail('PROBE_UNSUPPORTED', 'probe 仅支持 IMAGE_GENERATE_PROVIDER=openai-compatible')
    }
    const baseURL = process.env.IMAGE_API_BASE_URL
    const apiKey = process.env.IMAGE_API_KEY
    const model = process.env.IMAGE_API_MODEL || 'gpt-image-2'
    if (!baseURL || !apiKey) {
      return fail('PROBE_CONFIG_MISSING', 'probe 需要 IMAGE_API_BASE_URL 与 IMAGE_API_KEY')
    }
    const result = await probeProvider({ providerConfig: { baseURL, apiKey, model }, strong })
    console.log(JSON.stringify({ ok: true, result }, null, 2))
    return
  }

  fail('USAGE', `未知命令: ${cmd || '(空)'}`, ['支持: capabilities | request | probe'])
}

main(process.argv.slice(2)).catch((e) => {
  fail(e.code || 'INTERNAL', e.message || String(e))
})

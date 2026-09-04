import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Registry, validate } from '../../design-skill-contracts/scripts/validate.mjs'
import { CONTRACT_DIR } from './build-catalog.mjs'

function walk(root, current = root, files = []) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(current, entry.name)
    if (entry.isDirectory()) walk(root, absolute, files)
    else if (entry.isFile() && entry.name !== 'design-package.json') files.push(path.relative(root, absolute).replace(/\\/g, '/'))
  }
  return files
}

function kind(file) {
  const known = new Set(['prototype.html', 'prototype.png', 'design-brief.json', 'component-usage.json', 'design-guidance.json', 'research-pack.json', 'asset-manifest.json', 'validation-report.json'])
  return known.has(file) ? file : 'asset'
}

// 受控配置产物：页面交付四件套中的配置 JSON 与配置指南。
// 配置 JSON 按页面命名（home-config.json / landing-config.json），指南固定为 configuration-guide.md。
const CONFIG_GUIDE = 'configuration-guide.md'
const CONFIG_JSON_PATTERN = /^(home|landing)-config\.json$/

export function buildDesignPackage({ outputRoot, designBriefId, sourceCommit, skillDependencies = [] }) {
  const files = walk(outputRoot).map(file => ({
    path: file,
    kind: CONFIG_JSON_PATTERN.test(file) || file === CONFIG_GUIDE ? file : kind(file),
    sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(outputRoot, file))).digest('hex'),
  }))
  const configJsons = files.filter(file => CONFIG_JSON_PATTERN.test(file.path))
  const presentKinds = new Set(files.map(file => file.kind))
  if (presentKinds.has(CONFIG_GUIDE)) {
    // 配置指南存在时视为“配置化交付”：必须恰好对应一个页面的配置 JSON。
    if (configJsons.length !== 1) {
      throw new Error('配置产物不完整：configuration-guide.md 必须与恰好一份 home-config.json 或 landing-config.json 同时交付')
    }
  } else if (configJsons.length > 0) {
    throw new Error(`配置产物不完整：缺少 ${CONFIG_GUIDE}`)
  }
  const result = { packageRoot: path.resolve(outputRoot), designBriefId, files, sourceCommit, skillDependencies }
  const registry = Registry.fromDirectory(path.join(CONTRACT_DIR, 'schemas'))
  const schema = registry.byId.get('http://schemas.design-agent.local/design-skill/v1/design-package.schema.json').schema
  const errors = validate(result, schema, registry, schema.$id)
  if (errors.length) throw new Error(`DesignPackage 校验失败：${errors.join('；')}`)
  fs.writeFileSync(path.join(outputRoot, 'design-package.json'), JSON.stringify(result, null, 2) + '\n')
  return result
}

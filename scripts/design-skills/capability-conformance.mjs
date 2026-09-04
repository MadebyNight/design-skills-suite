import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { Registry, validate } from '../../packages/design-skill-contracts/scripts/validate.mjs'
import { discoverSkills } from '../../packages/skill-orchestrator/runtime/discovery.mjs'
import { matchCapability } from '../../packages/skill-orchestrator/runtime/matcher.mjs'

const exec = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const schemaDir = path.join(repoRoot, 'packages', 'design-skill-contracts', 'schemas')

async function runCli(root, args) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'))
  const bin = path.join(root, manifest.entrypoint)
  const { stdout } = await exec(process.execPath, [bin, ...args], { cwd: root, encoding: 'utf8' })
  return JSON.parse(stdout)
}

export async function runCapabilityConformance({ skillRoots, assetRequest, preferredSkillId } = {}) {
  const discovery = await discoverSkills({ skillRoots, executor: async ({ root }) => {
    const output = await runCli(root, ['capabilities'])
    return Boolean(output.skillManifest)
  } })
  const registry = Registry.fromDirectory(schemaDir)
  const capSchema = registry.byId.get('http://schemas.design-agent.local/design-skill/v1/capability-manifest.schema.json').schema
  const resultSchema = registry.byId.get('http://schemas.design-agent.local/design-skill/v1/asset-result.schema.json').schema
  const capabilities = []
  for (const skill of discovery.skills) {
    const output = await runCli(skill.root, ['capabilities'])
    for (const capability of output.capabilities || []) {
      const errors = validate(capability, capSchema, registry, capSchema.$id)
      if (errors.length) throw new Error(`${skill.manifest.id} CapabilityManifest 非法：${errors.join('；')}`)
      capabilities.push({ ...capability, skillId: skill.manifest.id })
    }
  }
  const matches = {}
  for (const id of ['image.crop', 'image.resize', 'image.export']) {
    matches[id] = matchCapability({ discovery, capability: id, capabilities, preferredSkillId })
  }
  const selected = matches['image.resize'].selected
  let assetResult = null
  if (selected && assetRequest) {
    const output = await runCli(selected.root, ['request', '--json', JSON.stringify(assetRequest)])
    assetResult = output.result
    const errors = validate(assetResult, resultSchema, registry, resultSchema.$id)
    if (errors.length) throw new Error(`AssetResult 非法：${errors.join('；')}`)
  }
  return { discovery, capabilities, matches, assetResult, passed: Boolean(selected) && (!assetRequest || Boolean(assetResult)) }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mockRoot = path.join(repoRoot, 'test-fixtures', 'design-skills', 'mocks', 'mock-image-edit')
  const result = await runCapabilityConformance({ skillRoots: [mockRoot] })
  console.log(JSON.stringify({ passed: result.passed, skills: result.discovery.skills.map(item => item.manifest.id) }, null, 2))
  process.exitCode = result.passed ? 0 : 1
}

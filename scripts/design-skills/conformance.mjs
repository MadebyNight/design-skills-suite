import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { runConformance as runContractConformance } from '../../packages/design-skill-contracts/scripts/validate.mjs'
import { runCapabilityConformance } from './capability-conformance.mjs'
import { generateAsset, testProvider } from '../../packages/skill-image-generate/runtime/generator.mjs'

const exec = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')

export function loadHostTemplates(file) {
  if (!file) return []
  const value = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!Array.isArray(value.hosts)) throw new Error('宿主模板文件必须包含 hosts 数组')
  return value.hosts
}

export async function probeHost(template) {
  if (!template?.name || !template?.command || !Array.isArray(template.versionArgs)) throw new Error('宿主模板缺少 name/command/versionArgs')
  try {
    const { stdout, stderr } = await exec(template.command, template.versionArgs, { encoding: 'utf8', windowsHide: true, shell: template.shell === true })
    return { name: template.name, available: true, version: (stdout || stderr).trim(), invocationValidated: false }
  } catch (error) {
    return { name: template.name, available: false, version: '', invocationValidated: false, reason: error.message }
  }
}

export async function runLocalConformance({ hostTemplates = [] } = {}) {
  const contract = runContractConformance()
  const mockRoot = path.join(repoRoot, 'test-fixtures', 'design-skills', 'mocks', 'mock-image-edit')
  const request = { id: 'conformance-edit', usageSlot: 'test.slot', theme: 'mock edit', targetWidth: 50, targetHeight: 50, aspectRatio: '1:1', format: 'png', fit: 'cover', safeArea: 'center', referenceImages: [], forbiddenContent: [], allowGenerate: false, allowEdit: true }
  const capability = await runCapabilityConformance({ skillRoots: [mockRoot], assetRequest: request })
  const generated = await generateAsset(request, { provider: testProvider })
  const combined = generated.strictSizeSatisfied === false && capability.assetResult?.strictSizeSatisfied === true
  fs.rmSync(path.join(repoRoot, 'packages', 'skill-image-generate', 'artifacts'), { recursive: true, force: true })
  const hosts = []
  for (const template of hostTemplates) hosts.push(await probeHost(template))
  return {
    layers: {
      manifest: contract.loadErrors.length === 0,
      capability: capability.passed,
      contracts: contract.passed,
      independentGolden: capability.assetResult?.strictSizeSatisfied === true,
      combinedGolden: combined,
      crossHost: hosts.length > 0 && hosts.every(host => host.invocationValidated),
    },
    hosts,
    passedLocal: contract.passed && capability.passed,
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const templateFlag = process.argv.indexOf('--hosts')
  const templates = templateFlag >= 0 ? loadHostTemplates(path.resolve(process.argv[templateFlag + 1])) : []
  const result = await runLocalConformance({ hostTemplates: templates })
  console.log(JSON.stringify(result, null, 2))
  process.exitCode = result.passedLocal ? 0 : 1
}

import assert from 'node:assert/strict'
import test from 'node:test'
import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')

test('OpenPhoto skill metadata is discoverable and contains no scaffold marker', async () => {
  await access(resolve(root, 'SKILL.md'))
  await access(resolve(root, 'agents/openai.yaml'))
  await access(resolve(root, 'bin/openphoto.mjs'))
  await access(resolve(root, 'references/protocol.md'))
  await access(resolve(root, 'references/capabilities.md'))
  await access(resolve(root, 'package-lock.json'))
  const skill = await readFile(resolve(root, 'SKILL.md'), 'utf8')
  assert.match(skill, /^---\r?\nname: openphoto\r?\n/m)
  assert.doesNotMatch(skill, /\[TODO:/)
  assert.match(skill, /node bin\/openphoto\.mjs capabilities/)
  assert.match(skill, /references\/protocol\.md/)
  assert.match(skill, /references\/capabilities\.md/)
  assert.match(skill, /Place this complete Skill directory in a Skills directory recognized by the host Agent\./)
  assert.match(skill, /If that host discovers Skills only at session startup, restart it or open a new session after installation\./)
  assert.match(skill, /Run every command from this Skill's root directory \(the directory containing `SKILL\.md`\)\./)
  assert.match(skill, /`agents\/openai\.yaml` is optional host UI metadata; the core CLI and JSON workflow is host-independent\./)
  assert.doesNotMatch(skill, /\$CODEX_HOME\/skills\/openphoto/)
  assert.doesNotMatch(skill, /~\/\.codex\/skills\/openphoto/)
  assert.doesNotMatch(skill, /\bCodex\b/i)
  assert.match(skill, /npm ci --omit=dev/)
  assert.match(skill, /Node >=22/)
  assert.match(skill, /OPENPHOTO_BROWSER_PATH/)
  assert.match(skill, /OPENPHOTO_DATA_DIR/)
  assert.match(skill, /Do not start a separate daemon, MCP server/)
  const metadata = await readFile(resolve(root, 'agents/openai.yaml'), 'utf8')
  assert.match(metadata, /display_name: "OpenPhoto"/)
  const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  assert.equal(packageJson.bin?.openphoto, './bin/openphoto.mjs')
  assert.deepEqual(packageJson.files, [
    'SKILL.md',
    'manifest.json',
    'agents',
    'bin',
    'runtime',
    'assets',
    'manifests',
    'references'
  ])
})

test('OpenPhoto docs define rotation direction and host-owned output paths', async () => {
  const [protocol, capabilities] = await Promise.all([
    readFile(resolve(root, 'references/protocol.md'), 'utf8'),
    readFile(resolve(root, 'references/capabilities.md'), 'utf8')
  ])
  assert.match(capabilities, /`canvas\.rotate`:[^\n]*positive `degrees` means clockwise; negative `degrees` means counterclockwise\./)
  assert.match(protocol, /`"degrees": 90` command rotates the canvas clockwise\./)
  assert.match(protocol, /The protocol has no RPC that accepts an output path\. `artifact\.read` returns metadata with a read-only source `path`\. If the user specifies a target path, the host shell must copy from that `path`; it must not overwrite an existing file without confirmation\./)
})

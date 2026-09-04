#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'))

function capabilities() {
  console.log(JSON.stringify({ skillManifest: manifest, capabilities: manifest.provides.map((id, index) => ({
    id, version: '1.0.0', inputSchema: manifest.inputSchema, outputSchema: manifest.outputSchema,
    automatic: true, priority: 1, availabilityCommand: manifest.verifyCommand,
  })) }))
}

function request(value) {
  const bytes = Buffer.from(JSON.stringify(value))
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
  return {
    assetRequestId: value.id,
    artifactId: `mock-${sha256.slice(0, 16)}`,
    path: `mock://${sha256}`,
    mimeType: 'image/png',
    width: value.targetWidth,
    height: value.targetHeight,
    sha256,
    sourceSkill: manifest.id,
    sourceSkillVersion: manifest.version,
    strictSizeSatisfied: true,
    notes: ['deterministic mock image edit'],
  }
}

const [command, flag, raw] = process.argv.slice(2)
if (command === 'capabilities') capabilities()
else if (command === 'request' && flag === '--json') console.log(JSON.stringify({ ok: true, result: request(JSON.parse(raw)) }))
else { console.error('usage: mock-image-edit capabilities | request --json JSON'); process.exitCode = 1 }

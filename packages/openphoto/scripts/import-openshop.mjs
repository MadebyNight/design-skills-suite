import { cp, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const ALLOWED = [
  'index.html',
  'sw.js',
  'manifest.webmanifest',
  'LICENSE',
  'icon-192.png',
  'icon-512.png',
  'vendor'
]

export async function importOpenShop({ sourceDir, outputDir, revision, entries = ALLOWED }) {
  const source = resolve(sourceDir)
  const output = resolve(outputDir)
  await mkdir(output, { recursive: true })
  for (const entry of entries) {
    await cp(resolve(source, entry), resolve(output, entry), { recursive: true, force: true, errorOnExist: false })
  }
  await writeFile(resolve(output, 'UPSTREAM.json'), JSON.stringify({
    source: source.replaceAll('\\', '/'),
    revision,
    importedAt: new Date().toISOString(),
    licenseFile: 'LICENSE'
  }, null, 2) + '\n')
}

async function main() {
  const [sourceDir, outputDir, revision] = process.argv.slice(2)
  if (!sourceDir || !outputDir || !revision) throw new Error('usage: import-openshop <sourceDir> <outputDir> <revision>')
  await importOpenShop({ sourceDir, outputDir, revision })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) void main()

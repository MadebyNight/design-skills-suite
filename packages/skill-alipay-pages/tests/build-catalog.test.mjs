import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { Registry, validate } from '../../design-skill-contracts/scripts/validate.mjs'
import {
  COMPONENT_LIB,
  CONTRACT_DIR,
  PACKAGE_ROOT,
  PAGES,
  buildPage,
  writeCatalog,
} from '../scripts/build-catalog.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const schemaDir = path.join(CONTRACT_DIR, 'schemas')
const schemaId = 'http://schemas.design-agent.local/design-skill/v1/component-catalog.schema.json'
const HAS_GIT = fs.existsSync(path.join(COMPONENT_LIB, '.git'))

// sourceCommit：有嵌套 git 时取 HEAD 并校验 clean；否则读取 SOURCE.json。
function componentSourceCommit() {
  if (HAS_GIT) {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: COMPONENT_LIB, encoding: 'utf8' }).trim()
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: COMPONENT_LIB, encoding: 'utf8' }).trim()
    assert.equal(dirty, '')
    return out
  }
  const record = JSON.parse(fs.readFileSync(path.join(COMPONENT_LIB, 'SOURCE.json'), 'utf8'))
  assert.ok(record.originalCommit, 'SOURCE.json 缺少 originalCommit')
  return record.originalCommit
}

function snapshotCatalogs() {
  return Object.fromEntries(PAGES.map(page => {
    const file = path.join(PACKAGE_ROOT, 'catalog', `${page.file}.catalog.json`)
    return [page.file, fs.readFileSync(file)]
  }))
}

test('生成 8 个首页组件和 7 个落地页组件', () => {
  const commit = componentSourceCommit()
  const home = buildPage(PAGES[0], COMPONENT_LIB, commit)
  const landing = buildPage(PAGES[1], COMPONENT_LIB, commit)
  assert.equal(home.components.length, 8)
  assert.equal(landing.components.length, 7)
  assert.equal(home.sourceCommit, commit)
  assert.equal(landing.sourceCommit, commit)
})

test('生成结果通过公共 ComponentCatalog Schema', () => {
  const registry = Registry.fromDirectory(schemaDir)
  const schema = registry.byId.get(schemaId).schema
  for (const page of PAGES) {
    const catalog = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'catalog', `${page.file}.catalog.json`), 'utf8'))
    assert.deepEqual(validate(catalog, schema, registry, schema.$id), [])
  }
})

test('DOM、class 与 variant 均来自只读组件输入', () => {
  for (const page of PAGES) {
    const css = fs.readFileSync(path.join(COMPONENT_LIB, page.css), 'utf8')
    const catalog = buildPage(page, COMPONENT_LIB, componentSourceCommit())
    for (const component of catalog.components) {
      assert.ok(component.domTemplate.length > 0, `${component.id} DOM 为空`)
      for (const className of [...component.allowedClasses, ...component.allowedVariants]) {
        assert.match(css, new RegExp(`\\.${className.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}(?![\\w-])`))
        assert.match(component.domTemplate, new RegExp(`class="[^"]*\\b${className.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\b`))
      }
    }
  }
})

test('重复生成 byte-identical（无嵌套 Git 也验证输入前后字节不变）', () => {
  const beforeCommit = componentSourceCommit()
  const inputsBefore = snapshotCatalogs()
  writeCatalog()
  const first = snapshotCatalogs()
  writeCatalog()
  const second = snapshotCatalogs()
  assert.deepEqual(first, inputsBefore)
  assert.deepEqual(second, first)
  assert.equal(componentSourceCommit(), beforeCommit)
})

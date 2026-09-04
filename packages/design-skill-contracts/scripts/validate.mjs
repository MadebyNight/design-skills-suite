// 设计 Skill 公共合同最小 JSON Schema 验证器。
//
// 范围约束：
//  - 只覆盖本 package 的 Schema 所用到的关键字。
//  - 不引入 AJV 等外部依赖，仅用 Node 内建能力。
//  - 支持 2020-12 的子集：$ref / $defs / type / properties / additionalProperties
//    / required / items / minItems / maxItems / uniqueItems / minLength / maxLength
//    / pattern / minimum / maximum / multipleOf / enum / const / oneOf。
//
// 同时作为 CLI 运行，也可被 tests/schemas.test.mjs 导入复用。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const PACKAGE_ROOT = path.resolve(__dirname, '..')
export const DEFAULT_SCHEMAS_DIR = path.join(PACKAGE_ROOT, 'schemas')
export const DEFAULT_FIXTURES_DIR = path.join(PACKAGE_ROOT, 'fixtures')

const FROZEN_CAPABILITY_IDS = [
  'page.alipay.home.design',
  'page.alipay.landing.design',
  'image.generate',
  'image.crop',
  'image.resize',
  'image.export',
  'research.search',
  'design.guidance',
  'workflow.orchestrate',
]

const TYPE_CHECKS = {
  string: (v) => typeof v === 'string',
  integer: (v) => Number.isInteger(v),
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  boolean: (v) => typeof v === 'boolean',
  array: (v) => Array.isArray(v),
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  null: (v) => v === null,
}

/** 解析 JSON Pointer 片段（如 /$defs/component）到目标 schema。 */
function applyPointer(root, fragment) {
  if (!fragment || fragment === '/') return root
  let node = root
  for (const raw of fragment.replace(/^\//, '').split('/')) {
    const token = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    if (node && typeof node === 'object' && token in node) {
      node = node[token]
    } else {
      return undefined
    }
  }
  return node
}

/** 收集 schema 中所有 $ref 字符串，用于引用可解析性检查。 */
export function collectRefs(schema, out = []) {
  if (Array.isArray(schema)) {
    for (const item of schema) collectRefs(item, out)
    return out
  }
  if (schema === null || typeof schema !== 'object') return out
  if (typeof schema.$ref === 'string') out.push(schema.$ref)
  for (const key of Object.keys(schema)) {
    if (key === '$ref') continue
    collectRefs(schema[key], out)
  }
  return out
}

/**
 * Schema 注册表：以 $id 为绝对 URI 索引所有 Schema，
 * 支持本地 #/pointer 与同目录相对文件名引用。
 */
export class Registry {
  constructor() {
    this.byId = new Map()
  }

  add(schema, fileName) {
    if (schema && typeof schema === 'object') {
      this.byId.set(schema.$id, { schema, fileName })
    }
  }

  static fromDirectory(dir) {
    const reg = new Registry()
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.schema.json'))
      .sort()
    for (const file of files) {
      const raw = fs.readFileSync(path.join(dir, file), 'utf8')
      reg.add(JSON.parse(raw), file)
    }
    return reg
  }

  /** 解析 $ref；返回 { schema, baseId } 或抛出错误。 */
  resolve(ref, baseId) {
    const hashIdx = ref.indexOf('#')
    const uri = hashIdx === -1 ? ref : ref.slice(0, hashIdx)
    const fragment = hashIdx === -1 ? '' : ref.slice(hashIdx + 1)

    let root = null
    if (uri === '') {
      root = this.byId.get(baseId)?.schema
      if (!root) throw new Error(`无法解析本地引用：${ref}（base ${baseId}）`)
    } else {
      const absolute = new URL(uri, ensureBase(baseId)).href
      const entry = this.byId.get(absolute)
      if (!entry) throw new Error(`未注册的 Schema 引用：${absolute}`)
      root = entry.schema
      if (fragment === '') return { schema: root, baseId: absolute }
      baseId = absolute
    }

    const target = fragment === '' ? root : decodePointer(root, fragment)
    if (target === undefined) {
      throw new Error(`引用指针不存在：${ref}（base ${baseId}）`)
    }
    return { schema: target, baseId }
  }
}

function decodePointer(root, fragment) {
  let node = root
  for (const raw of fragment.replace(/^\//, '').split('/')) {
    const token = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    if (node && typeof node === 'object' && token in node) node = node[token]
    else return undefined
  }
  return node
}

function ensureBase(baseId) {
  if (!baseId) throw new Error('缺少基准 Schema $id，无法解析引用')
  // baseId 是指向 .schema.json 文件的 URI 时，取其所在目录作为相对引用基准
  if (baseId.endsWith('.schema.json')) {
    const idx = baseId.lastIndexOf('/')
    return baseId.slice(0, idx + 1)
  }
  if (!baseId.endsWith('/')) return baseId + '/'
  return baseId
}

/**
 * 校验 instance 是否满足 schema。
 * 返回错误字符串数组；空数组表示通过。
 */
export function validate(instance, schema, registry, baseId = schema.$id) {
  const errors = []
  walk(instance, schema, registry, baseId, '#', errors)
  return errors
}

function walk(instance, schema, registry, baseId, pointer, errors) {
  if (!schema || typeof schema !== 'object') return

  // $ref 跳转
  if (typeof schema.$ref === 'string') {
    const resolved = registry.resolve(schema.$ref, baseId)
    walk(instance, resolved.schema, registry, resolved.baseId, pointer, errors)
    return
  }

  // oneOf（仅允许恰好一个分支通过）
  if (Array.isArray(schema.oneOf)) {
    const passCount = schema.oneOf.filter(
      (sub) => validate(instance, sub, registry, baseId).length === 0
    ).length
    if (passCount !== 1) {
      errors.push(`${pointer}: oneOf 期望恰好一个分支通过，实际 ${passCount} 个`)
    }
  }

  // const
  if (schema.const !== undefined && !Object.is(instance, schema.const)) {
    errors.push(`${pointer}: 期望 const ${JSON.stringify(schema.const)}，实际 ${JSON.stringify(instance)}`)
  }

  // enum
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => Object.is(e, instance))) {
    errors.push(`${pointer}: 值 ${JSON.stringify(instance)} 不在 enum 范围内`)
  }

  // type（可为单个字符串或字符串数组）
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    const ok = types.some((t) => TYPE_CHECKS[t]?.(instance))
    if (!ok) {
      errors.push(`${pointer}: 类型不符，期望 ${JSON.stringify(types)}，实际 ${describeType(instance)}`)
      return
    }
  }

  // 字符串关键字
  if (typeof instance === 'string') {
    if (schema.minLength !== undefined && instance.length < schema.minLength) {
      errors.push(`${pointer}: 长度 ${instance.length} 小于 minLength ${schema.minLength}`)
    }
    if (schema.maxLength !== undefined && instance.length > schema.maxLength) {
      errors.push(`${pointer}: 长度 ${instance.length} 大于 maxLength ${schema.maxLength}`)
    }
    if (schema.pattern !== undefined) {
      try {
        if (!new RegExp(schema.pattern).test(instance)) {
          errors.push(`${pointer}: 不匹配 pattern ${schema.pattern}`)
        }
      } catch (e) {
        errors.push(`${pointer}: pattern 无效 ${e.message}`)
      }
    }
  }

  // 数值关键字
  if (typeof instance === 'number') {
    if (schema.minimum !== undefined && instance < schema.minimum) {
      errors.push(`${pointer}: ${instance} 小于 minimum ${schema.minimum}`)
    }
    if (schema.maximum !== undefined && instance > schema.maximum) {
      errors.push(`${pointer}: ${instance} 大于 maximum ${schema.maximum}`)
    }
    if (schema.multipleOf !== undefined) {
      const quotient = instance / schema.multipleOf
      if (!Number.isFinite(quotient) || Math.abs(quotient - Math.round(quotient)) > 1e-9) {
        errors.push(`${pointer}: ${instance} 不是 ${schema.multipleOf} 的倍数（multipleOf）`)
      }
    }
  }

  // 数组关键字
  if (Array.isArray(instance)) {
    if (schema.minItems !== undefined && instance.length < schema.minItems) {
      errors.push(`${pointer}: 数组长度 ${instance.length} < minItems ${schema.minItems}`)
    }
    if (schema.maxItems !== undefined && instance.length > schema.maxItems) {
      errors.push(`${pointer}: 数组长度 ${instance.length} > maxItems ${schema.maxItems}`)
    }
    if (schema.uniqueItems && new Set(instance).size !== instance.length) {
      errors.push(`${pointer}: 数组元素重复（uniqueItems）`)
    }
    if (schema.items) {
      instance.forEach((item, i) => {
        walk(item, schema.items, registry, baseId, `${pointer}/${i}`, errors)
      })
    }
  }

  // 对象关键字
  if (instance !== null && typeof instance === 'object' && !Array.isArray(instance)) {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!(key in instance)) errors.push(`${pointer}: 缺少必填字段 "${key}"`)
      }
    }
    if (schema.properties && typeof schema.properties === 'object') {
      for (const key of Object.keys(schema.properties)) {
        if (key in instance) {
          walk(instance[key], schema.properties[key], registry, baseId, `${pointer}/${key}`, errors)
        }
      }
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties || {}))
      for (const key of Object.keys(instance)) {
        if (!allowed.has(key)) errors.push(`${pointer}: 未声明字段 "${key}"（additionalProperties 不允许）`)
      }
    }
  }
}

function describeType(v) {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

/** 深度遍历 schema 收集所有 $ref，逐一验证引用可解析。 */
export function verifyRefs(registry) {
  const failures = []
  for (const [id, entry] of registry.byId) {
    for (const ref of collectRefs(entry.schema)) {
      try {
        registry.resolve(ref, id)
      } catch (e) {
        failures.push({ schema: entry.fileName || id, ref, message: e.message })
      }
    }
  }
  return failures
}

/** 校验冻结的 capability ID。返回 { ids, matches }。 */
export function capabilityFrozen(registry) {
  const capSchema = registry.byId.get(
    'http://schemas.design-agent.local/design-skill/v1/capability-manifest.schema.json',
  )?.schema
  if (!capSchema) return { ids: [], matches: false, reason: 'capability-manifest schema 未加载' }
  const ids = capSchema.properties?.id?.enum || []
  const sorted = [...ids].sort()
  const expected = [...FROZEN_CAPABILITY_IDS].sort()
  const matches = JSON.stringify(sorted) === JSON.stringify(expected)
  return { ids: [...ids].sort(), matches }
}

/**
 * 加载 fixtures 目录（valid/invalid 统一由 { schema, fixture } 包装描述）。
 * 返回 { list: [{name, schemaFile, fixture, expectPass}] }
 */
export function loadFixtures(dir) {
  const validDir = path.join(dir, 'valid')
  const invalidDir = path.join(dir, 'invalid')
  const list = []

  const load = (sub, expectPass) => {
    if (!fs.existsSync(sub)) return
    for (const file of fs.readdirSync(sub).filter((f) => f.endsWith('.json')).sort()) {
      const pkg = JSON.parse(fs.readFileSync(path.join(sub, file), 'utf8'))
      list.push({
        name: path.relative(dir, path.join(sub, file)),
        schemaFile: pkg.schema,
        fixture: pkg.fixture,
        expectPass,
      })
    }
  }
  load(validDir, true)
  load(invalidDir, false)
  return list
}

export function findSchemaFile(registry, schemaFile) {
  for (const [, entry] of registry.byId) {
    if (entry.fileName === schemaFile) return entry
  }
  return null
}

/**
 * 运行完整校验：
 *  - Schema 可加载、引用可解析
 *  - valid fixtures 全通过
 *  - invalid fixtures 按预期失败
 *  - 未登记 capability 拒绝（由 invalid capability fixture 覆盖）
 *  - 重复验证确定性
 */
export function runConformance({ schemasDir = DEFAULT_SCHEMAS_DIR, fixturesDir = DEFAULT_FIXTURES_DIR } = {}) {
  const registry = Registry.fromDirectory(schemasDir)

  const loadErrors = []
  for (const [id, entry] of registry.byId) {
    if (!id) loadErrors.push({ file: entry.fileName, message: '缺少 $id' })
    if (entry.schema.schemaVersion === undefined) {
      loadErrors.push({ file: entry.fileName, message: '缺少 schemaVersion 关键字' })
    }
  }

  const refFailures = verifyRefs(registry)
  const frozen = capabilityFrozen(registry)

  const fixtures = loadFixtures(fixturesDir)

  const results = fixtures.map((f) => {
    const entry = findSchemaFile(registry, f.schemaFile)
    if (!entry) {
      return {
        name: f.name,
        expectPass: f.expectPass,
        ok: false,
        errors: [`引用 schema 文件 "${f.schemaFile}" 未加载`],
        deterministic: null,
      }
    }
    const errs1 = validate(f.fixture, entry.schema, registry, entry.schema.$id)
    const errs2 = validate(f.fixture, entry.schema, registry, entry.schema.$id)
    const deterministic = JSON.stringify(errs1) === JSON.stringify(errs2)
    const ok = f.expectPass ? errs1.length === 0 : errs1.length > 0
    return { name: f.name, expectPass: f.expectPass, ok, errors: errs1, deterministic }
  })

  const validFailures = results.filter((f) => f.expectPass && !f.ok)
  const invalidNotRejected = results.filter((f) => !f.expectPass && !f.ok)
  const notDeterministic = results.filter((f) => f.deterministic === false)

  return {
    schemasCount: registry.byId.size,
    loadErrors: loadErrors,
    refFailures: refFailures,
    frozen: frozen,
    fixtures: results,
    validFailures: validFailures,
    invalidNotRejected: invalidNotRejected,
    notDeterministic: notDeterministic,
    passed: loadErrors.length === 0 &&
      refFailures.length === 0 &&
      frozen.matches &&
      validFailures.length === 0 &&
      invalidNotRejected.length === 0 &&
      notDeterministic.length === 0,
  }
}

function formatResult(r) {
  const lines = []
  lines.push(`Schema 数量: ${r.schemasCount}`)
  lines.push(`加载错误: ${r.loadErrors.length}`)
  lines.push(`引用不可解析: ${r.refFailures.length}`)
  lines.push(`capability 冻结: ${r.frozen.matches ? '通过' : '未通过'}`)
  lines.push(`valid fixtures: ${r.fixtures.filter((f) => f.expectPass).length} 个`)
  lines.push(`invalid fixtures: ${r.fixtures.filter((f) => !f.expectPass).length} 个`)
  if (r.frozen.ids.length) lines.push(`冻结能力集合: ${r.frozen.ids.join(', ')}`)
  return lines.join('\n')
}

// ---- CLI 入口 ----
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const result = runConformance()
  console.log(formatResult(result))
  if (result.validFailures.length) {
    console.log('\n[失败] valid fixtures 未通过:')
    for (const f of result.validFailures) console.log(`  - ${f.name}`)
  }
  if (result.invalidNotRejected.length) {
    console.log('\n[失败] 期望失败的 invalid fixtures 未被拒绝:')
    for (const f of result.invalidNotRejected) console.log(`  - ${f.name}`)
  }
  if (result.notDeterministic.length) {
    console.log('\n[失败] 重复验证结果不一致:')
    for (const f of result.notDeterministic) console.log(`  - ${f.name}`)
  }
  if (result.loadErrors.length) {
    console.log('\n[失败] Schema 加载错误:')
    for (const e of result.loadErrors) console.log(`  - ${e.file}: ${e.message}`)
  }
  if (result.refFailures.length) {
    console.log('\n[失败] 引用不可解析:')
    for (const e of result.refFailures) console.log(`  - ${e.id}: ${e.ref} (${e.message})`)
  }
  if (!result.frozen.matches) console.log('\n[失败] capability ID 未与计划冻结集合一致')
  console.log(result.passed ? '\nPASS' : '\nFAIL')
  process.exitCode = result.passed ? 0 : 1
}

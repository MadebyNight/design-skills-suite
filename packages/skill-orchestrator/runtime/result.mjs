import path from 'node:path'
import { Registry, validate } from '../../design-skill-contracts/scripts/validate.mjs'

export function validateOrchestrationResult(result) {
  const schemas = path.resolve(import.meta.dirname, '..', '..', 'design-skill-contracts', 'schemas')
  const registry = Registry.fromDirectory(schemas)
  const schema = registry.byId.get('http://schemas.design-agent.local/design-skill/v1/orchestration-result.schema.json').schema
  const errors = validate(result, schema, registry, schema.$id)
  if (errors.length) throw new Error(`OrchestrationResult 校验失败：${errors.join('；')}`)
  return result
}

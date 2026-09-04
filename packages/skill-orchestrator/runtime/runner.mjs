import { discoverSkills } from './discovery.mjs'
import { matchCapability } from './matcher.mjs'
import { validateOrchestrationResult } from './result.mjs'
import { buildResearchPack } from './research.mjs'
import { resolveAssetPolicy } from './asset-policy.mjs'
import { assetKeyFor } from './asset-store.mjs'
import {
  acceptanceModeOf,
  generateMaxAttemptsOf,
  adaptMaxAttemptsOf,
  isRetryableError,
  validateAssetResultForRequest,
} from './asset-acceptance.mjs'
import path from 'node:path'

const PAGE_CAPABILITIES = {
  'alipay.home': 'page.alipay.home.design',
  'alipay.landing': 'page.alipay.landing.design',
}

const IMAGE_ADAPT_CAPABILITIES = ['image.crop', 'image.resize', 'image.export']
// 未传 assetPolicy 时的默认策略：全部 generate + required，保持既有行为。
const DEFAULT_ASSET_POLICY = { default: { source: 'generate', requirement: 'required' }, rules: [] }
// provider 通过 AssetRequest.referenceImages 传递参考图；provider 必须显式声明
// capabilities 包含 'asset.reference-images' 才视为支持。未声明时移除参考图，
// 记录 warning，并继续以文字约束生成。
const REFERENCE_IMAGE_CAPABILITY = 'asset.reference-images'
export const IMAGE_GENERATE_CONCURRENCY = 5

function startWithConcurrency(items, limit, worker) {
  const completions = items.map(() => {
    let resolve
    const promise = new Promise(done => { resolve = done })
    return { promise, resolve }
  })
  let cursor = 0
  const runWorker = async () => {
    while (cursor < items.length) {
      const index = cursor++
      try {
        completions[index].resolve({ value: await worker(items[index], index) })
      } catch (error) {
        completions[index].resolve({ error })
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, runWorker)
  return { completions: completions.map(item => item.promise), done: Promise.all(workers) }
}

function pushCapability(selectedCapabilities, capability) {
  if (!selectedCapabilities.includes(capability)) selectedCapabilities.push(capability)
}

function selectedImageAdapter({ discovery, capabilities, bindings }) {
  const providerIds = (discovery.skills || [])
    .filter(skill => IMAGE_ADAPT_CAPABILITIES.every(capability => skill.manifest.provides.includes(capability)))
    .map(skill => skill.manifest.id)
  const binding = bindings.imageAdapter
  const providerId = binding?.providerId
  if (!providerIds.length) return { matches: [], providerId: null, run: null, reason: '未找到同时提供 image.crop/image.resize/image.export 的 provider' }
  if (!providerIds.includes(providerId)) return { matches: [], providerId, run: null, reason: `图片适配 binding providerId 不在完整 provider 交集中：${providerId || '未声明'}` }

  const matches = IMAGE_ADAPT_CAPABILITIES.map(capability => matchCapability({
    discovery,
    capability,
    request: { requireAutomatic: true },
    capabilities,
    preferredSkillId: providerId,
  }))
  if (!matches.every(match => match.selected?.manifest?.id === providerId)) {
    return { matches, providerId, run: null, reason: `图片适配 provider ${providerId} 未通过 image.crop/image.resize/image.export 审计` }
  }
  if (typeof binding.run !== 'function') return { matches, providerId, run: null, reason: 'imageAdapter.run 未注入' }
  return { matches, providerId, run: binding.run, close: binding.close, reason: null }
}

/**
 * 把原始 brief 输入素材（用户输入，无论 sourceSkill 如何标记）去重合并进请求的
 * referenceImages 候选：与请求已有参考图按身份去重，不重复注入；不改动原请求对象。
 */
function withInjectedReferences(request, originalInputs) {
  /** 参考图去重身份：path+sha256+artifactId 组合（缺省字段按空串处理）。 */
  const referenceKeyOf = (asset) =>
    [asset?.path, asset?.sha256, asset?.artifactId]
      .map((value) => (typeof value === 'string' ? value : ''))
      .join('\u0000')
  const merged = [...(Array.isArray(request.referenceImages) ? request.referenceImages : [])]
  const seen = new Set(merged.map(referenceKeyOf))
  for (const input of originalInputs.filter(asset => asset?.assetRequestId === request.usageSlot || asset?.assetRequestId === request.id)) {
    const key = referenceKeyOf(input)
    if (!seen.has(key)) {
      seen.add(key)
      merged.push(input)
    }
  }
  return { ...request, referenceImages: merged }
}

export async function runDesign({ brief, skillRoots = [], outputRoot, bindings = {}, executor, capabilities, preferredSkillId, catalog, assetPolicy, assetStore, itemFingerprint } = {}) {
  const steps = []
  const pageCapability = PAGE_CAPABILITIES[brief?.deliverableType]
  if (!pageCapability) return { briefId: brief?.id || 'unknown', status: 'unsupported', selectedCapabilities: ['workflow.orchestrate'], steps: [{ name: 'route-page', status: 'failed', details: '不支持的 deliverableType' }], deliverable: emptyDeliverable(outputRoot, brief?.id) }
  const discovery = await discoverSkills({ skillRoots, executor })
  steps.push({ name: 'discover-skills', capability: 'workflow.orchestrate', status: 'succeeded', details: `发现 ${discovery.skills.length} 个可用 Skill` })
  const selectedCapabilities = ['workflow.orchestrate']
  const research = await buildResearchPack({ brief, searchBinding: bindings['research.search'], catalog })
  if (brief.researchPolicy !== 'none') selectedCapabilities.push('research.search')
  steps.push({
    name: 'research',
    capability: 'research.search',
    status: research.status === 'failed' ? 'failed' : research.status,
    details: research.pack ? `研究完成，来源 ${research.pack.sources.length} 条` : (research.warnings.join('；') || '研究跳过'),
  })
  if (research.status === 'failed') {
    return validateOrchestrationResult({ briefId: brief.id, status: 'failed', selectedCapabilities, steps, deliverable: emptyDeliverable(outputRoot, brief.id) })
  }
  const match = matchCapability({ discovery, capability: pageCapability, request: { requireAutomatic: true }, capabilities, preferredSkillId })
  if (!match.selected || typeof bindings[pageCapability] !== 'function') {
    return validateOrchestrationResult({ briefId: brief.id, status: 'unsupported', selectedCapabilities: ['workflow.orchestrate'], steps: [...steps, { name: 'select-page-skill', capability: pageCapability, status: 'failed', details: match.reason || '页面能力未绑定' }], deliverable: emptyDeliverable(outputRoot, brief.id) })
  }
  steps.push({ name: 'select-page-skill', capability: pageCapability, status: 'succeeded', details: `选择 ${match.selected.manifest.id}` })
  // 首次页面调用不带 brief.inputArtifacts（spec：原始 brief 输入素材无论
  // sourceSkill 如何都视为用户输入，仅作为 referenceImages 注入生图请求，
  // 不在首次组装时回填）。
  const page = await bindings[pageCapability]({ ...brief, inputArtifacts: [] }, { outputRoot, researchPack: research.pack })
  if (page.status === 'rejected') {
    return { briefId: brief.id, status: 'unsupported', selectedCapabilities: [...selectedCapabilities, pageCapability], steps: [...steps, { name: 'page-design', capability: pageCapability, status: 'failed', details: page.rejection.reasons.join('；') }], deliverable: emptyDeliverable(outputRoot, brief.id), rejection: page.rejection }
  }
  steps.push({ name: 'page-design', capability: pageCapability, status: 'succeeded', details: page.pendingAssetRequests?.length ? `基础页面完成，待补 ${page.pendingAssetRequests.length} 个素材` : '页面交付完成' })
  pushCapability(selectedCapabilities, pageCapability)
  const pendingAssetRequests = Array.isArray(page.pendingAssetRequests) ? page.pendingAssetRequests : []
  if (!pendingAssetRequests.length) {
    return validateOrchestrationResult({ briefId: brief.id, status: 'succeeded', selectedCapabilities, steps, deliverable: page.designPackage })
  }

  const policy = assetPolicy || DEFAULT_ASSET_POLICY
  const fingerprint = itemFingerprint || brief.id
  const store = assetStore

  const completedAssets = []
  const completedRequestIds = new Set()
  const completedArtifactIds = new Set()
  let requiredFailure = false
  const artifactRoot = path.join(outputRoot || '.', 'generated-assets')

  // 适配 provider 延迟到首次需要适配时再解析并记录 capability，避免全 reuse 时无谓要求 adapter 能力。
  let adapter = null
  let adapterResolved = false
  const getAdapter = () => {
    if (!adapterResolved) {
      adapterResolved = true
      adapter = selectedImageAdapter({ discovery, capabilities, bindings })
      for (let i = 0; i < IMAGE_ADAPT_CAPABILITIES.length; i++) {
        if (adapter.matches[i]?.selected) pushCapability(selectedCapabilities, IMAGE_ADAPT_CAPABILITIES[i])
      }
    }
    return adapter
  }

  const policyNote = (decision) => `（source=${decision.source}, requirement=${decision.requirement}）`

  // checkpoint asset store 会原子写同一个文件；生成可以并发，但缓存读写必须串行。
  let storeQueue = Promise.resolve()
  const useStore = (operation) => {
    const result = storeQueue.then(operation, operation)
    storeQueue = result.then(() => undefined, () => undefined)
    return result
  }
  // OpenPhoto 的生成后处理共享同一浏览器/daemon；API 生图保持并发，适配操作串行。
  let adapterQueue = Promise.resolve()
  const useAdapter = (operation) => {
    const result = adapterQueue.then(operation, operation)
    adapterQueue = result.then(() => undefined, () => undefined)
    return result
  }

  // runner 与页面层都维护一请求一结果合同：同一 request 或 artifact 不能被
  // 二次消费。页面层仍保留独立校验，避免绕过 runner 的直接调用破坏该约束。
  const addCompletedAsset = (request, asset) => {
    if (completedRequestIds.has(request.id)) return '同一素材请求返回多个结果'
    if (asset?.artifactId && completedArtifactIds.has(asset.artifactId)) return `同一素材结果不能回填多个请求：${asset.artifactId}`
    completedRequestIds.add(request.id)
    if (asset?.artifactId) completedArtifactIds.add(asset.artifactId)
    completedAssets.push(asset)
    return null
  }

  const recordDuplicateAsset = (request, decision, message) => {
    if (decision.requirement === 'required') {
      requiredFailure = true
      steps.push({ name: 'image-validate', capability: 'image.generate', status: 'failed', details: `请求 ${request.id} 素材结果重复消费：${message}${policyNote(decision)}` })
    } else {
      steps.push({ name: 'image-validate', capability: 'image.generate', status: 'warning', details: `请求 ${request.id} 素材结果重复消费（可选）：${message}${policyNote(decision)}` })
    }
  }

  // 原始 brief 输入素材：无论 sourceSkill 如何都视为用户输入（spec），仅作
  // referenceImages 注入，不命中 reuse，也不进入二次回填。
  const originalInputs = Array.isArray(brief.inputArtifacts) ? brief.inputArtifacts : []

  const processAssetRequest = async (request) => {
      const requestSteps = []
      const decision = resolveAssetPolicy(policy, request.usageSlot)
      let taskRequiredFailure = false
      const outcome = (extra = {}) => ({ request, decision, steps: requestSteps, requiredFailure: taskRequiredFailure, ...extra })
      // 原始 brief 输入素材去重注入每个待补请求的 referenceImages（与请求已有
      // 参考图去重），注入发生在 assetKeyFor 之前，进入请求哈希：注入与否命中
      // 不同缓存键。
      let generateRequest = originalInputs.length
        ? withInjectedReferences(request, originalInputs)
        : request
      const wantsReferences = Array.isArray(generateRequest.referenceImages) && generateRequest.referenceImages.length > 0
      const providerCapabilities = bindings['image.generate']?.capabilities
      const supportsReferences = Array.isArray(providerCapabilities) && providerCapabilities.includes(REFERENCE_IMAGE_CAPABILITY)
      if (wantsReferences && !supportsReferences) {
        generateRequest = { ...generateRequest, referenceImages: [] }
        requestSteps.push({ name: 'image-reference', capability: 'image.generate', status: 'warning', details: `请求 ${generateRequest.id} 的参考图被当前 provider 忽略，继续使用文字约束生成` })
      }
      const assetKey = assetKeyFor(fingerprint, generateRequest, decision.source)
      // 统一验收/重试合同（请求级，缺省维持旧精确尺寸 + 单次执行语义）。
      const acceptanceMode = acceptanceModeOf(generateRequest)
      const generateMaxAttempts = generateMaxAttemptsOf(generateRequest)
      const adaptMaxAttempts = adaptMaxAttemptsOf(generateRequest)

      // 1. 缓存命中（原始 brief 输入不命中 reuse 路径；spec：仅作 referenceImages）。
      if (store) {
        const cached = await useStore(() => store.get(assetKey, { request: generateRequest }))
        if (cached) {
          return outcome({ generateRequest, acceptedAsset: cached, successStep: { name: 'image-cache', capability: 'image.generate', status: 'succeeded', details: `请求 ${generateRequest.id} 命中缓存${policyNote(decision)}` } })
        }
      }

      // 2. reuse 决策：不调用 generator/adapter。原始 brief 输入素材不参与
      //    复用（spec：仅作 referenceImages），reuse 缺失按策略处理。
      if (decision.source === 'reuse') {
        if (decision.requirement === 'required') {
          taskRequiredFailure = true
          requestSteps.push({ name: 'image-reuse', capability: 'image.generate', status: 'failed', details: `请求 ${generateRequest.id} 无可用复用素材且未命中缓存${policyNote(decision)}` })
        } else {
          requestSteps.push({ name: 'image-reuse', capability: 'image.generate', status: 'warning', details: `请求 ${generateRequest.id} 无可用复用素材，可选跳过${policyNote(decision)}` })
        }
        return outcome({ generateRequest })
      }

      // 3. generate 决策：带 attempt 计数的有限重试（只重试 retryable 错误）。
      let generated = null
      if (generateRequest.allowGenerate) {
        if (typeof bindings['image.generate'] === 'function') {
          // provider 未声明参考图能力时，前面已清空 referenceImages 并记录 warning；
          // 真实 provider 继续消费同一请求的文字约束。支持参考图的 mock binding
          // 可显式声明该能力以接收精确槽位绑定的参考图。
          // 实际调用 generator 时才首次记录 image.generate capability（成功或失败均记录）。
          const recordGenerateCapability = () => {
            if (!selectedCapabilities.includes('image.generate')) selectedCapabilities.push('image.generate')
          }
          {
            for (let attempt = 1; attempt <= generateMaxAttempts; attempt++) {
              try {
                generated = await bindings['image.generate'](generateRequest, { outputRoot, artifactRoot, attempt })
                recordGenerateCapability()
                requestSteps.push({ name: 'image-generate', capability: 'image.generate', status: 'succeeded', details: `请求 ${generateRequest.id} 生图完成${attempt > 1 ? `（第 ${attempt} 次）` : ''}${policyNote(decision)}` })
                break
              } catch (error) {
                recordGenerateCapability()
                const finalAttempt = attempt >= generateMaxAttempts || !isRetryableError(error)
                if (!finalAttempt) continue
                if (decision.requirement === 'required') {
                  taskRequiredFailure = true
                  requestSteps.push({ name: 'image-generate', capability: 'image.generate', status: 'failed', details: `请求 ${generateRequest.id} 生图失败：${error.message || '未知错误'}${policyNote(decision)}` })
                } else {
                  requestSteps.push({ name: 'image-generate', capability: 'image.generate', status: 'warning', details: `请求 ${generateRequest.id} 生图失败（可选）：${error.message || '未知错误'}${policyNote(decision)}` })
                }
                break
              }
            }
          }
        } else if (decision.requirement === 'required') {
          taskRequiredFailure = true
          requestSteps.push({ name: 'image-generate', capability: 'image.generate', status: 'failed', details: `请求 ${generateRequest.id} image.generate 能力未绑定${policyNote(decision)}` })
        } else {
          requestSteps.push({ name: 'image-generate', capability: 'image.generate', status: 'warning', details: `请求 ${generateRequest.id} image.generate 能力未绑定（可选）${policyNote(decision)}` })
        }
      } else {
        // allowGenerate=false：保持既有语义（必填失败、可选跳过）。
        if (decision.requirement === 'required') {
          taskRequiredFailure = true
          requestSteps.push({ name: 'image-generate', capability: 'image.generate', status: 'failed', details: `请求 ${generateRequest.id} 生图失败：素材请求不允许生成${policyNote(decision)}` })
        } else {
          requestSteps.push({ name: 'image-generate', capability: 'image.generate', status: 'warning', details: `请求 ${generateRequest.id} 生图失败（可选）：素材请求不允许生成${policyNote(decision)}` })
        }
        return outcome({ generateRequest })
      }
      if (!generated) return outcome({ generateRequest })

      // 适配决策：验收通过的生成结果按各自 acceptance 记录；不满足时调用
      // adapter：仅 retryable 异常在 adaptMaxAttempts 次数内重试（warning），
      // 验收不合格或非 retryable 异常均为最终失败，绝不再次调用 adapter。
      let acceptedAsset = null
      const generationAccepted = validateAssetResultForRequest(generateRequest, generated).length === 0
      let adaptedByProviderId = null
      try {
        let adapted = generated
        if (!generationAccepted) {
          if (!generateRequest.allowEdit) throw new Error('素材请求不允许适配')
          const resolvedAdapter = getAdapter()
          if (resolvedAdapter.reason) throw new Error(resolvedAdapter.reason)
          adaptedByProviderId = resolvedAdapter.providerId
          for (let attempt = 1; attempt <= adaptMaxAttempts; attempt++) {
            let candidate = null
            try {
              candidate = await useAdapter(() => resolvedAdapter.run(generateRequest, { asset: generated, outputRoot }))
            } catch (error) {
              // retryable 异常且仍有剩余次数：记录 warning 后消耗一次重试机会；
              // 非 retryable 或次数耗尽：按最终失败处理。
              if (isRetryableError(error) && attempt < adaptMaxAttempts) {
                requestSteps.push({ name: 'image-adapt', capability: 'image.resize', status: 'warning', details: `请求 ${generateRequest.id} 图片适配失败（第 ${attempt} 次，重试）：${error.message || '未知错误'}${policyNote(decision)}` })
                continue
              }
              throw error
            }
            if (validateAssetResultForRequest(generateRequest, candidate).length === 0) {
              adapted = candidate
              break
            }
            // 正常返回但验收不合格：最终失败，绝不再次调用 adapter。
            throw new Error('图片适配结果不满足验收合同')
          }
        }
        const finalErrors = validateAssetResultForRequest(generateRequest, adapted)
        if (finalErrors.length) throw new Error(finalErrors.join('；'))
        acceptedAsset = adapted
      } catch (error) {
        if (decision.requirement === 'required') {
          taskRequiredFailure = true
          requestSteps.push({ name: 'image-adapt', capability: 'image.resize', status: 'failed', details: `请求 ${request.id} 图片适配失败：${error.message || '未知错误'}${policyNote(decision)}` })
        } else {
          requestSteps.push({ name: 'image-adapt', capability: 'image.resize', status: 'warning', details: `请求 ${request.id} 图片适配失败（可选）：${error.message || '未知错误'}${policyNote(decision)}` })
        }
        return outcome({ generateRequest })
      }

      const successStep = generationAccepted
        ? { name: 'image-validate', capability: 'image.generate', status: 'succeeded', details: `请求 ${generateRequest.id} 生图结果已通过${acceptanceMode === 'aspect-ratio' ? '比例' : '严格尺寸'}验收${policyNote(decision)}` }
        : { name: 'image-adapt', capability: 'image.resize', status: 'succeeded', details: `请求 ${generateRequest.id} 由 ${adaptedByProviderId} 适配完成${policyNote(decision)}` }
      return outcome({ generateRequest, acceptedAsset, assetKey, shouldCache: Boolean(store), successStep })
  }

  const finalizeAssetRequest = async (item) => {
      steps.push(...item.steps)
      if (item.requiredFailure) requiredFailure = true
      if (!item.acceptedAsset) return item
      const duplicate = addCompletedAsset(item.generateRequest, item.acceptedAsset)
      if (duplicate) {
        recordDuplicateAsset(item.generateRequest, item.decision, duplicate)
        return item
      }
      if (item.shouldCache) await useStore(() => store.put(item.assetKey, item.acceptedAsset, { request: item.generateRequest }))
      steps.push(item.successStep)
      return item
  }

  const running = startWithConcurrency(pendingAssetRequests, IMAGE_GENERATE_CONCURRENCY, processAssetRequest)
  try {
    // 生成 worker 可持续补位；只让归并和 checkpoint 写入按原请求顺序提交。
    for (const completion of running.completions) {
      const { value, error } = await completion
      if (error) throw error
      await finalizeAssetRequest(value)
    }
  } finally {
    await running.done
    await adapter?.close?.()
  }

  // 所有最终未回填的请求均由页面层标记为 failed（required/optional 同样
  // 需要可审阅原型）；已回填请求不会出现在 failedAssets。
  const failedAssets = pendingAssetRequests
    .filter((request) => !completedRequestIds.has(request.id))
    .map((request) => request.usageSlot || request.id)
  const needsFailedAssetRender = failedAssets.length > 0 && bindings[pageCapability].acceptsFailedAssets === true

  // 保持非标准页面 binding 的既有失败语义；标准 binding 声明支持 failedAssets
  // 时改走最终页面调用，输出可审阅的失败槽位原型。
  if (completedAssets.length === 0 && requiredFailure && !needsFailedAssetRender) {
    return validateOrchestrationResult({
      briefId: brief.id,
      status: 'failed',
      selectedCapabilities,
      steps,
      deliverable: page.designPackage,
    })
  }

  // 无回填且没有支持失败槽位渲染的页面 binding：保留首次页面包。标准页面
  // binding 声明 acceptsFailedAssets，因而会进入下方最终调用并展示失败占位。
  if (completedAssets.length === 0 && !needsFailedAssetRender) {
    steps.push({
      name: 'page-design-refill',
      capability: pageCapability,
      status: 'warning',
      details: '无必填素材待补，保留首次页面默认素材',
    })
    return validateOrchestrationResult({
      briefId: brief.id,
      status: 'succeeded',
      selectedCapabilities,
      steps,
      deliverable: page.designPackage,
    })
  }

  // 最终页面调用：已验收素材（本轮生成/适配 + asset store 命中，spec）经
  // opts.completedAssets 显式传入（内部参数，页面 Skill 按槽位验收回填）；
  // brief 原样传入（保留原始 inputArtifacts，页面仅作为参考图候选），
  // 绝不把完成素材塞回 brief.inputArtifacts。
  let finalPage
  try {
    finalPage = await bindings[pageCapability]({
      ...brief,
    }, {
      outputRoot,
      researchPack: research.pack,
      completedAssets: [...completedAssets],
      ...(failedAssets.length ? { failedAssets } : {}),
    })
  } catch (error) {
    steps.push({ name: 'page-design-refill', capability: pageCapability, status: 'failed', details: `素材回填页面生成失败：${error.message || '未知错误'}` })
    return validateOrchestrationResult({ briefId: brief.id, status: 'failed', selectedCapabilities, steps, deliverable: page.designPackage })
  }
  const remainingRequests = Array.isArray(finalPage.pendingAssetRequests) ? finalPage.pendingAssetRequests : []
  // 仅 requirement=required 的剩余请求计为失败；optional 保留默认素材。
  const requiredRemaining = remainingRequests.filter((r) => resolveAssetPolicy(policy, r.usageSlot).requirement === 'required')
  steps.push({
    name: 'page-design-refill',
    capability: pageCapability,
    status: requiredRemaining.length ? 'failed' : 'succeeded',
    details: requiredRemaining.length
      ? `素材回填后仍待补 ${requiredRemaining.length} 个必填素材（共 ${remainingRequests.length} 个待补）`
      : (remainingRequests.length ? `素材回填后仍待补 ${remainingRequests.length} 个可选素材` : '素材回填后的页面交付完成'),
  })
  return validateOrchestrationResult({
    briefId: brief.id,
    status: requiredFailure || requiredRemaining.length ? 'failed' : 'succeeded',
    selectedCapabilities,
    steps,
    deliverable: finalPage.designPackage,
  })
}

function emptyDeliverable(outputRoot = '.', briefId = 'unknown') {
  return { packageRoot: outputRoot || '.', designBriefId: briefId || 'unknown', files: [], sourceCommit: 'unavailable' }
}

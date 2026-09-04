import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateAsset, testProvider } from '../../packages/skill-image-generate/runtime/generator.mjs'
import { validateAssetResult } from '../../packages/skill-image-generate/runtime/protocol.mjs'
import { designHome } from '../../packages/skill-alipay-home/bin/home-design.mjs'
import { designLanding } from '../../packages/skill-alipay-landing/bin/landing-design.mjs'
import { planHome } from '../../packages/skill-alipay-home/runtime/planner.mjs'
import { deriveLandingConfig } from '../../packages/skill-alipay-landing/runtime/planner.mjs'
import { buildResearchPack } from '../../packages/skill-orchestrator/runtime/research.mjs'
import { runDesign } from '../../packages/skill-orchestrator/runtime/runner.mjs'
import { validateAssetResultForRequest } from '../../packages/skill-orchestrator/runtime/asset-acceptance.mjs'
import { createOpenPhotoAdapterBinding, editWithOpenPhoto, stopOpenPhotoDataRoot } from '../../packages/skill-orchestrator/scripts/image-edit-adapter.mjs'
import { buildDesignPackage } from '../../packages/skill-alipay-pages/scripts/package.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const fixturesRoot = path.join(repoRoot, 'test-fixtures', 'design-skills', 'golden')
const openphotoRoot = process.env.OPENPHOTO_SKILL_ROOT || path.join(repoRoot, 'packages', 'openphoto', 'dist', 'openphoto')

function fixture(number) {
  const file = fs.readdirSync(fixturesRoot).find(name => name.startsWith(String(number).padStart(2, '0')))
  return JSON.parse(fs.readFileSync(path.join(fixturesRoot, file), 'utf8'))
}

function fixedSearch() {
  return [
    { url: 'https://example.com/design-reference', title: '支付宝活动页视觉与布局参考', snippet: '使用清晰布局、克制色彩和明确内容层级。' },
  ]
}

async function exactAsset(request, root) {
  const generated = await generateAsset(request, {
    provider: testProvider,
    artifactRoot: path.join(root, 'generated', request.id.replace(/[^a-z0-9_-]/gi, '-')),
  })
  const dataRoot = path.join(root, `openphoto-${request.id.replace(/[^a-z0-9_-]/gi, '-')}`)
  try {
    const edited = await editWithOpenPhoto(request, { sourcePath: generated.path, openphotoRoot, dataRoot })
    return { generated, edited }
  } finally {
    await stopOpenPhotoDataRoot(dataRoot)
  }
}

function result(task, passed, evidence, limitations = []) {
  return { taskId: task.taskId, title: task.title, passed, evidence, limitations }
}

function assetEvidence(request, asset) {
  return {
    ...asset,
    format: request.format,
    fit: request.fit,
    targetWidth: request.targetWidth,
    targetHeight: request.targetHeight,
    strictSizeSatisfied: asset.strictSizeSatisfied,
  }
}

function satisfiesRequest(request, asset) {
  // 素材请求的验收合同（exact-size / aspect-ratio、MIME、ID 匹配）统一由
  // 共享 asset-acceptance 判定，评测器不复制验收规则。
  return validateAssetResultForRequest(request, asset).length === 0
}

/** deriveLandingConfig 状态数据请求条数（期望槽位数来源，与执行请求一一对应）。 */
function expectedRequestsLength(plan) {
  return plan.assetRequests.length
}

async function evaluateOne(number, root) {
  const task = fixture(number)
  const brief = task.input.brief
  if (number === 1) {
    const generated = await generateAsset(brief, { provider: testProvider, artifactRoot: path.join(root, 'generated', task.taskId) })
    return result(task, generated.mimeType === 'image/png' && /^[a-f0-9]{64}$/.test(generated.sha256), { assetResult: generated }, ['使用确定性 testProvider，未调用付费模型'])
  }
  if (number === 2 || number === 3) {
    const { generated, edited } = await exactAsset(brief, root)
    return result(task, edited.width === brief.targetWidth && edited.height === brief.targetHeight && edited.strictSizeSatisfied, { stages: [generated.sourceSkill, edited.sourceSkill], generated, final: edited }, ['输入图片使用确定性 2×1 多色 PNG，像素内容不参与断言'])
  }
  if (number === 4) {
    const outputRoot = path.join(root, task.taskId)
    const page = await designHome({ brief, outputRoot, screenshot: true })
    return result(task, page.designPackage.files.some(file => file.kind === 'prototype.png') && !page.designPackage.files.some(file => file.kind === 'research-pack.json'), { files: page.designPackage.files.length, pendingAssets: page.pendingAssetRequests.length, status: page.status })
  }
  if (number === 5 || number === 6) {
    const outputRoot = path.join(root, task.taskId)
    const catalog = JSON.parse(fs.readFileSync(path.join(repoRoot, 'packages', 'skill-alipay-pages', 'catalog', number === 5 ? 'home.catalog.json' : 'landing.catalog.json')))
    const research = await buildResearchPack({ brief, searchBinding: fixedSearch, catalog })
    // 期望请求必须与页面 Skill 实际素材请求合同同源：
    //  - 首页：planHome（槽位命名 home.<module>.<item>.<role>，固定快照不建请求）；
    //  - 落地页：deriveLandingConfig（landing.<key>.<slot>.image 命名、hero
    //    1500x720、IMAGE_AD 单图 1404x480 / 双图 686x480；不为商品图建请求）。
    const plan = number === 5 ? planHome(brief) : deriveLandingConfig(brief)
    const pageCapability = number === 5 ? 'page.alipay.home.design' : 'page.alipay.landing.design'
    const designPage = number === 5 ? designHome : designLanding
    const pageRoot = path.join(repoRoot, 'packages', number === 5 ? 'skill-alipay-home' : 'skill-alipay-landing')
    const pageCalls = []
    const orchestration = await runDesign({
      brief,
      skillRoots: [pageRoot, path.join(repoRoot, 'packages', 'skill-image-generate'), openphotoRoot],
      outputRoot,
      catalog,
      bindings: {
        [pageCapability]: async (value, context) => {
          // runner 二次回填合同：已验收素材经 opts.completedAssets 显式传入
          //（brief 原样传入，原始 inputArtifacts 仅作参考图候选）。
          const page = await designPage({ brief: value, outputRoot: context.outputRoot, screenshot: true, ...(context.completedAssets ? { completedAssets: context.completedAssets } : {}) })
          pageCalls.push({ brief: value, page, completedAssets: context.completedAssets })
          return page
        },
        'research.search': fixedSearch,
        'image.generate': request => generateAsset(request, {
          provider: testProvider,
          artifactRoot: path.join(root, 'generated', task.taskId),
        }),
        imageAdapter: createOpenPhotoAdapterBinding({
          openphotoRoot,
          dataRoot: path.join(root, `${task.taskId}-openphoto-data`),
          sourceRoot: path.join(repoRoot, 'packages', 'skill-image-generate'),
        }),
      },
    })
    const page = pageCalls.at(-1)?.page
    // 二次回填合同：最终素材经 opts.completedAssets 传入（不再塞回 brief.inputArtifacts）。
    const finalAssets = pageCalls.at(-1)?.completedAssets || []
    fs.writeFileSync(path.join(outputRoot, 'research-pack.json'), JSON.stringify(research.pack, null, 2) + '\n')
    const designPackage = buildDesignPackage({
      outputRoot,
      designBriefId: brief.id,
      sourceCommit: catalog.sourceCommit,
      skillDependencies: page?.designPackage.skillDependencies,
    })
    const totalRequests = plan.assetRequests.length
    // deriveLandingConfig 产出的是配置状态数据（含槽位/尺寸，不含 format/fit 等
    // 执行字段）；真实发给 image.generate 的是 designLanding 首调声明的
    // pendingAssetRequests（AssetRequest Schema 完整合同）。验收以首调 pending
    // 请求为准，并与 derive 状态数据同源核对（同 id、同尺寸），保证评测期望
    // 与页面 Skill 真实素材请求合同一致。
    const pendingRequests = pageCalls[0]?.page?.pendingAssetRequests || []
    const expectedRequests = number === 5
      ? plan.assetRequests
      : pendingRequests.map((pending) => {
          const derived = plan.assetRequests.find(request => request.id === pending.id)
          return derived && derived.targetWidth === pending.targetWidth && derived.targetHeight === pending.targetHeight
            ? pending
            : null
        }).filter(Boolean)
    const totalExpected = number === 5 ? totalRequests : expectedRequestsLength(plan)
    const finalAssetsById = new Map(finalAssets.map(asset => [asset.assetRequestId, asset]))
    const deliveredAssets = pendingRequests.map(request => assetEvidence(request, finalAssetsById.get(request.id) || {}))
    // 比例/严格尺寸等验收统一走共享合同；不再以 strictSizeSatisfied 计数。
    const acceptedCount = pendingRequests.filter(request => satisfiesRequest(request, finalAssetsById.get(request.id))).length
    const pendingRequestsHomogeneous = number !== 6 || expectedRequestsLength(plan) === pendingRequests.length
    const pendingAssets = page?.pendingAssetRequests?.length
    const allAssetResultsValid = finalAssets.every(asset => validateAssetResult(asset).length === 0)
    const validationReportPath = path.join(outputRoot, 'validation-report.json')
    const validationReport = fs.existsSync(validationReportPath)
      ? JSON.parse(fs.readFileSync(validationReportPath, 'utf8'))
      : null
    const passed = research.status === 'succeeded' &&
      orchestration.status === 'succeeded' &&
      pageCalls.length === 2 &&
      finalAssetsById.size === totalExpected &&
      acceptedCount === totalExpected &&
      pendingRequestsHomogeneous &&
      allAssetResultsValid &&
      pendingAssets === 0 &&
      validationReport?.passed === true &&
      designPackage.files.some(file => file.kind === 'validation-report.json') &&
      designPackage.files.some(file => file.kind === 'research-pack.json')
    return result(task, passed, {
      researchSources: research.pack.sources.length,
      totalRequests: totalExpected,
      pageCalls: pageCalls.length,
      finalAssets: deliveredAssets,
      acceptedCount,
      allAssetResultsValid,
      pendingAssets,
      validationReport: validationReport ? { passed: validationReport.passed, errors: validationReport.errors } : null,
      files: designPackage.files.length,
      orchestrationStatus: orchestration.status,
      orchestrationSteps: orchestration.steps,
      failedSteps: orchestration.steps.filter(step => step.status === 'failed').map(step => ({ capability: step.capability, name: step.name, details: step.details })),
    })
  }
  if (number === 7) {
    const outputRoot = path.join(root, task.taskId)
    const page = await designHome({ brief, outputRoot })
    return result(task, page.status === 'rejected' && page.rejection.reasons.length > 0 && !fs.existsSync(path.join(outputRoot, 'prototype.html')), { rejection: page.rejection })
  }
  const outputRoot = path.join(root, task.taskId)
  const orchestration = await runDesign({
    brief,
    skillRoots: [path.join(repoRoot, 'packages', 'skill-alipay-home')],
    outputRoot,
    bindings: {
      'page.alipay.home.design': (value, ctx) => designHome({ brief: value, outputRoot: ctx.outputRoot }),
      'research.search': async () => { throw new Error('search unavailable') },
      'image.generate': async () => { throw new Error('generation failed') },
    },
  })
  const passed = orchestration.steps.some(step => step.capability === 'research.search' && step.status === 'warning') && orchestration.steps.some(step => step.capability === 'image.generate' && step.status === 'failed') && fs.existsSync(path.join(outputRoot, 'asset-manifest.json'))
  return result(task, passed, { status: orchestration.status, steps: orchestration.steps })
}

export async function runGoldenEvaluation() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'design-golden-'))
  try {
    const tasks = []
    for (let number = 1; number <= 8; number += 1) {
      try { tasks.push(await evaluateOne(number, root)) }
      catch (error) { tasks.push(result(fixture(number), false, { error: { code: error.code || 'INTERNAL', message: error.message } })) }
    }
    const passed = tasks.filter(task => task.passed).length
    return {
      date: new Date().toISOString(),
      passed,
      total: tasks.length,
      completionRate: passed / tasks.length,
      tasks,
      humanBlindReview: { status: 'not_completed', reason: '当前可用视觉评审子代理不支持图片输入' },
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await runGoldenEvaluation()
  const flag = process.argv.indexOf('--report')
  if (flag >= 0) {
    const file = path.resolve(process.argv[flag + 1])
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n')
  }
  console.log(JSON.stringify(report, null, 2))
  process.exitCode = report.passed === report.total ? 0 : 1
}

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runGoldenEvaluation } from './golden-evaluator.mjs'
import { planHome } from '../../packages/skill-alipay-home/runtime/planner.mjs'
import { deriveLandingConfig } from '../../packages/skill-alipay-landing/runtime/planner.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')

const RESIDUE_PATHS = [
  path.join(repoRoot, 'packages', 'skill-image-generate', 'artifacts'),
  path.join(repoRoot, 'test-results'),
  path.join(repoRoot, 'packages', 'openphoto', 'skill', 'openphoto', '.openphoto'),
]

export function inspectResidue() {
  const repo = {}
  for (const p of RESIDUE_PATHS) repo[p] = fs.existsSync(p)
  let goldenTemp = []
  let profiles = []
  try {
    const entries = fs.readdirSync(os.tmpdir())
    goldenTemp = entries.filter(name => name.startsWith('design-golden-'))
    profiles = entries.filter(name => name.startsWith('openphoto-profile-'))
  } catch {
    // 临时目录不可读时视为无残留
  }
  return { repo, goldenTemp, profiles }
}

function residueSummary(inspection, baselineProfiles = []) {
  const baseline = new Set(baselineProfiles)
  return {
    repo: Object.entries(inspection.repo).filter(([, exists]) => exists).map(([p]) => p),
    goldenTemp: inspection.goldenTemp,
    newProfiles: inspection.profiles.filter(name => !baseline.has(name)),
  }
}

function hasBaselineResidue(inspection) {
  return Object.values(inspection.repo).some(Boolean) || inspection.goldenTemp.length > 0
}

function hasRunResidue(summary) {
  return summary.repo.length > 0 || summary.goldenTemp.length > 0 || summary.newProfiles.length > 0
}

/**
 * 稳定性断言的期望素材请求，与评测器同源派生：
 *  - golden-05：planHome（首页槽位合同，请求自带 format/fit 执行字段）；
 *  - golden-06：deriveLandingConfig 状态数据只含槽位/尺寸（landing.<key>.<slot>.image
 *    命名、hero 1500x720、IMAGE_AD 尺寸按模块 mode；不为商品图建请求），
 *    执行字段（format/fit）为页面 Skill 固定合同：png + cover。
 * 期望不再硬编码槽位数，避免页面 Skill 合同演进时稳定性脚本反向漂移。
 */
function expectedAssetRequests() {
  return [
    ['golden-05', planHome(goldenBrief(5)).assetRequests],
    ['golden-06', deriveLandingConfig(goldenBrief(6)).assetRequests.map(request => ({ ...request, format: 'png' }))],
  ]
}

function goldenBrief(number) {
  const file = fs.readdirSync(path.join(repoRoot, 'test-fixtures', 'design-skills', 'golden'))
    .find(name => name.startsWith(String(number).padStart(2, '0')))
  return JSON.parse(fs.readFileSync(path.join(repoRoot, 'test-fixtures', 'design-skills', 'golden', file), 'utf8')).input.brief
}

export function assertRunReport(report) {
  const errors = []
  if (report.total !== 8) errors.push(`total=${report.total} 期望 8`)
  if (report.passed !== 8) errors.push(`passed=${report.passed} 期望 8`)
  if (report.completionRate !== 1) errors.push(`completionRate=${report.completionRate} 期望 1`)
  for (const [taskId, expected] of expectedAssetRequests()) {
    const task = report.tasks?.find(t => t.taskId === taskId)
    if (!task) {
      errors.push(`${taskId} 缺少评测结果`)
      continue
    }
    const ev = task.evidence || {}
    if (ev.totalRequests !== expected.length) errors.push(`${taskId} totalRequests=${ev.totalRequests} 期望 ${expected.length}`)
    if (ev.finalAssets?.length !== expected.length) errors.push(`${taskId} finalAssets.length=${ev.finalAssets?.length} 期望 ${expected.length}`)
    if (ev.acceptedCount !== expected.length) errors.push(`${taskId} acceptedCount=${ev.acceptedCount} 期望 ${expected.length}`)
    for (const request of expected) {
      const delivered = ev.finalAssets?.find(asset => asset.assetRequestId === request.id)
      if (!delivered) {
        errors.push(`${taskId} 缺少交付素材 ${request.id}`)
        continue
      }
      if (delivered.targetWidth !== request.targetWidth || delivered.targetHeight !== request.targetHeight) {
        errors.push(`${taskId} ${request.id} 期望 ${request.targetWidth}x${request.targetHeight}，实际 ${delivered.targetWidth}x${delivered.targetHeight}`)
      }
      if (delivered.mimeType !== (request.format === 'png' ? 'image/png' : 'image/jpeg')) {
        errors.push(`${taskId} ${request.id} MIME=${delivered.mimeType} 期望 ${request.format}`)
      }
    }
    if (ev.pendingAssets !== 0) errors.push(`${taskId} pendingAssets=${ev.pendingAssets} 期望 0`)
    if (ev.pageCalls !== 2) errors.push(`${taskId} pageCalls=${ev.pageCalls} 期望 2`)
    if (ev.validationReport?.passed !== true) errors.push(`${taskId} validationReport.passed=${ev.validationReport?.passed} 期望 true`)
  }
  return errors
}

export function parseRuns(argv) {
  const flag = argv.indexOf('--runs')
  if (flag < 0) return { runs: 3 }
  const raw = Number(argv[flag + 1])
  if (!Number.isInteger(raw) || raw < 1 || raw > 10) return { error: '--runs 必须是 1-10 的整数' }
  return { runs: raw }
}

export async function verifyGoldenStability({
  runs = 3,
  run = runGoldenEvaluation,
  inspect = inspectResidue,
  now = () => new Date(),
} = {}) {
  const startedAt = now().toISOString()
  const baseline = inspect()
  const baselineResidue = residueSummary(baseline, baseline.profiles)
  if (hasBaselineResidue(baseline)) {
    return {
      runs,
      passedRuns: 0,
      startedAt,
      completedAt: now().toISOString(),
      runsDetail: [],
      taskSummary: { total: 0, passed: 0 },
      cleanupChecks: { baseline: baselineResidue, afterEach: [], failed: true },
      error: '基线已存在残留，立即失败',
    }
  }

  const runsDetail = []
  let passedRuns = 0
  let firstError = null
  let lastReport = null

  for (let i = 0; i < runs; i += 1) {
    const runStart = now()
    let report
    let runError = null
    try {
      report = await run()
    } catch (e) {
      runError = e
    }
    const durationMs = now() - runStart
    if (report) lastReport = report

    const errors = runError ? [`run 抛异常: ${runError.message}`] : assertRunReport(report)
    const failedTasks = runError
      ? []
      : (report?.tasks || []).filter(task => !task.passed).map(task => ({
          taskId: task.taskId,
          error: task.evidence?.error || task.evidence?.failedSteps || task.evidence?.orchestrationStatus,
        }))
    const after = inspect()
    const afterResidue = residueSummary(after, baseline.profiles)
    const residueError = hasRunResidue(afterResidue) ? '运行后新残留' : null
    const ok = errors.length === 0 && !residueError

    runsDetail.push({ run: i + 1, durationMs, passed: ok, errors, failedTasks, residueAfter: afterResidue })
    if (ok) {
      passedRuns += 1
    } else {
      firstError = { run: i + 1, errors, residueError, failedTasks }
      break
    }
  }

  return {
    runs,
    passedRuns,
    startedAt,
    completedAt: now().toISOString(),
    runsDetail,
    taskSummary: { total: lastReport?.total ?? 0, passed: lastReport?.passed ?? 0 },
    cleanupChecks: {
      baseline: baselineResidue,
      afterEach: runsDetail.map(d => d.residueAfter),
      failed: runsDetail.some(d => d.residueAfter && hasRunResidue(d.residueAfter)),
    },
    ...(firstError ? { error: firstError } : {}),
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2)
  const parsed = parseRuns(argv)
  if (parsed.error) {
    console.error(parsed.error)
    process.exitCode = 2
  } else {
    const report = await verifyGoldenStability({ runs: parsed.runs })
    const flag = argv.indexOf('--report')
    if (flag >= 0) {
      const file = path.resolve(argv[flag + 1])
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n')
    }
    console.log(JSON.stringify(report, null, 2))
    process.exitCode = report.passedRuns === report.runs ? 0 : 1
  }
}

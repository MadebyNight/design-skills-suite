import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyGoldenStability, assertRunReport, parseRuns, inspectResidue } from './verify-golden-stability.mjs'
import { planHome } from '../../packages/skill-alipay-home/runtime/planner.mjs'
import { deriveLandingConfig } from '../../packages/skill-alipay-landing/runtime/planner.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function goldenBrief(number) {
  const file = fs.readdirSync(path.join(repoRoot, 'test-fixtures', 'design-skills', 'golden'))
    .find(name => name.startsWith(String(number).padStart(2, '0')))
  return JSON.parse(fs.readFileSync(path.join(repoRoot, 'test-fixtures', 'design-skills', 'golden', file), 'utf8')).input.brief
}

function okReport() {
  // 期望槽位与页面 Skill 真实合同同源派生（首页 planHome、落地页 deriveLandingConfig），
  // 不再硬编码 17/5 等旧链路数字。落地页 derive 状态数据无 format 执行字段，
  // 真实请求合同固定 png（与 verify-golden-stability.mjs 的 expectedAssetRequests 一致）。
  const expected = [
    ['golden-05', planHome(goldenBrief(5)).assetRequests],
    ['golden-06', deriveLandingConfig(goldenBrief(6)).assetRequests.map(request => ({ ...request, format: 'png' }))],
  ]
  return {
    total: 8,
    passed: 8,
    completionRate: 1,
    tasks: expected.map(([taskId, requests]) => ({
      taskId,
      passed: true,
      evidence: {
        totalRequests: requests.length,
        finalAssets: requests.map(request => ({
          assetRequestId: request.id,
          targetWidth: request.targetWidth,
          targetHeight: request.targetHeight,
          mimeType: request.format === 'png' ? 'image/png' : 'image/jpeg',
        })),
        acceptedCount: requests.length,
        pendingAssets: 0,
        pageCalls: 2,
        validationReport: { passed: true },
      },
    })),
  }
}

function cleanInspect() {
  return { repo: { a: false, b: false, c: false }, goldenTemp: [], profiles: ['existing-profile'] }
}

function dirtyInspect() {
  return { repo: { a: true, b: false, c: false }, goldenTemp: [], profiles: ['existing-profile'] }
}

test('成功连续 3 次：passedRuns=3 且无残留', async () => {
  const report = await verifyGoldenStability({ runs: 3, run: async () => okReport(), inspect: cleanInspect })
  assert.equal(report.passedRuns, 3)
  assert.equal(report.runs, 3)
  assert.equal(report.cleanupChecks.failed, false)
  assert.equal(report.runsDetail.length, 3)
  for (const d of report.runsDetail) assert.equal(d.passed, true)
  assert.equal(report.taskSummary.total, 8)
  assert.equal(report.taskSummary.passed, 8)
})

test('任一次非 8/8 立即失败并停止后续 run', async () => {
  let call = 0
  const report = await verifyGoldenStability({
    runs: 3,
    run: async () => {
      call += 1
      if (call === 2) return { ...okReport(), passed: 7, completionRate: 7 / 8 }
      return okReport()
    },
    inspect: cleanInspect,
  })
  assert.equal(report.passedRuns, 1)
  assert.equal(report.runsDetail.length, 2)
  assert.equal(report.runsDetail[1].passed, false)
  assert.ok(report.error)
  assert.equal(report.cleanupChecks.failed, false, '业务评测失败不得误标为 cleanup 失败')
})

test('golden-05/06 断言失败被捕获', async () => {
  const bad = okReport()
  bad.tasks.find(t => t.taskId === 'golden-05').evidence.totalRequests = 999
  const report = await verifyGoldenStability({ runs: 1, run: async () => bad, inspect: cleanInspect })
  assert.equal(report.passedRuns, 0)
  assert.ok(report.error.errors.some(e => e.includes('golden-05 totalRequests')))
})

test('非法 runs 参数被拒绝', () => {
  assert.equal(parseRuns(['--runs', '0']).error, '--runs 必须是 1-10 的整数')
  assert.equal(parseRuns(['--runs', '11']).error, '--runs 必须是 1-10 的整数')
  assert.equal(parseRuns(['--runs', 'abc']).error, '--runs 必须是 1-10 的整数')
  assert.equal(parseRuns(['--runs', '2.5']).error, '--runs 必须是 1-10 的整数')
  assert.deepEqual(parseRuns(['--runs', '5']), { runs: 5 })
  assert.deepEqual(parseRuns([]), { runs: 3 })
})

test('基线残留立即失败', async () => {
  const report = await verifyGoldenStability({ runs: 3, run: async () => okReport(), inspect: dirtyInspect })
  assert.equal(report.passedRuns, 0)
  assert.equal(report.runsDetail.length, 0)
  assert.equal(report.error, '基线已存在残留，立即失败')
  assert.equal(report.cleanupChecks.failed, true)
})

test('运行后新残留立即失败且 cleanupChecks.failed=true', async () => {
  let call = 0
  const report = await verifyGoldenStability({
    runs: 3,
    run: async () => okReport(),
    inspect: () => {
      call += 1
      return call === 2
        ? { repo: { a: false, b: false, c: false }, goldenTemp: ['design-golden-new'], profiles: ['existing-profile', 'new-profile'] }
        : cleanInspect()
    },
  })
  assert.equal(report.passedRuns, 0)
  assert.equal(report.runsDetail.length, 1)
  assert.equal(report.runsDetail[0].passed, false)
  assert.equal(report.error.residueError, '运行后新残留')
  assert.equal(report.cleanupChecks.failed, true)
})

test('业务评测失败时保留 failedTasks 且不误标 cleanup 失败', async () => {
  const bad = okReport()
  bad.passed = 7
  bad.completionRate = 7 / 8
  bad.tasks.find(t => t.taskId === 'golden-05').passed = false
  bad.tasks.find(t => t.taskId === 'golden-05').evidence.orchestrationStatus = 'failed'
  bad.tasks.find(t => t.taskId === 'golden-05').evidence.failedSteps = [{ capability: 'image.export', name: 'image-adapt', details: 'OpenPhoto 输出不满足目标尺寸' }]
  const report = await verifyGoldenStability({ runs: 1, run: async () => bad, inspect: cleanInspect })
  assert.equal(report.passedRuns, 0)
  assert.equal(report.cleanupChecks.failed, false)
  const failed = report.runsDetail[0].failedTasks
  assert.ok(failed.some(t => t.taskId === 'golden-05'))
  assert.deepEqual(failed.find(t => t.taskId === 'golden-05').error, [{ capability: 'image.export', name: 'image-adapt', details: 'OpenPhoto 输出不满足目标尺寸' }])
})

test('report 结构完整', async () => {
  const report = await verifyGoldenStability({ runs: 2, run: async () => okReport(), inspect: cleanInspect })
  assert.equal(typeof report.startedAt, 'string')
  assert.equal(typeof report.completedAt, 'string')
  assert.equal(report.runs, 2)
  assert.equal(report.passedRuns, 2)
  assert.equal(report.runsDetail.length, 2)
  for (const d of report.runsDetail) {
    assert.equal(typeof d.durationMs, 'number')
    assert.equal(d.passed, true)
  }
  assert.deepEqual(report.taskSummary, { total: 8, passed: 8 })
  assert.ok(report.cleanupChecks.baseline)
  assert.equal(report.cleanupChecks.afterEach.length, 2)
  assert.equal(report.cleanupChecks.failed, false)
})

test('assertRunReport 对合法报告返回空错误', () => {
  assert.deepEqual(assertRunReport(okReport()), [])
})

test('inspectResidue 返回 repo 与 temp 结构', () => {
  const r = inspectResidue()
  assert.equal(typeof r.repo, 'object')
  assert.ok(Array.isArray(r.goldenTemp))
  assert.ok(Array.isArray(r.profiles))
})

test('运行前已有 profile 不阻塞，只有新增 profile 算残留', async () => {
  let calls = 0
  const report = await verifyGoldenStability({
    runs: 1,
    run: async () => okReport(),
    inspect: () => {
      calls += 1
      return calls === 1
        ? { repo: { a: false }, goldenTemp: [], profiles: ['old-a', 'old-b'] }
        : { repo: { a: false }, goldenTemp: [], profiles: ['old-a', 'old-b'] }
    },
  })
  assert.equal(report.passedRuns, 1)
  assert.equal(report.cleanupChecks.failed, false)
})

test('运行后新增 profile 被判定为残留', async () => {
  let calls = 0
  const report = await verifyGoldenStability({
    runs: 1,
    run: async () => okReport(),
    inspect: () => {
      calls += 1
      return calls === 1
        ? { repo: { a: false }, goldenTemp: [], profiles: ['old'] }
        : { repo: { a: false }, goldenTemp: [], profiles: ['old', 'new'] }
    },
  })
  assert.equal(report.passedRuns, 0)
  assert.equal(report.error.residueError, '运行后新残留')
  assert.deepEqual(report.runsDetail[0].residueAfter.newProfiles, ['new'])
})

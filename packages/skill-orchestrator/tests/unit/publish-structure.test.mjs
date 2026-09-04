import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runBatch, BatchRunnerError } from '../../runtime/batch-runner.mjs'
import { loadCheckpoint } from '../../runtime/checkpoint.mjs'
import { publishBatchDelivery } from '../../runtime/publish-structure.mjs'
import { assemblePage } from '../../../skill-alipay-pages/scripts/assemble.mjs'
import { validateOutput } from '../../../skill-alipay-pages/scripts/validate.mjs'

const brief = {
  id: 'brief-1',
  goal: '首页',
  deliverableType: 'alipay.home',
  audience: '年轻用户',
  brandConstraints: [],
  contentRequirements: [],
  visualConstraints: [],
  outputSpec: { width: 375, height: 812, format: 'png' },
  inputArtifacts: [],
  researchPolicy: 'none',
  forbiddenChanges: [],
}
const landingBrief = { ...brief, id: 'brief-land', deliverableType: 'alipay.landing' }
const assetPolicy = { default: { source: 'generate', requirement: 'required' }, rules: [] }
const providerIdentity = { id: 'openai-compatible', model: 'gpt-image-2', baseURL: 'https://api.example.com/v1' }
const sourceCommit = 'abc123'

function request(items, over = {}) {
  return { schemaVersion: '1', batchId: 'batch-pub', items, ...over }
}
function homeItem(id) {
  return { itemId: id, brief: { ...brief, id: `brief-${id}` }, assetPolicy }
}
function landingItem(id) {
  return { itemId: id, brief: { ...landingBrief, id: `brief-${id}` }, assetPolicy }
}

function okOrchestration() {
  return { briefId: 'b', status: 'succeeded', selectedCapabilities: ['workflow.orchestrate'], steps: [], deliverable: { packageRoot: '.', designBriefId: 'b', files: [], sourceCommit: 'x' } }
}

/**
 * 发布合同要求的最小成功 attempt 产物：原型（引用 styles + assets）+ 配置，
 * 可选附带 generated-assets/ 与 openphoto-data/ 禁区目录。
 */
function makePublishableAttempt(attemptRoot, itemId, { configType = 'home', withGeneratedAssets = false, withOpenphotoData = false, withCssBackground = false, html } = {}) {
  fs.mkdirSync(attemptRoot, { recursive: true })
  fs.writeFileSync(path.join(attemptRoot, 'prototype.html'), html || `<!doctype html>
<html lang="zh">
<head>
  <link rel="stylesheet" href="styles/tokens.css">
</head>
<body>
  <img src="assets/final-hero.png" alt="hero">
</body>
</html>`)
  fs.mkdirSync(path.join(attemptRoot, 'styles'), { recursive: true })
  fs.writeFileSync(
    path.join(attemptRoot, 'styles', 'tokens.css'),
    withCssBackground ? ':root { --x: 1 }\n.page { background: url("../assets/page-bg.png") center / cover; }\n' : ':root { --x: 1 }\n',
  )
  fs.mkdirSync(path.join(attemptRoot, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(attemptRoot, 'assets', 'final-hero.png'), 'final-asset-bytes')
  if (withCssBackground) fs.writeFileSync(path.join(attemptRoot, 'assets', 'page-bg.png'), 'background-asset-bytes')
  const configName = configType === 'landing' ? 'landing-config.json' : 'home-config.json'
  // 已有配置文件时不覆盖（联动测试需保留手写的 carousel/waistBanners 结构）。
  if (!fs.existsSync(path.join(attemptRoot, configName))) {
    fs.writeFileSync(path.join(attemptRoot, configName), JSON.stringify({ page: { name: `page-${itemId}` } }))
  }
  fs.writeFileSync(path.join(attemptRoot, 'validation-report.json'), JSON.stringify({ passed: true, errors: [], assets: [] }))
  if (withGeneratedAssets) {
    fs.mkdirSync(path.join(attemptRoot, 'generated-assets'), { recursive: true })
    fs.writeFileSync(path.join(attemptRoot, 'generated-assets', 'src-gen.png'), 'intermediate')
  }
  if (withOpenphotoData) {
    fs.mkdirSync(path.join(attemptRoot, 'openphoto-data'), { recursive: true })
    fs.writeFileSync(path.join(attemptRoot, 'openphoto-data', 'daemon.json'), '{}')
  }
}

/** 收集目录内全部相对文件路径（POSIX 形态）。 */
function listFiles(root, current = root, prefix = '') {
  const out = []
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...listFiles(root, path.join(current, entry.name), rel))
    else out.push(rel)
  }
  return out.sort()
}

test('run：终态自动发布四层结构（index/assets/configs/other + runtime 追溯）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-structure-'))
  try {
    const result = await runBatch({
      mode: 'run',
      batchRequest: request([homeItem('page-a')]),
      batchRoot: root,
      sourceCommit,
      providerIdentity,
      runItem: async ({ item, attemptRoot }) => {
        makePublishableAttempt(attemptRoot, item.itemId, { withGeneratedAssets: true, withOpenphotoData: true, withCssBackground: true })
        return okOrchestration()
      },
    })
    assert.equal(result.status, 'succeeded')
    // 顶层合同：batchRoot 顶层最终只允许 index.html / assets / configs / other。
    assert.deepEqual(
      fs.readdirSync(root).sort(),
      ['assets', 'configs', 'index.html', 'other'],
      '顶层只有四项：index.html/assets/configs/other',
    )
    // 四层根目录 + 入口。
    assert.ok(fs.existsSync(path.join(root, 'index.html')), 'index.html 存在')
    assert.ok(fs.statSync(path.join(root, 'assets', 'page-a')).isDirectory(), 'assets/<itemId>/ 存在')
    assert.ok(fs.existsSync(path.join(root, 'configs', 'page-a.config.json')), 'configs/<itemId>.config.json 存在')
    assert.ok(fs.statSync(path.join(root, 'other', 'page-a')).isDirectory(), 'other/<itemId>/ 存在')
    assert.ok(fs.statSync(path.join(root, 'other', 'runtime')).isDirectory(), 'other/runtime/ 存在')
    // other/<itemId>/ 内容：原型、styles、validation report。
    const pageDir = path.join(root, 'other', 'page-a')
    assert.ok(fs.existsSync(path.join(pageDir, 'prototype.html')))
    assert.ok(fs.existsSync(path.join(pageDir, 'styles', 'tokens.css')))
    assert.ok(fs.existsSync(path.join(pageDir, 'validation-report.json')))
    // 素材发布到 assets/<itemId>/ 且原型引用已改写。
    assert.ok(fs.existsSync(path.join(root, 'assets', 'page-a', 'final-hero.png')))
    assert.ok(fs.existsSync(path.join(root, 'assets', 'page-a', 'page-bg.png')), 'CSS url(...) 背景素材发布到 assets/<itemId>/')
    const html = fs.readFileSync(path.join(pageDir, 'prototype.html'), 'utf8')
    assert.ok(html.includes('src="../../assets/page-a/final-hero.png"'), '素材引用改写为 ../../assets/<itemId>/')
    assert.ok(html.includes('href="styles/tokens.css"'), 'styles 同目录引用保留')
    const css = fs.readFileSync(path.join(pageDir, 'styles', 'tokens.css'), 'utf8')
    assert.ok(css.includes('url("../../../assets/page-a/page-bg.png")'), 'CSS 背景引用改写到发布素材目录')
    // 禁区不进入发布区（other/runtime 属于运行时追溯，items 内禁区不算发布区）。
    assert.deepEqual(listFiles(path.join(root, 'other', 'page-a')).filter((f) => f.includes('generated-assets')), [])
    assert.deepEqual(listFiles(path.join(root, 'other', 'page-a')).filter((f) => f.includes('openphoto-data')), [])
    // runtime 追溯文件。
    for (const name of ['request.json', 'checkpoint.json', 'result.json']) {
      assert.ok(fs.existsSync(path.join(root, 'other', 'runtime', name)), `other/runtime/${name} 存在`)
    }
    // 入口使用设计模板（蓝金响应式）：列出成功页面与四类入口链接。
    const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
    assert.match(index, /<!doctype html>/i)
    assert.match(index, /--gold:#d6ad67/, '使用设计模板蓝金主题')
    assert.match(index, /prefers-reduced-motion/, '保留响应式模板的无障碍断点')
    const pageEntry = index.match(/<section class="page-entry"[^>]*>[\s\S]*?<\/section>\s*<\/section>\s*<div class="entry-preview-row"/)
    assert.ok(index.includes('data-item-id="page-a"'), '入口列出成功页面')
    assert.ok(index.includes('data-page-type="alipay.home"'), '入口含页面类型')
    assert.ok(index.includes('page-a') && /page-a/.test(index), '入口含页面标题')
    for (const [kind, ref] of [
      ['prototype', 'other/page-a/prototype.html'],
      ['config', 'configs/page-a.config.json'],
      ['assets', 'assets/page-a/'],
    ]) {
      const cardMatch = new RegExp(`data-kind="${kind}"[^>]*href="([^"]+)"`).exec(index)
      assert.ok(cardMatch, `入口含 ${kind} 卡片`)
      assert.equal(cardMatch[1], ref, `${kind} 卡片指向发布层相对路径`)
      assert.ok(fs.existsSync(path.join(root, ...ref.split('/'))), `${kind} 链接在发布层真实存在`)
    }
    // 截图缺失：模板渲染 fallback，不产出死链。
    assert.ok(!/data-kind="screenshot"[^>]*href="[^"]*\.png"/.test(index), '无截图时 screenshot 卡片指向锚点')
    // attempt 保持原样（原型未被改写、禁区目录仍在）。
    const attemptHtml = fs.readFileSync(path.join(root, 'other', 'runtime', 'items', 'page-a', 'attempts', '0001', 'prototype.html'), 'utf8')
    assert.ok(attemptHtml.includes('src="assets/final-hero.png"'), 'attempt 原型引用保持原样')
    assert.ok(fs.existsSync(path.join(root, 'other', 'runtime', 'items', 'page-a', 'attempts', '0001', 'generated-assets', 'src-gen.png')), 'attempt 内 generated-assets 保留')
    assert.ok(fs.existsSync(path.join(root, 'other', 'runtime', 'items', 'page-a', 'attempts', '0001', 'openphoto-data', 'daemon.json')), 'attempt 内 openphoto-data 保留')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('attempt 产物引用缺失/越界/绝对路径 → 发布按 BATCH_PUBLISH_* 明确抛出', async () => {
  // 缺失依赖。
  const missingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-missing-'))
  try {
    await assert.rejects(
      () => runBatch({
        mode: 'run',
        batchRequest: request([homeItem('bad-a')]),
        batchRoot: missingRoot,
        sourceCommit,
        providerIdentity,
        runItem: async ({ item, attemptRoot }) => {
          makePublishableAttempt(attemptRoot, item.itemId)
          fs.rmSync(path.join(attemptRoot, 'assets', 'final-hero.png'))
          return okOrchestration()
        },
      }),
      (e) => e instanceof BatchRunnerError && e.code === 'BATCH_PUBLISH_INCOMPLETE',
    )
  } finally { fs.rmSync(missingRoot, { recursive: true, force: true }) }

  // 绝对路径引用。
  const absRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-abs-'))
  try {
    await assert.rejects(
      () => runBatch({
        mode: 'run',
        batchRequest: request([homeItem('bad-b')]),
        batchRoot: absRoot,
        sourceCommit,
        providerIdentity,
        runItem: async ({ item, attemptRoot }) => {
          makePublishableAttempt(attemptRoot, item.itemId, { html: '<!doctype html><html lang="zh"><body><img src="C:\\abs\\x.png"></body></html>' })
          return okOrchestration()
        },
      }),
      (e) => e.code === 'BATCH_PUBLISH_INVALID',
    )
  } finally { fs.rmSync(absRoot, { recursive: true, force: true }) }

  // 缺配置文件。
  const noConfigRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-noconfig-'))
  try {
    await assert.rejects(
      () => runBatch({
        mode: 'run',
        batchRequest: request([homeItem('bad-c')]),
        batchRoot: noConfigRoot,
        sourceCommit,
        providerIdentity,
        runItem: async ({ item, attemptRoot }) => {
          makePublishableAttempt(attemptRoot, item.itemId)
          fs.rmSync(path.join(attemptRoot, 'home-config.json'))
          return okOrchestration()
        },
      }),
      (e) => e.code === 'BATCH_PUBLISH_INCOMPLETE',
    )
  } finally { fs.rmSync(noConfigRoot, { recursive: true, force: true }) }
})

test('部分失败批次：只发布成功 item，失败页不进入入口', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-partial-'))
  try {
    const result = await runBatch({
      mode: 'run',
      batchRequest: request([homeItem('ok-page'), homeItem('bad-page')]),
      batchRoot: root,
      sourceCommit,
      providerIdentity,
      runItem: async ({ item, attemptRoot }) => {
        if (item.itemId === 'bad-page') throw new Error('boom')
        makePublishableAttempt(attemptRoot, item.itemId)
        return okOrchestration()
      },
    })
    assert.equal(result.status, 'partially_failed')
    assert.ok(fs.existsSync(path.join(root, 'assets', 'ok-page', 'final-hero.png')))
    assert.ok(fs.existsSync(path.join(root, 'configs', 'ok-page.config.json')))
    assert.equal(fs.existsSync(path.join(root, 'other', 'bad-page')), false, '失败 item 不发布')
    const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
    assert.ok(index.includes('ok-page'))
    assert.doesNotMatch(index, /bad-page/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('发布幂等：resume 后重新发布覆盖并重建发布区，attempt 记录不变', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-idempotent-'))
  try {
    await runBatch({
      mode: 'run',
      batchRequest: request([homeItem('a'), homeItem('b')]),
      batchRoot: root,
      sourceCommit,
      providerIdentity,
      runItem: async ({ item, attemptRoot }) => {
        if (item.itemId === 'b') throw new Error('interrupted')
        makePublishableAttempt(attemptRoot, item.itemId)
        return okOrchestration()
      },
    })
    const indexV1 = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
    assert.ok(indexV1.includes('data-item-id="a"'))
    // 篡改发布区证明重建生效。
    fs.writeFileSync(path.join(root, 'other', 'a', 'prototype.html'), 'stale')
    // 模拟中断：b 置为 running，resume 后发布重建。
    const ck = loadCheckpoint(path.join(root, 'other', 'runtime'))
    ck.items = ck.items.map((i) => (i.itemId === 'b' ? { ...i, status: 'running' } : i))
    fs.writeFileSync(path.join(root, 'other', 'runtime', 'checkpoint.json'), JSON.stringify(ck, null, 2))
    const result = await runBatch({
      mode: 'resume',
      batchRoot: root,
      sourceCommit,
      providerIdentity,
      runItem: async ({ item, attemptRoot }) => {
        makePublishableAttempt(attemptRoot, item.itemId)
        return okOrchestration()
      },
    })
    assert.equal(result.status, 'succeeded')
    const indexV2 = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
    assert.ok(indexV2.includes('data-item-id="b"'), '重新发布含新成功页面')
    assert.ok(indexV2.includes('data-item-id="a"'), '重新发布保留旧成功页面')
    // stale 被重建覆盖回真实原型。
    assert.match(fs.readFileSync(path.join(root, 'other', 'a', 'prototype.html'), 'utf8'), /<!doctype html>/i)
    // attempt 记录不变。
    const ck2 = loadCheckpoint(path.join(root, 'other', 'runtime'))
    assert.equal(ck2.items[0].attempt, 1)
    assert.ok(fs.existsSync(path.join(root, 'other', 'runtime', 'items', 'a', 'attempts', '0001', 'prototype.html')))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('首页—落地页联动：发布层内离线链接可点击（landingPreviewRef 重写）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-linkage-'))
  try {
    const result = await runBatch({
      mode: 'run',
      batchRequest: request(
        [landingItem('item.land'), homeItem('item.home')],
        {
          batchId: 'batch-pub-link',
          pageLinkage: { homeTheme: '夏日出游租赁', landingThemes: [{ theme: '夏日出游租赁' }] },
        },
      ),
      batchRoot: root,
      sourceCommit,
      providerIdentity,
      runItem: async ({ item, attemptRoot, linkage }) => {
        if (item.brief.deliverableType === 'alipay.landing') {
          assemblePage({ pageType: 'landing', outputRoot: attemptRoot })
          fs.writeFileSync(path.join(attemptRoot, 'landing-config.json'), JSON.stringify({ page: { name: 'mock-landing' } }))
          return okOrchestration()
        }
        // 首页 attempt：含可点击落地页预览链接 + 联动层发布的完整预览目录，
        // config 的 carousel/waistBanners 带 attempt 内相对路径的 landingPreviewRef。
        const previewDir = path.join(attemptRoot, linkage.landingThemes[0].landingKey)
        fs.mkdirSync(previewDir, { recursive: true })
        fs.writeFileSync(path.join(previewDir, 'prototype.html'), '<!doctype html><html lang="zh"><body>landing preview</body></html>')
        const ref = linkage.landingThemes[0].landingPreviewRef
        fs.writeFileSync(path.join(attemptRoot, 'home-config.json'), JSON.stringify({
          page: { name: `page-${item.itemId}` },
          carousel: [{ image: 'c.png', contentTheme: 't', landingKey: linkage.landingThemes[0].landingKey, landingPreviewRef: ref }],
          waistBanners: [{ image: 'w.png', contentTheme: 't', landingKey: linkage.landingThemes[0].landingKey, landingPreviewRef: ref }],
        }))
        makePublishableAttempt(attemptRoot, item.itemId, {
          configType: 'home',
          html: `<!doctype html><html lang="zh"><head><link rel="stylesheet" href="styles/tokens.css"></head><body><a href="${ref}">关联落地页</a><img src="assets/final-hero.png"></body></html>`,
        })
        return okOrchestration()
      },
    })
    assert.equal(result.status, 'succeeded')
    // 首页原型内 landingPreviewRef 已改写为发布层相对路径。
    const homeHtml = fs.readFileSync(path.join(root, 'other', 'item.home', 'prototype.html'), 'utf8')
    assert.ok(
      homeHtml.includes('href="../item.land/prototype.html"'),
      `landingPreviewRef 改写为发布层路径：${homeHtml.match(/href="[^"]*prototype.html"/g)?.join(', ')}`,
    )
    // 改写后的链接在发布层真实存在（离线可点击）。
    assert.ok(fs.existsSync(path.join(root, 'other', 'item.land', 'prototype.html')))
    // 素材链接同时改写。
    assert.ok(homeHtml.includes('src="../../assets/item.home/final-hero.png"'))
    // 落地页受控快照素材按其原型引用发布到 assets/item.land/。
    assert.ok(fs.existsSync(path.join(root, 'assets', 'item.land', 'landing', 'hero.png')), '落地页素材发布')
    // 配置副本的 landingPreviewRef 重写为从 configs/ 目录解析的有效相对路径。
    const homeConfig = JSON.parse(fs.readFileSync(path.join(root, 'configs', 'item.home.config.json'), 'utf8'))
    for (const module of ['carousel', 'waistBanners']) {
      assert.equal(homeConfig[module][0].landingPreviewRef, '../other/item.land/prototype.html', `${module} 配置 ref 指向发布层原型`)
      // 从 configs/ 目录解析配置 ref，目标文件必须真实存在（无死链）。
      assert.ok(fs.existsSync(path.join(root, 'configs', homeConfig[module][0].landingPreviewRef)), `${module} 配置 ref 从 configs/ 可解析`)
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('联动确定性映射：前一 landing 可审阅失败、后一 landing 成功 → 各自正确关联，绝不错链', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-reviewable-'))
  try {
    const result = await runBatch({
      mode: 'run',
      batchRequest: request(
        [landingItem('item.land.a'), landingItem('item.land.b'), homeItem('item.home')],
        {
          batchId: 'batch-pub-reviewable',
          pageLinkage: { homeTheme: '夏日出游租赁', landingThemes: [{ theme: '夏日出游租赁' }, { theme: '演唱会租赁' }] },
        },
      ),
      batchRoot: root,
      sourceCommit,
      providerIdentity,
      runItem: async ({ item, attemptRoot, linkage }) => {
        if (item.brief.deliverableType === 'alipay.landing') {
          if (item.itemId === 'item.land.a') {
            // 前一 landing：required 素材失败但页面已完成（可审阅）——完整证据链。
            assemblePage({ pageType: 'landing', outputRoot: attemptRoot })
            validateOutput({ outputRoot: attemptRoot, pageType: 'landing' })
            fs.writeFileSync(path.join(attemptRoot, 'landing-config.json'), JSON.stringify({ page: { name: 'landing-a' } }))
            fs.writeFileSync(path.join(attemptRoot, 'asset-manifest.json'), JSON.stringify({ pendingAssetRequests: [{ id: 'landing.default.hero.image', usageSlot: 'landing.default.hero.image', status: 'pending' }] }, null, 2) + '\n')
            return { briefId: item.brief.id, status: 'failed', selectedCapabilities: ['workflow.orchestrate'], steps: [{ name: 'image-generate', status: 'failed', details: 'required 素材生成失败' }], deliverable: { packageRoot: attemptRoot, designBriefId: item.brief.id, files: [{ path: 'prototype.html', kind: 'prototype.html', sha256: 'a'.repeat(64) }], sourceCommit: 'x' } }
          }
          assemblePage({ pageType: 'landing', outputRoot: attemptRoot })
          fs.writeFileSync(path.join(attemptRoot, 'landing-config.json'), JSON.stringify({ page: { name: 'landing-b' } }))
          return okOrchestration()
        }
        // 首页：按页面侧联动判定（linkage.landingThemes 带 ref 的才可关联）写预览
        // 目录、<a> 与 config ref——与 batch-runner 证据链同源，不人工猜测。
        for (const theme of linkage.landingThemes) {
          const previewDir = path.join(attemptRoot, theme.landingKey)
          fs.mkdirSync(previewDir, { recursive: true })
          fs.writeFileSync(path.join(previewDir, 'prototype.html'), `<!doctype html><html lang="zh"><body>${theme.landingKey} preview</body></html>`)
        }
        const anchors = linkage.landingThemes
          .filter((t) => t.landingPreviewRef)
          .map((t) => `<a href="${t.landingPreviewRef}">${t.landingKey}</a>`)
          .join('')
        fs.writeFileSync(path.join(attemptRoot, 'home-config.json'), JSON.stringify({
          page: { name: `page-${item.itemId}` },
          carousel: linkage.landingThemes.map((t) => ({ image: `c-${t.landingKey}.png`, contentTheme: t.theme, landingKey: t.landingKey, ...(t.landingPreviewRef ? { landingPreviewRef: t.landingPreviewRef } : {}) })),
          waistBanners: linkage.landingThemes.map((t) => ({ image: `w-${t.landingKey}.png`, contentTheme: t.theme, landingKey: t.landingKey, ...(t.landingPreviewRef ? { landingPreviewRef: t.landingPreviewRef } : {}) })),
        }))
        makePublishableAttempt(attemptRoot, item.itemId, {
          configType: 'home',
          html: `<!doctype html><html lang="zh"><head><link rel="stylesheet" href="styles/tokens.css"></head><body>${anchors}<img src="assets/final-hero.png"></body></html>`,
        })
        return okOrchestration()
      },
    })
    assert.equal(result.status, 'partially_failed')
    // plan 确定性映射：landing-01→item.land.a（可审阅失败）、landing-02→item.land.b（成功）。
    // 交付区只发布 succeeded item：可审阅失败 landing 不发布（运行时证据在 other/runtime）。
    assert.ok(fs.existsSync(path.join(root, 'other', 'runtime', 'items', 'item.land.a', 'attempts', '0001', 'prototype.html')), '可审阅失败 landing 原型保留在运行时')
    assert.equal(fs.existsSync(path.join(root, 'other', 'item.land.a')), false, '可审阅失败 landing 不发布到交付区')
    assert.ok(fs.existsSync(path.join(root, 'other', 'item.land.b', 'prototype.html')), '成功 landing 原型已发布')
    const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
    assert.ok(index.includes('data-item-id="item.land.b"'), '入口列出成功 landing')
    assert.ok(index.includes('data-item-id="item.home"'), '入口列出首页')
    assert.doesNotMatch(index, /item\.land\.a/, '可审阅失败 landing 不进入入口')
    // 首页原型 ref：可审阅失败 landing-01 的 href 被剥离（纯视觉，无死链、不链接失败页），
    // 成功 landing-02 正确映射。
    const homeHtml = fs.readFileSync(path.join(root, 'other', 'item.home', 'prototype.html'), 'utf8')
    assert.doesNotMatch(homeHtml, /href="[^"]*landing-01/, '可审阅失败 landing 的 href 已剥离（纯视觉）')
    assert.ok(homeHtml.includes('href="../item.land.b/prototype.html"'), 'landing-02（成功）映射到 item.land.b')
    assert.doesNotMatch(homeHtml, /href="landing-\d{2}\/prototype\.html"/, '无 attempt 内 landingKey 路径残留')
    // 首页交付目录不得包含失败落地页预览目录（landing-01 只存在于 attempt 运行时）。
    assert.equal(fs.existsSync(path.join(root, 'other', 'item.home', 'landing-01')), false, '可审阅失败 landing 预览目录不进入交付区')
    // 配置副本 ref：失败主题条目删 ref（纯视觉），成功主题条目正确关联。
    const homeConfig = JSON.parse(fs.readFileSync(path.join(root, 'configs', 'item.home.config.json'), 'utf8'))
    const configByLandingKey = new Map()
    for (const module of ['carousel', 'waistBanners']) {
      for (const entry of homeConfig[module]) {
        configByLandingKey.set(entry.landingKey, entry.landingPreviewRef)
        if (entry.landingPreviewRef) {
          assert.ok(fs.existsSync(path.join(root, 'configs', entry.landingPreviewRef)), `${module} ${entry.landingKey} 配置 ref 从 configs/ 解析存在`)
        }
      }
    }
    assert.equal(configByLandingKey.get('landing-01'), undefined, 'landing-01（可审阅失败）配置 ref 已删除（纯视觉）')
    assert.equal(configByLandingKey.get('landing-02'), '../other/item.land.b/prototype.html', 'landing-02（成功）配置 ref 指向 item.land.b')
    // 每个发布原型的本地引用全部存在（首页含跨页面 ../item.land.* 链接）。
    for (const itemId of ['item.home', 'item.land.b']) {
      const html = fs.readFileSync(path.join(root, 'other', itemId, 'prototype.html'), 'utf8')
      for (const match of html.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
        const ref = match[1]
        if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref)) continue
        assert.ok(fs.existsSync(path.resolve(root, 'other', itemId, ref)), `${itemId} 发布原型引用存在：${ref}`)
      }
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('联动不可链接：首页 config/原型 ref 指向无预览 landing 时按纯视觉处理（绝不误连）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-unlinkable-'))
  try {
    const result = await runBatch({
      mode: 'run',
      batchRequest: request(
        [landingItem('item.land.dead'), landingItem('item.land.ok'), homeItem('item.home')],
        {
          batchId: 'batch-pub-unlink',
          pageLinkage: { homeTheme: '夏日出游租赁', landingThemes: [{ theme: '夏日出游租赁' }, { theme: '演唱会租赁' }] },
        },
      ),
      batchRoot: root,
      sourceCommit,
      providerIdentity,
      runItem: async ({ item, attemptRoot, linkage }) => {
        if (item.brief.deliverableType === 'alipay.landing') {
          if (item.itemId === 'item.land.dead') throw new Error('landing boom（完全失败，无可审阅原型）')
          assemblePage({ pageType: 'landing', outputRoot: attemptRoot })
          fs.writeFileSync(path.join(attemptRoot, 'landing-config.json'), JSON.stringify({ page: { name: 'landing-ok' } }))
          return okOrchestration()
        }
        // 页面侧联动判定：landing-01（完全失败）无 landingPreviewRef → 不建 <a>；
        // config 中失败主题条目无 ref（页面 Skill 同源语义：失败主题保留纯视觉）。
        for (const theme of linkage.landingThemes) {
          if (!theme.landingPreviewRef) continue
          const previewDir = path.join(attemptRoot, theme.landingKey)
          fs.mkdirSync(previewDir, { recursive: true })
          fs.writeFileSync(path.join(previewDir, 'prototype.html'), `<!doctype html><html lang="zh"><body>${theme.landingKey} preview</body></html>`)
        }
        const anchors = linkage.landingThemes
          .filter((t) => t.landingPreviewRef)
          .map((t) => `<a href="${t.landingPreviewRef}">${t.landingKey}</a>`)
          .join('')
        fs.writeFileSync(path.join(attemptRoot, 'home-config.json'), JSON.stringify({
          page: { name: `page-${item.itemId}` },
          carousel: linkage.landingThemes.map((t) => ({ image: `c-${t.landingKey}.png`, contentTheme: t.theme, landingKey: t.landingKey, ...(t.landingPreviewRef ? { landingPreviewRef: t.landingPreviewRef } : {}) })),
          waistBanners: linkage.landingThemes.map((t) => ({ image: `w-${t.landingKey}.png`, contentTheme: t.theme, landingKey: t.landingKey, ...(t.landingPreviewRef ? { landingPreviewRef: t.landingPreviewRef } : {}) })),
        }))
        makePublishableAttempt(attemptRoot, item.itemId, {
          configType: 'home',
          html: `<!doctype html><html lang="zh"><head><link rel="stylesheet" href="styles/tokens.css"></head><body>${anchors}<img src="assets/final-hero.png"></body></html>`,
        })
        return okOrchestration()
      },
    })
    assert.equal(result.status, 'partially_failed')
    // 配置副本：失败主题条目无 landingPreviewRef（纯视觉），成功主题条目指向发布层。
    const homeConfig = JSON.parse(fs.readFileSync(path.join(root, 'configs', 'item.home.config.json'), 'utf8'))
    assert.equal(homeConfig.carousel[0].landingPreviewRef, undefined, '完全失败 landing 条目无 ref（纯视觉）')
    assert.equal(homeConfig.carousel[0].landingKey, 'landing-01', '失败主题条目保留视觉内容')
    assert.equal(homeConfig.carousel[1].landingPreviewRef, '../other/item.land.ok/prototype.html', '成功 landing 条目指向正确 item')
    assert.ok(fs.existsSync(path.join(root, 'configs', homeConfig.carousel[1].landingPreviewRef)), '成功条目配置 ref 从 configs/ 解析存在')
    // 首页原型只有成功 landing 的链接。
    const homeHtml = fs.readFileSync(path.join(root, 'other', 'item.home', 'prototype.html'), 'utf8')
    assert.ok(homeHtml.includes('href="../item.land.ok/prototype.html"'))
    assert.doesNotMatch(homeHtml, /href="[^"]*item\.land\.dead/, '完全失败 landing 绝不误连')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('真实受控组装产物：发布后原型本地 src/href 全部存在（无死链）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-real-'))
  try {
    const result = await runBatch({
      mode: 'run',
      batchRequest: request([homeItem('real-page')]),
      batchRoot: root,
      sourceCommit,
      providerIdentity,
      runItem: async ({ item, attemptRoot }) => {
        // 受控组装器真实落盘：prototype.html + styles/ + assets/ + component-usage。
        assemblePage({ pageType: 'home', outputRoot: attemptRoot })
        validateOutput({ outputRoot: attemptRoot, pageType: 'home' })
        fs.writeFileSync(path.join(attemptRoot, 'home-config.json'), JSON.stringify({ page: { name: 'real' } }))
        return okOrchestration()
      },
    })
    assert.equal(result.status, 'succeeded')
    const publishedHtml = fs.readFileSync(path.join(root, 'other', 'real-page', 'prototype.html'), 'utf8')
    for (const match of publishedHtml.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
      const ref = match[1]
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref)) continue
      assert.ok(fs.existsSync(path.resolve(root, 'other', 'real-page', ref)), `发布原型本地引用必须存在：${ref}`)
    }
    // 快照样式齐备。
    for (const style of ['tokens.css', 'base.css', 'home.css']) {
      assert.ok(fs.existsSync(path.join(root, 'other', 'real-page', 'styles', style)))
    }
    // 受控快照素材齐备。
    assert.ok(fs.existsSync(path.join(root, 'assets', 'real-page', 'home', 'search.png')), '快照素材发布到 assets/<itemId>/')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('publishBatchDelivery 独立调用：终态 checkpoint 缺失/非法按 BATCH_PUBLISH_INVALID 拒绝', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-direct-'))
  try {
    assert.throws(
      () => publishBatchDelivery({ batchRoot: root, request: request([homeItem('x')]), checkpoint: null }),
      (e) => e instanceof BatchRunnerError && e.code === 'BATCH_PUBLISH_INVALID',
    )
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('入口模板：多页批次每页四卡片，截图链接与文件一一对应（部分失败页不出现）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-template-'))
  try {
    const result = await runBatch({
      mode: 'run',
      batchRequest: request([homeItem('shot-page'), homeItem('bare-page'), homeItem('fail-page')]),
      batchRoot: root,
      sourceCommit,
      providerIdentity,
      runItem: async ({ item, attemptRoot }) => {
        if (item.itemId === 'fail-page') throw new Error('boom')
        makePublishableAttempt(attemptRoot, item.itemId)
        // shot-page 额外产出截图（进入模板 preview 与 screenshot 卡片）。
        if (item.itemId === 'shot-page') {
          fs.writeFileSync(path.join(attemptRoot, 'prototype.png'), 'png-bytes')
        }
        return okOrchestration()
      },
    })
    assert.equal(result.status, 'partially_failed')
    const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
    // 设计模板特征：蓝金 CSS 变量、页面分节、卡片 grid、无远程资源。
    assert.match(index, /--blue-deep:#071225/)
    assert.match(index, /--gold:#d6ad67/)
    assert.match(index, /radial-gradient\(/, '模板深蓝渐变背景')
    assert.equal((index.match(/class="page-entry"/g) || []).length, 2, '两个成功页各一节')
    assert.ok(index.includes('data-item-id="shot-page"'))
    assert.ok(index.includes('data-item-id="bare-page"'))
    assert.doesNotMatch(index, /fail-page/, '失败页不进入入口')
    // 截图卡片：有截图页指向 prototype.png 且文件存在；无截图页指向锚点。
    const shotCard = /data-item-id="shot-page"[\s\S]*?data-kind="screenshot"[^>]*href="([^"]+)"/.exec(index)
    assert.ok(shotCard, 'shot-page 含 screenshot 卡片')
    assert.equal(shotCard[1], 'other/shot-page/prototype.png')
    assert.ok(fs.existsSync(path.join(root, 'other', 'shot-page', 'prototype.png')), '截图链接指向的文件真实存在')
    const bareCard = /data-item-id="bare-page"[\s\S]*?data-kind="screenshot"[^>]*href="([^"]+)"/.exec(index)
    assert.ok(bareCard, 'bare-page 含 screenshot 卡片')
    assert.match(bareCard[1], /^#/, '无截图页 screenshot 卡片指向锚点（无死链）')
    // 每个成功页的原型/配置/素材/截图链接都指向发布层真实存在的文件。
    for (const itemId of ['shot-page', 'bare-page']) {
      for (const ref of [
        `other/${itemId}/prototype.html`,
        `configs/${itemId}.config.json`,
      ]) {
        assert.ok(fs.existsSync(path.join(root, ...ref.split('/'))), `${itemId} 的 ${ref} 存在`)
        assert.ok(index.includes(ref), `入口含 ${itemId} 的 ${ref} 链接`)
      }
      const assetsRef = `assets/${itemId}/`
      assert.ok(fs.existsSync(path.join(root, ...assetsRef.split('/'))) && fs.statSync(path.join(root, ...assetsRef.split('/'))).isDirectory(), `${itemId} 素材目录存在`)
      assert.ok(index.includes(assetsRef), `入口含 ${itemId} 的素材链接`)
    }
    // 入口自身引用的相对链接（卡片 href）都可在发布层解析（无死链）。
    for (const match of index.matchAll(/href="([^"]+)"/g)) {
      const ref = match[1]
      if (ref.startsWith('#')) continue
      assert.ok(fs.existsSync(path.resolve(root, ref)), `入口链接必须存在：${ref}`)
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

// ---- 回归：公开根目录合同、旧结构迁移、零成功批次四层骨架 ----

test('顶层合同：run/resume/retry-failed 终态后 batchRoot 顶层只有 index.html/assets/configs/other，运行时状态全部位于 other/runtime', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-toplevel-'))
  try {
    // run：两 item，其一失败后 retry-failed 修复，覆盖三种模式的终态发布。
    const result = await runBatch({
      mode: 'run',
      batchRequest: request([homeItem('a'), homeItem('b')]),
      batchRoot: root,
      sourceCommit,
      providerIdentity,
      runItem: async ({ item, attemptRoot }) => {
        if (item.itemId === 'b') throw new Error('boom')
        makePublishableAttempt(attemptRoot, item.itemId)
        return okOrchestration()
      },
    })
    assert.equal(result.status, 'partially_failed')
    for (const dir of ['assets', 'configs', 'other', 'index.html']) {
      assert.ok(fs.existsSync(path.join(root, dir)), `run 终态顶层存在 ${dir}`)
    }
    assert.ok(fs.existsSync(path.join(root, 'other', 'runtime', 'request.json')), 'request.json 在 other/runtime')
    assert.ok(fs.existsSync(path.join(root, 'other', 'runtime', 'checkpoint.json')), 'checkpoint.json 在 other/runtime')
    assert.ok(fs.existsSync(path.join(root, 'other', 'runtime', 'result.json')), 'result.json 在 other/runtime')
    assert.ok(fs.existsSync(path.join(root, 'other', 'runtime', 'items', 'a', 'attempts', '0001', 'prototype.html')), 'attempts 在 other/runtime/items')

    // retry-failed：修复 b 后顶层合同仍成立。
    await runBatch({
      mode: 'retry-failed',
      batchRoot: root,
      sourceCommit,
      providerIdentity,
      runItem: async ({ item, attemptRoot }) => {
        makePublishableAttempt(attemptRoot, item.itemId)
        return okOrchestration()
      },
    })
    assert.deepEqual(
      fs.readdirSync(root).sort(),
      ['assets', 'configs', 'index.html', 'other'],
      'retry-failed 后顶层仍只有四项',
    )
    assert.ok(fs.existsSync(path.join(root, 'other', 'runtime', 'items', 'b', 'attempts', '0002')), 'retry attempt 也在运行时根')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('旧结构迁移：顶层 checkpoint/request/items 的旧批次 resume 后归位到 other/runtime 且顶层合同恢复', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-legacy-'))
  try {
    // 先按新结构跑一个批次：b 抛错中断后手动置回 running（模拟进程中断，
    // resume 语义才会把 b 归一化为 interrupted 并重跑修复）。
    await runBatch({
      mode: 'run',
      batchRequest: request([homeItem('a'), homeItem('b')]),
      batchRoot: root,
      sourceCommit,
      providerIdentity,
      runItem: async ({ item, attemptRoot }) => {
        if (item.itemId === 'b') throw new Error('interrupted')
        makePublishableAttempt(attemptRoot, item.itemId)
        return okOrchestration()
      },
    })
    const runtime = path.join(root, 'other', 'runtime')
    const ck = loadCheckpoint(runtime)
    ck.items = ck.items.map((i) => (i.itemId === 'b' ? { ...i, status: 'running' } : i))
    fs.writeFileSync(path.join(runtime, 'checkpoint.json'), JSON.stringify(ck, null, 2))
    // 构造旧结构：把运行时状态搬回顶层。
    for (const name of ['request.json', 'checkpoint.json', 'checkpoint.previous.json', 'result.json', 'items']) {
      const source = path.join(runtime, name)
      if (fs.existsSync(source)) fs.renameSync(source, path.join(root, name))
    }
    fs.rmSync(runtime, { recursive: true, force: true })
    assert.ok(fs.existsSync(path.join(root, 'checkpoint.json')), '旧结构：checkpoint 在顶层')

    const result = await runBatch({
      mode: 'resume',
      batchRoot: root,
      sourceCommit,
      providerIdentity,
      runItem: async ({ item, attemptRoot }) => {
        makePublishableAttempt(attemptRoot, item.itemId)
        return okOrchestration()
      },
    })
    // 首跑 b 中断（fixture 置回 running → resume 归一化为 interrupted 并重跑成功），
    // a 首跑已 succeeded → 批次 succeeded。
    assert.equal(result.status, 'succeeded')
    // 迁移归位：旧顶层文件不再存在，运行时状态在 other/runtime。
    assert.deepEqual(
      fs.readdirSync(root).sort(),
      ['assets', 'configs', 'index.html', 'other'],
      'resume 迁移后顶层只有四项',
    )
    assert.ok(fs.existsSync(path.join(runtime, 'checkpoint.json')), 'checkpoint 迁移到 other/runtime')
    assert.ok(fs.existsSync(path.join(runtime, 'request.json')), 'request 迁移到 other/runtime')
    assert.ok(fs.existsSync(path.join(runtime, 'items', 'a', 'attempts', '0001')), '旧 attempt 一并迁移')
    assert.ok(fs.existsSync(path.join(root, 'index.html')), 'resume 终态重新发布入口')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('旧批次迁移：checkpoint 绝对 attemptRoot 指向旧顶层 items/ 时 resume 重写为运行时根并成功发布', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-legacy-abs-'))
  try {
    // 先按新结构跑一个批次：a 成功、b 中断，checkpoint 内 attemptRoot 均为新结构绝对路径。
    await runBatch({
      mode: 'run',
      batchRequest: request([homeItem('a'), homeItem('b')]),
      batchRoot: root,
      sourceCommit,
      providerIdentity,
      runItem: async ({ item, attemptRoot }) => {
        if (item.itemId === 'b') throw new Error('interrupted')
        makePublishableAttempt(attemptRoot, item.itemId)
        return okOrchestration()
      },
    })
    const runtime = path.join(root, 'other', 'runtime')
    const ck = loadCheckpoint(runtime)
    ck.items = ck.items.map((i) => (i.itemId === 'b' ? { ...i, status: 'running' } : i))
    fs.writeFileSync(path.join(runtime, 'checkpoint.json'), JSON.stringify(ck, null, 2))
    // 构造旧批次 fixture：把运行时状态搬回顶层（items/ 物理位于旧位置），并把
    // checkpoint 内全部 attemptRoot/resultPath 改写为旧批次绝对路径
    //（旧 run 直接落盘 createAttemptRoot 返回值：<batchRoot>/items/...）。
    for (const name of ['request.json', 'checkpoint.json', 'checkpoint.previous.json', 'result.json', 'items']) {
      const source = path.join(runtime, name)
      if (fs.existsSync(source)) fs.renameSync(source, path.join(root, name))
    }
    fs.rmSync(runtime, { recursive: true, force: true })
    const legacyCk = JSON.parse(fs.readFileSync(path.join(root, 'checkpoint.json'), 'utf8'))
    legacyCk.items = legacyCk.items.map((i) => ({
      ...i,
      attemptRoot: path.join(root, 'items', i.itemId, 'attempts', String(i.attempt).padStart(4, '0')),
      resultPath: path.join(root, 'items', i.itemId, 'attempts', String(i.attempt).padStart(4, '0'), 'result.json'),
    }))
    fs.writeFileSync(path.join(root, 'checkpoint.json'), JSON.stringify(legacyCk, null, 2))
    assert.ok(
      legacyCk.items.every((i) => path.isAbsolute(i.attemptRoot) && fs.existsSync(i.attemptRoot)),
      'fixture：旧绝对 attemptRoot 且 attempt 目录在旧顶层真实存在',
    )

    const result = await runBatch({
      mode: 'resume',
      batchRoot: root,
      sourceCommit,
      providerIdentity,
      runItem: async ({ item, attemptRoot }) => {
        // resume 重跑 b（interrupted）；新 attempt 目录由 createAttemptRoot 分配在运行时根。
        makePublishableAttempt(attemptRoot, item.itemId)
        return okOrchestration()
      },
    })
    // a（succeeded，attemptRoot 为旧顶层绝对路径）不重跑但发布可定位；b 重跑成功。
    assert.equal(result.status, 'succeeded')
    const finalCk = JSON.parse(fs.readFileSync(path.join(runtime, 'checkpoint.json'), 'utf8'))
    for (const item of finalCk.items) {
      assert.ok(
        fs.existsSync(path.join(runtime, ...path.relative(runtime, path.resolve(item.attemptRoot)).split(/[\\/]+/))),
        `item ${item.itemId} 的 attemptRoot 已归位到运行时根且真实存在`,
      )
      assert.ok(!path.resolve(item.attemptRoot).startsWith(path.join(root, 'items') + path.sep), 'attemptRoot 不再指向旧顶层 items/')
    }
    // 顶层合同恢复：只有四层，发布成功。
    assert.deepEqual(
      fs.readdirSync(root).sort(),
      ['assets', 'configs', 'index.html', 'other'],
      'resume 后顶层只有四项（发布成功）',
    )
    assert.ok(fs.existsSync(path.join(root, 'assets', 'a', 'final-hero.png')), '旧 succeeded item 的素材发布成功')
    assert.ok(fs.existsSync(path.join(root, 'configs', 'a.config.json')), '旧 succeeded item 的配置发布成功')
    assert.ok(fs.existsSync(path.join(root, 'configs', 'b.config.json')), '重跑成功 item 的配置发布成功')
    const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
    assert.ok(index.includes('data-item-id="a"') && index.includes('data-item-id="b"'), '入口列出全部成功页')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('零成功批次：仍发布四层骨架（assets/configs/other + 空态入口），无任何页面目录', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-zerook-'))
  try {
    const result = await runBatch({
      mode: 'run',
      batchRequest: request([homeItem('all-bad')]),
      batchRoot: root,
      sourceCommit,
      providerIdentity,
      runItem: async () => { throw new Error('boom') },
    })
    assert.equal(result.status, 'failed')
    assert.deepEqual(
      fs.readdirSync(root).sort(),
      ['assets', 'configs', 'index.html', 'other'],
      '零成功批次顶层仍为四项',
    )
    assert.ok(fs.statSync(path.join(root, 'assets')).isDirectory())
    assert.ok(fs.statSync(path.join(root, 'configs')).isDirectory())
    const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
    assert.match(index, /本批次没有成功页面/, '空态入口')
    assert.doesNotMatch(index, /data-item-id=/, '无任何页面条目')
    // 入口自身无死链（空态无卡片链接）。
    assert.equal(/href="(?!#)/.test(index.replace(/href="#[^"]*"/g, '')), false, '空态入口无文件链接')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('无素材成功页：assets/<itemId>/ 目录仍创建，入口素材链接可访问（不缺目录）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-noasset-'))
  try {
    await runBatch({
      mode: 'run',
      batchRequest: request([homeItem('plain-page')]),
      batchRoot: root,
      sourceCommit,
      providerIdentity,
      runItem: async ({ item, attemptRoot }) => {
        // 原型只引用 styles（无 assets/ 引用）。
        fs.mkdirSync(attemptRoot, { recursive: true })
        fs.writeFileSync(path.join(attemptRoot, 'prototype.html'), '<!doctype html><html lang="zh"><head><link rel="stylesheet" href="styles/tokens.css"></head><body>plain</body></html>')
        fs.mkdirSync(path.join(attemptRoot, 'styles'), { recursive: true })
        fs.writeFileSync(path.join(attemptRoot, 'styles', 'tokens.css'), ':root{}\n')
        fs.writeFileSync(path.join(attemptRoot, 'home-config.json'), JSON.stringify({ page: { name: 'plain' } }))
        return okOrchestration()
      },
    })
    assert.ok(fs.statSync(path.join(root, 'assets', 'plain-page')).isDirectory(), '无素材成功页也创建 assets/<itemId>/ 目录')
    const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
    const assetsCard = /data-kind="assets"[^>]*href="([^"]+)"/.exec(index)
    assert.ok(assetsCard, '入口含素材卡片')
    assert.equal(assetsCard[1], 'assets/plain-page/')
    assert.ok(fs.statSync(path.join(root, 'assets', 'plain-page')).isDirectory(), '入口素材链接指向存在的目录（不缺目录、不死链）')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

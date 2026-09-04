import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { COMPONENT_LIB } from '../scripts/build-catalog.mjs'
import {
  applyHomeNav,
  homeNavGridCss,
  pageThemeCss,
  planHomeNav,
  planLandingBlocks,
  validateHomeNav,
  validateLandingBlocks,
} from '../scripts/catalog/composition.mjs'
import { assemblePage } from '../scripts/assemble.mjs'
import { validateOutput } from '../scripts/validate.mjs'
import { buildDesignPackage } from '../scripts/package.mjs'

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'alipay-pages-config-'))
}

// ---------------------------------------------------------------------------
// home-nav 受控槽位（5–25、五列多行）
// ---------------------------------------------------------------------------

test('homeNav 计划：5 项默认单行，10/25 项多行且新项只用连续编号', () => {
  const five = planHomeNav({ count: 5 })
  assert.equal(five.count, 5)
  assert.equal(five.rows, 1)
  assert.deepEqual(five.entries.map(e => e.label), ['运动相机', '相机摄影', '演唱会神器', 'CCD专区', '超级补贴'])

  const ten = planHomeNav({ count: 10 })
  assert.equal(ten.rows, 2)
  assert.deepEqual(ten.entries.slice(5).map(e => e.label), ['06', '07', '08', '09', '10'])

  const twentyFive = planHomeNav({ count: 25 })
  assert.equal(twentyFive.rows, 5)
  assert.equal(twentyFive.entries.at(-1).label, '25')
})

test('homeNav 计划拒绝：非 5 倍数、越界 4/30、非法 icons', () => {
  const sampleSlot = '../assets/home/nav-concert.png'
  assert.throws(() => planHomeNav({ count: 7 }), /5 的倍数/)
  assert.throws(() => planHomeNav({ count: 4 }), /5–25/)
  assert.throws(() => planHomeNav({ count: 30 }), /5–25/)
  assert.throws(() => planHomeNav({ icons: [{ slot: 'not-a-slot' }] }), /icons.slot/)
  assert.throws(() => planHomeNav({
    icons: [{ slot: sampleSlot, sourcePath: 'x' }, { slot: sampleSlot, sourcePath: 'y' }],
  }), /icons.slot 重复/)
})

test('homeNav 组装：10 项五列两行、样例名称锁定、编号回填与图标受控替换', () => {
  const sourceHtml = fs.readFileSync(path.join(COMPONENT_LIB, 'pages', 'home.html'), 'utf8')
  const { html, imageMarkers, rows } = applyHomeNav(sourceHtml, { count: 10, icons: [] })
  assert.equal(rows, 2)
  assert.deepEqual(imageMarkers, [])
  assert.match(html, /<div class="home-nav__label">06<\/div>/)
  assert.equal([...html.matchAll(/class="home-nav__item"/g)].length, 10)
  // 前五项保留样例名称与顺序（首尾各验一项）。
  assert.match(html, /<div class="home-nav__label">运动相机<\/div>/)
  assert.match(html, /<div class="home-nav__label">超级补贴<\/div>/)
})

test('homeNav 组装：样例图标受控回填', () => {
  const sourceHtml = fs.readFileSync(path.join(COMPONENT_LIB, 'pages', 'home.html'), 'utf8')
  const slot = '../assets/home/nav-concert.png'
  const { imageMarkers, rows } = applyHomeNav(sourceHtml, {
    count: 5,
    icons: [{ slot, sourcePath: 'any/source/icon.png' }],
  })
  assert.equal(rows, 1)
  assert.deepEqual(imageMarkers, [{ currentSrc: slot, sourcePath: 'any/source/icon.png' }])
  assert.throws(() => applyHomeNav(sourceHtml, {
    count: 5,
    icons: [{ slot: '../assets/home/not-exists.png', sourcePath: 'x.png' }],
  }), /icons.slot/)
})

test('homeNav 通过 assemblePage 交付：多行样式补丁写入并通过校验', () => {
  const outputRoot = temporaryDirectory()
  try {
    const sourcePath = path.join(COMPONENT_LIB, 'assets', 'home', 'banner-concert.png')
    assemblePage({
      pageType: 'home',
      outputRoot,
      changes: {
        homeNav: { count: 10, icons: [{ slot: '../assets/home/nav-concert.png', sourcePath }] },
      },
    })
    const html = fs.readFileSync(path.join(outputRoot, 'prototype.html'), 'utf8')
    assert.ok(fs.existsSync(path.join(outputRoot, 'styles', 'home-nav.grid.css')), '多行金刚区应生成受控样式补丁')
    assert.match(html, /styles\/home-nav\.grid\.css/)
    assert.equal([...html.matchAll(/class="home-nav__item"/g)].length, 10)
    assert.deepEqual(validateOutput({ outputRoot, pageType: 'home' }).errors, [])
  } finally { fs.rmSync(outputRoot, { recursive: true, force: true }) }
})

test('单行金刚区（count=5，默认）不生成样式补丁，固定骨架保持原样', () => {
  const outputRoot = temporaryDirectory()
  try {
    assemblePage({ pageType: 'home', outputRoot, changes: { homeNav: { count: 5 } } })
    assert.ok(!fs.existsSync(path.join(outputRoot, 'styles', 'home-nav.grid.css')))
    const html = fs.readFileSync(path.join(outputRoot, 'prototype.html'), 'utf8')
    assert.doesNotMatch(html, /home-nav\.grid\.css/)
    assert.match(html, /home-category-tabs__item is-active/)
    assert.match(html, /home-tabbar__item is-active/)
    assert.deepEqual(validateOutput({ outputRoot, pageType: 'home' }).errors, [])
  } finally { fs.rmSync(outputRoot, { recursive: true, force: true }) }
})

test('homeNav 非法输入：validateHomeNav 与 assemblePage 拒绝一致，homeNav 不接受落地页', () => {
  let outputRoot = temporaryDirectory()
  try {
    assert.throws(() => assemblePage({ pageType: 'home', outputRoot, changes: { homeNav: { count: 6 } } }), /5 的倍数/)

    outputRoot = temporaryDirectory()
    assert.throws(() => assemblePage({ pageType: 'landing', outputRoot, changes: { homeNav: { count: 5 } } }), /homeNav 仅支持首页/)
  } finally { fs.rmSync(outputRoot, { recursive: true, force: true }) }
  assert.deepEqual(validateHomeNav({ count: 6 }), ['金刚区数量必须是 5 的倍数（五列多行）'])
  assert.deepEqual(validateHomeNav({ count: 3 }), ['金刚区数量必须在 5–25 之间'])
  assert.deepEqual(validateHomeNav({}), [])
})

test('homeNavGridCss 是固定受控补丁内容', () => {
  assert.match(homeNavGridCss(), /\.home-nav \{ flex-wrap: wrap/)
})

test('主题样式由结构化配置确定性生成，并在交付校验时防篡改', () => {
  const outputRoot = temporaryDirectory()
  const homeConfig = {
    searchBar: {
      topBarBackgroundColor: '#112233', inputBackgroundColor: '#445566', inputButtonBackgroundColor: '#778899',
      topBarCornerRadiusRpx: 20, inputCornerRadiusRpx: 16,
    },
  }
  try {
    assemblePage({ pageType: 'home', outputRoot, changes: { themeTokens: { pageType: 'home', config: homeConfig } } })
    const theme = fs.readFileSync(path.join(outputRoot, 'styles', 'theme.css'), 'utf8')
    assert.equal(theme, pageThemeCss({ pageType: 'home', config: homeConfig }))
    assert.match(theme, /\.home-top \{ background: #112233; border-radius: 0 0 10px 10px/)
    assert.match(theme, /\.home-search__button \{ background: #778899; border-radius: 8px/)
    assert.equal(validateOutput({ outputRoot, pageType: 'home' }).passed, true)
    fs.appendFileSync(path.join(outputRoot, 'styles', 'theme.css'), '/* changed */\n')
    assert.ok(validateOutput({ outputRoot, pageType: 'home' }).errors.some(error => error.includes('主题样式内容被修改')))
  } finally { fs.rmSync(outputRoot, { recursive: true, force: true }) }
})

test('落地页主题样式映射页面背景、模块圆角间距、标题、优惠券与商品集合', () => {
  const outputRoot = temporaryDirectory()
  const config = {
    page: { background: { type: 'color', color: '#112233' } },
    modules: [
      { type: 'HERO_IMAGE', marginTopRpx: 24, marginBottomRpx: 16, cornerRadiusRpx: 12 },
      { type: 'SECTION_TITLE', mode: { mode: 'text', marginTopRpx: 8, marginBottomRpx: 4, textColor: '#FFFFFF', backgroundColor: '#445566', fontSizeRpx: 32, bold: true, align: 'center' } },
      { type: 'IMAGE_AD', cornerRadiusRpx: 10 },
      { type: 'COUPON_GROUP', overallBackground: { mode: 'color', color: '#778899' }, amountAreaBackground: { mode: 'color', color: '#AABBCC' }, contentAreaBackground: { mode: 'transparent' } },
      { type: 'PRODUCT_COLLECTION', spacingRpx: 16, background: { mode: 'color', color: '#DDEEFF' } },
    ],
  }
  try {
    assemblePage({
      pageType: 'landing', outputRoot,
      changes: {
        themeTokens: { pageType: 'landing', config },
        blocks: [
          { component: 'lp-hero' }, { component: 'lp-section-title' }, { component: 'lp-image-ad' },
          { component: 'lp-coupons' }, { component: 'lp-products' },
        ],
      },
    })
    const theme = fs.readFileSync(path.join(outputRoot, 'styles', 'theme.css'), 'utf8')
    assert.match(theme, /main\.lp-page \{ background: #112233/)
    assert.match(theme, /:nth-child\(1\) \{ margin-top: 12px; margin-bottom: 8px; border-radius: 6px/)
    assert.match(theme, /:nth-child\(2\) \{ margin-top: 4px; margin-bottom: 2px; color: #FFFFFF; background: #445566; font-size: 16px; font-weight: 700; text-align: center/)
    assert.match(theme, /:nth-child\(3\) \.lp-image-ad-item \{ border-radius: 5px/)
    assert.match(theme, /:nth-child\(4\) \{ background: #778899/)
    assert.match(theme, /:nth-child\(4\) \.lp-coupon-value \{ background: #AABBCC/)
    assert.match(theme, /:nth-child\(5\) \{ gap: 8px; background: #DDEEFF/)
    assert.match(theme, /:nth-child\(5\) \.lp-product \{ width: calc\(\(100% - 8px\) \/ 2\); margin-right: 0; margin-bottom: 0/)
    assert.match(theme, /:nth-child\(5\) \.lp-product-title \{ font-size: 14px/)
    assert.equal(validateOutput({ outputRoot, pageType: 'landing' }).passed, true)
  } finally { fs.rmSync(outputRoot, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------
// 落地页 blocks：白名单实例选择、增删、排序
// ---------------------------------------------------------------------------

test('落地页 blocks 计划：空数组、白名单外、超 80 模块被拒绝', () => {
  assert.throws(() => planLandingBlocks({ blocks: [] }), /非空数组/)
  assert.throws(() => planLandingBlocks({ blocks: [{ component: 'custom-hero' }] }), /组件白名单/)
  assert.throws(() => planLandingBlocks({ blocks: Array.from({ length: 81 }, () => ({ component: 'lp-spacer' })) }), /模块总数不能超过 80/)
  assert.throws(() => planLandingBlocks({ blocks: [{ component: 'lp-hero' }, { component: 'lp-spacer', repeat: 80 }] }), /模块总数不能超过 80/)
  assert.doesNotThrow(() => planLandingBlocks({ blocks: [{ component: 'lp-spacer', repeat: 80 }] }))
  assert.deepEqual(validateLandingBlocks([{ component: 'lp-hero' }]), [])
  assert.ok(validateLandingBlocks([{ component: 'video-module' }]).length > 0)
})

test('落地页 blocks 组装：删掉 hero/coupons、标题+商品+按钮三模块按序重建', () => {
  const outputRoot = temporaryDirectory()
  try {
    assemblePage({
      pageType: 'landing',
      outputRoot,
      changes: {
        blocks: [
          { component: 'lp-section-title', texts: [{ className: 'lp-section-title', value: '热门推荐' }] },
          { component: 'lp-products', repeat: 2 },
          { component: 'lp-action', variants: [{ className: 'lp-action', add: ['is-full'] }] },
        ],
      },
    })
    const html = fs.readFileSync(path.join(outputRoot, 'prototype.html'), 'utf8')
    assert.doesNotMatch(html, /lp-hero|lp-coupons/)
    assert.match(html, /<h2 class="lp-section-title">热门推荐<\/h2>/)
    assert.equal([...html.matchAll(/class="lp-product"/g)].length, 8, 'repeat=2 应产生 8 个商品卡片')
    assert.match(html, /lp-action-button/)
    assert.doesNotMatch(html, /\.\.\/(?:assets|styles)/)
    assert.deepEqual(validateOutput({ outputRoot, pageType: 'landing' }).errors, [])
  } finally { fs.rmSync(outputRoot, { recursive: true, force: true }) }
})

test('落地页 blocks 组装：模块内图片槽位受控回填并走统一 images 链路', () => {
  const outputRoot = temporaryDirectory()
  try {
    assemblePage({
      pageType: 'landing',
      outputRoot,
      changes: {
        blocks: [
          { component: 'lp-hero', images: [{ currentSrc: '../assets/landing/hero.png', sourcePath: path.join(COMPONENT_LIB, 'assets', 'landing', 'hero.png'), outputPath: 'assets/generated/hero.png' }] },
          { component: 'lp-section-title' },
        ],
      },
    })
    const html = fs.readFileSync(path.join(outputRoot, 'prototype.html'), 'utf8')
    assert.match(html, /src="assets\/generated\/hero\.png"/)
    assert.ok(fs.existsSync(path.join(outputRoot, 'assets', 'generated', 'hero.png')))
    assert.deepEqual(validateOutput({ outputRoot, pageType: 'landing' }).errors, [])
    const usage = JSON.parse(fs.readFileSync(path.join(outputRoot, 'component-usage.json'), 'utf8'))
    assert.equal(usage.changes.blocks.length, 2)
  } finally { fs.rmSync(outputRoot, { recursive: true, force: true }) }
})

test('落地页双图广告保持一个 is-double 容器和两张图片', () => {
  const outputRoot = temporaryDirectory()
  try {
    assemblePage({
      pageType: 'landing', outputRoot,
      changes: { blocks: [{ component: 'lp-image-ad', double: true }] },
    })
    const html = fs.readFileSync(path.join(outputRoot, 'prototype.html'), 'utf8')
    assert.equal([...html.matchAll(/<(?:section|div) class="[^"]*\blp-image-ad\b[^"]*\bis-double\b[^"]*">/g)].length, 1)
    assert.equal([...html.matchAll(/<img\b/g)].length, 2)
    assert.equal(validateOutput({ outputRoot, pageType: 'landing' }).passed, true)
  } finally { fs.rmSync(outputRoot, { recursive: true, force: true }) }
})

test('落地页 blocks：目标槽位不存在或 variant 未登记时报错拒绝', () => {
  const sourcePath = path.join(COMPONENT_LIB, 'assets', 'landing', 'hero.png')
  assert.throws(() => assemblePage({
    outputRoot: temporaryDirectory(),
    pageType: 'landing',
    changes: { blocks: [{ component: 'lp-hero', images: [{ currentSrc: '../assets/landing/missing.png', sourcePath }] }] },
  }), /图片槽位不存在/)
  assert.throws(() => {
    const outputRoot = temporaryDirectory()
    try {
      assemblePage({
        pageType: 'landing',
        outputRoot,
        changes: { blocks: [{ component: 'lp-action', variants: [{ className: 'lp-action', add: ['is-new'] }] }] },
      })
    } finally { fs.rmSync(outputRoot, { recursive: true, force: true }) }
  }, /未登记 variant/)
})

// ---------------------------------------------------------------------------
// 配置 JSON 与 configuration-guide 产物进入 DesignPackage
// ---------------------------------------------------------------------------

test('home 交付：home-config.json + configuration-guide.md 以受控 kind 进入 DesignPackage', () => {
  const outputRoot = temporaryDirectory()
  try {
    const { catalog } = assemblePage({ pageType: 'home', outputRoot, changes: { homeNav: { count: 5 } } })
    validateOutput({ outputRoot, pageType: 'home' })
    fs.writeFileSync(path.join(outputRoot, 'home-config.json'), JSON.stringify({ schemaVersion: 'alipay-home-config/v1' }, null, 2) + '\n')
    fs.writeFileSync(path.join(outputRoot, 'configuration-guide.md'), '# 配置指南\n')
    const result = buildDesignPackage({
      outputRoot,
      designBriefId: 'brief-home-config',
      sourceCommit: catalog.sourceCommit,
ecoration: undefined,
    })
    const kinds = Object.fromEntries(result.files.map(file => [file.path, file.kind]))
    assert.equal(kinds['home-config.json'], 'home-config.json')
    assert.equal(kinds['configuration-guide.md'], 'configuration-guide.md')
  } finally { fs.rmSync(outputRoot, { recursive: true, force: true }) }
})

test('landing 交付：landing-config.json + configuration-guide.md 以受控 kind 进入 DesignPackage', () => {
  const outputRoot = temporaryDirectory()
  try {
    const { catalog } = assemblePage({
      pageType: 'landing',
      outputRoot,
      changes: {
        blocks: [
          { component: 'lp-hero' },
          { component: 'lp-action' },
        ],
      },
    })
    validateOutput({ outputRoot, pageType: 'landing' })
    fs.writeFileSync(path.join(outputRoot, 'landing-config.json'), JSON.stringify({ schemaVersion: 'alipay-landing-config/v1' }, null, 2) + '\n')
    fs.writeFileSync(path.join(outputRoot, 'configuration-guide.md'), '# 配置指南\n')
    const result = buildDesignPackage({ outputRoot, designBriefId: 'brief-landing', sourceCommit: catalog.sourceCommit })
    const kinds = Object.fromEntries(result.files.map(file => [file.path, file.kind]))
    assert.equal(kinds['landing-config.json'], 'landing-config.json')
    assert.equal(kinds['configuration-guide.md'], 'configuration-guide.md')
  } finally { fs.rmSync(outputRoot, { recursive: true, force: true }) }
})

test('配置产物不完整时 buildDesignPackage 拒绝', () => {
  const outputRoot = temporaryDirectory()
  try {
    const { catalog } = assemblePage({ outputRoot })
    validateOutput({ outputRoot })
    fs.writeFileSync(path.join(outputRoot, 'home-config.json'), '{}\n')
    assert.throws(() => buildDesignPackage({
      outputRoot,
      designBriefId: 'brief-incomplete',
      sourceCommit: catalog.sourceCommit,
    }), /缺少 configuration-guide\.md/)

    // 配置指南存在时必须恰好对应一份页面配置 JSON：两份同时存在则拒绝。
    fs.writeFileSync(path.join(outputRoot, 'configuration-guide.md'), '# 指南\n')
    fs.writeFileSync(path.join(outputRoot, 'landing-config.json'), '{}\n')
    assert.throws(() => buildDesignPackage({
      outputRoot,
      designBriefId: 'brief-complete',
      sourceCommit: catalog.sourceCommit,
    }), /恰好一份/)
  } finally { fs.rmSync(outputRoot, { recursive: true, force: true }) }
})

test('docTitle 只影响 title 标签（转义输出，不开结构口子）', () => {
  const outputRoot = temporaryDirectory()
  try {
    assemblePage({ outputRoot, changes: { docTitle: '<b>夏</b>日主题 & 预览' } })
    const html = fs.readFileSync(path.join(outputRoot, 'prototype.html'), 'utf8')
    assert.match(html, /<title>&lt;b&gt;夏&lt;\/b&gt;日主题 &amp; 预览<\/title>/)
    assert.equal(validateOutput({ outputRoot }).passed, true)
  } finally { fs.rmSync(outputRoot, { recursive: true, force: true }) }
})

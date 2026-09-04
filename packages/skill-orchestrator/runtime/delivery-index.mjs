/**
 * 渲染统一离线交付入口。
 *
 * @param {object} input
 * @param {string} input.title 成功页面标题
 * @param {string} input.type 页面类型
 * @param {string} input.prototypePath prototype.html 的相对路径
 * @param {string} input.configPath 配置文件的相对路径
 * @param {string} input.assetsPath 素材包目录或入口的相对路径
 * @param {string} [input.screenshotPath] 截图的相对路径；缺省时显示 fallback
 * @returns {string} 可直接写入 index.html 的完整离线文档
 */
export function renderDeliveryIndex({
  title,
  type,
  prototypePath,
  configPath,
  assetsPath,
  screenshotPath,
}) {
  const pageTitle = requiredText(title, 'title')
  const pageType = requiredText(type, 'type')
  const prototype = localPath(prototypePath, 'prototypePath')
  const config = localPath(configPath, 'configPath')
  const assets = localPath(assetsPath, 'assetsPath')
  const screenshot = screenshotPath ? localPath(screenshotPath, 'screenshotPath') : ''
  const screenshotMarkup = screenshot
    ? `<img class="preview-image" src="${attribute(screenshot)}" alt="${attribute(pageTitle)} 预览截图" onerror="this.hidden=true;this.nextElementSibling.hidden=false"><div class="preview-fallback" hidden><span>截图暂不可用</span><small>请打开原型查看完整页面</small></div>`
    : '<div class="preview-fallback"><span>暂无截图</span><small>请打开原型查看完整页面</small></div>'

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>${escapeHtml(pageTitle)} · 离线交付</title>
  <style>
    :root { color-scheme: dark; --ink:#f5f7fb; --muted:#9aa8bd; --line:rgba(178,195,220,.16); --blue:#0d1d38; --blue-deep:#071225; --gold:#d6ad67; --gold-soft:#f0d49a; }
    * { box-sizing:border-box; }
    html { min-width:320px; background:var(--blue-deep); }
    body { margin:0; min-height:100vh; color:var(--ink); background:radial-gradient(circle at 82% 10%, rgba(39,91,158,.28), transparent 32rem), linear-gradient(135deg,#071225 0%,#0b1930 56%,#101f3a 100%); font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
    body::before { content:""; position:fixed; inset:0; pointer-events:none; opacity:.22; background-image:linear-gradient(rgba(255,255,255,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.025) 1px,transparent 1px); background-size:48px 48px; mask-image:linear-gradient(to bottom,black,transparent 78%); }
    main { position:relative; width:min(1120px,calc(100% - 48px)); margin:auto; padding:clamp(48px,9vw,112px) 0 72px; }
    .eyebrow { display:flex; align-items:center; gap:12px; color:var(--gold-soft); font:600 11px/1.2 ui-monospace,SFMono-Regular,Consolas,monospace; letter-spacing:.18em; text-transform:uppercase; }
    .eyebrow::before { content:""; width:34px; height:1px; background:var(--gold); }
    h1 { max-width:820px; margin:22px 0 14px; font:500 clamp(38px,7vw,78px)/.98 ui-serif,Georgia,"Times New Roman",serif; letter-spacing:-.045em; }
    .intro { max-width:560px; margin:0; color:var(--muted); font-size:15px; line-height:1.8; }
    .type { display:inline-block; margin-top:25px; padding:8px 12px; border:1px solid rgba(214,173,103,.42); color:var(--gold-soft); font:600 11px/1 ui-monospace,SFMono-Regular,Consolas,monospace; letter-spacing:.08em; }
    .cards { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:14px; margin-top:66px; }
    .card { min-height:184px; display:flex; flex-direction:column; justify-content:space-between; padding:22px; color:inherit; text-decoration:none; border:1px solid var(--line); background:linear-gradient(145deg,rgba(22,46,82,.72),rgba(10,26,51,.62)); box-shadow:0 18px 50px rgba(0,0,0,.16); transition:transform .35s ease,border-color .35s ease,background .35s ease; }
    .card:hover,.card:focus-visible { transform:translateY(-7px); border-color:rgba(214,173,103,.72); background:linear-gradient(145deg,rgba(31,65,111,.8),rgba(12,30,57,.74)); outline:none; }
    .icon { width:34px; height:34px; color:var(--gold-soft); }
    .card-label { margin-top:28px; font-size:16px; font-weight:600; }
    .card-detail { margin-top:7px; color:var(--muted); font-size:12px; line-height:1.5; overflow-wrap:anywhere; }
    .preview { position:relative; display:grid; grid-template-columns:minmax(0,1.5fr) minmax(190px,1fr); gap:24px; align-items:stretch; margin-top:14px; padding:14px; border:1px solid var(--line); background:rgba(4,14,31,.38); }
    .preview-image,.preview-fallback { width:100%; min-height:190px; height:100%; object-fit:cover; border:1px solid rgba(178,195,220,.1); background:#0d1d38; }
    .preview-fallback { display:flex; flex-direction:column; align-items:center; justify-content:center; color:var(--gold-soft); font:500 17px ui-serif,Georgia,serif; }
    .preview-fallback small { margin-top:10px; color:var(--muted); font:12px ui-sans-serif,system-ui,sans-serif; }
    .preview-copy { align-self:center; padding:10px 14px 10px 0; }
    .preview-copy strong { display:block; margin-bottom:8px; font:500 25px/1.15 ui-serif,Georgia,serif; }
    .preview-copy span { color:var(--muted); font-size:13px; line-height:1.7; }
    footer { margin-top:54px; color:rgba(154,168,189,.7); font:11px ui-monospace,SFMono-Regular,Consolas,monospace; letter-spacing:.08em; }
    @media (max-width:860px) { .cards { grid-template-columns:repeat(2,minmax(0,1fr)); } }
    @media (max-width:560px) { main { width:min(100% - 32px,480px); padding-top:42px; } .cards,.preview { grid-template-columns:1fr; } .cards { margin-top:42px; } .preview-copy { padding:10px 4px 14px; } }
    @media (prefers-reduced-motion:reduce) { *,*::before,*::after { scroll-behavior:auto!important; transition-duration:.01ms!important; animation-duration:.01ms!important; animation-iteration-count:1!important; } }
  </style>
</head>
<body>
  <main>
    <div class="eyebrow">Design delivery / offline</div>
    <h1>${escapeHtml(pageTitle)}</h1>
    <p class="intro">页面已成功交付。以下入口均指向本地文件，可在无网络环境中继续查看、审阅与归档。</p>
    <div class="type">${escapeHtml(pageType)}</div>
    <section class="cards" aria-label="交付文件入口">
      ${card('prototype', '查看原型', '打开可交互的页面原型', prototype, 'M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 13.5z M8 21h8 M12 16v5')}
      ${card('config', '查看配置', '阅读页面设计配置与意图', config, 'M7 3h10v18H7z M10 7h4 M10 11h4 M10 15h4')}
      ${card('assets', '打开素材包', '浏览本页面使用的本地素材', assets, 'M4 7.5A2.5 2.5 0 0 1 6.5 5h3l2 2h6A2.5 2.5 0 0 1 20 9.5v7A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5z')}
      ${card('screenshot', '查看截图', screenshot ? '打开页面静态预览' : '当前交付未生成截图', screenshot || '#preview', 'M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v13a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 18.5z M8 16l2.5-3 2 2 2.5-3 2 4 M8 8.5h.01')}
    </section>
    <section class="preview" id="preview" aria-label="页面截图预览">
      <div>${screenshotMarkup}</div>
      <div class="preview-copy"><strong>一份清晰的交付</strong><span>原型、配置、素材与截图各自独立，方便快速定位，也方便离线保存。</span></div>
    </section>
    <footer>LOCAL DELIVERY · NO REMOTE ASSETS</footer>
  </main>
</body>
</html>
`
}

function requiredText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} 必须为非空字符串`)
  return value.trim()
}

function localPath(value, name) {
  const result = requiredText(value, name).replaceAll('\\', '/')
  if (result.startsWith('/') || /^[a-z]:/i.test(result) || /^\\\\/.test(result) || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(result)) {
    throw new TypeError(`${name} 必须为相对本地路径`)
  }
  if (result.split('/').some((part) => part === '..')) throw new TypeError(`${name} 不得越出交付目录`)
  return result
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
}

function attribute(value) { return escapeHtml(value) }

function card(key, label, detail, href, pathData) {
  const target = href === '#preview' ? ' href="#preview"' : ` href="${attribute(href)}" target="_blank" rel="noreferrer"`
  return `<a class="card" data-kind="${key}"${target}><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${pathData}"/></svg><div><div class="card-label">${label}</div><div class="card-detail">${detail}</div></div></a>`
}

/**
 * 渲染批量交付统一入口（蓝金响应式设计模板的批次版）。
 *
 * @param {object} input
 * @param {string} input.batchId 批次 ID（入口标题）
 * @param {Array<object>} input.pages 成功页面列表，每项：
 *   - itemId: string 页面 item ID
 *   - title: string 页面标题
 *   - type: string 页面类型（deliverableType）
 *   - prototypePath: string 原型相对路径
 *   - configPath: string 配置相对路径
 *   - assetsPath: string 素材目录相对路径
 *   - [screenshotPath]: string 截图相对路径；缺省显示 fallback
 * @returns {string} 可直接写入 index.html 的完整离线文档
 */
export function renderBatchDeliveryIndex({ batchId, pages }) {
  const batchTitle = requiredText(batchId, 'batchId')
  if (!Array.isArray(pages)) throw new TypeError('pages 必须是数组')
  const sections = pages.map((page) => {
    const itemId = requiredText(page.itemId, 'pages[].itemId')
    const pageTitle = requiredText(page.title, 'pages[].title')
    const pageType = requiredText(page.type, 'pages[].type')
    const prototype = localPath(page.prototypePath, 'pages[].prototypePath')
    const config = localPath(page.configPath, 'pages[].configPath')
    const assets = localPath(page.assetsPath, 'pages[].assetsPath')
    const screenshot = page.screenshotPath ? localPath(page.screenshotPath, 'pages[].screenshotPath') : ''
    const screenshotMarkup = screenshot
      ? `<div class="entry-preview"><img src="${attribute(screenshot)}" alt="${attribute(pageTitle)} 预览截图" onerror="this.hidden=true;this.nextElementSibling.hidden=false"><div class="entry-fallback" hidden><span>截图暂不可用</span></div></div>`
      : '<div class="entry-preview"><div class="entry-fallback"><span>暂无截图</span><small>请打开原型查看完整页面</small></div></div>'
    return `    <section class="page-entry" data-item-id="${attribute(itemId)}" data-page-type="${attribute(pageType)}">
      <header class="entry-head">
        <h2>${escapeHtml(pageTitle)}</h2>
        <span class="type">${escapeHtml(pageType)}</span>
      </header>
      <section class="cards" aria-label="${attribute(pageTitle)} 交付文件入口">
        ${card('prototype', '查看原型', '打开可交互的页面原型', prototype, 'M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 13.5z M8 21h8 M12 16v5')}
        ${card('config', '查看配置', '阅读页面设计配置与意图', config, 'M7 3h10v18H7z M10 7h4 M10 11h4 M10 15h4')}
        ${card('assets', '打开素材包', '浏览本页面使用的本地素材', assets, 'M4 7.5A2.5 2.5 0 0 1 6.5 5h3l2 2h6A2.5 2.5 0 0 1 20 9.5v7A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5z')}
        ${card('screenshot', '查看截图', screenshot ? '打开页面静态预览' : '当前交付未生成截图', screenshot || `#preview-${attribute(itemId)}`, 'M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v13a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 18.5z M8 16l2.5-3 2 2 2.5-3 2 4 M8 8.5h.01')}
      </section>
      <div class="entry-preview-row" id="preview-${attribute(itemId)}">
        ${screenshotMarkup}
      </div>
    </section>`
  }).join('\n')
  const emptyState = '<p class="intro">本批次没有成功页面。</p>'
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>${escapeHtml(batchTitle)} · 批量交付</title>
  <style>
    :root { color-scheme: dark; --ink:#f5f7fb; --muted:#9aa8bd; --line:rgba(178,195,220,.16); --blue:#0d1d38; --blue-deep:#071225; --gold:#d6ad67; --gold-soft:#f0d49a; }
    * { box-sizing:border-box; }
    html { min-width:320px; background:var(--blue-deep); }
    body { margin:0; min-height:100vh; color:var(--ink); background:radial-gradient(circle at 82% 10%, rgba(39,91,158,.28), transparent 32rem), linear-gradient(135deg,#071225 0%,#0b1930 56%,#101f3a 100%); font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
    body::before { content:""; position:fixed; inset:0; pointer-events:none; opacity:.22; background-image:linear-gradient(rgba(255,255,255,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.025) 1px,transparent 1px); background-size:48px 48px; mask-image:linear-gradient(to bottom,black,transparent 78%); }
    main { position:relative; width:min(1120px,calc(100% - 48px)); margin:auto; padding:clamp(48px,9vw,112px) 0 72px; }
    .eyebrow { display:flex; align-items:center; gap:12px; color:var(--gold-soft); font:600 11px/1.2 ui-monospace,SFMono-Regular,Consolas,monospace; letter-spacing:.18em; text-transform:uppercase; }
    .eyebrow::before { content:""; width:34px; height:1px; background:var(--gold); }
    h1 { max-width:820px; margin:22px 0 14px; font:500 clamp(38px,7vw,78px)/.98 ui-serif,Georgia,"Times New Roman",serif; letter-spacing:-.045em; }
    .intro { max-width:560px; margin:0; color:var(--muted); font-size:15px; line-height:1.8; }
    .page-entry { margin-top:58px; padding-top:34px; border-top:1px solid var(--line); }
    .page-entry:first-of-type { border-top:none; margin-top:66px; padding-top:0; }
    .entry-head { display:flex; align-items:baseline; gap:14px; flex-wrap:wrap; }
    .entry-head h2 { margin:0; font:500 clamp(22px,3.4vw,30px)/1.2 ui-serif,Georgia,serif; letter-spacing:-.02em; }
    .entry-head .type { display:inline-block; padding:6px 10px; border:1px solid rgba(214,173,103,.42); color:var(--gold-soft); font:600 11px/1 ui-monospace,SFMono-Regular,Consolas,monospace; letter-spacing:.08em; }
    .cards { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:14px; margin-top:22px; }
    .card { min-height:150px; display:flex; flex-direction:column; justify-content:space-between; padding:18px; color:inherit; text-decoration:none; border:1px solid var(--line); background:linear-gradient(145deg,rgba(22,46,82,.72),rgba(10,26,51,.62)); box-shadow:0 18px 50px rgba(0,0,0,.16); transition:transform .35s ease,border-color .35s ease,background .35s ease; }
    .card:hover,.card:focus-visible { transform:translateY(-7px); border-color:rgba(214,173,103,.72); background:linear-gradient(145deg,rgba(31,65,111,.8),rgba(12,30,57,.74)); outline:none; }
    .icon { width:28px; height:28px; color:var(--gold-soft); }
    .card-label { margin-top:18px; font-size:15px; font-weight:600; }
    .card-detail { margin-top:6px; color:var(--muted); font-size:12px; line-height:1.5; overflow-wrap:anywhere; }
    .entry-preview-row { margin-top:14px; padding:14px; border:1px solid var(--line); background:rgba(4,14,31,.38); }
    .entry-preview img { display:block; width:100%; max-height:280px; object-fit:cover; border:1px solid rgba(178,195,220,.1); background:#0d1d38; }
    .entry-fallback { display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:120px; color:var(--gold-soft); font:500 15px ui-serif,Georgia,serif; }
    .entry-fallback small { margin-top:8px; color:var(--muted); font:12px ui-sans-serif,system-ui,sans-serif; }
    footer { margin-top:54px; color:rgba(154,168,189,.7); font:11px ui-monospace,SFMono-Regular,Consolas,monospace; letter-spacing:.08em; }
    @media (max-width:860px) { .cards { grid-template-columns:repeat(2,minmax(0,1fr)); } }
    @media (max-width:560px) { main { width:min(100% - 32px,480px); padding-top:42px; } .cards { grid-template-columns:1fr; margin-top:18px; } }
    @media (prefers-reduced-motion:reduce) { *,*::before,*::after { scroll-behavior:auto!important; transition-duration:.01ms!important; animation-duration:.01ms!important; animation-iteration-count:1!important; } }
  </style>
</head>
<body>
  <main>
    <div class="eyebrow">Batch delivery / offline</div>
    <h1>${escapeHtml(batchTitle)}</h1>
${pages.length ? '    <p class="intro">离线统一入口：以下为全部成功页面的原型、配置、素材与截图入口，均指向本地文件，可在无网络环境中查看、审阅与归档。</p>' : emptyState}
${sections}
    <footer>LOCAL DELIVERY · NO REMOTE ASSETS</footer>
  </main>
</body>
</html>
`
}

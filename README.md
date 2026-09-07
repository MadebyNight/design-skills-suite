# design-skills-suite

面向支付宝小程序首页和活动落地页的受控设计 Skill 套件。它把结构化设计需求转换为页面配置、视觉素材、高保真静态原型和运营配置建议，并通过统一合同完成生图、图片适配、页面组装、批量执行和结果追溯。

- 产品定位、应用场景与人工提效估算：[产品需求文档](docs/product/design-skills-suite-prd.md)
- 输入字段、命令与故障处理：见各 package 的 `SKILL.md`。
# 当前版本为适配目前小程序可用设计功能的版本，全量功能需等后端升级后再逐步开放

## 适合解决什么问题

- 根据主题生成支付宝首页视觉方案，同时保持既有六模块边界；
- 在七类白名单模块内组合活动落地页；
- 根据页面槽位生图，并自动完成比例适配与素材回填；
- 生成首页—落地页的离线联动预览；
- 批量执行多页任务，并从中断或失败处恢复；
- 在 Codex、Claude Code、OpenCode 等 Agent 宿主中复用同一套 Skill 合同和 CLI。

标准页面任务的流程模型估算显示，套件可把单页人工投入从约 4–8 人时降至约 2 人时，即减少约 2–6 人时。该数字不是实测 KPI；假设、计算方式和不计入范围见[产品需求文档的人工提效章节](docs/product/design-skills-suite-prd.md#2-人工提效)。

## 包含什么

| Package / 目录 | 提供能力 |
|---|---|
| `packages/design-skill-contracts` | 公共 JSON Schema 与合同验证 |
| `packages/skill-image-generate` | `image.generate`：通过 fal.ai 或 OpenAI-compatible provider 生成初始图片 |
| `packages/skill-alipay-home` | `page.alipay.home.design`：支付宝首页受控设计 |
| `packages/skill-alipay-landing` | `page.alipay.landing.design`：支付宝落地页受控设计 |
| `packages/skill-alipay-pages` | Catalog、组装、校验、截图、打包 |
| `packages/skill-orchestrator` | Skill 发现与匹配、研究信号、素材回填、批量执行和恢复 |
| `packages/openphoto` | `image.crop`、`image.resize`、`image.export` 本地图片处理；发布到 `dist/openphoto` |
| `examples/alipay-components` | 支付宝组件库只读快照（无嵌套 `.git`，`SOURCE.json` 记录来源） |

组件权威来源为 `examples/alipay-components/` 快照。`SOURCE.json` 记录
`originalRepository`、`originalCommit` 与 `snapshotDate`；若该目录含 `.git` 则生成器仍会校验 clean。

各页面 Skill 可以独立调用。只有需要多页生产、素材自动回填、失败恢复或首页—落地页联动时，才需要编排器。

## 交付内容

页面任务的核心交付包括：

```text
design-package/
├─ home-config.json 或 landing-config.json
├─ prototype.html
├─ prototype.png              # 使用 --screenshot 时生成
├─ assets/
├─ configuration-guide.md
├─ validation-report.json
└─ design-package.json
```

- 页面配置表达设计意图和原型内容，不是生产接口请求体；
- `prototype.html` 是离线静态原型，不等同于支付宝真机效果；
- `configuration-guide.md` 用于说明运营配置建议和待补业务资源；
- `design-package.json` 记录文件、SHA-256、组件来源和 Skill 版本。

批量任务还会生成统一的 `index.html` 交付入口，以及用于恢复和追溯的 request、checkpoint 和 result 文件。

## 环境要求

- Windows；
- Node.js `>=22.0.0`；
- npm；
- 页面截图需要 Playwright Chromium；
- OpenPhoto 需要系统 Chrome 或 Edge。

## 首次准备

```powershell
npm run install:all
npx playwright install chromium
```

## 常用脚本

| 命令 | 作用 |
|---|---|
| `npm run install:all` | 安装根依赖与各 package 独立依赖 |
| `npm run build:openphoto` | 构建 OpenPhoto 发布包到 `packages/openphoto/dist/openphoto` |
| `npm run build:catalog` | 从组件库快照重建 Catalog |
| `npm run test:contracts` | contracts 测试 |
| `npm run test:image` | 生图测试 |
| `npm run test:pages` | pages（Catalog 生成/校验）测试 |
| `npm run test:home` | 首页 Skill 测试 |
| `npm run test:landing` | 落地页 Skill 测试 |
| `npm run test:orchestrator` | 编排器测试 |
| `npm run test:conformance` | 本地 conformance |
| `npm run test:golden` | 八个黄金任务评测 |
| `npm run test:all` | 运行全部测试 |
| `npm run batch` | 标准批量设计 CLI（`packages/skill-orchestrator/bin/design-batch.mjs`） |

## 批量生产快速开始

标准批量设计 CLI 按 item 顺序生产多个首页/落地页；单页独立生图请求最多五路并发，并支持素材级 checkpoint 恢复。

```powershell
# 先计算不会覆盖既有产物的统一名称
npm run batch -- name --output-root ./output --theme-abbr summer

# 根据 name 返回的 requestFile 创建请求，再原样使用返回路径
npm run batch -- run --request <requestFile> --output <outputPath>
```

- `name`：只读计算 `YYYYMMDD-<主题缩写>-vN` 请求文件名和输出路径；
- `run`：从请求文件新建批次；`--screenshot` 可选，开启页面截图；
- `resume`：从已有输出目录继续未完成 item（`npm run batch -- resume --output <dir>`）；
- `retry-failed`：仅重跑失败 item，attempt 递增（`npm run batch -- retry-failed --output <dir>`）。

图片 provider 由环境变量选择：

| 环境变量 | 值 | 说明 |
|---|---|---|
| `IMAGE_GENERATE_PROVIDER=test` | 本地确定性 provider，不联网 | 默认推荐用于验证 |
| `IMAGE_GENERATE_PROVIDER=fal` | 需 `FAL_KEY` | 真实 fal.ai |
| `IMAGE_GENERATE_PROVIDER=openai-compatible` | 需 `IMAGE_API_BASE_URL`、`IMAGE_API_KEY` | OpenAI-compatible 网关 |

stdout 仅输出单行最终 JSON：成功 `{ ok:true, result }`，错误 `{ ok:false, code, message }`。

退出码：

| 退出码 | 含义 |
|---:|---|
| 0 | 全部成功 |
| 2 | 请求/Schema/用法错误 |
| 3 | provider 配置缺失（如缺 API key） |
| 4 | 批次部分失败或失败 |
| 5 | checkpoint 不兼容/损坏、输出已存在或内部错误 |

输出目录结构：

```text
<dir>/
├─ request.json
├─ checkpoint.json
├─ checkpoint.previous.json
├─ result.json
└─ items/
   └─ <itemId>/
      └─ attempts/
         ├─ 0001/
         └─ 0002/
```

详细字段与恢复语义见 [`skill-orchestrator/SKILL.md`](packages/skill-orchestrator/SKILL.md)。

## 能力边界

本套件可以在既有组件 Catalog 和模块白名单内规划页面，生成或适配视觉素材，输出配置、原型、截图、素材和配置建议，并完成自动校验与批量恢复。

本套件不负责：

- 自由生成任意 HTML、CSS、JavaScript、坐标布局或自定义组件；
- 创建真实商品、优惠券、价格、库存或业务资源 ID；
- 推导生产路由、`pageCode`、`jumpUrl` 或发布状态；
- 上传生产素材、保存草稿、发布页面、刷新缓存或替代真机验收；
- 把离线原型、截图或设计配置描述为已经在支付宝小程序生效。

## 已记录的验证状态

当前版本定位为**产品形态验证版**。仓库现有阶段报告记录：

- 八个黄金任务自动评测通过；
- 首页和落地页黄金任务的全部测试素材槽完成生成、OpenPhoto 适配与回填；
- 页面在 375px 视口的结构化检查中无横向溢出；
- 三个 Agent 宿主生成的首页设计包结构和逐文件 SHA-256 一致；
- 人工视觉可用率、真实图片 provider 的重复耗时与成本、真实 Web Search 来源质量尚未完成评测。

上述数据来自发布前的自动评测记录；人工视觉质量仍需独立验收。

## 文档导航

- [产品需求文档](docs/product/design-skills-suite-prd.md)
- [首页 Skill](packages/skill-alipay-home/SKILL.md)
- [落地页 Skill](packages/skill-alipay-landing/SKILL.md)
- [生图 Skill](packages/skill-image-generate/SKILL.md)
- [编排 Skill](packages/skill-orchestrator/SKILL.md)
- [OpenPhoto Skill](packages/openphoto/skill/openphoto/SKILL.md)

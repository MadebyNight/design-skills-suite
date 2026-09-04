# skill-alipay-home

支付宝首页设计 Skill。接收公共 `DesignBrief`（`deliverableType` 必须为 `alipay.home`），从 `DesignBrief` 与可选主题参数派生 `alipay-home-config/v1` 唯一配置合同，并以配置驱动受控组装，输出四项同源交付物。

> **范围约束**：这是受控 Node 工具链实现，**不做自由视觉设计**。只允许在现有 8 类首页组件上做最小自然中文文本替换和图片回填，不新增 DOM、class、style 或 script；商品推荐固定 `preserve-existing`。

## 规划与询问

本 Skill 自行做与本次首页生成直接相关的短计划，不调用外部通用 `brainstorming` Skill。页面类型、主题和数量明确时静默执行；仅当表述不明确、要求冲突，或必须明显扩展范围时询问用户。批量交付的目录和请求文件命名由 `skill-orchestrator name` 统一分配。

## 能力

- 提供能力 `page.alipay.home.design`（ID 冻结于 `design-skill-contracts`）。
- 复用 `design-skill-contracts` 的 Schema 与最小验证器，不复制 Schema。
- 复用 `skill-alipay-pages/scripts/{assemble,validate,package,screenshot}.mjs` 与 `catalog/home.catalog.json`；禁止修改这些依赖、公共 Schema、根依赖和组件库。
- `runtime/planner.mjs#deriveHomeConfig` 从 `DesignBrief + 可选 { homeTheme, landingThemes, landingPreviewRefs }` 派生并严格校验 `alipay-home-config/v1` 配置；搜索栏使用受控的默认/主题短文案，并按首页主题自动选择顶部、输入框和按钮背景色，不直接展示 `contentRequirements` 中的设计指令；越界输入（非法主题、失效预览引用路径等）在产出任何文件前按稳定错误码失败。
- 素材链路：生产 AssetRequest 槽位统一为 `home.<module>.<item>.<role>` 并采用能力基线尺寸，按比例（±3%）验收 + 3 生成 / 2 适配重试执行；`brief.inputArtifacts` 一律视为用户原始参考图（不信任 `sourceSkill`），仅作参考图，不直接进入最终页面。

## 输入

公共 `DesignBrief`（`design-brief.schema.json`）。`deliverableType` 必须为 `alipay.home`，否则返回稳定错误 `UNSUPPORTED_DELIVERABLE`。

### 可选主题参数（designHome options / CLI flags）

| 参数 | CLI | 说明 |
| --- | --- | --- |
| `homeTheme` | `--home-theme <text>` | 首页宽泛主题，决定整页风格、搜索占位文案与搜索栏背景色板；缺省取 `brief.goal`。 |
| `landingThemes` | `--landing-themes <json>` | 落地页主题数组：字符串，或编排器对象形 `{landingKey, theme, landingPreviewRef?}`；缺省使用默认两主题（夏日出游租赁、演唱会租赁）。 |
| `landingPreviewRefs` | `--landing-preview-refs <json>` | 成功落地页预览引用 `[{landingKey, landingPreviewRef}]`；与 `landingThemes` 对象形内嵌 ref 等效。仅任务内成功落地页登记，绝不等同生产跳转。 |

主题输入越界时返回稳定错误码：`INVALID_HOMETHEME`、`INVALID_LANDING_THEMES`、`INVALID_LANDING_PREVIEW_REFS`（经 `deriveHomeConfig` 校验后还会产出 `INVALID_HOME_CONFIG`）。

### inputArtifacts 回填规则

- `brief.inputArtifacts` **一律视为用户原始参考图，不信任 `sourceSkill` 标记**：无论标记为何，都不参与槽位验收、不形成 `imageChanges`、不命中 reuse；仅作为缺图请求的 `referenceImages` 候选（按 `assetRequestId` 对应槽位注入），未匹配槽位记 warnings。
- 二次回填（编排器回传的 `completedAssets`）走 `designHome` 内部参数 `completedAssets`（AssetResult 列表）：
  - 该参数不进入 DesignBrief 公共 Schema，CLI 不暴露；编排器适配后由 runner 显式传入已验收结果，公共 brief 不存在伪造回填路径。
  - 素材必须命中槽位 `assetRequestId` 且通过槽位比例验收（相对目标比例误差 ≤3%，边界 0.03 通过）才回填；`strictSizeSatisfied` 不作为验收条件。
  - `assetRequestId` 与 `artifactId` 均须在本页唯一；同一已完成结果不能绑定多个槽位，重复值以 `DUPLICATE_COMPLETED_ASSET` 明确拒绝。
  - 编排器可通过内部参数 `failedAssets`（重试耗尽的 `assetRequestId` 列表）标记失败槽位：原型显示“素材生成失败”；该参数不进入 CLI 或公共 brief。
  - 未通过验收或未匹配槽位的回填素材不写入 `imageChanges`，记 warnings。
- 回填产物统一按槽位命名 `assets/<usageSlot>.png`，与 `home-config.json` 中的素材路径一致。
- 未命中的缺图槽位生成合法 `AssetRequest`（见下方执行合同），并**复制组件快照至对应槽位路径作为 pending 预览**（status 为 `completed_with_pending_assets`，不伪装 `succeeded`）；该快照不是用户 `inputArtifacts`，也不表示素材已验收。
- 任一必填素材重试耗尽后仍失败时，任务整体失败（`VALIDATION_FAILED` 等），不得用默认图伪装完整交付；该失败只约束首页自身，不阻断联合任务中独立的落地页交付。

### AssetRequest 执行合同（稳定）

生产素材请求统一声明请求级执行合同（schema 见 `design-skill-contracts`）：

```json
{
  "acceptance": { "mode": "aspect-ratio", "maxAspectRatioError": 0.03 },
  "retryPolicy": { "generateMaxAttempts": 3, "adaptMaxAttempts": 2 }
}
```

- 比例模式以 `targetWidth / targetHeight` 为唯一数值目标，实际素材比例误差 ≤3% 即通过，不检查 `strictSizeSatisfied`。
- 生成最多 3 次、适配最多 2 次，仅对可重试错误重试；生成比例合格时跳过适配。

### 可生成素材槽位（稳定）

| 槽位 | 尺寸 | 说明 |
|---|---|---|
| `home.carousel.<item>.image` | 1404x600 | 每个配置轮播条目一张 |
| `home.quickEntries.<01-05>.image` | 200x200 | 金刚区前 5 项 |
| `home.tofuBlocks.01.large` | 690x640 | 豆腐块左主图 |
| `home.tofuBlocks.02/03.image` | 690x312 | 豆腐块右上/右下 |
| `home.waistBanners.<01..>.image` | 1440x328 | 每个配置腰封条目一张 |

不创建素材请求的固定快照：搜索图标（`home.searchBar.…`）、固定 TabBar（`home.tabbar.…`）与商品推荐（`home.productRecommendation.…`），它们保持组件快照内容。

## CLI

```bash
# 输出本 Skill 提供的能力清单
node bin/home-design.mjs capabilities

# 从 JSON 文件读取 DesignBrief 并设计首页
node bin/home-design.mjs request --file brief.json --output out/

# 从内联 JSON 读取 DesignBrief 并设计首页
node bin/home-design.mjs request --json '{...}' --output out/

# 可选主题参数（也可与 --file 组合）
node bin/home-design.mjs request --json '{...}' --output out/ \
  --home-theme '夏日出游租赁' \
  --landing-themes '["夏日出游租赁","演唱会租赁"]' \
  --landing-preview-refs '[{"landingKey":"landing-01","landingPreviewRef":"landing-01/prototype.html"}]'

# 可选生成全页截图（需要 Playwright）
node bin/home-design.mjs request --file brief.json --output out/ --screenshot
```

## 输出

正常返回：

```text
{
  "ok": true,
  "status": "succeeded | completed_with_pending_assets",
  "designPackage": { ... },        // 符合 design-package.schema.json
  "pendingAssetRequests": [ ... ], // 缺图槽位生成的合法 AssetRequest 列表
  "warnings": [ ... ]
}
```

### 四项同源交付物

`designHome` 每次交付固定包含以下四项，全部从同一份 `home-config.json`（`alipay-home-config/v1`）派生，素材路径均为包内相对路径：

| 产物 | 说明 |
| --- | --- |
| `home-config.json` | 唯一配置合同：固定六模块（searchBar/carousel/quickEntries/tofuBlocks/waistBanners/productRecommendation）、`landingThemes`（含任务内 `landingKey`）与成功落地页 `landingPreviewRef`。 |
| `prototype.html` + `assets/` | 静态原型按配置受控组装：搜索占位文案取受控 `searchBar.placeholderText`，金刚区经受控 homeNav 重建（5–25、五列多行），每个轮播 clone 使用自身 `item.image`；pending 槽位仅显示复制的组件快照，素材路径与配置一致。 |
| `configuration-guide.md` | 面向运营的配置建议，由同一份配置渲染：颜色/圆角、轮播与腰封主题、素材比例（轮播 1404x600、金刚区 200x200 等）、`jumpUrl` 与生产发布归属业务系统的说明。 |
| `design-package.json` | 交付元数据，逐文件记录 `home-config.json` 与 `configuration-guide.md`（kind 与文件名对应）及各资产 sha256。 |
| `visual-review.json` | 最小审阅记录：先 assets 后 page；未配置视觉模型时只写可选评审跳过 warning。 |

配置派生失败（越界主题、非法 ref）在写入任何文件前失败；交付校验失败（`VALIDATION_FAILED`）不产出残缺交付包。

若用户明确要求修改圆角、tokens、新增组件/class 或远程资源，返回
`status: "rejected"` 与结构化 `rejection.reasons/alternatives`，且不生成原型文件。

稳定错误：

```text
{ "ok": false, "code": "...", "message": "...", "details": [...] }
```

稳定错误码：`INVALID_JSON`、`INVALID_BRIEF`、`UNSUPPORTED_DELIVERABLE`、`INVALID_ASSET_REQUEST`、`DUPLICATE_REQUEST`、`INVALID_HOMETHEME`、`INVALID_LANDING_THEMES`、`INVALID_LANDING_PREVIEW_REFS`、`INVALID_HOME_CONFIG`、`VALIDATION_FAILED`、`PLAYWRIGHT_UNAVAILABLE`、`FILE_NOT_FOUND`、`USAGE`、`INTERNAL`。

## 测试

```bash
npm test
# 等价于 node --test "tests/**/*.test.mjs"
```

测试全部使用临时目录，结束后清理，不产生工作空间残留。

## 目录结构

```text
packages/skill-alipay-home/
├─ package.json
├─ SKILL.md
├─ manifest.json
├─ bin/
│  └─ home-design.mjs       # CLI + 配置派生 + 组装编排（写 home-config.json 与 configuration-guide.md）
├─ runtime/
│  ├─ planner.mjs           # DesignBrief 校验 + 文本/图片规划 + deriveHomeConfig
│  └─ asset-requester.mjs   # AssetRequest 合法性校验
└─ tests/
   └─ home.test.mjs         # node:test
```

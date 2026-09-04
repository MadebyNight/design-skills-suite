# skill-alipay-landing

支付宝落地页设计 Skill。接收公共 `DesignBrief`（`deliverableType` 必须为 `alipay.landing`），只消费 `landing catalog`，受控组装输出完整 `DesignPackage`。

> **范围约束**：这是受控 Node 工具链实现，**不做自由视觉设计**。只允许在 landing-config（landing-schema/v1）的七类白名单模块内受控重组页面，不新增 DOM、class、style 或 script。

## 规划与询问

本 Skill 自行做与本次落地页生成直接相关的短计划，不调用外部通用 `brainstorming` Skill。页面类型、主题和数量明确时静默执行；仅当表述不明确、要求冲突，或必须明显扩展范围时询问用户。批量交付的目录和请求文件命名由 `skill-orchestrator name` 统一分配。

## 能力

- 提供能力 `page.alipay.landing.design`（ID 冻结于 `design-skill-contracts`）。
- 复用 `design-skill-contracts` 的 Schema 与最小验证器，不复制 Schema。
- 复用 `skill-alipay-pages/scripts/{assemble,validate,package,screenshot}.mjs` 与 `catalog/landing.catalog.json`；禁止修改这些依赖、公共 Schema、根依赖和组件库。

## 输入

公共 `DesignBrief`（`design-brief.schema.json`）。`deliverableType` 必须为 `alipay.landing`，否则返回稳定错误 `UNSUPPORTED_DELIVERABLE`。

可选参数（CLI `--theme`/`--landing-key`，或编排器 `designLanding` 的 `{ theme, landingKey }`）：

- `theme`：整页主题与页面名/导航标题；页面背景默认由 Agent 按主题主动设计并进入统一素材链路，不要求用户写出“背景图”等关键词；仅用户明确要求纯色背景时使用主题纯色。未提供主题时用默认主题「夏日出游租赁」。
- `landingKey`：联合任务内非生产稳定标识（`landing-01`/`landing-02`…），独立交付省略。

## 交付（四项同源）

均由 `landing-config.json`（landing-schema/v1）派生：

| 产物 | 说明 |
| --- | --- |
| `landing-config.json` | 唯一配置合同：页面级配置 + 七类白名单模块 + pendingResourceRequests |
| `prototype.html` | 由 `config.modules` 映射为受控 blocks 组装 |
| `assets/` | 已回填素材按 config 声明路径复制 |
| `configuration-guide.md` | 面向运营的配置建议，标注发布前必填项 |

### 回填边界（独立设计入口防伪造）

- `brief.inputArtifacts` 一律视为**用户原始参考图**：不信任 `sourceSkill` 标记，绝不直接形成 `imageChanges`，只作为 `pendingAssetRequests.referenceImages` 候选进入生图请求；不存在通过 brief 伪造已验收素材的公共路径。
- 已验收素材仅经**内部参数 `completedAssets`** 显式传入（编排器 `runDesign` 二次回填专用）：按 `assetRequestId` 匹配 `landing.<slotKey>.<slot>.image` 槽位、比例误差 ≤3% 才复制回填并替换 `src`。
- 未回填的缺图槽位生成合法 `AssetRequest`（`pending`），原型暂用组件快照素材维持完整评审画面；`pending` 不显示失败。已验收的 `completedAssets` 按槽位回填后为 `accepted`。编排器可通过内部参数 `failedAssets`（重试耗尽的 `assetRequestId` 列表）标记失败槽位，原型显示“素材生成失败”；页面背景在页面顶部显示，优惠券和商品集合背景在对应模块内显示。该参数不进入 CLI 或公共 brief，不能把 pending 当作 failed。全部槽位回填才返回 `succeeded`，否则 `completed_with_pending_assets`。

### 素材请求执行合同

所有真实素材请求（`pendingAssetRequests`）统一携带：

- 槽位命名：`landing.<landingKey>.<slot>.image`（独立交付 `<slotKey>=default`），`id === usageSlot`。
- `acceptance: { mode: 'aspect-ratio', maxAspectRatioError: 0.03 }`：以 `targetWidth / targetHeight` 为唯一数值目标，比例误差 ≤3% 即通过（边界 0.03 通过），不检查 `strictSizeSatisfied`。
- `retryPolicy: { generateMaxAttempts: 3, adaptMaxAttempts: 2 }`：生成最多 3 次、适配最多 2 次，只对 `error.retryable === true` 重试。
- 商品图片不创建素材请求；PRODUCT_COLLECTION 保持快照商品引用，由业务系统维护。

### 素材槽位（配置驱动）

槽位随 config modules 生成，命名 `landing.<slotKey>.<slot>.image`：

| 槽位 | 目标尺寸 | 验收 |
|---|---|---|
| hero | 1500x720 | 比例误差 ≤3% |
| imageAd.N（单图模式） | 1404x480 | 比例误差 ≤3% |
| imageAd.N（双图模块，单张） | 686x480 | 比例误差 ≤3% |
| pageBackground | 1500x2400 | 比例误差 ≤3% |
| sectionTitle.N（图片标题） | 720x120 | 比例误差 ≤3% |
| couponGroup.N.*Background / productCollection.N.background | 对应容器 | 比例误差 ≤3% |

槽位名 `<slotKey>` 取 `landingKey`（独立交付为 `default`）；IMAGE_AD 尺寸按模块 `mode` 生成（单图恰好 1 张，双图恰好 2 张）。

仅提供主题而未明确模块诉求时，默认顺序为 `HERO_IMAGE → SPACER → COUPON_GROUP → SECTION_TITLE → IMAGE_AD → SECTION_TITLE → PRODUCT_COLLECTION → SPACER`。`ACTION_BUTTON` 只在明确提出按钮、跳转或报名时加入。双图广告在同一个 `.lp-image-ad.is-double` 容器内横向并排，每张图仍各有一个请求和文件。

每个请求只接收 `assetRequestId === usageSlot` 的参考图；没有槽位绑定的参考图不会注入 provider。槽位提示词包含用途、比例、展示方式、构图、安全区与禁止内容；有效 `ResearchPack` 的 color/visual/layout/content 信号只作为受控提示词补充。

## CLI

```bash
# 输出本 Skill 提供的能力清单
node bin/landing-design.mjs capabilities

# 从 JSON 文件读取 DesignBrief 并设计落地页
node bin/landing-design.mjs request --file brief.json --output out/

# 从内联 JSON 读取 DesignBrief 并设计落地页
node bin/landing-design.mjs request --json '{...}' --output out/

# 指定主题与联合任务标识
node bin/landing-design.mjs request --file brief.json --output out/ --theme '演唱会租赁' --landing-key landing-01

# 可选生成全页截图（需要 Playwright）
node bin/landing-design.mjs request --file brief.json --output out/ --screenshot
```

## 输出

正常返回：

```text
{
  "ok": true,
  "status": "succeeded | completed_with_pending_assets",
  "designPackage": { ... },        // 符合 design-package.schema.json，记录四项产物
  "pendingAssetRequests": [ ... ], // 未回填槽位的合法 AssetRequest 列表
  "warnings": [ ... ]
}
```

编排器二次回填入口（内部参数，非 brief 公共路径）：

```js
// runDesign 已验收素材通过 completedAssets 显式传入，触发二次页面调用回填
designLanding({ brief, outputRoot, completedAssets: acceptedAssets })
```

稳定错误：

```text
{ "ok": false, "code": "...", "message": "...", "details": [...] }
```

稳定错误码：`INVALID_JSON`、`INVALID_BRIEF`、`UNSUPPORTED_DELIVERABLE`、`INVALID_OPTIONS`、`INVALID_LANDING_KEY`、`FORBIDDEN_FIELD`、`INVALID_ASSET_REQUEST`、`DUPLICATE_REQUEST`、`VALIDATION_FAILED`、`PROTOTYPE_SLOT_MISSING`、`PLAYWRIGHT_UNAVAILABLE`、`FILE_NOT_FOUND`、`USAGE`、`INTERNAL`。

## 测试

```bash
npm test
# 等价于 node --test "tests/**/*.test.mjs"
```

测试全部使用临时目录，结束后清理，不产生工作空间残留。

## 视觉检查

先逐槽位检查素材是否属于目标用途，且未出现整页、手机框、多模块拼版或重复宫格；再检查完整原型的模块顺序、双图并排、背景与裁切。视觉模型不可用时记录 warning，规则校验继续执行。

## 目录结构

```text
packages/skill-alipay-landing/
├─ package.json
├─ SKILL.md
├─ manifest.json
├─ bin/
│  └─ landing-design.mjs   # CLI + config 派生编排（blocks 组装、回填、诊断占位）
├─ runtime/
│  ├─ planner.mjs          # DesignBrief 校验 + deriveLandingConfig 配置派生
│  └─ asset-requester.mjs  # AssetRequest 合法性校验
└─ tests/
   └─ landing.test.mjs     # node:test
```

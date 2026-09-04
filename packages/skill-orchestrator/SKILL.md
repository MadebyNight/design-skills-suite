# skill-orchestrator

设计 Skill 编排 package（计划工作线 C）。实现 Skill 发现、Capability 匹配、研究信号装配（C3）、
软建议合并（C4）、页面素材回填（C5）与批量生产编排（3B/3C）。

> **范围约束**：不动态安装、不自动升级、不连网络 registry。provider 凭据来自显式环境变量或当前 Codex Agent 登录态，不落入交付物。

## 规划与询问

本 Skill 自行做与本次生成直接相关的短计划，不调用外部通用 `brainstorming` Skill。用户已明确页面类型、主题和数量时静默执行；仅当表述不明确、要求彼此冲突，或完成任务必须明显扩展范围时再询问用户。

## 能力

- 扫描显式传入的 Skill 根目录，读取 `SKILL.md` / `manifest.json`，以 `manifest.json` 为结构化真相源。
- 复用 `design-skill-contracts` 的 JSON Schema 与最小验证器校验 `SkillManifest`，不复制 Schema、不改合同、不安装依赖。
- 支持注入 executor 做 capability 可用性探测。
- 稳定排序输出：`skills` / `byCapability` / `unavailable`。
- 根据显式指定、Schema、自动执行、确认点、可选优先级和稳定排序选择 capability provider。
- 批量生产：批次请求加载、checkpoint 持久化、断点恢复、失败重试与标准运行时绑定（见下）。

## 用法

```js
import { discoverSkills } from './runtime/discovery.mjs'

const result = await discoverSkills({
  skillRoots: ['path/to/skill-a', 'path/to/skill-b'],
  // executor 可选，签名 async ({ root, manifest }) => boolean
  executor: async ({ root, manifest }) => true,
})

// result.skills       可用的 Skill 列表（稳定排序）
// result.byCapability capability ID -> Skill ID 列表
// result.unavailable  不可用 Skill（含原因）
// result.duplicates   重复 Skill ID 记录
```

```js
import { matchCapability } from './runtime/matcher.mjs'

const match = matchCapability({
  discovery: result,
  capability: 'image.generate',
  request: { requireAutomatic: true },
})
```

未提供 `CapabilityManifest` 元数据时 priority 默认为 `0`；提供时数值越大越优先，
同优先级再按 capability version、Skill ID 和规范化路径稳定排序。

## 研究信号包（C3）与软建议合并（C4）

```js
import { buildResearchPack } from './runtime/research.mjs'
import { aggregateGuidance } from './runtime/guidance.mjs'
```

`buildResearchPack({ brief, searchBinding, catalog, maxQueries = 3 })` 按 `brief.researchPolicy`
决定行为：

- `none` → `skipped`，pack 为 `null`；
- `optional` 且检索缺失/失败/空结果 → `warning`，pack 为 `null`；
- `required` 且检索缺失/失败/空结果 → `failed`，pack 为 `null`；
- 成功：归一化 `url/title/snippet`，生成 `queries/sources/signals`（visual/color/layout/content）
  与 `adoptedElements`（经 catalog 过滤），`sourceRefs` 全部引用 `sources` 的 URL，
  输出通过 `ResearchPack` Schema 校验。`searchBinding` 由调用方注入，本模块不联网。

`aggregateGuidance({ brief, researchPack, catalog, guidanceBindings = [] })` 合并多个
binding（`{ sourceSkill, sourceSkillVersion, run }`，`run` 返回 item 数组）的软建议：

- 按 catalog 的 component id / allowedClasses / allowedVariants 做明确 token 过滤；
- 采纳条目 `catalogAccepted=true`、`rejectionReason=null`；拒绝条目记 `rejectedCount` 与原因；
- binding 失败非阻断，记为 warning；输出通过 `DesignGuidance` Schema 校验，
  含 `sourceCommit` 与 `rejectedCount`。

## 页面素材回填（C5）

`runDesign` 对首次页面调用返回的 `pendingAssetRequests` 执行一次有界回填。可选参数
`assetPolicy`（`{ default, rules }`，见 `asset-policy.schema.json`）、`assetStore`
（`createAssetStore` 返回的缓存）、`itemFingerprint`（缓存键指纹，缺省用 `brief.id`）。
未传 `assetPolicy` 时使用默认策略 `{ default: { source: 'generate', requirement: 'required' }, rules: [] }`，
保持既有行为。

原始 `brief.inputArtifacts` 只作参考图候选：仅当其 `assetRequestId` 精确匹配待补请求的
`id` 或 `usageSlot` 时才注入该请求，未绑定输入不会注入任意槽位，也不参与回填或 reuse。
对每个待补请求按 `usageSlot` 解析策略决策，处理顺序：
1. 命中 `assetStore` 缓存（`assetKeyFor` 派生键，仅含 canonical request + policySource，不含密钥）；
2. `source=reuse`：未找到时不调用 generator/adapter；`required` 记失败、`optional` 记 warning；
3. `source=generate`：无缓存才调用 `image.generate`，成功后写入缓存；`required` 失败记失败、
   `optional` 失败记 warning 且继续。

参考图 provider 需通过 binding 的 `capabilities` 声明 `asset.reference-images`。未声明时 runner
会清空该请求的 `referenceImages`、记录 warning，并继续以请求的文字约束生成，不会使全部素材失败。
runner 确保每个 request 仅产生一个回填结果，且同一 `artifactId` 不会被多个请求重复消费；重试耗尽的
required/optional 请求 ID 会在最终页面调用中通过内部 `failedAssets` 透传，以便原型明确显示“素材生成失败”；页面 Skill
仍会独立校验该合同。

仅当 `allowGenerate=true` 时逐项调用 `image.generate`；仅当生成结果的 width、height、MIME 与
`strictSizeSatisfied=true` 均严格满足请求时才直接回填，否则仅在 `allowEdit=true` 时调用由组合根
注入的 `imageAdapter`。收集严格满足请求尺寸与格式的 `AssetResult` 后，将其合并到
`brief.inputArtifacts` 并第二次调用同一页面 capability。已有 `inputArtifacts` 不会被自动编辑。

适配 provider 采用延迟解析：仅当至少一个 generate 请求实际需要适配时才解析并记录
`image.crop/image.resize/image.export` capability；全 reuse 场景不要求 adapter/provider 能力，
避免无谓失败。`image.generate` capability 也仅在真正调用 generator（成功或失败）时记录；
brief input 复用、缓存命中、reuse 缺失均不记录。最终状态仅由 `required` 的失败或剩余必填请求决定；
`optional` 失败或剩余可选请求不使整体失败，保留默认素材。若全部待补素材均为 optional 且无任何
可回填素材，则不做第二次页面调用，直接使用首次页面包并标记 `succeeded`。

适配 provider 先由 discovery 中同时声明 `image.crop`、`image.resize`、`image.export` 的 Skill ID
交集确定，再以 `preferredSkillId` 审计三项 matcher。适配 binding 使用
`{ providerId, run(request, { asset, outputRoot }), close?() }` 形式：`providerId` 必须位于该交集；runner 不依赖
具体图片实现。OpenPhoto 组合根 adapter 使用 `canvas.resize`、`object.transform.set` 和
`document.renderArtifact` 完成真实 cover/contain、PNG/JPEG 输出，并回读 artifact 校验尺寸、MIME 与 SHA-256。
`createOpenPhotoAdapterBinding({ openphotoRoot, dataRoot, sourceRoot })` 的 `sourceRoot` 用于解析
相对 `AssetResult.path`：传入时必须是生成器产物所属目录；未传入时固定为创建 binding 当时的
`process.cwd()`。绝对路径不受此参数影响；runner 只依赖通用 binding 接口，不硬编码 OpenPhoto。
若 binding 提供可选 `close()`，runner 会在本次所有待补素材处理完成后调用它；OpenPhoto 的 `dataRoot` 是一轮
run 内所有素材共享的 data root，复用同一个 daemon，统一由该 `close()` 回收，避免逐素材重启和遗留进程。

调用 `image.generate` 时，runner 会传入 `{ outputRoot, artifactRoot }`；`artifactRoot` 是本轮 `outputRoot` 下的
`generated-assets/` 目录，生成 binding 应将本轮临时源素材写入该目录。

同一页面的独立生图请求以固定并发上限 `5` 执行；单个素材内部的生成重试仍按请求合同串行。OpenPhoto 适配共享同一浏览器/daemon，因此跨素材适配与缓存/checkpoint 写入保持串行。并发完成后的素材和步骤按原请求顺序合并。批次 item 仍按既有顺序执行，联动首页仍等待关联落地页完成。

每个请求都会记录生成、复用、缓存或适配步骤（details 含 request id 与策略 source/requirement）；
单项失败仍继续处理其余请求。至少一个请求成功才会第二次调用页面 Skill；全部失败时保留首次页面包
且只调用一次。仅当所有 `required` 请求均严格回填、第二次页面调用不再返回 `required` 待补请求且
没有 `required` 失败步骤时，编排结果为 `succeeded`；否则为 `failed`。

## 批量生产 CLI（3B/3C）

`bin/design-batch.mjs` 提供批次生产入口，根目录脚本 `npm run batch` 等价于
`node packages/skill-orchestrator/bin/design-batch.mjs`。

```bash
# 先计算本次统一名称（只读，不创建文件）
npm run batch -- name --output-root ./output --theme-abbr bg4
# 运行新批次
npm run batch -- run --request ./output/20260904-bg4-v1-request.json --output ./output/20260904-bg4-v1 [--screenshot] [--source-commit X]
# 断点恢复（只重跑 pending/interrupted）
npm run batch -- resume --output ./out [--screenshot] [--source-commit X]
# 重试失败项（只重跑 failed）
npm run batch -- retry-failed --output ./out [--screenshot] [--source-commit X]
```

- `--source-commit` 缺省用 `git rev-parse HEAD`（execFile 无 shell），失败抛 `SOURCE_COMMIT_UNAVAILABLE`。
- provider 不接受 key CLI 参数。显式 `IMAGE_GENERATE_PROVIDER` 及 `IMAGE_API_*` / `FAL_KEY` 优先；未显式指定时优先继承当前 Codex Agent 的 provider URL 与登录态，图片模型缺省 `gpt-image-2`；Codex 配置不可用时再回退既有 FAL 环境变量。
- 标准绑定 `createStandardBatchRuntime` 把每个 item 映射到 `runDesign`：页面 binding 按
  `deliverableType` 用 `designHome`/`designLanding`，`image.generate` 用 `generateAsset`，
  `imageAdapter` 用 `createOpenPhotoAdapterBinding`（仅当 OpenPhoto 已发布时注入，全 reuse 不需 adapter），
  并将 runner 生成的 `researchPack` 透传给页面 planner。

### 目录与产物

Agent 创建新批次前必须先调用 `name`，并原样使用返回路径。统一 basename 为 `YYYYMMDD-<主题缩写>-vN`：日期在最前，主题缩写为 2–20 位英文字母/数字，版本从 `v1` 起；同日同主题扫描输出目录和 `-request.json` 后自动递增。请求文件固定为 `<basename>-request.json`，输出目录固定为 `<basename>/`。既有产物不自动移动或重命名。

每次批次在 `--output` 目录下生成两层产物：面向使用者的四层交付发布区（终态自动发布）
与保留给恢复/追溯的批次运行目录。

发布区（`run`/`resume`/`retry-failed` 终态自动重建，幂等；只含成功 item）：

```text
out/
├─ index.html                  # 离线统一入口（蓝金响应式设计模板）：列出全部成功页面的
│                              # 原型/配置/素材/截图入口
├─ assets/<itemId>/            # 该页面原型实际引用的最终素材（改写后的本地引用）
├─ configs/<itemId>.config.json # home-config.json / landing-config.json 发布副本
└─ other/
   ├─ <itemId>/                # prototype.html（引用改写）、styles/、配置指南、
   │                           # brief、manifest、package、component usage、
   │                           # validation report、prototype.png
   ├─ <itemId>/<landingKey>/   # 联动批次首页 attempt 内的落地页完整离线预览目录
   └─ runtime/                 # request.json、checkpoint.json、result.json 运行时追溯
```

- 发布后原型的素材引用改写为 `../../assets/<itemId>/...`；styles 保留同目录引用；
  首页 `landingPreviewRef` 改写为 `../<landingItemId>/prototype.html`，发布层内
  首页—落地页离线链接可点击。
- 发布层不复制 `generated-assets/` 与 `openphoto-data/`（生成中间图与 daemon 工作目录）；
  发布后原型的本地 `src`/`href` 均必须存在，缺失依赖、越界或绝对路径引用按
  `BATCH_PUBLISH_INCOMPLETE` / `BATCH_PUBLISH_INVALID` 明确抛出（fail fast）。
- 部分失败批次仍发布已成功页面；发布失败会使 `runBatch` 整体抛错，
  不会静默报告批次成功但交付入口损坏。

批次运行目录（attempt 恢复与追溯，不进入交付入口）：

```text
out/
├─ request.json            # 批次请求（不含 provider secret）
├─ checkpoint.json         # 当前检查点（原子写，含 checkpoint.previous.json 备份）
├─ result.json             # 最终 BatchResult
└─ items/<itemId>/attempts/<0001>/   # 每次 attempt 独立目录
   ├─ result.json          # 该 attempt 的 OrchestrationResult
   └─ generated-assets/    # 生图产物
```

### 恢复语义

- `run`：输出已存在（request/checkpoint/result 任一）抛 `BATCH_OUTPUT_EXISTS`；空目录允许。
- `resume`：加载 request+checkpoint，`assertCompatible`（batchId/requestFingerprint/sourceCommit/provider），
  把 `running` 归一化为 `interrupted` 并持久化，只重跑 `pending`/`interrupted`；`succeeded` 永不重跑。
- `retry-failed`：只重跑 `failed`；若存在 `pending`/`running`/`interrupted` 抛 `BATCH_RETRY_REQUIRES_RESUME`。
- 每次状态变更都 `touch updatedAt` + 原子写 checkpoint；attempt 目录用 `nextAttempt` 递增，已存在拒绝覆盖。
- 最终 `checkpoint.status` 与 `BatchResult.status` 同名（`succeeded`/`partially_failed`/`failed`）。

### 退出码

| 码 | 含义 |
|----|------|
| 0  | 批次 `succeeded` |
| 2  | 请求/schema/用法（`BATCH_REQUEST_*`、`BATCH_USAGE` 等） |
| 3  | provider 配置（`MISSING_API_KEY`、`IMAGE_PROVIDER_*`、`FAL_*`、`PROBE_*`、`OPENPHOTO_RELEASE_MISSING`） |
| 4  | 批次 `partially_failed`/`failed`（命令正常完成但结果非 succeeded） |
| 5  | checkpoint/不兼容/输出已存在/内部（`CHECKPOINT_*`、`BATCH_OUTPUT_EXISTS`、`BATCH_STATE_*` 等） |

stdout 仅单行 JSON：成功 `{ ok:true, result }`，错误 `{ ok:false, code, message }`。

### 安全与脱敏

- provider 身份只保存 `id`/`model`/`baseUrlFingerprint`（SHA256 规范化 host+path），不存完整 URL/API key/secret。
- `assetKeyFor` 只含 canonical request + policySource，不含密钥。
- `request.json` 本身不含 provider 凭据。

### 契约

- 批次请求/结果复用 `design-skill-contracts` 的 `batch-design-request.schema.json` 与
  `batch-design-result.schema.json`；素材策略用 `asset-policy.schema.json`。
- 内部检查点用本 package 的 `schemas/batch-checkpoint.schema.json`（`additionalProperties:false`，
  item/asset 状态机、error 结构、provider 脱敏身份）。

## 稳定错误

- 目录不存在、缺 `manifest.json`、`manifest.json` 非法 JSON、`SkillManifest` 校验失败、executor 失败，
  均被记录到 `unavailable` 或 `duplicates`，整体不崩溃。
- 重复 Skill ID：按规范化路径排序保留第一个，其余记录到 `duplicates`。

## 测试

```bash
npm test
# 等价于 node --test "tests/**/*.test.mjs"
```

## 目录结构

```text
packages/skill-orchestrator/
├─ package.json
├─ SKILL.md
├─ bin/
│  └─ design-batch.mjs          # 批量生产 CLI（run/resume/retry-failed）
├─ schemas/
│  └─ batch-checkpoint.schema.json   # 内部检查点 Schema
├─ runtime/
│  ├─ discovery.mjs             # Skill 发现器
│  ├─ matcher.mjs               # Capability 匹配器
│  ├─ research.mjs              # 研究信号包装配（C3）
│  ├─ guidance.mjs              # 软建议合并（C4）
│  ├─ runner.mjs                # 页面素材回填 runner（C5）
│  ├─ asset-policy.mjs          # 素材策略解析（usageSlot 匹配）
│  ├─ asset-store.mjs           # 素材缓存存储（canonicalize/assetKeyFor）
│  ├─ fingerprint.mjs           # 指纹与 provider 身份脱敏
│  ├─ checkpoint.mjs            # 检查点创建/校验/原子写/恢复
│  ├─ checkpoint-asset-store.mjs # checkpoint 支撑的素材存储
│  ├─ attempt-root.mjs          # attempt 目录与序号管理
│  ├─ batch-request.mjs         # 批次请求加载与校验
│  ├─ batch-runner.mjs         # 批次执行器（状态机/汇总）
│  ├─ publish-structure.mjs     # 四层交付发布层（终态自动发布）
│  └─ standard-bindings.mjs     # 标准批次运行时绑定
└─ tests/
   ├─ unit/
   │  ├─ discovery.test.mjs
   │  ├─ matcher.test.mjs
   │  ├─ research.test.mjs
   │  ├─ guidance.test.mjs
   │  ├─ asset-policy.test.mjs
   │  ├─ asset-store.test.mjs
   │  ├─ fingerprint.test.mjs
   │  ├─ checkpoint.test.mjs
   │  ├─ checkpoint-asset-store.test.mjs
   │  ├─ attempt-root.test.mjs
   │  ├─ batch-request.test.mjs
   │  ├─ batch-runner.test.mjs
   │  ├─ publish-structure.test.mjs
   │  └─ standard-bindings.test.mjs
   ├─ integration/
   │  ├─ vertical-chain.test.mjs
   │  └─ batch-resume.test.mjs
   ├─ cli/
   │  └─ design-batch.test.mjs
   └─ fixtures/
      ├─ cli-batch-request.json
      └─ skills/                # 发现器测试 fixture
```

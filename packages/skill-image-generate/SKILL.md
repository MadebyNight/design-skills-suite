# skill-image-generate

生图 Skill。接收结构化 `AssetRequest`，生成初始图片并输出 `AssetResult`。

> **范围约束**：本 package 只提供 `image.generate`，不负责裁切、缩放或页面编排。支持 fal.ai 与 OpenAI-compatible 图片 provider；固定 PNG provider 仅用于显式测试。

## 用户引导

用户询问用途或怎么使用时，说明本 Skill 根据用途、主题和目标尺寸生成初始图片，输出图片文件及真实尺寸等结果；不做页面组装或本地裁切。仅咨询时不探测 provider、不生成图片。

示例：“生成一张 1404×600 的夏日出游横幅素材，主体居中，两侧留出裁切空间。”由 Agent 将已知用途、尺寸、风格及可选参考图整理成 AssetRequest，仅询问影响结果的缺项。执行前说明 provider 和真实生图可能产生的费用，按会话授权执行；测试图片不能当作主题成果。交付时提供真实图片路径和尺寸，尺寸不符时说明是否仍需 OpenPhoto 适配。页面设计及自动回填交给页面 Skill 与编排器。套件流程见[使用指南](../../docs/usage/design-skills-user-guide.md#新用户使用流程)。

## 能力

- 提供能力 `image.generate`（ID 冻结于 `design-skill-contracts`）。
- 复用 `design-skill-contracts` 的 JSON Schema 与最小验证器做输入/输出校验，不复制 Schema。

## CLI

```bash
# 输出本 Skill 提供的能力清单
node bin/image-generate.mjs capabilities

# 从 JSON 文件读取 AssetRequest 并生图
node bin/image-generate.mjs request --file path/to/asset-request.json

# 从内联 JSON 读取 AssetRequest 并生图
node bin/image-generate.mjs request --json '{"id":"...", ...}'

# 探测 provider 可用性（默认只调 /models，不产生费用）
node bin/image-generate.mjs probe

# 强探测：实际生成一张最小图片并验证（产生费用）
node bin/image-generate.mjs probe --generate
```

### provider 选择

provider 按以下顺序选择：

1. 显式 `IMAGE_GENERATE_PROVIDER`：`test` 仅用于测试；`openai-compatible` 读取 `IMAGE_API_BASE_URL` / `IMAGE_API_KEY`；`fal` 读取 `FAL_KEY`（兼容 `IMAGE_GENERATE_API_KEY`）。
2. 未显式指定时，优先继承当前 Codex Agent：从 `CODEX_HOME/config.toml` 读取当前 `model_provider` 的 `base_url`，按其 `env_key`、bearer token 或 `requires_openai_auth` 声明取得当前登录认证。密钥只在内存中传给 provider，不写入请求、产物或日志。
3. Codex 配置不可用时，兼容既有 `FAL_KEY` / `IMAGE_GENERATE_API_KEY` 回退。

图片模型独立固定为 `IMAGE_API_MODEL`，缺省 `gpt-image-2`；不复用 Codex 当前文本模型。显式 provider 始终覆盖 Codex 自动继承。

`probe` 仍只支持显式 `IMAGE_GENERATE_PROVIDER=openai-compatible`。

## 稳定错误

- 未配置 provider 凭据时返回 `MISSING_API_KEY`。
- fal.ai 请求、输出解析和下载失败分别返回 `FAL_REQUEST_FAILED`、`FAL_OUTPUT_INVALID`、`FAL_DOWNLOAD_FAILED`。
- OpenAI-compatible provider 错误码前缀 `IMAGE_PROVIDER_*`：`CONFIG_MISSING`、`UNAUTHORIZED`、`NOT_FOUND`、`RATE_LIMITED`、`SERVER_ERROR`、`TIMEOUT`、`OUTPUT_INVALID`、`DOWNLOAD_FAILED`。错误对象可含 `status`/`requestId`/`retryable`/`outcomeUnknown`/`details`，但绝不包含 API key 或请求头。

## 真实元数据

输出 `AssetResult` 时计算并如实填写真实数据：

- `path`：产物文件相对本 package 的路径
- `mimeType`：按扩展名推断（`image/png` 等）
- `width` / `height`：从 PNG IHDR 解析的真实宽高
- `sha256`：文件字节的 SHA-256
- `strictSizeSatisfied`：真实宽高是否严格等于请求目标尺寸
- `notes`：记录 `provider` 与 `model`，以及尺寸不满足时的说明

## provider 注入

`runtime/generator.mjs` 的 `generateAsset(request, { provider })` 支持注入 provider。provider 需实现：

```js
async generate(request) => {
  bytes,            // Buffer，PNG 字节
  mimeType,         // 'image/png'
  providerRequestId,// string | null
  revisedPrompt,    // string | null
  responseMode,     // 'test' | 'url' | 'sdk' | 'b64_json'
}
```

generator 不接受裸 Buffer；provider 输出非法（非对象、bytes 非 Buffer、MIME 非
`image/png`、字段类型错误、responseMode 非法）时抛稳定 `ProviderOutputError`
（`code=INVALID_PROVIDER_OUTPUT`）。默认 `testProvider` 返回固定 2×1 PNG，`responseMode='test'`。

## 测试

```bash
npm test
# 等价于 node --test tests/
```

## 目录结构

```text
packages/skill-image-generate/
├─ package.json
├─ SKILL.md
├─ manifest.json
├─ bin/
│  └─ image-generate.mjs       # CLI
├─ runtime/
│  ├─ protocol.mjs             # 输入校验 + Schema 复用
│  ├─ generator.mjs            # 生图核心 + provider 注入
│  ├─ artifact-store.mjs       # 落盘 + 真实元数据计算
│  ├─ fal-provider.mjs         # fal.ai provider
│  ├─ openai-compatible-provider.mjs  # OpenAI-compatible provider
│  └─ provider-probe.mjs       # provider 探测
├─ references/                 # 参考文档
└─ tests/                      # node:test
```

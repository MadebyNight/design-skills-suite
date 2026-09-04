# 参考：provider 与测试策略

## 目标

使用固定输出的测试 provider 验证整条链路（校验 → 生成 → 落盘 → 元数据 → 输出 AssetResult）可工作；真实 provider 使用相同输出合同。

## provider 注入

`runtime/generator.mjs`：

```js
generateAsset(request, { provider })
```

- `provider.generate(request)` 返回统一对象：

```js
{
  bytes,             // Buffer，PNG 字节
  mimeType,          // 'image/png'
  providerRequestId, // string | null
  revisedPrompt,     // string | null
  responseMode,      // test | url | sdk | b64_json
}
```

- generator 不接受裸 Buffer；非法输出返回 `INVALID_PROVIDER_OUTPUT`
- 默认不注入 provider 时按“显式配置 → 当前 Codex Agent → FAL 兼容环境变量”解析真实 provider；全部不可用时抛 `MissingApiKeyError`

### testProvider

`runtime/generator.mjs` 内置：

```js
{
  name: 'test-provider',
  model: 'test-fixed-png',
  async generate() {
    return {
      bytes: Buffer.from(FIXED_PNG_BASE64, 'base64'), // 固定 2×1 多色 PNG
      mimeType: 'image/png',
      providerRequestId: null,
      revisedPrompt: null,
      responseMode: 'test',
    }
  }
}
```

固定 2×1 PNG 用于如实检验 `strictSizeSatisfied` 判定和 OpenPhoto cover/contain 像素行为：当请求目标尺寸非 2×1 时，真实尺寸与目标不一致，`strictSizeSatisfied=false`，`notes` 记录差异。

## 测试

`tests/` 下 node:test 测试：

- `protocol.test.mjs`：`normalizeAssetRequest` 的合法/非法输入，含稳定错误码
- `generator.test.mjs`：注入 testProvider 生成，断言真实 path/MIME/宽高/sha256/`strictSizeSatisfied`、provider metadata、裸 Buffer/错误 MIME/非 PNG 被拒且不落盘
- `cli.test.mjs`：CLI 子命令路径（capabilities、`--file`、`--json`、`probe`）
- `openai-compatible-provider.test.mjs`：mock fetch 覆盖 b64_json/url/401/403/404/429/5xx/timeout/空 data/非法 base64/下载失败/x-request-id/secret 不泄漏
- `provider-probe.test.mjs`：默认只调 `/models`，strong 才调用 generate

## OpenAI-compatible provider

`runtime/openai-compatible-provider.mjs`：

```js
createOpenAICompatibleProvider({ baseURL, apiKey, model, fetchImpl, timeoutMs, clientRequestIdFactory })
```

- 请求 `POST <baseURL>/images/generations`，body 只含 `model` + `prompt`；
- 请求头 `Authorization: Bearer <key>`、`Content-Type: application/json`、`X-Client-Request-Id`；
- 支持 `data[0].b64_json` 与 `data[0].url`；`providerRequestId` 优先 `x-request-id` 否则 client id；
- `revisedPrompt` 来自 `item.revised_prompt`；`responseMode` 为 `b64_json` 或 `url`；
- URL 下载使用独立 120s 超时；
- 错误码前缀 `IMAGE_PROVIDER_*`，错误对象可含 `status`/`requestId`/`retryable`/`outcomeUnknown`/`details`，不含 key/header。

## Provider 探测

`runtime/provider-probe.mjs`：

```js
probeProvider({ providerConfig, fetchImpl, strong, tempRoot })
```

- 默认 `GET <baseURL>/models`，不产生费用；
- 状态：`ready` / `degraded` / `unavailable` / `invalid`；
- 401/403 → `unavailable`；404/405 models 不支持 → `degraded`；模型未列出 → `degraded`；
- `strong=true` 才调用 `generate` 一个最小 prompt，验证统一对象与 PNG，返回 `width`/`height`/`sha256`/`latencyMs`，不落盘。

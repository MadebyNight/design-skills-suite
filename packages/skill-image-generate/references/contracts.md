# 参考：AssetRequest / AssetResult 契约

本 Skill 直接复用 `design-skill-contracts` 的 Schema 作为唯一真相源，不复制、不修改。以下为理解用的摘要。

## 输入：AssetRequest（`asset-request.schema.json`）

必填字段：`id`、`usageSlot`、`theme`、`targetWidth`、`targetHeight`、`aspectRatio`、`format`、`fit`、`safeArea`、`referenceImages`、`forbiddenContent`、`allowGenerate`、`allowEdit`。

关键约束：

- `targetWidth` / `targetHeight`：正整数（≥ 1）
- `fit`：`cover` | `contain`
- `format`：字符串（如 `png` / `jpg` / `webp`）
- `referenceImages`：`AssetResult[]`
- `additionalProperties: false`，不接受未声明字段

## 输出：AssetResult（`asset-result.schema.json`）

必填字段：`assetRequestId`、`artifactId`、`path`、`mimeType`、`width`、`height`、`sha256`、`sourceSkill`、`sourceSkillVersion`、`strictSizeSatisfied`、`notes`。

关键约束：

- `width` / `height`：整数 ≥ 1
- `sha256`：匹配 `^[a-f0-9]{64}$`
- `notes`：字符串数组
- `additionalProperties: false`

## 校验入口

`runtime/protocol.mjs` 通过 `Registry.fromDirectory(schemasDir)` 加载 `design-skill-contracts/schemas`，并调用其手写最小验证器（`scripts/validate.mjs` 的 `validate`）。

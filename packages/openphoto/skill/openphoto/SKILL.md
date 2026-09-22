---
name: openphoto
description: "Use for deterministic local image editing with OpenPhoto: inspect an image, crop or transform the canvas or an object, adjust image properties, apply supported filters, run automatic background removal/depth/detection/coordinate segmentation/upscale, and return PNG or JPEG artifacts. Ask the user before downloading a missing AI model."
---

# OpenPhoto

Run every command from this Skill's root directory (the directory containing `SKILL.md`).

## 用户引导

用户询问用途或怎么使用时，说明 OpenPhoto 可处理已有本地图片，例如检查、裁切、缩放与导出；具体可用操作以运行时能力清单为准。仅咨询时无需启动 CLI 或安装模型。

示例：“把指定的本地图片居中裁切为 1:1，缩放至 200×200 并导出 PNG。”执行需求至少包含文件路径和处理目标，由 Agent 整理请求，只补问影响结果的缺项。交付时提供实际导出文件路径、尺寸和格式。不要把图片处理描述为新图生成或页面发布；在 design-skills-suite 中，新图生成由 `skill-image-generate` 负责，页面素材自动回填由 `skill-orchestrator` 负责。独立安装 OpenPhoto 时不依赖这些套件 Skill。

## Install and Runtime Prerequisites

1. Place this complete Skill directory in a Skills directory recognized by the host Agent. If that host discovers Skills only at session startup, restart it or open a new session after installation.
2. After the user allows dependency installation, run `npm ci --omit=dev` from the Skill root.
3. Use Node >=22 and an installed system Chrome or Edge. Set `OPENPHOTO_BROWSER_PATH` when the browser is not in a default location.
4. Ensure `LOCALAPPDATA` or `OPENPHOTO_DATA_DIR` points to a writable location.
5. Do not start a separate daemon, MCP server, or workspace-root script. The CLI starts its local daemon on demand.
6. `agents/openai.yaml` is optional host UI metadata; the core CLI and JSON workflow is host-independent.

## Start

1. Discover the runtime surface before choosing an operation:

   ```powershell
   node bin/openphoto.mjs capabilities
   ```

2. Send one JSON request at a time. Prefer saving it as `request.json`, then run:

   ```powershell
   node bin/openphoto.mjs request --file request.json
   ```

   For a single inline request, run:

   ```powershell
   node bin/openphoto.mjs request --json '<single JSON request object>'
   ```

Every request needs `protocol: "openphoto/v1"`, a non-empty `requestId`, an operation name, and a plain-object `payload`. Do not invoke operations outside the returned capability list.

## Workflows

- For ordinary edits, use `artifact.import` → `document.open` → `document.inspect` → `document.mutate` or `document.renderArtifact` → `artifact.read` → `document.close`. Before every mutation, render, or artifact application, inspect the document and pass its current revision as `expectedRevision`.
- For AI work, start with `ai.analyze.start`. If it returns `MODEL_DOWNLOAD_REQUIRED`, explain the model name, source, size, license, and cache location; ask for clear user approval before calling `model.install`. Poll `model.status` with the returned `installId`, then poll `ai.job.get`. Inspect again before applying a completed raster result. Apply only `kind: "raster"` results through `document.applyArtifact`; report `kind: "json"` detection results without applying them.
- Call `model.install.cancel` only when the user explicitly withdraws the shared download, because it cancels that installation for every waiting job in the current daemon session.

Read `references/protocol.md` for executable ordinary and AI workflows. Read `references/capabilities.md` for supported mutation command parameters.

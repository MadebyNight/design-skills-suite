# 设计 Skill 使用指南

## 新用户使用流程

本套件把活动需求转换为受控页面视觉方案，主要减少素材生成、图片适配、原型组装和多页交付中的重复工作。产物用于设计评审和运营交接，不是可直接发布的小程序页面。

### 先选择任务

首页设计使用 `skill-alipay-home`；活动落地页使用 `skill-alipay-landing`；只生成图片使用 `skill-image-generate`；处理已有图片使用 OpenPhoto。需要自动生成并回填页面素材、批量执行、失败恢复或首页—落地页离线联动时，使用 `skill-orchestrator`，其中批次也可以只有一页。

### 用自然语言开始

先完成下方环境准备，再让能访问本仓库的 Agent 读取对应 package 的 `SKILL.md`。不依赖宿主自动发现这些仓库目录，也不要求普通用户手写 JSON。例如：

- 首页：读本仓库首页 Skill，设计一个夏日出游首页，面向年轻租赁用户，清爽蓝色风格。
- 落地页：读本仓库落地页 Skill，设计一个开学季活动落地页，绿色清新风格。
- 联合任务：读本仓库编排 Skill，设计一个首页和两个落地页，分别是开学季与演唱会主题，自动生成并回填素材，支持离线预览跳转。
- 单独生图：读本仓库生图 Skill，生成一张 1404×600 的夏日出游横幅素材，主体居中，两侧留出裁切空间。
- 图片处理：读本仓库 OpenPhoto Skill，把我指定的本地图片居中裁切为 1:1，缩放至 200×200 并导出 PNG。
- 只了解功能：介绍这个套件能做什么、我该选哪个 Skill，暂时不要执行。

页面任务至少需要页面类型、主题和数量；受众、品牌色、文案、参考图和输出位置可按需补充。图片生成需明确用途和目标尺寸；本地图片处理需提供文件路径和处理目标。Agent 从上下文提取已知信息，只询问会影响结果的缺项，不把完整 Schema 当作用户问卷。

自然语言由 Agent 整理成 `DesignBrief`、`AssetRequest` 或批次请求，并按各 Skill 合同校验和调用 CLI；这些 CLI 不自行理解自然语言。涉及真实生图前说明所用 provider 和可能的费用，按当前会话授权执行。`test` provider 的固定测试图片只能验证流程，不能作为主题设计成果。

### 查看与继续

1. 打开结果返回的批次 `index.html`，或单页设计包的 `prototype.html`，先检查整体视觉。只有启用截图时才有 `prototype.png`。
2. 查看 `configuration-guide.md`，了解配置建议及仍需业务系统补齐的资源。`assets/` 保存本次交付的素材。
3. 结合状态与校验报告判断是否完成：`completed_with_pending_assets` 表示仍有素材待生成或回填；组件快照预览不代表素材已完成。单独页面 CLI 不自动执行完整生图链路，需要编排器处理。
4. 对成果提出具体修改，例如主题、文案或素材方向，并指出页面；新设计使用新的输出目录。已有批次中断时用 `resume`，失败项用 `retry-failed`，它们不用于替换设计需求。

真实商品、优惠券、生产路由、素材上传和发布由业务系统负责。离线预览、截图和校验通过均不代表真机验收或生产发布完成。

命令行使用者可运行 `npm run batch -- --help` 查看批量入口，成功返回单行 JSON，其中 `result.usage` 为命令说明；详细输入字段见对应 package 的 SKILL.md。

## 首次环境准备

需要 Windows、Node.js >=22 和 npm。截图需要 Playwright Chromium，OpenPhoto 需要系统 Chrome 或 Edge。安装会下载依赖与浏览器，OpenPhoto 构建会写入本地 dist 目录。

在仓库根目录执行：

```powershell
npm run install:all
npx playwright install chromium
npm run build:openphoto
```

真实生图的 provider 配置见[生图 Skill](../../packages/skill-image-generate/SKILL.md)。任务执行、输入字段和恢复命令见[编排器 Skill](../../packages/skill-orchestrator/SKILL.md)。

## 独立使用入口

- [首页设计](../../packages/skill-alipay-home/SKILL.md)
- [落地页设计](../../packages/skill-alipay-landing/SKILL.md)
- [生图](../../packages/skill-image-generate/SKILL.md)
- [OpenPhoto 图片处理](../../packages/openphoto/skill/openphoto/SKILL.md)

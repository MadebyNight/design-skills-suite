// 3C.3：标准批次运行时绑定。
//
// 职责：把批次 item 映射到 runDesign 的完整绑定（页面 Skill、生图 provider、图片适配 adapter），
// 并派生 provider 身份（脱敏）与 skillRoots。业务仍由 runDesign 执行。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { designHome } from '../../skill-alipay-home/bin/home-design.mjs'
import { designLanding } from '../../skill-alipay-landing/bin/landing-design.mjs'
import { generateAsset, resolveProvider } from '../../skill-image-generate/runtime/generator.mjs'
import { createOpenPhotoAdapterBinding } from '../scripts/image-edit-adapter.mjs'
import { runDesign } from './runner.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = path.resolve(__dirname, '..')
const DEFAULT_REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..')

const PAGE_CAPABILITIES = {
  'alipay.home': 'page.alipay.home.design',
  'alipay.landing': 'page.alipay.landing.design',
}

// runner 合同：provider 声明此能力才接收非空 referenceImages；未声明时 runner
// 清空参考图、记录 warning，并继续仅以文字约束生成。
// standard-bindings 不为任何 provider 虚假声明此能力：内置真实 provider
//（fal.ai / openai-compatible）的请求体只发送 prompt，不消费参考图。需要验证
// 参考图注入链路的测试应
// 注入明确声明该能力的 mock capability/provider。
export const REFERENCE_IMAGE_CAPABILITY = 'asset.reference-images'

/**
 * 按 provider 真实实现声明参考图能力：内置真实 provider 一律不声明。
 * 不按 provider 名字给任何桩/测试 provider 虚假声明支持；需要验证参考图
 * 注入的测试使用明确 mock 的 capability/provider。
 */
function referenceImageCapabilitiesFor() {
  return []
}

/** 根据 provider 对象派生脱敏身份（不含 secret）。 */
function providerIdentityFor(provider) {
  if (provider.name === 'test-provider') {
    return { id: 'test-provider', model: 'test-fixed-png', baseURL: 'test://local' }
  }
  if (provider.name === 'fal.ai') {
    return { id: 'fal.ai', model: provider.model, baseURL: 'https://fal.ai' }
  }
  if (provider.name === 'openai-compatible') {
    return { id: 'openai-compatible', model: provider.model, baseURL: provider.baseURL }
  }
  return { id: provider.name, model: provider.model, baseURL: provider.baseURL || '' }
}

/**
 * 创建标准批次运行时。
 * @param {object} opts
 * @param {string} [opts.repoRoot] 仓库根目录，缺省自动推导
 * @param {object} [opts.env] 环境变量，用于 resolveProvider
 * @param {boolean} [opts.screenshot] 页面是否截图
 * @param {Function} [opts.searchBinding] research.search binding，缺省不注入
 * @param {string} [opts.openphotoRoot] OpenPhoto 根目录
 * @param {object} [opts.provider] 注入的 provider（测试用），缺省 resolveProvider(env)
 * @param {Function} [opts.runDesignImpl] 注入的 runDesign 实现（测试用），缺省真实 runDesign
 * @returns {{ providerIdentity, skillRoots, runItem, close }}
 */
export function createStandardBatchRuntime({ repoRoot, env = process.env, screenshot = false, searchBinding, openphotoRoot, provider, runDesignImpl } = {}) {
  const root = repoRoot ? path.resolve(repoRoot) : DEFAULT_REPO_ROOT
  const homeRoot = path.join(root, 'packages', 'skill-alipay-home')
  const landingRoot = path.join(root, 'packages', 'skill-alipay-landing')
  const imageRoot = path.join(root, 'packages', 'skill-image-generate')
  // OpenPhoto 根：opts.openphotoRoot > env.OPENPHOTO_SKILL_ROOT > 默认；manifest 延迟到 runItem 读取。
  const openRoot = openphotoRoot
    ? path.resolve(openphotoRoot)
    : (env.OPENPHOTO_SKILL_ROOT
      ? path.resolve(env.OPENPHOTO_SKILL_ROOT)
      : path.join(root, 'packages', 'openphoto', 'dist', 'openphoto'))
  const catalogDir = path.join(root, 'packages', 'skill-alipay-pages', 'catalog')
  const imageSourceRoot = path.join(root, 'packages', 'skill-image-generate')

  const resolvedProvider = provider || resolveProvider(env)
  const identity = providerIdentityFor(resolvedProvider)
  const runDesignFn = runDesignImpl || runDesign
  const skillRoots = [homeRoot, landingRoot, imageRoot, openRoot]

  const catalogCache = {}
  function catalogFor(type) {
    const file = type === 'alipay.home' ? 'home.catalog.json' : 'landing.catalog.json'
    if (!catalogCache[file]) {
      catalogCache[file] = JSON.parse(fs.readFileSync(path.join(catalogDir, file), 'utf8'))
    }
    return catalogCache[file]
  }

  async function runItem({ item, attemptRoot, assetStore, itemFingerprint, linkage }) {
    const brief = item.brief
    const pageCapability = PAGE_CAPABILITIES[brief.deliverableType]
    const pageFn = brief.deliverableType === 'alipay.home' ? designHome : designLanding
    // 页面联动（可选）：landing context 注入 landingKey/theme；home context 注入
    // homeTheme/landingThemes（含成功落地页预览 ref）。页面 Skill 尚未声明这些可选
    // 参数时忽略之（forward-compatible）；无 linkage 时保持既有单参调用。
    const pageOptions = { screenshot }
    if (linkage?.role === 'landing') {
      pageOptions.landingKey = linkage.landingKey
      pageOptions.theme = linkage.theme
    } else if (linkage?.role === 'home') {
      pageOptions.homeTheme = linkage.homeTheme
      pageOptions.landingThemes = linkage.landingThemes
    }
    const bindings = {
      // 页面 binding：编排器二次回填的已验收素材经 ctx.completedAssets（内部
      // 参数）透传给 designHome/designLanding；brief 原样传入（原始
      // inputArtifacts 仅作参考图候选）。
      [pageCapability]: Object.assign(
        (b, { outputRoot, completedAssets, failedAssets, researchPack }) =>
          pageFn({ brief: b, outputRoot, ...pageOptions, researchPack, ...(completedAssets ? { completedAssets } : {}), ...(failedAssets ? { failedAssets } : {}) }),
        { acceptsFailedAssets: true },
      ),
      // 绑定函数携带 provider 能力声明：runner 据此判断参考图请求能否路由到该
      // provider。standard-bindings 按真实 provider 实现声明：内置真实 provider
      // 均不消费参考图，一律不声明；runner 会回退为文字约束生成。
      'image.generate': Object.assign(
        (request, { artifactRoot }) => generateAsset(request, { provider: resolvedProvider, artifactRoot }),
        { capabilities: referenceImageCapabilitiesFor() },
      ),
    }
    // 图片适配 adapter：仅当 OpenPhoto 已发布（manifest 存在）时注入；全 reuse 不需要 adapter。
    const openManifest = path.join(openRoot, 'manifest.json')
    if (fs.existsSync(openManifest)) {
      bindings.imageAdapter = createOpenPhotoAdapterBinding({
        openphotoRoot: openRoot,
        dataRoot: path.join(attemptRoot, 'openphoto-data'),
        sourceRoot: imageSourceRoot,
      })
    }
    if (searchBinding) bindings['research.search'] = searchBinding

    return runDesignFn({
      brief,
      skillRoots,
      outputRoot: attemptRoot,
      bindings,
      catalog: catalogFor(brief.deliverableType),
      assetPolicy: item.assetPolicy,
      assetStore,
      itemFingerprint,
    })
  }

  return {
    providerIdentity: identity,
    skillRoots,
    runItem,
    // adapter 由 runDesign 每 item 关闭，无需全局 close。
    close: async () => {},
  }
}

export default createStandardBatchRuntime

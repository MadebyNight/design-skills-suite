// 3C.1：checkpoint 支撑的素材存储。
//
// 职责：实现 runDesign 的 assetStore 接口（get/put/invalidate），但条目持久化到
// checkpoint 对应 item 的 assets，并在每次更新时 touch updatedAt + 原子写 checkpoint。
// 校验逻辑复用 createAssetStore（文件落盘/hash/Schema/尺寸），不复制 AssetResult 校验。
import path from 'node:path'
import { createAssetStore } from './asset-store.mjs'
import { writeCheckpointAtomic, touchCheckpoint } from './checkpoint.mjs'

/**
 * 创建 checkpoint 支撑的素材存储。
 * @param {object} opts
 * @param {string} opts.checkpointRoot 批次根目录（checkpoint.json 所在目录）
 * @param {Function} opts.getState 返回当前 checkpoint 状态
 * @param {Function} opts.setState 更新 checkpoint 状态
 * @param {string} [opts.sourceRoot] 相对 AssetResult.path 的解析根目录
 * @param {string} opts.itemId 当前 itemId
 * @param {string} [opts.itemFingerprint] item 指纹（信息性）
 * @param {Function} [opts.now] 可注入时间函数
 * @returns {{ get, put, invalidate }}
 */
export function createCheckpointAssetStore({ checkpointRoot, getState, setState, sourceRoot, itemId, itemFingerprint, now }) {
  const nowFn = now || (() => new Date())

  // 从 checkpoint 对应 item 的 assets 种子化内部校验存储。
  const seedEntries = {}
  const item = getState().items.find((i) => i.itemId === itemId)
  for (const asset of item?.assets || []) {
    seedEntries[asset.assetKey] = { status: asset.status, result: asset.result }
  }
  const internal = createAssetStore({ entries: seedEntries, sourceRoot })

  function currentItem() {
    return getState().items.find((i) => i.itemId === itemId)
  }

  /** 更新 checkpoint 中该 item 的某个 asset 条目（不存在则新增），touch + 原子写。 */
  function updateAsset(assetKey, patch) {
    const state = getState()
    const items = state.items.map((i) => {
      if (i.itemId !== itemId) return i
      const existing = (i.assets || []).find((a) => a.assetKey === assetKey)
      const assets = existing
        ? (i.assets || []).map((a) => (a.assetKey === assetKey ? { ...a, ...patch } : a))
        : [...(i.assets || []), { assetKey, status: 'pending', result: null, error: null, ...patch }]
      return { ...i, assets }
    })
    const next = { ...state, items }
    const touched = touchCheckpoint(next, nowFn)
    setState(touched)
    return writeCheckpointAtomic(checkpointRoot, touched)
  }

  /**
   * 读取缓存。条目不存在返回 null；校验失败更新为 invalidated 并返回 null。
   * @param {string} assetKey
   * @param {object} [opts.request]
   * @returns {Promise<object|null>}
   */
  async function get(assetKey, { request } = {}) {
    const entry = currentItem()?.assets?.find((a) => a.assetKey === assetKey)
    if (!entry) return null
    const result = await internal.get(assetKey, { request })
    if (result === null) {
      await updateAsset(assetKey, { status: 'invalidated' })
      return null
    }
    return result
  }

  /**
   * 写入缓存。严格校验（复用 createAssetStore），失败抛错且不更新 checkpoint。
   * 成功后更新 asset 条目为 succeeded 并原子写 checkpoint。
   * @param {string} assetKey
   * @param {object} result AssetResult
   * @param {object} [opts.request]
   * @returns {Promise<string>}
   */
  async function put(assetKey, result, { request } = {}) {
    await internal.put(assetKey, result, { request }) // 校验失败抛错
    await updateAsset(assetKey, { status: 'succeeded', result: structuredClone(result) })
    return assetKey
  }

  /**
   * 使缓存失效并更新 checkpoint 为 invalidated。
   * @param {string} assetKey
   * @returns {Promise<boolean>}
   */
  async function invalidate(assetKey) {
    await updateAsset(assetKey, { status: 'invalidated' })
    return true
  }

  return { get, put, invalidate }
}

export default createCheckpointAssetStore

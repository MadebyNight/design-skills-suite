// 批次运行时根目录约定。
//
// 公开 batchRoot 顶层最终只允许 index.html / assets/ / configs/ / other/ 四项；
// 全部运行时状态（request.json、checkpoint*.json、result.json、
// items/<itemId>/attempts/<000N>/）物理置于 <batchRoot>/other/runtime/ 之下，
// 由 run/resume/retry-failed/CLI 统一经 runtimeRootFor 读写；发布层不再复制
// 运行时文件（它们已在正确位置）。
import path from 'node:path'

/** 批次根目录下运行时状态的固定相对路径段。 */
export const RUNTIME_SUBPATH = ['other', 'runtime']

/**
 * 返回批次根目录对应的运行时状态根（绝对路径）。
 * @param {string} batchRoot 批次根目录
 * @returns {string} <batchRoot>/other/runtime 绝对路径
 */
export function runtimeRootFor(batchRoot) {
  return path.join(path.resolve(batchRoot), ...RUNTIME_SUBPATH)
}

export default runtimeRootFor
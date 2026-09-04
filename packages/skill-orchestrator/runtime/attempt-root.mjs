// 3B：attempt 根目录管理。
//
// 职责：为批次内每个 item 的每次 attempt 分配稳定目录，并计算下一次 attempt 序号。
// attempts 物理位于批次运行时根（<batchRoot>/other/runtime/）之下的
// items/<itemId>/attempts/<000N>，公开 batchRoot 顶层不出现 items/。
// 边界：只做目录路径与序号计算，不执行业务。
import fs from 'node:fs'
import path from 'node:path'
import { runtimeRootFor } from './runtime-root.mjs'

/** itemId 是否安全：仅允许字母数字、下划线、连字符、点，且非空。 */
export function isSafeItemId(itemId) {
  return typeof itemId === 'string' && itemId.length > 0 && /^[A-Za-z0-9._-]+$/.test(itemId)
}

/**
 * 计算 item 的下一次 attempt 序号：已有 attempt 目录的最大序号 + 1。
 * @param {string} batchRoot 批次根目录
 * @param {string} itemId
 * @returns {number} 下一次 attempt 序号（>=1）
 */
export function nextAttempt(batchRoot, itemId) {
  if (!isSafeItemId(itemId)) throw new Error(`itemId 非法：${itemId}`)
  const attemptsDir = path.join(runtimeRootFor(batchRoot), 'items', itemId, 'attempts')
  if (!fs.existsSync(attemptsDir)) return 1
  let max = 0
  for (const entry of fs.readdirSync(attemptsDir)) {
    const match = /^(\d{4})$/.exec(entry)
    if (match) {
      const n = Number(match[1])
      if (n > max) max = n
    }
  }
  return max + 1
}

/**
 * 创建 item 的 attempt 根目录：items/<id>/attempts/<0001>（运行时根之下）。
 * 已存在同名 attempt 目录时拒绝覆盖（抛错）。
 * @param {string} batchRoot 批次根目录
 * @param {string} itemId
 * @param {number} attempt attempt 序号（>=1）
 * @returns {string} 创建的 attempt 根目录绝对路径
 */
export function createAttemptRoot(batchRoot, itemId, attempt) {
  if (!isSafeItemId(itemId)) throw new Error(`itemId 非法：${itemId}`)
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error(`attempt 必须 >=1，实际 ${attempt}`)
  const dir = path.join(runtimeRootFor(batchRoot), 'items', itemId, 'attempts', String(attempt).padStart(4, '0'))
  if (fs.existsSync(dir)) {
    throw new Error(`attempt 目录已存在，拒绝覆盖：${dir}`)
  }
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export default { createAttemptRoot, nextAttempt, isSafeItemId }
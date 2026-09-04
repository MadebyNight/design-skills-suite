// 产物存储层：把生成的字节写入磁盘，并计算真实 path / MIME / 宽高 / sha256 / 严格尺寸满足度。
//
// 边界：本层只负责落地与元数据计算，不决定图片内容（内容由 generator 决定）。
// 本层只接受 image/png 且扩展名为 .png 的产物；任何不匹配都在写文件之前拒绝，
// 失败不产生文件。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const PACKAGE_ROOT = path.resolve(__dirname, '..')

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** 产物不受支持时的稳定错误。 */
export class UnsupportedProviderOutputError extends Error {
  constructor(message, details = []) {
    super(message)
    this.code = 'UNSUPPORTED_PROVIDER_OUTPUT'
    this.details = details
  }
}

/**
 * 校验字节为合法 PNG 并解析 IHDR 真实宽高。
 * 要求：PNG 签名正确、至少 24 字节、IHDR 宽高 > 0。
 * 校验失败抛 UnsupportedProviderOutputError。
 * @param {Buffer} buf
 * @returns {{ width: number, height: number }}
 */
export function readPngDimensions(buf) {
  if (!Buffer.isBuffer(buf)) {
    throw new UnsupportedProviderOutputError('产物字节必须是 Buffer')
  }
  if (buf.length < 24) {
    throw new UnsupportedProviderOutputError('产物字节不足 24 字节，不是合法 PNG')
  }
  for (let i = 0; i < 8; i += 1) {
    if (buf[i] !== PNG_SIGNATURE[i]) {
      throw new UnsupportedProviderOutputError('产物字节缺少 PNG 签名')
    }
  }
  // IHDR 数据从偏移 16 起：前 4 字节宽度（大端）、4 字节高度
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new UnsupportedProviderOutputError('PNG IHDR 宽高必须为正整数')
  }
  return { width, height }
}

/**
 * 将字节写入产物目录，并返回含真实元数据的文件信息。
 * 只接受 image/png 且 fileName 以 .png 结尾；校验全部通过后才写文件，失败不产生文件。
 * @param {Buffer} bytes
 * @param {object} opts { fileName, mimeType, targetWidth, targetHeight, artifactRoot? }
 */
export function writeArtifact(bytes, { fileName, mimeType, targetWidth, targetHeight, artifactRoot }) {
  if (mimeType !== 'image/png') {
    throw new UnsupportedProviderOutputError(`不支持的 MIME 类型: ${mimeType}`, ['仅支持 image/png'])
  }
  if (typeof fileName !== 'string' || !fileName.toLowerCase().endsWith('.png')) {
    throw new UnsupportedProviderOutputError(`不支持的产物文件名: ${fileName}`, ['仅支持 .png 扩展名'])
  }
  // 在写文件之前校验 PNG 字节，失败不产生文件。
  const { width, height } = readPngDimensions(bytes)

  const outDir = artifactRoot ? path.resolve(artifactRoot) : path.join(PACKAGE_ROOT, 'artifacts')
  fs.mkdirSync(outDir, { recursive: true })

  const filePath = path.join(outDir, fileName)
  fs.writeFileSync(filePath, bytes)

  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex')

  return {
    // 默认路径保持 CLI 的既有相对引用；隔离根使用绝对路径，供下游直接消费。
    path: artifactRoot ? filePath : `artifacts/${fileName}`,
    mimeType,
    width,
    height,
    sha256,
    strictSizeSatisfied: width === targetWidth && height === targetHeight,
  }
}

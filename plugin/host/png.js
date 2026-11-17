/**
 * 最小 PNG 解码/编码：只为了把整屏截图裁成「和 UI 树一致的那块」。
 *
 * 为什么要裁：截图是整屏（含底部系统导航栏），UI 树只覆盖前台窗口。两者原点相同、
 * 高度不同，模型按截图比例推算坐标时，底部多出来的那一截会把位置带偏。
 *
 * 只支持 Android/桌面截图常见的 8bit、非隔行 PNG（colorType 0/2/4/6）。
 * 遇到别的格式直接抛错，调用方退回「原图 + offset」，绝不能静默给错图。
 */
import { deflateSync, inflateSync } from 'node:zlib'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 }

let crcTable = null

function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Int32Array(256)
    for (let n = 0; n < 256; n += 1) {
      let value = n
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
      }
      crcTable[n] = value
    }
  }
  let crc = -1
  for (let index = 0; index < buffer.length; index += 1) {
    crc = crcTable[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ -1) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

export function isPng(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 24 && buffer.subarray(0, 8).equals(SIGNATURE)
}

/** 只读 IHDR：宽高、位深、颜色类型、隔行标志。 */
export function readPngHeader(buffer) {
  if (!isPng(buffer)) return null
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bitDepth: buffer[24],
    colorType: buffer[25],
    interlace: buffer[28],
  }
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

/** 收集 IDAT，解压后按行反滤波，得到原始像素。 */
export function decodePng(buffer) {
  const header = readPngHeader(buffer)
  if (!header) throw new Error('不是 PNG')
  const channels = CHANNELS[header.colorType]
  if (!channels) throw new Error(`不支持的 PNG 颜色类型 ${header.colorType}`)
  if (header.bitDepth !== 8) throw new Error(`不支持的 PNG 位深 ${header.bitDepth}`)
  if (header.interlace !== 0) throw new Error('不支持隔行 PNG')

  const parts = []
  let offset = 8
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii')
    const start = offset + 8
    const end = start + length
    if (end > buffer.length) throw new Error('PNG 数据被截断')
    if (type === 'IDAT') parts.push(buffer.subarray(start, end))
    if (type === 'IEND') break
    offset = end + 4
  }
  if (parts.length === 0) throw new Error('PNG 没有 IDAT')

  const raw = inflateSync(Buffer.concat(parts))
  const { width, height } = header
  const stride = width * channels
  if (raw.length < (stride + 1) * height) throw new Error('PNG 像素数据不完整')

  const pixels = Buffer.alloc(stride * height)
  let cursor = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor]
    cursor += 1
    const source = raw.subarray(cursor, cursor + stride)
    cursor += stride
    const target = pixels.subarray(y * stride, (y + 1) * stride)
    const previous = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null
    for (let index = 0; index < stride; index += 1) {
      const value = source[index]
      const left = index >= channels ? target[index - channels] : 0
      const up = previous ? previous[index] : 0
      const upLeft = previous && index >= channels ? previous[index - channels] : 0
      switch (filter) {
        case 0:
          target[index] = value
          break
        case 1:
          target[index] = (value + left) & 0xff
          break
        case 2:
          target[index] = (value + up) & 0xff
          break
        case 3:
          target[index] = (value + ((left + up) >> 1)) & 0xff
          break
        case 4:
          target[index] = (value + paeth(left, up, upLeft)) & 0xff
          break
        default:
          throw new Error(`不支持的 PNG 行过滤器 ${filter}`)
      }
    }
  }
  return { ...header, channels, pixels }
}

/** 用最简单的「每行 filter=0」重新编码，截图本来就大，压缩率不是重点。 */
export function encodePng({ width, height, channels, pixels }) {
  const colorType = channels === 4 ? 6 : channels === 3 ? 2 : channels === 2 ? 4 : 0
  const stride = width * channels
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = colorType
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * 裁一块出来。rect 用屏幕绝对坐标（和 UI 树同一套），超出图片的部分会贴边裁掉；
 * 裁没了就直接报错——空图会让上层以为「界面上什么都没有」。
 */
export function cropPng(buffer, rect) {
  const image = decodePng(buffer)
  const left = Math.max(0, Math.round(rect.x ?? 0))
  const top = Math.max(0, Math.round(rect.y ?? 0))
  const right = Math.min(image.width, left + Math.round(rect.width ?? image.width))
  const bottom = Math.min(image.height, top + Math.round(rect.height ?? image.height))
  const width = right - left
  const height = bottom - top
  if (width <= 0 || height <= 0) {
    throw new Error(
      `裁切区域 ${JSON.stringify(rect)} 落在图片 ${image.width}×${image.height} 之外，裁出来是空图。`,
    )
  }
  const { channels } = image
  const sourceStride = image.width * channels
  const targetStride = width * channels
  const pixels = Buffer.alloc(targetStride * height)
  for (let y = 0; y < height; y += 1) {
    const from = (top + y) * sourceStride + left * channels
    image.pixels.copy(pixels, y * targetStride, from, from + targetStride)
  }
  return encodePng({ width, height, channels, pixels })
}
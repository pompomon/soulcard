#!/usr/bin/env node
// Packs the indexed PNG components in art/tarot-pixel/ into the generated
// src/presentation/themes/tarot-pixel-sprites.js module. Node built-ins only.
//
// Usage: node tools/card-art/pack-pixel.mjs [--check]
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, gzipSync, inflateSync } from 'node:zlib'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const PIXEL_SOURCE_DIR = path.join(REPO_ROOT, 'art/tarot-pixel')
export const PIXEL_MODULE_PATH = path.join(
  REPO_ROOT,
  'src/presentation/themes/tarot-pixel-sprites.js',
)
export const MAX_PALETTE_COLORS = 32
export const TRANSPARENT_KEY = '.'

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const COLOR_TYPE_INDEXED = 3
const COLOR_TYPE_RGBA = 6
const KEY_PATTERN = /^[A-Za-z]$/
const HEX_PATTERN = /^#[0-9a-f]{6}$/
const SUITS = ['cups', 'pentacles', 'wands', 'swords']
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A']
const ART_WINDOW = Object.freeze({ maxWidth: 41, maxHeight: 79 })

const exact = (width, height) => Object.freeze({ width, height })

// Every component and its size. Figures may be smaller than the art window.
export const PIXEL_COMPONENTS = Object.freeze(Object.fromEntries([
  ['frame', exact(75, 105)],
  ['back', exact(75, 105)],
  ...RANKS.map((rank) => [`rank-${rank}`, exact(rank === '10' ? 7 : 5, 7)]),
  ...['S', 'H', 'D', 'C'].map((suit) => [`suit-${suit}`, exact(7, 7)]),
  ['numeral-I', exact(3, 5)],
  ['numeral-V', exact(5, 5)],
  ['numeral-X', exact(5, 5)],
  ['cartouche-sun', exact(5, 5)],
  ['title-page', exact(15, 5)],
  ['title-queen', exact(20, 5)],
  ['title-king', exact(16, 5)],
  ...SUITS.map((suit) => [`pip-${suit}`, exact(9, 9)]),
  ...SUITS.map((suit) => [`ace-${suit}`, ART_WINDOW]),
  ...['page', 'queen', 'king'].flatMap(
    (figure) => SUITS.map((suit) => [`${figure}-${suit}`, ART_WINDOW]),
  ),
]))

function fail(name, message) {
  throw new Error(`${name}: ${message}`)
}

export function readPalette(json, name = 'palette.json') {
  const palette = JSON.parse(json)
  if (palette?.transparent !== TRANSPARENT_KEY || !Array.isArray(palette.colors)) {
    fail(name, `expected { transparent: '${TRANSPARENT_KEY}', colors: [...] }`)
  }
  if (palette.colors.length === 0 || palette.colors.length > MAX_PALETTE_COLORS) {
    fail(name, `expected 1 to ${MAX_PALETTE_COLORS} colours plus transparency`)
  }
  const keys = new Set()
  const hexes = new Map()
  for (const { key, hex } of palette.colors) {
    if (!KEY_PATTERN.test(key) || keys.has(key)) fail(name, `invalid or duplicate key ${key}`)
    if (!HEX_PATTERN.test(hex) || hexes.has(hex)) fail(name, `invalid or duplicate colour ${hex}`)
    keys.add(key)
    hexes.set(hex, key)
  }
  return Object.freeze({
    colors: Object.freeze(palette.colors.map(({ key, hex }) => Object.freeze({ key, hex }))),
    keyByHex: hexes,
  })
}

function paethPredictor(left, above, upperLeft) {
  const estimate = left + above - upperLeft
  const toLeft = Math.abs(estimate - left)
  const toAbove = Math.abs(estimate - above)
  const toUpperLeft = Math.abs(estimate - upperLeft)
  if (toLeft <= toAbove && toLeft <= toUpperLeft) return left
  return toAbove <= toUpperLeft ? above : upperLeft
}

function unfilter(raw, width, height, bytesPerPixel, name) {
  const stride = width * bytesPerPixel
  if (raw.length !== (stride + 1) * height) fail(name, 'image data has the wrong length')
  const pixels = new Uint8Array(stride * height)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const source = y * (stride + 1) + 1
    const row = y * stride
    for (let x = 0; x < stride; x += 1) {
      const value = raw[source + x]
      const left = x >= bytesPerPixel ? pixels[row + x - bytesPerPixel] : 0
      const above = y > 0 ? pixels[row - stride + x] : 0
      const upperLeft = y > 0 && x >= bytesPerPixel ? pixels[row - stride + x - bytesPerPixel] : 0
      let predicted
      if (filter === 0) predicted = 0
      else if (filter === 1) predicted = left
      else if (filter === 2) predicted = above
      else if (filter === 3) predicted = (left + above) >> 1
      else if (filter === 4) predicted = paethPredictor(left, above, upperLeft)
      else fail(name, `unknown PNG filter ${filter}`)
      pixels[row + x] = (value + predicted) & 0xff
    }
  }
  return pixels
}

// Decodes a non-interlaced 8-bit indexed or RGBA PNG into RGBA pixels.
export function decodePng(buffer, name = 'image') {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    fail(name, 'not a PNG file')
  }
  let header = null
  let palette = null
  let transparency = null
  let ended = false
  const data = []
  for (let offset = 8; offset < buffer.length && !ended;) {
    if (offset + 12 > buffer.length) fail(name, 'truncated chunk')
    const length = buffer.readUInt32BE(offset)
    const end = offset + 12 + length
    if (end > buffer.length) fail(name, 'truncated chunk')
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    const body = buffer.subarray(offset + 8, offset + 8 + length)
    if (crc32(buffer.subarray(offset + 4, offset + 8 + length)) !== buffer.readUInt32BE(end - 4)) {
      fail(name, `bad CRC in ${type}`)
    }
    if (type === 'IHDR') {
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        bitDepth: body[8],
        colorType: body[9],
        compression: body[10],
        filter: body[11],
        interlace: body[12],
      }
    } else if (type === 'PLTE') {
      palette = body
    } else if (type === 'tRNS') {
      transparency = body
    } else if (type === 'IDAT') {
      data.push(body)
    } else if (type === 'IEND') {
      ended = true
    }
    offset = end
  }
  if (!header || !ended || data.length === 0) fail(name, 'missing IHDR, IDAT or IEND')
  const { width, height, bitDepth, colorType, compression, filter, interlace } = header
  if (bitDepth !== 8 || ![COLOR_TYPE_INDEXED, COLOR_TYPE_RGBA].includes(colorType)) {
    fail(name, 'expected an 8-bit indexed or RGBA PNG')
  }
  if (compression !== 0 || filter !== 0 || interlace !== 0) {
    fail(name, 'expected a non-interlaced PNG with standard compression')
  }
  if (colorType === COLOR_TYPE_INDEXED && (!palette || palette.length % 3 !== 0)) {
    fail(name, 'indexed PNG has no valid palette')
  }
  const bytesPerPixel = colorType === COLOR_TYPE_RGBA ? 4 : 1
  const pixels = unfilter(inflateSync(Buffer.concat(data)), width, height, bytesPerPixel, name)
  if (colorType === COLOR_TYPE_RGBA) return { width, height, rgba: pixels }

  const rgba = new Uint8Array(width * height * 4)
  const entries = palette.length / 3
  for (let i = 0; i < width * height; i += 1) {
    const index = pixels[i]
    if (index >= entries) fail(name, `palette index ${index} is out of range`)
    rgba[i * 4] = palette[index * 3]
    rgba[i * 4 + 1] = palette[index * 3 + 1]
    rgba[i * 4 + 2] = palette[index * 3 + 2]
    rgba[i * 4 + 3] = transparency && index < transparency.length ? transparency[index] : 255
  }
  return { width, height, rgba }
}

const toHex = (red, green, blue) => `#${[red, green, blue]
  .map((value) => value.toString(16).padStart(2, '0'))
  .join('')}`

// Maps each pixel to its palette key. Pixels are either fully transparent or opaque.
export function toPaletteKeys({ width, height, rgba }, keyByHex, name = 'image') {
  const keys = new Array(width * height)
  for (let i = 0; i < keys.length; i += 1) {
    const alpha = rgba[i * 4 + 3]
    if (alpha === 0) {
      keys[i] = TRANSPARENT_KEY
      continue
    }
    if (alpha !== 255) fail(name, `pixel ${i % width},${Math.floor(i / width)} is translucent`)
    const hex = toHex(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2])
    const key = keyByHex.get(hex)
    if (key === undefined) {
      fail(name, `pixel ${i % width},${Math.floor(i / width)} uses ${hex}, which is not in the palette`)
    }
    keys[i] = key
  }
  return keys
}

// Row-major runs: a palette key, then the run length when it is 2 or more.
export function encodeRunLength(keys) {
  let encoded = ''
  for (let i = 0; i < keys.length;) {
    let run = 1
    while (i + run < keys.length && keys[i + run] === keys[i]) run += 1
    encoded += run > 1 ? `${keys[i]}${run}` : keys[i]
    i += run
  }
  return encoded
}

function assertComponentSize(name, width, height) {
  const spec = PIXEL_COMPONENTS[name]
  if (spec.width !== undefined) {
    if (width !== spec.width || height !== spec.height) {
      fail(name, `expected ${spec.width}×${spec.height}, found ${width}×${height}`)
    }
  } else if (width > spec.maxWidth || height > spec.maxHeight || width < 1 || height < 1) {
    fail(name, `expected at most ${spec.maxWidth}×${spec.maxHeight}, found ${width}×${height}`)
  }
}

export function packPixelDeck(sourceDir = PIXEL_SOURCE_DIR) {
  const palette = readPalette(readFileSync(path.join(sourceDir, 'palette.json'), 'utf8'))
  const expected = Object.keys(PIXEL_COMPONENTS)
  const found = readdirSync(sourceDir)
    .filter((file) => file.endsWith('.png'))
    .map((file) => file.slice(0, -'.png'.length))
  const missing = expected.filter((name) => !found.includes(name))
  const unexpected = found.filter((name) => !Object.hasOwn(PIXEL_COMPONENTS, name))
  if (missing.length > 0 || unexpected.length > 0) {
    fail(sourceDir, `missing [${missing.join(', ')}], unexpected [${unexpected.join(', ')}]`)
  }

  const sprites = expected.map((name) => {
    const image = decodePng(readFileSync(path.join(sourceDir, `${name}.png`)), name)
    assertComponentSize(name, image.width, image.height)
    const keys = toPaletteKeys(image, palette.keyByHex, name)
    return { name, width: image.width, height: image.height, rle: encodeRunLength(keys) }
  })

  const lines = [
    '// Generated by tools/card-art/pack-pixel.mjs from art/tarot-pixel/. Do not edit:',
    '// change the PNG sources, then run `node tools/card-art/pack-pixel.mjs`.',
    '// Sprites are row-major runs of palette keys; a decimal run length follows a key',
    `// that repeats. '${TRANSPARENT_KEY}' is transparent.`,
    '',
    'export const TAROT_PIXEL_PALETTE = Object.freeze({',
    ...palette.colors.map(({ key, hex }) => `  ${key}: '${hex}',`),
    '})',
    '',
    'export const TAROT_PIXEL_SPRITES = Object.freeze({',
    ...sprites.map(({ name, width, height, rle }) => (
      `  '${name}': Object.freeze({ width: ${width}, height: ${height}, rle: '${rle}' }),`
    )),
    '})',
    '',
  ]
  return lines.join('\n')
}

function main(args) {
  const source = packPixelDeck()
  const bytes = Buffer.byteLength(source)
  const gzipBytes = gzipSync(source, { level: 9 }).length
  if (args.includes('--check')) {
    const committed = readFileSync(PIXEL_MODULE_PATH, 'utf8')
    if (committed !== source) {
      console.error(`${path.relative(REPO_ROOT, PIXEL_MODULE_PATH)} is out of date`)
      process.exitCode = 1
      return
    }
    console.log(`up to date: ${bytes} bytes, ${gzipBytes} bytes gzip`)
    return
  }
  writeFileSync(PIXEL_MODULE_PATH, source)
  console.log(
    `wrote ${path.relative(REPO_ROOT, PIXEL_MODULE_PATH)}: ${bytes} bytes, ${gzipBytes} bytes gzip`,
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
}

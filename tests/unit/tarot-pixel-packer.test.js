import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { crc32, deflateSync } from 'node:zlib'
import {
  PIXEL_COMPONENTS,
  PIXEL_MODULE_PATH,
  PIXEL_SOURCE_DIR,
  decodePng,
  encodeRunLength,
  packPixelDeck,
  readPalette,
  toPaletteKeys,
} from '../../tools/card-art/pack-pixel.mjs'

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

function chunk(type, body) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(body.length)
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), body])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed))
  return Buffer.concat([length, typed, crc])
}

function paeth(left, above, upperLeft) {
  const estimate = left + above - upperLeft
  const toLeft = Math.abs(estimate - left)
  const toAbove = Math.abs(estimate - above)
  const toUpperLeft = Math.abs(estimate - upperLeft)
  if (toLeft <= toAbove && toLeft <= toUpperLeft) return left
  return toAbove <= toUpperLeft ? above : upperLeft
}

// Encodes RGBA rows, cycling through the given PNG filter types.
function encodeRgbaPng(width, height, rgba, { filters = [0], bitDepth = 8, interlace = 0 } = {}) {
  const stride = width * 4
  const rows = []
  for (let y = 0; y < height; y += 1) {
    const filter = filters[y % filters.length]
    const row = Buffer.alloc(stride + 1)
    row[0] = filter
    for (let x = 0; x < stride; x += 1) {
      const left = x >= 4 ? rgba[y * stride + x - 4] : 0
      const above = y > 0 ? rgba[(y - 1) * stride + x] : 0
      const upperLeft = y > 0 && x >= 4 ? rgba[(y - 1) * stride + x - 4] : 0
      const predicted = [0, left, above, (left + above) >> 1, paeth(left, above, upperLeft)][filter]
      row[x + 1] = (rgba[y * stride + x] - predicted) & 0xff
    }
    rows.push(row)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = bitDepth
  header[9] = 6
  header[12] = interlace
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function copySources(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'tarot-pixel-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  cpSync(PIXEL_SOURCE_DIR, directory, { recursive: true })
  return directory
}

test('the committed sprite module matches the packed PNG sources byte for byte', () => {
  assert.equal(packPixelDeck(), readFileSync(PIXEL_MODULE_PATH, 'utf8'))
})

test('decodePng reverses every PNG filter in RGBA images', () => {
  const width = 5
  const height = 5
  const rgba = Uint8Array.from({ length: width * height * 4 }, (_, i) => (i * 37 + (i >> 3) * 11) & 0xff)
  const image = decodePng(encodeRgbaPng(width, height, rgba, { filters: [0, 1, 2, 3, 4] }))
  assert.deepEqual([image.width, image.height], [width, height])
  assert.deepEqual([...image.rgba], [...rgba])
})

test('decodePng reads indexed PNGs with transparency', () => {
  const image = decodePng(readFileSync(path.join(PIXEL_SOURCE_DIR, 'frame.png')), 'frame')
  assert.deepEqual([image.width, image.height], [75, 105])
  assert.deepEqual([...image.rgba.slice(0, 4)], [0, 0, 0, 0])
  const center = ((52 * 75) + 37) * 4
  assert.equal(image.rgba[center + 3], 255)
})

test('decodePng rejects files outside the supported PNG subset', () => {
  const pixel = Uint8Array.of(1, 2, 3, 255)
  const valid = encodeRgbaPng(1, 1, pixel)
  assert.throws(() => decodePng(Buffer.from('not a png'), 'text'), /text: not a PNG/)
  const corrupted = Buffer.from(valid)
  corrupted[30] ^= 0xff
  assert.throws(() => decodePng(corrupted, 'corrupt'), /bad CRC/)
  assert.throws(
    () => decodePng(encodeRgbaPng(1, 1, pixel, { bitDepth: 16 }), 'deep'),
    /8-bit indexed or RGBA/,
  )
  assert.throws(
    () => decodePng(encodeRgbaPng(1, 1, pixel, { interlace: 1 }), 'interlaced'),
    /non-interlaced/,
  )
})

test('palette keys reject translucent and off-palette pixels', () => {
  const palette = readPalette(JSON.stringify({
    transparent: '.',
    colors: [{ key: 'N', hex: '#28204f' }, { key: 'G', hex: '#d7bb72' }],
  }))
  const image = (rgba) => ({ width: 2, height: 1, rgba: Uint8Array.from(rgba) })
  assert.deepEqual(
    toPaletteKeys(image([0x28, 0x20, 0x4f, 255, 9, 9, 9, 0]), palette.keyByHex),
    ['N', '.'],
  )
  assert.throws(
    () => toPaletteKeys(image([0x28, 0x20, 0x4f, 128, 0, 0, 0, 0]), palette.keyByHex, 'soft'),
    /soft: pixel 0,0 is translucent/,
  )
  assert.throws(
    () => toPaletteKeys(image([0x28, 0x20, 0x4f, 255, 1, 2, 3, 255]), palette.keyByHex, 'odd'),
    /odd: pixel 1,0 uses #010203/,
  )
})

test('readPalette enforces unique keys and colours within 32 entries', () => {
  const colors = (count) => Array.from({ length: count }, (_, i) => ({
    key: String.fromCharCode(65 + (i % 26)) + (i >= 26 ? 'x' : ''),
    hex: `#0000${i.toString(16).padStart(2, '0')}`,
  }))
  assert.throws(() => readPalette('{"transparent":"_","colors":[]}'), /transparent/)
  assert.throws(
    () => readPalette(JSON.stringify({ transparent: '.', colors: [] })),
    /1 to 32 colours/,
  )
  assert.throws(
    () => readPalette(JSON.stringify({ transparent: '.', colors: colors(33) })),
    /1 to 32 colours/,
  )
  assert.throws(
    () => readPalette(JSON.stringify({
      transparent: '.',
      colors: [{ key: 'N', hex: '#000000' }, { key: 'N', hex: '#000001' }],
    })),
    /duplicate key N/,
  )
  assert.throws(
    () => readPalette(JSON.stringify({
      transparent: '.',
      colors: [{ key: 'N', hex: '#000000' }, { key: 'M', hex: '#000000' }],
    })),
    /duplicate colour #000000/,
  )
  assert.throws(
    () => readPalette(JSON.stringify({ transparent: '.', colors: colors(27) })),
    /invalid or duplicate key Ax/,
  )
})

test('run-length encoding writes counts only for repeated keys', () => {
  assert.equal(encodeRunLength([]), '')
  assert.equal(encodeRunLength(['.', '.', 'N', 'P', 'P', 'P']), '.2NP3')
  assert.equal(encodeRunLength(Array(12).fill('G')), 'G12')
})

test('packPixelDeck requires exactly the expected components at their sizes', (t) => {
  assert.equal(Object.keys(PIXEL_COMPONENTS).length, 46)

  const missing = copySources(t)
  unlinkSync(path.join(missing, 'rank-10.png'))
  assert.throws(() => packPixelDeck(missing), /missing \[rank-10\], unexpected \[\]/)

  const extra = copySources(t)
  writeFileSync(path.join(extra, 'rank-1.png'), readFileSync(path.join(extra, 'rank-2.png')))
  assert.throws(() => packPixelDeck(extra), /missing \[\], unexpected \[rank-1\]/)

  const resized = copySources(t)
  writeFileSync(path.join(resized, 'pip-cups.png'), readFileSync(path.join(resized, 'rank-2.png')))
  assert.throws(() => packPixelDeck(resized), /pip-cups: expected 9×9, found 5×7/)

  const oversized = copySources(t)
  writeFileSync(path.join(oversized, 'ace-cups.png'), readFileSync(path.join(oversized, 'frame.png')))
  assert.throws(() => packPixelDeck(oversized), /ace-cups: expected at most 41×79, found 75×105/)
})

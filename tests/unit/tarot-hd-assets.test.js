import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { CARD_IDS } from '../../src/domain/cards.js'
import {
  TAROT_HD_ASSETS,
  TAROT_HD_SOURCE_SHA256,
} from '../../src/presentation/themes/tarot-hd-assets.js'
import {
  TAROT_HD_ASSET_IDS,
  TAROT_HD_BACK_ID,
  TAROT_HD_IMAGE_SIZE,
  TAROT_HD_PREVIEW_ID,
  TAROT_HD_PREVIEW_LAYOUT,
} from '../../src/presentation/themes/tarot-hd-layout.js'
import {
  HD_OUTPUT_DIR,
  HD_PACK_BUDGET_BYTES,
  HD_SOURCE_DIR,
  REPO_ROOT,
  computeSourceDigest,
  getAssetFileName,
} from '../../tools/card-art/hd-compose.mjs'

const FILE_NAME = /^tarot-hd-art-[A-Za-z0-9-]+\.webp$/

function readFrameSize(bytes, offset, type) {
  if (type === 'VP8 ') {
    assert.equal(bytes.readUIntBE(offset + 3, 3), 0x9d012a, 'VP8 start code')
    return {
      width: bytes.readUInt16LE(offset + 6) & 0x3fff,
      height: bytes.readUInt16LE(offset + 8) & 0x3fff,
    }
  }
  assert.equal(bytes[offset], 0x2f, 'VP8L signature')
  const bits = bytes.readUInt32LE(offset + 1)
  return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
}

// Reads the canvas size of a simple or extended (VP8X) still WebP and checks
// that its single frame has the same size.
function readWebpSize(bytes) {
  assert.equal(bytes.toString('latin1', 0, 4), 'RIFF')
  assert.equal(bytes.readUInt32LE(4) + 8, bytes.length, 'RIFF size')
  assert.equal(bytes.toString('latin1', 8, 12), 'WEBP')
  let canvas = null
  let frame = null
  for (let offset = 12; offset < bytes.length;) {
    const type = bytes.toString('latin1', offset, offset + 4)
    const length = bytes.readUInt32LE(offset + 4)
    const body = offset + 8
    assert.ok(body + length <= bytes.length, `${type} chunk overruns the file`)
    if (type === 'VP8X') {
      assert.equal(offset, 12, 'VP8X must be the first chunk')
      assert.equal(bytes[body] & 0x02, 0, 'animated WebP')
      canvas = {
        width: bytes.readUIntLE(body + 4, 3) + 1,
        height: bytes.readUIntLE(body + 7, 3) + 1,
      }
    } else if (type === 'VP8 ' || type === 'VP8L') {
      assert.equal(frame, null, 'more than one image frame')
      frame = readFrameSize(bytes, body, type)
    }
    offset = body + length + (length % 2)
  }
  assert.ok(frame, 'no VP8 or VP8L frame')
  if (canvas) assert.deepEqual(frame, canvas, 'the frame and the VP8X canvas differ')
  return frame
}

const readAsset = ({ url }) => readFileSync(fileURLToPath(url))

test('the HD manifest lists every card front, then the back and the preview', () => {
  assert.deepEqual(TAROT_HD_ASSET_IDS, [...CARD_IDS, TAROT_HD_BACK_ID, TAROT_HD_PREVIEW_ID])
  assert.deepEqual(TAROT_HD_ASSETS.map(({ id }) => id), TAROT_HD_ASSET_IDS)
  assert.equal(TAROT_HD_ASSETS.length, 54)
  assert.ok(Object.isFrozen(TAROT_HD_ASSETS))
  for (const entry of TAROT_HD_ASSETS) {
    assert.ok(Object.isFrozen(entry), entry.id)
    assert.deepEqual(Object.keys(entry), ['id', 'url', 'bytes', 'sha256'])
    assert.ok(Number.isSafeInteger(entry.bytes) && entry.bytes > 0, entry.id)
    assert.match(entry.sha256, /^[0-9a-f]{64}$/, entry.id)
  }
})

test('every HD image exists under its pack file name with the recorded size and SHA-256', () => {
  for (const entry of TAROT_HD_ASSETS) {
    const file = fileURLToPath(entry.url)
    assert.equal(path.dirname(file), HD_OUTPUT_DIR, entry.id)
    assert.equal(path.basename(file), getAssetFileName(entry.id))
    assert.match(path.basename(file), FILE_NAME)
    const bytes = readAsset(entry)
    assert.equal(bytes.length, entry.bytes, `${entry.id}: size`)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, `${entry.id}: SHA-256`)
  }
})

test('cards and the back are 600×840 WebP images and the preview is 1200×1470', () => {
  assert.deepEqual(TAROT_HD_IMAGE_SIZE, { width: 600, height: 840 })
  assert.deepEqual(
    { width: TAROT_HD_PREVIEW_LAYOUT.width, height: TAROT_HD_PREVIEW_LAYOUT.height },
    { width: 1200, height: 1470 },
  )
  for (const entry of TAROT_HD_ASSETS) {
    const expected = entry.id === TAROT_HD_PREVIEW_ID
      ? { width: 1200, height: 1470 }
      : { width: 600, height: 840 }
    assert.deepEqual(readWebpSize(readAsset(entry)), expected, entry.id)
  }
})

test('the pack directory holds exactly the manifest files, within the budget', () => {
  const expected = TAROT_HD_ASSETS.map(({ id }) => getAssetFileName(id)).sort()
  assert.deepEqual(readdirSync(HD_OUTPUT_DIR).sort(), expected)
  const total = TAROT_HD_ASSETS.reduce((sum, { bytes }) => sum + bytes, 0)
  assert.ok(total <= HD_PACK_BUDGET_BYTES, `the pack is ${total} bytes`)
})

test('the committed HD pack was built from the current sources', () => {
  assert.equal(
    TAROT_HD_SOURCE_SHA256,
    computeSourceDigest(),
    'art/tarot-hd/ or the HD tools changed since the pack was built; run '
      + '`npm --prefix tools/card-art ci && npm --prefix tools/card-art run build:hd` '
      + 'and commit the results (see art/README.md)',
  )
})

test('every HD art source has a provenance record', () => {
  const provenance = JSON.parse(readFileSync(path.join(REPO_ROOT, 'art/provenance.json'), 'utf8'))
  const recorded = new Set(provenance.files.map((record) => record.path))
  const sources = readdirSync(HD_SOURCE_DIR)
  assert.ok(sources.length > 0)
  for (const file of sources) {
    assert.ok(recorded.has(`tarot-hd/${file}`), `tarot-hd/${file}`)
  }
})

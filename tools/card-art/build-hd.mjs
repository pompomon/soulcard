// Builds the Tarot (HD) pack from the SVG components in art/tarot-hd/:
//
// - rasterizes every composed card and the back with resvg at 1200×1680
// - downsamples to 600×840 (Lanczos) with sharp and encodes WebP
// - samples the index plates and the back's symmetry before writing anything
// - writes the 1200×1470 preview atlas and src/presentation/themes/tarot-hd-assets.js.
//
// `--check` builds in memory and exits 1 if the committed outputs differ.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'
import sharp from 'sharp'
import { CARD_IDS } from '../../src/domain/cards.js'
import {
  TAROT_COLORS,
  TAROT_LAYOUT,
  TAROT_LOGICAL_SIZE,
  getTarotComposition,
} from '../../src/presentation/themes/tarot-composition.js'
import {
  TAROT_HD_ASSET_IDS,
  TAROT_HD_BACK_ID,
  TAROT_HD_IMAGE_SIZE,
  TAROT_HD_PREVIEW_ID,
  TAROT_HD_PREVIEW_LAYOUT,
  TAROT_HD_PREVIEW_ORDER,
  getTarotHdPreviewCell,
} from '../../src/presentation/themes/tarot-hd-layout.js'
import {
  HD_FILE_PREFIX,
  HD_MODULE_PATH,
  HD_OUTPUT_DIR,
  HD_PACK_BUDGET_BYTES,
  HD_RENDER_SCALE,
  composeBackSvg,
  composeCardSvg,
  computeSourceDigest,
  getAssetFileName,
  loadComponents,
  renderAssetsModule,
} from './hd-compose.mjs'

const CARD_WEBP = Object.freeze({ quality: 82, alphaQuality: 100, effort: 6, smartSubsample: true })
const PREVIEW_WEBP = Object.freeze({ quality: 75, alphaQuality: 100, effort: 6, smartSubsample: true })

// Index-plate tolerances, in 8-bit channel units. In the lossless reference every
// pixel must lie on the line through the ground and the index ink (anti-aliasing),
// allowing for Lanczos overshoot past either end, clipped to 0–255; the encoded
// image may drift within the WebP tolerances, and must keep at least 4.5:1 contrast.
const PLATE = Object.freeze({
  lineTolerance: 6,
  overshoot: 0.2,
  minimumInkPixels: 40,
  inkTolerance: 24,
  groundTolerance: 6,
  minimumContrast: 4.5,
})
// The rendered back against its 180° rotation: the mean absolute channel
// difference, and how many pixels may differ by more than `threshold` in some
// channel (anti-aliasing at sharp points). A missing star breaks either bound.
const BACK_SYMMETRY = Object.freeze({ mean: 0.05, threshold: 32, maxPixels: 16 })

const RENDER_SIZE = Object.freeze({
  width: TAROT_LOGICAL_SIZE.width * HD_RENDER_SCALE,
  height: TAROT_LOGICAL_SIZE.height * HD_RENDER_SCALE,
})
const OUTPUT_SCALE = TAROT_HD_IMAGE_SIZE.width / TAROT_LOGICAL_SIZE.width

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const relative = (file) => path.relative(process.cwd(), file) || file

function rasterize(svg) {
  const rendered = new Resvg(svg, {
    fitTo: { mode: 'width', value: RENDER_SIZE.width },
    font: { loadSystemFonts: false },
  }).render()
  if (rendered.width !== RENDER_SIZE.width || rendered.height !== RENDER_SIZE.height) {
    throw new Error(`resvg rendered ${rendered.width}×${rendered.height}, expected ${RENDER_SIZE.width}×${RENDER_SIZE.height}`)
  }
  // asPng() un-premultiplies; render().pixels is premultiplied.
  return rendered.asPng()
}

async function toRaw(image) {
  const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height }
}

async function renderImage(svg) {
  const png = rasterize(svg)
  const reference = await toRaw(sharp(png).resize(TAROT_HD_IMAGE_SIZE.width, TAROT_HD_IMAGE_SIZE.height, {
    kernel: sharp.kernel.lanczos3,
  }))
  const webp = await sharp(reference.data, {
    raw: { width: reference.width, height: reference.height, channels: 4 },
  }).webp(CARD_WEBP).toBuffer()
  return { png, reference, webp }
}

const toRgb = (hex) => [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16))

function relativeLuminance(rgb) {
  const [r, g, b] = rgb.map((value) => {
    const channel = value / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrastRatio(a, b) {
  const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x)
  return (light + 0.05) / (dark + 0.05)
}

// The index boxes and their 180° copies, in output pixels.
function plateBoxes() {
  const { width, height } = TAROT_LOGICAL_SIZE
  return Object.entries(TAROT_LAYOUT.index).flatMap(([name, box]) => [
    { name, ...box },
    { name: `${name} (rotated)`, ...box, x: width - box.x - box.width, y: height - box.y - box.height },
  ]).map((box) => ({
    name: box.name,
    x: box.x * OUTPUT_SCALE,
    y: box.y * OUTPUT_SCALE,
    width: box.width * OUTPUT_SCALE,
    height: box.height * OUTPUT_SCALE,
  }))
}

function boxPixels(image, box, visit) {
  for (let y = box.y; y < box.y + box.height; y += 1) {
    for (let x = box.x; x < box.x + box.width; x += 1) {
      const offset = (y * image.width + x) * 4
      visit(offset)
    }
  }
}

// The position of a pixel along ground + t·axis, projected over the channels that
// aren't clipped at 0 or 255.
function linePosition(pixel, ground, axis) {
  let dot = 0
  let length = 0
  pixel.forEach((value, channel) => {
    if (value > 0 && value < 255) {
      dot += (value - ground[channel]) * axis[channel]
      length += axis[channel] * axis[channel]
    }
  })
  return length === 0 ? Number.NaN : dot / length
}

// An index plate may contain only the ground, the index ink and their blends in
// the lossless reference; in the encoded image the ink and ground means must stay
// close to the composition's colours.
export function checkIndexPlates(cardId, reference, decoded) {
  const ink = toRgb(getTarotComposition(cardId).index.color)
  const ground = toRgb(TAROT_COLORS.ground)
  const axis = ink.map((value, channel) => value - ground[channel])
  const stats = []
  for (const box of plateBoxes()) {
    const inkSum = [0, 0, 0]
    const groundSum = [0, 0, 0]
    let inkCount = 0
    let groundCount = 0
    let worstBlend = 0
    let worstOvershoot = 0
    boxPixels(reference, box, (offset) => {
      const pixel = [0, 1, 2].map((channel) => reference.data[offset + channel])
      if (reference.data[offset + 3] !== 255) {
        throw new Error(`${cardId} ${box.name}: index plate is not opaque`)
      }
      const t = linePosition(pixel, ground, axis)
      if (Number.isNaN(t)) {
        throw new Error(`${cardId} ${box.name}: rgb(${pixel.join(', ')}) is off the ground–ink line`)
      }
      const distance = Math.hypot(...pixel.map((value, channel) => (
        value - Math.min(255, Math.max(0, ground[channel] + t * axis[channel]))
      )))
      worstBlend = Math.max(worstBlend, distance)
      worstOvershoot = Math.max(worstOvershoot, -t, t - 1)
      const decodedPixel = [0, 1, 2].map((channel) => decoded.data[offset + channel])
      if (t >= 0.95) {
        inkCount += 1
        decodedPixel.forEach((value, channel) => { inkSum[channel] += value })
      } else if (t <= 0.02) {
        groundCount += 1
        decodedPixel.forEach((value, channel) => { groundSum[channel] += value })
      }
    })
    if (worstBlend > PLATE.lineTolerance || worstOvershoot > PLATE.overshoot) {
      throw new Error(`${cardId} ${box.name}: a pixel strays ${worstBlend.toFixed(1)} from the ground–ink line`
        + ` or overshoots it by ${worstOvershoot.toFixed(2)}`)
    }
    if (inkCount < PLATE.minimumInkPixels || groundCount === 0) {
      throw new Error(`${cardId} ${box.name}: ${inkCount} ink and ${groundCount} ground pixels`)
    }
    const inkMean = inkSum.map((sum) => sum / inkCount)
    const groundMean = groundSum.map((sum) => sum / groundCount)
    const inkDrift = Math.max(...inkMean.map((value, channel) => Math.abs(value - ink[channel])))
    const groundDrift = Math.max(...groundMean.map((value, channel) => Math.abs(value - ground[channel])))
    const contrast = contrastRatio(inkMean, groundMean)
    if (inkDrift > PLATE.inkTolerance || groundDrift > PLATE.groundTolerance || contrast < PLATE.minimumContrast) {
      throw new Error(`${cardId} ${box.name}: encoded ink drifts ${inkDrift.toFixed(1)}, ground ${groundDrift.toFixed(1)}, contrast ${contrast.toFixed(2)}:1`)
    }
    stats.push({ worstBlend, worstOvershoot, inkDrift, groundDrift, contrast })
  }
  return stats
}

export async function checkBackSymmetry(png) {
  const image = await toRaw(sharp(png))
  const { data, width, height } = image
  let total = 0
  let outliers = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const a = (y * width + x) * 4
      const b = ((height - 1 - y) * width + (width - 1 - x)) * 4
      let pixelMax = 0
      for (let channel = 0; channel < 4; channel += 1) {
        const difference = Math.abs(data[a + channel] - data[b + channel])
        total += difference
        if (difference > pixelMax) pixelMax = difference
      }
      if (pixelMax > BACK_SYMMETRY.threshold) outliers += 1
    }
  }
  const mean = total / data.length
  if (mean > BACK_SYMMETRY.mean || outliers > BACK_SYMMETRY.maxPixels) {
    throw new Error(`The back is not 180° symmetric: mean difference ${mean.toFixed(4)},`
      + ` ${outliers} pixels differ by more than ${BACK_SYMMETRY.threshold}`)
  }
  return { mean, outliers }
}

async function renderPreview(pngs) {
  const { cellWidth, cellHeight, width, height } = TAROT_HD_PREVIEW_LAYOUT
  const composites = []
  for (const id of TAROT_HD_PREVIEW_ORDER) {
    const cell = getTarotHdPreviewCell(id)
    const raw = await toRaw(sharp(pngs.get(id)).resize(cellWidth, cellHeight, { kernel: sharp.kernel.lanczos3 }))
    composites.push({
      input: raw.data,
      raw: { width: raw.width, height: raw.height, channels: 4 },
      left: cell.x,
      top: cell.y,
    })
  }
  return sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(composites)
    .webp(PREVIEW_WEBP)
    .toBuffer()
}

async function checkDimensions(id, bytes) {
  const expected = id === TAROT_HD_PREVIEW_ID ? TAROT_HD_PREVIEW_LAYOUT : TAROT_HD_IMAGE_SIZE
  const metadata = await sharp(bytes).metadata()
  if (metadata.format !== 'webp' || metadata.width !== expected.width || metadata.height !== expected.height) {
    throw new Error(`${getAssetFileName(id)} is ${metadata.format} ${metadata.width}×${metadata.height}, expected webp ${expected.width}×${expected.height}`)
  }
}

export async function buildPack() {
  const components = loadComponents()
  const outputs = new Map()
  const pngs = new Map()
  const plates = []
  let symmetry = null
  for (const id of TAROT_HD_PREVIEW_ORDER) {
    const svg = id === TAROT_HD_BACK_ID ? composeBackSvg(components) : composeCardSvg(id, components)
    const { png, reference, webp } = await renderImage(svg)
    if (id === TAROT_HD_BACK_ID) {
      symmetry = await checkBackSymmetry(png)
    } else {
      plates.push(...checkIndexPlates(id, reference, await toRaw(sharp(webp))))
    }
    pngs.set(id, png)
    outputs.set(id, webp)
  }
  outputs.set(TAROT_HD_PREVIEW_ID, await renderPreview(pngs))
  const entries = []
  for (const id of TAROT_HD_ASSET_IDS) {
    const bytes = outputs.get(id)
    await checkDimensions(id, bytes)
    entries.push({ id, bytes: bytes.length, sha256: sha256(bytes) })
  }
  const total = entries.reduce((sum, entry) => sum + entry.bytes, 0)
  if (total > HD_PACK_BUDGET_BYTES) {
    throw new Error(`The pack is ${total} bytes, over the ${HD_PACK_BUDGET_BYTES}-byte budget`)
  }
  return {
    outputs,
    entries,
    total,
    plates,
    symmetry,
    moduleSource: renderAssetsModule(entries, computeSourceDigest()),
  }
}

function writePack(pack) {
  mkdirSync(HD_OUTPUT_DIR, { recursive: true })
  for (const file of readdirSync(HD_OUTPUT_DIR)) {
    if (file.startsWith(HD_FILE_PREFIX)) rmSync(path.join(HD_OUTPUT_DIR, file))
  }
  for (const [id, bytes] of pack.outputs) {
    writeFileSync(path.join(HD_OUTPUT_DIR, getAssetFileName(id)), bytes)
  }
  writeFileSync(HD_MODULE_PATH, pack.moduleSource)
}

function comparePack(pack) {
  const problems = []
  const expected = new Set(TAROT_HD_ASSET_IDS.map(getAssetFileName))
  const present = existsSync(HD_OUTPUT_DIR) ? readdirSync(HD_OUTPUT_DIR) : []
  for (const file of present) {
    if (!expected.has(file)) problems.push(`unexpected ${file}`)
  }
  for (const [id, bytes] of pack.outputs) {
    const file = path.join(HD_OUTPUT_DIR, getAssetFileName(id))
    if (!existsSync(file)) problems.push(`missing ${relative(file)}`)
    else if (!readFileSync(file).equals(bytes)) problems.push(`${relative(file)} differs`)
  }
  const committed = existsSync(HD_MODULE_PATH) ? readFileSync(HD_MODULE_PATH, 'utf8') : null
  if (committed !== pack.moduleSource) problems.push(`${relative(HD_MODULE_PATH)} differs`)
  return problems
}

function summarize(pack) {
  const sizes = pack.entries.map((entry) => entry.bytes)
  const cards = pack.entries.filter((entry) => CARD_IDS.includes(entry.id))
  const kb = (bytes) => `${(bytes / 1000).toFixed(1)} kB`
  const worst = (key, pick) => pick(...pack.plates.map((plate) => plate[key]))
  return [
    `Tarot (HD): ${pack.entries.length} images, ${kb(pack.total)} in total (budget ${kb(HD_PACK_BUDGET_BYTES)})`,
    `  fronts ${kb(cards.reduce((sum, entry) => sum + entry.bytes, 0))}, `
      + `${kb(Math.min(...cards.map((entry) => entry.bytes)))}–${kb(Math.max(...cards.map((entry) => entry.bytes)))} each; `
      + `back ${kb(sizes[TAROT_HD_ASSET_IDS.indexOf(TAROT_HD_BACK_ID)])}; `
      + `preview ${kb(sizes[TAROT_HD_ASSET_IDS.indexOf(TAROT_HD_PREVIEW_ID)])}`,
    `  index plates: off-line ≤ ${worst('worstBlend', Math.max).toFixed(1)}, `
      + `overshoot ≤ ${worst('worstOvershoot', Math.max).toFixed(2)}, `
      + `ink drift ≤ ${worst('inkDrift', Math.max).toFixed(1)}, `
      + `ground drift ≤ ${worst('groundDrift', Math.max).toFixed(1)}, `
      + `contrast ≥ ${worst('contrast', Math.min).toFixed(2)}:1`,
    `  back symmetry: mean difference ${pack.symmetry.mean.toFixed(4)}, `
      + `${pack.symmetry.outliers} pixels over ${BACK_SYMMETRY.threshold}`,
  ].join('\n')
}

async function main(argv) {
  const unknown = argv.filter((argument) => argument !== '--check')
  if (unknown.length > 0) {
    console.error(`Unknown arguments: ${unknown.join(' ')}\nUsage: node build-hd.mjs [--check]`)
    return 2
  }
  const pack = await buildPack()
  console.log(summarize(pack))
  if (argv.includes('--check')) {
    const problems = comparePack(pack)
    if (problems.length > 0) {
      console.error(`The committed Tarot (HD) pack is stale:\n  ${problems.join('\n  ')}`)
      console.error('Run `npm --prefix tools/card-art run build:hd` and commit the result.')
      return 1
    }
    console.log('The committed Tarot (HD) pack is up to date.')
    return 0
  }
  writePack(pack)
  console.log(`Wrote ${relative(HD_OUTPUT_DIR)} and ${relative(HD_MODULE_PATH)}.`)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  }, (error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}

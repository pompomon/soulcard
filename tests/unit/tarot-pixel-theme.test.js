import assert from 'node:assert/strict'
import test from 'node:test'
import { CARD_IDS } from '../../src/domain/cards.js'
import {
  TAROT_LAYOUT,
  TAROT_MAX_TEXTURE_SCALE,
  getTarotComposition,
  getTarotPipBox,
  isInsideTarotWindow,
} from '../../src/presentation/themes/tarot-composition.js'
import {
  DEFAULT_TAROT_PIXEL_TEXTURE_SCALE,
  TAROT_PIXEL_ART_SIZE,
  TAROT_PIXEL_BACK_THEME,
  TAROT_PIXEL_BACK_THEME_ID,
  TAROT_PIXEL_FRONT_THEME,
  TAROT_PIXEL_FRONT_THEME_ID,
  generateTarotPixelBack,
  generateTarotPixelFront,
  renderTarotPixelBack,
  renderTarotPixelFront,
} from '../../src/presentation/themes/tarot-pixel.js'
import {
  TAROT_PIXEL_PALETTE,
  TAROT_PIXEL_SPRITES,
} from '../../src/presentation/themes/tarot-pixel-sprites.js'
import { createThemeRegistry } from '../../src/presentation/themes/registry.js'

const WIDTH = 75
const HEIGHT = 105
const UNIT = 4
const PALETTE_HEXES = new Set(Object.values(TAROT_PIXEL_PALETTE))
const GROUND = '#f2e6c9'
const WINDOW = '#fbf5e6'

function decode(name) {
  const { width, height, rle } = TAROT_PIXEL_SPRITES[name]
  const keys = []
  for (const [, key, run] of rle.matchAll(/([A-Za-z.])(\d*)/g)) {
    for (let i = 0; i < (run === '' ? 1 : Number(run)); i += 1) keys.push(key)
  }
  assert.equal(keys.length, width * height, name)
  return {
    width,
    height,
    at: (x, y) => keys[y * width + x],
  }
}

function hexAt(buffer, x, y) {
  const offset = (y * buffer.width + x) * 4
  if (buffer.data[offset + 3] === 0) return null
  return `#${[0, 1, 2]
    .map((channel) => buffer.data[offset + channel].toString(16).padStart(2, '0'))
    .join('')}`
}

const toArt = ({ x, y, width, height }) => ({
  x: x / UNIT,
  y: y / UNIT,
  width: width / UNIT,
  height: height / UNIT,
})
const rotate = (x, y) => [WIDTH - 1 - x, HEIGHT - 1 - y]
const inWindow = (x, y) => isInsideTarotWindow((x + 0.5) * UNIT, (y + 0.5) * UNIT)
const inBox = (box, x, y) => (
  x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height
)
const centred = (box, sprite) => ({
  x: box.x + Math.floor((box.width - sprite.width) / 2),
  y: box.y + Math.floor((box.height - sprite.height) / 2),
})

const RANK_BOX = toArt(TAROT_LAYOUT.index.rank)
const SUIT_BOX = toArt(TAROT_LAYOUT.index.suit)
const CARTOUCHE = toArt(TAROT_LAYOUT.cartouche)
const CARTOUCHE_INTERIOR = {
  x: CARTOUCHE.x + 1,
  y: CARTOUCHE.y + 1,
  width: CARTOUCHE.width - 2,
  height: CARTOUCHE.height - 2,
}

function isIndexPixel(x, y) {
  const [rx, ry] = rotate(x, y)
  return [RANK_BOX, SUIT_BOX].some((box) => inBox(box, x, y) || inBox(box, rx, ry))
}

class RecordingContext {
  constructor() {
    this.operations = []
    this.smoothing = true
  }

  set imageSmoothingEnabled(value) {
    this.smoothing = value
    this.operations.push({ name: 'imageSmoothingEnabled', args: [value] })
  }

  get imageSmoothingEnabled() {
    return this.smoothing
  }

  record(name, args) {
    this.operations.push({ name, args: [...args], smoothing: this.smoothing })
  }

  scale() { this.record('scale', arguments) }
  clearRect() { this.record('clearRect', arguments) }
  drawImage() { this.record('drawImage', arguments) }

  createImageData(width, height) {
    this.record('createImageData', arguments)
    return { width, height, data: new Uint8ClampedArray(width * height * 4) }
  }

  putImageData(image) {
    this.record('putImageData', [
      { width: image.width, height: image.height, data: Uint8ClampedArray.from(image.data) },
      ...[...arguments].slice(1),
    ])
  }
}

function createCanvasHarness() {
  const canvases = []
  return {
    canvases,
    createCanvas(width, height) {
      const context = new RecordingContext()
      const canvas = {
        width,
        height,
        context,
        getContext(type) {
          assert.equal(type, '2d')
          return context
        },
      }
      canvases.push(canvas)
      return canvas
    },
  }
}

test('Tarot pixel theme exports stable immutable descriptors', () => {
  assert.equal(TAROT_PIXEL_FRONT_THEME_ID, 'tarot-pixel-front-v1')
  assert.equal(TAROT_PIXEL_BACK_THEME_ID, 'tarot-pixel-back-v1')
  assert.equal(DEFAULT_TAROT_PIXEL_TEXTURE_SCALE, 2)
  assert.equal(TAROT_MAX_TEXTURE_SCALE, 2)
  assert.deepEqual(TAROT_PIXEL_ART_SIZE, { width: WIDTH, height: HEIGHT })
  assert.ok(Object.isFrozen(TAROT_PIXEL_ART_SIZE))
  assert.deepEqual(TAROT_PIXEL_FRONT_THEME, {
    id: TAROT_PIXEL_FRONT_THEME_ID,
    create: generateTarotPixelFront,
  })
  assert.deepEqual(TAROT_PIXEL_BACK_THEME, {
    id: TAROT_PIXEL_BACK_THEME_ID,
    create: generateTarotPixelBack,
  })
  assert.ok(Object.isFrozen(TAROT_PIXEL_FRONT_THEME))
  assert.ok(Object.isFrozen(TAROT_PIXEL_BACK_THEME))
  assert.ok(Object.isFrozen(TAROT_PIXEL_PALETTE))
  assert.ok(Object.isFrozen(TAROT_PIXEL_SPRITES))
  assert.ok(PALETTE_HEXES.size <= 32)

  const registry = createThemeRegistry({
    frontThemes: [TAROT_PIXEL_FRONT_THEME],
    backThemes: [TAROT_PIXEL_BACK_THEME],
  })
  assert.equal(registry.resolveFront(TAROT_PIXEL_FRONT_THEME_ID).create, generateTarotPixelFront)
  assert.equal(registry.resolveBack(TAROT_PIXEL_BACK_THEME_ID).create, generateTarotPixelBack)
})

test('every card and the back render deterministic, palette-only 75×105 buffers', () => {
  const signatures = new Set()
  for (const render of [...CARD_IDS.map((id) => () => renderTarotPixelFront(id)), renderTarotPixelBack]) {
    const buffer = render()
    assert.equal(buffer.width, WIDTH)
    assert.equal(buffer.height, HEIGHT)
    assert.ok(buffer.data instanceof Uint8ClampedArray)
    assert.equal(buffer.data.length, WIDTH * HEIGHT * 4)
    assert.deepEqual(render().data, buffer.data)

    for (const [x, y] of [[0, 0], [WIDTH - 1, 0], [0, HEIGHT - 1], [WIDTH - 1, HEIGHT - 1]]) {
      assert.equal(hexAt(buffer, x, y), null, `corner ${x},${y}`)
    }
    for (let y = 0; y < HEIGHT; y += 1) {
      for (let x = 0; x < WIDTH; x += 1) {
        const alpha = buffer.data[(y * WIDTH + x) * 4 + 3]
        assert.ok(alpha === 0 || alpha === 255, `alpha at ${x},${y}`)
        const hex = hexAt(buffer, x, y)
        if (hex !== null) assert.ok(PALETTE_HEXES.has(hex), `${hex} at ${x},${y}`)
      }
    }
    signatures.add(Buffer.from(buffer.data).toString('base64'))
  }
  assert.equal(signatures.size, CARD_IDS.length + 1)

  const mutated = renderTarotPixelFront('c-AS')
  mutated.data.fill(0)
  assert.notDeepEqual(renderTarotPixelFront('c-AS').data, mutated.data)
})

test('index glyphs sit top-left in the index colour with an exact 180° copy', () => {
  for (const cardId of CARD_IDS) {
    const composition = getTarotComposition(cardId)
    const buffer = renderTarotPixelFront(cardId)
    for (const [name, box] of [
      [`rank-${composition.rank}`, RANK_BOX],
      [`suit-${composition.suit}`, SUIT_BOX],
    ]) {
      const sprite = decode(name)
      const origin = centred(box, sprite)
      const inkRows = new Set()
      for (let y = box.y; y < box.y + box.height; y += 1) {
        for (let x = box.x; x < box.x + box.width; x += 1) {
          const sx = x - origin.x
          const sy = y - origin.y
          const ink = sx >= 0 && sy >= 0 && sx < sprite.width && sy < sprite.height
            && sprite.at(sx, sy) !== '.'
          const expected = ink ? composition.index.color : GROUND
          assert.equal(hexAt(buffer, x, y), expected, `${cardId} ${name} at ${x},${y}`)
          assert.equal(hexAt(buffer, ...rotate(x, y)), expected, `${cardId} rotated ${name}`)
          if (ink) inkRows.add(y)
        }
      }
      // Seven art px are 28 logical px, the minimum index height.
      assert.equal(inkRows.size, 7, `${cardId} ${name} height`)
    }
  }
})

test('pips match the composition and nothing else marks a pip card window', () => {
  for (const cardId of CARD_IDS) {
    const composition = getTarotComposition(cardId)
    if (composition.kind !== 'pips') continue
    const buffer = renderTarotPixelFront(cardId)
    const sprite = decode(`pip-${composition.tarotSuit}`)
    const boxes = composition.pips.map((point) => toArt(getTarotPipBox(point)))
    assert.equal(boxes.length, Number(composition.rank))
    for (const box of boxes) {
      const origin = centred(box, sprite)
      for (let sy = 0; sy < sprite.height; sy += 1) {
        for (let sx = 0; sx < sprite.width; sx += 1) {
          const x = origin.x + sx
          const y = origin.y + sy
          assert.ok(inWindow(x, y), `${cardId} pip pixel ${x},${y} inside the window`)
          const key = sprite.at(sx, sy)
          const expected = key === '.' ? WINDOW : TAROT_PIXEL_PALETTE[key]
          assert.equal(hexAt(buffer, x, y), expected, `${cardId} pip at ${x},${y}`)
        }
      }
    }
    for (let y = 0; y < HEIGHT; y += 1) {
      for (let x = 0; x < WIDTH; x += 1) {
        if (!inWindow(x, y) || boxes.some((box) => inBox(box, x, y))) continue
        assert.equal(hexAt(buffer, x, y), WINDOW, `${cardId} window at ${x},${y}`)
      }
    }
  }
})

test('art stays inside the window, cartouche and index boxes over the frame', () => {
  const frame = decode('frame')
  for (const cardId of CARD_IDS) {
    const composition = getTarotComposition(cardId)
    const buffer = renderTarotPixelFront(cardId)
    let figurePixels = 0
    for (let y = 0; y < HEIGHT; y += 1) {
      for (let x = 0; x < WIDTH; x += 1) {
        const framed = frame.at(x, y)
        const expected = framed === '.' ? null : TAROT_PIXEL_PALETTE[framed]
        if (inWindow(x, y)) {
          if (hexAt(buffer, x, y) !== WINDOW) figurePixels += 1
          continue
        }
        if (inBox(CARTOUCHE_INTERIOR, x, y) || isIndexPixel(x, y)) continue
        assert.equal(hexAt(buffer, x, y), expected, `${cardId} frame at ${x},${y}`)
      }
    }
    if (composition.kind !== 'pips') {
      assert.ok(figurePixels > 200, `${cardId} draws a figure`)
    }
  }
})

test('the cartouche shows the numeral, sun or court title in gold', () => {
  const gold = new Set([TAROT_PIXEL_PALETTE.G, TAROT_PIXEL_PALETTE.Y])
  const interior = CARTOUCHE_INTERIOR
  const signatures = new Map()
  for (const cardId of CARD_IDS) {
    const composition = getTarotComposition(cardId)
    const buffer = renderTarotPixelFront(cardId)
    let signature = ''
    for (let y = interior.y; y < interior.y + interior.height; y += 1) {
      for (let x = interior.x; x < interior.x + interior.width; x += 1) {
        const hex = hexAt(buffer, x, y)
        assert.ok(hex === TAROT_PIXEL_PALETTE.N || gold.has(hex), `${cardId} at ${x},${y}`)
        signature += hex === TAROT_PIXEL_PALETTE.N ? '.' : '#'
      }
    }
    assert.match(signature, /#/)
    const label = composition.cartouche.text ?? composition.cartouche.kind
    if (signatures.has(label)) {
      assert.equal(signature, signatures.get(label), `${cardId} cartouche`)
    }
    signatures.set(label, signature)
  }
  assert.equal(new Set(signatures.values()).size, signatures.size)
  assert.equal(signatures.size, 13)
})

test('the back is 180° symmetric', () => {
  const back = renderTarotPixelBack()
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      assert.equal(hexAt(back, x, y), hexAt(back, ...rotate(x, y)), `back at ${x},${y}`)
    }
  }
})

test('create() upscales the art without smoothing and caps the texture at 600×840', () => {
  for (const [scale, size, contextScale] of [
    [1, [300, 420], 1],
    [2, [600, 840], 2],
    [3, [600, 840], 2],
    [4, [600, 840], 2],
  ]) {
    const harness = createCanvasHarness()
    const canvas = generateTarotPixelFront('c-QH', { scale, createCanvas: harness.createCanvas })
    assert.equal(canvas, harness.canvases[0])
    assert.deepEqual([canvas.width, canvas.height], size)
    const { operations } = canvas.context
    assert.deepEqual(operations.find(({ name }) => name === 'scale').args, [contextScale, contextScale])
    const smoothingOff = operations.findIndex(
      ({ name, args }) => name === 'imageSmoothingEnabled' && args[0] === false,
    )
    const draw = operations.findIndex(({ name }) => name === 'drawImage')
    assert.ok(smoothingOff >= 0 && smoothingOff < draw)
    assert.equal(operations[draw].smoothing, false)

    const scratch = harness.canvases[1]
    assert.deepEqual([scratch.width, scratch.height], [WIDTH, HEIGHT])
    assert.deepEqual(operations[draw].args, [scratch, 0, 0, WIDTH, HEIGHT, 0, 0, 300, 420])
    const put = scratch.context.operations.find(({ name }) => name === 'putImageData')
    assert.deepEqual(put.args[0].data, renderTarotPixelFront('c-QH').data)
    assert.deepEqual(put.args.slice(1), [0, 0])
  }

  const harness = createCanvasHarness()
  const back = generateTarotPixelBack({ createCanvas: harness.createCanvas })
  assert.deepEqual([back.width, back.height], [600, 840])
  const put = harness.canvases[1].context.operations.find(({ name }) => name === 'putImageData')
  assert.deepEqual(put.args[0].data, renderTarotPixelBack().data)
})

test('create() reuses one scratch canvas per canvas factory', () => {
  const harness = createCanvasHarness()
  generateTarotPixelFront('c-2S', { createCanvas: harness.createCanvas })
  generateTarotPixelFront('c-3S', { createCanvas: harness.createCanvas })
  generateTarotPixelBack({ createCanvas: harness.createCanvas })
  assert.deepEqual(
    harness.canvases.map(({ width, height }) => [width, height]),
    [[600, 840], [WIDTH, HEIGHT], [600, 840], [600, 840]],
  )
  const scratchPuts = harness.canvases[1].context.operations
    .filter(({ name }) => name === 'putImageData')
  assert.equal(scratchPuts.length, 3)
  assert.deepEqual(scratchPuts[1].args[0].data, renderTarotPixelFront('c-3S').data)
})

test('Tarot pixel generators reject invalid cards, scales, factories, and contexts', () => {
  const harness = createCanvasHarness()
  for (const cardId of ['c-1S', 'c-AS ', null]) {
    assert.throws(
      () => generateTarotPixelFront(cardId, { createCanvas: harness.createCanvas }),
      /Unknown Tarot card ID/,
    )
  }
  assert.throws(() => renderTarotPixelFront('c-1S'), /Unknown Tarot card ID/)
  for (const scale of [0, 1.5, 5, Number.NaN]) {
    assert.throws(
      () => generateTarotPixelBack({ scale, createCanvas: harness.createCanvas }),
      /scale/,
    )
    assert.throws(
      () => generateTarotPixelFront('c-AS', { scale, createCanvas: harness.createCanvas }),
      /scale/,
    )
  }
  assert.equal(harness.canvases.length, 0)
  assert.throws(() => generateTarotPixelBack(null), /options/)
  assert.throws(() => generateTarotPixelFront('c-AS', []), /options/)
  assert.throws(() => generateTarotPixelBack({ createCanvas: null }), /createCanvas/)
  assert.throws(() => generateTarotPixelBack({ createCanvas: () => ({}) }), /canvas-like/)
  assert.throws(
    () => generateTarotPixelBack({ createCanvas: () => ({ getContext: () => null }) }),
    /2D context/,
  )

  const scratchless = createCanvasHarness()
  const factory = (width, height) => (
    width === WIDTH ? {} : scratchless.createCanvas(width, height)
  )
  assert.throws(() => generateTarotPixelBack({ createCanvas: factory }), /canvas-like/)
})

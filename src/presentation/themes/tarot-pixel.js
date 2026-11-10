import { TAROT_PIXEL_PALETTE, TAROT_PIXEL_SPRITES } from './tarot-pixel-sprites.js'
import {
  TAROT_ART_UNIT,
  TAROT_LAYOUT,
  TAROT_LOGICAL_SIZE,
  TAROT_MAX_TEXTURE_SCALE,
  getTarotComposition,
  getTarotPipBox,
} from './tarot-composition.js'
import {
  assertTextureOptions,
  assertTextureScale,
  createBrowserCanvas,
  prepareCardSurface,
} from './canvas.js'

export const TAROT_PIXEL_FRONT_THEME_ID = 'tarot-pixel-front-v1'
export const TAROT_PIXEL_BACK_THEME_ID = 'tarot-pixel-back-v1'
export const DEFAULT_TAROT_PIXEL_TEXTURE_SCALE = 2
export const TAROT_PIXEL_ART_SIZE = Object.freeze({
  width: TAROT_LOGICAL_SIZE.width / TAROT_ART_UNIT,
  height: TAROT_LOGICAL_SIZE.height / TAROT_ART_UNIT,
})

const ART_WIDTH = TAROT_PIXEL_ART_SIZE.width
const ART_HEIGHT = TAROT_PIXEL_ART_SIZE.height
const TRANSPARENT_KEY = '.'
const NUMERAL_GAP = 1
const PALETTE_KEYS = Object.keys(TAROT_PIXEL_PALETTE)
const PALETTE_INDEX_BY_KEY = new Map(PALETTE_KEYS.map((key, index) => [key, index + 1]))
const PALETTE_INDEX_BY_HEX = new Map(
  PALETTE_KEYS.map((key, index) => [TAROT_PIXEL_PALETTE[key], index + 1]),
)
// Index 0 is transparent; palette entry n is index n + 1.
const PALETTE_RGB = new Uint8Array((PALETTE_KEYS.length + 1) * 3)
PALETTE_KEYS.forEach((key, index) => {
  const hex = TAROT_PIXEL_PALETTE[key]
  const offset = (index + 1) * 3
  PALETTE_RGB[offset] = Number.parseInt(hex.slice(1, 3), 16)
  PALETTE_RGB[offset + 1] = Number.parseInt(hex.slice(3, 5), 16)
  PALETTE_RGB[offset + 2] = Number.parseInt(hex.slice(5, 7), 16)
})

const toArtBox = ({ x, y, width, height }) => ({
  x: x / TAROT_ART_UNIT,
  y: y / TAROT_ART_UNIT,
  width: width / TAROT_ART_UNIT,
  height: height / TAROT_ART_UNIT,
})
const ART_WINDOW = toArtBox(TAROT_LAYOUT.window)
const ART_RANK_BOX = toArtBox(TAROT_LAYOUT.index.rank)
const ART_SUIT_BOX = toArtBox(TAROT_LAYOUT.index.suit)
const ART_CARTOUCHE = toArtBox(TAROT_LAYOUT.cartouche)
// Cartouche content sits inside its 1 px gold border.
const ART_CARTOUCHE_INTERIOR = {
  x: ART_CARTOUCHE.x + 1,
  y: ART_CARTOUCHE.y + 1,
  width: ART_CARTOUCHE.width - 2,
  height: ART_CARTOUCHE.height - 2,
}

const decodedSprites = new Map()

function decodeSprite(name) {
  const cached = decodedSprites.get(name)
  if (cached) return cached
  if (!Object.hasOwn(TAROT_PIXEL_SPRITES, name)) {
    throw new Error(`Missing Tarot pixel sprite: ${name}`)
  }
  const { width, height, rle } = TAROT_PIXEL_SPRITES[name]
  const pixels = new Uint8Array(width * height)
  let offset = 0
  for (let cursor = 0; cursor < rle.length;) {
    const key = rle[cursor]
    cursor += 1
    let run = 0
    while (cursor < rle.length && rle[cursor] >= '0' && rle[cursor] <= '9') {
      run = run * 10 + Number(rle[cursor])
      cursor += 1
    }
    const index = key === TRANSPARENT_KEY ? 0 : PALETTE_INDEX_BY_KEY.get(key)
    if (index === undefined) {
      throw new Error(`Tarot pixel sprite ${name} uses unknown palette key ${key}`)
    }
    const end = offset + Math.max(run, 1)
    if (end > pixels.length) {
      throw new Error(`Tarot pixel sprite ${name} overflows ${width}×${height}`)
    }
    pixels.fill(index, offset, end)
    offset = end
  }
  if (offset !== pixels.length) {
    throw new Error(`Tarot pixel sprite ${name} does not fill ${width}×${height}`)
  }
  const sprite = Object.freeze({ width, height, pixels })
  decodedSprites.set(name, sprite)
  return sprite
}

function createArtBuffer() {
  return {
    width: ART_WIDTH,
    height: ART_HEIGHT,
    data: new Uint8ClampedArray(ART_WIDTH * ART_HEIGHT * 4),
  }
}

function writePixel(buffer, x, y, paletteIndex) {
  if (x < 0 || y < 0 || x >= ART_WIDTH || y >= ART_HEIGHT) return
  const offset = (y * ART_WIDTH + x) * 4
  const color = paletteIndex * 3
  buffer.data[offset] = PALETTE_RGB[color]
  buffer.data[offset + 1] = PALETTE_RGB[color + 1]
  buffer.data[offset + 2] = PALETTE_RGB[color + 2]
  buffer.data[offset + 3] = 255
}

// Draws a sprite's opaque pixels; `color` recolours every opaque pixel, and
// `rotated` also draws the 180° copy about the card centre.
function blit(buffer, sprite, left, top, { color = null, rotated = false } = {}) {
  for (let y = 0; y < sprite.height; y += 1) {
    for (let x = 0; x < sprite.width; x += 1) {
      const index = sprite.pixels[y * sprite.width + x]
      if (index === 0) continue
      const paletteIndex = color ?? index
      writePixel(buffer, left + x, top + y, paletteIndex)
      if (rotated) {
        writePixel(buffer, ART_WIDTH - 1 - (left + x), ART_HEIGHT - 1 - (top + y), paletteIndex)
      }
    }
  }
}

const centerIn = (box, sprite) => ({
  x: box.x + Math.floor((box.width - sprite.width) / 2),
  y: box.y + Math.floor((box.height - sprite.height) / 2),
})

function drawCartouche(buffer, cartouche) {
  if (cartouche.kind === 'numeral') {
    const glyphs = [...cartouche.text].map((letter) => decodeSprite(`numeral-${letter}`))
    const width = glyphs.reduce((total, glyph) => total + glyph.width, 0)
      + NUMERAL_GAP * (glyphs.length - 1)
    const height = Math.max(...glyphs.map((glyph) => glyph.height))
    let { x } = centerIn(ART_CARTOUCHE_INTERIOR, { width, height })
    const { y } = centerIn(ART_CARTOUCHE_INTERIOR, { width, height })
    for (const glyph of glyphs) {
      blit(buffer, glyph, x, y + height - glyph.height)
      x += glyph.width + NUMERAL_GAP
    }
    return
  }
  const sprite = decodeSprite(
    cartouche.kind === 'sun' ? 'cartouche-sun' : `title-${cartouche.text.toLowerCase()}`,
  )
  const { x, y } = centerIn(ART_CARTOUCHE_INTERIOR, sprite)
  blit(buffer, sprite, x, y)
}

function drawFigure(buffer, composition) {
  const sprite = decodeSprite(composition.figureId)
  const { x, y } = centerIn(ART_WINDOW, sprite)
  // Courts stand on the window sill; Ace emblems float in the centre.
  const top = composition.kind === 'court'
    ? ART_WINDOW.y + ART_WINDOW.height - sprite.height
    : y
  blit(buffer, sprite, x, top)
}

function drawPips(buffer, composition) {
  const sprite = decodeSprite(`pip-${composition.tarotSuit}`)
  for (const point of composition.pips) {
    const { x, y } = centerIn(toArtBox(getTarotPipBox(point)), sprite)
    blit(buffer, sprite, x, y)
  }
}

function drawIndices(buffer, composition) {
  const color = PALETTE_INDEX_BY_HEX.get(composition.index.color)
  if (color === undefined) {
    throw new Error(`Tarot index colour ${composition.index.color} is not in the pixel palette`)
  }
  const rank = decodeSprite(`rank-${composition.rank}`)
  const suit = decodeSprite(`suit-${composition.suit}`)
  const rankPosition = centerIn(ART_RANK_BOX, rank)
  const suitPosition = centerIn(ART_SUIT_BOX, suit)
  blit(buffer, rank, rankPosition.x, rankPosition.y, { color, rotated: true })
  blit(buffer, suit, suitPosition.x, suitPosition.y, { color, rotated: true })
}

// Pure 75×105 RGBA render of a card front. Each call returns a new buffer.
export function renderTarotPixelFront(cardId) {
  const composition = getTarotComposition(cardId)
  const buffer = createArtBuffer()
  blit(buffer, decodeSprite('frame'), 0, 0)
  drawCartouche(buffer, composition.cartouche)
  if (composition.kind === 'pips') {
    drawPips(buffer, composition)
  } else {
    drawFigure(buffer, composition)
  }
  drawIndices(buffer, composition)
  return buffer
}

export function renderTarotPixelBack() {
  const buffer = createArtBuffer()
  blit(buffer, decodeSprite('back'), 0, 0)
  return buffer
}

const scratchSurfaces = new WeakMap()

// One 75×105 canvas per canvas factory carries each render to the GPU canvas.
function getScratchSurface(createCanvas) {
  const cached = scratchSurfaces.get(createCanvas)
  if (cached) return cached
  const canvas = createCanvas(ART_WIDTH, ART_HEIGHT)
  if (
    canvas === null
    || typeof canvas !== 'object'
    || typeof canvas.getContext !== 'function'
  ) {
    throw new TypeError('createCanvas must return a canvas-like object')
  }
  canvas.width = ART_WIDTH
  canvas.height = ART_HEIGHT
  const context = canvas.getContext('2d')
  if (context === null || typeof context !== 'object') {
    throw new Error('Canvas 2D context is unavailable')
  }
  const surface = {
    canvas,
    context,
    image: context.createImageData(ART_WIDTH, ART_HEIGHT),
  }
  scratchSurfaces.set(createCanvas, surface)
  return surface
}

function drawArt(options, render) {
  const {
    scale = DEFAULT_TAROT_PIXEL_TEXTURE_SCALE,
    createCanvas = createBrowserCanvas,
  } = options
  assertTextureScale(scale)
  const { canvas, context } = prepareCardSurface({
    scale: Math.min(scale, TAROT_MAX_TEXTURE_SCALE),
    createCanvas,
  })
  const scratch = getScratchSurface(createCanvas)
  scratch.image.data.set(render().data)
  scratch.context.putImageData(scratch.image, 0, 0)

  const { width, height } = TAROT_LOGICAL_SIZE
  context.clearRect(0, 0, width, height)
  context.imageSmoothingEnabled = false
  context.drawImage(scratch.canvas, 0, 0, ART_WIDTH, ART_HEIGHT, 0, 0, width, height)
  return canvas
}

export function generateTarotPixelFront(cardId, options = {}) {
  assertTextureOptions(options, 'Tarot pixel')
  getTarotComposition(cardId)
  return drawArt(options, () => renderTarotPixelFront(cardId))
}

export function generateTarotPixelBack(options = {}) {
  assertTextureOptions(options, 'Tarot pixel')
  return drawArt(options, renderTarotPixelBack)
}

export const TAROT_PIXEL_FRONT_THEME = Object.freeze({
  id: TAROT_PIXEL_FRONT_THEME_ID,
  create: generateTarotPixelFront,
})

export const TAROT_PIXEL_BACK_THEME = Object.freeze({
  id: TAROT_PIXEL_BACK_THEME_ID,
  create: generateTarotPixelBack,
})

import { getCard } from '../../domain/cards.js'

export const CLASSIC_FRONT_THEME_ID = 'classic-front-v1'
export const CLASSIC_BACK_THEME_ID = 'classic-back-v1'
export const CLASSIC_CARD_LOGICAL_SIZE = Object.freeze({
  width: 300,
  height: 420,
})
export const DEFAULT_CLASSIC_TEXTURE_SCALE = 2

const MAX_TEXTURE_SCALE = 4
const RED_SUIT_COLOR = '#b42336'
const DARK_SUIT_COLOR = '#18141f'
const SUIT_SYMBOLS = Object.freeze({
  S: '♠',
  H: '♥',
  D: '♦',
  C: '♣',
})

const PIP_LAYOUTS = Object.freeze({
  2: Object.freeze([[0.5, 0.27], [0.5, 0.73]]),
  3: Object.freeze([[0.5, 0.23], [0.5, 0.5], [0.5, 0.77]]),
  4: Object.freeze([
    [0.32, 0.27], [0.68, 0.27], [0.32, 0.73], [0.68, 0.73],
  ]),
  5: Object.freeze([
    [0.32, 0.23], [0.68, 0.23], [0.5, 0.5], [0.32, 0.77], [0.68, 0.77],
  ]),
  6: Object.freeze([
    [0.32, 0.22], [0.68, 0.22], [0.32, 0.5],
    [0.68, 0.5], [0.32, 0.78], [0.68, 0.78],
  ]),
  7: Object.freeze([
    [0.32, 0.2], [0.68, 0.2], [0.5, 0.36], [0.32, 0.5],
    [0.68, 0.5], [0.32, 0.8], [0.68, 0.8],
  ]),
  8: Object.freeze([
    [0.32, 0.19], [0.68, 0.19], [0.5, 0.34], [0.32, 0.5],
    [0.68, 0.5], [0.5, 0.66], [0.32, 0.81], [0.68, 0.81],
  ]),
  9: Object.freeze([
    [0.32, 0.18], [0.68, 0.18], [0.32, 0.39], [0.68, 0.39],
    [0.5, 0.5], [0.32, 0.61], [0.68, 0.61], [0.32, 0.82], [0.68, 0.82],
  ]),
  10: Object.freeze([
    [0.32, 0.17], [0.68, 0.17], [0.5, 0.29], [0.32, 0.39],
    [0.68, 0.39], [0.32, 0.61], [0.68, 0.61], [0.5, 0.71],
    [0.32, 0.83], [0.68, 0.83],
  ]),
})

function assertOptions(options) {
  if (
    options === null
    || typeof options !== 'object'
    || Array.isArray(options)
  ) {
    throw new TypeError('Classic texture options must be an object')
  }
}

function assertScale(scale) {
  if (!Number.isInteger(scale) || scale < 1 || scale > MAX_TEXTURE_SCALE) {
    throw new TypeError(`scale must be an integer from 1 through ${MAX_TEXTURE_SCALE}`)
  }
}

function createBrowserCanvas(width, height) {
  const canvas = globalThis.document?.createElement?.('canvas')
  if (!canvas) {
    throw new Error('Canvas creation is unavailable')
  }
  canvas.width = width
  canvas.height = height
  return canvas
}

function prepareSurface({ scale, createCanvas }) {
  assertScale(scale)
  if (typeof createCanvas !== 'function') {
    throw new TypeError('createCanvas must be a function')
  }

  const width = CLASSIC_CARD_LOGICAL_SIZE.width * scale
  const height = CLASSIC_CARD_LOGICAL_SIZE.height * scale
  const canvas = createCanvas(width, height)
  if (
    canvas === null
    || typeof canvas !== 'object'
    || typeof canvas.getContext !== 'function'
  ) {
    throw new TypeError('createCanvas must return a canvas-like object')
  }
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (context === null || typeof context !== 'object') {
    throw new Error('Canvas 2D context is unavailable')
  }
  context.scale(scale, scale)
  return { canvas, context }
}

function roundedRectangle(context, x, y, width, height, radius) {
  context.beginPath()
  context.moveTo(x + radius, y)
  context.lineTo(x + width - radius, y)
  context.quadraticCurveTo(x + width, y, x + width, y + radius)
  context.lineTo(x + width, y + height - radius)
  context.quadraticCurveTo(
    x + width,
    y + height,
    x + width - radius,
    y + height,
  )
  context.lineTo(x + radius, y + height)
  context.quadraticCurveTo(x, y + height, x, y + height - radius)
  context.lineTo(x, y + radius)
  context.quadraticCurveTo(x, y, x + radius, y)
  context.closePath()
}

function drawCardSurface(context) {
  const { width, height } = CLASSIC_CARD_LOGICAL_SIZE
  context.clearRect(0, 0, width, height)
  roundedRectangle(context, 4, 4, width - 8, height - 8, 18)
  context.fillStyle = '#fffdf7'
  context.fill()
  context.lineWidth = 5
  context.strokeStyle = '#d8cfbd'
  context.stroke()
  roundedRectangle(context, 12, 12, width - 24, height - 24, 13)
  context.lineWidth = 1.5
  context.strokeStyle = '#ece4d5'
  context.stroke()
}

function drawCornerIndex(context, rank, symbol, color) {
  context.save()
  context.fillStyle = color
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.font = '700 34px system-ui, sans-serif'
  context.fillText(rank, 35, 36)
  context.font = '32px serif'
  context.fillText(symbol, 35, 70)
  context.restore()

  context.save()
  context.translate(
    CLASSIC_CARD_LOGICAL_SIZE.width,
    CLASSIC_CARD_LOGICAL_SIZE.height,
  )
  context.rotate(Math.PI)
  context.fillStyle = color
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.font = '700 34px system-ui, sans-serif'
  context.fillText(rank, 35, 36)
  context.font = '32px serif'
  context.fillText(symbol, 35, 70)
  context.restore()
}

function drawPip(context, symbol, color, xRatio, yRatio, size = 57) {
  context.save()
  context.translate(
    CLASSIC_CARD_LOGICAL_SIZE.width * xRatio,
    CLASSIC_CARD_LOGICAL_SIZE.height * yRatio,
  )
  if (yRatio > 0.5) context.rotate(Math.PI)
  context.fillStyle = color
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.font = `${size}px serif`
  context.fillText(symbol, 0, 0)
  context.restore()
}

function drawNumberCard(context, rank, symbol, color) {
  for (const [x, y] of PIP_LAYOUTS[rank]) {
    drawPip(context, symbol, color, x, y)
  }
}

function drawFaceGeometry(context, rank, symbol, color) {
  roundedRectangle(context, 71, 88, 158, 244, 14)
  context.fillStyle = '#f4ead4'
  context.fill()
  context.lineWidth = 3
  context.strokeStyle = color
  context.stroke()

  context.beginPath()
  context.moveTo(78, 210)
  context.lineTo(222, 96)
  context.lineTo(222, 324)
  context.closePath()
  context.fillStyle = color
  context.globalAlpha = 0.16
  context.fill()
  context.globalAlpha = 1

  context.beginPath()
  context.arc(150, 181, 36, 0, Math.PI * 2)
  context.fillStyle = '#d9a56f'
  context.fill()

  context.beginPath()
  context.moveTo(109, 184)
  context.lineTo(124, 132)
  context.lineTo(150, 151)
  context.lineTo(176, 132)
  context.lineTo(191, 184)
  context.closePath()
  context.fillStyle = rank === 'J' ? '#365b78' : '#d2a51f'
  context.fill()

  if (rank === 'Q') {
    context.beginPath()
    context.arc(150, 222, 27, 0, Math.PI * 2)
    context.strokeStyle = '#6e3b78'
    context.lineWidth = 9
    context.stroke()
  } else if (rank === 'K') {
    context.fillStyle = '#365b78'
    context.fillRect(131, 211, 38, 72)
    context.fillStyle = '#d2a51f'
    context.fillRect(112, 238, 76, 13)
  } else {
    context.beginPath()
    context.moveTo(118, 283)
    context.lineTo(150, 217)
    context.lineTo(182, 283)
    context.closePath()
    context.fillStyle = '#365b78'
    context.fill()
  }

  context.fillStyle = color
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.font = '700 54px system-ui, sans-serif'
  context.fillText(rank, 150, 302)
  context.font = '42px serif'
  context.fillText(symbol, 150, 112)
}

function drawBackMotif(context) {
  context.strokeStyle = '#d7bb72'
  context.lineWidth = 2
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      const x = 72 + column * 52
      const y = 82 + row * 48
      context.beginPath()
      context.moveTo(x, y - 16)
      context.lineTo(x + 20, y)
      context.lineTo(x, y + 16)
      context.lineTo(x - 20, y)
      context.closePath()
      context.stroke()
    }
  }
}

export function generateClassicFront(cardId, options = {}) {
  assertOptions(options)
  const card = getCard(cardId)
  if (!card) {
    throw new RangeError(`Unknown classic card ID: ${String(cardId)}`)
  }
  const {
    scale = DEFAULT_CLASSIC_TEXTURE_SCALE,
    createCanvas = createBrowserCanvas,
  } = options
  const { canvas, context } = prepareSurface({ scale, createCanvas })
  const symbol = SUIT_SYMBOLS[card.suit]
  const color = card.suit === 'H' || card.suit === 'D'
    ? RED_SUIT_COLOR
    : DARK_SUIT_COLOR

  drawCardSurface(context)
  drawCornerIndex(context, card.rank, symbol, color)
  if (card.rank === 'A') {
    drawPip(context, symbol, color, 0.5, 0.5, 112)
  } else if (Object.hasOwn(PIP_LAYOUTS, card.rank)) {
    drawNumberCard(context, card.rank, symbol, color)
  } else {
    drawFaceGeometry(context, card.rank, symbol, color)
  }
  return canvas
}

export function generateClassicBack(options = {}) {
  assertOptions(options)
  const {
    scale = DEFAULT_CLASSIC_TEXTURE_SCALE,
    createCanvas = createBrowserCanvas,
  } = options
  const { canvas, context } = prepareSurface({ scale, createCanvas })
  const { width, height } = CLASSIC_CARD_LOGICAL_SIZE

  drawCardSurface(context)
  roundedRectangle(context, 25, 25, width - 50, height - 50, 14)
  context.fillStyle = '#28204f'
  context.fill()
  context.lineWidth = 5
  context.strokeStyle = '#b69442'
  context.stroke()

  context.save()
  roundedRectangle(context, 38, 38, width - 76, height - 76, 10)
  context.strokeStyle = '#6c5aa5'
  context.lineWidth = 3
  context.stroke()
  drawBackMotif(context)
  context.translate(width, height)
  context.rotate(Math.PI)
  drawBackMotif(context)
  context.restore()

  context.beginPath()
  context.arc(width / 2, height / 2, 54, 0, Math.PI * 2)
  context.fillStyle = '#171331'
  context.fill()
  context.strokeStyle = '#d7bb72'
  context.lineWidth = 5
  context.stroke()
  context.fillStyle = '#d7bb72'
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.font = '700 42px system-ui, sans-serif'
  context.fillText('S', width / 2, height / 2)
  return canvas
}

export const CLASSIC_FRONT_THEME = Object.freeze({
  id: CLASSIC_FRONT_THEME_ID,
  create: generateClassicFront,
})

export const CLASSIC_BACK_THEME = Object.freeze({
  id: CLASSIC_BACK_THEME_ID,
  create: generateClassicBack,
})

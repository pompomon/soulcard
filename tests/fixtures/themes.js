import { isCardId } from '../../src/domain/cards.js'

export const ALTERNATE_FRONT_THEME_ID = 'test-outline-front-v1'
export const ALTERNATE_BACK_THEME_ID = 'test-outline-back-v1'

function createSurface(scale, createCanvas) {
  if (!Number.isInteger(scale) || scale < 1 || scale > 4) {
    throw new TypeError('scale must be an integer from 1 through 4')
  }
  if (typeof createCanvas !== 'function') {
    throw new TypeError('createCanvas must be a function')
  }
  const canvas = createCanvas(48 * scale, 72 * scale)
  const context = canvas?.getContext?.('2d')
  if (!context) throw new Error('Canvas 2D context is unavailable')
  canvas.width = 48 * scale
  canvas.height = 72 * scale
  context.scale(scale, scale)
  return { canvas, context }
}

function createAlternateFront(cardId, {
  scale = 1,
  createCanvas,
} = {}) {
  if (!isCardId(cardId)) throw new RangeError(`Unknown card ID: ${String(cardId)}`)
  const { canvas, context } = createSurface(scale, createCanvas)
  context.fillStyle = '#f4f4f4'
  context.fillRect(0, 0, 48, 72)
  context.strokeStyle = '#222222'
  context.strokeRect(2, 2, 44, 68)
  context.fillStyle = '#222222'
  context.font = '10px sans-serif'
  context.fillText(cardId, 5, 14)
  return canvas
}

function createAlternateBack({
  scale = 1,
  createCanvas,
} = {}) {
  const { canvas, context } = createSurface(scale, createCanvas)
  context.fillStyle = '#244f66'
  context.fillRect(0, 0, 48, 72)
  context.strokeStyle = '#f4f4f4'
  context.strokeRect(4, 4, 40, 64)
  return canvas
}

export const ALTERNATE_FRONT_THEME = Object.freeze({
  id: ALTERNATE_FRONT_THEME_ID,
  create: createAlternateFront,
})

export const ALTERNATE_BACK_THEME = Object.freeze({
  id: ALTERNATE_BACK_THEME_ID,
  create: createAlternateBack,
})

export const ALTERNATE_THEME_SELECTION = Object.freeze({
  frontThemeId: ALTERNATE_FRONT_THEME_ID,
  backThemeId: ALTERNATE_BACK_THEME_ID,
})

export const UNKNOWN_THEME_SELECTION = Object.freeze({
  frontThemeId: 'missing-front-v1',
  backThemeId: 'missing-back-v1',
})

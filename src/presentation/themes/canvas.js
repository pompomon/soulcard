// Canvas helpers shared by card themes. Every theme draws in 300×420 logical px
// and receives an integer texture scale from the texture cache.
export const CARD_TEXTURE_LOGICAL_SIZE = Object.freeze({
  width: 300,
  height: 420,
})
export const MAX_CARD_TEXTURE_SCALE = 4

export function assertTextureOptions(options, themeLabel) {
  if (
    options === null
    || typeof options !== 'object'
    || Array.isArray(options)
  ) {
    throw new TypeError(`${themeLabel} texture options must be an object`)
  }
}

export function assertTextureScale(scale) {
  if (!Number.isInteger(scale) || scale < 1 || scale > MAX_CARD_TEXTURE_SCALE) {
    throw new TypeError(
      `scale must be an integer from 1 through ${MAX_CARD_TEXTURE_SCALE}`,
    )
  }
}

export function createBrowserCanvas(width, height) {
  const canvas = globalThis.document?.createElement?.('canvas')
  if (!canvas) {
    throw new Error('Canvas creation is unavailable')
  }
  canvas.width = width
  canvas.height = height
  return canvas
}

// Creates a canvas of logical size × scale whose context draws in logical px.
export function prepareCardSurface({ scale, createCanvas }) {
  assertTextureScale(scale)
  if (typeof createCanvas !== 'function') {
    throw new TypeError('createCanvas must be a function')
  }

  const width = CARD_TEXTURE_LOGICAL_SIZE.width * scale
  const height = CARD_TEXTURE_LOGICAL_SIZE.height * scale
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

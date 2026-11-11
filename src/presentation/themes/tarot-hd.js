import { TAROT_LOGICAL_SIZE, TAROT_MAX_TEXTURE_SCALE, getTarotComposition } from './tarot-composition.js'
import {
  TAROT_HD_ASSET_IDS,
  TAROT_HD_BACK_ID,
  TAROT_HD_IMAGE_SIZE,
  TAROT_HD_PREVIEW_ID,
  TAROT_HD_PREVIEW_LAYOUT,
  getTarotHdPreviewCell,
} from './tarot-hd-layout.js'
import { TAROT_PIXEL_BACK_THEME, TAROT_PIXEL_FRONT_THEME } from './tarot-pixel.js'
import {
  assertTextureOptions,
  assertTextureScale,
  createBrowserCanvas,
  prepareCardSurface,
} from './canvas.js'

export const TAROT_HD_FRONT_THEME_ID = 'tarot-hd-front-v1'
export const TAROT_HD_BACK_THEME_ID = 'tarot-hd-back-v1'
export const DEFAULT_TAROT_HD_TEXTURE_SCALE = 2
// Each full-size decode holds about 2 MB until it is drawn and closed.
export const TAROT_HD_DECODE_CONCURRENCY = 2

export class TarotHdArtError extends Error {
  constructor(code, message, { assetId = null, cause = undefined } = {}) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'TarotHdArtError'
    this.code = code
    this.assetId = assetId
  }
}

const PREVIEW_SIZE = Object.freeze({
  width: TAROT_HD_PREVIEW_LAYOUT.width,
  height: TAROT_HD_PREVIEW_LAYOUT.height,
})

function decodeImageBitmap(blob) {
  if (typeof globalThis.createImageBitmap !== 'function') {
    throw new Error('createImageBitmap is unavailable')
  }
  return globalThis.createImageBitmap(blob)
}

function assertFallback(descriptor, label) {
  if (descriptor === null || typeof descriptor !== 'object' || typeof descriptor.create !== 'function') {
    throw new TypeError(`${label} must be a theme descriptor with create()`)
  }
}

function assertActivation({ store, manifest, signal }) {
  if (store === null || typeof store !== 'object' || typeof store.read !== 'function') {
    throw new TypeError('store must provide read(id)')
  }
  if (
    !Array.isArray(manifest)
    || manifest.length !== TAROT_HD_ASSET_IDS.length
    || manifest.some((entry, index) => entry?.id !== TAROT_HD_ASSET_IDS[index])
  ) {
    throw new TypeError('manifest must list the Tarot HD assets in pack order')
  }
  if (signal !== undefined && (signal === null || typeof signal.aborted !== 'boolean')) {
    throw new TypeError('signal must be an AbortSignal or undefined')
  }
}

function abortError(message) {
  return new DOMException(message, 'AbortError')
}

function closeBitmap(bitmap) {
  try {
    bitmap?.close?.()
  } catch {}
}

function createLimiter(limit) {
  let active = 0
  const queue = []
  function pump() {
    while (active < limit && queue.length > 0) {
      const { task, resolve, reject } = queue.shift()
      active += 1
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          active -= 1
          pump()
        })
    }
  }
  return (task) => new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject })
    pump()
  })
}

function drawSmoothed(context, image, source, width, height) {
  context.clearRect(0, 0, width, height)
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(image, source.x, source.y, source.width, source.height, 0, 0, width, height)
}

// Draws a decoded image over the whole canvas that create() returned, in device
// pixels, whatever transform the context carries.
function drawFullImage(canvas, bitmap) {
  const context = canvas.getContext('2d')
  if (context === null || typeof context !== 'object') {
    throw new Error('Canvas 2D context is unavailable')
  }
  context.save()
  try {
    context.setTransform(1, 0, 0, 1, 0, 0)
    drawSmoothed(
      context,
      bitmap,
      { x: 0, y: 0, width: bitmap.width, height: bitmap.height },
      canvas.width,
      canvas.height,
    )
  } finally {
    context.restore()
  }
}

// The HD deck's texture descriptors. They are created once and registered once;
// activate() points them at a downloaded pack and release() returns them to the
// pixel deck, so the registry never needs to unregister a theme.
export function createTarotHdThemes({
  decode = decodeImageBitmap,
  fallbackFront = TAROT_PIXEL_FRONT_THEME,
  fallbackBack = TAROT_PIXEL_BACK_THEME,
} = {}) {
  if (typeof decode !== 'function') throw new TypeError('decode must be a function')
  assertFallback(fallbackFront, 'fallbackFront')
  assertFallback(fallbackBack, 'fallbackBack')

  const limit = createLimiter(TAROT_HD_DECODE_CONCURRENCY)
  let activation = null
  let generation = 0

  async function readBitmap(store, id, expected) {
    let blob
    try {
      blob = await store.read(id)
    } catch (error) {
      throw new TarotHdArtError('missing', `Tarot HD art ${id} is unavailable`, { assetId: id, cause: error })
    }
    let bitmap
    try {
      bitmap = await decode(blob)
    } catch (error) {
      throw new TarotHdArtError('decode', `Could not decode Tarot HD art ${id}`, { assetId: id, cause: error })
    }
    if (bitmap?.width !== expected.width || bitmap?.height !== expected.height) {
      closeBitmap(bitmap)
      throw new TarotHdArtError(
        'decode',
        `Tarot HD art ${id} decoded at ${bitmap?.width}×${bitmap?.height}, not ${expected.width}×${expected.height}`,
        { assetId: id },
      )
    }
    return bitmap
  }

  function closeActivation() {
    const current = activation
    activation = null
    if (!current) return
    closeBitmap(current.preview)
    closeBitmap(current.back)
  }

  // Decodes the preview atlas and the back, then switches the descriptors to the
  // pack. A later activate() or release() supersedes an activation in progress.
  async function activate({ store, manifest, signal = undefined } = {}) {
    assertActivation({ store, manifest, signal })
    if (signal?.aborted) throw abortError('Tarot HD activation was aborted')
    generation += 1
    const token = generation
    const results = await Promise.allSettled([
      limit(() => readBitmap(store, TAROT_HD_PREVIEW_ID, PREVIEW_SIZE)),
      limit(() => readBitmap(store, TAROT_HD_BACK_ID, TAROT_HD_IMAGE_SIZE)),
    ])
    const bitmaps = results.filter(({ status }) => status === 'fulfilled').map(({ value }) => value)
    let error = results.find(({ status }) => status === 'rejected')?.reason
    if (!error && signal?.aborted) error = abortError('Tarot HD activation was aborted')
    if (!error && token !== generation) error = abortError('Tarot HD activation was superseded')
    if (error) {
      bitmaps.forEach(closeBitmap)
      throw error
    }
    closeActivation()
    const [preview, back] = bitmaps
    activation = Object.freeze({ store, preview, back })
  }

  function release() {
    generation += 1
    closeActivation()
  }

  function prepare(options) {
    assertTextureOptions(options, 'Tarot HD')
    const {
      scale = DEFAULT_TAROT_HD_TEXTURE_SCALE,
      createCanvas = createBrowserCanvas,
    } = options
    assertTextureScale(scale)
    return prepareCardSurface({ scale: Math.min(scale, TAROT_MAX_TEXTURE_SCALE), createCanvas })
  }

  function createFront(cardId, options = {}) {
    getTarotComposition(cardId)
    const current = activation
    if (!current) return fallbackFront.create(cardId, options)
    const { canvas, context } = prepare(options)
    const { width, height } = TAROT_LOGICAL_SIZE
    drawSmoothed(context, current.preview, getTarotHdPreviewCell(cardId), width, height)
    return canvas
  }

  function createBack(options = {}) {
    const current = activation
    if (!current) return fallbackBack.create(options)
    const { canvas, context } = prepare(options)
    const { width, height } = TAROT_LOGICAL_SIZE
    drawSmoothed(context, current.back, { x: 0, y: 0, ...TAROT_HD_IMAGE_SIZE }, width, height)
    return canvas
  }

  // Replaces the preview with the full image in the same canvas. Resolves without
  // drawing when the refinement was aborted or the pack was released meanwhile.
  async function refineFront(cardId, { canvas, signal } = {}) {
    getTarotComposition(cardId)
    if (canvas === null || typeof canvas !== 'object' || typeof canvas.getContext !== 'function') {
      throw new TypeError('canvas must be the canvas that create() returned')
    }
    const current = activation
    const stale = () => signal?.aborted === true || activation !== current
    if (!current || stale()) return
    const bitmap = await limit(() => (stale() ? null : readBitmap(current.store, cardId, TAROT_HD_IMAGE_SIZE)))
    if (!bitmap) return
    try {
      if (!stale()) drawFullImage(canvas, bitmap)
    } finally {
      closeBitmap(bitmap)
    }
  }

  const frontTheme = Object.freeze({
    id: TAROT_HD_FRONT_THEME_ID,
    create: createFront,
    refine: refineFront,
  })
  const backTheme = Object.freeze({
    id: TAROT_HD_BACK_THEME_ID,
    create: createBack,
  })

  return Object.freeze({
    frontTheme,
    backTheme,
    activate,
    release,
    get active() {
      return activation !== null
    },
  })
}

import * as THREE from 'three'
import { isCardId } from '../domain/cards.js'
import { DEFAULT_CLASSIC_TEXTURE_SCALE } from './themes/classic.js'
import { createThemeRegistry, isThemeId } from './themes/registry.js'

const TEXTURE_KINDS = Object.freeze(['front', 'back'])
const MAX_TEXTURE_SCALE = 4

export class TextureCacheCapacityError extends Error {
  constructor(maxEntries) {
    super(`Texture cache capacity ${maxEntries} is fully leased`)
    this.name = 'TextureCacheCapacityError'
    this.maxEntries = maxEntries
  }
}

function assertRegistry(registry) {
  if (
    registry === null
    || typeof registry !== 'object'
    || typeof registry.resolveFront !== 'function'
    || typeof registry.resolveBack !== 'function'
    || !isThemeId(registry.fallbackFrontThemeId)
    || !isThemeId(registry.fallbackBackThemeId)
  ) {
    throw new TypeError('registry must implement the theme registry interface')
  }
}

function assertMaxEntries(maxEntries) {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new TypeError('maxEntries must be a positive integer')
  }
}

function assertScale(scale) {
  if (!Number.isInteger(scale) || scale < 1 || scale > MAX_TEXTURE_SCALE) {
    throw new TypeError(`scale must be an integer from 1 through ${MAX_TEXTURE_SCALE}`)
  }
}

function assertRequestedAnisotropy(anisotropy) {
  if (!Number.isFinite(anisotropy) || anisotropy < 1) {
    throw new TypeError('anisotropy must be a finite number of at least 1')
  }
}

function supportedAnisotropy(renderer) {
  if (renderer === undefined || renderer === null) return 1
  const capabilities = renderer.capabilities
  if (
    capabilities === null
    || typeof capabilities !== 'object'
    || typeof capabilities.getMaxAnisotropy !== 'function'
  ) {
    throw new TypeError('renderer must expose capabilities.getMaxAnisotropy')
  }
  const supported = capabilities.getMaxAnisotropy()
  if (!Number.isFinite(supported) || supported < 0) {
    throw new TypeError('renderer anisotropy capability must be a finite non-negative number')
  }
  return Math.max(1, supported)
}

function defaultTextureFactory(canvas) {
  return new THREE.CanvasTexture(canvas)
}

function textureKey(kind, themeId, cardId, scale) {
  return JSON.stringify([kind, themeId, cardId ?? null, scale])
}

function refinementFailureReason(error) {
  if (typeof error?.code === 'string' && error.code.length > 0) return error.code
  if (typeof error?.name === 'string' && error.name.length > 0) return error.name
  return 'unknown'
}

function notify(callback, value) {
  try {
    callback(value)
  } catch {}
}

function clearTextureImage(texture, canvas) {
  try {
    if (texture.image === canvas || texture.image !== null) {
      texture.image = null
    }
  } catch {}
  try {
    if (texture.source?.data === canvas) {
      texture.source.data = null
    }
  } catch {}
}

export function createTextureCache({
  registry = createThemeRegistry(),
  maxEntries = 16,
  renderer = undefined,
  anisotropy = 4,
  createCanvas = undefined,
  textureFactory = defaultTextureFactory,
  onTextureUpdate = () => {},
  onDiagnostic = () => {},
} = {}) {
  assertRegistry(registry)
  assertMaxEntries(maxEntries)
  assertRequestedAnisotropy(anisotropy)
  if (createCanvas !== undefined && typeof createCanvas !== 'function') {
    throw new TypeError('createCanvas must be a function or undefined')
  }
  if (typeof textureFactory !== 'function') {
    throw new TypeError('textureFactory must be a function')
  }
  if (typeof onTextureUpdate !== 'function') {
    throw new TypeError('onTextureUpdate must be a function')
  }
  if (typeof onDiagnostic !== 'function') {
    throw new TypeError('onDiagnostic must be a function')
  }
  const appliedAnisotropy = Math.min(anisotropy, supportedAnisotropy(renderer))
  const entries = new Map()
  let destroyed = false

  function assertActive() {
    if (destroyed) throw new Error('Texture cache has been destroyed')
  }

  function touch(key, entry) {
    entries.delete(key)
    entries.set(key, entry)
  }

  function abortRefinement(entry) {
    const controller = entry.refinement
    if (!controller) return
    entry.refinement = null
    try {
      controller.abort()
    } catch {}
  }

  function disposeEntry(key, entry) {
    entries.delete(key)
    if (entry.disposed) return
    entry.disposed = true
    abortRefinement(entry)
    let error = null
    try {
      entry.texture.dispose()
    } catch (cause) {
      error = cause
    } finally {
      clearTextureImage(entry.texture, entry.canvas)
      entry.canvas = null
    }
    if (error) throw error
  }

  function disposeEntries(candidates) {
    let firstError = null
    for (const [key, entry] of candidates) {
      try {
        disposeEntry(key, entry)
      } catch (error) {
        firstError ??= error
      }
    }
    if (firstError) throw firstError
  }

  function makeSpace() {
    while (entries.size >= maxEntries) {
      const candidate = [...entries].find(([, entry]) => entry.leases === 0)
      if (!candidate) throw new TextureCacheCapacityError(maxEntries)
      disposeEntry(...candidate)
    }
  }

  function configureTexture(texture) {
    texture.colorSpace = THREE.SRGBColorSpace
    texture.minFilter = THREE.LinearMipmapLinearFilter
    texture.magFilter = THREE.LinearFilter
    texture.generateMipmaps = true
    texture.anisotropy = appliedAnisotropy
    texture.needsUpdate = true
  }

  function finishRefinement(entry, controller) {
    if (entry.refinement === controller) entry.refinement = null
    if (controller.signal.aborted || entry.disposed || entries.get(entry.key) !== entry) {
      return
    }
    // Refinement redraws the same canvas at the same size, so one re-upload suffices.
    entry.texture.needsUpdate = true
    notify(onTextureUpdate, Object.freeze({
      kind: entry.kind,
      themeId: entry.themeId,
      cardId: entry.cardId,
      scale: entry.scale,
    }))
  }

  function failRefinement(entry, controller, error) {
    if (entry.refinement === controller) entry.refinement = null
    if (controller.signal.aborted || error?.name === 'AbortError') return
    notify(onDiagnostic, Object.freeze({
      type: 'texture-refine-failed',
      kind: entry.kind,
      themeId: entry.themeId,
      cardId: entry.cardId,
      reason: refinementFailureReason(error),
    }))
  }

  function startRefinement(entry, refine) {
    const controller = new AbortController()
    entry.refinement = controller
    const options = { scale: entry.scale, canvas: entry.canvas, signal: controller.signal }
    // Refinement starts after acquire() returns, so it never delays the first frame.
    Promise.resolve()
      .then(() => {
        if (controller.signal.aborted) return undefined
        return entry.kind === 'front' ? refine(entry.cardId, options) : refine(options)
      })
      .then(
        () => finishRefinement(entry, controller),
        (error) => failRefinement(entry, controller, error),
      )
  }

  function createEntry({ kind, descriptor, cardId, scale, key }) {
    makeSpace()
    const generatorOptions = createCanvas === undefined
      ? { scale }
      : { scale, createCanvas }
    const canvas = kind === 'front'
      ? descriptor.create(cardId, generatorOptions)
      : descriptor.create(generatorOptions)
    if (
      canvas === null
      || typeof canvas !== 'object'
      || !Number.isInteger(canvas.width)
      || canvas.width < 1
      || !Number.isInteger(canvas.height)
      || canvas.height < 1
    ) {
      throw new TypeError('Theme generator must return a sized canvas')
    }
    let texture
    try {
      texture = textureFactory(canvas)
      if (
        texture === null
        || typeof texture !== 'object'
        || typeof texture.dispose !== 'function'
      ) {
        throw new TypeError('textureFactory must return a disposable texture')
      }
      configureTexture(texture)
    } catch (error) {
      if (texture && typeof texture.dispose === 'function') {
        try {
          texture.dispose()
        } catch {}
        clearTextureImage(texture, canvas)
      }
      throw error
    }

    const entry = {
      key,
      kind,
      themeId: descriptor.id,
      cardId,
      scale,
      canvas,
      texture,
      leases: 0,
      disposed: false,
      refinement: null,
    }
    entries.set(key, entry)
    if (typeof descriptor.refine === 'function') startRefinement(entry, descriptor.refine)
    return entry
  }

  function createLease(entry) {
    entry.leases += 1
    let released = false
    return Object.freeze({
      key: entry.key,
      kind: entry.kind,
      themeId: entry.themeId,
      cardId: entry.cardId,
      scale: entry.scale,
      texture: entry.texture,
      release() {
        if (released) return
        released = true
        if (entries.get(entry.key) === entry && entry.leases > 0) {
          entry.leases -= 1
        }
      },
    })
  }

  function acquire(kind, {
    themeId,
    cardId = null,
    scale = DEFAULT_CLASSIC_TEXTURE_SCALE,
  }) {
    assertActive()
    assertScale(scale)
    if (kind === 'front' && !isCardId(cardId)) {
      throw new RangeError(`Unknown card ID: ${String(cardId)}`)
    }
    const normalizedCardId = kind === 'front' ? cardId : null
    const descriptor = kind === 'front'
      ? registry.resolveFront(
        themeId === undefined ? registry.fallbackFrontThemeId : themeId,
      )
      : registry.resolveBack(
        themeId === undefined ? registry.fallbackBackThemeId : themeId,
      )
    const key = textureKey(kind, descriptor.id, normalizedCardId, scale)
    let entry = entries.get(key)
    if (entry) {
      touch(key, entry)
    } else {
      entry = createEntry({ kind, descriptor, cardId: normalizedCardId, scale, key })
    }
    return createLease(entry)
  }

  function invalidateTheme(kind, themeId) {
    assertActive()
    if (!TEXTURE_KINDS.includes(kind)) {
      throw new RangeError(`Unknown texture kind: ${String(kind)}`)
    }
    if (!isThemeId(themeId)) {
      throw new TypeError('themeId is invalid')
    }
    const candidates = [...entries].filter(
      ([, entry]) => entry.kind === kind && entry.themeId === themeId,
    )
    disposeEntries(candidates)
    return candidates.length
  }

  function clear() {
    assertActive()
    disposeEntries([...entries])
  }

  return Object.freeze({
    acquireFront(options = {}) {
      if (options === null || typeof options !== 'object' || Array.isArray(options)) {
        throw new TypeError('Front texture options must be an object')
      }
      return acquire('front', options)
    },
    acquireBack(options = {}) {
      if (options === null || typeof options !== 'object' || Array.isArray(options)) {
        throw new TypeError('Back texture options must be an object')
      }
      return acquire('back', options)
    },
    invalidateTheme,
    clear,
    destroy() {
      if (destroyed) return
      let error = null
      try {
        disposeEntries([...entries])
      } catch (cause) {
        error = cause
      } finally {
        destroyed = true
      }
      if (error) throw error
    },
    getStats() {
      let activeLeases = 0
      let leasedEntries = 0
      let refining = 0
      for (const entry of entries.values()) {
        activeLeases += entry.leases
        if (entry.leases > 0) leasedEntries += 1
        if (entry.refinement) refining += 1
      }
      return Object.freeze({
        entries: entries.size,
        maxEntries,
        activeLeases,
        leasedEntries,
        refining,
        anisotropy: appliedAnisotropy,
        destroyed,
      })
    },
  })
}

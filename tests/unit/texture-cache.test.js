import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'
import { CARD_IDS } from '../../src/domain/cards.js'
import {
  TextureCacheCapacityError,
  createTextureCache,
} from '../../src/presentation/texture-cache.js'
import { createThemeRegistry } from '../../src/presentation/themes/registry.js'
import {
  ALTERNATE_BACK_THEME,
  ALTERNATE_FRONT_THEME,
} from '../fixtures/themes.js'

function createCanvas(width, height) {
  const operations = []
  const context = {
    operations,
    scale(...args) { operations.push(['scale', ...args]) },
    fillRect(...args) { operations.push(['fillRect', ...args]) },
    strokeRect(...args) { operations.push(['strokeRect', ...args]) },
    fillText(...args) { operations.push(['fillText', ...args]) },
  }
  return {
    width,
    height,
    context,
    getContext: () => context,
  }
}

class FakeTexture {
  constructor(canvas) {
    this.image = canvas
    this.disposeCalls = 0
  }

  dispose() {
    this.disposeCalls += 1
  }
}

function createHarness(options = {}) {
  const textures = []
  const registry = createThemeRegistry({
    frontThemes: [ALTERNATE_FRONT_THEME],
    backThemes: [ALTERNATE_BACK_THEME],
  })
  const cache = createTextureCache({
    registry,
    createCanvas,
    textureFactory(canvas) {
      const texture = new FakeTexture(canvas)
      textures.push(texture)
      return texture
    },
    ...options,
  })
  return { cache, registry, textures }
}

function frontOptions(cardId, scale = 1) {
  return {
    themeId: ALTERNATE_FRONT_THEME.id,
    cardId,
    scale,
  }
}

const REFINED_FRONT_ID = 'refined-front-v1'
const REFINED_BACK_ID = 'refined-back-v1'
const THROWING_FRONT_ID = 'throwing-front-v1'

class CountingTexture extends FakeTexture {
  constructor(canvas) {
    super(canvas)
    this.uploads = 0
  }

  get needsUpdate() {
    return false
  }

  set needsUpdate(value) {
    if (value === true) this.uploads += 1
  }
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve))
}

function createRefiningHarness(options = {}) {
  const textures = []
  const calls = []
  const updates = []
  const diagnostics = []
  function recordRefinement(kind) {
    return (...args) => {
      const call = { kind, args, ...Promise.withResolvers() }
      calls.push(call)
      return call.promise
    }
  }
  const registry = createThemeRegistry({
    frontThemes: [
      ALTERNATE_FRONT_THEME,
      {
        id: REFINED_FRONT_ID,
        create: ALTERNATE_FRONT_THEME.create,
        refine: recordRefinement('front'),
      },
      {
        id: THROWING_FRONT_ID,
        create: ALTERNATE_FRONT_THEME.create,
        refine() {
          throw new Error('refine threw')
        },
      },
    ],
    backThemes: [{
      id: REFINED_BACK_ID,
      create: ALTERNATE_BACK_THEME.create,
      refine: recordRefinement('back'),
    }],
  })
  const cache = createTextureCache({
    registry,
    createCanvas,
    textureFactory(canvas) {
      const texture = new CountingTexture(canvas)
      textures.push(texture)
      return texture
    },
    onTextureUpdate: (update) => updates.push(update),
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    ...options,
  })
  return { cache, calls, diagnostics, textures, updates }
}

function refinedFront(cardId, scale = 1) {
  return { themeId: REFINED_FRONT_ID, cardId, scale }
}

test('cache lazily reuses keyed textures and applies documented sampler settings', () => {
  const { cache, textures } = createHarness({
    maxEntries: 4,
    anisotropy: 8,
    renderer: {
      capabilities: {
        getMaxAnisotropy: () => 3,
      },
    },
  })
  assert.deepEqual(cache.getStats(), {
    entries: 0,
    maxEntries: 4,
    activeLeases: 0,
    leasedEntries: 0,
    refining: 0,
    anisotropy: 3,
    destroyed: false,
  })

  const first = cache.acquireFront(frontOptions('c-2S'))
  const repeated = cache.acquireFront(frontOptions('c-2S'))
  assert.equal(textures.length, 1)
  assert.equal(first.texture, repeated.texture)
  assert.equal(first.themeId, ALTERNATE_FRONT_THEME.id)
  assert.equal(first.cardId, 'c-2S')
  assert.equal(first.texture.colorSpace, THREE.SRGBColorSpace)
  assert.equal(first.texture.minFilter, THREE.LinearMipmapLinearFilter)
  assert.equal(first.texture.magFilter, THREE.LinearFilter)
  assert.equal(first.texture.generateMipmaps, true)
  assert.equal(first.texture.anisotropy, 3)
  assert.equal(first.texture.needsUpdate, true)
  assert.equal(cache.getStats().activeLeases, 2)

  const highResolution = cache.acquireFront(frontOptions('c-2S', 2))
  assert.notEqual(highResolution.texture, first.texture)
  assert.equal(textures.length, 2)
  assert.notEqual(highResolution.key, first.key)

  first.release()
  first.release()
  repeated.release()
  highResolution.release()
  assert.equal(cache.getStats().activeLeases, 0)
  cache.destroy()
  assert.ok(textures.every(({ disposeCalls, image }) => disposeCalls === 1 && image === null))
})

test('cache uses baseline anisotropy when the renderer reports no extension support', () => {
  const { cache } = createHarness({
    anisotropy: 8,
    renderer: {
      capabilities: {
        getMaxAnisotropy: () => 0,
      },
    },
  })

  assert.equal(cache.getStats().anisotropy, 1)
  const lease = cache.acquireFront(frontOptions('c-2S'))
  assert.equal(lease.texture.anisotropy, 1)
  lease.release()
  cache.destroy()
})

test('LRU eviction refreshes reused entries and disposes released textures once', () => {
  const { cache, textures } = createHarness({ maxEntries: 2 })
  const first = cache.acquireFront(frontOptions('c-2S'))
  first.release()
  const second = cache.acquireFront(frontOptions('c-3S'))
  second.release()

  const refreshed = cache.acquireFront(frontOptions('c-2S'))
  assert.equal(refreshed.texture, first.texture)
  refreshed.release()
  const third = cache.acquireFront(frontOptions('c-4S'))
  third.release()

  assert.equal(textures.length, 3)
  assert.equal(first.texture.disposeCalls, 0)
  assert.equal(second.texture.disposeCalls, 1)
  assert.equal(second.texture.image, null)
  assert.equal(third.texture.disposeCalls, 0)
  assert.equal(cache.getStats().entries, 2)

  cache.destroy()
  assert.equal(first.texture.disposeCalls, 1)
  assert.equal(second.texture.disposeCalls, 1)
  assert.equal(third.texture.disposeCalls, 1)
})

test('capacity eviction protects active leases and fails before generating a texture', () => {
  const { cache, textures } = createHarness({ maxEntries: 2 })
  const first = cache.acquireFront(frontOptions('c-2S'))
  const second = cache.acquireFront(frontOptions('c-3S'))
  assert.throws(
    () => cache.acquireFront(frontOptions('c-4S')),
    (error) => (
      error instanceof TextureCacheCapacityError
      && error.maxEntries === 2
    ),
  )
  assert.equal(textures.length, 2)
  assert.equal(first.texture.disposeCalls, 0)
  assert.equal(second.texture.disposeCalls, 0)

  first.release()
  const third = cache.acquireFront(frontOptions('c-4S'))
  assert.equal(textures.length, 3)
  assert.equal(first.texture.disposeCalls, 1)
  assert.equal(second.texture.disposeCalls, 0)
  second.release()
  third.release()
  cache.destroy()
})

test('complete-deck traversal plus a back remains bounded and regenerable', () => {
  const { cache, textures } = createHarness({ maxEntries: 8 })
  for (const cardId of CARD_IDS) {
    cache.acquireFront(frontOptions(cardId)).release()
    assert.ok(cache.getStats().entries <= 8)
  }
  assert.equal(textures.length, 52)
  assert.equal(cache.getStats().entries, 8)
  assert.equal(textures.filter(({ disposeCalls }) => disposeCalls === 1).length, 44)

  const back = cache.acquireBack({
    themeId: ALTERNATE_BACK_THEME.id,
    scale: 2,
  })
  back.release()
  assert.equal(textures.length, 53)
  assert.equal(cache.getStats().entries, 8)
  assert.equal(textures.filter(({ disposeCalls }) => disposeCalls === 1).length, 45)

  cache.destroy()
  assert.equal(textures.filter(({ disposeCalls }) => disposeCalls === 1).length, 53)
})

test('back acquisitions ignore card IDs and reuse the same texture', () => {
  const { cache, textures } = createHarness()
  const first = cache.acquireBack({
    themeId: ALTERNATE_BACK_THEME.id,
    cardId: 'c-2S',
    scale: 1,
  })
  const second = cache.acquireBack({
    themeId: ALTERNATE_BACK_THEME.id,
    cardId: 'c-AS',
    scale: 1,
  })

  assert.equal(textures.length, 1)
  assert.equal(second.texture, first.texture)
  assert.equal(second.key, first.key)
  assert.equal(first.cardId, null)
  assert.equal(second.cardId, null)

  first.release()
  second.release()
  cache.destroy()
})

test('theme invalidation and clear dispose active entries and permit regeneration', () => {
  const { cache, textures } = createHarness({ maxEntries: 4 })
  const front = cache.acquireFront(frontOptions('c-AS'))
  const back = cache.acquireBack({
    themeId: ALTERNATE_BACK_THEME.id,
    scale: 1,
  })
  assert.equal(cache.invalidateTheme('front', ALTERNATE_FRONT_THEME.id), 1)
  assert.equal(front.texture.disposeCalls, 1)
  assert.equal(front.texture.image, null)
  assert.equal(back.texture.disposeCalls, 0)
  front.release()

  const regenerated = cache.acquireFront(frontOptions('c-AS'))
  assert.notEqual(regenerated.texture, front.texture)
  regenerated.release()
  back.release()
  cache.clear()
  assert.equal(cache.getStats().entries, 0)
  assert.equal(textures.filter(({ disposeCalls }) => disposeCalls === 1).length, 3)

  const regeneratedBack = cache.acquireBack({
    themeId: ALTERNATE_BACK_THEME.id,
    scale: 1,
  })
  regeneratedBack.release()
  assert.equal(textures.length, 4)
  cache.destroy()
  cache.destroy()
  assert.equal(cache.getStats().destroyed, true)
  assert.throws(() => cache.acquireFront(frontOptions('c-2S')), /destroyed/)
})

test('generation and configuration failures leave no cached or canvas-backed texture', () => {
  const partialTextures = []
  const registry = createThemeRegistry({
    frontThemes: [
      ALTERNATE_FRONT_THEME,
      {
        id: 'broken-front-v1',
        create() {
          throw new Error('generation failed')
        },
      },
      {
        id: 'empty-front-v1',
        create() {
          return {}
        },
      },
    ],
  })
  const cache = createTextureCache({
    registry,
    createCanvas,
    textureFactory(canvas) {
      const texture = new FakeTexture(canvas)
      Object.defineProperty(texture, 'colorSpace', {
        set() {
          throw new Error('configuration failed')
        },
      })
      partialTextures.push(texture)
      return texture
    },
  })

  assert.throws(
    () => cache.acquireFront({
      themeId: 'broken-front-v1',
      cardId: 'c-2S',
      scale: 1,
    }),
    /generation failed/,
  )
  assert.equal(partialTextures.length, 0)
  assert.equal(cache.getStats().entries, 0)

  assert.throws(
    () => cache.acquireFront({
      themeId: 'empty-front-v1',
      cardId: 'c-2S',
      scale: 1,
    }),
    /sized canvas/,
  )
  assert.equal(partialTextures.length, 0)
  assert.equal(cache.getStats().entries, 0)

  assert.throws(
    () => cache.acquireFront(frontOptions('c-2S')),
    /configuration failed/,
  )
  assert.equal(partialTextures.length, 1)
  assert.equal(partialTextures[0].disposeCalls, 1)
  assert.equal(partialTextures[0].image, null)
  assert.equal(cache.getStats().entries, 0)
  cache.destroy()
})

test('cache validates adapters, limits, acquisition data, and invalidation data', () => {
  assert.throws(() => createTextureCache({ registry: {} }), /registry/)
  assert.throws(() => createTextureCache({ maxEntries: 0 }), /maxEntries/)
  assert.throws(() => createTextureCache({ anisotropy: 0 }), /anisotropy/)
  assert.throws(() => createTextureCache({ createCanvas: null }), /createCanvas/)
  assert.throws(() => createTextureCache({ textureFactory: null }), /textureFactory/)
  assert.throws(() => createTextureCache({ onTextureUpdate: null }), /onTextureUpdate/)
  assert.throws(() => createTextureCache({ onDiagnostic: 1 }), /onDiagnostic/)
  assert.throws(
    () => createTextureCache({ renderer: {} }),
    /getMaxAnisotropy/,
  )
  for (const supported of [-1, Number.NaN]) {
    assert.throws(
      () => createTextureCache({
        renderer: { capabilities: { getMaxAnisotropy: () => supported } },
      }),
      /finite non-negative/,
    )
  }

  const { cache } = createHarness()
  assert.throws(() => cache.acquireFront(null), /options/)
  assert.throws(() => cache.acquireBack([]), /options/)
  assert.throws(() => cache.acquireFront(frontOptions('c-1S')), /Unknown card ID/)
  assert.throws(() => cache.acquireFront(frontOptions('c-2S', 0)), /scale/)
  assert.throws(() => cache.invalidateTheme('side', ALTERNATE_FRONT_THEME.id), /kind/)
  assert.throws(() => cache.invalidateTheme('front', 'bad id'), /themeId/)
  cache.destroy()
})

test('refinement redraws the drawn canvas later, marks one upload, and notifies once', async () => {
  const { cache, calls, diagnostics, textures, updates } = createRefiningHarness()
  const front = cache.acquireFront(refinedFront('c-QH', 2))
  const canvas = front.texture.image
  assert.equal(calls.length, 0, 'refinement must not run inside acquire()')
  assert.equal(cache.getStats().refining, 1)
  assert.equal(front.texture.uploads, 1)

  await flush()
  assert.equal(calls.length, 1)
  const [cardId, options] = calls[0].args
  assert.equal(cardId, 'c-QH')
  assert.deepEqual(Object.keys(options).sort(), ['canvas', 'scale', 'signal'])
  assert.equal(options.canvas, canvas)
  assert.equal(options.scale, 2)
  assert.equal(options.signal.aborted, false)

  calls[0].resolve()
  await flush()
  assert.equal(front.texture.uploads, 2)
  assert.equal(front.texture.image, canvas)
  assert.deepEqual([canvas.width, canvas.height], [96, 144])
  assert.deepEqual(updates, [{
    kind: 'front',
    themeId: REFINED_FRONT_ID,
    cardId: 'c-QH',
    scale: 2,
  }])
  assert.ok(Object.isFrozen(updates[0]))
  assert.equal(cache.getStats().refining, 0)

  const repeated = cache.acquireFront(refinedFront('c-QH', 2))
  assert.equal(repeated.texture, front.texture)
  const back = cache.acquireBack({ themeId: REFINED_BACK_ID, cardId: 'c-2S', scale: 1 })
  await flush()
  assert.equal(calls.length, 2, 'cached entries are not refined again')
  assert.equal(calls[1].kind, 'back')
  assert.equal(calls[1].args.length, 1, 'backs receive only the options')
  assert.equal(calls[1].args[0].canvas, back.texture.image)
  calls[1].resolve()
  await flush()
  assert.deepEqual(updates.at(-1), {
    kind: 'back',
    themeId: REFINED_BACK_ID,
    cardId: null,
    scale: 1,
  })
  assert.equal(back.texture.uploads, 2)

  const plain = cache.acquireFront(frontOptions('c-2S'))
  await flush()
  assert.equal(plain.texture.uploads, 1, 'themes without refine upload once')
  assert.equal(calls.length, 2)
  assert.equal(updates.length, 2)
  assert.deepEqual(diagnostics, [])
  assert.equal(textures.length, 3)
  for (const lease of [front, repeated, back, plain]) lease.release()
  cache.destroy()
})

test('eviction, invalidation, clear, and destroy abort refinement without notifying', async () => {
  const { cache, calls, diagnostics, textures, updates } = createRefiningHarness({
    maxEntries: 1,
  })
  async function pendingRefinement(acquire) {
    const lease = acquire()
    lease.release()
    await flush()
    const call = calls.at(-1)
    assert.equal(call.args.at(-1).signal.aborted, false)
    return call
  }

  const evicted = await pendingRefinement(() => cache.acquireFront(refinedFront('c-2S')))
  const invalidated = await pendingRefinement(() => cache.acquireFront(refinedFront('c-3S')))
  assert.equal(evicted.args[1].signal.aborted, true, 'eviction aborts')
  assert.equal(cache.invalidateTheme('front', REFINED_FRONT_ID), 1)
  assert.equal(invalidated.args[1].signal.aborted, true, 'invalidation aborts')
  const cleared = await pendingRefinement(() => cache.acquireBack({ themeId: REFINED_BACK_ID }))
  cache.clear()
  assert.equal(cleared.args[0].signal.aborted, true, 'clear aborts')
  const destroyed = await pendingRefinement(() => cache.acquireFront(refinedFront('c-4S')))

  // Disposal before the deferred start skips the refine call entirely.
  cache.acquireFront(refinedFront('c-5S')).release()
  cache.clear()
  await flush()
  assert.equal(calls.length, 4)

  cache.destroy()
  assert.equal(destroyed.args[1].signal.aborted, true, 'destroy aborts')
  evicted.resolve()
  invalidated.reject(new Error('late failure'))
  cleared.resolve()
  destroyed.resolve()
  await flush()
  assert.deepEqual(updates, [])
  assert.deepEqual(diagnostics, [])
  assert.equal(cache.getStats().refining, 0)
  assert.ok(textures.every(({ uploads, image }) => uploads === 1 && image === null))
})

test('refinement failures emit one diagnostic and keep the drawn texture usable', async () => {
  const { cache, calls, diagnostics, updates } = createRefiningHarness()
  const decodeFailure = cache.acquireFront(refinedFront('c-AS'))
  const valueFailure = cache.acquireFront(refinedFront('c-KS'))
  const aborted = cache.acquireFront(refinedFront('c-JS'))
  const thrown = cache.acquireFront({ themeId: THROWING_FRONT_ID, cardId: 'c-2D', scale: 1 })
  await flush()
  assert.equal(calls.length, 3)
  calls[0].reject(Object.assign(new Error('decode failed'), { code: 'decode' }))
  calls[1].reject(undefined)
  calls[2].reject(new DOMException('stopped', 'AbortError'))
  await flush()

  assert.deepEqual(diagnostics, [
    {
      type: 'texture-refine-failed',
      kind: 'front',
      themeId: THROWING_FRONT_ID,
      cardId: 'c-2D',
      reason: 'Error',
    },
    {
      type: 'texture-refine-failed',
      kind: 'front',
      themeId: REFINED_FRONT_ID,
      cardId: 'c-AS',
      reason: 'decode',
    },
    {
      type: 'texture-refine-failed',
      kind: 'front',
      themeId: REFINED_FRONT_ID,
      cardId: 'c-KS',
      reason: 'unknown',
    },
  ])
  assert.deepEqual(updates, [])
  assert.equal(cache.getStats().refining, 0)
  for (const lease of [decodeFailure, valueFailure, aborted, thrown]) {
    assert.equal(lease.texture.uploads, 1)
    assert.notEqual(lease.texture.image, null)
  }
  const reused = cache.acquireFront(refinedFront('c-AS'))
  assert.equal(reused.texture, decodeFailure.texture)
  await flush()
  assert.equal(calls.length, 3, 'a failed refinement is not retried for a cached entry')
  assert.equal(diagnostics.length, 3)
  cache.destroy()
})

test('throwing update and diagnostic listeners do not break the cache', async () => {
  const seen = []
  const { cache, calls } = createRefiningHarness({
    onTextureUpdate(update) {
      seen.push(update.cardId)
      throw new Error('update listener failed')
    },
    onDiagnostic(diagnostic) {
      seen.push(diagnostic.reason)
      throw new Error('diagnostic listener failed')
    },
  })
  const refined = cache.acquireFront(refinedFront('c-9C'))
  const failed = cache.acquireFront(refinedFront('c-8C'))
  await flush()
  calls[0].resolve()
  calls[1].reject(Object.assign(new Error('missing'), { code: 'missing' }))
  await flush()
  assert.deepEqual(seen, ['c-9C', 'missing'])
  assert.equal(refined.texture.uploads, 2)
  assert.equal(cache.getStats().refining, 0)

  const next = cache.acquireFront(refinedFront('c-7C'))
  assert.equal(cache.getStats().entries, 3)
  for (const lease of [refined, failed, next]) lease.release()
  cache.destroy()
})

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
  assert.throws(
    () => createTextureCache({ renderer: {} }),
    /getMaxAnisotropy/,
  )

  const { cache } = createHarness()
  assert.throws(() => cache.acquireFront(null), /options/)
  assert.throws(() => cache.acquireBack([]), /options/)
  assert.throws(() => cache.acquireFront(frontOptions('c-1S')), /Unknown card ID/)
  assert.throws(() => cache.acquireFront(frontOptions('c-2S', 0)), /scale/)
  assert.throws(() => cache.invalidateTheme('side', ALTERNATE_FRONT_THEME.id), /kind/)
  assert.throws(() => cache.invalidateTheme('front', 'bad id'), /themeId/)
  cache.destroy()
})

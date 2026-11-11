import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_SETTINGS,
} from '../../src/app/settings.js'
import {
  SETTINGS_STORAGE_KEYS,
  createSettingsRepository,
} from '../../src/persistence/settings-repository.js'

function createStorage(entries = []) {
  const values = new Map(entries)
  return {
    values,
    getItem(key) {
      return values.has(key) ? values.get(key) : null
    },
    setItem(key, value) {
      values.set(key, value)
    },
    removeItem(key) {
      values.delete(key)
    },
  }
}

test('settings repository exposes versioned independent keys and immutable defaults', () => {
  const storage = createStorage()
  const repository = createSettingsRepository({ storage })

  assert.deepEqual(SETTINGS_STORAGE_KEYS, {
    burnEnabled: 'soulcard.settings.v1.burnEnabled',
    quality: 'soulcard.settings.v1.quality',
    renderScaleCap: 'soulcard.settings.v1.renderScaleCap',
    animationSpeed: 'soulcard.settings.v1.animationSpeed',
    reducedMotionOverride: 'soulcard.settings.v1.reducedMotionOverride',
    cardArt: 'soulcard.settings.v1.cardArt',
  })
  assert.deepEqual(repository.load(), DEFAULT_SETTINGS)
  assert.equal(DEFAULT_SETTINGS.cardArt, 'tarot-pixel')
  assert.equal(repository.persistent, true)
  assert.equal(Object.isFrozen(repository.load()), true)
  assert.throws(() => {
    repository.load().quality = 'high'
  }, TypeError)
})

test('each setting persists independently and reloads with explicit false intact', () => {
  const storage = createStorage()
  const repository = createSettingsRepository({ storage })

  repository.setBurnEnabled(false)
  repository.setQuality('high')
  repository.setRenderScaleCap(1.5)
  repository.setAnimationSpeed(2)
  repository.setReducedMotionOverride(false)
  repository.setCardArt('tarot-hd')

  assert.deepEqual(Object.fromEntries(storage.values), {
    [SETTINGS_STORAGE_KEYS.burnEnabled]: 'false',
    [SETTINGS_STORAGE_KEYS.quality]: '"high"',
    [SETTINGS_STORAGE_KEYS.renderScaleCap]: '1.5',
    [SETTINGS_STORAGE_KEYS.animationSpeed]: '2',
    [SETTINGS_STORAGE_KEYS.reducedMotionOverride]: 'false',
    [SETTINGS_STORAGE_KEYS.cardArt]: '"tarot-hd"',
  })
  assert.deepEqual(createSettingsRepository({ storage }).load(), {
    burnEnabled: false,
    quality: 'high',
    renderScaleCap: 1.5,
    animationSpeed: 2,
    reducedMotionOverride: false,
    cardArt: 'tarot-hd',
  })

  repository.setCardArt('tarot-pixel')
  assert.equal(storage.values.get(SETTINGS_STORAGE_KEYS.cardArt), '"tarot-pixel"')
  assert.equal(createSettingsRepository({ storage }).load().cardArt, 'tarot-pixel')

  repository.setReducedMotionOverride(null)
  assert.equal(storage.values.has(SETTINGS_STORAGE_KEYS.reducedMotionOverride), false)
  assert.equal(createSettingsRepository({ storage }).load().reducedMotionOverride, null)
})

test('missing and malformed values fall back independently without disabling storage', () => {
  const storage = createStorage([
    [SETTINGS_STORAGE_KEYS.burnEnabled, '"false"'],
    [SETTINGS_STORAGE_KEYS.quality, '"high"'],
    [SETTINGS_STORAGE_KEYS.renderScaleCap, '1.25'],
    [SETTINGS_STORAGE_KEYS.animationSpeed, '{'],
    [SETTINGS_STORAGE_KEYS.reducedMotionOverride, '"false"'],
    [SETTINGS_STORAGE_KEYS.cardArt, '"tarot-hd-front-v1"'],
  ])
  const repository = createSettingsRepository({ storage })

  assert.deepEqual(repository.load(), {
    burnEnabled: DEFAULT_SETTINGS.burnEnabled,
    quality: 'high',
    renderScaleCap: DEFAULT_SETTINGS.renderScaleCap,
    animationSpeed: DEFAULT_SETTINGS.animationSpeed,
    reducedMotionOverride: DEFAULT_SETTINGS.reducedMotionOverride,
    cardArt: DEFAULT_SETTINGS.cardArt,
  })
  assert.equal(repository.persistent, true)

  for (const malformed of ['"classic"', '"Tarot (HD)"', 'true', '{']) {
    const cardArtOnly = createStorage([[SETTINGS_STORAGE_KEYS.cardArt, malformed]])
    assert.equal(createSettingsRepository({ storage: cardArtOnly }).load().cardArt, 'tarot-pixel')
  }
  const hdOnly = createStorage([[SETTINGS_STORAGE_KEYS.cardArt, '"tarot-hd"']])
  assert.deepEqual(createSettingsRepository({ storage: hdOnly }).load(), {
    ...DEFAULT_SETTINGS,
    cardArt: 'tarot-hd',
  })
})

test('unavailable storage retains validated changes for the current session', () => {
  const repository = createSettingsRepository({ storage: null })

  assert.equal(repository.persistent, false)
  repository.setBurnEnabled(false)
  repository.setQuality('low')
  repository.setRenderScaleCap(1)
  repository.setAnimationSpeed(0.5)
  repository.setReducedMotionOverride(true)
  repository.setCardArt('tarot-hd')

  assert.deepEqual(repository.load(), {
    burnEnabled: false,
    quality: 'low',
    renderScaleCap: 1,
    animationSpeed: 0.5,
    reducedMotionOverride: true,
    cardArt: 'tarot-hd',
  })
})

test('read and write failures degrade to session storage without crashing', () => {
  const readFailure = createSettingsRepository({
    storage: {
      getItem() {
        throw new Error('blocked')
      },
      setItem() {
        throw new Error('should not write after read failure')
      },
      removeItem() {},
    },
  })
  assert.equal(readFailure.persistent, false)
  assert.deepEqual(readFailure.setQuality('high'), {
    ...DEFAULT_SETTINGS,
    quality: 'high',
  })

  let writes = 0
  const storage = {
    getItem() {
      return null
    },
    setItem() {
      writes += 1
      throw new Error('quota exceeded')
    },
    removeItem() {
      writes += 1
      throw new Error('quota exceeded')
    },
  }
  const writeFailure = createSettingsRepository({ storage })
  assert.deepEqual(writeFailure.setAnimationSpeed(1.5), {
    ...DEFAULT_SETTINGS,
    animationSpeed: 1.5,
  })
  assert.equal(writeFailure.persistent, false)
  writeFailure.setQuality('low')
  assert.equal(writes, 1)
  assert.deepEqual(writeFailure.load(), {
    ...DEFAULT_SETTINGS,
    quality: 'low',
    animationSpeed: 1.5,
  })
})

test('invalid updates are rejected atomically', () => {
  const storage = createStorage()
  const repository = createSettingsRepository({ storage })

  for (const [method, value] of [
    ['setBurnEnabled', 'off'],
    ['setQuality', 'ultra'],
    ['setRenderScaleCap', 3],
    ['setAnimationSpeed', 0],
    ['setReducedMotionOverride', 'system'],
    ['setCardArt', 'classic'],
    ['setCardArt', null],
    ['setCardArt', 'tarot-hd-front-v1'],
  ]) {
    assert.throws(() => repository[method](value), TypeError)
  }

  assert.deepEqual(repository.load(), DEFAULT_SETTINGS)
  assert.deepEqual([...storage.values], [])
})

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_SETTINGS,
} from '../../src/app/settings.js'
import { createSettingsRepository } from '../../src/persistence/settings-repository.js'
import {
  REDUCED_MOTION_QUERY,
  createSettingsController,
} from '../../src/ui/settings-controller.js'

function createStorage() {
  const values = new Map()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  }
}

function createMediaQueryList(initialMatches) {
  const listeners = new Set()
  return {
    matches: initialMatches,
    addEventListener(type, listener) {
      if (type === 'change') listeners.add(listener)
    },
    removeEventListener(type, listener) {
      if (type === 'change') listeners.delete(listener)
    },
    change(matches) {
      this.matches = matches
      for (const listener of [...listeners]) listener({ matches })
    },
    get listenerCount() {
      return listeners.size
    },
  }
}

function createController({ storage = createStorage(), mediaMatches = false } = {}) {
  const media = createMediaQueryList(mediaMatches)
  const queries = []
  const controller = createSettingsController({
    repository: createSettingsRepository({ storage }),
    matchMedia(query) {
      queries.push(query)
      return media
    },
  })
  return { controller, media, queries, storage }
}

test('system motion preference initializes only when there is no explicit override', () => {
  const { controller, queries } = createController({ mediaMatches: true })

  assert.deepEqual(queries, [REDUCED_MOTION_QUERY])
  assert.deepEqual(controller.getSnapshot(), {
    ...DEFAULT_SETTINGS,
    reducedMotion: true,
  })
  assert.equal(Object.isFrozen(controller.getSnapshot()), true)
})

test('both explicit motion overrides persist and take precedence after reload', () => {
  const storage = createStorage()
  const first = createController({ storage, mediaMatches: false })
  first.controller.setReducedMotionOverride(true)
  assert.equal(first.controller.getSnapshot().reducedMotion, true)
  first.controller.destroy()

  const second = createController({ storage, mediaMatches: false })
  assert.equal(second.controller.getSnapshot().reducedMotionOverride, true)
  assert.equal(second.controller.getSnapshot().reducedMotion, true)
  second.controller.setReducedMotionOverride(false)
  second.media.change(true)
  assert.equal(second.controller.getSnapshot().reducedMotionOverride, false)
  assert.equal(second.controller.getSnapshot().reducedMotion, false)
  second.controller.destroy()

  const third = createController({ storage, mediaMatches: true })
  assert.equal(third.controller.getSnapshot().reducedMotionOverride, false)
  assert.equal(third.controller.getSnapshot().reducedMotion, false)
})

test('system mode follows live media changes and adopts changes made under an override', () => {
  const { controller, media } = createController({ mediaMatches: false })
  const snapshots = []
  const unsubscribe = controller.subscribe((settings) => snapshots.push(settings))

  media.change(true)
  assert.equal(controller.getSnapshot().reducedMotion, true)
  controller.setReducedMotionOverride(false)
  media.change(false)
  media.change(true)
  assert.equal(controller.getSnapshot().reducedMotion, false)
  controller.setReducedMotionOverride(null)
  assert.equal(controller.getSnapshot().reducedMotion, true)

  assert.deepEqual(snapshots.map((settings) => [
    settings.reducedMotionOverride,
    settings.reducedMotion,
  ]), [
    [null, false],
    [null, true],
    [false, false],
    [null, true],
  ])
  unsubscribe()
})

test('quality, render cap, and speed updates persist and notify subscribers', () => {
  const { controller } = createController()
  const snapshots = []
  controller.subscribe((settings) => snapshots.push(settings))

  controller.setQuality('high')
  controller.setRenderScaleCap(1.5)
  controller.setAnimationSpeed(2)

  assert.deepEqual(controller.getSnapshot(), {
    ...DEFAULT_SETTINGS,
    quality: 'high',
    renderScaleCap: 1.5,
    animationSpeed: 2,
    reducedMotion: false,
  })
  assert.equal(snapshots.length, 4)
})

test('invalid updates and subscribers are rejected without changing settings', () => {
  const { controller } = createController()
  const initial = controller.getSnapshot()

  assert.throws(() => controller.subscribe(null), TypeError)
  assert.throws(() => controller.setQuality('ultra'), TypeError)
  assert.throws(() => controller.setRenderScaleCap(Number.NaN), TypeError)
  assert.throws(() => controller.setAnimationSpeed(3), TypeError)
  assert.throws(() => controller.setReducedMotionOverride('system'), TypeError)
  assert.equal(controller.getSnapshot(), initial)
})

test('storage degradation is exposed while updates remain available', () => {
  const controller = createSettingsController({
    repository: createSettingsRepository({ storage: null }),
    matchMedia: null,
  })

  assert.equal(controller.persistent, false)
  controller.setQuality('low')
  assert.equal(controller.getSnapshot().quality, 'low')
  assert.equal(controller.getSnapshot().reducedMotion, false)
})

test('destroy removes media and subscriber listeners and prevents later updates', () => {
  const { controller, media } = createController()
  let calls = 0
  controller.subscribe(() => {
    calls += 1
  })
  assert.equal(media.listenerCount, 1)

  controller.destroy()
  controller.destroy()
  media.change(true)

  assert.equal(media.listenerCount, 0)
  assert.equal(calls, 1)
  assert.throws(() => controller.setQuality('high'), /has been destroyed/)
  assert.throws(() => controller.subscribe(() => {}), /has been destroyed/)
})

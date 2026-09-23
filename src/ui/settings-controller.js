import {
  assertSettingValue,
  createSettingsSnapshot,
} from '../app/settings.js'
import { createSettingsRepository } from '../persistence/settings-repository.js'

export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

function getDefaultMatchMedia() {
  try {
    return typeof globalThis.matchMedia === 'function'
      ? globalThis.matchMedia.bind(globalThis)
      : null
  } catch {
    return null
  }
}

function assertRepository(repository) {
  const methods = [
    'load',
    'setBurnEnabled',
    'setQuality',
    'setRenderScaleCap',
    'setAnimationSpeed',
    'setReducedMotionOverride',
  ]
  if (
    repository === null
    || typeof repository !== 'object'
    || methods.some((method) => typeof repository[method] !== 'function')
  ) {
    throw new TypeError('repository must implement the settings repository interface')
  }
}

export function createSettingsController({
  repository = createSettingsRepository(),
  matchMedia = undefined,
} = {}) {
  assertRepository(repository)

  const subscribers = new Set()
  const resolvedMatchMedia = matchMedia === undefined ? getDefaultMatchMedia() : matchMedia
  if (resolvedMatchMedia !== null && typeof resolvedMatchMedia !== 'function') {
    throw new TypeError('matchMedia must be a function, null, or undefined')
  }

  let mediaQueryList = null
  if (resolvedMatchMedia) {
    try {
      const candidate = resolvedMatchMedia(REDUCED_MOTION_QUERY)
      if (candidate !== null && typeof candidate === 'object') {
        mediaQueryList = candidate
      }
    } catch {
      mediaQueryList = null
    }
  }

  let systemReducedMotion = mediaQueryList?.matches === true
  let preferences = repository.load()
  let snapshot = createSettingsSnapshot(preferences, systemReducedMotion)
  let destroyed = false

  function assertActive() {
    if (destroyed) throw new Error('Settings controller has been destroyed')
  }

  function publish() {
    snapshot = createSettingsSnapshot(preferences, systemReducedMotion)
    for (const subscriber of [...subscribers]) subscriber(snapshot)
    return snapshot
  }

  function update(field, value, persist) {
    assertActive()
    assertSettingValue(field, value)
    if (Object.is(preferences[field], value)) return snapshot

    persist(value)
    preferences = repository.load()
    return publish()
  }

  const handleMediaChange = (event) => {
    if (destroyed || typeof event?.matches !== 'boolean') return

    const nextSystemReducedMotion = event.matches
    if (systemReducedMotion === nextSystemReducedMotion) return
    systemReducedMotion = nextSystemReducedMotion

    if (preferences.reducedMotionOverride === null) publish()
  }

  let removeMediaListener = () => {}
  if (
    typeof mediaQueryList?.addEventListener === 'function'
    && typeof mediaQueryList?.removeEventListener === 'function'
  ) {
    mediaQueryList.addEventListener('change', handleMediaChange)
    removeMediaListener = () => mediaQueryList.removeEventListener('change', handleMediaChange)
  } else if (
    typeof mediaQueryList?.addListener === 'function'
    && typeof mediaQueryList?.removeListener === 'function'
  ) {
    mediaQueryList.addListener(handleMediaChange)
    removeMediaListener = () => mediaQueryList.removeListener(handleMediaChange)
  }

  function subscribe(subscriber) {
    assertActive()
    if (typeof subscriber !== 'function') {
      throw new TypeError('Settings subscriber must be a function')
    }

    subscribers.add(subscriber)
    try {
      subscriber(snapshot)
    } catch (error) {
      subscribers.delete(subscriber)
      throw error
    }

    let subscribed = true
    return () => {
      if (!subscribed) return
      subscribed = false
      subscribers.delete(subscriber)
    }
  }

  function destroy() {
    if (destroyed) return
    destroyed = true
    removeMediaListener()
    subscribers.clear()
  }

  return Object.freeze({
    getSnapshot: () => snapshot,
    subscribe,
    setBurnEnabled: (value) => update(
      'burnEnabled',
      value,
      repository.setBurnEnabled,
    ),
    setQuality: (value) => update('quality', value, repository.setQuality),
    setRenderScaleCap: (value) => update(
      'renderScaleCap',
      value,
      repository.setRenderScaleCap,
    ),
    setAnimationSpeed: (value) => update(
      'animationSpeed',
      value,
      repository.setAnimationSpeed,
    ),
    setReducedMotionOverride: (value) => update(
      'reducedMotionOverride',
      value,
      repository.setReducedMotionOverride,
    ),
    destroy,
    get persistent() {
      return repository.persistent === true
    },
  })
}

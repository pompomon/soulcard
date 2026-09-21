import {
  DEFAULT_SETTINGS,
  assertSettingValue,
  createSettingsPreferences,
  isSettingValue,
} from '../app/settings.js'

const STORAGE_PREFIX = 'soulcard.settings.v1'

export const SETTINGS_STORAGE_KEYS = Object.freeze({
  quality: `${STORAGE_PREFIX}.quality`,
  renderScaleCap: `${STORAGE_PREFIX}.renderScaleCap`,
  animationSpeed: `${STORAGE_PREFIX}.animationSpeed`,
  reducedMotionOverride: `${STORAGE_PREFIX}.reducedMotionOverride`,
})

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

function supportsStorage(storage) {
  return (
    storage !== null
    && typeof storage === 'object'
    && typeof storage.getItem === 'function'
    && typeof storage.setItem === 'function'
    && typeof storage.removeItem === 'function'
  )
}

function parseStoredValue(field, serialized) {
  if (serialized === null) return undefined

  try {
    const value = JSON.parse(serialized)
    return isSettingValue(field, value) ? value : undefined
  } catch {
    return undefined
  }
}

export function createSettingsRepository({ storage = undefined } = {}) {
  const resolvedStorage = storage === undefined ? defaultStorage() : storage
  let persistent = supportsStorage(resolvedStorage)
  const current = { ...DEFAULT_SETTINGS }

  if (persistent) {
    for (const [field, key] of Object.entries(SETTINGS_STORAGE_KEYS)) {
      try {
        const value = parseStoredValue(field, resolvedStorage.getItem(key))
        if (value !== undefined) current[field] = value
      } catch {
        persistent = false
        break
      }
    }
  }

  function load() {
    return createSettingsPreferences(current)
  }

  function save(field, value) {
    assertSettingValue(field, value)
    current[field] = value

    if (persistent) {
      try {
        if (field === 'reducedMotionOverride' && value === null) {
          resolvedStorage.removeItem(SETTINGS_STORAGE_KEYS[field])
        } else {
          resolvedStorage.setItem(SETTINGS_STORAGE_KEYS[field], JSON.stringify(value))
        }
      } catch {
        persistent = false
      }
    }

    return load()
  }

  return Object.freeze({
    load,
    setQuality: (value) => save('quality', value),
    setRenderScaleCap: (value) => save('renderScaleCap', value),
    setAnimationSpeed: (value) => save('animationSpeed', value),
    setReducedMotionOverride: (value) => save('reducedMotionOverride', value),
    get persistent() {
      return persistent
    },
  })
}

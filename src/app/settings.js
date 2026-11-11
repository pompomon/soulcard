export const QUALITY_PRESETS = Object.freeze(['low', 'balanced', 'high'])
export const RENDER_SCALE_CAPS = Object.freeze([1, 1.5, 2])
export const ANIMATION_SPEEDS = Object.freeze([0.5, 1, 1.5, 2])
// Option IDs, not theme IDs: src/app/card-art.js maps each to its versioned themes.
export const CARD_ART_OPTIONS = Object.freeze(['tarot-pixel', 'tarot-hd'])

export const DEFAULT_SETTINGS = Object.freeze({
  burnEnabled: true,
  quality: 'balanced',
  renderScaleCap: 2,
  animationSpeed: 1,
  reducedMotionOverride: null,
  cardArt: 'tarot-pixel',
})

const SETTING_FIELDS = Object.freeze(Object.keys(DEFAULT_SETTINGS))

function includesSameValue(values, value) {
  return values.some((candidate) => Object.is(candidate, value))
}

export function isSettingValue(field, value) {
  switch (field) {
    case 'burnEnabled':
      return typeof value === 'boolean'
    case 'quality':
      return QUALITY_PRESETS.includes(value)
    case 'renderScaleCap':
      return includesSameValue(RENDER_SCALE_CAPS, value)
    case 'animationSpeed':
      return includesSameValue(ANIMATION_SPEEDS, value)
    case 'reducedMotionOverride':
      return value === null || typeof value === 'boolean'
    case 'cardArt':
      return CARD_ART_OPTIONS.includes(value)
    default:
      return false
  }
}

export function assertSettingValue(field, value) {
  if (!SETTING_FIELDS.includes(field)) {
    throw new RangeError(`Unknown setting: ${String(field)}`)
  }
  if (!isSettingValue(field, value)) {
    throw new TypeError(`Invalid ${field} setting`)
  }
  return value
}

export function createSettingsPreferences(values = DEFAULT_SETTINGS) {
  if (values === null || typeof values !== 'object' || Array.isArray(values)) {
    throw new TypeError('Settings preferences must be an object')
  }

  const keys = Object.keys(values)
  if (
    keys.length !== SETTING_FIELDS.length
    || keys.some((key) => !SETTING_FIELDS.includes(key))
  ) {
    throw new TypeError('Settings preferences must contain exactly the supported settings')
  }

  for (const field of SETTING_FIELDS) {
    assertSettingValue(field, values[field])
  }

  return Object.freeze({
    burnEnabled: values.burnEnabled,
    quality: values.quality,
    renderScaleCap: values.renderScaleCap,
    animationSpeed: values.animationSpeed,
    reducedMotionOverride: values.reducedMotionOverride,
    cardArt: values.cardArt,
  })
}

export function createSettingsSnapshot(preferences, systemReducedMotion) {
  if (typeof systemReducedMotion !== 'boolean') {
    throw new TypeError('systemReducedMotion must be a boolean')
  }

  const validated = createSettingsPreferences(preferences)
  return Object.freeze({
    ...validated,
    reducedMotion: validated.reducedMotionOverride ?? systemReducedMotion,
  })
}

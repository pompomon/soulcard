import {
  CLASSIC_BACK_THEME,
  CLASSIC_BACK_THEME_ID,
  CLASSIC_FRONT_THEME,
  CLASSIC_FRONT_THEME_ID,
} from './classic.js'

const THEME_KINDS = Object.freeze(['front', 'back'])
const THEME_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_THEME_ID_LENGTH = 64

export function isThemeId(value) {
  return (
    typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_THEME_ID_LENGTH
    && THEME_ID_PATTERN.test(value)
  )
}

function assertPlainObject(value, name) {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new TypeError(`${name} must be a plain object`)
  }
}

function assertDescriptor(descriptor, kind) {
  assertPlainObject(descriptor, `${kind} theme`)
  const keys = Reflect.ownKeys(descriptor)
  if (
    keys.length !== 2
    || !keys.includes('id')
    || !keys.includes('create')
    || keys.some((key) => typeof key !== 'string')
  ) {
    throw new TypeError(`${kind} theme must contain only id and create`)
  }
  for (const key of keys) {
    const property = Object.getOwnPropertyDescriptor(descriptor, key)
    if (!property?.enumerable || !Object.hasOwn(property, 'value')) {
      throw new TypeError(`${kind} theme.${key} must be an enumerable data property`)
    }
  }
  if (!isThemeId(descriptor.id)) {
    throw new TypeError(`${kind} theme id is invalid`)
  }
  if (typeof descriptor.create !== 'function') {
    throw new TypeError(`${kind} theme create must be a function`)
  }
}

function assertThemeArray(themes, name) {
  if (!Array.isArray(themes)) {
    throw new TypeError(`${name} must be an array`)
  }
}

function readSelectionValue(selection, key) {
  if (selection === undefined || selection === null) {
    return { value: undefined, reason: 'missing' }
  }
  if (
    typeof selection !== 'object'
    || Array.isArray(selection)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(selection))
  ) {
    return { value: undefined, reason: 'invalid-selection' }
  }
  const property = Object.getOwnPropertyDescriptor(selection, key)
  if (!property) return { value: undefined, reason: 'missing' }
  if (!property.enumerable || !Object.hasOwn(property, 'value')) {
    return { value: undefined, reason: 'invalid-selection' }
  }
  return { value: property.value }
}

export function createThemeRegistry({
  frontThemes = [],
  backThemes = [],
  onDiagnostic = () => {},
} = {}) {
  assertThemeArray(frontThemes, 'frontThemes')
  assertThemeArray(backThemes, 'backThemes')
  if (typeof onDiagnostic !== 'function') {
    throw new TypeError('onDiagnostic must be a function')
  }

  const registries = {
    front: new Map(),
    back: new Map(),
  }
  const fallbackIds = Object.freeze({
    front: CLASSIC_FRONT_THEME_ID,
    back: CLASSIC_BACK_THEME_ID,
  })

  function register(kind, descriptor) {
    assertDescriptor(descriptor, kind)
    const registry = registries[kind]
    if (registry.has(descriptor.id)) {
      throw new Error(`${kind} theme is already registered: ${descriptor.id}`)
    }
    const registered = Object.freeze({
      kind,
      id: descriptor.id,
      create: descriptor.create,
    })
    registry.set(registered.id, registered)
    return registered
  }

  register('front', CLASSIC_FRONT_THEME)
  register('back', CLASSIC_BACK_THEME)
  for (const descriptor of frontThemes) register('front', descriptor)
  for (const descriptor of backThemes) register('back', descriptor)

  function emitFallback(kind, requestedId, reason) {
    const diagnostic = Object.freeze({
      type: 'theme-fallback',
      kind,
      requestedId: typeof requestedId === 'string' ? requestedId : null,
      fallbackId: fallbackIds[kind],
      reason,
    })
    try {
      onDiagnostic(diagnostic)
    } catch {}
  }

  function resolve(kind, requestedId, forcedReason = undefined) {
    const registry = registries[kind]
    if (forcedReason === undefined && isThemeId(requestedId) && registry.has(requestedId)) {
      return registry.get(requestedId)
    }

    let reason = forcedReason
    if (reason === undefined) {
      if (requestedId === undefined || requestedId === null || requestedId === '') {
        reason = 'missing'
      } else if (!isThemeId(requestedId)) {
        reason = 'invalid-id'
      } else {
        reason = 'unknown-id'
      }
    }
    emitFallback(kind, requestedId, reason)
    return registry.get(fallbackIds[kind])
  }

  function list(kind) {
    return Object.freeze([...registries[kind].values()])
  }

  return Object.freeze({
    registerFront: (descriptor) => register('front', descriptor),
    registerBack: (descriptor) => register('back', descriptor),
    resolveFront: (themeId) => resolve('front', themeId),
    resolveBack: (themeId) => resolve('back', themeId),
    resolveSelection(selection = undefined) {
      const front = readSelectionValue(selection, 'frontThemeId')
      const back = readSelectionValue(selection, 'backThemeId')
      return Object.freeze({
        frontThemeId: resolve('front', front.value, front.reason).id,
        backThemeId: resolve('back', back.value, back.reason).id,
      })
    },
    listFrontThemes: () => list('front'),
    listBackThemes: () => list('back'),
    get fallbackFrontThemeId() {
      return fallbackIds.front
    },
    get fallbackBackThemeId() {
      return fallbackIds.back
    },
  })
}

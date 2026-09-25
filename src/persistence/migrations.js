import {
  SAVE_SCHEMA_VERSION,
  UnsupportedSaveVersionError,
  validateRunSave,
} from './run-schema.js'

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

function cloneData(value) {
  if (Array.isArray(value)) return value.map(cloneData)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, cloneData(child)]),
    )
  }
  return value
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

export function migrateRunSave(input) {
  assertPlainObject(input, 'save')
  const descriptor = Object.getOwnPropertyDescriptor(input, 'saveSchemaVersion')
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
    throw new TypeError('save.saveSchemaVersion must be JSON-compatible data')
  }
  if (!Number.isSafeInteger(descriptor.value) || descriptor.value < 1) {
    throw new TypeError('saveSchemaVersion must be a positive safe integer')
  }
  if (descriptor.value !== SAVE_SCHEMA_VERSION) {
    throw new UnsupportedSaveVersionError(descriptor.value)
  }
  validateRunSave(input)
  return deepFreeze(cloneData(input))
}

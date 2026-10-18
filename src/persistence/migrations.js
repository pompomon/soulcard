import {
  SAVE_SCHEMA_VERSION,
  UnsupportedGameRulesVersionError,
  UnsupportedSaveVersionError,
  validateRunSave,
} from './run-schema.js'

// Schema 4 and 5 Classic saves carry over unchanged. Their Campaign saves use the
// scripted rewards of campaign rules 3 or the linear seeded drafts of campaign
// rules 4, which the branching expedition of campaign rules 5 cannot replay.
const CARRIED_SCHEMAS = Object.freeze([4, 5])

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

function dataEntries(value, name) {
  return Reflect.ownKeys(value).map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (
      typeof key !== 'string'
      || !descriptor.enumerable
      || !Object.hasOwn(descriptor, 'value')
    ) {
      throw new TypeError(`${name} must contain only JSON-compatible data`)
    }
    return [key, descriptor.value]
  })
}

function migrateCarriedSchema(input) {
  const entries = dataEntries(input, 'save')
  const fields = Object.fromEntries(entries)
  if (fields.runType === 'campaign') {
    if (!Number.isSafeInteger(fields.gameRulesVersion)) {
      throw new TypeError('gameRulesVersion must be a safe integer')
    }
    throw new UnsupportedGameRulesVersionError(fields.gameRulesVersion)
  }
  const migrated = Object.fromEntries(entries.map(([key, value]) => [
    key,
    key === 'saveSchemaVersion' ? SAVE_SCHEMA_VERSION : value,
  ]))
  validateRunSave(migrated)
  return deepFreeze(cloneData(migrated))
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
  if (CARRIED_SCHEMAS.includes(descriptor.value)) return migrateCarriedSchema(input)
  if (descriptor.value !== SAVE_SCHEMA_VERSION) {
    throw new UnsupportedSaveVersionError(descriptor.value)
  }
  validateRunSave(input)
  return deepFreeze(cloneData(input))
}

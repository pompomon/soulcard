import {
  GAME_RULES_VERSION,
  SAVE_SCHEMA_VERSION,
  UnsupportedGameRulesVersionError,
  UnsupportedSaveVersionError,
  validateRunSave,
} from './run-schema.js'

const LEGACY_V1_MATCH_KEYS = Object.freeze([
  'stage',
  'machineState',
  'turn',
  'status',
  'sourceDeck',
  'player',
  'opponent',
  'contestedPile',
  'inPlay',
  'burnPile',
  'futureModifiers',
])

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

function assertExactDataKeys(value, expected, name) {
  const keys = Reflect.ownKeys(value)
  if (
    keys.length !== expected.length
    || keys.some((key) => typeof key !== 'string' || !expected.includes(key))
    || expected.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new TypeError(`${name} must contain only ${expected.join(', ')}`)
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`${name}.${key} must be JSON-compatible data`)
    }
  }
}

function cloneData(value) {
  if (Array.isArray(value)) {
    return value.map(cloneData)
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, cloneData(child)]),
    )
  }
  return value
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) {
      deepFreeze(child)
    }
    Object.freeze(value)
  }
  return value
}

function migrateV1ToV2(input) {
  assertPlainObject(input, 'save')
  assertPlainObject(input.match, 'save.match')
  assertExactDataKeys(input.match, LEGACY_V1_MATCH_KEYS, 'save.match')
  if (input.gameRulesVersion !== GAME_RULES_VERSION) {
    throw new UnsupportedGameRulesVersionError(input.gameRulesVersion)
  }
  if (input.match.machineState !== 'ready' || input.match.status !== 'active') {
    throw new TypeError('Save schema version 1 supports only active ready matches')
  }

  const migrated = cloneData(input)
  migrated.saveSchemaVersion = 2
  migrated.match.outcome = null
  return migrated
}

const MIGRATIONS = new Map([
  [1, migrateV1ToV2],
])

export function migrateRunSave(input) {
  assertPlainObject(input, 'save')
  const versionDescriptor = Object.getOwnPropertyDescriptor(input, 'saveSchemaVersion')
  if (!versionDescriptor?.enumerable || !Object.hasOwn(versionDescriptor, 'value')) {
    throw new TypeError('save.saveSchemaVersion must be JSON-compatible data')
  }
  const initialVersion = versionDescriptor.value
  if (!Number.isSafeInteger(initialVersion) || initialVersion < 1) {
    throw new TypeError('saveSchemaVersion must be a positive safe integer')
  }
  if (initialVersion > SAVE_SCHEMA_VERSION) {
    throw new UnsupportedSaveVersionError(initialVersion)
  }

  let migrated = cloneData(input)
  while (migrated.saveSchemaVersion < SAVE_SCHEMA_VERSION) {
    const sourceVersion = migrated.saveSchemaVersion
    const migration = MIGRATIONS.get(sourceVersion)
    if (!migration) {
      throw new UnsupportedSaveVersionError(sourceVersion)
    }
    migrated = migration(migrated)
    if (migrated.saveSchemaVersion !== sourceVersion + 1) {
      throw new Error(`Migration from version ${sourceVersion} must advance exactly one version`)
    }
  }

  validateRunSave(migrated)
  return deepFreeze(cloneData(migrated))
}

import { validateMatchState } from '../domain/match-machine.js'

export const SAVE_SCHEMA_VERSION = 3
export const GAME_RULES_VERSION = 1

const SAVE_KEYS = Object.freeze([
  'saveSchemaVersion',
  'gameRulesVersion',
  'savedAt',
  'runId',
  'rng',
  'ruleset',
  'match',
  'pendingEvent',
])

const MATCH_KEYS = Object.freeze([
  'stage',
  'machineState',
  'turn',
  'status',
  'outcome',
  'sourceDeck',
  'player',
  'opponent',
  'contestedPile',
  'inPlay',
  'burnPile',
  'futureModifiers',
])

export class UnsupportedSaveVersionError extends Error {
  constructor(version) {
    super(`Unsupported save schema version: ${String(version)}`)
    this.name = 'UnsupportedSaveVersionError'
    this.version = version
  }
}

export class UnsupportedGameRulesVersionError extends Error {
  constructor(version) {
    super(`Unsupported game rules version: ${String(version)}`)
    this.name = 'UnsupportedGameRulesVersionError'
    this.version = version
  }
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

function assertExactKeys(value, expected, name) {
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

function assertDenseArray(value, name) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${name} must be a dense array`)
  }
  const propertyNames = Object.getOwnPropertyNames(value)
  if (
    propertyNames.length !== value.length + 1
    || propertyNames.at(-1) !== 'length'
    || Object.getOwnPropertySymbols(value).length !== 0
  ) {
    throw new TypeError(`${name} must be a dense array`)
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`${name} must be a dense array`)
    }
  }
}

function assertCanonicalTimestamp(savedAt) {
  if (
    typeof savedAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(savedAt)
  ) {
    throw new TypeError('savedAt must be a canonical ISO timestamp')
  }
  const date = new Date(savedAt)
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== savedAt) {
    throw new TypeError('savedAt must be a canonical ISO timestamp')
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

function assertMatchStructure(match) {
  assertPlainObject(match, 'save.match')
  assertExactKeys(match, MATCH_KEYS, 'save.match')
  for (const pile of ['sourceDeck', 'contestedPile', 'inPlay', 'burnPile', 'futureModifiers']) {
    assertDenseArray(match[pile], `save.match.${pile}`)
  }
  for (const pile of ['contestedPile', 'inPlay']) {
    for (let index = 0; index < match[pile].length; index += 1) {
      const name = `save.match.${pile}[${index}]`
      assertPlainObject(match[pile][index], name)
      assertExactKeys(match[pile][index], ['cardId', 'suppliedBy'], name)
    }
  }
  for (const side of ['player', 'opponent']) {
    assertPlainObject(match[side], `save.match.${side}`)
    assertExactKeys(match[side], ['drawPile', 'wonPile'], `save.match.${side}`)
    assertDenseArray(match[side].drawPile, `save.match.${side}.drawPile`)
    assertDenseArray(match[side].wonPile, `save.match.${side}.wonPile`)
  }
  if (match.futureModifiers.length !== 0) {
    throw new TypeError('save.match.futureModifiers must be empty for the current rules version')
  }
}

function matchFromSave(save) {
  return {
    runId: save.runId,
    ruleset: save.ruleset,
    rng: save.rng,
    stage: save.match.stage,
    machineState: save.match.machineState,
    turn: save.match.turn,
    status: save.match.status,
    outcome: save.match.outcome,
    zones: {
      sourceDeck: save.match.sourceDeck,
      player: save.match.player,
      opponent: save.match.opponent,
      contestedPile: save.match.contestedPile,
      burnPile: save.match.burnPile,
      inPlay: save.match.inPlay,
    },
    pendingEvent: save.pendingEvent,
  }
}

export function validateRunSaveVersion(save, expectedVersion) {
  if (![2, SAVE_SCHEMA_VERSION].includes(expectedVersion)) {
    throw new RangeError('expectedVersion must be a supported save schema version')
  }
  assertPlainObject(save, 'save')
  assertExactKeys(save, SAVE_KEYS, 'save')
  if (!Number.isSafeInteger(save.saveSchemaVersion)) {
    throw new TypeError('saveSchemaVersion must be a safe integer')
  }
  if (save.saveSchemaVersion !== expectedVersion) {
    throw new UnsupportedSaveVersionError(save.saveSchemaVersion)
  }
  if (!Number.isSafeInteger(save.gameRulesVersion)) {
    throw new TypeError('gameRulesVersion must be a safe integer')
  }
  if (save.gameRulesVersion !== GAME_RULES_VERSION) {
    throw new UnsupportedGameRulesVersionError(save.gameRulesVersion)
  }
  assertCanonicalTimestamp(save.savedAt)
  assertMatchStructure(save.match)
  if (expectedVersion === 2 && save.match.machineState === 'paused') {
    throw new TypeError('Save schema version 2 does not support paused matches')
  }
  validateMatchState(matchFromSave(save))
  return save
}

export function validateRunSave(save) {
  return validateRunSaveVersion(save, SAVE_SCHEMA_VERSION)
}

export function createRunSave(match, options) {
  assertPlainObject(options, 'options')
  assertExactKeys(options, ['savedAt'], 'options')
  validateMatchState(match)
  assertCanonicalTimestamp(options.savedAt)

  const save = {
    saveSchemaVersion: SAVE_SCHEMA_VERSION,
    gameRulesVersion: GAME_RULES_VERSION,
    savedAt: options.savedAt,
    runId: match.runId,
    rng: match.rng,
    ruleset: match.ruleset,
    match: {
      stage: match.stage,
      machineState: match.machineState,
      turn: match.turn,
      status: match.status,
      outcome: match.outcome,
      sourceDeck: match.zones.sourceDeck,
      player: match.zones.player,
      opponent: match.zones.opponent,
      contestedPile: match.zones.contestedPile,
      inPlay: match.zones.inPlay,
      burnPile: match.zones.burnPile,
      futureModifiers: [],
    },
    pendingEvent: match.pendingEvent,
  }
  const detached = cloneData(save)
  validateRunSave(detached)
  return deepFreeze(detached)
}

export function restoreRunSave(save) {
  validateRunSave(save)
  const match = cloneData(matchFromSave(save))
  validateMatchState(match)
  return deepFreeze(match)
}

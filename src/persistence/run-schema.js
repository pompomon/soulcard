import {
  CAMPAIGN_GAME_RULES_VERSION,
  validateCampaignState,
} from '../domain/campaign-machine.js'
import { validateMatchState } from '../domain/match-machine.js'
import { isCampaignState, validateRunState } from '../domain/run-state.js'

export const SAVE_SCHEMA_VERSION = 4
export const GAME_RULES_VERSION = 2

const SAVE_KEYS = Object.freeze([
  'saveSchemaVersion',
  'gameRulesVersion',
  'runType',
  'savedAt',
  'runId',
  'rng',
  'ruleset',
  'match',
  'pendingEvent',
])
const CLASSIC_MATCH_KEYS = Object.freeze([
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
const CAMPAIGN_MATCH_KEYS = Object.freeze([
  'campaignVersion',
  'machineState',
  'turn',
  'status',
  'outcome',
  'health',
  'maxHealth',
  'encounterIndex',
  'encounterAttempt',
  'cards',
  'deckLayout',
  'hold',
  'activeModifiers',
  'encounter',
  'holdChoice',
  'pendingReward',
  'stateFingerprint',
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
  const names = Object.getOwnPropertyNames(value)
  if (
    names.length !== value.length + 1
    || names.at(-1) !== 'length'
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

function assertClassicMatchStructure(match) {
  assertPlainObject(match, 'save.match')
  assertExactKeys(match, CLASSIC_MATCH_KEYS, 'save.match')
  for (const pile of [
    'sourceDeck',
    'contestedPile',
    'inPlay',
    'burnPile',
    'futureModifiers',
  ]) {
    assertDenseArray(match[pile], `save.match.${pile}`)
  }
  for (const pile of ['contestedPile', 'inPlay']) {
    match[pile].forEach((record, index) => {
      const name = `save.match.${pile}[${index}]`
      assertPlainObject(record, name)
      assertExactKeys(record, ['cardId', 'suppliedBy'], name)
    })
  }
  if (match.futureModifiers.length !== 0) {
    throw new TypeError('save.match.futureModifiers must remain empty')
  }
  for (const side of ['player', 'opponent']) {
    assertPlainObject(match[side], `save.match.${side}`)
    assertExactKeys(match[side], ['drawPile', 'wonPile'], `save.match.${side}`)
    assertDenseArray(match[side].drawPile, `save.match.${side}.drawPile`)
    assertDenseArray(match[side].wonPile, `save.match.${side}.wonPile`)
  }
}

function classicFromSave(save) {
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

function campaignFromSave(save) {
  return {
    mode: 'campaign',
    runId: save.runId,
    ruleset: save.ruleset,
    rng: save.rng,
    pendingEvent: save.pendingEvent,
    ...save.match,
  }
}

function stateFromSave(save) {
  return save.runType === 'campaign'
    ? campaignFromSave(save)
    : classicFromSave(save)
}

function matchForSave(run) {
  if (!isCampaignState(run)) {
    return {
      stage: run.stage,
      machineState: run.machineState,
      turn: run.turn,
      status: run.status,
      outcome: run.outcome,
      sourceDeck: run.zones.sourceDeck,
      player: run.zones.player,
      opponent: run.zones.opponent,
      contestedPile: run.zones.contestedPile,
      inPlay: run.zones.inPlay,
      burnPile: run.zones.burnPile,
      futureModifiers: [],
    }
  }
  return Object.fromEntries(
    CAMPAIGN_MATCH_KEYS.map((key) => [key, run[key]]),
  )
}

export function validateRunSaveVersion(save, expectedVersion) {
  if (expectedVersion !== SAVE_SCHEMA_VERSION) {
    throw new RangeError(`expectedVersion must be ${SAVE_SCHEMA_VERSION}`)
  }
  assertPlainObject(save, 'save')
  const versionDescriptor = Object.getOwnPropertyDescriptor(save, 'saveSchemaVersion')
  if (!versionDescriptor?.enumerable || !Object.hasOwn(versionDescriptor, 'value')) {
    throw new TypeError('save.saveSchemaVersion must be JSON-compatible data')
  }
  const saveSchemaVersion = versionDescriptor.value
  if (!Number.isSafeInteger(saveSchemaVersion)) {
    throw new TypeError('saveSchemaVersion must be a safe integer')
  }
  if (saveSchemaVersion !== expectedVersion) {
    throw new UnsupportedSaveVersionError(saveSchemaVersion)
  }
  assertExactKeys(save, SAVE_KEYS, 'save')
  if (!['classic', 'campaign'].includes(save.runType)) {
    throw new TypeError('runType must be classic or campaign')
  }
  const expectedRulesVersion = save.runType === 'campaign'
    ? CAMPAIGN_GAME_RULES_VERSION
    : GAME_RULES_VERSION
  if (!Number.isSafeInteger(save.gameRulesVersion)) {
    throw new TypeError('gameRulesVersion must be a safe integer')
  }
  if (save.gameRulesVersion !== expectedRulesVersion) {
    throw new UnsupportedGameRulesVersionError(save.gameRulesVersion)
  }
  assertCanonicalTimestamp(save.savedAt)
  if (save.runType === 'campaign') {
    assertPlainObject(save.match, 'save.match')
    assertExactKeys(save.match, CAMPAIGN_MATCH_KEYS, 'save.match')
    validateCampaignState(campaignFromSave(save))
  } else {
    assertClassicMatchStructure(save.match)
    validateMatchState(classicFromSave(save))
  }
  return save
}

export function validateRunSave(save) {
  return validateRunSaveVersion(save, SAVE_SCHEMA_VERSION)
}

export function createRunSave(run, options) {
  assertPlainObject(options, 'options')
  assertExactKeys(options, ['savedAt'], 'options')
  validateRunState(run)
  assertCanonicalTimestamp(options.savedAt)
  const campaign = isCampaignState(run)
  const save = {
    saveSchemaVersion: SAVE_SCHEMA_VERSION,
    gameRulesVersion: campaign ? CAMPAIGN_GAME_RULES_VERSION : GAME_RULES_VERSION,
    runType: campaign ? 'campaign' : 'classic',
    savedAt: options.savedAt,
    runId: run.runId,
    rng: run.rng,
    ruleset: run.ruleset,
    match: matchForSave(run),
    pendingEvent: run.pendingEvent,
  }
  const detached = cloneData(save)
  validateRunSave(detached)
  return deepFreeze(detached)
}

export function restoreRunSave(save) {
  validateRunSave(save)
  const run = cloneData(stateFromSave(save))
  validateRunState(run)
  return deepFreeze(run)
}

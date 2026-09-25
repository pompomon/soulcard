import { compareCards, isCardId } from './cards.js'

export const CAMPAIGN_EVENT_VERSION = 5

const SIDES = Object.freeze(['player', 'opponent'])
const ORIGINS = Object.freeze([
  'player.sourcePile',
  'player.drawPile',
  'player.hold',
  'opponent.sourcePile',
  'opponent.drawPile',
])
const DRAW_REASON = 'mutualInability'

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

function assertDenseArray(value, name, { nonempty = false } = {}) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${name} must be a dense array`)
  }
  if (nonempty && value.length === 0) {
    throw new TypeError(`${name} must not be empty`)
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

function assertInstanceId(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${name} must be a nonempty trimmed string`)
  }
}

function assertBase(event, expectedType) {
  if (event.eventVersion !== CAMPAIGN_EVENT_VERSION) {
    throw new TypeError(`eventVersion must be ${CAMPAIGN_EVENT_VERSION}`)
  }
  const marker = event.id.lastIndexOf(':clash-')
  const runId = event.id.slice(0, marker)
  if (
    marker <= 0
    || runId.trim() !== runId
    || !Number.isSafeInteger(event.turn)
    || event.turn < 1
    || event.id !== `${runId}:clash-${event.turn}`
  ) {
    throw new TypeError('event id must contain its run ID and clash turn')
  }
  if (event.type !== expectedType) {
    throw new TypeError(`event type must be ${expectedType}`)
  }
  if (!Number.isSafeInteger(event.encounterIndex) || event.encounterIndex < 0) {
    throw new TypeError('encounterIndex must be a nonnegative safe integer')
  }
  if (!Number.isSafeInteger(event.encounterAttempt) || event.encounterAttempt < 1) {
    throw new TypeError('encounterAttempt must be a positive safe integer')
  }
  if (typeof event.stateFingerprint !== 'string' || event.stateFingerprint.length === 0) {
    throw new TypeError('stateFingerprint must be a nonempty string')
  }
}

function assertReveals(reveals) {
  assertDenseArray(reveals, 'reveals', { nonempty: true })
  const seen = new Set()
  for (let index = 0; index < reveals.length; index += 1) {
    const reveal = reveals[index]
    const name = `reveals[${index}]`
    assertPlainObject(reveal, name)
    assertExactKeys(reveal, ['instanceId', 'cardId', 'suppliedBy', 'from'], name)
    assertInstanceId(reveal.instanceId, `${name}.instanceId`)
    if (!isCardId(reveal.cardId)) {
      throw new TypeError(`${name}.cardId must be canonical`)
    }
    if (!SIDES.includes(reveal.suppliedBy)) {
      throw new TypeError(`${name}.suppliedBy must be player or opponent`)
    }
    if (
      !ORIGINS.includes(reveal.from)
      || !reveal.from.startsWith(`${reveal.suppliedBy}.`)
    ) {
      throw new TypeError(`${name}.from must match its supplied side`)
    }
    if (seen.has(reveal.instanceId)) {
      throw new Error(`Instance ${reveal.instanceId} occurs more than once in reveals`)
    }
    seen.add(reveal.instanceId)
  }

  const pairedLength = reveals.length - (reveals.length % 2)
  for (let index = 0; index < pairedLength; index += 2) {
    if (
      reveals[index].suppliedBy !== 'player'
      || reveals[index + 1].suppliedBy !== 'opponent'
    ) {
      throw new Error('Complete reveal rounds must be ordered player then opponent')
    }
  }
  return seen
}

function assertTiedHistory(reveals, terminalIsSingleton) {
  const completeRounds = Math.floor(reveals.length / 2)
  const tiedRounds = terminalIsSingleton ? completeRounds : completeRounds - 1
  for (let round = 0; round < tiedRounds; round += 1) {
    const index = round * 2
    if (compareCards(reveals[index].cardId, reveals[index + 1].cardId) !== 0) {
      throw new Error('Every reveal round before the result must be tied')
    }
  }
}

function assertSettled(event) {
  const revealed = assertReveals(event.reveals)
  if (!SIDES.includes(event.winner)) {
    throw new TypeError('winner must be player or opponent')
  }
  assertDenseArray(event.transfers, 'transfers')
  assertDenseArray(event.burned, 'burned')

  const transferred = new Set()
  const destination = `${event.winner}.wonPile`
  for (let index = 0; index < event.transfers.length; index += 1) {
    const transfer = event.transfers[index]
    const name = `transfers[${index}]`
    assertPlainObject(transfer, name)
    assertExactKeys(transfer, ['instanceId', 'to'], name)
    assertInstanceId(transfer.instanceId, `${name}.instanceId`)
    if (transfer.to !== destination) {
      throw new TypeError(`${name}.to must be ${destination}`)
    }
    if (transferred.has(transfer.instanceId)) {
      throw new Error('Transfers must not contain duplicate instances')
    }
    transferred.add(transfer.instanceId)
  }

  const burned = new Set()
  for (let index = 0; index < event.burned.length; index += 1) {
    assertInstanceId(event.burned[index], `burned[${index}]`)
    if (burned.has(event.burned[index])) {
      throw new Error('Burned instances must not contain duplicates')
    }
    burned.add(event.burned[index])
  }

  if (
    transferred.size + burned.size !== revealed.size
    || [...transferred].some((instanceId) => !revealed.has(instanceId) || burned.has(instanceId))
    || [...burned].some((instanceId) => !revealed.has(instanceId))
  ) {
    throw new Error('Settlement must contain every revealed instance exactly once')
  }
  const expectedTransfers = event.reveals
    .filter(({ instanceId }) => transferred.has(instanceId))
    .map(({ instanceId }) => instanceId)
  const expectedBurned = event.reveals
    .filter(({ instanceId }) => burned.has(instanceId))
    .map(({ instanceId }) => instanceId)
  if (
    expectedTransfers.some((instanceId, index) => (
      event.transfers[index].instanceId !== instanceId
    ))
    || expectedBurned.some((instanceId, index) => event.burned[index] !== instanceId)
  ) {
    throw new Error('Settlement arrays must preserve reveal order')
  }
  for (const reveal of event.reveals) {
    if (reveal.suppliedBy === event.winner && !transferred.has(reveal.instanceId)) {
      throw new Error('Winner-supplied instances must transfer to the winner')
    }
  }

  const singleton = event.reveals.length % 2 === 1
  assertTiedHistory(event.reveals, singleton)
  if (singleton) {
    if (event.reveals.at(-1).suppliedBy !== event.winner) {
      throw new Error('The sole available card must belong to the event winner')
    }
  } else {
    const comparison = compareCards(
      event.reveals.at(-2).cardId,
      event.reveals.at(-1).cardId,
    )
    if (comparison === 0) {
      throw new Error('A settled clash must end with a decisive reveal')
    }
    const winner = comparison > 0 ? 'player' : 'opponent'
    if (winner !== event.winner) {
      throw new Error('The event winner must match the decisive reveal')
    }
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

export function validateCampaignEvent(event) {
  assertPlainObject(event, 'event')
  const typeDescriptor = Object.getOwnPropertyDescriptor(event, 'type')
  if (!typeDescriptor?.enumerable || !Object.hasOwn(typeDescriptor, 'value')) {
    throw new TypeError('event.type must be JSON-compatible data')
  }
  const eventType = typeDescriptor.value
  const common = [
    'eventVersion',
    'id',
    'type',
    'turn',
    'encounterIndex',
    'encounterAttempt',
  ]
  if (eventType === 'clashSettled') {
    assertExactKeys(event, [
      ...common,
      'winner',
      'reveals',
      'transfers',
      'burned',
      'stateFingerprint',
      'pendingPresentation',
    ], 'event')
    assertBase(event, 'clashSettled')
    if (event.pendingPresentation !== 'settlement-v1') {
      throw new TypeError('pendingPresentation must be settlement-v1')
    }
    assertSettled(event)
    return event
  }
  if (eventType === 'clashDrawn') {
    assertExactKeys(event, [
      ...common,
      'reason',
      'reveals',
      'stateFingerprint',
      'pendingPresentation',
    ], 'event')
    assertBase(event, 'clashDrawn')
    if (event.reason !== DRAW_REASON) {
      throw new TypeError(`reason must be ${DRAW_REASON}`)
    }
    if (event.pendingPresentation !== 'draw-v1') {
      throw new TypeError('pendingPresentation must be draw-v1')
    }
    assertReveals(event.reveals)
    if (event.reveals.length % 2 !== 0) {
      throw new Error('A drawn clash must end with a complete reveal round')
    }
    for (let index = 0; index < event.reveals.length; index += 2) {
      if (compareCards(event.reveals[index].cardId, event.reveals[index + 1].cardId) !== 0) {
        throw new Error('Every drawn reveal round must be tied')
      }
    }
    return event
  }
  throw new TypeError('event.type must be clashSettled or clashDrawn')
}

function createBase(options, type) {
  return {
    eventVersion: CAMPAIGN_EVENT_VERSION,
    id: `${options.runId}:clash-${options.turn}`,
    type,
    turn: options.turn,
    encounterIndex: options.encounterIndex,
    encounterAttempt: options.encounterAttempt,
  }
}

export function createCampaignClashSettledEvent(options) {
  assertPlainObject(options, 'options')
  assertExactKeys(options, [
    'runId',
    'turn',
    'encounterIndex',
    'encounterAttempt',
    'winner',
    'reveals',
    'transfers',
    'burned',
    'stateFingerprint',
  ], 'options')
  const event = {
    ...createBase(options, 'clashSettled'),
    winner: options.winner,
    reveals: options.reveals,
    transfers: options.transfers,
    burned: options.burned,
    stateFingerprint: options.stateFingerprint,
    pendingPresentation: 'settlement-v1',
  }
  validateCampaignEvent(event)
  return deepFreeze(cloneData(event))
}

export function createCampaignClashDrawnEvent(options) {
  assertPlainObject(options, 'options')
  assertExactKeys(options, [
    'runId',
    'turn',
    'encounterIndex',
    'encounterAttempt',
    'reveals',
    'stateFingerprint',
  ], 'options')
  const event = {
    ...createBase(options, 'clashDrawn'),
    reason: DRAW_REASON,
    reveals: options.reveals,
    stateFingerprint: options.stateFingerprint,
    pendingPresentation: 'draw-v1',
  }
  validateCampaignEvent(event)
  return deepFreeze(cloneData(event))
}

import { getCard, isCardId } from './cards.js'

export const EVENT_VERSION = 1

const SIDES = Object.freeze(['player', 'opponent'])
const STAGES = Object.freeze(['source', 'personal'])
const SETTLEMENT_PRESENTATION = 'settlement-v1'
const DRAW_PRESENTATION = 'draw-v1'
const DRAW_REASON = 'mutualInability'

function assertPlainObject(value, name) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new TypeError(`${name} must be a plain object`)
  }
}

function assertExactKeys(value, expected, name) {
  const keys = Reflect.ownKeys(value)
  if (
    keys.length !== expected.length ||
    keys.some((key) => typeof key !== 'string' || !expected.includes(key)) ||
    expected.some((key) => !Object.hasOwn(value, key))
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
  const propertyNames = Object.getOwnPropertyNames(value)
  if (
    propertyNames.length !== value.length + 1 ||
    propertyNames.at(-1) !== 'length' ||
    Object.getOwnPropertySymbols(value).length !== 0
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

function assertRunId(runId) {
  if (typeof runId !== 'string' || runId.length === 0 || runId.trim() !== runId) {
    throw new TypeError('runId must be a nonempty trimmed string')
  }
}

function assertTurn(turn) {
  if (!Number.isSafeInteger(turn) || turn < 1) {
    throw new TypeError('turn must be a positive safe integer')
  }
}

function assertStage(stage) {
  if (!STAGES.includes(stage)) {
    throw new TypeError('stage must be source or personal')
  }
}

function assertRevealRecords(reveals) {
  assertDenseArray(reveals, 'reveals', { nonempty: true })
  const seen = new Set()

  for (let index = 0; index < reveals.length; index += 1) {
    const record = reveals[index]
    const name = `reveals[${index}]`
    assertPlainObject(record, name)
    assertExactKeys(record, ['cardId', 'suppliedBy'], name)
    if (!isCardId(record.cardId)) {
      throw new TypeError(`${name} contains an unknown card ID`)
    }
    if (!SIDES.includes(record.suppliedBy)) {
      throw new TypeError(`${name}.suppliedBy must be player or opponent`)
    }
    if (seen.has(record.cardId)) {
      throw new Error(`Card ${record.cardId} occurs more than once in reveals`)
    }
    seen.add(record.cardId)
  }

  const pairedLength = reveals.length - (reveals.length % 2)
  for (let index = 0; index < pairedLength; index += 2) {
    if (
      reveals[index].suppliedBy !== 'player' ||
      reveals[index + 1].suppliedBy !== 'opponent'
    ) {
      throw new Error('Complete reveal rounds must be ordered player then opponent')
    }
  }

  return seen
}

function assertTransfers(transfers, winner) {
  assertDenseArray(transfers, 'transfers')
  const seen = new Set()
  const destination = `${winner}.wonPile`

  for (let index = 0; index < transfers.length; index += 1) {
    const transfer = transfers[index]
    const name = `transfers[${index}]`
    assertPlainObject(transfer, name)
    assertExactKeys(transfer, ['cardId', 'to'], name)
    if (!isCardId(transfer.cardId)) {
      throw new TypeError(`${name} contains an unknown card ID`)
    }
    if (transfer.to !== destination) {
      throw new TypeError(`${name}.to must be ${destination}`)
    }
    if (seen.has(transfer.cardId)) {
      throw new Error(`Card ${transfer.cardId} occurs more than once in transfers`)
    }
    seen.add(transfer.cardId)
  }

  return seen
}

function assertBurned(burned) {
  assertDenseArray(burned, 'burned')
  const seen = new Set()

  for (let index = 0; index < burned.length; index += 1) {
    const cardId = burned[index]
    if (!isCardId(cardId)) {
      throw new TypeError(`burned[${index}] contains an unknown card ID`)
    }
    if (seen.has(cardId)) {
      throw new Error(`Card ${cardId} occurs more than once in burned`)
    }
    seen.add(cardId)
  }

  return seen
}

function assertSettlementCoverage(reveals, transfers, burned, winner) {
  const revealed = assertRevealRecords(reveals)
  const transferred = assertTransfers(transfers, winner)
  const burnedSet = assertBurned(burned)

  for (const cardId of transferred) {
    if (!revealed.has(cardId) || burnedSet.has(cardId)) {
      throw new Error('Settlement must contain each revealed card exactly once')
    }
  }
  for (const cardId of burnedSet) {
    if (!revealed.has(cardId)) {
      throw new Error('Settlement must contain each revealed card exactly once')
    }
  }
  if (transferred.size + burnedSet.size !== revealed.size) {
    throw new Error('Settlement must contain each revealed card exactly once')
  }

  const expectedTransfers = reveals
    .filter(({ cardId }) => transferred.has(cardId))
    .map(({ cardId }) => cardId)
  const expectedBurned = reveals
    .filter(({ cardId }) => burnedSet.has(cardId))
    .map(({ cardId }) => cardId)
  if (
    expectedTransfers.some((cardId, index) => transfers[index].cardId !== cardId) ||
    expectedBurned.some((cardId, index) => burned[index] !== cardId)
  ) {
    throw new Error('Settlement arrays must preserve reveal order')
  }
  for (const { cardId, suppliedBy } of reveals) {
    if (suppliedBy === winner && !transferred.has(cardId)) {
      throw new Error('Winner-supplied cards must transfer to the winner')
    }
  }
}

function assertBaseEvent(event, expectedType) {
  if (event.eventVersion !== EVENT_VERSION) {
    throw new TypeError(`eventVersion must be ${EVENT_VERSION}`)
  }
  assertRunId(event.id.slice(0, event.id.lastIndexOf(':clash-')))
  assertTurn(event.turn)
  if (event.id !== `${event.id.slice(0, event.id.lastIndexOf(':clash-'))}:clash-${event.turn}`) {
    throw new TypeError('event id must end with its clash turn')
  }
  if (event.type !== expectedType) {
    throw new TypeError(`event type must be ${expectedType}`)
  }
  assertStage(event.stage)
}

function cloneData(value) {
  if (Array.isArray(value)) {
    return value.map(cloneData)
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneData(child)]))
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

export function validateCommittedEvent(event) {
  assertPlainObject(event, 'event')
  if (event.type === 'clashSettled') {
    assertExactKeys(event, [
      'eventVersion',
      'id',
      'type',
      'turn',
      'stage',
      'winner',
      'reveals',
      'transfers',
      'burned',
      'pendingPresentation',
    ], 'event')
    assertBaseEvent(event, 'clashSettled')
    if (!SIDES.includes(event.winner)) {
      throw new TypeError('winner must be player or opponent')
    }
    if (event.pendingPresentation !== SETTLEMENT_PRESENTATION) {
      throw new TypeError(`pendingPresentation must be ${SETTLEMENT_PRESENTATION}`)
    }
    assertSettlementCoverage(event.reveals, event.transfers, event.burned, event.winner)
    return event
  }

  if (event.type === 'clashDrawn') {
    assertExactKeys(event, [
      'eventVersion',
      'id',
      'type',
      'turn',
      'stage',
      'reason',
      'reveals',
      'pendingPresentation',
    ], 'event')
    assertBaseEvent(event, 'clashDrawn')
    if (event.reason !== DRAW_REASON) {
      throw new TypeError(`reason must be ${DRAW_REASON}`)
    }
    if (event.pendingPresentation !== DRAW_PRESENTATION) {
      throw new TypeError(`pendingPresentation must be ${DRAW_PRESENTATION}`)
    }
    assertRevealRecords(event.reveals)
    if (
      event.reveals.length % 2 !== 0 ||
      getCard(event.reveals.at(-2).cardId).value !== getCard(event.reveals.at(-1).cardId).value
    ) {
      throw new Error('A drawn clash must end with a complete tied reveal round')
    }
    return event
  }

  throw new TypeError('event.type must be clashSettled or clashDrawn')
}

export function createClashSettledEvent({
  runId,
  turn,
  stage,
  winner,
  reveals,
  transfers,
  burned,
}) {
  assertRunId(runId)
  const event = {
    eventVersion: EVENT_VERSION,
    id: `${runId}:clash-${turn}`,
    type: 'clashSettled',
    turn,
    stage,
    winner,
    reveals: cloneData(reveals),
    transfers: cloneData(transfers),
    burned: cloneData(burned),
    pendingPresentation: SETTLEMENT_PRESENTATION,
  }
  validateCommittedEvent(event)
  return deepFreeze(event)
}

export function createClashDrawnEvent({
  runId,
  turn,
  stage,
  reason = DRAW_REASON,
  reveals,
}) {
  assertRunId(runId)
  const event = {
    eventVersion: EVENT_VERSION,
    id: `${runId}:clash-${turn}`,
    type: 'clashDrawn',
    turn,
    stage,
    reason,
    reveals: cloneData(reveals),
    pendingPresentation: DRAW_PRESENTATION,
  }
  validateCommittedEvent(event)
  return deepFreeze(event)
}

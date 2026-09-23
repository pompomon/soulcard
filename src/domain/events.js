import { compareCards, getCard, isCardId } from './cards.js'

export const EVENT_VERSION = 4

const SIDES = Object.freeze(['player', 'opponent'])
const STAGES = Object.freeze(['source', 'personal'])
const ORIGIN_EVENT_VERSION = 3
const SUPPORTED_EVENT_VERSIONS = Object.freeze([2, ORIGIN_EVENT_VERSION, EVENT_VERSION])
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

function assertStateFingerprint(stateFingerprint) {
  if (typeof stateFingerprint !== 'string' || stateFingerprint.length === 0) {
    throw new TypeError('stateFingerprint must be a nonempty string')
  }
}

function assertRevealRecords(reveals, eventVersion) {
  assertDenseArray(reveals, 'reveals', { nonempty: true })
  const seen = new Set()
  let personalOriginReached = false

  for (let index = 0; index < reveals.length; index += 1) {
    const record = reveals[index]
    const name = `reveals[${index}]`
    assertPlainObject(record, name)
    assertExactKeys(
      record,
      eventVersion >= ORIGIN_EVENT_VERSION
        ? ['cardId', 'suppliedBy', 'from']
        : ['cardId', 'suppliedBy'],
      name,
    )
    if (!isCardId(record.cardId)) {
      throw new TypeError(`${name} contains an unknown card ID`)
    }
    if (!SIDES.includes(record.suppliedBy)) {
      throw new TypeError(`${name}.suppliedBy must be player or opponent`)
    }
    if (eventVersion >= ORIGIN_EVENT_VERSION) {
      const personalOrigin = `${record.suppliedBy}.drawPile`
      if (record.from !== 'sourceDeck' && record.from !== personalOrigin) {
        throw new TypeError(`${name}.from must match its committed reveal origin`)
      }
      if (record.from === 'sourceDeck') {
        if (personalOriginReached) {
          throw new Error('Reveal origins cannot return to the source stage')
        }
      } else {
        personalOriginReached = true
      }
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
    if (
      eventVersion >= ORIGIN_EVENT_VERSION
      && (reveals[index].from === 'sourceDeck')
      !== (reveals[index + 1].from === 'sourceDeck')
    ) {
      throw new Error('Complete reveal rounds must use the same stage origin')
    }
  }
  if (
    eventVersion >= ORIGIN_EVENT_VERSION
    && reveals.length % 2 === 1
    && reveals.at(-1).from === 'sourceDeck'
  ) {
    throw new Error('A singleton reveal must originate from a personal draw pile')
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

function assertSettlementCoverage(reveals, transfers, burned, winner, eventVersion) {
  const revealed = assertRevealRecords(reveals, eventVersion)
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

function assertTiedRound(reveals, index) {
  if (compareCards(reveals[index].cardId, reveals[index + 1].cardId) !== 0) {
    throw new Error('Every reveal round before the decisive result must be tied')
  }
}

function assertSettledRevealHistory(reveals, winner, stage, eventVersion) {
  const hasAvailableWinnerCard = reveals.length % 2 === 1
  const completeRounds = Math.floor(reveals.length / 2)
  const tiedRounds = hasAvailableWinnerCard ? completeRounds : completeRounds - 1

  for (let round = 0; round < tiedRounds; round += 1) {
    assertTiedRound(reveals, round * 2)
  }

  if (hasAvailableWinnerCard) {
    if (stage !== 'personal' || reveals.at(-1).suppliedBy !== winner) {
      throw new Error('A single available winning card is valid only in the personal stage')
    }
    return
  }

  const comparison = eventVersion === EVENT_VERSION
    ? compareCards(reveals.at(-2).cardId, reveals.at(-1).cardId)
    : getCard(reveals.at(-2).cardId).value - getCard(reveals.at(-1).cardId).value
  if (comparison === 0) {
    throw new Error('A settled clash must end with a decisive result')
  }
  const decisiveWinner = comparison > 0 ? 'player' : 'opponent'
  if (winner !== decisiveWinner) {
    throw new Error('The event winner must match the decisive reveal round')
  }
}

function assertBaseEvent(event, expectedType) {
  if (!SUPPORTED_EVENT_VERSIONS.includes(event.eventVersion)) {
    throw new TypeError(`eventVersion must be ${SUPPORTED_EVENT_VERSIONS.join(' or ')}`)
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
  const typeDescriptor = Object.getOwnPropertyDescriptor(event, 'type')
  if (!typeDescriptor?.enumerable || !Object.hasOwn(typeDescriptor, 'value')) {
    throw new TypeError('event.type must be JSON-compatible data')
  }
  if (typeDescriptor.value === 'clashSettled') {
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
      'stateFingerprint',
      'pendingPresentation',
    ], 'event')
    assertBaseEvent(event, 'clashSettled')
    if (!SIDES.includes(event.winner)) {
      throw new TypeError('winner must be player or opponent')
    }
    if (event.pendingPresentation !== SETTLEMENT_PRESENTATION) {
      throw new TypeError(`pendingPresentation must be ${SETTLEMENT_PRESENTATION}`)
    }
    assertStateFingerprint(event.stateFingerprint)
    assertSettlementCoverage(
      event.reveals,
      event.transfers,
      event.burned,
      event.winner,
      event.eventVersion,
    )
    if (
      event.eventVersion >= ORIGIN_EVENT_VERSION
      && event.stage === 'source'
      && event.reveals.some(({ from }) => from !== 'sourceDeck')
    ) {
      throw new Error('Source-stage events must reveal only from the source deck')
    }
    assertSettledRevealHistory(event.reveals, event.winner, event.stage, event.eventVersion)
    return event
  }

  if (typeDescriptor.value === 'clashDrawn') {
    assertExactKeys(event, [
      'eventVersion',
      'id',
      'type',
      'turn',
      'stage',
      'reason',
      'reveals',
      'stateFingerprint',
      'pendingPresentation',
    ], 'event')
    assertBaseEvent(event, 'clashDrawn')
    if (event.reason !== DRAW_REASON) {
      throw new TypeError(`reason must be ${DRAW_REASON}`)
    }
    if (event.pendingPresentation !== DRAW_PRESENTATION) {
      throw new TypeError(`pendingPresentation must be ${DRAW_PRESENTATION}`)
    }
    assertStateFingerprint(event.stateFingerprint)
    assertRevealRecords(event.reveals, event.eventVersion)
    if (event.stage !== 'personal' || event.reveals.length % 2 !== 0) {
      throw new Error('A drawn clash must end with a complete tied reveal round')
    }
    for (let index = 0; index < event.reveals.length; index += 2) {
      assertTiedRound(event.reveals, index)
    }
    return event
  }

  throw new TypeError('event.type must be clashSettled or clashDrawn')
}

export function createClashSettledEvent(options) {
  assertPlainObject(options, 'options')
  assertExactKeys(
    options,
    ['runId', 'turn', 'stage', 'winner', 'reveals', 'transfers', 'burned', 'stateFingerprint'],
    'options',
  )
  assertRunId(options.runId)
  const event = {
    eventVersion: EVENT_VERSION,
    id: `${options.runId}:clash-${options.turn}`,
    type: 'clashSettled',
    turn: options.turn,
    stage: options.stage,
    winner: options.winner,
    reveals: options.reveals,
    transfers: options.transfers,
    burned: options.burned,
    stateFingerprint: options.stateFingerprint,
    pendingPresentation: SETTLEMENT_PRESENTATION,
  }
  validateCommittedEvent(event)
  return deepFreeze(cloneData(event))
}

export function createClashDrawnEvent(options) {
  assertPlainObject(options, 'options')
  const keys = ['runId', 'turn', 'stage', 'reveals', 'stateFingerprint']
  if (Object.hasOwn(options, 'reason')) {
    keys.push('reason')
  }
  assertExactKeys(options, keys, 'options')
  assertRunId(options.runId)
  const event = {
    eventVersion: EVENT_VERSION,
    id: `${options.runId}:clash-${options.turn}`,
    type: 'clashDrawn',
    turn: options.turn,
    stage: options.stage,
    reason: Object.hasOwn(options, 'reason') ? options.reason : DRAW_REASON,
    reveals: options.reveals,
    stateFingerprint: options.stateFingerprint,
    pendingPresentation: DRAW_PRESENTATION,
  }
  validateCommittedEvent(event)
  return deepFreeze(cloneData(event))
}

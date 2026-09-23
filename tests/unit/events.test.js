import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createClashDrawnEvent,
  createClashSettledEvent,
  EVENT_VERSION,
  validateCommittedEvent,
} from '../../src/domain/events.js'

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function allObjects(value) {
  if (value === null || typeof value !== 'object') {
    return []
  }
  return [value, ...Object.values(value).flatMap(allObjects)]
}

const SETTLED_INPUT = {
  runId: 'run-42',
  turn: 17,
  stage: 'personal',
  winner: 'player',
  reveals: [
    { cardId: 'c-10H', suppliedBy: 'player', from: 'player.drawPile' },
    { cardId: 'c-10C', suppliedBy: 'opponent', from: 'opponent.drawPile' },
    { cardId: 'c-AS', suppliedBy: 'player', from: 'player.drawPile' },
    { cardId: 'c-KD', suppliedBy: 'opponent', from: 'opponent.drawPile' },
  ],
  transfers: [
    { cardId: 'c-10H', to: 'player.wonPile' },
    { cardId: 'c-AS', to: 'player.wonPile' },
  ],
  burned: ['c-10C', 'c-KD'],
  stateFingerprint: 'post-commit-state',
}

test('settled clash events use the canonical versioned shape and detached immutable data', () => {
  const input = clone(SETTLED_INPUT)
  const event = createClashSettledEvent(input)

  assert.deepEqual(event, {
    eventVersion: EVENT_VERSION,
    id: 'run-42:clash-17',
    type: 'clashSettled',
    turn: 17,
    stage: 'personal',
    winner: 'player',
    reveals: SETTLED_INPUT.reveals,
    transfers: SETTLED_INPUT.transfers,
    burned: SETTLED_INPUT.burned,
    stateFingerprint: SETTLED_INPUT.stateFingerprint,
    pendingPresentation: 'settlement-v1',
  })

  assert.equal(Object.hasOwn(event, 'runId'), false)
  assert.ok(allObjects(event).every(Object.isFrozen))
  assert.equal(validateCommittedEvent(event), event)
  assert.doesNotThrow(() => validateCommittedEvent(clone(event)))

  input.reveals[0].cardId = 'c-2S'
  input.transfers.length = 0
  input.burned.push('c-3S')
  assert.deepEqual(event.reveals, SETTLED_INPUT.reveals)
  assert.deepEqual(event.transfers, SETTLED_INPUT.transfers)
  assert.deepEqual(event.burned, SETTLED_INPUT.burned)
})

test('settled event validation applies the 2-over-Ace comparison exception', () => {
  const input = {
    runId: 'two-over-ace',
    turn: 1,
    stage: 'source',
    winner: 'player',
    reveals: [
      { cardId: 'c-2S', suppliedBy: 'player', from: 'sourceDeck' },
      { cardId: 'c-AH', suppliedBy: 'opponent', from: 'sourceDeck' },
    ],
    transfers: [{ cardId: 'c-2S', to: 'player.wonPile' }],
    burned: ['c-AH'],
    stateFingerprint: 'two-over-ace-state',
  }

  assert.doesNotThrow(() => createClashSettledEvent(input))
  assert.throws(() => createClashSettledEvent({
    ...clone(input),
    winner: 'opponent',
    transfers: [{ cardId: 'c-AH', to: 'opponent.wonPile' }],
    burned: ['c-2S'],
  }), /decisive reveal round/)
})

test('terminal draws use a distinct event without settlement fields', () => {
  const reveals = [
    { cardId: 'c-10S', suppliedBy: 'player', from: 'player.drawPile' },
    { cardId: 'c-10H', suppliedBy: 'opponent', from: 'opponent.drawPile' },
  ]
  const event = createClashDrawnEvent({
    runId: 'draw-run',
    turn: 3,
    stage: 'personal',
    reveals,
    stateFingerprint: 'draw-post-commit-state',
  })

  assert.deepEqual(event, {
    eventVersion: EVENT_VERSION,
    id: 'draw-run:clash-3',
    type: 'clashDrawn',
    turn: 3,
    stage: 'personal',
    reason: 'mutualInability',
    reveals,
    stateFingerprint: 'draw-post-commit-state',
    pendingPresentation: 'draw-v1',
  })
  assert.equal(Object.hasOwn(event, 'winner'), false)
  assert.equal(Object.hasOwn(event, 'transfers'), false)
  assert.equal(Object.hasOwn(event, 'burned'), false)
  assert.ok(allObjects(event).every(Object.isFrozen))
  assert.doesNotThrow(() => validateCommittedEvent(clone(event)))
})

test('settled events reject incomplete, duplicated, misordered, or redirected settlement data', () => {
  const invalid = [
    { ...clone(SETTLED_INPUT), transfers: SETTLED_INPUT.transfers.slice(0, 1) },
    { ...clone(SETTLED_INPUT), burned: ['c-10C', 'c-10C', 'c-KD'] },
    {
      ...clone(SETTLED_INPUT),
      transfers: [...SETTLED_INPUT.transfers].reverse(),
    },
    {
      ...clone(SETTLED_INPUT),
      transfers: SETTLED_INPUT.transfers.map((transfer) => ({
        ...transfer,
        to: 'opponent.wonPile',
      })),
    },
    {
      ...clone(SETTLED_INPUT),
      burned: ['c-10H', 'c-10C', 'c-KD'],
      transfers: SETTLED_INPUT.transfers.slice(1),
    },
  ]

  for (const input of invalid) {
    assert.throws(() => createClashSettledEvent(input))
  }
})

test('event validation rejects malformed metadata, reveal rounds, and draw outcomes', () => {
  const settled = createClashSettledEvent(SETTLED_INPUT)
  const invalidEvents = [
    { ...clone(settled), eventVersion: 1 },
    { ...clone(settled), id: 'run-42:clash-16' },
    { ...clone(settled), turn: 0 },
    { ...clone(settled), stage: 'Source' },
    { ...clone(settled), winner: 'draw' },
    { ...clone(settled), stateFingerprint: '' },
    { ...clone(settled), pendingPresentation: 'draw-v1' },
    { ...clone(settled), extra: true },
    {
      ...clone(settled),
      reveals: [
        { cardId: 'c-10C', suppliedBy: 'opponent' },
        { cardId: 'c-10H', suppliedBy: 'player' },
        ...settled.reveals.slice(2),
      ],
    },
  ]
  for (const event of invalidEvents) {
    assert.throws(() => validateCommittedEvent(event))
  }

  assert.throws(() => createClashDrawnEvent({
    runId: 'draw-run',
    turn: 1,
    stage: 'personal',
    stateFingerprint: 'draw-state',
    reveals: [
      { cardId: 'c-10S', suppliedBy: 'player', from: 'player.drawPile' },
      { cardId: 'c-9H', suppliedBy: 'opponent', from: 'opponent.drawPile' },
    ],
  }), /tied/)
  assert.throws(() => createClashDrawnEvent({
    runId: 'draw-run',
    turn: 1,
    stage: 'personal',
    stateFingerprint: 'draw-state',
    reveals: [{ cardId: 'c-10S', suppliedBy: 'player', from: 'player.drawPile' }],
  }), /complete tied reveal round/)
  assert.throws(() => createClashSettledEvent({
    runId: 'source-singleton',
    turn: 1,
    stage: 'source',
    winner: 'player',
    reveals: [{ cardId: 'c-AS', suppliedBy: 'player', from: 'sourceDeck' }],
    transfers: [{ cardId: 'c-AS', to: 'player.wonPile' }],
    burned: [],
    stateFingerprint: 'settled-state',
  }))
  assert.throws(() => createClashSettledEvent({
    ...clone(SETTLED_INPUT),
    winner: 'opponent',
    transfers: SETTLED_INPUT.reveals.map(({ cardId }) => ({
      cardId,
      to: 'opponent.wonPile',
    })),
    burned: [],
  }), /decisive reveal round/)
  assert.throws(() => createClashDrawnEvent({
    runId: 'late-draw',
    turn: 1,
    stage: 'personal',
    stateFingerprint: 'draw-state',
    reveals: [
      { cardId: 'c-AS', suppliedBy: 'player', from: 'player.drawPile' },
      { cardId: 'c-KH', suppliedBy: 'opponent', from: 'opponent.drawPile' },
      { cardId: 'c-10S', suppliedBy: 'player', from: 'player.drawPile' },
      { cardId: 'c-10H', suppliedBy: 'opponent', from: 'opponent.drawPile' },
    ],
  }), /before the decisive result/)
})

test('event validation retains read compatibility with version 2 reveal records', () => {
  const current = createClashSettledEvent(SETTLED_INPUT)
  const legacy = {
    ...clone(current),
    eventVersion: 2,
    reveals: current.reveals.map(({ cardId, suppliedBy }) => ({ cardId, suppliedBy })),
  }

  assert.equal(validateCommittedEvent(legacy), legacy)
})

test('version 3 events reject missing, mismatched, or reversing reveal origins', () => {
  const settled = createClashSettledEvent(SETTLED_INPUT)
  const invalidReveals = [
    settled.reveals.map(({ cardId, suppliedBy }) => ({ cardId, suppliedBy })),
    settled.reveals.map((reveal, index) => (
      index === 0 ? { ...reveal, from: 'opponent.drawPile' } : reveal
    )),
    settled.reveals.map((reveal, index) => (
      index === 1 ? { ...reveal, from: 'sourceDeck' } : reveal
    )),
    settled.reveals.map((reveal, index) => (
      index < 2 ? reveal : { ...reveal, from: 'sourceDeck' }
    )),
  ]

  for (const reveals of invalidReveals) {
    assert.throws(() => validateCommittedEvent({ ...clone(settled), reveals }))
  }
})

test('event factories reject accessors and extra fields before reading nested data', () => {
  const input = clone(SETTLED_INPUT)
  let calls = 0
  Object.defineProperty(input, 'reveals', {
    enumerable: true,
    get() {
      calls += 1
      return SETTLED_INPUT.reveals
    },
  })
  assert.throws(() => createClashSettledEvent(input), /JSON-compatible data/)
  assert.equal(calls, 0)
  assert.throws(
    () => createClashSettledEvent({ ...clone(SETTLED_INPUT), extra: true }),
    /must contain only/,
  )
})

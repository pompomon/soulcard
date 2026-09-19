import assert from 'node:assert/strict'
import test from 'node:test'
import { CARD_IDS } from '../../src/domain/cards.js'
import {
  assertStableBoundary,
  assertZoneInvariants,
  getCardOwnership,
} from '../../src/domain/invariants.js'
import { createRng } from '../../src/domain/rng.js'
import { createInitialZones } from '../../src/domain/zones.js'

function revealRecords(cardIds) {
  return cardIds.map((cardId, index) => ({
    cardId,
    suppliedBy: index % 2 === 0 ? 'player' : 'opponent',
  }))
}

function createDistributedZones() {
  return {
    sourceDeck: CARD_IDS.slice(0, 4),
    player: {
      drawPile: CARD_IDS.slice(4, 10),
      wonPile: CARD_IDS.slice(10, 16),
    },
    opponent: {
      drawPile: CARD_IDS.slice(16, 22),
      wonPile: CARD_IDS.slice(22, 28),
    },
    contestedPile: revealRecords(CARD_IDS.slice(28, 36)),
    burnPile: CARD_IDS.slice(36, 44),
    inPlay: revealRecords(CARD_IDS.slice(44)),
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
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

test('all eight ordered zones conserve cards and determine ownership', () => {
  const zones = createDistributedZones()
  assert.doesNotThrow(() => assertZoneInvariants(zones))

  assert.equal(getCardOwnership(zones, zones.sourceDeck[0]), 'unowned')
  assert.equal(getCardOwnership(zones, zones.player.drawPile[0]), 'player')
  assert.equal(getCardOwnership(zones, zones.player.wonPile[0]), 'player')
  assert.equal(getCardOwnership(zones, zones.opponent.drawPile[0]), 'opponent')
  assert.equal(getCardOwnership(zones, zones.opponent.wonPile[0]), 'opponent')
  assert.equal(getCardOwnership(zones, zones.contestedPile[0].cardId), 'unsettled')
  assert.equal(getCardOwnership(zones, zones.burnPile[0]), 'unowned')
  assert.equal(getCardOwnership(zones, zones.inPlay[0].cardId), 'unsettled')
  assert.throws(() => getCardOwnership(zones, 'c-1S'), {
    name: 'TypeError',
    message: 'cardId must be a known card ID',
  })
})

test('stable boundaries require empty inPlay but may retain a contested pile', () => {
  const resolving = createDistributedZones()
  assert.doesNotThrow(() => assertZoneInvariants(resolving))
  assert.throws(() => assertStableBoundary(resolving), {
    message: 'Stable boundaries require an empty inPlay zone',
  })

  const stable = {
    ...resolving,
    contestedPile: [...resolving.contestedPile, ...resolving.inPlay],
    inPlay: [],
  }
  assert.doesNotThrow(() => assertStableBoundary(stable))
  assert.ok(stable.contestedPile.length > 0)
})

test('validation preserves pile and record ordering without mutation', () => {
  const zones = deepFreeze(createDistributedZones())
  const before = clone(zones)

  assert.doesNotThrow(() => assertZoneInvariants(zones))
  assert.equal(getCardOwnership(zones, zones.contestedPile[3].cardId), 'unsettled')
  assert.deepEqual(zones, before)
})

test('missing, duplicate, and unknown cards are rejected', () => {
  const missing = createInitialZones(createRng(1))
  const missingId = missing.sourceDeck.pop()
  assert.throws(() => assertZoneInvariants(missing), {
    message: `Zones must contain all 52 cards; missing: ${missingId}`,
  })

  const duplicate = createInitialZones(createRng(1))
  duplicate.sourceDeck[1] = duplicate.sourceDeck[0]
  assert.throws(() => assertZoneInvariants(duplicate), /occurs in more than one zone/)

  const unknown = createInitialZones(createRng(1))
  unknown.sourceDeck[0] = 'c-1S'
  assert.throws(() => assertZoneInvariants(unknown), {
    name: 'TypeError',
    message: 'sourceDeck contains an unknown card ID',
  })
})

test('malformed zone containers and piles are rejected', () => {
  const valid = createInitialZones(createRng(2))
  const malformed = [
    null,
    [],
    {},
    { ...valid, sourceDeck: null },
    { ...valid, player: null },
    { ...valid, player: [] },
    { ...valid, player: {} },
    { ...valid, player: { drawPile: [], wonPile: null } },
    { ...valid, opponent: { drawPile: null, wonPile: [] } },
    { ...valid, contestedPile: {} },
    { ...valid, burnPile: 'cards' },
    { ...valid, inPlay: new Set() },
  ]

  for (const zones of malformed) {
    assert.throws(() => assertZoneInvariants(zones), TypeError)
  }
})

test('sparse piles and non-ID ordinary-pile entries are rejected', () => {
  const sparse = createInitialZones(createRng(3))
  delete sparse.sourceDeck[7]
  assert.throws(() => assertZoneInvariants(sparse), {
    name: 'TypeError',
    message: 'sourceDeck must be a dense array',
  })

  for (const invalid of [undefined, null, false, 2, {}, ['c-2S']]) {
    const zones = createInitialZones(createRng(3))
    zones.sourceDeck[0] = invalid
    assert.throws(() => assertZoneInvariants(zones), TypeError)
  }
})

test('malformed reveal records and provenance are rejected', () => {
  const mutators = [
    (zones) => { zones.contestedPile[0] = null },
    (zones) => { zones.contestedPile[0] = [] },
    (zones) => { zones.contestedPile[0] = {} },
    (zones) => { delete zones.contestedPile[0].cardId },
    (zones) => { delete zones.contestedPile[0].suppliedBy },
    (zones) => { zones.contestedPile[0].extra = true },
    (zones) => { zones.contestedPile[0].cardId = 'c-1S' },
    (zones) => { zones.contestedPile[0].suppliedBy = 'source' },
    (zones) => { zones.contestedPile[0].suppliedBy = 'Player' },
    (zones) => { delete zones.inPlay[2] },
  ]

  for (const mutate of mutators) {
    const zones = createDistributedZones()
    mutate(zones)
    assert.throws(() => assertZoneInvariants(zones), TypeError)
  }
})

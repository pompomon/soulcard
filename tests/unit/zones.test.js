import assert from 'node:assert/strict'
import test from 'node:test'
import { CARD_IDS } from '../../src/domain/cards.js'
import { assertStableBoundary, assertZoneInvariants } from '../../src/domain/invariants.js'
import { createRng } from '../../src/domain/rng.js'
import { createInitialZones } from '../../src/domain/zones.js'

test('initial zones contain one shuffled source deck and seven empty ordered piles', () => {
  const rng = createRng(12345)
  const zones = createInitialZones(rng)

  assert.equal(zones.sourceDeck.length, 52)
  assert.deepEqual([...zones.sourceDeck].sort(), [...CARD_IDS].sort())
  assert.deepEqual(zones.player, { drawPile: [], wonPile: [] })
  assert.deepEqual(zones.opponent, { drawPile: [], wonPile: [] })
  assert.deepEqual(zones.contestedPile, [])
  assert.deepEqual(zones.burnPile, [])
  assert.deepEqual(zones.inPlay, [])
  assert.equal(Object.hasOwn(zones, 'stage'), false)
  assert.equal(Object.hasOwn(zones, 'machineState'), false)
  assert.doesNotThrow(() => assertZoneInvariants(zones))
  assert.doesNotThrow(() => assertStableBoundary(zones))
  assert.deepEqual(rng.snapshot(), {
    algorithm: 'mulberry32',
    seed: 12345,
    state: 3215555592,
  })
})

test('every setup returns fresh structures without aliases', () => {
  const first = createInitialZones(createRng(12345))
  const second = createInitialZones(createRng(12345))

  assert.deepEqual(first, second)
  assert.notEqual(first, second)
  assert.notEqual(first.sourceDeck, second.sourceDeck)
  assert.notEqual(first.player, second.player)
  assert.notEqual(first.opponent, second.opponent)

  const firstPiles = [
    first.sourceDeck,
    first.player.drawPile,
    first.player.wonPile,
    first.opponent.drawPile,
    first.opponent.wonPile,
    first.contestedPile,
    first.burnPile,
    first.inPlay,
  ]
  assert.equal(new Set(firstPiles).size, firstPiles.length)

  first.sourceDeck.shift()
  first.player.drawPile.push('c-2S')
  assert.equal(second.sourceDeck.length, 52)
  assert.deepEqual(second.player.drawPile, [])
  assert.equal(CARD_IDS.length, 52)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { CARD_IDS } from '../../src/domain/cards.js'
import { createSourceDeck } from '../../src/domain/deck.js'
import { createRng, restoreRng } from '../../src/domain/rng.js'

const SEED_12345_DECK = [
  'c-6D', 'c-JH', 'c-AH', 'c-7D', 'c-3H', 'c-9C', 'c-5D', 'c-6S', 'c-4C',
  'c-QD', 'c-2H', 'c-9S', 'c-AC', 'c-KS', 'c-7C', 'c-2S', 'c-8C', 'c-10H',
  'c-2C', 'c-3D', 'c-9D', 'c-8S', 'c-4S', 'c-8D', 'c-7S', 'c-10S', 'c-3S',
  'c-AS', 'c-7H', 'c-JC', 'c-10C', 'c-9H', 'c-4D', 'c-2D', 'c-QS', 'c-6H',
  'c-JS', 'c-QH', 'c-KD', 'c-5C', 'c-AD', 'c-8H', 'c-JD', 'c-6C', 'c-10D',
  'c-5S', 'c-5H', 'c-QC', 'c-3C', 'c-KH', 'c-4H', 'c-KC',
]

test('source deck has a locked seeded permutation and RNG continuation', () => {
  const canonicalOrder = [...CARD_IDS]
  const rng = createRng(12345)
  const deck = createSourceDeck(rng)

  assert.deepEqual(deck, SEED_12345_DECK)
  assert.deepEqual(rng.snapshot(), {
    algorithm: 'mulberry32',
    seed: 12345,
    state: 3215555592,
  })
  assert.deepEqual(CARD_IDS, canonicalOrder)
  assert.notEqual(deck, CARD_IDS)
  assert.equal(new Set(deck).size, 52)
})

test('source deck consumes exactly 51 draws', () => {
  const actual = createRng(0x80000000)
  const control = createRng(0x80000000)

  createSourceDeck(actual)
  for (let draw = 0; draw < 51; draw += 1) {
    control.next()
  }

  assert.deepEqual(actual.snapshot(), control.snapshot())
})

test('identical RNG seed or state creates identical decks and continuations', () => {
  const fromSeedA = createRng(4294967295)
  const fromSeedB = createRng(4294967295)
  assert.deepEqual(createSourceDeck(fromSeedA), createSourceDeck(fromSeedB))
  assert.deepEqual(fromSeedA.snapshot(), fromSeedB.snapshot())

  const advanced = createRng(987654321)
  for (let draw = 0; draw < 17; draw += 1) {
    advanced.next()
  }
  const restored = restoreRng(JSON.parse(JSON.stringify(advanced.snapshot())))
  assert.deepEqual(createSourceDeck(advanced), createSourceDeck(restored))
  assert.deepEqual(advanced.snapshot(), restored.snapshot())
})

test('source deck construction never uses hidden randomness', (t) => {
  t.mock.method(Math, 'random', () => assert.fail('Unexpected Math.random use'))
  assert.deepEqual(createSourceDeck(createRng(12345)), SEED_12345_DECK)
})

test('source deck construction rejects an invalid RNG', () => {
  for (const invalid of [undefined, null, false, 1, 'rng', {}, { next: 1 }]) {
    assert.throws(() => createSourceDeck(invalid), TypeError)
  }
})

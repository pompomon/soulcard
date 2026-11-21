import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CARDS,
  CARD_IDS,
  DECKS,
  RANKS,
  SHORT_DECK_CARD_IDS,
  SUITS,
  compareCards,
  getCard,
  isCardId,
  isDeckId,
} from '../../src/domain/cards.js'

const EXPECTED_SUITS = ['S', 'H', 'D', 'C']
const EXPECTED_RANKS = [
  ['2', 2],
  ['3', 3],
  ['4', 4],
  ['5', 5],
  ['6', 6],
  ['7', 7],
  ['8', 8],
  ['9', 9],
  ['10', 10],
  ['J', 11],
  ['Q', 12],
  ['K', 13],
  ['A', 14],
]

test('classic cards contain the complete canonical rank and suit matrix', () => {
  assert.deepEqual(SUITS, EXPECTED_SUITS)
  assert.deepEqual(RANKS, EXPECTED_RANKS.map(([rank, value]) => ({ rank, value })))

  const expectedCards = EXPECTED_SUITS.flatMap((suit) =>
    EXPECTED_RANKS.map(([rank, value]) => ({
      id: `c-${rank}${suit}`,
      suit,
      rank,
      value,
    })))

  assert.equal(CARDS.length, 52)
  assert.deepEqual(CARDS, expectedCards)
  assert.deepEqual(CARD_IDS, expectedCards.map(({ id }) => id))
  assert.equal(new Set(CARD_IDS).size, 52)
})

test('card identities and exported canonical collections are immutable', () => {
  assert.ok(Object.isFrozen(SUITS))
  assert.ok(Object.isFrozen(RANKS))
  assert.ok(RANKS.every(Object.isFrozen))
  assert.ok(Object.isFrozen(CARDS))
  assert.ok(CARDS.every(Object.isFrozen))
  assert.ok(Object.isFrozen(CARD_IDS))

  assert.throws(() => SUITS.push('X'), TypeError)
  assert.throws(() => {
    RANKS[0].value = 14
  }, TypeError)
  assert.throws(() => {
    CARDS[0].rank = 'A'
  }, TypeError)
  assert.throws(() => CARD_IDS.reverse(), TypeError)
})

test('card lookup exposes only canonical immutable identities', () => {
  const aceOfSpades = getCard('c-AS')
  assert.deepEqual(aceOfSpades, {
    id: 'c-AS',
    suit: 'S',
    rank: 'A',
    value: 14,
  })
  assert.equal(aceOfSpades, CARDS[12])
  assert.ok(Object.isFrozen(aceOfSpades))

  for (const cardId of CARD_IDS) {
    assert.equal(isCardId(cardId), true)
    assert.equal(getCard(cardId)?.id, cardId)
  }
  for (const invalid of [
    undefined, null, false, 1, '', 'c-1S', 'c-11S', 'c-as', 'AS', {}, [],
  ]) {
    assert.equal(isCardId(invalid), false)
    assert.equal(getCard(invalid), undefined)
  }
})

test('canonical comparison makes 2 beat only Ace without changing card values', () => {
  assert.ok(compareCards('c-2S', 'c-AH') > 0)
  assert.ok(compareCards('c-AD', 'c-2C') < 0)
  assert.ok(compareCards('c-2H', 'c-3D') < 0)
  assert.ok(compareCards('c-KS', 'c-2D') > 0)
  assert.equal(compareCards('c-7S', 'c-7C'), 0)
  assert.ok(compareCards('c-6S', 'c-AH') < 0)
  assert.equal(compareCards('c-2S', 'c-AH', 'standard-52'), compareCards('c-2S', 'c-AH'))

  for (const cards of [
    ['unknown', 'c-AS'],
    ['c-2S', undefined],
  ]) {
    assert.throws(() => compareCards(...cards), RangeError)
  }
})

test('the short deck keeps ranks 6 to Ace in canonical order', () => {
  const expected = EXPECTED_SUITS.flatMap((suit) =>
    EXPECTED_RANKS.filter(([, value]) => value >= 6).map(([rank]) => `c-${rank}${suit}`))

  assert.equal(SHORT_DECK_CARD_IDS.length, 36)
  assert.deepEqual(SHORT_DECK_CARD_IDS, expected)
  assert.deepEqual(Object.keys(DECKS), ['standard-52', 'short-36'])
  assert.equal(DECKS['standard-52'], CARD_IDS)
  assert.equal(DECKS['short-36'], SHORT_DECK_CARD_IDS)
  assert.ok(Object.isFrozen(DECKS))
  assert.ok(Object.isFrozen(SHORT_DECK_CARD_IDS))
  assert.equal(isDeckId('short-36'), true)
  for (const invalid of [undefined, null, '', 'short-32', 'toString', CARD_IDS]) {
    assert.equal(isDeckId(invalid), false)
  }
})

test('on the short deck 6 beats only Ace', () => {
  assert.ok(compareCards('c-6S', 'c-AH', 'short-36') > 0)
  assert.ok(compareCards('c-AD', 'c-6C', 'short-36') < 0)
  assert.ok(compareCards('c-6H', 'c-7D', 'short-36') < 0)
  assert.ok(compareCards('c-KS', 'c-6D', 'short-36') > 0)
  assert.ok(compareCards('c-AS', 'c-KC', 'short-36') > 0)
  assert.equal(compareCards('c-6S', 'c-6C', 'short-36'), 0)

  for (const cards of [
    ['c-2S', 'c-AH', 'short-36'],
    ['c-AH', 'c-5S', 'short-36'],
    ['c-6S', 'c-AH', 'short-32'],
    ['c-6S', 'c-AH', null],
  ]) {
    assert.throws(() => compareCards(...cards), RangeError)
  }
})

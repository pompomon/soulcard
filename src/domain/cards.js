export const SUITS = Object.freeze(['S', 'H', 'D', 'C'])

export const RANKS = Object.freeze([
  Object.freeze({ rank: '2', value: 2 }),
  Object.freeze({ rank: '3', value: 3 }),
  Object.freeze({ rank: '4', value: 4 }),
  Object.freeze({ rank: '5', value: 5 }),
  Object.freeze({ rank: '6', value: 6 }),
  Object.freeze({ rank: '7', value: 7 }),
  Object.freeze({ rank: '8', value: 8 }),
  Object.freeze({ rank: '9', value: 9 }),
  Object.freeze({ rank: '10', value: 10 }),
  Object.freeze({ rank: 'J', value: 11 }),
  Object.freeze({ rank: 'Q', value: 12 }),
  Object.freeze({ rank: 'K', value: 13 }),
  Object.freeze({ rank: 'A', value: 14 }),
])

export const CARDS = Object.freeze(
  SUITS.flatMap((suit) => RANKS.map(({ rank, value }) => Object.freeze({
    id: `c-${rank}${suit}`,
    suit,
    rank,
    value,
  }))),
)

export const CARD_IDS = Object.freeze(CARDS.map(({ id }) => id))

export const SHORT_DECK_CARD_IDS = Object.freeze(
  CARDS.filter(({ value }) => value >= 6).map(({ id }) => id),
)

export const STANDARD_DECK = 'standard-52'
export const SHORT_DECK = 'short-36'

export const DECKS = Object.freeze({
  [STANDARD_DECK]: CARD_IDS,
  [SHORT_DECK]: SHORT_DECK_CARD_IDS,
})

const CARD_BY_ID = new Map(CARDS.map((card) => [card.id, card]))

export function isCardId(cardId) {
  return typeof cardId === 'string' && CARD_BY_ID.has(cardId)
}

export function getCard(cardId) {
  return CARD_BY_ID.get(cardId)
}

export function isDeckId(deck) {
  return typeof deck === 'string' && Object.hasOwn(DECKS, deck)
}

// The deck's lowest rank beats Ace, and only Ace: 2 on standard-52, 6 on short-36.
const DECK_RULES = new Map(Object.entries(DECKS).map(([deck, cardIds]) => {
  const cards = cardIds.map(getCard)
  const lowest = cards.reduce((low, card) => (card.value < low.value ? card : low))
  return [deck, Object.freeze({ cardIds: new Set(cardIds), upsetRank: lowest.rank })]
}))

export function compareCards(firstCardId, secondCardId, deck = STANDARD_DECK) {
  const first = getCard(firstCardId)
  const second = getCard(secondCardId)
  if (!first || !second) {
    throw new RangeError('compareCards requires two canonical card IDs')
  }
  const rules = DECK_RULES.get(deck)
  if (!rules) {
    throw new RangeError('compareCards requires a known deck')
  }
  if (!rules.cardIds.has(first.id) || !rules.cardIds.has(second.id)) {
    throw new RangeError(`compareCards requires two cards of the ${deck} deck`)
  }
  if (first.rank === rules.upsetRank && second.rank === 'A') return 1
  if (first.rank === 'A' && second.rank === rules.upsetRank) return -1
  return first.value - second.value
}

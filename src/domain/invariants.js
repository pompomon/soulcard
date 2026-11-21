import { CARD_IDS, DECKS, isCardId } from './cards.js'

const SIDES = Object.freeze(['player', 'opponent'])
const DECK_CARDS = new Map(Object.values(DECKS).map((cardIds) => [cardIds, new Set(cardIds)]))

function assertObject(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`)
  }
}

function assertOwnProperty(value, property, name) {
  if (!Object.hasOwn(value, property)) {
    throw new TypeError(`${name} must contain ${property}`)
  }
}

function assertDenseArray(value, name) {
  if (!Array.isArray(value)) {
    throw new TypeError(`${name} must be a dense array`)
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new TypeError(`${name} must be a dense array`)
    }
  }
}

function deckCards(cardIds) {
  return DECK_CARDS.get(cardIds) ?? new Set(cardIds)
}

function assertCardId(cardId, name, cards) {
  if (!isCardId(cardId)) {
    throw new TypeError(`${name} contains an unknown card ID`)
  }
  if (!cards.has(cardId)) {
    throw new TypeError(`${name} contains a card outside the ${cards.size}-card deck`)
  }
}

function assertRevealRecord(record, name, cards) {
  assertObject(record, name)
  if (
    Object.keys(record).length !== 2 ||
    !Object.hasOwn(record, 'cardId') ||
    !Object.hasOwn(record, 'suppliedBy')
  ) {
    throw new TypeError(`${name} must contain only cardId and suppliedBy`)
  }
  assertCardId(record.cardId, name, cards)
  if (!SIDES.includes(record.suppliedBy)) {
    throw new TypeError(`${name}.suppliedBy must be player or opponent`)
  }
}

function collectZoneCardIds(zones, cards) {
  const ordinaryPiles = [
    ['sourceDeck', zones.sourceDeck],
    ['player.drawPile', zones.player.drawPile],
    ['player.wonPile', zones.player.wonPile],
    ['opponent.drawPile', zones.opponent.drawPile],
    ['opponent.wonPile', zones.opponent.wonPile],
    ['burnPile', zones.burnPile],
  ]
  const recordPiles = [
    ['contestedPile', zones.contestedPile],
    ['inPlay', zones.inPlay],
  ]
  const cardIds = []

  for (const [name, pile] of ordinaryPiles) {
    assertDenseArray(pile, name)
    for (const cardId of pile) {
      assertCardId(cardId, name, cards)
      cardIds.push(cardId)
    }
  }

  for (const [name, pile] of recordPiles) {
    assertDenseArray(pile, name)
    for (let index = 0; index < pile.length; index += 1) {
      const recordName = `${name}[${index}]`
      assertRevealRecord(pile[index], recordName, cards)
      cardIds.push(pile[index].cardId)
    }
  }

  return cardIds
}

function assertZoneStructure(zones) {
  assertObject(zones, 'zones')
  for (const property of ['sourceDeck', 'player', 'opponent', 'contestedPile', 'burnPile', 'inPlay']) {
    assertOwnProperty(zones, property, 'zones')
  }
  for (const side of SIDES) {
    assertObject(zones[side], side)
    assertOwnProperty(zones[side], 'drawPile', side)
    assertOwnProperty(zones[side], 'wonPile', side)
  }
}

export function assertZoneInvariants(zones, cardIds = CARD_IDS) {
  assertZoneStructure(zones)
  const cards = deckCards(cardIds)
  const seen = new Set()

  for (const cardId of collectZoneCardIds(zones, cards)) {
    if (seen.has(cardId)) {
      throw new Error(`Card ${cardId} occurs in more than one zone`)
    }
    seen.add(cardId)
  }

  if (seen.size !== cards.size) {
    const missing = cardIds.filter((cardId) => !seen.has(cardId))
    throw new Error(`Zones must contain all ${cards.size} cards; missing: ${missing.join(', ')}`)
  }
}

export function assertStableBoundary(zones, cardIds = CARD_IDS) {
  assertZoneInvariants(zones, cardIds)
  if (zones.inPlay.length !== 0) {
    throw new Error('Stable boundaries require an empty inPlay zone')
  }
}

export function getCardOwnership(zones, cardId, cardIds = CARD_IDS) {
  if (!isCardId(cardId)) {
    throw new TypeError('cardId must be a known card ID')
  }
  if (!deckCards(cardIds).has(cardId)) {
    throw new TypeError('cardId must belong to the deck')
  }
  assertZoneInvariants(zones, cardIds)

  if (zones.player.drawPile.includes(cardId) || zones.player.wonPile.includes(cardId)) {
    return 'player'
  }
  if (zones.opponent.drawPile.includes(cardId) || zones.opponent.wonPile.includes(cardId)) {
    return 'opponent'
  }
  if (zones.sourceDeck.includes(cardId) || zones.burnPile.includes(cardId)) {
    return 'unowned'
  }
  return 'unsettled'
}

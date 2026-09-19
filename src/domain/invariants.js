import { CARD_IDS, isCardId } from './cards.js'

const SIDES = Object.freeze(['player', 'opponent'])

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

function assertCardId(cardId, name) {
  if (!isCardId(cardId)) {
    throw new TypeError(`${name} contains an unknown card ID`)
  }
}

function assertRevealRecord(record, name) {
  assertObject(record, name)
  if (
    Object.keys(record).length !== 2 ||
    !Object.hasOwn(record, 'cardId') ||
    !Object.hasOwn(record, 'suppliedBy')
  ) {
    throw new TypeError(`${name} must contain only cardId and suppliedBy`)
  }
  assertCardId(record.cardId, name)
  if (!SIDES.includes(record.suppliedBy)) {
    throw new TypeError(`${name}.suppliedBy must be player or opponent`)
  }
}

function collectZoneCardIds(zones) {
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
      assertCardId(cardId, name)
      cardIds.push(cardId)
    }
  }

  for (const [name, pile] of recordPiles) {
    assertDenseArray(pile, name)
    for (let index = 0; index < pile.length; index += 1) {
      const recordName = `${name}[${index}]`
      assertRevealRecord(pile[index], recordName)
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

export function assertZoneInvariants(zones) {
  assertZoneStructure(zones)
  const seen = new Set()

  for (const cardId of collectZoneCardIds(zones)) {
    if (seen.has(cardId)) {
      throw new Error(`Card ${cardId} occurs in more than one zone`)
    }
    seen.add(cardId)
  }

  if (seen.size !== CARD_IDS.length) {
    const missing = CARD_IDS.filter((cardId) => !seen.has(cardId))
    throw new Error(`Zones must contain all 52 cards; missing: ${missing.join(', ')}`)
  }
}

export function assertStableBoundary(zones) {
  assertZoneInvariants(zones)
  if (zones.inPlay.length !== 0) {
    throw new Error('Stable boundaries require an empty inPlay zone')
  }
}

export function getCardOwnership(zones, cardId) {
  if (!isCardId(cardId)) {
    throw new TypeError('cardId must be a known card ID')
  }
  assertZoneInvariants(zones)

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

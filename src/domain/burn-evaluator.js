import { getCard, isCardId } from './cards.js'
import { validateRuleset } from './ruleset.js'

const SIDES = Object.freeze(['player', 'opponent'])

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

function assertDenseArray(value, name) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${name} must be a nonempty dense array`)
  }
  const propertyNames = Object.getOwnPropertyNames(value)
  if (
    value.length === 0 ||
    propertyNames.length !== value.length + 1 ||
    propertyNames.at(-1) !== 'length' ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    throw new TypeError(`${name} must be a nonempty dense array`)
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`${name} must be a nonempty dense array`)
    }
  }
}

function validateContest(contestedPile, winner) {
  if (!SIDES.includes(winner)) {
    throw new TypeError('winner must be player or opponent')
  }
  assertDenseArray(contestedPile, 'contestedPile')
  const seen = new Set()
  let hasWinningCard = false

  for (let index = 0; index < contestedPile.length; index += 1) {
    const record = contestedPile[index]
    const name = `contestedPile[${index}]`
    assertPlainObject(record, name)
    const keys = Reflect.ownKeys(record)
    if (
      keys.length !== 2 ||
      !Object.hasOwn(record, 'cardId') ||
      !Object.hasOwn(record, 'suppliedBy') ||
      keys.some((key) => !['cardId', 'suppliedBy'].includes(key))
    ) {
      throw new TypeError(`${name} must contain only cardId and suppliedBy`)
    }
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(record, key)
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError(`${name}.${key} must be JSON-compatible data`)
      }
    }
    if (!isCardId(record.cardId)) {
      throw new TypeError(`${name} contains an unknown card ID`)
    }
    if (!SIDES.includes(record.suppliedBy)) {
      throw new TypeError(`${name}.suppliedBy must be player or opponent`)
    }
    if (seen.has(record.cardId)) {
      throw new Error(`Card ${record.cardId} occurs more than once in contestedPile`)
    }
    seen.add(record.cardId)
    hasWinningCard ||= record.suppliedBy === winner
  }

  if (!hasWinningCard) {
    throw new Error('A resolved contest must contain a card supplied by the winner')
  }
}

function nextRandom(rng) {
  if (typeof rng?.next !== 'function') {
    throw new TypeError('A chance predicate requires an RNG with a next method')
  }
  const draw = rng.next()
  if (!Number.isFinite(draw) || draw < 0 || draw >= 1) {
    throw new TypeError('RNG next() must return a finite number in [0, 1)')
  }
  return draw
}

function matches(rule, cardId, rng) {
  const { match } = rule
  if (Object.hasOwn(match, 'chance')) {
    return nextRandom(rng) < match.chance
  }
  const card = getCard(cardId)
  return (
    (!Object.hasOwn(match, 'cardIds') || match.cardIds.includes(cardId)) &&
    (!Object.hasOwn(match, 'ranks') || match.ranks.includes(card.rank)) &&
    (!Object.hasOwn(match, 'suits') || match.suits.includes(card.suit))
  )
}

function outcomeFor(cardId, burn, rng) {
  if (!Object.hasOwn(burn, 'rules')) {
    return 'burn'
  }
  for (const rule of burn.rules) {
    if (matches(rule, cardId, rng)) {
      return rule.outcome
    }
  }
  return burn.defaultOutcome
}

export function evaluateBurn(ruleset, winner, contestedPile, rng) {
  validateRuleset(ruleset)
  validateContest(contestedPile, winner)

  const transfers = []
  const burned = []
  const destination = `${winner}.wonPile`

  for (const { cardId, suppliedBy } of contestedPile) {
    if (
      !ruleset.burn.enabled ||
      suppliedBy === winner ||
      outcomeFor(cardId, ruleset.burn, rng) === 'transfer'
    ) {
      transfers.push({ cardId, to: destination })
    } else {
      burned.push(cardId)
    }
  }

  return { transfers, burned }
}

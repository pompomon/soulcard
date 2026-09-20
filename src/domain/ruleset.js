import { RANKS, SUITS, isCardId } from './cards.js'

const ELIGIBLE_SCOPE = 'all-losing-side-cards-in-resolved-contested-pile'
const WINNER_DESTINATION = 'winner.wonPile'
const OUTCOMES = Object.freeze(['burn', 'transfer'])
const RANK_NAMES = new Set(RANKS.map(({ rank }) => rank))
const SUIT_NAMES = new Set(SUITS)

function deepFreeze(value) {
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === 'object') {
      deepFreeze(child)
    }
  }
  return Object.freeze(value)
}

export const BASELINE_RULESET = deepFreeze({
  id: 'mvp-baseline-v1',
  burn: {
    enabled: true,
    eligibleScope: ELIGIBLE_SCOPE,
    decisiveWinningCard: WINNER_DESTINATION,
  },
})

export const NO_BURN_RULESET = deepFreeze({
  id: 'debug-no-burn-v1',
  burn: {
    enabled: false,
  },
})

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

function assertDataProperty(value, key, name) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
    throw new TypeError(`${name}.${key} must be JSON-compatible data`)
  }
  return descriptor.value
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
    assertDataProperty(value, key, name)
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

function assertUniqueSelector(values, name, predicate) {
  assertDenseArray(values, name, { nonempty: true })
  const seen = new Set()
  for (const value of values) {
    if (!predicate(value)) {
      throw new TypeError(`${name} contains an unsupported value`)
    }
    if (seen.has(value)) {
      throw new TypeError(`${name} must not contain duplicates`)
    }
    seen.add(value)
  }
}

function assertMatch(match, name) {
  assertPlainObject(match, name)
  const keys = Reflect.ownKeys(match)
  if (keys.includes('chance')) {
    assertExactKeys(match, ['chance'], name)
    if (!Number.isFinite(match.chance) || match.chance < 0 || match.chance > 1) {
      throw new TypeError(`${name}.chance must be a finite number from 0 through 1`)
    }
    return
  }

  const allowed = ['cardIds', 'ranks', 'suits']
  if (
    keys.length === 0 ||
    keys.some((key) => typeof key !== 'string' || !allowed.includes(key))
  ) {
    throw new TypeError(`${name} must contain cardIds, ranks, suits, or chance`)
  }
  assertExactKeys(match, keys, name)
  if (Object.hasOwn(match, 'cardIds')) {
    assertUniqueSelector(match.cardIds, `${name}.cardIds`, isCardId)
  }
  if (Object.hasOwn(match, 'ranks')) {
    assertUniqueSelector(
      match.ranks,
      `${name}.ranks`,
      (rank) => typeof rank === 'string' && RANK_NAMES.has(rank),
    )
  }
  if (Object.hasOwn(match, 'suits')) {
    assertUniqueSelector(
      match.suits,
      `${name}.suits`,
      (suit) => typeof suit === 'string' && SUIT_NAMES.has(suit),
    )
  }
}

function assertRule(rule, index) {
  const name = `ruleset.burn.rules[${index}]`
  assertPlainObject(rule, name)
  assertExactKeys(rule, ['match', 'outcome'], name)
  assertMatch(rule.match, `${name}.match`)
  if (!OUTCOMES.includes(rule.outcome)) {
    throw new TypeError(`${name}.outcome must be burn or transfer`)
  }
}

function sameCanonicalValue(actual, expected) {
  if (actual === expected) {
    return true
  }
  if (
    actual === null ||
    expected === null ||
    typeof actual !== 'object' ||
    typeof expected !== 'object' ||
    Array.isArray(actual) !== Array.isArray(expected)
  ) {
    return false
  }
  const actualKeys = Object.keys(actual)
  const expectedKeys = Object.keys(expected)
  return (
    actualKeys.length === expectedKeys.length &&
    expectedKeys.every(
      (key) => Object.hasOwn(actual, key) && sameCanonicalValue(actual[key], expected[key]),
    )
  )
}

function assertBuiltIn(ruleset, canonical) {
  if (!sameCanonicalValue(ruleset, canonical)) {
    throw new TypeError(`Built-in ruleset ${canonical.id} must use its canonical definition`)
  }
}

export function validateRuleset(ruleset) {
  assertPlainObject(ruleset, 'ruleset')
  assertExactKeys(ruleset, ['id', 'burn'], 'ruleset')
  if (
    typeof ruleset.id !== 'string' ||
    ruleset.id.length === 0 ||
    ruleset.id.trim() !== ruleset.id
  ) {
    throw new TypeError('ruleset.id must be a nonempty trimmed string')
  }
  assertPlainObject(ruleset.burn, 'ruleset.burn')

  if (ruleset.id === BASELINE_RULESET.id) {
    assertExactKeys(
      ruleset.burn,
      ['enabled', 'eligibleScope', 'decisiveWinningCard'],
      'ruleset.burn',
    )
    assertBuiltIn(ruleset, BASELINE_RULESET)
    return ruleset
  }
  if (ruleset.id === NO_BURN_RULESET.id) {
    assertExactKeys(ruleset.burn, ['enabled'], 'ruleset.burn')
    assertBuiltIn(ruleset, NO_BURN_RULESET)
    return ruleset
  }

  const enabled = assertDataProperty(ruleset.burn, 'enabled', 'ruleset.burn')
  if (enabled === false) {
    assertExactKeys(ruleset.burn, ['enabled'], 'ruleset.burn')
    return ruleset
  }
  assertExactKeys(
    ruleset.burn,
    ['enabled', 'eligibleScope', 'decisiveWinningCard', 'rules', 'defaultOutcome'],
    'ruleset.burn',
  )
  if (enabled !== true) {
    throw new TypeError('ruleset.burn.enabled must be a boolean')
  }
  if (ruleset.burn.eligibleScope !== ELIGIBLE_SCOPE) {
    throw new TypeError(`ruleset.burn.eligibleScope must be ${ELIGIBLE_SCOPE}`)
  }
  if (ruleset.burn.decisiveWinningCard !== WINNER_DESTINATION) {
    throw new TypeError(`ruleset.burn.decisiveWinningCard must be ${WINNER_DESTINATION}`)
  }
  if (!OUTCOMES.includes(ruleset.burn.defaultOutcome)) {
    throw new TypeError('ruleset.burn.defaultOutcome must be burn or transfer')
  }
  assertDenseArray(ruleset.burn.rules, 'ruleset.burn.rules', { nonempty: true })
  ruleset.burn.rules.forEach(assertRule)
  return ruleset
}

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BASELINE_RULESET,
  NO_BURN_RULESET,
  validateRuleset,
} from '../../src/domain/ruleset.js'
import {
  BASELINE_RULESET_FIXTURE,
  NO_BURN_RULESET_FIXTURE,
  PRECEDENCE_RULESET_FIXTURE,
} from '../fixtures/rulesets.js'

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function allObjects(value) {
  if (value === null || typeof value !== 'object') {
    return []
  }
  return [value, ...Object.values(value).flatMap(allObjects)]
}

test('built-in rulesets match the independent canonical fixtures and are deeply immutable', () => {
  assert.deepEqual(BASELINE_RULESET, BASELINE_RULESET_FIXTURE)
  assert.deepEqual(NO_BURN_RULESET, NO_BURN_RULESET_FIXTURE)
  assert.ok(allObjects(BASELINE_RULESET).every(Object.isFrozen))
  assert.ok(allObjects(NO_BURN_RULESET).every(Object.isFrozen))
  assert.throws(() => {
    BASELINE_RULESET.burn.enabled = false
  }, TypeError)
  assert.throws(() => {
    NO_BURN_RULESET.id = 'changed'
  }, TypeError)
})

test('canonical and custom rulesets validate unchanged through JSON round trips', () => {
  for (const fixture of [
    BASELINE_RULESET_FIXTURE,
    NO_BURN_RULESET_FIXTURE,
    PRECEDENCE_RULESET_FIXTURE,
  ]) {
    const ruleset = clone(fixture)
    assert.equal(validateRuleset(ruleset), ruleset)
    assert.deepEqual(ruleset, fixture)
  }

  const disabledCustom = { id: 'test-no-burn-v2', burn: { enabled: false } }
  assert.equal(validateRuleset(disabledCustom), disabledCustom)
})

test('built-in IDs cannot be reused with altered definitions', () => {
  const variants = [
    { ...clone(BASELINE_RULESET), burn: { enabled: false } },
    {
      ...clone(BASELINE_RULESET),
      burn: { ...clone(BASELINE_RULESET).burn, extra: true },
    },
    {
      ...clone(BASELINE_RULESET),
      burn: { ...clone(BASELINE_RULESET).burn, decisiveWinningCard: 'burnPile' },
    },
    {
      ...clone(NO_BURN_RULESET),
      burn: { enabled: false, rules: [] },
    },
    {
      ...clone(NO_BURN_RULESET),
      burn: { enabled: true },
    },
  ]

  for (const ruleset of variants) {
    assert.throws(() => validateRuleset(ruleset), TypeError)
  }
})

test('rulesets require plain exact root objects and nonempty trimmed IDs', () => {
  const valid = clone(PRECEDENCE_RULESET_FIXTURE)
  const invalid = [
    undefined,
    null,
    false,
    [],
    new Date(),
    {},
    { id: valid.id },
    { burn: valid.burn },
    { ...valid, extra: true },
    { ...valid, id: '' },
    { ...valid, id: '   ' },
    { ...valid, id: ' padded' },
    { ...valid, id: 4 },
    { ...valid, burn: [] },
  ]

  for (const ruleset of invalid) {
    assert.throws(() => validateRuleset(ruleset), TypeError)
  }

  const symbolKey = clone(valid)
  symbolKey[Symbol('extra')] = true
  assert.throws(() => validateRuleset(symbolKey), TypeError)
})

test('enabled custom rules require the fixed scope, destination, rules, and fallback', () => {
  const valid = clone(PRECEDENCE_RULESET_FIXTURE)
  const invalidBurns = [
    {},
    { enabled: true },
    { ...valid.burn, enabled: 1 },
    { ...valid.burn, eligibleScope: 'decisive-card-only' },
    { ...valid.burn, decisiveWinningCard: 'burnPile' },
    { ...valid.burn, defaultOutcome: 'discard' },
    { ...valid.burn, rules: [] },
    { ...valid.burn, rules: null },
    { ...valid.burn, extra: true },
  ]

  for (const burn of invalidBurns) {
    assert.throws(() => validateRuleset({ id: 'test-invalid', burn }), TypeError)
  }
})

test('disabled rules reject inert configuration fields', () => {
  for (const burn of [
    { enabled: false, rules: [] },
    { enabled: false, defaultOutcome: 'transfer' },
    { enabled: false, eligibleScope: 'all-losing-side-cards-in-resolved-contested-pile' },
  ]) {
    assert.throws(() => validateRuleset({ id: 'test-disabled', burn }), TypeError)
  }
})

test('rulesets reject a burn enabled accessor without invoking it', () => {
  const ruleset = clone(PRECEDENCE_RULESET_FIXTURE)
  let calls = 0
  Object.defineProperty(ruleset.burn, 'enabled', {
    enumerable: true,
    get() {
      calls += 1
      return true
    },
  })

  assert.throws(() => validateRuleset(ruleset), TypeError)
  assert.equal(calls, 0)
})

test('deterministic selectors are nonempty, canonical, unique, and conjunctive-compatible', () => {
  const base = clone(PRECEDENCE_RULESET_FIXTURE)
  const invalidMatches = [
    {},
    { cardIds: [] },
    { cardIds: ['c-1S'] },
    { cardIds: ['c-2S', 'c-2S'] },
    { ranks: ['1'] },
    { ranks: ['A', 'A'] },
    { suits: ['X'] },
    { suits: ['S', 'S'] },
    { rank: ['A'] },
    { cardIds: ['c-AS'], extra: true },
  ]

  for (const match of invalidMatches) {
    const ruleset = clone(base)
    ruleset.burn.rules = [{ match, outcome: 'burn' }]
    assert.throws(() => validateRuleset(ruleset), TypeError)
  }

  const conjunctive = clone(base)
  conjunctive.burn.rules = [{
    match: { cardIds: ['c-KH'], ranks: ['K'], suits: ['H'] },
    outcome: 'transfer',
  }]
  assert.doesNotThrow(() => validateRuleset(conjunctive))
})

test('chance predicates are standalone finite probabilities from zero through one', () => {
  const base = clone(PRECEDENCE_RULESET_FIXTURE)
  const invalidMatches = [
    { chance: -0.01 },
    { chance: 1.01 },
    { chance: NaN },
    { chance: Infinity },
    { chance: '0.5' },
    { chance: 0.5, ranks: ['A'] },
  ]

  for (const match of invalidMatches) {
    const ruleset = clone(base)
    ruleset.burn.rules = [{ match, outcome: 'burn' }]
    assert.throws(() => validateRuleset(ruleset), TypeError)
  }

  for (const chance of [0, 0.5, 1]) {
    const ruleset = clone(base)
    ruleset.burn.rules = [{ match: { chance }, outcome: 'burn' }]
    assert.doesNotThrow(() => validateRuleset(ruleset))
  }
})

test('rules and selector arrays must be dense JSON data with supported outcomes', () => {
  const sparseRules = clone(PRECEDENCE_RULESET_FIXTURE)
  sparseRules.burn.rules.length = 4
  assert.throws(() => validateRuleset(sparseRules), TypeError)

  const sparseSelector = clone(PRECEDENCE_RULESET_FIXTURE)
  sparseSelector.burn.rules[0].match.cardIds.length = 3
  assert.throws(() => validateRuleset(sparseSelector), TypeError)

  const badOutcome = clone(PRECEDENCE_RULESET_FIXTURE)
  badOutcome.burn.rules[0].outcome = 'keep'
  assert.throws(() => validateRuleset(badOutcome), TypeError)

  const extraRuleField = clone(PRECEDENCE_RULESET_FIXTURE)
  extraRuleField.burn.rules[0].priority = 1
  assert.throws(() => validateRuleset(extraRuleField), TypeError)

  const accessor = clone(PRECEDENCE_RULESET_FIXTURE)
  Object.defineProperty(accessor.burn.rules[0], 'outcome', {
    enumerable: true,
    get: () => 'burn',
  })
  assert.throws(() => validateRuleset(accessor), TypeError)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateBurn } from '../../src/domain/burn-evaluator.js'
import {
  BASELINE_RULESET,
  NO_BURN_RULESET,
} from '../../src/domain/ruleset.js'
import {
  PRECEDENCE_RULESET_FIXTURE,
} from '../fixtures/rulesets.js'

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

const PLAYER_WIN = Object.freeze([
  Object.freeze({ cardId: 'c-10H', suppliedBy: 'player' }),
  Object.freeze({ cardId: 'c-10C', suppliedBy: 'opponent' }),
  Object.freeze({ cardId: 'c-AS', suppliedBy: 'player' }),
  Object.freeze({ cardId: 'c-KD', suppliedBy: 'opponent' }),
])

const OPPONENT_WIN = Object.freeze([
  Object.freeze({ cardId: 'c-5S', suppliedBy: 'player' }),
  Object.freeze({ cardId: 'c-5H', suppliedBy: 'opponent' }),
  Object.freeze({ cardId: 'c-QD', suppliedBy: 'player' }),
  Object.freeze({ cardId: 'c-KC', suppliedBy: 'opponent' }),
])

test('baseline burning keeps winner cards and burns loser cards in reveal order', () => {
  assert.deepEqual(evaluateBurn(BASELINE_RULESET, 'player', PLAYER_WIN), {
    transfers: [
      { cardId: 'c-10H', to: 'player.wonPile' },
      { cardId: 'c-AS', to: 'player.wonPile' },
    ],
    burned: ['c-10C', 'c-KD'],
  })

  assert.deepEqual(evaluateBurn(BASELINE_RULESET, 'opponent', OPPONENT_WIN), {
    transfers: [
      { cardId: 'c-5H', to: 'opponent.wonPile' },
      { cardId: 'c-KC', to: 'opponent.wonPile' },
    ],
    burned: ['c-5S', 'c-QD'],
  })
})

test('disabled burning transfers the complete contest in reveal order without RNG', () => {
  const rng = {
    get next() {
      assert.fail('Disabled burning must not inspect RNG')
    },
  }
  assert.deepEqual(evaluateBurn(NO_BURN_RULESET, 'player', PLAYER_WIN, rng), {
    transfers: PLAYER_WIN.map(({ cardId }) => ({ cardId, to: 'player.wonPile' })),
    burned: [],
  })
})

test('ordered predicates apply ID, conjunctive rank/suit, chance, then fallback', () => {
  const contest = [
    { cardId: 'c-AS', suppliedBy: 'player' },
    { cardId: 'c-2S', suppliedBy: 'opponent' },
    { cardId: 'c-QS', suppliedBy: 'player' },
    { cardId: 'c-KH', suppliedBy: 'opponent' },
    { cardId: 'c-JS', suppliedBy: 'player' },
    { cardId: 'c-7C', suppliedBy: 'opponent' },
    { cardId: 'c-10S', suppliedBy: 'player' },
    { cardId: 'c-8C', suppliedBy: 'opponent' },
  ]
  const draws = [0.25, 0.75]
  let calls = 0
  const rng = { next: () => draws[calls++] }

  assert.deepEqual(evaluateBurn(PRECEDENCE_RULESET_FIXTURE, 'player', contest, rng), {
    transfers: [
      { cardId: 'c-AS', to: 'player.wonPile' },
      { cardId: 'c-2S', to: 'player.wonPile' },
      { cardId: 'c-QS', to: 'player.wonPile' },
      { cardId: 'c-JS', to: 'player.wonPile' },
      { cardId: 'c-10S', to: 'player.wonPile' },
      { cardId: 'c-8C', to: 'player.wonPile' },
    ],
    burned: ['c-KH', 'c-7C'],
  })
  assert.equal(calls, 2)
})

test('chance boundaries consume one draw per reached predicate in stable order', () => {
  const ruleset = {
    id: 'test-chance-boundaries-v1',
    burn: {
      enabled: true,
      eligibleScope: 'all-losing-side-cards-in-resolved-contested-pile',
      decisiveWinningCard: 'winner.wonPile',
      rules: [
        { match: { chance: 0 }, outcome: 'transfer' },
        { match: { chance: 1 }, outcome: 'burn' },
      ],
      defaultOutcome: 'transfer',
    },
  }
  const contest = [
    { cardId: 'c-AS', suppliedBy: 'player' },
    { cardId: 'c-2H', suppliedBy: 'opponent' },
    { cardId: 'c-KS', suppliedBy: 'player' },
    { cardId: 'c-3H', suppliedBy: 'opponent' },
  ]
  const draws = [0, 0.999999, 0.5, 0]
  let calls = 0

  assert.deepEqual(evaluateBurn(ruleset, 'player', contest, {
    next: () => draws[calls++],
  }), {
    transfers: [
      { cardId: 'c-AS', to: 'player.wonPile' },
      { cardId: 'c-KS', to: 'player.wonPile' },
    ],
    burned: ['c-2H', 'c-3H'],
  })
  assert.equal(calls, 4)
})

test('winner cards and deterministic matches never consume chance draws', () => {
  let calls = 0
  const contest = [
    { cardId: 'c-AS', suppliedBy: 'player' },
    { cardId: 'c-2S', suppliedBy: 'opponent' },
  ]
  const result = evaluateBurn(PRECEDENCE_RULESET_FIXTURE, 'player', contest, {
    next() {
      calls += 1
      return 0
    },
  })

  assert.deepEqual(result, {
    transfers: [
      { cardId: 'c-AS', to: 'player.wonPile' },
      { cardId: 'c-2S', to: 'player.wonPile' },
    ],
    burned: [],
  })
  assert.equal(calls, 0)
})

test('chance evaluation requires a valid explicit RNG and never uses Math.random', (t) => {
  t.mock.method(Math, 'random', () => assert.fail('Unexpected Math.random use'))
  const ruleset = {
    id: 'test-chance-v1',
    burn: {
      enabled: true,
      eligibleScope: 'all-losing-side-cards-in-resolved-contested-pile',
      decisiveWinningCard: 'winner.wonPile',
      rules: [{ match: { chance: 0.5 }, outcome: 'burn' }],
      defaultOutcome: 'transfer',
    },
  }
  const contest = [
    { cardId: 'c-AS', suppliedBy: 'player' },
    { cardId: 'c-KD', suppliedBy: 'opponent' },
  ]

  assert.deepEqual(evaluateBurn(ruleset, 'player', contest, { next: () => 0.25 }), {
    transfers: [{ cardId: 'c-AS', to: 'player.wonPile' }],
    burned: ['c-KD'],
  })
  for (const rng of [undefined, null, {}, { next: 1 }]) {
    assert.throws(() => evaluateBurn(ruleset, 'player', contest, rng), TypeError)
  }
  for (const value of [undefined, null, false, '0.5', NaN, Infinity, -0.1, 1]) {
    assert.throws(
      () => evaluateBurn(ruleset, 'player', contest, { next: () => value }),
      {
        name: 'TypeError',
        message: 'RNG next() must return a finite number in [0, 1)',
      },
    )
  }
})

test('evaluation preserves frozen inputs and returns detached complete settlement data', () => {
  const ruleset = deepFreeze(clone(PRECEDENCE_RULESET_FIXTURE))
  const contest = deepFreeze(clone(PLAYER_WIN))
  const rulesBefore = clone(ruleset)
  const contestBefore = clone(contest)
  const result = evaluateBurn(ruleset, 'player', contest, { next: () => 0.75 })

  assert.deepEqual(ruleset, rulesBefore)
  assert.deepEqual(contest, contestBefore)
  assert.deepEqual(
    [...result.transfers.map(({ cardId }) => cardId), ...result.burned].sort(),
    contest.map(({ cardId }) => cardId).sort(),
  )
  assert.equal(
    new Set([...result.transfers.map(({ cardId }) => cardId), ...result.burned]).size,
    contest.length,
  )

  result.transfers[0].cardId = 'c-2D'
  result.burned.push('c-3D')
  assert.deepEqual(contest, contestBefore)
})

test('single available winner cards settle without requiring a losing card', () => {
  assert.deepEqual(
    evaluateBurn(BASELINE_RULESET, 'opponent', [
      { cardId: 'c-AC', suppliedBy: 'opponent' },
    ]),
    {
      transfers: [{ cardId: 'c-AC', to: 'opponent.wonPile' }],
      burned: [],
    },
  )
})

test('invalid winners and malformed or unresolved contests are rejected', () => {
  const invalidWinners = [undefined, null, 'draw', 'Player', 1]
  for (const winner of invalidWinners) {
    assert.throws(() => evaluateBurn(BASELINE_RULESET, winner, PLAYER_WIN), TypeError)
  }

  const invalidContests = [
    undefined,
    null,
    {},
    [],
    [null],
    [{}],
    [{ cardId: 'c-AS', suppliedBy: 'player', extra: true }],
    [{ cardId: 'c-1S', suppliedBy: 'player' }],
    [{ cardId: 'c-AS', suppliedBy: 'source' }],
    [
      { cardId: 'c-AS', suppliedBy: 'player' },
      { cardId: 'c-AS', suppliedBy: 'opponent' },
    ],
  ]
  for (const contest of invalidContests) {
    assert.throws(() => evaluateBurn(BASELINE_RULESET, 'player', contest))
  }
  assert.throws(
    () => evaluateBurn(BASELINE_RULESET, 'player', [
      { cardId: 'c-AS', suppliedBy: 'opponent' },
    ]),
    /must contain a card supplied by the winner/,
  )
})

test('rules and contest validation finish before any possible RNG draw', () => {
  let calls = 0
  const rng = {
    next() {
      calls += 1
      return 0
    },
  }
  const invalidRuleset = clone(PRECEDENCE_RULESET_FIXTURE)
  invalidRuleset.burn.rules[0].outcome = 'discard'
  assert.throws(() => evaluateBurn(invalidRuleset, 'player', PLAYER_WIN, rng), TypeError)

  const invalidContest = clone(PLAYER_WIN)
  invalidContest[2].cardId = 'c-1S'
  assert.throws(
    () => evaluateBurn(PRECEDENCE_RULESET_FIXTURE, 'player', invalidContest, rng),
    TypeError,
  )
  assert.equal(calls, 0)
})

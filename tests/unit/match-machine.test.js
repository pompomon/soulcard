import assert from 'node:assert/strict'
import test from 'node:test'
import { CARD_IDS } from '../../src/domain/cards.js'
import {
  createMatch,
  revealOrContinue,
  validateMatchState,
} from '../../src/domain/match-machine.js'
import { assertStableBoundary } from '../../src/domain/invariants.js'
import { restoreRng, shuffle } from '../../src/domain/rng.js'
import {
  BASELINE_RULESET,
  NO_BURN_RULESET,
} from '../../src/domain/ruleset.js'

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function allObjects(value) {
  if (value === null || typeof value !== 'object') {
    return []
  }
  return [value, ...Object.values(value).flatMap(allObjects)]
}

function createFixture({
  runId = 'fixture-run',
  seed = 12345,
  ruleset = BASELINE_RULESET,
  stage = 'personal',
  sourceDeck = [],
  playerDraw = [],
  playerWon = [],
  opponentDraw = [],
  opponentWon = [],
  contestedPile = [],
  burnPile = [],
} = {}) {
  const match = clone(createMatch({ runId, seed, ruleset }))
  const supplied = [
    ...sourceDeck,
    ...playerDraw,
    ...playerWon,
    ...opponentDraw,
    ...opponentWon,
    ...contestedPile.map(({ cardId }) => cardId),
    ...burnPile,
  ]
  assert.equal(new Set(supplied).size, supplied.length, 'fixture cards must be unique')
  const suppliedSet = new Set(supplied)

  match.stage = stage
  match.zones = {
    sourceDeck: [...sourceDeck],
    player: {
      drawPile: [...playerDraw],
      wonPile: [...playerWon],
    },
    opponent: {
      drawPile: [...opponentDraw],
      wonPile: [...opponentWon],
    },
    contestedPile: clone(contestedPile),
    burnPile: [...burnPile, ...CARD_IDS.filter((cardId) => !suppliedSet.has(cardId))],
    inPlay: [],
  }
  validateMatchState(match)
  return match
}

test('new matches require explicit inputs and produce deterministic immutable ready states', (t) => {
  t.mock.method(Math, 'random', () => assert.fail('Match setup must not use Math.random'))
  const options = { runId: 'run-12345', seed: 12345, ruleset: BASELINE_RULESET }
  const first = createMatch(options)
  const second = createMatch(options)

  assert.deepEqual(first, second)
  assert.deepEqual({
    runId: first.runId,
    stage: first.stage,
    machineState: first.machineState,
    turn: first.turn,
    status: first.status,
    outcome: first.outcome,
    pendingEvent: first.pendingEvent,
  }, {
    runId: 'run-12345',
    stage: 'source',
    machineState: 'ready',
    turn: 0,
    status: 'active',
    outcome: null,
    pendingEvent: null,
  })
  assert.equal(first.zones.sourceDeck.length, 52)
  assert.deepEqual(first.rng, {
    algorithm: 'mulberry32',
    seed: 12345,
    state: 3215555592,
  })
  assert.ok(allObjects(first).every(Object.isFrozen))
  assert.equal(validateMatchState(first), first)
  assert.doesNotThrow(() => assertStableBoundary(first.zones))

  const invalid = [
    undefined,
    null,
    {},
    { seed: 1, ruleset: BASELINE_RULESET },
    { runId: '', seed: 1, ruleset: BASELINE_RULESET },
    { runId: ' padded ', seed: 1, ruleset: BASELINE_RULESET },
    { runId: 'run', seed: -1, ruleset: BASELINE_RULESET },
    { runId: 'run', seed: 1 },
    { runId: 'run', seed: 1, ruleset: BASELINE_RULESET, extra: true },
  ]
  for (const input of invalid) {
    assert.throws(() => createMatch(input))
  }
})

test('source-stage clashes resolve both winners and preserve the input snapshot', () => {
  const cases = [
    {
      sourceDeck: ['c-AS', 'c-KH', 'c-2S', 'c-3H'],
      winner: 'player',
      transfers: [{ cardId: 'c-AS', to: 'player.wonPile' }],
      burned: ['c-KH'],
    },
    {
      sourceDeck: ['c-KS', 'c-AH', 'c-2S', 'c-3H'],
      winner: 'opponent',
      transfers: [{ cardId: 'c-AH', to: 'opponent.wonPile' }],
      burned: ['c-KS'],
    },
  ]

  for (const fixture of cases) {
    const input = createFixture({ stage: 'source', sourceDeck: fixture.sourceDeck })
    const before = clone(input)
    const { match, event } = revealOrContinue(input)

    assert.deepEqual(input, before)
    assert.notEqual(match, input)
    assert.equal(match.turn, 1)
    assert.equal(match.machineState, 'ready')
    assert.equal(match.stage, 'source')
    assert.deepEqual(match.zones.sourceDeck, fixture.sourceDeck.slice(2))
    assert.deepEqual(event, {
      eventVersion: 1,
      id: 'fixture-run:clash-1',
      type: 'clashSettled',
      turn: 1,
      stage: 'source',
      winner: fixture.winner,
      reveals: [
        { cardId: fixture.sourceDeck[0], suppliedBy: 'player' },
        { cardId: fixture.sourceDeck[1], suppliedBy: 'opponent' },
      ],
      transfers: fixture.transfers,
      burned: fixture.burned,
      pendingPresentation: 'settlement-v1',
    })
    assert.equal(match.pendingEvent, event)
    assert.ok(allObjects(match).every(Object.isFrozen))
    assert.doesNotThrow(() => assertStableBoundary(match.zones))
  }
})

test('one action resolves multiple source ties in chronological order', () => {
  const sourceDeck = [
    'c-10S', 'c-10H',
    'c-9S', 'c-9H',
    'c-AS', 'c-KH',
    'c-2S', 'c-3H',
  ]
  const { match, event } = revealOrContinue(createFixture({
    stage: 'source',
    sourceDeck,
  }))

  assert.equal(match.turn, 1)
  assert.deepEqual(match.zones.sourceDeck, ['c-2S', 'c-3H'])
  assert.deepEqual(event.reveals, [
    { cardId: 'c-10S', suppliedBy: 'player' },
    { cardId: 'c-10H', suppliedBy: 'opponent' },
    { cardId: 'c-9S', suppliedBy: 'player' },
    { cardId: 'c-9H', suppliedBy: 'opponent' },
    { cardId: 'c-AS', suppliedBy: 'player' },
    { cardId: 'c-KH', suppliedBy: 'opponent' },
  ])
  assert.deepEqual(event.transfers, [
    { cardId: 'c-10S', to: 'player.wonPile' },
    { cardId: 'c-9S', to: 'player.wonPile' },
    { cardId: 'c-AS', to: 'player.wonPile' },
  ])
  assert.deepEqual(event.burned, ['c-10H', 'c-9H', 'c-KH'])
  assert.deepEqual(match.zones.player.wonPile, ['c-10S', 'c-9S', 'c-AS'])
  assert.equal(match.zones.contestedPile.length, 0)
})

test('disabled and chance-based burn rules preserve their RNG contracts', () => {
  const sourceDeck = ['c-AS', 'c-KH', 'c-2S', 'c-3H']
  const noBurnInput = createFixture({
    runId: 'no-burn',
    ruleset: NO_BURN_RULESET,
    stage: 'source',
    sourceDeck,
  })
  const noBurn = revealOrContinue(noBurnInput)
  assert.deepEqual(noBurn.match.rng, noBurnInput.rng)
  assert.deepEqual(noBurn.event.transfers, [
    { cardId: 'c-AS', to: 'player.wonPile' },
    { cardId: 'c-KH', to: 'player.wonPile' },
  ])
  assert.deepEqual(noBurn.event.burned, [])

  const chanceRuleset = {
    id: 'test-match-chance-v1',
    burn: {
      enabled: true,
      eligibleScope: 'all-losing-side-cards-in-resolved-contested-pile',
      decisiveWinningCard: 'winner.wonPile',
      rules: [{ match: { chance: 1 }, outcome: 'burn' }],
      defaultOutcome: 'transfer',
    },
  }
  const chanceInput = createFixture({
    runId: 'chance',
    ruleset: chanceRuleset,
    stage: 'source',
    sourceDeck,
  })
  const expectedRng = restoreRng(chanceInput.rng)
  expectedRng.next()
  const chance = revealOrContinue(chanceInput)

  assert.deepEqual(chance.match.rng, expectedRng.snapshot())
  assert.deepEqual(chance.event.burned, ['c-KH'])
})

test('a settled final source pair transitions and shuffles player before opponent', () => {
  const input = createFixture({
    stage: 'source',
    sourceDeck: ['c-AS', 'c-KH'],
    playerWon: ['c-2S', 'c-3S'],
    opponentWon: ['c-4H', 'c-5H'],
  })
  const control = restoreRng(input.rng)
  const expectedPlayer = shuffle(['c-2S', 'c-3S', 'c-AS'], control)
  const expectedOpponent = shuffle(['c-4H', 'c-5H'], control)
  const { match, event } = revealOrContinue(input)

  assert.equal(match.stage, 'personal')
  assert.equal(match.machineState, 'ready')
  assert.deepEqual(match.zones.player.drawPile, expectedPlayer)
  assert.deepEqual(match.zones.opponent.drawPile, expectedOpponent)
  assert.deepEqual(match.zones.player.wonPile, [])
  assert.deepEqual(match.zones.opponent.wonPile, [])
  assert.deepEqual(match.rng, control.snapshot())
  assert.equal(event.stage, 'personal')
  assert.deepEqual(event.transfers, [{ cardId: 'c-AS', to: 'player.wonPile' }])
})

test('a tied final source pair continues from personal piles in the same action', () => {
  const input = createFixture({
    stage: 'source',
    sourceDeck: ['c-10S', 'c-10H'],
    playerWon: ['c-AS'],
    opponentWon: ['c-KH'],
  })
  const { match, event } = revealOrContinue(input)

  assert.equal(match.stage, 'personal')
  assert.equal(match.machineState, 'ready')
  assert.equal(match.turn, 1)
  assert.deepEqual(event.reveals, [
    { cardId: 'c-10S', suppliedBy: 'player' },
    { cardId: 'c-10H', suppliedBy: 'opponent' },
    { cardId: 'c-AS', suppliedBy: 'player' },
    { cardId: 'c-KH', suppliedBy: 'opponent' },
  ])
  assert.deepEqual(event.transfers, [
    { cardId: 'c-10S', to: 'player.wonPile' },
    { cardId: 'c-AS', to: 'player.wonPile' },
  ])
  assert.deepEqual(event.burned, ['c-10H', 'c-KH'])
})

test('source-to-personal inability produces a terminal winner or retained draw', () => {
  const oneAvailable = revealOrContinue(createFixture({
    runId: 'one-available',
    stage: 'source',
    sourceDeck: ['c-10S', 'c-10H'],
    playerWon: ['c-AS'],
  }))
  assert.deepEqual(oneAvailable.match.outcome, {
    result: 'win',
    winner: 'player',
    reason: 'opponentUnableToReveal',
  })
  assert.equal(oneAvailable.match.machineState, 'ended')
  assert.deepEqual(oneAvailable.event.reveals, [
    { cardId: 'c-10S', suppliedBy: 'player' },
    { cardId: 'c-10H', suppliedBy: 'opponent' },
    { cardId: 'c-AS', suppliedBy: 'player' },
  ])
  assert.equal(oneAvailable.match.zones.contestedPile.length, 0)

  const neitherAvailable = revealOrContinue(createFixture({
    runId: 'neither-available',
    stage: 'source',
    sourceDeck: ['c-10S', 'c-10H'],
  }))
  assert.deepEqual(neitherAvailable.match.outcome, {
    result: 'draw',
    reason: 'mutualInability',
  })
  assert.deepEqual(neitherAvailable.event, {
    eventVersion: 1,
    id: 'neither-available:clash-1',
    type: 'clashDrawn',
    turn: 1,
    stage: 'personal',
    reason: 'mutualInability',
    reveals: [
      { cardId: 'c-10S', suppliedBy: 'player' },
      { cardId: 'c-10H', suppliedBy: 'opponent' },
    ],
    pendingPresentation: 'draw-v1',
  })
  assert.deepEqual(neitherAvailable.match.zones.contestedPile, neitherAvailable.event.reveals)
})

test('personal ties recycle both won piles in player-first RNG order', () => {
  const input = createFixture({
    stage: 'personal',
    playerDraw: ['c-10S'],
    playerWon: ['c-AS', 'c-KS', 'c-QS'],
    opponentDraw: ['c-10H'],
    opponentWon: ['c-2H', 'c-3H', 'c-4H'],
  })
  const control = restoreRng(input.rng)
  const playerRecycle = shuffle(input.zones.player.wonPile, control)
  const opponentRecycle = shuffle(input.zones.opponent.wonPile, control)
  const { match, event } = revealOrContinue(input)

  assert.equal(event.winner, 'player')
  assert.deepEqual(event.reveals, [
    { cardId: 'c-10S', suppliedBy: 'player' },
    { cardId: 'c-10H', suppliedBy: 'opponent' },
    { cardId: playerRecycle[0], suppliedBy: 'player' },
    { cardId: opponentRecycle[0], suppliedBy: 'opponent' },
  ])
  assert.deepEqual(match.zones.player.drawPile, playerRecycle.slice(1))
  assert.deepEqual(match.zones.opponent.drawPile, opponentRecycle.slice(1))
  assert.deepEqual(match.rng, control.snapshot())
})

test('personal-stage inability appends the available card and ends for either side', () => {
  const cases = [
    {
      runId: 'player-terminal',
      playerDraw: ['c-10S', 'c-AS'],
      opponentDraw: ['c-10H'],
      winner: 'player',
      reason: 'opponentUnableToReveal',
      finalCard: 'c-AS',
    },
    {
      runId: 'opponent-terminal',
      playerDraw: ['c-10S'],
      opponentDraw: ['c-10H', 'c-AH'],
      winner: 'opponent',
      reason: 'playerUnableToReveal',
      finalCard: 'c-AH',
    },
  ]

  for (const fixture of cases) {
    const { match, event } = revealOrContinue(createFixture({
      stage: 'personal',
      ...fixture,
    }))
    assert.deepEqual(match.outcome, {
      result: 'win',
      winner: fixture.winner,
      reason: fixture.reason,
    })
    assert.equal(match.status, 'ended')
    assert.equal(event.winner, fixture.winner)
    assert.deepEqual(event.reveals.at(-1), {
      cardId: fixture.finalCard,
      suppliedBy: fixture.winner,
    })
    assert.equal(match.zones.contestedPile.length, 0)
  }
})

test('personal mutual inability retains the unresolved contest without settlement or RNG', () => {
  const input = createFixture({
    runId: 'personal-draw',
    stage: 'personal',
    playerDraw: ['c-10S'],
    opponentDraw: ['c-10H'],
  })
  const { match, event } = revealOrContinue(input)

  assert.deepEqual(match.rng, input.rng)
  assert.deepEqual(match.outcome, { result: 'draw', reason: 'mutualInability' })
  assert.equal(event.type, 'clashDrawn')
  assert.equal(Object.hasOwn(event, 'transfers'), false)
  assert.equal(Object.hasOwn(event, 'burned'), false)
  assert.deepEqual(match.zones.contestedPile, event.reveals)
  assert.equal(match.zones.inPlay.length, 0)
  assert.doesNotThrow(() => assertStableBoundary(match.zones))
})

test('invalid and ended states fail atomically before any transition is exposed', () => {
  const input = createFixture({
    stage: 'source',
    sourceDeck: ['c-AS', 'c-KH', 'c-2S', 'c-3H'],
  })
  const malformed = clone(input)
  malformed.zones.sourceDeck[1] = malformed.zones.sourceDeck[0]
  const malformedBefore = clone(malformed)
  assert.throws(() => revealOrContinue(malformed), /more than one zone/)
  assert.deepEqual(malformed, malformedBefore)

  const ended = revealOrContinue(createFixture({
    stage: 'personal',
    playerDraw: ['c-10S'],
    opponentDraw: ['c-10H'],
  })).match
  const endedBefore = clone(ended)
  assert.throws(() => revealOrContinue(ended), /ended match/)
  assert.deepEqual(ended, endedBefore)
})

test('bounded seeded runs remain deterministic and conserve all cards at every boundary', () => {
  for (const ruleset of [BASELINE_RULESET, NO_BURN_RULESET]) {
    for (let seed = 0; seed < 12; seed += 1) {
      let first = createMatch({ runId: `${ruleset.id}-${seed}`, seed, ruleset })
      let second = createMatch({ runId: `${ruleset.id}-${seed}`, seed, ruleset })

      for (let step = 0; step < 128 && first.status === 'active'; step += 1) {
        const firstTransition = revealOrContinue(first)
        const secondTransition = revealOrContinue(second)
        assert.deepEqual(firstTransition, secondTransition)
        first = firstTransition.match
        second = secondTransition.match
        assert.equal(first.turn, step + 1)
        assert.equal(firstTransition.event.turn, first.turn)
        assert.equal(firstTransition.event.id, `${first.runId}:clash-${first.turn}`)
        assert.equal(first.zones.inPlay.length, 0)
        assert.doesNotThrow(() => assertStableBoundary(first.zones))
        assert.equal(validateMatchState(first), first)
      }
    }
  }
})

test('seed 12345 has a locked complete baseline result and exact event count', () => {
  let match = createMatch({
    runId: 'baseline-12345',
    seed: 12345,
    ruleset: BASELINE_RULESET,
  })
  const eventIds = []

  while (match.status === 'active') {
    const transition = revealOrContinue(match)
    match = transition.match
    eventIds.push(transition.event.id)
  }

  assert.equal(match.turn, 46)
  assert.equal(eventIds.length, 46)
  assert.equal(eventIds[0], 'baseline-12345:clash-1')
  assert.equal(eventIds.at(-1), 'baseline-12345:clash-46')
  assert.deepEqual(match.outcome, {
    result: 'win',
    winner: 'player',
    reason: 'opponentUnableToReveal',
  })
  assert.equal(match.zones.burnPile.length, 48)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { createAiController } from '../../src/domain/ai-controller.js'
import {
  createMatch,
  pauseMatch,
  revealOrContinue,
} from '../../src/domain/match-machine.js'
import { BASELINE_RULESET } from '../../src/domain/ruleset.js'

function createBaselineMatch(runId, seed) {
  return createMatch({ runId, seed, ruleset: BASELINE_RULESET })
}

function runToEnd(controller, runId, seed) {
  let match = createBaselineMatch(runId, seed)
  const events = []
  while (match.status === 'active') {
    const transition = controller.advanceEncounter(match)
    match = transition.match
    events.push(transition.event)
  }
  return { match, events }
}

test('AI advances exactly one deterministic immutable clash without hidden randomness', (t) => {
  const previousRandom = Math.random
  Math.random = () => assert.fail('AI advancement must not use Math.random')
  t.after(() => {
    Math.random = previousRandom
  })

  const input = createBaselineMatch('ai-deterministic', 12345)
  const inputCopy = JSON.parse(JSON.stringify(input))
  let resolveCalls = 0
  const controller = createAiController({
    resolveClash(match) {
      resolveCalls += 1
      return revealOrContinue(match)
    },
  })
  const actual = controller.advanceEncounter(input)
  const expected = revealOrContinue(input)

  assert.equal(resolveCalls, 1)
  assert.deepEqual(actual, expected)
  assert.equal(actual.match.turn, input.turn + 1)
  assert.equal(actual.event, actual.match.pendingEvent)
  assert.equal(Object.isFrozen(actual.match), true)
  assert.equal(Object.isFrozen(actual.event), true)
  assert.deepEqual(input, inputCopy)
  for (let index = 0; index < actual.event.reveals.length; index += 1) {
    assert.equal(
      actual.event.reveals[index].suppliedBy,
      index % 2 === 0 ? 'player' : 'opponent',
    )
  }
})

test('AI carries a final source tie through the personal-stage encounter', () => {
  const controller = createAiController()
  let match = createBaselineMatch('ai-cross-stage', 0)
  let transition

  while (match.stage === 'source') {
    transition = controller.advanceEncounter(match)
    match = transition.match
  }

  assert.equal(transition.event.turn, 26)
  assert.equal(transition.event.stage, 'personal')
  assert.deepEqual(
    transition.event.reveals.map(({ suppliedBy, from }) => ({ suppliedBy, from })),
    [
      { suppliedBy: 'player', from: 'sourceDeck' },
      { suppliedBy: 'opponent', from: 'sourceDeck' },
      { suppliedBy: 'player', from: 'player.drawPile' },
      { suppliedBy: 'opponent', from: 'opponent.drawPile' },
    ],
  )
  assert.equal(match.zones.sourceDeck.length, 0)
  assert.equal(match.machineState, 'ready')
})

test('AI reaches deterministic player, opponent, and draw terminal outcomes', () => {
  const controller = createAiController()
  const cases = [
    [0, { result: 'win', winner: 'player', reason: 'opponentUnableToReveal' }],
    [5, { result: 'win', winner: 'opponent', reason: 'playerUnableToReveal' }],
    [32, { result: 'draw', reason: 'mutualInability' }],
  ]

  for (const [seed, outcome] of cases) {
    const first = runToEnd(controller, `ai-terminal-${seed}`, seed)
    const second = runToEnd(controller, `ai-terminal-${seed}`, seed)
    assert.deepEqual(first, second)
    assert.deepEqual(first.match.outcome, outcome)
    assert.equal(first.events.length, first.match.turn)
    assert.equal(first.events.at(-1), first.match.pendingEvent)
  }
})

test('AI rejects invalid states, dependencies, and malformed advancements', () => {
  assert.throws(
    () => createAiController({ resolveClash: null }),
    /resolveClash must be a function/,
  )

  const ready = createBaselineMatch('ai-invalid', 1)
  const paused = pauseMatch(ready)
  assert.throws(
    () => createAiController().advanceEncounter(paused),
    /paused match cannot reveal/,
  )

  const { match: ended } = runToEnd(createAiController(), 'ai-ended', 0)
  assert.throws(
    () => createAiController().advanceEncounter(ended),
    /ended match cannot reveal/,
  )
  assert.throws(
    () => createAiController({ resolveClash: () => ({}) }).advanceEncounter(ready),
    /return only match and event/,
  )
  assert.throws(
    () => createAiController({
      resolveClash: () => ({ match: ready, event: ready.pendingEvent }),
    }).advanceEncounter(ready),
    /exactly one matching clash/,
  )
})

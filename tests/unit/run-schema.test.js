import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  createMatch,
  revealOrContinue,
  validateMatchState,
} from '../../src/domain/match-machine.js'
import {
  BASELINE_RULESET,
  NO_BURN_RULESET,
} from '../../src/domain/ruleset.js'
import {
  GAME_RULES_VERSION,
  SAVE_SCHEMA_VERSION,
  UnsupportedGameRulesVersionError,
  UnsupportedSaveVersionError,
  createRunSave,
  restoreRunSave,
  validateRunSave,
} from '../../src/persistence/run-schema.js'

const FIXTURE_ROOT = new URL('../fixtures/', import.meta.url)
const SAVED_AT = '2026-09-21T08:00:00.000Z'

function fixture(name) {
  return JSON.parse(readFileSync(new URL(name, FIXTURE_ROOT), 'utf8'))
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function allObjects(value) {
  if (value === null || typeof value !== 'object') return []
  return [value, ...Object.values(value).flatMap(allObjects)]
}

function activeFixtureMatch() {
  const match = createMatch({
    runId: 'fixture-active',
    seed: 12345,
    ruleset: BASELINE_RULESET,
  })
  return revealOrContinue(match).match
}

test('current saves use the exact versioned shape and complete fixed fixture', () => {
  const match = activeFixtureMatch()
  const save = createRunSave(match, { savedAt: SAVED_AT })

  assert.equal(SAVE_SCHEMA_VERSION, 2)
  assert.equal(GAME_RULES_VERSION, 1)
  assert.deepEqual(save, fixture('run-save-v2.json'))
  assert.equal(validateRunSave(save), save)
  assert.ok(allObjects(save).every(Object.isFrozen))
  assert.notEqual(save.ruleset, match.ruleset)
  assert.notEqual(save.pendingEvent, match.pendingEvent)
  assert.deepEqual(save.match.futureModifiers, [])
  assert.deepEqual(save.match.outcome, null)
})

test('restore returns a detached immutable equivalent domain snapshot', () => {
  const source = fixture('run-save-v2.json')
  const before = clone(source)
  const restored = restoreRunSave(source)

  assert.deepEqual(restored, activeFixtureMatch())
  assert.equal(validateMatchState(restored), restored)
  assert.ok(allObjects(restored).every(Object.isFrozen))
  assert.notEqual(restored.rng, source.rng)
  assert.notEqual(restored.pendingEvent, source.pendingEvent)
  assert.deepEqual(source, before)

  source.rng.state = 0
  source.match.sourceDeck.length = 0
  assert.deepEqual(restored, activeFixtureMatch())
})

test('terminal outcome and pending presentation event restore exactly', () => {
  const save = fixture('run-save-terminal-v2.json')
  const restored = restoreRunSave(save)

  assert.equal(restored.machineState, 'ended')
  assert.equal(restored.status, 'ended')
  assert.deepEqual(restored.outcome, {
    result: 'win',
    winner: 'player',
    reason: 'opponentUnableToReveal',
  })
  assert.equal(restored.turn, 46)
  assert.equal(restored.pendingEvent.id, 'fixture-terminal:clash-46')
  assert.equal(restored.pendingEvent.pendingPresentation, 'settlement-v1')
  assert.deepEqual(restored.rng, save.rng)
})

test('schema validation rejects malformed metadata and nonstable records', () => {
  const current = fixture('run-save-v2.json')
  const invalid = [
    { ...clone(current), saveSchemaVersion: 1 },
    { ...clone(current), saveSchemaVersion: 3 },
    { ...clone(current), gameRulesVersion: 2 },
    { ...clone(current), savedAt: '2026-09-21T08:00:00Z' },
    { ...clone(current), savedAt: 'not-a-date' },
    { ...clone(current), extra: true },
    { ...clone(current), runId: 'different-run' },
    {
      ...clone(current),
      match: { ...clone(current.match), machineState: 'resolving' },
    },
    {
      ...clone(current),
      match: { ...clone(current.match), futureModifiers: [{}] },
    },
    {
      ...clone(current),
      match: {
        ...clone(current.match),
        sourceDeck: current.match.sourceDeck.slice(1),
      },
    },
    {
      ...clone(current),
      pendingEvent: {
        ...clone(current.pendingEvent),
        stateFingerprint: `${current.pendingEvent.stateFingerprint}:stale`,
      },
    },
  ]

  for (const save of invalid) {
    assert.throws(() => validateRunSave(save))
    assert.throws(() => restoreRunSave(save))
  }
  assert.throws(
    () => validateRunSave({ ...clone(current), saveSchemaVersion: 3 }),
    UnsupportedSaveVersionError,
  )
  assert.throws(
    () => validateRunSave({ ...clone(current), gameRulesVersion: 2 }),
    UnsupportedGameRulesVersionError,
  )
})

test('serialization requires an explicit canonical timestamp and stable valid match', () => {
  const match = activeFixtureMatch()
  assert.throws(() => createRunSave(match), TypeError)
  assert.throws(() => createRunSave(match, {}), TypeError)
  assert.throws(
    () => createRunSave(match, { savedAt: '2026-09-21T08:00:00Z' }),
    /canonical ISO timestamp/,
  )
  assert.throws(
    () => createRunSave(match, { savedAt: SAVED_AT, extra: true }),
    TypeError,
  )

  const unstable = clone(match)
  unstable.machineState = 'resolving'
  assert.throws(
    () => createRunSave(unstable, { savedAt: SAVED_AT }),
    /public boundary/,
  )
})

test('JSON save and restore preserve deterministic continuation without RNG replay', () => {
  const cases = [
    [BASELINE_RULESET, 0],
    [BASELINE_RULESET, 12345],
    [NO_BURN_RULESET, 0],
    [NO_BURN_RULESET, 7],
  ]

  for (const [ruleset, seed] of cases) {
    let uninterrupted = createMatch({
      runId: `resume:${ruleset.id}:${seed}`,
      seed,
      ruleset,
    })
    for (let step = 0; step < 5; step += 1) {
      uninterrupted = revealOrContinue(uninterrupted).match
    }

    const save = JSON.parse(JSON.stringify(createRunSave(uninterrupted, { savedAt: SAVED_AT })))
    let resumed = restoreRunSave(save)
    assert.deepEqual(resumed.rng, uninterrupted.rng)
    assert.deepEqual(resumed.pendingEvent, uninterrupted.pendingEvent)
    assert.deepEqual(resumed, uninterrupted)

    let guard = 0
    while (uninterrupted.status === 'active') {
      const expected = revealOrContinue(uninterrupted)
      const actual = revealOrContinue(resumed)
      assert.deepEqual(actual, expected)
      uninterrupted = expected.match
      resumed = actual.match
      guard += 1
      assert.ok(guard < 10_000)
    }
    assert.deepEqual(resumed, uninterrupted)
  }
})

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  createMatch,
  pauseMatch,
  revealOrContinue,
  validateMatchState,
} from '../../src/domain/match-machine.js'
import {
  BASELINE_RULESET,
  NO_BURN_RULESET,
  SHORT_DECK_BASELINE_RULESET,
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
const TERMINAL_SAVED_AT = '2026-09-21T08:05:00.000Z'

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

function playToEnd(match) {
  let current = match
  while (current.status === 'active') {
    current = revealOrContinue(current).match
  }
  return current
}

// Seed 62 opens the short-deck game with a 6 beating an Ace.
function shortDeckMatch(runId) {
  return createMatch({ runId, seed: 62, ruleset: SHORT_DECK_BASELINE_RULESET })
}

test('current saves use the exact versioned shape and complete fixed fixture', () => {
  const match = activeFixtureMatch()
  const save = createRunSave(match, { savedAt: SAVED_AT })

  assert.equal(SAVE_SCHEMA_VERSION, 9)
  assert.equal(GAME_RULES_VERSION, 2)
  assert.deepEqual(save, fixture('run-save-v9.json'))
  assert.equal(validateRunSave(save), save)
  assert.ok(allObjects(save).every(Object.isFrozen))
  assert.notEqual(save.ruleset, match.ruleset)
  assert.notEqual(save.pendingEvent, match.pendingEvent)
  assert.deepEqual(save.match.futureModifiers, [])
  assert.deepEqual(save.match.outcome, null)
})

test('restore returns a detached immutable equivalent domain snapshot', () => {
  const source = fixture('run-save-v9.json')
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
  const save = fixture('run-save-terminal-v9.json')
  const restored = restoreRunSave(save)
  const ended = playToEnd(createMatch({
    runId: 'fixture-terminal',
    seed: 12345,
    ruleset: BASELINE_RULESET,
  }))

  assert.deepEqual(createRunSave(ended, { savedAt: TERMINAL_SAVED_AT }), save)
  assert.deepEqual(restored, ended)

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

test('paused snapshots preserve the ready-state event fingerprint and restore exactly', () => {
  const paused = pauseMatch(activeFixtureMatch())
  const save = createRunSave(paused, { savedAt: SAVED_AT })

  assert.deepEqual(save, fixture('run-save-paused-v9.json'))
  assert.equal(
    save.pendingEvent.stateFingerprint,
    fixture('run-save-v9.json').pendingEvent.stateFingerprint,
  )
  const restored = restoreRunSave(JSON.parse(JSON.stringify(save)))
  assert.deepEqual(restored, paused)
  assert.deepEqual(restored.rng, activeFixtureMatch().rng)
  assert.deepEqual(restored.pendingEvent, activeFixtureMatch().pendingEvent)
  assert.equal(validateMatchState(restored), restored)
})

test('short-deck saves regenerate exactly and restore their 36-card games', () => {
  const active = revealOrContinue(shortDeckMatch('fixture-short-deck-active')).match
  const ended = playToEnd(shortDeckMatch('fixture-short-deck-terminal'))
  const cases = [
    ['run-save-short-deck-v9.json', active, SAVED_AT],
    ['run-save-short-deck-paused-v9.json', pauseMatch(active), SAVED_AT],
    ['run-save-short-deck-terminal-v9.json', ended, TERMINAL_SAVED_AT],
  ]

  for (const [name, match, savedAt] of cases) {
    const save = fixture(name)
    assert.deepEqual(createRunSave(match, { savedAt }), save, name)
    assert.deepEqual(restoreRunSave(save), match, name)
    assert.equal(save.ruleset.id, 'short-deck-baseline-v1', name)
    assert.equal(save.pendingEvent.eventVersion, 6, name)
    assert.equal(save.pendingEvent.deck, 'short-36', name)
  }

  const ready = fixture('run-save-short-deck-v9.json')
  assert.deepEqual(ready.pendingEvent.reveals.map(({ cardId }) => cardId), ['c-6C', 'c-AH'])
  assert.equal(ready.pendingEvent.winner, 'player')
  assert.equal(
    ready.match.sourceDeck.length + ready.match.player.drawPile.length
      + ready.match.player.wonPile.length + ready.match.opponent.drawPile.length
      + ready.match.opponent.wonPile.length + ready.match.burnPile.length,
    36,
  )
  const terminal = restoreRunSave(fixture('run-save-short-deck-terminal-v9.json'))
  assert.equal(terminal.status, 'ended')
  assert.ok(terminal.turn <= 36)

  const shortEvent = fixture('run-save-v9.json')
  shortEvent.pendingEvent.deck = 'short-36'
  assert.throws(() => validateRunSave(shortEvent), /deck of the match ruleset/)
  // Without the short deck, the Ace wins the saved 6-vs-A round.
  const standardEvent = fixture('run-save-short-deck-v9.json')
  standardEvent.pendingEvent.deck = 'standard-52'
  assert.throws(() => validateRunSave(standardEvent), /decisive reveal round/)
  const legacyEvent = fixture('run-save-short-deck-v9.json')
  delete legacyEvent.pendingEvent.deck
  legacyEvent.pendingEvent.eventVersion = 4
  assert.throws(() => validateRunSave(legacyEvent), /decisive reveal round/)
})

test('a fresh turn-zero match round-trips without inventing a pending event', () => {
  const match = createMatch({
    runId: 'turn-zero',
    seed: 0,
    ruleset: BASELINE_RULESET,
  })
  const restored = restoreRunSave(createRunSave(match, { savedAt: SAVED_AT }))

  assert.deepEqual(restored, match)
  assert.equal(restored.turn, 0)
  assert.equal(restored.pendingEvent, null)
  assert.deepEqual(restored.rng, match.rng)

  const paused = pauseMatch(match)
  const restoredPaused = restoreRunSave(createRunSave(paused, { savedAt: SAVED_AT }))
  assert.deepEqual(restoredPaused, paused)
  assert.equal(restoredPaused.turn, 0)
  assert.equal(restoredPaused.pendingEvent, null)
  assert.deepEqual(restoredPaused.rng, match.rng)
})

test('schema validation rejects malformed metadata and nonstable records', () => {
  const current = fixture('run-save-v9.json')
  const invalid = [
    { ...clone(current), saveSchemaVersion: 1 },
    { ...clone(current), saveSchemaVersion: 2 },
    { ...clone(current), saveSchemaVersion: 5 },
    { ...clone(current), saveSchemaVersion: 6 },
    { ...clone(current), saveSchemaVersion: 7 },
    { ...clone(current), saveSchemaVersion: 8 },
    { ...clone(current), saveSchemaVersion: 10 },
    { ...clone(current), gameRulesVersion: 1 },
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
  for (const saveSchemaVersion of [4, 5, 6, 7, 8, 10]) {
    assert.throws(
      () => validateRunSave({ ...clone(current), saveSchemaVersion }),
      UnsupportedSaveVersionError,
    )
  }
  assert.throws(
    () => validateRunSave({ ...clone(current), gameRulesVersion: 1 }),
    UnsupportedGameRulesVersionError,
  )

  // A current-schema Campaign save that claims older campaign rules is incompatible.
  const campaign = fixture('campaign-save-route-v9.json')
  assert.equal(campaign.gameRulesVersion, 8)
  assert.throws(
    () => validateRunSave({ ...campaign, gameRulesVersion: 7 }),
    (error) => error instanceof UnsupportedGameRulesVersionError && error.version === 7,
  )
  assert.throws(
    () => validateRunSave({ ...campaign, gameRulesVersion: 6 }),
    (error) => error instanceof UnsupportedGameRulesVersionError && error.version === 6,
  )
})

test('schema validation rejects non-JSON containers and accessors without invoking them', () => {
  const extraArrayProperty = fixture('run-save-v9.json')
  extraArrayProperty.match.sourceDeck.label = 'not-an-index'
  assert.throws(() => validateRunSave(extraArrayProperty), /dense array/)

  const accessor = fixture('run-save-v9.json')
  let invoked = false
  Object.defineProperty(accessor.match.player, 'drawPile', {
    enumerable: true,
    get() {
      invoked = true
      return []
    },
  })
  assert.throws(() => validateRunSave(accessor), /JSON-compatible data/)
  assert.equal(invoked, false)

  const indexAccessor = fixture('run-save-v9.json')
  const firstCard = indexAccessor.match.sourceDeck[0]
  Object.defineProperty(indexAccessor.match.sourceDeck, '0', {
    enumerable: true,
    get() {
      invoked = true
      return firstCard
    },
  })
  assert.throws(() => validateRunSave(indexAccessor), /dense array/)
  assert.equal(invoked, false)

  const versionAccessor = fixture('run-save-v9.json')
  Object.defineProperty(versionAccessor, 'saveSchemaVersion', {
    enumerable: true,
    get() {
      invoked = true
      return SAVE_SCHEMA_VERSION
    },
  })
  assert.throws(() => validateRunSave(versionAccessor), /JSON-compatible data/)
  assert.equal(invoked, false)

  const modeAccessor = clone(activeFixtureMatch())
  Object.defineProperty(modeAccessor, 'mode', {
    enumerable: true,
    get() {
      invoked = true
      return 'campaign'
    },
  })
  assert.throws(
    () => createRunSave(modeAccessor, { savedAt: SAVED_AT }),
    /must contain only/,
  )
  assert.equal(invoked, false)
})

test('schema validation rejects hidden fields on saved reveal records', () => {
  let match = createMatch({
    runId: 'malformed-draw',
    seed: 93,
    ruleset: BASELINE_RULESET,
  })
  while (match.status === 'active') {
    match = revealOrContinue(match).match
  }
  assert.equal(match.outcome.result, 'draw')

  const save = clone(createRunSave(match, { savedAt: SAVED_AT }))
  Object.defineProperty(save.match.contestedPile[0], 'hidden', {
    value: true,
  })

  assert.throws(
    () => validateRunSave(save),
    /save\.match\.contestedPile\[0\] must contain only cardId, suppliedBy/,
  )
  assert.throws(
    () => restoreRunSave(save),
    /save\.match\.contestedPile\[0\] must contain only cardId, suppliedBy/,
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

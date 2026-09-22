import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createMatch,
  revealOrContinue,
} from '../../src/domain/match-machine.js'
import { BASELINE_RULESET } from '../../src/domain/ruleset.js'
import {
  createRunSave,
  restoreRunSave,
} from '../../src/persistence/run-schema.js'
import { createEventPlayer } from '../../src/presentation/event-player.js'

const ZERO_TIMING = Object.freeze({
  revealMs: 0,
  settlementMs: 0,
  burnMs: 0,
})

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function createAdapter(calls) {
  return {
    beginEvent(event) {
      calls.push(['begin', event.id])
    },
    applyStep(step) {
      calls.push(['step', step.kind, step.cardId ?? null])
    },
    syncSnapshot(match, context) {
      calls.push(['sync', match.pendingEvent.id, context.reason])
    },
  }
}

test('saved pending presentation replays without changing deterministic continuation', async () => {
  const initial = createMatch({
    runId: 'presentation-restore',
    seed: 12345,
    ruleset: BASELINE_RULESET,
  })
  const committed = revealOrContinue(initial).match
  const record = JSON.parse(JSON.stringify(createRunSave(committed, {
    savedAt: '2026-09-22T09:00:00.000Z',
  })))
  const restored = restoreRunSave(record)
  const beforeCommitted = clone(committed)
  const beforeRestored = clone(restored)
  const calls = []
  const player = createEventPlayer({
    adapter: createAdapter(calls),
    timing: ZERO_TIMING,
  })

  const result = await player.present(restored)

  assert.equal(result.status, 'completed')
  assert.equal(calls[0][0], 'begin')
  assert.deepEqual(calls.at(-1), ['sync', restored.pendingEvent.id, 'completed'])
  assert.deepEqual(committed, beforeCommitted)
  assert.deepEqual(restored, beforeRestored)
  assert.deepEqual(restored.rng, committed.rng)
  assert.deepEqual(restored.zones, committed.zones)
  assert.deepEqual(restored.pendingEvent, committed.pendingEvent)
  assert.deepEqual(revealOrContinue(restored), revealOrContinue(committed))
})

test('reduced-motion restore skips transitions and preserves the saved fingerprint', async () => {
  const committed = revealOrContinue(createMatch({
    runId: 'presentation-restore-reduced',
    seed: 0,
    ruleset: BASELINE_RULESET,
  })).match
  const restored = restoreRunSave(JSON.parse(JSON.stringify(createRunSave(committed, {
    savedAt: '2026-09-22T09:01:00.000Z',
  }))))
  const fingerprint = restored.pendingEvent.stateFingerprint
  const calls = []
  const player = createEventPlayer({
    adapter: createAdapter(calls),
    settingsController: {
      getSnapshot: () => ({ animationSpeed: 1, reducedMotion: true }),
      subscribe(listener) {
        listener({ animationSpeed: 1, reducedMotion: true })
        return () => {}
      },
    },
  })

  assert.equal((await player.present(restored)).status, 'skipped')
  assert.equal(calls.some(([kind]) => kind === 'begin'), false)
  assert.equal(calls.some(([kind]) => kind === 'step'), false)
  assert.deepEqual(calls, [['sync', restored.pendingEvent.id, 'skipped']])
  assert.equal(restored.pendingEvent.stateFingerprint, fingerprint)
  assert.deepEqual(restored, committed)
})

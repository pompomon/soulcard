import assert from 'node:assert/strict'
import test from 'node:test'
import { createRunController } from '../../src/app/run-controller.js'
import {
  createMatch,
  revealOrContinue,
} from '../../src/domain/match-machine.js'
import { BASELINE_RULESET } from '../../src/domain/ruleset.js'
import {
  createRunSave,
  restoreRunSave,
} from '../../src/persistence/run-schema.js'
import { createPageLifecycle } from '../../src/pwa/lifecycle.js'

class FakeEventTarget {
  constructor() {
    this.listeners = new Map()
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener)
  }

  dispatch(type) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener({ type })
    }
  }
}

function createMemoryRepository() {
  let record = null
  let saveCount = 0
  return {
    async load() {
      if (record === null) return { status: 'empty' }
      return {
        status: 'resumable',
        savedAt: record.savedAt,
        migratedFrom: null,
        match: restoreRunSave(JSON.parse(JSON.stringify(record))),
      }
    },
    async save(match) {
      saveCount += 1
      const savedAt = `2026-09-21T12:00:0${saveCount}.000Z`
      record = JSON.parse(JSON.stringify(createRunSave(match, { savedAt })))
      return { status: 'saved', savedAt }
    },
    close() {},
    get saveCount() {
      return saveCount
    },
  }
}

test('clash, pause, background, restore, and resume preserve deterministic continuation', async () => {
  const repository = createMemoryRepository()
  const initial = createMatch({
    runId: 'integration-lifecycle',
    seed: 12345,
    ruleset: BASELINE_RULESET,
  })
  const firstController = createRunController({
    repository,
    initialMatch: initial,
  })

  const committed = await firstController.revealOrContinue()
  const readyBoundary = committed.match
  assert.equal(committed.save.status, 'saved')
  assert.equal(readyBoundary.machineState, 'ready')

  const paused = await firstController.pause()
  assert.equal(paused.match.machineState, 'paused')
  assert.deepEqual(paused.match.rng, readyBoundary.rng)
  assert.deepEqual(paused.match.pendingEvent, readyBoundary.pendingEvent)

  const documentObject = new FakeEventTarget()
  documentObject.visibilityState = 'visible'
  documentObject.hidden = false
  const windowObject = new FakeEventTarget()
  const lifecycle = createPageLifecycle({
    documentObject,
    windowObject,
    onSave: () => firstController.saveStable(),
  })
  windowObject.dispatch('pagehide')
  await firstController.whenIdle()
  assert.equal(repository.saveCount, 3)

  lifecycle.destroy()
  await firstController.destroy()

  const restoredController = createRunController({ repository })
  const restored = await restoredController.restore()
  assert.equal(restored.status, 'resumable')
  assert.equal(restored.match.machineState, 'paused')
  assert.deepEqual(restored.match.rng, readyBoundary.rng)
  assert.deepEqual(restored.match.pendingEvent, readyBoundary.pendingEvent)

  const expected = revealOrContinue(readyBoundary)
  restoredController.resume()
  const actual = await restoredController.revealOrContinue()
  assert.deepEqual(actual.match, expected.match)
  assert.deepEqual(actual.event, expected.event)
  assert.deepEqual(actual.match.rng, expected.match.rng)
})

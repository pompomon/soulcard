import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createMatch,
  pauseMatch,
  revealOrContinue,
} from '../../src/domain/match-machine.js'
import { REVEAL_OR_CONTINUE_ACTION } from '../../src/domain/ai-controller.js'
import { BASELINE_RULESET } from '../../src/domain/ruleset.js'
import { createRunController } from '../../src/app/run-controller.js'

function createActiveMatch(runId = 'controller-run', seed = 12345) {
  return createMatch({
    runId,
    seed,
    ruleset: BASELINE_RULESET,
  })
}

function createEndedMatch(runId = 'ended-controller-run') {
  let match = createActiveMatch(runId)
  while (match.status === 'active') {
    match = revealOrContinue(match).match
  }
  return match
}

function deferred() {
  let resolve
  const promise = new Promise((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function createRepository({
  loadResult = { status: 'empty' },
  saveResult,
} = {}) {
  const saves = []
  let closeCalls = 0
  return {
    saves,
    load: async () => loadResult,
    async save(match) {
      saves.push(match)
      return saveResult?.(match, saves.length) ?? {
        status: 'saved',
        savedAt: `2026-09-21T10:00:0${saves.length}.000Z`,
      }
    },
    close() {
      closeCalls += 1
    },
    get closeCalls() {
      return closeCalls
    },
  }
}

test('committed clashes and explicit pauses autosave stable snapshots', async () => {
  const repository = createRepository()
  const controller = createRunController({
    repository,
    initialMatch: createActiveMatch(),
  })
  const snapshots = []
  const unsubscribe = controller.subscribe((snapshot) => snapshots.push(snapshot))

  const clashPromise = controller.revealOrContinue()
  assert.equal(controller.currentMatch.turn, 1)
  assert.equal(controller.currentMatch.machineState, 'ready')
  assert.equal(controller.getSnapshot().saveStatus, 'saving')
  const clash = await clashPromise
  assert.equal(clash.save.status, 'saved')
  assert.equal(repository.saves.length, 1)
  assert.equal(repository.saves[0].machineState, 'ready')

  const ready = controller.currentMatch
  const pausePromise = controller.pause()
  assert.equal(controller.currentMatch.machineState, 'paused')
  assert.deepEqual(controller.currentMatch.rng, ready.rng)
  assert.deepEqual(controller.currentMatch.pendingEvent, ready.pendingEvent)
  const paused = await pausePromise
  assert.equal(paused.save.status, 'saved')
  assert.equal(repository.saves[1].machineState, 'paused')
  assert.equal(controller.getSnapshot().saveStatus, 'saved')

  const resumed = controller.resume()
  assert.deepEqual(resumed, ready)
  assert.equal(controller.getSnapshot().saveStatus, 'unsaved')
  const lifecycleSave = await controller.saveStable()
  assert.equal(lifecycleSave.status, 'saved')
  assert.equal(repository.saves[2].machineState, 'ready')
  assert.equal(controller.getSnapshot().saveStatus, 'saved')
  assert.ok(snapshots.some((snapshot) => snapshot.saveStatus === 'saving'))

  unsubscribe()
  await controller.destroy()
  assert.equal(repository.closeCalls, 1)
})

test('run controller applies one injected AI action through the match machine before saving', async () => {
  const initialMatch = createActiveMatch('injected-ai')
  const expected = revealOrContinue(initialMatch)
  const repository = createRepository()
  const calls = []
  const controller = createRunController({
    repository,
    initialMatch,
    aiController: {
      chooseEncounterAction(match) {
        calls.push(match)
        return REVEAL_OR_CONTINUE_ACTION
      },
    },
  })

  const result = await controller.revealOrContinue()

  assert.deepEqual(calls, [initialMatch])
  assert.deepEqual(result.match, expected.match)
  assert.deepEqual(result.event, expected.event)
  assert.equal(result.event, result.match.pendingEvent)
  assert.deepEqual(repository.saves, [expected.match])
  assert.equal(repository.saves[0], result.match)
  assert.equal(controller.currentMatch, result.match)
})

test('injected AI cannot mutate the authoritative match snapshot', async () => {
  const initialMatch = structuredClone(createActiveMatch('immutable-ai-input'))
  const expected = revealOrContinue(initialMatch)
  const repository = createRepository()
  let receivedMatch
  const controller = createRunController({
    repository,
    initialMatch,
    aiController: {
      chooseEncounterAction(match) {
        receivedMatch = match
        assert.notEqual(match, initialMatch)
        assert.ok(Object.isFrozen(match))
        assert.ok(Object.isFrozen(match.zones.sourceDeck))
        assert.throws(() => {
          match.zones.sourceDeck.pop()
        }, TypeError)
        return REVEAL_OR_CONTINUE_ACTION
      },
    },
  })

  const result = await controller.revealOrContinue()

  assert.deepEqual(receivedMatch, initialMatch)
  assert.deepEqual(result.match, expected.match)
  assert.deepEqual(repository.saves, [expected.match])
})

test('AI mutation before throwing leaves the authoritative match unchanged and unsaved', async () => {
  const initialMatch = structuredClone(createActiveMatch('immutable-ai-failure'))
  const before = structuredClone(initialMatch)
  const repository = createRepository()
  const controller = createRunController({
    repository,
    initialMatch,
    aiController: {
      chooseEncounterAction(match) {
        assert.throws(() => {
          match.rng.value = 0
        }, TypeError)
        throw new Error('AI failed after mutation attempt')
      },
    },
  })

  assert.throws(() => controller.revealOrContinue(), /AI failed after mutation attempt/)
  assert.deepEqual(initialMatch, before)
  assert.equal(controller.currentMatch, initialMatch)
  assert.deepEqual(repository.saves, [])
})

test('run controller rejects paused and ended matches before invoking injected AI', () => {
  const repository = createRepository()

  for (const [match, expectedError] of [
    [pauseMatch(createActiveMatch('paused-ai')), /paused match cannot reveal/],
    [createEndedMatch('ended-ai'), /ended match cannot reveal/],
  ]) {
    let calls = 0
    const controller = createRunController({
      repository,
      initialMatch: match,
      aiController: {
        chooseEncounterAction() {
          calls += 1
          return REVEAL_OR_CONTINUE_ACTION
        },
      },
    })

    assert.throws(() => controller.revealOrContinue(), expectedError)
    assert.equal(calls, 0)
    assert.equal(controller.currentMatch, match)
    assert.equal(controller.getSnapshot().saveStatus, 'unsaved')
  }
  assert.deepEqual(repository.saves, [])
})

test('invalid AI dependencies, actions, and failures leave the current run unchanged and unsaved', async () => {
  const repository = createRepository()
  assert.throws(
    () => createRunController({ repository, aiController: null }),
    /aiController must expose chooseEncounterAction/,
  )
  assert.throws(
    () => createRunController({ repository, aiController: {} }),
    /aiController must expose chooseEncounterAction/,
  )

  const initialMatch = createActiveMatch('atomic-ai-failure')
  const foreignInput = createActiveMatch(initialMatch.runId, 54321)
  const foreignTransition = revealOrContinue(foreignInput)
  assert.equal(foreignTransition.match.runId, initialMatch.runId)
  assert.equal(foreignTransition.match.turn, initialMatch.turn + 1)
  assert.equal(foreignTransition.event, foreignTransition.match.pendingEvent)
  assert.notDeepEqual(foreignTransition.match, revealOrContinue(initialMatch).match)

  for (const chooseEncounterAction of [
    () => {
      throw new Error('AI failed')
    },
    () => foreignTransition,
  ]) {
    const controller = createRunController({
      repository,
      initialMatch,
      aiController: { chooseEncounterAction },
    })
    assert.throws(() => controller.revealOrContinue())
    await controller.whenIdle()
    assert.equal(controller.currentMatch, initialMatch)
    assert.equal(controller.getSnapshot().saveStatus, 'unsaved')
  }
  assert.deepEqual(repository.saves, [])
})

test('AI action selection cannot overwrite a synchronously changed or destroyed run', async () => {
  for (const mutation of ['setMatch', 'pause', 'destroy']) {
    const initialMatch = createActiveMatch(`reentrant-ai-${mutation}`)
    const replacement = createActiveMatch(`replacement-${mutation}`)
    const repository = createRepository()
    let controller
    const aiController = {
      chooseEncounterAction() {
        if (mutation === 'setMatch') controller.setMatch(replacement)
        else controller[mutation]()
        return REVEAL_OR_CONTINUE_ACTION
      },
    }
    controller = createRunController({ repository, initialMatch, aiController })

    assert.throws(
      () => controller.revealOrContinue(),
      /Run changed while choosing an encounter action/,
    )
    await controller.whenIdle()

    if (mutation === 'setMatch') {
      assert.equal(controller.currentMatch, replacement)
      assert.deepEqual(repository.saves, [])
    } else if (mutation === 'pause') {
      assert.equal(controller.currentMatch.machineState, 'paused')
      assert.deepEqual(repository.saves, [controller.currentMatch])
    } else {
      assert.equal(controller.currentMatch, initialMatch)
      assert.deepEqual(repository.saves, [])
    }
  }
})

test('restore adopts ready or paused snapshots without replaying RNG', async () => {
  const ready = revealOrContinue(createActiveMatch('restored-run')).match
  const paused = pauseMatch(ready)
  const repository = createRepository({
    loadResult: {
      status: 'resumable',
      savedAt: '2026-09-21T10:15:00.000Z',
      migratedFrom: null,
      match: paused,
    },
  })
  const controller = createRunController({ repository })

  const result = await controller.restore()
  assert.equal(result.status, 'resumable')
  assert.deepEqual(controller.currentMatch, paused)
  assert.deepEqual(controller.currentMatch.rng, ready.rng)
  assert.deepEqual(controller.currentMatch.pendingEvent, ready.pendingEvent)
  assert.deepEqual(controller.getSnapshot(), {
    match: paused,
    restoreStatus: 'resumable',
    restoreReason: null,
    restoreMessage: null,
    saveStatus: 'saved',
    savedAt: '2026-09-21T10:15:00.000Z',
    saveReason: null,
  })

  const uninterrupted = revealOrContinue(ready)
  controller.resume()
  const continued = await controller.revealOrContinue()
  assert.deepEqual(continued.match, uninterrupted.match)
  assert.deepEqual(continued.event, uninterrupted.event)
})

test('invalid repository restore results degrade without an unhandled rejection', async () => {
  const repository = createRepository({
    loadResult: {
      status: 'resumable',
      savedAt: '2026-09-21T10:16:00.000Z',
      migratedFrom: null,
      match: {},
    },
  })
  const controller = createRunController({ repository })

  assert.deepEqual(await controller.restore(), {
    status: 'storage-unavailable',
    operation: 'load',
    reason: 'storage-error',
  })
  assert.equal(controller.currentMatch, null)
  assert.equal(controller.getSnapshot().restoreStatus, 'storage-unavailable')
  assert.equal(controller.getSnapshot().restoreReason, 'storage-error')
})

test('queued saves cannot let an older snapshot overwrite a newer pause', async () => {
  const writes = []
  const repository = createRepository({
    saveResult(match) {
      const write = deferred()
      writes.push({ match, ...write })
      return write.promise
    },
  })
  const controller = createRunController({
    repository,
    initialMatch: createActiveMatch('ordered-saves'),
  })

  const clashPromise = controller.revealOrContinue()
  await Promise.resolve()
  assert.equal(writes.length, 1)
  assert.equal(writes[0].match.machineState, 'ready')

  const pausePromise = controller.pause()
  assert.equal(controller.currentMatch.machineState, 'paused')
  assert.equal(controller.getSnapshot().saveStatus, 'saving')
  assert.equal(writes.length, 1)

  writes[0].resolve({
    status: 'saved',
    savedAt: '2026-09-21T10:20:00.000Z',
  })
  await clashPromise
  await Promise.resolve()
  assert.equal(writes.length, 2)
  assert.equal(writes[1].match.machineState, 'paused')
  assert.equal(controller.getSnapshot().saveStatus, 'saving')

  writes[1].resolve({
    status: 'saved',
    savedAt: '2026-09-21T10:21:00.000Z',
  })
  await pausePromise
  assert.equal(controller.getSnapshot().saveStatus, 'saved')
  assert.equal(controller.getSnapshot().savedAt, '2026-09-21T10:21:00.000Z')
})

test('storage failures are reported without discarding valid in-memory play', async () => {
  let fail = true
  const repository = createRepository({
    saveResult() {
      if (fail) {
        return {
          status: 'storage-unavailable',
          operation: 'save',
          reason: 'quota-exceeded',
        }
      }
      return {
        status: 'saved',
        savedAt: '2026-09-21T10:30:00.000Z',
      }
    },
  })
  const controller = createRunController({
    repository,
    initialMatch: createActiveMatch('failed-save'),
  })

  const paused = await controller.pause()
  assert.equal(paused.save.status, 'storage-unavailable')
  assert.equal(controller.currentMatch.machineState, 'paused')
  assert.equal(controller.getSnapshot().saveStatus, 'failed')
  assert.equal(controller.getSnapshot().saveReason, 'quota-exceeded')

  fail = false
  const retried = await controller.saveStable()
  assert.equal(retried.status, 'saved')
  assert.equal(controller.currentMatch.machineState, 'paused')
  assert.equal(controller.getSnapshot().saveStatus, 'saved')
})

test('subscriber failures cannot interrupt transitions or autosaves', async () => {
  const repository = createRepository()
  const subscriberErrors = []
  const controller = createRunController({
    repository,
    initialMatch: createActiveMatch('subscriber-failure'),
    onSubscriberError: (error) => subscriberErrors.push(error),
  })
  let deliveries = 0
  controller.subscribe(() => {
    deliveries += 1
    if (deliveries > 1) throw new Error('subscriber failed')
  })

  const paused = await controller.pause()

  assert.equal(paused.match.machineState, 'paused')
  assert.equal(paused.save.status, 'saved')
  assert.equal(repository.saves.length, 1)
  assert.ok(subscriberErrors.length > 0)
  assert.match(subscriberErrors[0].message, /subscriber failed/)
})

test('a subscriber that rejects its initial snapshot is removed', () => {
  const controller = createRunController({
    repository: createRepository(),
    initialMatch: createActiveMatch('initial-subscriber-failure'),
  })
  let deliveries = 0

  assert.throws(() => controller.subscribe(() => {
    deliveries += 1
    throw new Error('initial delivery failed')
  }), /initial delivery failed/)
  assert.doesNotThrow(() => controller.setMatch(createActiveMatch('replacement-match')))
  assert.equal(deliveries, 1)
})

test('lifecycle saves skip an absent run and invalid snapshots never enter the controller', async () => {
  const repository = createRepository()
  const controller = createRunController({ repository })

  assert.deepEqual(await controller.saveStable(), {
    status: 'skipped',
    reason: 'no-active-run',
  })
  assert.equal(repository.saves.length, 0)
  assert.throws(() => controller.pause(), /No active match/)
  assert.throws(() => controller.resume(), /No active match/)
  assert.throws(() => controller.setMatch({}), /match must contain only/)
})

test('destroy waits for queued writes and closes the repository once', async () => {
  const write = deferred()
  const repository = createRepository({
    saveResult: () => write.promise,
  })
  const controller = createRunController({
    repository,
    initialMatch: createActiveMatch('destroy-run'),
  })

  const saving = controller.saveStable()
  await Promise.resolve()
  const firstDestroy = controller.destroy()
  const secondDestroy = controller.destroy()
  assert.equal(firstDestroy, secondDestroy)
  assert.equal(repository.closeCalls, 0)
  assert.throws(() => controller.pause(), /destroyed/)

  write.resolve({
    status: 'saved',
    savedAt: '2026-09-21T10:40:00.000Z',
  })
  await saving
  await firstDestroy
  assert.equal(repository.closeCalls, 1)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createMatch,
  revealOrContinue,
} from '../../src/domain/match-machine.js'
import {
  captureCampaignHold,
  chooseCampaignReveal,
  createCampaignRun,
  getEligibleHoldTargets,
  prepareCampaignReveal,
} from '../../src/domain/campaign-machine.js'
import { BASELINE_RULESET } from '../../src/domain/ruleset.js'
import { createClashSettledEvent } from '../../src/domain/events.js'
import {
  EVENT_PRESENTATION_TIMING,
  createEventPlayer,
  createEventTimeline,
} from '../../src/presentation/event-player.js'

function transitionAt(seed, turn) {
  let match = createMatch({
    runId: `event-player-${seed}`,
    seed,
    ruleset: BASELINE_RULESET,
  })
  while (match.status === 'active') {
    const transition = revealOrContinue(match)
    match = transition.match
    if (transition.event.turn === turn) return transition
  }
  throw new Error(`Seed ${seed} ended before turn ${turn}`)
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function createSettings(values = {}) {
  let snapshot = Object.freeze({
    animationSpeed: 1,
    reducedMotion: false,
    ...values,
  })
  const subscribers = new Set()
  return {
    getSnapshot: () => snapshot,
    subscribe(subscriber) {
      subscribers.add(subscriber)
      subscriber(snapshot)
      return () => subscribers.delete(subscriber)
    },
    emit(values) {
      snapshot = Object.freeze({ ...snapshot, ...values })
      for (const subscriber of [...subscribers]) subscriber(snapshot)
    },
    get subscriberCount() {
      return subscribers.size
    },
  }
}

function createAdapter({ failStepOnce = false, failSyncOnce = false } = {}) {
  const calls = []
  let shouldFail = failStepOnce
  let shouldFailSync = failSyncOnce
  return {
    calls,
    setPaused(value) {
      calls.push(['paused', value])
    },
    beginEvent(event) {
      calls.push(['begin', event.id])
    },
    applyStep(step, context) {
      calls.push(['step', step.kind, step.cardId ?? null, context.durationMs])
      if (shouldFail) {
        shouldFail = false
        throw new Error('adapter step failed')
      }
    },
    syncSnapshot(match, context) {
      calls.push(['sync', match.pendingEvent?.id ?? null, context.reason])
      if (shouldFailSync) {
        shouldFailSync = false
        throw new Error('adapter sync failed')
      }
    },
    cancelEvent(reason) {
      calls.push(['cancel', reason])
    },
  }
}

class FakeClock {
  constructor() {
    this.time = 0
    this.nextId = 1
    this.timers = new Map()
  }

  now = () => this.time

  setTimeout = (callback, delay) => {
    const id = this.nextId
    this.nextId += 1
    this.timers.set(id, {
      callback,
      at: this.time + Math.max(0, delay),
    })
    return id
  }

  clearTimeout = (id) => {
    this.timers.delete(id)
  }

  advance(milliseconds) {
    const target = this.time + milliseconds
    while (true) {
      const due = [...this.timers]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0]
      if (!due) break
      const [id, timer] = due
      this.timers.delete(id)
      this.time = timer.at
      timer.callback()
    }
    this.time = target
  }
}

async function flushMicrotasks() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

const ZERO_TIMING = Object.freeze({
  revealMs: 0,
  settlementMs: 0,
  burnMs: 0,
})

test('timeline preserves reveal and settlement order for ties and terminal variants', () => {
  const tied = transitionAt(0, 26).event
  const tiedTimeline = createEventTimeline(tied)
  assert.deepEqual(
    tiedTimeline.slice(0, tied.reveals.length).map((step) => [
      step.kind,
      step.cardId,
      step.suppliedBy,
      step.from,
      step.round,
      step.tied,
    ]),
    tied.reveals.map((reveal, index) => [
      'reveal',
      reveal.cardId,
      reveal.suppliedBy,
      reveal.from,
      Math.floor(index / 2),
      index < 2,
    ]),
  )
  assert.deepEqual(
    tiedTimeline.slice(tied.reveals.length).map(({ kind, cardId }) => [kind, cardId]),
    tied.reveals.map(({ cardId }) => [
      tied.transfers.some((transfer) => transfer.cardId === cardId) ? 'transfer' : 'burn',
      cardId,
    ]),
  )
  assert.equal(
    tiedTimeline.reduce((total, step) => total + step.durationMs, 0),
    tied.reveals.length * EVENT_PRESENTATION_TIMING.revealMs
      + EVENT_PRESENTATION_TIMING.settlementMs
      + tied.burned.length * EVENT_PRESENTATION_TIMING.burnMs,
  )
  assert.ok(tiedTimeline.every(Object.isFrozen))

  const oneSided = transitionAt(0, 44).event
  const oneSidedTimeline = createEventTimeline(oneSided)
  assert.equal(oneSided.reveals.length % 2, 1)
  assert.deepEqual(
    oneSidedTimeline.filter(({ kind }) => kind === 'reveal').at(-1),
    {
      kind: 'reveal',
      cardId: oneSided.reveals.at(-1).cardId,
      suppliedBy: oneSided.reveals.at(-1).suppliedBy,
      from: oneSided.reveals.at(-1).from,
      revealIndex: oneSided.reveals.length - 1,
      round: Math.floor((oneSided.reveals.length - 1) / 2),
      tied: false,
      durationMs: EVENT_PRESENTATION_TIMING.revealMs,
    },
  )

  const drawn = transitionAt(93, 48).event
  const drawnTimeline = createEventTimeline(drawn)
  assert.equal(drawn.type, 'clashDrawn')
  assert.deepEqual(drawnTimeline.at(-1), {
    kind: 'retain',
    reason: 'mutualInability',
    cardIds: drawn.reveals.map(({ cardId }) => cardId),
    durationMs: 0,
  })

  assert.ok(drawnTimeline
    .filter(({ kind }) => kind === 'reveal')
    .every(({ tied }) => tied))

  const legacy = {
    ...clone(tied),
    eventVersion: 2,
    reveals: tied.reveals.map(({ cardId, suppliedBy }) => ({ cardId, suppliedBy })),
  }
  assert.ok(createEventTimeline(legacy)
    .filter(({ kind }) => kind === 'reveal')
    .every(({ from }) => from === null))
})

test('timeline does not present 2 versus Ace as a tie', () => {
  const event = createClashSettledEvent({
    runId: 'timeline-two-over-ace',
    turn: 1,
    stage: 'source',
    winner: 'player',
    reveals: [
      { cardId: 'c-2S', suppliedBy: 'player', from: 'sourceDeck' },
      { cardId: 'c-AH', suppliedBy: 'opponent', from: 'sourceDeck' },
    ],
    transfers: [{ cardId: 'c-2S', to: 'player.wonPile' }],
    burned: ['c-AH'],
    stateFingerprint: 'two-over-ace',
  })

  assert.deepEqual(
    createEventTimeline(event)
      .filter(({ kind }) => kind === 'reveal')
      .map(({ tied }) => tied),
    [false, false],
  )
})

test('player consumes detached committed data once and queues newer events in order', async () => {
  const first = transitionAt(0, 1).match
  const second = revealOrContinue(first).match
  const beforeFirst = clone(first)
  const beforeSecond = clone(second)
  const adapter = createAdapter()
  const player = createEventPlayer({
    adapter,
    timing: ZERO_TIMING,
  })

  const firstPlay = player.present(first)
  const duplicate = player.present(first)
  const secondPlay = player.present(second)
  assert.deepEqual(await firstPlay, {
    status: 'completed',
    eventId: first.pendingEvent.id,
    reason: null,
  })
  assert.deepEqual(await duplicate, await firstPlay)
  assert.equal((await secondPlay).status, 'completed')

  assert.deepEqual(
    adapter.calls.filter(([kind]) => kind === 'begin').map(([, id]) => id),
    [first.pendingEvent.id, second.pendingEvent.id],
  )
  assert.deepEqual(
    adapter.calls.filter(([kind]) => kind === 'sync').map(([, id]) => id),
    [first.pendingEvent.id, second.pendingEvent.id],
  )
  assert.deepEqual(first, beforeFirst)
  assert.deepEqual(second, beforeSecond)
  assert.equal((await player.present(second)).status, 'duplicate')
})

test('speed scales durations and a live reduced-motion change skips the active event', async () => {
  const match = transitionAt(0, 1).match
  const settings = createSettings({ animationSpeed: 2 })
  const adapter = createAdapter()
  const clock = new FakeClock()
  const states = []
  const player = createEventPlayer({
    adapter,
    settingsController: settings,
    clock,
    onStateChange: (state) => states.push(state),
  })

  const playing = player.present(match)
  await flushMicrotasks()
  const firstStep = adapter.calls.find(([kind]) => kind === 'step')
  assert.equal(firstStep[1], 'reveal')
  assert.equal(firstStep[3], EVENT_PRESENTATION_TIMING.revealMs / 2)

  clock.advance(25)
  settings.emit({ animationSpeed: 1 })
  clock.advance(349)
  await flushMicrotasks()
  assert.equal(adapter.calls.filter(([kind]) => kind === 'step').length, 1)

  settings.emit({ reducedMotion: true })
  assert.deepEqual(await playing, {
    status: 'skipped',
    eventId: match.pendingEvent.id,
    reason: 'reduced-motion',
  })
  assert.ok(adapter.calls.some(
    ([kind, reason]) => kind === 'cancel' && reason === 'reduced-motion',
  ))
  assert.ok(adapter.calls.some(
    ([kind, , reason]) => kind === 'sync' && reason === 'skipped',
  ))
  assert.equal(states.at(-1).status, 'skipped')
})

test('initial reduced motion synchronizes without starting transitional steps', async () => {
  const match = transitionAt(0, 1).match
  const adapter = createAdapter()
  const player = createEventPlayer({
    adapter,
    settingsController: createSettings({ reducedMotion: true }),
  })

  const result = await player.present(match)

  assert.equal(result.status, 'skipped')
  assert.equal(adapter.calls.some(([kind]) => kind === 'begin'), false)
  assert.equal(adapter.calls.some(([kind]) => kind === 'step'), false)
  assert.ok(adapter.calls.some(
    ([kind, id, reason]) => (
      kind === 'sync'
      && id === match.pendingEvent.id
      && reason === 'skipped'
    ),
  ))
})

test('pause freezes timing, resume continues, and explicit cancellation reconciles', async () => {
  const match = transitionAt(0, 1).match
  const adapter = createAdapter()
  const clock = new FakeClock()
  const player = createEventPlayer({ adapter, clock })

  const playing = player.present(match)
  await flushMicrotasks()
  assert.equal(adapter.calls.filter(([kind]) => kind === 'step').length, 1)

  player.setPaused(true)
  clock.advance(10_000)
  await flushMicrotasks()
  assert.equal(adapter.calls.filter(([kind]) => kind === 'step').length, 1)

  player.setPaused(false)
  clock.advance(EVENT_PRESENTATION_TIMING.revealMs)
  await flushMicrotasks()
  assert.equal(adapter.calls.filter(([kind]) => kind === 'step').length, 2)

  player.cancel('navigation')
  assert.deepEqual(await playing, {
    status: 'cancelled',
    eventId: match.pendingEvent.id,
    reason: 'navigation',
  })
  assert.deepEqual(
    adapter.calls.filter(([kind]) => kind === 'paused'),
    [['paused', false], ['paused', true], ['paused', false]],
  )
  assert.ok(adapter.calls.some(
    ([kind, , reason]) => kind === 'sync' && reason === 'cancelled',
  ))
  assert.throws(() => player.setPaused('yes'), /boolean/)
})

test('adapter failures reconcile the committed snapshot and do not block the queue', async () => {
  const first = transitionAt(0, 1).match
  const second = revealOrContinue(first).match
  const adapter = createAdapter({ failStepOnce: true })
  const errors = []
  const player = createEventPlayer({
    adapter,
    timing: ZERO_TIMING,
    onError: (error) => errors.push(error),
  })

  const failed = player.present(first)
  const continued = player.present(second)

  assert.deepEqual(await failed, {
    status: 'failed',
    eventId: first.pendingEvent.id,
    reason: 'adapter-error',
  })
  assert.equal((await continued).status, 'completed')
  assert.equal(errors.length, 1)
  assert.match(errors[0].message, /adapter step failed/)
  assert.ok(adapter.calls.some(
    ([kind, id, reason]) => (
      kind === 'sync'
      && id === first.pendingEvent.id
      && reason === 'adapter-error'
    ),
  ))
})

test('events remain retryable when adapter-error reconciliation fails', async () => {
  const match = transitionAt(0, 1).match
  const adapter = createAdapter({ failStepOnce: true, failSyncOnce: true })
  const errors = []
  const player = createEventPlayer({
    adapter,
    timing: ZERO_TIMING,
    onError: (error) => errors.push(error),
  })

  assert.deepEqual(await player.present(match), {
    status: 'failed',
    eventId: match.pendingEvent.id,
    reason: 'adapter-error',
  })
  assert.equal((await player.present(match)).status, 'completed')
  assert.deepEqual(
    adapter.calls.filter(([kind]) => kind === 'sync').map(([, id, reason]) => [id, reason]),
    [
      [match.pendingEvent.id, 'adapter-error'],
      [match.pendingEvent.id, 'completed'],
    ],
  )
  assert.equal(errors.length, 2)
  assert.match(errors[0].message, /adapter sync failed/)
  assert.match(errors[1].message, /adapter step failed/)
})

test('turn-zero snapshots deduplicate and teardown cancels pending work idempotently', async () => {
  const initial = createMatch({
    runId: 'event-player-initial',
    seed: 12345,
    ruleset: BASELINE_RULESET,
  })
  const pending = transitionAt(0, 1).match
  const settings = createSettings()
  const adapter = createAdapter()
  const clock = new FakeClock()
  const player = createEventPlayer({
    adapter,
    settingsController: settings,
    clock,
  })

  assert.equal((await player.present(initial)).status, 'synchronized')
  assert.equal((await player.present(initial)).status, 'duplicate')
  const playing = player.present(pending)
  await flushMicrotasks()
  player.destroy()
  player.destroy()

  assert.equal((await playing).status, 'cancelled')
  assert.equal(settings.subscriberCount, 0)
  assert.equal(player.getState().status, 'destroyed')
  await assert.rejects(player.present(pending), /destroyed/)
  assert.throws(() => player.cancel(''), /nonempty/)
})

test('same-turn Campaign Hold replacements synchronize distinct fingerprints', async () => {
  let campaign = createCampaignRun({
    runId: 'event-player-hold-replacement',
    seed: 0,
    ruleset: BASELINE_RULESET,
  })
  for (let turn = 0; turn < 3; turn += 1) {
    const prepared = prepareCampaignReveal(campaign)
    campaign = chooseCampaignReveal(prepared.match, 'normal').match
  }
  const targets = getEligibleHoldTargets(campaign)
  assert.equal(targets.length, 2)

  const first = captureCampaignHold(campaign, targets[0].instanceId)
  const second = captureCampaignHold(first, targets[1].instanceId)
  assert.equal(second.turn, first.turn)
  assert.equal(second.machineState, first.machineState)
  assert.notEqual(second.stateFingerprint, first.stateFingerprint)

  const adapter = createAdapter()
  const player = createEventPlayer({ adapter })
  assert.equal((await player.present(first)).status, 'synchronized')
  assert.equal((await player.present(second)).status, 'synchronized')
  assert.equal(
    adapter.calls.filter(([kind]) => kind === 'sync').length,
    2,
  )
  assert.equal((await player.present(second)).status, 'duplicate')
})

test('player validates adapters, settings, timing, and committed snapshots', async () => {
  assert.throws(() => createEventPlayer(), /adapter/)
  assert.throws(
    () => createEventPlayer({ adapter: { syncSnapshot() {}, applyStep: true } }),
    /applyStep/,
  )
  assert.throws(
    () => createEventPlayer({ adapter: createAdapter(), settingsController: {} }),
    /settingsController/,
  )
  assert.throws(
    () => createEventPlayer({ adapter: createAdapter(), timing: { revealMs: 1 } }),
    /timing/,
  )

  const player = createEventPlayer({ adapter: createAdapter() })
  await assert.rejects(player.present({}), /match must contain only/)
})

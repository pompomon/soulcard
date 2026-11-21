import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createMatch,
  revealOrContinue,
} from '../../src/domain/match-machine.js'
import {
  captureCampaignHold,
  chooseCampaignReveal,
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
import { runVisualKey } from '../../src/domain/run-state.js'
import {
  attritionFixtureRun,
  gateFightUntil,
  resolvePrepared,
  stakesDrawFixtureRun,
  stakesFixtureRun,
  startCampaign,
} from '../fixtures/campaign-route.js'

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

  const { deck, ...tiedWithoutDeck } = clone(tied)
  const legacy = {
    ...tiedWithoutDeck,
    eventVersion: 2,
    reveals: tied.reveals.map(({ cardId, suppliedBy }) => ({ cardId, suppliedBy })),
  }
  assert.ok(createEventTimeline(legacy)
    .filter(({ kind }) => kind === 'reveal')
    .every(({ from }) => from === null))
})

test('timeline does not present an upset over Ace as a tie', () => {
  for (const [deck, low] of [['standard-52', 'c-2S'], ['short-36', 'c-6S']]) {
    const event = createClashSettledEvent({
      runId: `timeline-${deck}-upset`,
      turn: 1,
      stage: 'source',
      deck,
      winner: 'player',
      reveals: [
        { cardId: low, suppliedBy: 'player', from: 'sourceDeck' },
        { cardId: 'c-AH', suppliedBy: 'opponent', from: 'sourceDeck' },
      ],
      transfers: [{ cardId: low, to: 'player.wonPile' }],
      burned: ['c-AH'],
      stateFingerprint: `${deck}-upset`,
    })

    assert.deepEqual(
      createEventTimeline(event)
        .filter(({ kind }) => kind === 'reveal')
        .map(({ tied }) => tied),
      [false, false],
      deck,
    )
  }
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
  let campaign = startCampaign({
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

// The campaign probe prices an event as reveals, one reveal for a stake, the settlement, and one
// burn for every burned or Attrition card (scripts/campaign-probe.js eventDurationMs).
function probeDurationMs(event, timing = EVENT_PRESENTATION_TIMING) {
  const settled = event.type === 'clashSettled'
  return event.reveals.length * timing.revealMs
    + (event.stakes.length > 0 ? timing.revealMs : 0)
    + (settled
      ? timing.settlementMs + (event.burned.length + event.attrition.length) * timing.burnMs
      : 0)
}

// Seed 4 stakes 7 cards a side at the gate, then ties once more before the clash settles.
function largeStakesRun(runId = 'event-player-large-stakes') {
  return gateFightUntil(4, runId, (run) => (
    run.machineState === 'ready' && run.pendingEvent.stakes.length >= 14
  ))
}

test('stake and Attrition steps follow contest order and price like the campaign probe', () => {
  const large = largeStakesRun().pendingEvent
  assert.equal(large.reveals.length, 4)
  const runs = [largeStakesRun(), stakesFixtureRun(), attritionFixtureRun(), stakesDrawFixtureRun()]
  for (const event of runs.map((run) => run.pendingEvent)) {
    const timeline = createEventTimeline(event)
    const stakeKeys = (side) => event.stakes
      .filter(({ suppliedBy }) => suppliedBy === side)
      .map(runVisualKey)
    const contest = [
      ...event.reveals.slice(0, 2),
      ...event.stakes,
      ...event.reveals.slice(2),
    ].map(runVisualKey)
    const presented = [
      ...event.reveals.slice(0, 2).map(runVisualKey),
      ...(event.stakes.length > 0 ? ['stake'] : []),
      ...event.reveals.slice(2).map(runVisualKey),
    ]
    assert.deepEqual(
      timeline.slice(0, presented.length).map((step) => (
        step.kind === 'reveal' ? step.visualKey : step.kind
      )),
      presented,
      event.id,
    )

    if (event.stakes.length > 0) {
      const stake = timeline[2]
      assert.deepEqual(
        stake.piles.map(({ side, count, visualKeys, from }) => [side, count, visualKeys, from]),
        ['player', 'opponent'].map((side) => [
          side,
          stakeKeys(side).length,
          stakeKeys(side),
          event.stakes.find(({ suppliedBy }) => suppliedBy === side).from,
        ]),
      )
      assert.equal(stake.piles[0].count, stake.piles[1].count)
      assert.equal(stake.durationMs, EVENT_PRESENTATION_TIMING.revealMs)
      assert.equal(stake.cardId, undefined)
    }

    const settlement = timeline.slice(presented.length)
    if (event.type === 'clashSettled') {
      const moves = settlement.filter(({ kind }) => kind === 'transfer' || kind === 'burn')
      assert.deepEqual(moves.flatMap((step) => step.visualKeys ?? [step.visualKey]), contest)
      for (const step of moves.filter(({ pile }) => pile === 'stake')) {
        const staked = event.stakes.filter(({ suppliedBy }) => suppliedBy === step.side)
        assert.equal(step.visualKey, `stake:${step.side}`)
        assert.equal(step.count, staked.length)
        assert.equal(step.cardId, staked.at(-1).cardId)
      }
      const attrition = settlement.filter(({ kind }) => kind === 'attrition')
      if (event.attrition.length === 0) {
        assert.deepEqual(attrition, [])
      } else {
        const loser = event.winner === 'player' ? 'opponent' : 'player'
        assert.deepEqual(settlement.at(-1), {
          kind: 'attrition',
          side: loser,
          count: event.attrition.length,
          cardId: event.attrition.at(-1).cardId,
          visualKeys: event.attrition.map(runVisualKey),
          visualKey: `attrition:${loser}`,
          from: event.attrition[0].from,
          to: 'burnPile',
          durationMs: event.attrition.length * EVENT_PRESENTATION_TIMING.burnMs,
        })
      }
    } else {
      assert.deepEqual(settlement.map(({ kind }) => kind), ['retain'])
      assert.deepEqual(settlement[0].visualKeys, contest)
    }

    const total = timeline.reduce((sum, { durationMs }) => sum + durationMs, 0)
    assert.ok(Math.abs(total - probeDurationMs(event)) < 1e-6, `${event.id} ${total}`)
  }
})

test('stake and Attrition steps scale with speed and skip under reduced motion', async () => {
  for (const run of [largeStakesRun('event-player-speed'), attritionFixtureRun()]) {
    const event = run.pendingEvent
    const timeline = createEventTimeline(event)
    const adapter = createAdapter()
    const clock = new FakeClock()
    const player = createEventPlayer({
      adapter,
      settingsController: createSettings({ animationSpeed: 2 }),
      clock,
    })
    const playing = player.present(run)
    for (let step = 0; step < timeline.length; step += 1) {
      await flushMicrotasks()
      clock.advance(10_000)
    }
    assert.equal((await playing).status, 'completed')
    assert.deepEqual(
      adapter.calls
        .filter(([kind]) => kind === 'step')
        .map(([, stepKind, , durationMs]) => [stepKind, durationMs]),
      timeline.map(({ kind, durationMs }) => [kind, durationMs / 2]),
    )
    assert.ok(adapter.calls.some(([kind, stepKind]) => (
      kind === 'step' && ['stake', 'attrition'].includes(stepKind)
    )))

    const skipped = createAdapter()
    const reduced = createEventPlayer({
      adapter: skipped,
      settingsController: createSettings({ reducedMotion: true }),
    })
    assert.equal((await reduced.present(run)).status, 'skipped')
    assert.deepEqual(
      skipped.calls.filter(([kind]) => kind !== 'paused'),
      [['sync', event.id, 'skipped']],
    )
  }
})

test('unruled, Classic, and version 5 events add no stake or Attrition steps', async () => {
  const unruled = resolvePrepared(startCampaign({
    runId: 'event-player-unruled',
    seed: 8,
    ruleset: BASELINE_RULESET,
  }))
  assert.deepEqual([unruled.event.stakes, unruled.event.attrition], [[], []])
  const legacy = clone(unruled.event)
  legacy.eventVersion = 5
  delete legacy.stakes
  delete legacy.attrition
  const classic = transitionAt(0, 26).event
  for (const event of [unruled.event, legacy, classic]) {
    const timeline = createEventTimeline(event)
    assert.ok(timeline.every(({ kind }) => ['reveal', 'transfer', 'burn', 'retain'].includes(kind)))
    assert.equal(
      timeline.reduce((sum, { durationMs }) => sum + durationMs, 0),
      event.reveals.length * EVENT_PRESENTATION_TIMING.revealMs
        + EVENT_PRESENTATION_TIMING.settlementMs
        + event.burned.length * EVENT_PRESENTATION_TIMING.burnMs,
    )
  }
  assert.deepEqual(createEventTimeline(legacy), createEventTimeline(unruled.event))

  const adapter = createAdapter()
  const player = createEventPlayer({ adapter, timing: ZERO_TIMING })
  assert.equal((await player.present(unruled.match)).status, 'completed')
  assert.deepEqual(
    adapter.calls.filter(([kind]) => kind === 'step').map(([, kind]) => kind),
    createEventTimeline(legacy).map(({ kind }) => kind),
  )
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

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CAMPAIGN_EVENT_VERSION,
  createCampaignClashSettledEvent,
  validateCampaignEvent,
} from '../../src/domain/campaign-events.js'
import { validateCommittedEvent } from '../../src/domain/events.js'
import { BASELINE_RULESET } from '../../src/domain/ruleset.js'
import { createEventTimeline } from '../../src/presentation/event-player.js'
import {
  attritionFixtureRun,
  resolvePrepared,
  stakesDrawFixtureRun,
  stakesFixtureRun,
  startCampaign,
} from '../fixtures/campaign-route.js'

test('campaign events distinguish duplicate canonical cards by instance identity', () => {
  const event = createCampaignClashSettledEvent({
    runId: 'campaign-event',
    turn: 4,
    encounterIndex: 2,
    encounterAttempt: 1,
    winner: 'player',
    reveals: [
      {
        instanceId: 'player-027',
        cardId: 'c-AS',
        suppliedBy: 'player',
        from: 'player.sourcePile',
      },
      {
        instanceId: 'opponent-3-1-001',
        cardId: 'c-AS',
        suppliedBy: 'opponent',
        from: 'opponent.sourcePile',
      },
      {
        instanceId: 'player-001',
        cardId: 'c-2D',
        suppliedBy: 'player',
        from: 'player.drawPile',
      },
      {
        instanceId: 'opponent-3-1-002',
        cardId: 'c-AH',
        suppliedBy: 'opponent',
        from: 'opponent.drawPile',
      },
    ],
    stakes: [],
    transfers: [
      { instanceId: 'player-027', to: 'player.wonPile' },
      { instanceId: 'opponent-3-1-001', to: 'player.wonPile' },
      { instanceId: 'player-001', to: 'player.wonPile' },
      { instanceId: 'opponent-3-1-002', to: 'player.wonPile' },
    ],
    burned: [],
    attrition: [],
    stateFingerprint: 'campaign-fingerprint',
  })

  assert.equal(event.eventVersion, CAMPAIGN_EVENT_VERSION)
  assert.equal(validateCampaignEvent(event), event)
  assert.equal(validateCommittedEvent(event), event)
  assert.deepEqual(
    createEventTimeline(event).filter(({ kind }) => kind === 'reveal')
      .map(({ visualKey }) => visualKey),
    [
      'player-027',
      'opponent-3-1-001',
      'player-001',
      'opponent-3-1-002',
    ],
  )

  const firstHold = structuredClone(event)
  firstHold.reveals[0].from = 'player.hold'
  assert.equal(validateCampaignEvent(firstHold), firstHold)

  const lateHold = structuredClone(event)
  lateHold.reveals[2].from = 'player.hold'
  assert.throws(
    () => validateCampaignEvent(lateHold),
    /Hold can supply only the first player reveal/,
  )
})

test('campaign event validation rejects duplicate instances and mismatched origins', () => {
  const base = {
    eventVersion: CAMPAIGN_EVENT_VERSION,
    id: 'campaign-event:clash-1',
    type: 'clashSettled',
    turn: 1,
    encounterIndex: 0,
    encounterAttempt: 1,
    winner: 'player',
    reveals: [
      {
        instanceId: 'player-1',
        cardId: 'c-KD',
        suppliedBy: 'player',
        from: 'player.sourcePile',
      },
      {
        instanceId: 'opponent-1',
        cardId: 'c-QS',
        suppliedBy: 'opponent',
        from: 'opponent.sourcePile',
      },
    ],
    stakes: [],
    transfers: [
      { instanceId: 'player-1', to: 'player.wonPile' },
      { instanceId: 'opponent-1', to: 'player.wonPile' },
    ],
    burned: [],
    attrition: [],
    stateFingerprint: 'fingerprint',
    pendingPresentation: 'settlement-v1',
  }
  const duplicate = structuredClone(base)
  duplicate.reveals[1].instanceId = 'player-1'
  duplicate.transfers[1].instanceId = 'player-1'
  assert.throws(() => validateCampaignEvent(duplicate), /more than once/)

  const wrongOrigin = structuredClone(base)
  wrongOrigin.reveals[0].from = 'opponent.sourcePile'
  assert.throws(() => validateCampaignEvent(wrongOrigin), /supplied side/)
})

test('campaign event validation rejects array index accessors without invoking them', () => {
  const event = structuredClone(createCampaignClashSettledEvent({
    runId: 'campaign-accessor',
    turn: 1,
    encounterIndex: 0,
    encounterAttempt: 1,
    winner: 'player',
    reveals: [
      {
        instanceId: 'player-1',
        cardId: 'c-KD',
        suppliedBy: 'player',
        from: 'player.sourcePile',
      },
      {
        instanceId: 'opponent-1',
        cardId: 'c-QS',
        suppliedBy: 'opponent',
        from: 'opponent.sourcePile',
      },
    ],
    stakes: [],
    transfers: [
      { instanceId: 'player-1', to: 'player.wonPile' },
      { instanceId: 'opponent-1', to: 'player.wonPile' },
    ],
    burned: [],
    attrition: [],
    stateFingerprint: 'fingerprint',
  }))
  const firstReveal = event.reveals[0]
  let invoked = false
  Object.defineProperty(event.reveals, '0', {
    enumerable: true,
    get() {
      invoked = true
      return firstReveal
    },
  })

  assert.throws(() => validateCampaignEvent(event), /dense array/)
  assert.equal(invoked, false)
})

test('campaign event validation rejects a type accessor without invoking it', () => {
  const event = structuredClone(createCampaignClashSettledEvent({
    runId: 'campaign-type-accessor',
    turn: 1,
    encounterIndex: 0,
    encounterAttempt: 1,
    winner: 'player',
    reveals: [
      {
        instanceId: 'player-1',
        cardId: 'c-KD',
        suppliedBy: 'player',
        from: 'player.sourcePile',
      },
      {
        instanceId: 'opponent-1',
        cardId: 'c-QS',
        suppliedBy: 'opponent',
        from: 'opponent.sourcePile',
      },
    ],
    stakes: [],
    transfers: [
      { instanceId: 'player-1', to: 'player.wonPile' },
      { instanceId: 'opponent-1', to: 'player.wonPile' },
    ],
    burned: [],
    attrition: [],
    stateFingerprint: 'fingerprint',
  }))
  let invoked = false
  Object.defineProperty(event, 'type', {
    enumerable: true,
    get() {
      invoked = true
      return 'clashSettled'
    },
  })

  assert.throws(() => validateCampaignEvent(event), /JSON-compatible data/)
  assert.equal(invoked, false)
})

test('version 7 events order stakes and attrition, and version 5 events carry neither', () => {
  const staked = stakesFixtureRun().pendingEvent
  const attrition = attritionFixtureRun().pendingEvent
  const drawn = stakesDrawFixtureRun().pendingEvent
  assert.equal(staked.stakes.length, 2)
  assert.deepEqual(staked.stakes.map(({ suppliedBy }) => suppliedBy), ['player', 'opponent'])
  assert.ok(attrition.attrition.length > 0)
  assert.ok(drawn.stakes.length > 0)
  for (const event of [staked, attrition, drawn]) {
    assert.equal(event.eventVersion, CAMPAIGN_EVENT_VERSION)
    assert.equal(validateCommittedEvent(event), event)
  }

  const edited = (event, edit) => {
    const copy = structuredClone(event)
    edit(copy)
    return copy
  }
  const loser = attrition.winner === 'player' ? 'opponent' : 'player'
  const cases = [
    [edited(staked, (event) => { delete event.stakes }), /event must contain only/],
    [edited(drawn, (event) => { delete event.stakes }), /event must contain only/],
    [edited(attrition, (event) => { delete event.attrition }), /event must contain only/],
    [edited(staked, (event) => { event.stakes[0].from = 'player.hold' }),
      /Hold cannot supply a stake/],
    [edited(staked, (event) => { event.reveals = event.reveals.slice(0, 1) }),
      /Stakes require a complete first reveal round/],
    [edited(staked, (event) => { event.stakes.reverse() }),
      /Stakes must be ordered player then opponent/],
    [edited(staked, (event) => { event.stakes[1].instanceId = event.reveals[1].instanceId }),
      /occurs more than once in the event/],
    [edited(staked, (event) => { event.transfers.reverse() }),
      /Settlement arrays must preserve contest order/],
    [edited(staked, (event) => { event.stakes.pop() }),
      /Settlement must contain every contested instance exactly once/],
    [edited(attrition, (event) => { event.attrition[0].from = `${attrition.winner}.drawPile` }),
      /attrition\[0\]\.from must be the loser's source or draw pile/],
    [edited(attrition, (event) => { event.attrition[0].from = `${loser}.hold` }),
      /attrition\[0\]\.from must be the loser's source or draw pile/],
    [edited(attrition, (event) => {
      event.attrition[0].instanceId = event.reveals[0].instanceId
    }), /occurs more than once in the event/],
  ]
  for (const [event, expected] of cases) {
    assert.throws(() => validateCampaignEvent(event), expected)
  }

  // A clash before the rule starts carries empty lists; without them it reads as version 5.
  const unruled = resolvePrepared(startCampaign({
    runId: 'campaign-event-unruled',
    seed: 8,
    ruleset: BASELINE_RULESET,
  })).event
  assert.deepEqual([unruled.stakes, unruled.attrition], [[], []])
  const legacy = edited(unruled, (event) => {
    event.eventVersion = 5
    delete event.stakes
    delete event.attrition
  })
  assert.equal(validateCommittedEvent(legacy), legacy)
  assert.equal(createEventTimeline(legacy).length, createEventTimeline(unruled).length)
  assert.throws(
    () => validateCampaignEvent({ ...unruled, eventVersion: 5 }),
    /event must contain only/,
  )
  assert.throws(
    () => validateCommittedEvent({ ...unruled, eventVersion: 6 }),
    /event must contain only eventVersion, id, type, turn, stage, deck/,
  )
  assert.throws(
    () => validateCampaignEvent({ ...legacy, eventVersion: 6 }),
    /eventVersion must be 5 or 7/,
  )
})

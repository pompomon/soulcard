import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CAMPAIGN_EVENT_VERSION,
  createCampaignClashSettledEvent,
  validateCampaignEvent,
} from '../../src/domain/campaign-events.js'
import { validateCommittedEvent } from '../../src/domain/events.js'
import { createEventTimeline } from '../../src/presentation/event-player.js'

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
    transfers: [
      { instanceId: 'player-027', to: 'player.wonPile' },
      { instanceId: 'opponent-3-1-001', to: 'player.wonPile' },
      { instanceId: 'player-001', to: 'player.wonPile' },
      { instanceId: 'opponent-3-1-002', to: 'player.wonPile' },
    ],
    burned: [],
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
    transfers: [
      { instanceId: 'player-1', to: 'player.wonPile' },
      { instanceId: 'opponent-1', to: 'player.wonPile' },
    ],
    burned: [],
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
    transfers: [
      { instanceId: 'player-1', to: 'player.wonPile' },
      { instanceId: 'opponent-1', to: 'player.wonPile' },
    ],
    burned: [],
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

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CAMPAIGN_NODE_EVENTS,
  getCampaignNodeEvent,
} from '../../src/domain/campaign-content.js'
import { createStarterPlayerCards, playerInstanceId } from '../../src/domain/campaign-deck.js'
import {
  HOLD_POSITION,
  chooseCampaignEventOption,
  getCampaignEventOptions,
  getCampaignEventTargets,
} from '../../src/domain/campaign-machine.js'
import {
  createModifierRecord,
  createStartingModifierRecords,
} from '../../src/domain/campaign-modifiers.js'
import { eventOptionBlocker } from '../../src/domain/campaign-node-events.js'
import { CARD_IDS } from '../../src/domain/cards.js'
import { BASELINE_RULESET } from '../../src/domain/ruleset.js'
import {
  chooseEventOption,
  chooseRoute,
  claimReward,
  holdCard,
  loseEncounter,
  passThrough,
  retryEncounter,
  routeStates,
  startCampaign,
  winEncounter,
} from '../fixtures/campaign-route.js'

function gate(runId = 'campaign-node-events') {
  return startCampaign({ runId, seed: 0, ruleset: BASELINE_RULESET })
}

// Seed 0 with player-001 (2D) held reaches the shrine with 4 health and 3 coins, and the
// vault, through the shrine and the court, with full health (5) and 7 coins.
function stageTwo({ held = true } = {}) {
  return claimReward(winEncounter(held ? holdCard(gate(), 'player-001') : gate()), 'mend')
}

function shrine(options) {
  return chooseRoute(stageTwo(options), 'shrine')
}

function vault(options) {
  const court = passThrough(stageTwo(options), 'shrine', 'court')
  return chooseRoute(claimReward(winEncounter(court), 'mend'), 'vault')
}

function option(eventId, optionId) {
  return getCampaignNodeEvent(eventId).options.find(({ id }) => id === optionId)
}

function context({
  health = 3,
  currency = 10,
  cardIds = createStarterPlayerCards().map(({ cardId }) => cardId),
  holdOccupied = true,
  activeModifiers = createStartingModifierRecords(),
  candidates = (cards) => cards,
} = {}) {
  const playerCards = cardIds.map((cardId, index) => ({
    instanceId: playerInstanceId(index + 1),
    cardId,
    campaignOwner: 'player',
  }))
  return {
    health,
    currency,
    ruleset: BASELINE_RULESET,
    activeModifiers,
    playerCards,
    targetCandidates: candidates(playerCards),
    holdOccupied,
  }
}

function optionSummary(run) {
  return getCampaignEventOptions(run).map(({ optionId, blocker }) => [optionId, blocker])
}

function playerCardIds(run) {
  return run.cards.map(({ instanceId }) => instanceId)
}

test('events state every cost and gain and end with an effect-free walk-on', () => {
  assert.deepEqual(
    CAMPAIGN_NODE_EVENTS.map(({ id, options }) => [id, options.map((entry) => [
      entry.id,
      entry.healthCost,
      entry.coinCost,
      entry.surrenderHold,
      entry.deckEdit?.kind ?? null,
      entry.modifierId,
      entry.healthGain,
      entry.coinGain,
    ])]),
    [
      ['crossroads-shrine', [
        ['bleed-for-fortune', 1, 0, false, null, null, 0, 5],
        ['burn-an-offering', 0, 0, false, 'remove', null, 2, 0],
        ['walk-on', 0, 0, false, null, null, 0, 0],
      ]],
      ['oathkeepers-vault', [
        ['surrender-held-card', 0, 0, true, null, 'hold-insight-v1', 0, 0],
        ['pay-for-a-copy', 0, 3, false, 'duplicate', null, 0, 0],
        ['walk-on', 0, 0, false, null, null, 0, 0],
      ]],
    ],
  )
})

test('event blockers name the first reason an option cannot be chosen', () => {
  const bleed = option('crossroads-shrine', 'bleed-for-fortune')
  const burn = option('crossroads-shrine', 'burn-an-offering')
  const surrender = option('oathkeepers-vault', 'surrender-held-card')
  const pay = option('oathkeepers-vault', 'pay-for-a-copy')
  const walkOn = option('oathkeepers-vault', 'walk-on')
  const minimum = CARD_IDS.slice(0, 20)
  const doubled = CARD_IDS.slice(0, 13).flatMap((cardId) => [cardId, cardId])
  const insight = [
    ...createStartingModifierRecords(),
    createModifierRecord('hold-insight-v1', 'gate'),
  ]
  const cases = [
    ['bleeding at 1 health', bleed, context({ health: 1 }), 'health-too-low'],
    ['bleeding at 2 health', bleed, context({ health: 2 }), null],
    ['health before Hold', { ...surrender, healthCost: 2 }, context({
      health: 2,
      holdOccupied: false,
    }), 'health-too-low'],
    ['surrendering an empty Hold', surrender, context({ holdOccupied: false }), 'hold-empty'],
    ['an empty Hold before the deck minimum', surrender, context({
      holdOccupied: false,
      cardIds: minimum,
    }), 'hold-empty'],
    ['surrendering at the deck minimum', surrender, context({ cardIds: minimum }), 'deck-minimum'],
    ['the deck minimum before a modifier conflict', surrender, context({
      cardIds: minimum,
      activeModifiers: insight,
    }), 'deck-minimum'],
    ['surrendering for an active modifier', surrender, context({
      activeModifiers: insight,
    }), 'modifier-conflict'],
    ['replay cannot see Hold', surrender, context({ holdOccupied: null }), null],
    ['burning at the deck minimum', burn, context({ cardIds: minimum }), 'deck-minimum'],
    ['burning with no target', burn, context({ candidates: () => [] }), 'no-eligible-card'],
    ['a copy with every card capped before price', pay, context({
      cardIds: doubled,
      currency: 0,
    }), 'no-eligible-card'],
    ['a copy into a full deck', pay, context({ cardIds: CARD_IDS.slice(0, 40) }), 'deck-full'],
    ['a copy the coins do not cover', pay, context({ currency: 2 }), 'unaffordable'],
    ['a copy the coins cover', pay, context({ currency: 3 }), null],
    ['a deck edit before a modifier', { ...burn, modifierId: 'hold-insight-v1' }, context({
      cardIds: minimum,
      activeModifiers: insight,
    }), 'deck-minimum'],
    ['a modifier before price', { ...walkOn, coinCost: 3, modifierId: 'hold-insight-v1' }, context({
      currency: 0,
      activeModifiers: insight,
    }), 'modifier-conflict'],
    ['walking on with nothing', walkOn, context({
      health: 1,
      currency: 0,
      holdOccupied: false,
      cardIds: minimum,
    }), null],
  ]
  for (const [name, candidate, decisionContext, blocker] of cases) {
    assert.equal(eventOptionBlocker(candidate, decisionContext), blocker, name)
  }

  // A health cost needs more health than it takes, so an event never ends the run.
  for (const event of CAMPAIGN_NODE_EVENTS) {
    for (const candidate of event.options) {
      for (let health = 1; health <= 5; health += 1) {
        if (eventOptionBlocker(candidate, context({ health })) === null) {
          assert.ok(health - candidate.healthCost >= 1, `${candidate.id} at ${health} health`)
        }
      }
    }
  }
})

test('shrine options apply their exact costs and gains and cap healing', () => {
  const event = shrine()
  assert.equal(event.machineState, 'awaitingEvent')
  assert.deepEqual([event.health, event.maxHealth, event.currency, event.hold], [4, 5, 3, 'player-001'])
  assert.deepEqual(optionSummary(event), [
    ['bleed-for-fortune', null],
    ['burn-an-offering', null],
    ['walk-on', null],
  ])

  const bled = chooseEventOption(event, 'bleed-for-fortune')
  assert.deepEqual([bled.health, bled.currency, bled.hold], [3, 8, 'player-001'])
  assert.deepEqual(bled.cards, event.cards)
  assert.deepEqual(bled.journal.at(-1), {
    type: 'event',
    nodeId: 'shrine',
    optionId: 'bleed-for-fortune',
    targetInstanceId: null,
    createdInstanceId: null,
  })
  assert.equal(bled.machineState, 'awaitingRoute')
  assert.equal(bled.nodeEvent, null)
  assert.deepEqual(
    [routeStates(bled).market, routeStates(bled).shrine, routeStates(bled).court, routeStates(bled).watch],
    ['bypassed', 'completed', 'available', 'available'],
  )

  const targets = getCampaignEventTargets(event, 'burn-an-offering')
    .map(({ instanceId }) => instanceId)
  assert.equal(targets.length, 25)
  assert.ok(!targets.includes('player-001'))
  assert.throws(
    () => chooseEventOption(event, 'burn-an-offering'),
    /Event target must be an eligible card in the campaign deck layout/,
  )
  assert.throws(
    () => chooseEventOption(event, 'burn-an-offering', 'player-001'),
    /Event target must be an eligible card in the campaign deck layout/,
  )
  const burned = chooseEventOption(event, 'burn-an-offering', 'player-002')
  assert.equal(burned.health, 5, 'healing 2 from 4 stops at the 5-health maximum')
  assert.equal(burned.currency, 3)
  assert.equal(burned.cards.length, 25)
  assert.ok(!playerCardIds(burned).includes('player-002'))
  assert.ok(!burned.deckLayout.includes('player-002'))
  assert.equal(burned.journal.at(-1).targetInstanceId, 'player-002')

  const walked = chooseEventOption(event, 'walk-on')
  assert.deepEqual([walked.health, walked.currency, walked.hold], [4, 3, 'player-001'])
  assert.deepEqual(walked.cards, event.cards)
  assert.deepEqual(walked.deckLayout, event.deckLayout)
  assert.deepEqual(walked.rng, event.rng)
  assert.deepEqual(walked.activeModifiers, event.activeModifiers)
  assert.throws(
    () => chooseEventOption(event, 'walk-on', 'player-002'),
    /This event option does not take a target/,
  )
})

test('bleeding is refused when its health cost would end the run', () => {
  let run = gate('campaign-node-events-low')
  run = retryEncounter(loseEncounter(run))
  run = retryEncounter(loseEncounter(run))
  assert.equal(run.health, 1)
  const event = chooseRoute(claimReward(winEncounter(run), 'new-card'), 'shrine')
  assert.equal(event.health, 1)
  assert.deepEqual(optionSummary(event), [
    ['bleed-for-fortune', 'health-too-low'],
    ['burn-an-offering', null],
    ['walk-on', null],
  ])
  assert.throws(
    () => chooseEventOption(event, 'bleed-for-fortune'),
    /Event option bleed-for-fortune is unavailable: health-too-low/,
  )
  assert.equal(chooseEventOption(event, 'walk-on').health, 1)
})

test('the vault trades the held card for Hold Insight or a copy for coins', () => {
  const event = vault()
  assert.deepEqual([event.health, event.currency, event.hold], [5, 7, 'player-001'])
  assert.deepEqual(optionSummary(event), [
    ['surrender-held-card', null],
    ['pay-for-a-copy', null],
    ['walk-on', null],
  ])
  assert.deepEqual(getCampaignEventTargets(event, 'surrender-held-card'), [
    { instanceId: 'player-001', cardId: 'c-2D' },
  ])
  assert.deepEqual(getCampaignEventTargets(event, 'walk-on'), [])
  assert.throws(() => getCampaignEventTargets(event, 'pray'), /not part of the open event/)
  const copyTargets = getCampaignEventTargets(event, 'pay-for-a-copy')
    .map(({ instanceId }) => instanceId)
  assert.equal(copyTargets.length, 25)
  assert.ok(!copyTargets.includes('player-001'))

  for (const target of [null, 'player-002']) {
    assert.throws(
      () => chooseEventOption(event, 'surrender-held-card', target),
      /Surrendering Hold must name the held card/,
    )
  }
  const surrendered = chooseEventOption(event, 'surrender-held-card', 'player-001')
  assert.equal(surrendered.hold, null)
  assert.equal(surrendered.cards.length, 25)
  assert.ok(!playerCardIds(surrendered).includes('player-001'))
  assert.ok(!surrendered.deckLayout.includes('player-001'))
  assert.ok(!surrendered.deckLayout.includes(HOLD_POSITION))
  assert.deepEqual(surrendered.activeModifiers.at(-1), {
    id: 'hold-insight-v1',
    lifetime: 'campaign',
    grantedAtNodeId: 'vault',
  })
  assert.deepEqual([surrendered.health, surrendered.currency], [5, 7])
  assert.deepEqual(surrendered.journal.at(-1), {
    type: 'event',
    nodeId: 'vault',
    optionId: 'surrender-held-card',
    targetInstanceId: 'player-001',
    createdInstanceId: null,
  })

  assert.throws(
    () => chooseEventOption(event, 'pay-for-a-copy', 'player-001'),
    /Event target must be an eligible card in the campaign deck layout/,
  )
  const paid = chooseEventOption(event, 'pay-for-a-copy', 'player-002')
  const copied = event.cards.find(({ instanceId }) => instanceId === 'player-002').cardId
  assert.equal(paid.currency, 4)
  assert.equal(paid.hold, 'player-001')
  assert.deepEqual(paid.cards.at(-1), {
    instanceId: 'player-027',
    cardId: copied,
    campaignOwner: 'player',
  })
  assert.equal(paid.deckLayout.at(-1), 'player-027')
  assert.equal(paid.journal.at(-1).createdInstanceId, 'player-027')

  const empty = vault({ held: false })
  assert.equal(empty.hold, null)
  assert.deepEqual(optionSummary(empty)[0], ['surrender-held-card', 'hold-empty'])
  assert.deepEqual(getCampaignEventTargets(empty, 'surrender-held-card'), [])
  assert.throws(
    () => chooseEventOption(empty, 'surrender-held-card'),
    /Event option surrender-held-card is unavailable: hold-empty/,
  )
})

test('event decisions refuse unknown options, other nodes, stale steps, and closed events', () => {
  const event = shrine()
  const step = event.journal.length
  const decision = (overrides = {}) => ({
    nodeId: 'shrine',
    step,
    optionId: 'walk-on',
    targetInstanceId: null,
    ...overrides,
  })
  for (const [selection, message] of [
    [decision({ optionId: 'pray' }), /Event option is not part of the open event/],
    [decision({ nodeId: 'market' }), /Route node market is not the active node/],
    [decision({ nodeId: 'vault' }), /Route node vault is not the active node/],
    [decision({ step: step - 1 }), /stale/],
    [decision({ step: step + 1 }), /stale/],
    [{ nodeId: 'shrine', step, optionId: 'walk-on' }, /must contain only/],
    [decision({ targetInstanceId: 'player-002' }), /This event option does not take a target/],
  ]) {
    assert.throws(() => chooseCampaignEventOption(event, selection), message)
  }

  const walked = chooseCampaignEventOption(event, decision())
  assert.equal(walked.machineState, 'awaitingRoute')
  assert.throws(
    () => chooseCampaignEventOption(walked, decision({ step: walked.journal.length })),
    /Campaign is not at an event/,
  )
  assert.throws(() => chooseCampaignEventOption(walked, decision()), /Campaign is not at an event/)
  assert.deepEqual(getCampaignEventOptions(walked), [])
  assert.deepEqual(getCampaignEventTargets(walked, 'walk-on'), [])
})

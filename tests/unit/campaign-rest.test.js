import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CAMPAIGN_MAX_HEALTH,
  CAMPAIGN_NODE_HEAL_LIMIT,
  CAMPAIGN_REST_SITES,
  getCampaignRestSite,
} from '../../src/domain/campaign-content.js'
import { createStarterPlayerCards, playerInstanceId } from '../../src/domain/campaign-deck.js'
import { replayCampaignJournal } from '../../src/domain/campaign-journal.js'
import {
  chooseCampaignRestOption,
  getCampaignRestOptions,
  getCampaignRestTargets,
  validateCampaignState,
} from '../../src/domain/campaign-machine.js'
import { CAMPAIGN_MAP } from '../../src/domain/campaign-map.js'
import { createStartingModifierRecords } from '../../src/domain/campaign-modifiers.js'
import { eventOptionBlocker } from '../../src/domain/campaign-node-events.js'
import { CARD_IDS } from '../../src/domain/cards.js'
import { BASELINE_RULESET } from '../../src/domain/ruleset.js'
import {
  chooseEventOption,
  chooseRestOption,
  chooseRoute,
  claimReward,
  clone,
  holdCard,
  loseEncounter,
  passThrough,
  refingerprint,
  retryEncounter,
  routeStates,
  startCampaign,
  winEncounter,
} from '../fixtures/campaign-route.js'

function gate(seed = 0) {
  return startCampaign({ runId: 'campaign-rest', seed, ruleset: BASELINE_RULESET })
}

// The route map after the court, through the shrine. Seed 0 with Mend at both fights has
// full health (5) and 7 coins; a lost gate attempt leaves 4, or 2 when both rewards are new
// cards instead.
function beforeCamp({ held = false, lost = false, rewards = ['mend', 'mend'], seed = 0, gateTarget = null } = {}) {
  let run = held ? holdCard(gate(seed), 'player-001') : gate(seed)
  if (lost) run = retryEncounter(loseEncounter(run))
  run = claimReward(winEncounter(run), rewards[0], gateTarget)
  run = passThrough(run, 'shrine', 'court')
  return claimReward(winEncounter(run), rewards[1])
}

function camp(options) {
  return chooseRoute(beforeCamp(options), 'camp')
}

// The route map after walking on at the camp and taking Mend at the watch.
function beforeSanctum(options) {
  const watch = chooseRoute(chooseRestOption(camp(options), 'walk-on'), 'watch')
  return claimReward(winEncounter(watch), 'mend')
}

function sanctum(options) {
  return chooseRoute(beforeSanctum(options), 'sanctum')
}

function option(siteId, optionId) {
  return getCampaignRestSite(siteId).options.find(({ id }) => id === optionId)
}

function context({
  health = 3,
  cardIds = createStarterPlayerCards().map(({ cardId }) => cardId),
  candidates = (cards) => cards,
} = {}) {
  const playerCards = cardIds.map((cardId, index) => ({
    instanceId: playerInstanceId(index + 1),
    cardId,
    campaignOwner: 'player',
  }))
  return {
    health,
    currency: 0,
    ruleset: BASELINE_RULESET,
    activeModifiers: createStartingModifierRecords(),
    playerCards,
    targetCandidates: candidates(playerCards),
    holdOccupied: false,
  }
}

function optionSummary(run) {
  return getCampaignRestOptions(run).map(({ optionId, blocker }) => [optionId, blocker])
}

function targetIds(run, optionId) {
  return getCampaignRestTargets(run, optionId).map(({ instanceId }) => instanceId)
}

function playerCards(run) {
  return run.cards.filter(({ campaignOwner }) => campaignOwner === 'player')
}

function restEntry(nodeId, optionId, targetInstanceId = null, createdInstanceId = null) {
  return { type: 'rest', nodeId, optionId, targetInstanceId, createdInstanceId }
}

// A rest decision journals one entry, and replaying the journal rebuilds the live run.
function assertReplays(run) {
  const replayed = replayCampaignJournal({
    seed: run.rng.seed,
    ruleset: run.ruleset,
    journal: run.journal,
  })
  assert.equal(replayed.phase, 'route')
  assert.equal(replayed.activeNodeId, null)
  assert.deepEqual(replayed.routeNodes, run.route.nodes)
  assert.deepEqual(replayed.playerCards, playerCards(run))
  assert.equal(replayed.health, run.health)
  assert.equal(replayed.currency, run.currency)
  assert.deepEqual(replayed.activeModifiers, run.activeModifiers)
}

test('rest sites offer cost-free healing or a deck edit and end with Walk on', () => {
  assert.deepEqual(
    CAMPAIGN_REST_SITES.map(({ id, options }) => [id, options.map((entry) => [
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
      ['roadside-camp', [
        ['rest', 0, 0, false, null, null, 2, 0],
        ['train', 0, 0, false, 'duplicate', null, 0, 0],
        ['walk-on', 0, 0, false, null, null, 0, 0],
      ]],
      ['last-light-sanctum', [
        ['rest', 0, 0, false, null, null, 2, 0],
        ['cleanse', 0, 0, false, 'remove', null, 0, 0],
        ['walk-on', 0, 0, false, null, null, 0, 0],
      ]],
    ],
  )
  assert.deepEqual(
    CAMPAIGN_MAP.nodes
      .filter(({ kind }) => kind === 'rest')
      .map(({ id, stage, contentId }) => [id, stage, contentId]),
    [['camp', 4, 'roadside-camp'], ['sanctum', 6, 'last-light-sanctum']],
  )
  for (const site of CAMPAIGN_REST_SITES) {
    for (const entry of site.options) {
      assert.ok(entry.healthGain <= CAMPAIGN_NODE_HEAL_LIMIT, `${site.id} ${entry.id} heal limit`)
      assert.equal(entry.deckEdit?.cardId ?? null, null)
    }
  }
})

test('rest blockers come only from the deck limits and never from health', () => {
  const rest = option('roadside-camp', 'rest')
  const train = option('roadside-camp', 'train')
  const cleanse = option('last-light-sanctum', 'cleanse')
  const walkOn = option('last-light-sanctum', 'walk-on')
  const minimum = CARD_IDS.slice(0, 20)
  const doubled = CARD_IDS.slice(0, 13).flatMap((cardId) => [cardId, cardId])
  const cases = [
    ['resting at 1 health', rest, context({ health: 1 }), null],
    ['resting at full health', rest, context({ health: CAMPAIGN_MAX_HEALTH }), null],
    ['training a starter deck', train, context(), null],
    ['training into a full deck', train, context({ cardIds: CARD_IDS.slice(0, 40) }), 'deck-full'],
    ['training with every card at the copy limit', train, context({ cardIds: doubled }),
      'no-eligible-card'],
    ['training with one card below the copy limit', train, context({
      cardIds: [...doubled, 'c-2C'],
    }), null],
    ['training with no target', train, context({ candidates: () => [] }), 'no-eligible-card'],
    ['cleansing at the deck minimum', cleanse, context({ cardIds: minimum }), 'deck-minimum'],
    ['cleansing above the deck minimum', cleanse, context({ cardIds: CARD_IDS.slice(0, 21) }), null],
    ['cleansing with no target', cleanse, context({ candidates: () => [] }), 'no-eligible-card'],
    ['walking on with nothing', walkOn, context({ health: 1, cardIds: minimum }), null],
  ]
  for (const [name, candidate, decisionContext, blocker] of cases) {
    assert.equal(eventOptionBlocker(candidate, decisionContext), blocker, name)
  }
})

test('entering a rest site opens its options without drawing RNG', () => {
  for (const [nodeId, siteId, before, deckOption] of [
    ['camp', 'roadside-camp', beforeCamp(), 'train'],
    ['sanctum', 'last-light-sanctum', beforeSanctum(), 'cleanse'],
  ]) {
    assert.equal(before.machineState, 'awaitingRoute')
    assert.equal(routeStates(before)[nodeId], 'available')
    const run = chooseRoute(before, nodeId)
    assert.deepEqual(run.rng, before.rng)
    assert.deepEqual(run.cards, before.cards)
    assert.deepEqual(run.deckLayout, before.deckLayout)
    assert.deepEqual(run.activeModifiers, before.activeModifiers)
    assert.deepEqual([run.health, run.currency], [before.health, before.currency])
    assert.equal(run.machineState, 'awaitingRest')
    assert.deepEqual(run.restSite, { nodeId, siteId })
    assert.equal(routeStates(run)[nodeId], 'active')
    assert.deepEqual(run.journal.at(-1), { type: 'route', nodeId })
    assert.equal(run.encounter, null)
    assert.equal(run.shop, null)
    assert.equal(run.nodeEvent, null)
    assert.equal(run.pendingReward, null)
    assert.deepEqual(optionSummary(run), [['rest', null], [deckOption, null], ['walk-on', null]])
    assert.deepEqual(getCampaignRestOptions(run)[0], {
      optionId: 'rest',
      label: getCampaignRestSite(siteId).options[0].label,
      healthCost: 0,
      coinCost: 0,
      surrenderHold: false,
      deckEdit: null,
      modifierId: null,
      healthGain: 2,
      coinGain: 0,
      blocker: null,
    })
    assert.deepEqual(getCampaignRestTargets(run, 'rest'), [])
    assert.deepEqual(getCampaignRestTargets(run, 'walk-on'), [])
    assert.throws(() => getCampaignRestTargets(run, 'pray'), /Rest option is not part of the open rest site/)
    assert.deepEqual(validateCampaignState(clone(run)), clone(run))
  }
})

test('resting heals two up to the maximum and is allowed at full health', () => {
  const hurt = camp({ lost: true, rewards: ['new-card', 'new-card'] })
  assert.deepEqual([hurt.health, hurt.maxHealth, hurt.currency], [2, CAMPAIGN_MAX_HEALTH, 7])
  const rested = chooseRestOption(hurt, 'rest')
  assert.equal(rested.health, 4)
  assert.equal(rested.currency, 7)
  assert.deepEqual(rested.cards, hurt.cards)
  assert.deepEqual(rested.deckLayout, hurt.deckLayout)
  assert.deepEqual(rested.rng, hurt.rng)
  assert.deepEqual(rested.journal.at(-1), restEntry('camp', 'rest'))
  assert.equal(rested.machineState, 'awaitingRoute')
  assert.equal(rested.restSite, null)
  assertReplays(rested)

  const bruised = camp({ lost: true })
  assert.equal(bruised.health, 4)
  assert.equal(chooseRestOption(bruised, 'rest').health, CAMPAIGN_MAX_HEALTH, 'healing 2 from 4 stops at 5')

  const full = camp()
  assert.equal(full.health, CAMPAIGN_MAX_HEALTH)
  const idle = chooseRestOption(full, 'rest')
  assert.equal(idle.health, CAMPAIGN_MAX_HEALTH)
  assert.deepEqual(idle.journal.at(-1), restEntry('camp', 'rest'))
  assert.equal(routeStates(idle).camp, 'completed')
  assertReplays(idle)

  const sanctumRest = chooseRestOption(sanctum({ lost: true, rewards: ['new-card', 'new-card'] }), 'rest')
  assert.equal(sanctumRest.health, 5, 'the watch Mend gives 3, and the sanctum rest gives 5')
  assert.deepEqual(sanctumRest.journal.at(-1), restEntry('sanctum', 'rest'))
  assertReplays(sanctumRest)
})

test('training copies an eligible card and cleansing removes one, never the held card', () => {
  const held = camp({ held: true })
  assert.equal(held.hold, 'player-001')
  const trainTargets = targetIds(held, 'train')
  assert.equal(trainTargets.length, 25)
  assert.ok(!trainTargets.includes('player-001'))
  const trained = chooseRestOption(held, 'train', 'player-002')
  const copied = held.cards.find(({ instanceId }) => instanceId === 'player-002').cardId
  assert.deepEqual(trained.cards.at(-1), {
    instanceId: 'player-027',
    cardId: copied,
    campaignOwner: 'player',
  })
  assert.equal(trained.deckLayout.at(-1), 'player-027')
  assert.equal(trained.hold, 'player-001')
  assert.deepEqual([trained.health, trained.currency], [held.health, held.currency])
  assert.deepEqual(trained.journal.at(-1), restEntry('camp', 'train', 'player-002', 'player-027'))
  assertReplays(trained)

  // Seed 1 drafts a duplicate at the gate, so both copies of its target are at the copy
  // limit and neither can be trained.
  const duplicated = camp({ seed: 1, rewards: ['deck-edit', 'mend'], gateTarget: 'player-002' })
  const capped = duplicated.cards
    .filter(({ cardId }) => cardId === duplicated.cards[1].cardId)
    .map(({ instanceId }) => instanceId)
  assert.deepEqual(capped, ['player-002', 'player-027'])
  const cappedTargets = targetIds(duplicated, 'train')
  assert.equal(cappedTargets.length, 25)
  assert.ok(capped.every((instanceId) => !cappedTargets.includes(instanceId)))
  assert.throws(
    () => chooseRestOption(duplicated, 'train', 'player-027'),
    /Rest target must be an eligible card in the campaign deck layout/,
  )
  assert.equal(chooseRestOption(duplicated, 'train', 'player-003').cards.at(-1).instanceId, 'player-028')

  const rite = sanctum({ held: true })
  const cleanseTargets = targetIds(rite, 'cleanse')
  assert.equal(cleanseTargets.length, 25)
  assert.ok(!cleanseTargets.includes('player-001'))
  for (const target of [null, 'player-001', 'player-099']) {
    assert.throws(
      () => chooseRestOption(rite, 'cleanse', target),
      /Rest target must be an eligible card in the campaign deck layout/,
    )
  }
  const cleansed = chooseRestOption(rite, 'cleanse', 'player-002')
  assert.equal(cleansed.cards.length, 25)
  assert.ok(!cleansed.cards.some(({ instanceId }) => instanceId === 'player-002'))
  assert.ok(!cleansed.deckLayout.includes('player-002'))
  assert.equal(cleansed.hold, 'player-001')
  assert.deepEqual(cleansed.journal.at(-1), restEntry('sanctum', 'cleanse', 'player-002'))
  assert.deepEqual(routeStates(cleansed).finale, 'available')
  assertReplays(cleansed)
})

test('walking on changes nothing but the journal and the route', () => {
  const run = camp({ held: true })
  const walked = chooseRestOption(run, 'walk-on')
  for (const key of ['cards', 'deckLayout', 'rng', 'activeModifiers', 'health', 'currency', 'hold']) {
    assert.deepEqual(walked[key], run[key], key)
  }
  assert.deepEqual(walked.journal, [...run.journal, restEntry('camp', 'walk-on')])
  assert.equal(walked.machineState, 'awaitingRoute')
  assert.equal(walked.restSite, null)
  assert.deepEqual(
    ['bazaar', 'vault', 'camp', 'watch', 'night-watch', 'sanctum']
      .map((nodeId) => routeStates(walked)[nodeId]),
    ['bypassed', 'bypassed', 'completed', 'available', 'available', 'locked'],
  )
  assertReplays(walked)
  assert.throws(
    () => chooseRestOption(run, 'walk-on', 'player-002'),
    /This rest option does not take a target/,
  )
})

test('rest decisions refuse unknown options, other nodes, stale steps, and closed sites', () => {
  const run = camp()
  const step = run.journal.length
  const decision = (overrides = {}) => ({
    nodeId: 'camp',
    step,
    optionId: 'walk-on',
    targetInstanceId: null,
    ...overrides,
  })
  for (const [selection, message] of [
    [decision({ optionId: 'pray' }), /Rest option is not part of the open rest site/],
    [decision({ optionId: 'cleanse', targetInstanceId: 'player-002' }), /Rest option is not part of the open rest site/],
    [decision({ optionId: 'bleed-for-fortune' }), /Rest option is not part of the open rest site/],
    [decision({ nodeId: 'sanctum' }), /Route node sanctum is not the active node/],
    [decision({ nodeId: 'vault' }), /Route node vault is not the active node/],
    [decision({ step: step - 1 }), /stale/],
    [decision({ step: step + 1 }), /stale/],
    [{ nodeId: 'camp', step, optionId: 'walk-on' }, /must contain only/],
    [decision({ optionId: 'rest', targetInstanceId: 'player-002' }), /This rest option does not take a target/],
    [decision({ optionId: 'train' }), /Rest target must be an eligible card in the campaign deck layout/],
    [decision({ optionId: 'train', targetInstanceId: 'opponent-1-1-001' }), /Rest target must be an eligible card/],
  ]) {
    assert.throws(() => chooseCampaignRestOption(run, selection), message)
  }

  const walked = chooseCampaignRestOption(run, decision())
  assert.equal(walked.machineState, 'awaitingRoute')
  assert.throws(
    () => chooseCampaignRestOption(walked, decision({ step: walked.journal.length })),
    /Campaign is not at a rest site/,
  )
  assert.throws(() => chooseCampaignRestOption(walked, decision()), /Campaign is not at a rest site/)
  assert.deepEqual(getCampaignRestOptions(walked), [])
  assert.deepEqual(getCampaignRestTargets(walked, 'train'), [])

  const shrine = chooseRoute(claimReward(winEncounter(gate()), 'mend'), 'shrine')
  assert.equal(shrine.machineState, 'awaitingEvent')
  assert.throws(
    () => chooseCampaignRestOption(shrine, {
      nodeId: 'shrine',
      step: shrine.journal.length,
      optionId: 'walk-on',
      targetInstanceId: null,
    }),
    /Campaign is not at a rest site/,
  )
  assert.deepEqual(getCampaignRestOptions(shrine), [])
  assert.equal(chooseEventOption(shrine, 'walk-on').machineState, 'awaitingRoute')
})

test('replay reproduces every rest entry and refuses unknown entry types', () => {
  const site = camp({ held: true })
  for (const [optionId, target] of [['rest', null], ['train', 'player-005'], ['walk-on', null]]) {
    assertReplays(chooseRestOption(site, optionId, target))
  }
  const rite = sanctum({ held: true })
  for (const [optionId, target] of [['rest', null], ['cleanse', 'player-005'], ['walk-on', null]]) {
    assertReplays(chooseRestOption(rite, optionId, target))
  }
  const step = site.journal.length
  assert.throws(
    () => replayCampaignJournal({
      seed: 0,
      ruleset: BASELINE_RULESET,
      journal: [...site.journal, { type: 'teleport', nodeId: 'camp' }],
    }),
    new RegExp(`Campaign journal entry ${step} has an unknown entry type: teleport`),
  )
})

test('a tampered rest site fails validation', () => {
  const run = camp()
  const walked = chooseRestOption(run, 'walk-on')
  const shrine = chooseRoute(claimReward(winEncounter(gate()), 'mend'), 'shrine')
  for (const [base, mutate, message] of [
    [run, (state) => { state.restSite.nodeId = 'sanctum' }, /campaign\.restSite\.nodeId must match the active route node/],
    [run, (state) => { state.restSite.siteId = 'last-light-sanctum' }, /campaign\.restSite\.siteId must match the active route node/],
    [run, (state) => { state.restSite = null }, /campaign\.restSite must be a plain object/],
    [run, (state) => { state.restSite = [] }, /campaign\.restSite must be a plain object/],
    [run, (state) => { state.restSite.note = 1 }, /campaign\.restSite must contain only nodeId, siteId/],
    [run, (state) => { delete state.restSite }, /restSite/],
    [walked, (state) => { state.restSite = { nodeId: 'camp', siteId: 'roadside-camp' } },
      /A rest site is allowed only while a rest site is open/],
    [shrine, (state) => {
      state.machineState = 'awaitingRest'
      state.restSite = { nodeId: 'shrine', siteId: 'crossroads-shrine' }
    }, /Campaign machine state must match the route position implied by the journal/],
  ]) {
    const forged = clone(base)
    mutate(forged)
    refingerprint(forged)
    assert.throws(() => validateCampaignState(forged), message)
  }
  assert.deepEqual(validateCampaignState(clone(run)), clone(run))
})

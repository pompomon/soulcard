import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createAutoRevealCoordinator } from '../../src/app/auto-reveal-coordinator.js'
import { createRunController } from '../../src/app/run-controller.js'
import {
  CAMPAIGN_GAME_RULES_VERSION,
  CAMPAIGN_VERSION,
  chooseCampaignReveal,
  createCampaignRun,
  createCampaignStateFingerprint,
  getCampaignRestTargets,
  getCampaignShopOffers,
  getCampaignShopTargets,
  prepareCampaignReveal,
} from '../../src/domain/campaign-machine.js'
import { CAMPAIGN_MEND_HEALTH_BY_TIER } from '../../src/domain/campaign-content.js'
import { getCampaignMapNode, getCampaignNodeContent } from '../../src/domain/campaign-map.js'
import { BASELINE_RULESET } from '../../src/domain/ruleset.js'
import {
  SAVE_SCHEMA_VERSION,
  createRunSave,
  restoreRunSave,
  validateRunSave,
} from '../../src/persistence/run-schema.js'
import {
  CAMPAIGN_SAVE_FIXTURES,
  EXPEDITION_PLANS,
  activeNodeId,
  bossFixtureRun,
  buyShopItem,
  chooseEventOption,
  chooseRestOption,
  chooseRoute,
  claimReward,
  createExpeditionCounters,
  eliteRewardFixtureRun,
  exhaustedShopFixtureRun,
  informedFixtureRun,
  leaveShop,
  loseEncounter,
  passThrough,
  restFixtureRun,
  retryEncounter,
  rewardFixtureRun,
  routeFixtureRun,
  routeStates,
  shopFixtureRun,
  startCampaign,
  stepExpedition,
  victoryFixtureRun,
  winEncounter,
} from '../fixtures/campaign-route.js'

const SAVED_AT = '2026-09-25T04:00:00.000Z'
const FIXTURE_ROOT = new URL('../fixtures/', import.meta.url)

function fixture(name) {
  return JSON.parse(readFileSync(new URL(name, FIXTURE_ROOT), 'utf8'))
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function campaign(seed = 27, runId = 'campaign-persistence') {
  return startCampaign({
    runId,
    seed,
    ruleset: BASELINE_RULESET,
  })
}

function roundTrip(run) {
  return restoreRunSave(clone(createRunSave(run, { savedAt: SAVED_AT })))
}

function refingerprintSave(save) {
  const state = {
    mode: 'campaign',
    runId: save.runId,
    ruleset: save.ruleset,
    rng: save.rng,
    pendingEvent: save.pendingEvent,
    ...save.match,
  }
  save.match.stateFingerprint = createCampaignStateFingerprint(state)
  if (save.pendingEvent !== null) save.pendingEvent.stateFingerprint = save.match.stateFingerprint
  return save
}

test('campaign saves use schema v7 and campaign rules v7 and restore exactly', () => {
  const map = createCampaignRun({
    runId: 'campaign-persistence-map',
    seed: 27,
    ruleset: BASELINE_RULESET,
  })
  const mapSave = createRunSave(map, { savedAt: SAVED_AT })
  assert.equal(SAVE_SCHEMA_VERSION, 7)
  assert.equal(CAMPAIGN_GAME_RULES_VERSION, 7)
  assert.equal(CAMPAIGN_VERSION, 4)
  assert.equal(mapSave.saveSchemaVersion, SAVE_SCHEMA_VERSION)
  assert.equal(mapSave.runType, 'campaign')
  assert.equal(mapSave.gameRulesVersion, CAMPAIGN_GAME_RULES_VERSION)
  assert.equal(mapSave.match.campaignVersion, CAMPAIGN_VERSION)
  assert.equal(mapSave.match.machineState, 'awaitingRoute')
  assert.equal(mapSave.match.encounter, null)
  assert.equal(mapSave.match.currency, 0)
  assert.deepEqual(mapSave.match.journal, [])
  assert.deepEqual(mapSave.match.route.nodes.map(({ state }) => state), [
    'available',
    ...Array(11).fill('locked'),
  ])
  assert.deepEqual(Object.keys(mapSave.match).slice(-7), [
    'holdChoice',
    'pendingReward',
    'shop',
    'nodeEvent',
    'restSite',
    'journal',
    'stateFingerprint',
  ])
  assert.equal(mapSave.match.restSite, null)
  assert.equal(validateRunSave(mapSave), mapSave)
  assert.deepEqual(restoreRunSave(clone(mapSave)), map)

  const run = campaign()
  const save = createRunSave(run, { savedAt: SAVED_AT })
  assert.deepEqual(save.match.journal, [{ type: 'route', nodeId: 'gate' }])
  assert.equal(save.match.machineState, 'ready')
  assert.notDeepEqual(save.rng, map.rng)
  assert.deepEqual(restoreRunSave(clone(save)), run)
})

test('campaign v7 fixtures regenerate exactly and restore their stable states', () => {
  assert.equal(CAMPAIGN_SAVE_FIXTURES.length, 12)
  for (const [name, build] of CAMPAIGN_SAVE_FIXTURES) {
    const run = build()
    const save = createRunSave(run, { savedAt: SAVED_AT })
    assert.deepEqual(save, fixture(name), name)
    assert.deepEqual(restoreRunSave(fixture(name)), run, name)
  }

  const reward = fixture('campaign-save-reward-v7.json')
  assert.equal(reward.match.machineState, 'awaitingReward')
  assert.deepEqual(reward.match.pendingReward.offers.map(({ offerId }) => offerId), [
    'new-card',
    'deck-edit',
    'modifier',
    'mend',
  ])
  assert.equal(reward.match.pendingReward.offers[2].modifierId, 'hold-insight-v1')

  const route = fixture('campaign-save-route-v7.json')
  assert.equal(route.match.machineState, 'awaitingRoute')
  assert.equal(route.match.encounter, null)
  assert.equal(route.match.currency, 3)
  assert.equal(route.match.encounterIndex, 1)
  assert.deepEqual(route.match.journal.map(({ type }) => type), ['route', 'reward'])
  assert.deepEqual(routeStates(restoreRunSave(route)), {
    gate: 'completed',
    market: 'available',
    shrine: 'available',
    court: 'locked',
    'high-court': 'locked',
    bazaar: 'locked',
    vault: 'locked',
    camp: 'locked',
    watch: 'locked',
    'night-watch': 'locked',
    sanctum: 'locked',
    finale: 'locked',
  })

  const shop = fixture('campaign-save-shop-v7.json')
  assert.equal(shop.match.machineState, 'awaitingShop')
  assert.equal(shop.match.shop.nodeId, 'market')
  assert.deepEqual(shop.match.shop.items.map(({ itemId, kind, price, sold }) => (
    [itemId, kind, price, sold]
  )), [
    ['card-1', 'add', 3, false],
    ['service-1', 'replace', 2, false],
    ['modifier-1', 'modifier', 4, false],
  ])

  const exhausted = fixture('campaign-save-shop-exhausted-v7.json')
  assert.equal(exhausted.match.machineState, 'awaitingShop')
  assert.equal(exhausted.match.shop.nodeId, 'bazaar')
  assert.equal(exhausted.match.currency, 0)
  assert.equal(exhausted.match.encounter, null)
  assert.deepEqual(exhausted.match.shop.items.map(({ itemId, kind, price, sold }) => (
    [itemId, kind, price, sold]
  )), [
    ['card-1', 'add', 3, true],
    ['card-2', 'add', 3, true],
    ['service-1', 'remove', 2, true],
    ['modifier-1', 'modifier', 4, true],
  ])
  assert.deepEqual(exhausted.match.journal.map(({ type, nodeId }) => `${type}:${nodeId}`), [
    'route:gate',
    'reward:gate',
    'route:shrine',
    'event:shrine',
    'route:court',
    'reward:court',
    'route:bazaar',
    'purchase:bazaar',
    'purchase:bazaar',
    'purchase:bazaar',
    'purchase:bazaar',
  ])
  assert.equal(exhausted.match.journal[3].optionId, 'bleed-for-fortune')
  assert.deepEqual(routeStates(restoreRunSave(exhausted)), {
    gate: 'completed',
    market: 'bypassed',
    shrine: 'completed',
    court: 'completed',
    'high-court': 'bypassed',
    bazaar: 'active',
    vault: 'bypassed',
    camp: 'bypassed',
    watch: 'locked',
    'night-watch': 'locked',
    sanctum: 'locked',
    finale: 'locked',
  })

  const event = fixture('campaign-save-event-v7.json')
  assert.equal(event.match.machineState, 'awaitingEvent')
  assert.deepEqual(event.match.nodeEvent, { nodeId: 'shrine', eventId: 'crossroads-shrine' })

  const informed = fixture('campaign-save-informed-v7.json')
  assert.equal(informed.match.machineState, 'awaitingInformedHoldChoice')
  assert.deepEqual(Object.keys(informed.match.holdChoice), [
    'from',
    'candidate',
    'opponentFrom',
    'opponentCandidate',
  ])
  assert.deepEqual(informed.match.journal.map(({ type, nodeId }) => `${type}:${nodeId}`), [
    'route:gate',
    'reward:gate',
    'route:shrine',
    'event:shrine',
    'route:court',
  ])

  const modifiers = fixture('campaign-save-modifiers-v7.json')
  assert.deepEqual(modifiers.match.activeModifiers, [
    { id: 'vitality-cap-v1', lifetime: 'campaign', grantedAtNodeId: null },
    { id: 'spoils-of-war-v1', lifetime: 'encounter', grantedAtNodeId: 'gate' },
  ])
  assert.notEqual(modifiers.match.hold, null)

  const eliteChoice = fixture('campaign-save-elite-choice-v7.json')
  assert.equal(eliteChoice.match.machineState, 'awaitingRoute')
  const eliteChoiceStates = routeStates(restoreRunSave(eliteChoice))
  assert.equal(eliteChoiceStates.court, 'available')
  assert.equal(eliteChoiceStates['high-court'], 'available')
  assert.deepEqual(eliteChoice.match.journal.at(-1), {
    type: 'event',
    nodeId: 'shrine',
    optionId: 'walk-on',
    targetInstanceId: null,
    createdInstanceId: null,
  })

  const eliteReward = fixture('campaign-save-elite-reward-v7.json')
  assert.equal(eliteReward.match.machineState, 'awaitingReward')
  assert.equal(eliteReward.match.encounter.id, 'high-court')
  assert.equal(eliteReward.match.encounter.tier, 'elite')
  assert.deepEqual(eliteReward.match.encounter.traitIds, ['court-etiquette-v1'])
  assert.deepEqual(eliteReward.match.pendingReward.offers.map(({ offerId }) => offerId), [
    'new-card',
    'deck-edit',
    'modifier',
    'mend',
  ])
  assert.match(eliteReward.match.pendingReward.offers[0].cardId, /^c-[JQKA][SHDC]$/)

  const rest = fixture('campaign-save-rest-v7.json')
  assert.equal(rest.match.machineState, 'awaitingRest')
  assert.deepEqual(rest.match.restSite, { nodeId: 'camp', siteId: 'roadside-camp' })
  assert.ok(rest.match.health < rest.match.maxHealth)
  assert.equal(rest.match.encounter, null)

  const boss = fixture('campaign-save-boss-v7.json')
  assert.equal(boss.match.machineState, 'ready')
  assert.equal(boss.match.encounter.id, 'ace-sovereign')
  assert.equal(boss.match.encounter.tier, 'boss')
  assert.deepEqual(boss.match.encounter.traitIds, [])
  assert.equal(boss.match.encounterAttempt, 1)
  assert.equal(boss.pendingEvent, null)
  assert.deepEqual(boss.match.journal.map(({ type, nodeId }) => `${type}:${nodeId}`), [
    'route:gate',
    'reward:gate',
    'route:shrine',
    'event:shrine',
    'route:high-court',
    'reward:high-court',
    'route:camp',
    'rest:camp',
    'route:night-watch',
    'reward:night-watch',
    'route:sanctum',
    'rest:sanctum',
    'route:finale',
  ])

  const victory = fixture('campaign-save-victory-v7.json')
  assert.equal(victory.match.machineState, 'ended')
  assert.deepEqual(victory.match.outcome, { result: 'victory', reason: 'campaignCompleted' })
  assert.deepEqual(victory.match.journal, boss.match.journal)
  assert.equal(routeStates(restoreRunSave(victory)).finale, 'completed')
})

test('the first fight and the court fight match their 21.2 saves exactly', () => {
  for (const kind of ['reward', 'informed', 'modifiers']) {
    const legacy = fixture(`campaign-save-${kind}-v5.json`)
    const current = fixture(`campaign-save-${kind}-v7.json`)
    for (const key of ['rng', 'runId', 'ruleset']) {
      assert.deepEqual(current[key], legacy[key], `${kind} ${key}`)
    }
    for (const key of [
      'machineState',
      'turn',
      'health',
      'encounterIndex',
      'encounterAttempt',
      'cards',
      'deckLayout',
      'hold',
      'holdChoice',
      'pendingReward',
    ]) {
      assert.deepEqual(current.match[key], legacy.match[key], `${kind} ${key}`)
    }
    // 21.4 records the fight tier and its traits; the rest of the encounter is unchanged.
    const { tier, traitIds, ...encounter } = current.match.encounter
    assert.equal(tier, 'normal', `${kind} tier`)
    assert.deepEqual(traitIds, [], `${kind} traitIds`)
    assert.deepEqual(encounter, legacy.match.encounter, `${kind} encounter`)
  }
})

test('restored boundaries continue exactly without RNG replay', () => {
  const reward = rewardFixtureRun()
  const restoredReward = restoreRunSave(fixture('campaign-save-reward-v7.json'))
  for (const offerId of ['new-card', 'modifier', 'mend']) {
    assert.deepEqual(claimReward(restoredReward, offerId), claimReward(reward, offerId))
  }

  const route = routeFixtureRun()
  const restoredRoute = restoreRunSave(fixture('campaign-save-route-v7.json'))
  for (const nodeId of ['market', 'shrine']) {
    assert.deepEqual(chooseRoute(restoredRoute, nodeId), chooseRoute(route, nodeId))
  }
  assert.deepEqual(chooseRoute(restoredRoute, 'market').rng, route.rng)

  const shop = shopFixtureRun()
  const restoredShop = restoreRunSave(fixture('campaign-save-shop-v7.json'))
  const target = getCampaignShopTargets(restoredShop, 'service-1')[0].instanceId
  assert.deepEqual(
    buyShopItem(restoredShop, 'service-1', target),
    buyShopItem(shop, 'service-1', target),
  )
  assert.deepEqual(leaveShop(restoredShop), leaveShop(shop))

  const restoredEvent = restoreRunSave(fixture('campaign-save-event-v7.json'))
  const bled = chooseEventOption(restoredEvent, 'bleed-for-fortune')
  assert.equal(bled.health, restoredEvent.health - 1)
  assert.equal(bled.currency, restoredEvent.currency + 5)
  assert.deepEqual(bled.rng, restoredEvent.rng)

  const informed = informedFixtureRun()
  const restoredInformed = restoreRunSave(fixture('campaign-save-informed-v7.json'))
  assert.deepEqual(restoredInformed.rng, informed.rng)
  const resumed = chooseCampaignReveal(restoredInformed, 'normal')
  assert.deepEqual(resumed, chooseCampaignReveal(informed, 'normal'))
  assert.equal(
    resumed.event.reveals.find(({ suppliedBy }) => suppliedBy === 'opponent').instanceId,
    restoredInformed.holdChoice.opponentCandidate,
  )
  assert.deepEqual(resumed.match.rng, restoredInformed.rng)

  const rest = restFixtureRun()
  const restoredRest = restoreRunSave(fixture('campaign-save-rest-v7.json'))
  const trainTarget = getCampaignRestTargets(restoredRest, 'train')[0].instanceId
  for (const [optionId, target] of [['rest', null], ['train', trainTarget], ['walk-on', null]]) {
    const chosen = chooseRestOption(restoredRest, optionId, target)
    assert.deepEqual(chosen, chooseRestOption(rest, optionId, target), optionId)
    assert.equal(chosen.machineState, 'awaitingRoute')
    assert.deepEqual(chosen.rng, restoredRest.rng)
  }
  assert.equal(chooseRestOption(restoredRest, 'rest').health, restoredRest.health + 2)

  const eliteReward = eliteRewardFixtureRun()
  const restoredEliteReward = restoreRunSave(fixture('campaign-save-elite-reward-v7.json'))
  const mended = claimReward(restoredEliteReward, 'mend')
  assert.deepEqual(mended, claimReward(eliteReward, 'mend'))
  assert.equal(mended.health, restoredEliteReward.health + CAMPAIGN_MEND_HEALTH_BY_TIER.elite)

  // The boss fight continues to a victory, or, once the held card is revealed, to a defeat
  // after two retries.
  const boss = restoreRunSave(fixture('campaign-save-boss-v7.json'))
  assert.deepEqual(boss, bossFixtureRun())
  const won = winEncounter(boss)
  assert.deepEqual(won.outcome, { result: 'victory', reason: 'campaignCompleted' })
  assert.deepEqual(roundTrip(won), won)
  let defeated = chooseCampaignReveal(prepareCampaignReveal(boss).match, 'hold').match
  assert.equal(defeated.hold, null)
  while (defeated.machineState !== 'ended') {
    defeated = defeated.machineState === 'awaitingRetry'
      ? retryEncounter(defeated)
      : loseEncounter(defeated)
  }
  assert.deepEqual(defeated.outcome, { result: 'defeat', reason: 'healthDepleted' })
  assert.equal(defeated.encounterAttempt, 3)
  assert.equal(defeated.health, 0)

  const victory = restoreRunSave(fixture('campaign-save-victory-v7.json'))
  assert.deepEqual(victory, victoryFixtureRun())
  assert.deepEqual(roundTrip(victory), victory)
  assert.throws(() => prepareCampaignReveal(victory), /Only a ready campaign can prepare a reveal/)
  assert.throws(() => chooseRoute(victory, 'finale'), /route/)
})

test('a restored sold-out shop refuses every purchase and leaves toward the boss', () => {
  const exhausted = restoreRunSave(fixture('campaign-save-shop-exhausted-v7.json'))
  const offers = getCampaignShopOffers(exhausted)
  assert.deepEqual(offers.map(({ itemId, blocker }) => [itemId, blocker]), [
    ['card-1', 'sold'],
    ['card-2', 'sold'],
    ['service-1', 'sold'],
    ['modifier-1', 'sold'],
  ])
  const deckCard = exhausted.cards.find(({ campaignOwner, instanceId }) => (
    campaignOwner === 'player' && instanceId !== exhausted.hold
  )).instanceId
  for (const { itemId, kind } of offers) {
    assert.throws(
      () => buyShopItem(exhausted, itemId, kind === 'remove' ? deckCard : null),
      new RegExp(`Shop item ${itemId} is unavailable: sold`),
    )
  }

  const left = leaveShop(exhausted)
  assert.equal(left.machineState, 'awaitingRoute')
  assert.equal(left.currency, 0)
  assert.equal(left.shop, null)
  assert.deepEqual(left.rng, exhausted.rng)
  assert.deepEqual(left.cards, exhausted.cards)
  assert.deepEqual(left.journal.at(-1), { type: 'leaveShop', nodeId: 'bazaar' })
  assert.deepEqual(routeStates(left), {
    gate: 'completed',
    market: 'bypassed',
    shrine: 'completed',
    court: 'completed',
    'high-court': 'bypassed',
    bazaar: 'completed',
    vault: 'bypassed',
    camp: 'bypassed',
    watch: 'available',
    'night-watch': 'available',
    sanctum: 'locked',
    finale: 'locked',
  })
  assert.deepEqual(roundTrip(left), left)
  assert.deepEqual(left, leaveShop(exhaustedShopFixtureRun()))

  // The stage-5 fight and the sanctum still stand between the bazaar and the boss.
  const watched = claimReward(winEncounter(chooseRoute(roundTrip(left), 'watch')), 'mend')
  assert.equal(routeStates(watched).sanctum, 'available')
  const finale = passThrough(roundTrip(watched), 'sanctum', 'finale')
  assert.equal(finale.machineState, 'ready')
  assert.equal(finale.encounter.id, 'ace-sovereign')
})

function activeFightTier(run) {
  return getCampaignNodeContent(getCampaignMapNode(activeNodeId(run))).tier
}

test('every expedition boundary round-trips and continues like an uninterrupted run', () => {
  // Seed 17 climbs the elite ladder, retries once, and rests at the camp and the sanctum
  // before defeating the Ace Sovereign; seed 12 bleeds at the shrine, sells out the bazaar,
  // retries twice, and falls to the boss; seed 1 takes the market path without a retry.
  const covered = new Set()
  for (const [seed, plan, outcome, retries] of [
    [17, EXPEDITION_PLANS.shrine, 'victory', 1],
    [12, EXPEDITION_PLANS.soldOut, 'defeat', 2],
    [1, EXPEDITION_PLANS.market, 'victory', 0],
  ]) {
    const options = { runId: `expedition-boundaries-${seed}`, seed, ruleset: BASELINE_RULESET }
    let uninterrupted = createCampaignRun(options)
    let resumed = roundTrip(createCampaignRun(options))
    const straightCounters = createExpeditionCounters()
    const resumedCounters = createExpeditionCounters()
    const boundaries = new Set()
    let soldOut = false
    for (let step = 0; uninterrupted.machineState !== 'ended'; step += 1) {
      assert.ok(step < 5000)
      boundaries.add(uninterrupted.machineState)
      soldOut ||= uninterrupted.machineState === 'awaitingShop'
        && uninterrupted.shop.items.every(({ sold }) => sold)
      if (uninterrupted.machineState === 'ready') covered.add(`${activeFightTier(uninterrupted)} fight`)
      uninterrupted = stepExpedition(uninterrupted, plan, straightCounters)
      resumed = roundTrip(stepExpedition(resumed, plan, resumedCounters))
      assert.deepEqual(resumed, uninterrupted)
    }
    assert.equal(uninterrupted.outcome.result, outcome)
    assert.deepEqual(resumedCounters, straightCounters)
    assert.equal(straightCounters.retries, retries, `seed ${seed} retries`)
    for (const state of [
      'awaitingRoute',
      'ready',
      'awaitingHoldChoice',
      'awaitingReward',
      'awaitingEvent',
      'awaitingRest',
    ]) {
      assert.ok(boundaries.has(state), `seed ${seed} reaches ${state}`)
    }
    assert.equal(boundaries.has('awaitingRetry'), retries > 0)
    assert.equal(boundaries.has('awaitingShop'), plan !== EXPEDITION_PLANS.shrine)
    assert.equal(soldOut, plan === EXPEDITION_PLANS.soldOut, `seed ${seed} sells out a shop`)
    for (const state of boundaries) covered.add(state)
    if (soldOut) covered.add('sold-out shop')
    if (outcome === 'victory') {
      assert.equal(routeStates(uninterrupted).finale, 'completed')
      covered.add('boss victory')
    } else {
      assert.equal(routeStates(uninterrupted).finale, 'active')
      assert.equal(uninterrupted.health, 0)
      covered.add('boss defeat')
    }
  }
  for (const item of [
    'awaitingRetry',
    'awaitingShop',
    'awaitingRest',
    'normal fight',
    'elite fight',
    'boss fight',
    'sold-out shop',
    'boss victory',
    'boss defeat',
  ]) {
    assert.ok(covered.has(item), `the plays cover ${item}`)
  }
})

test('tampered drafts, journal, route, coins, shops, events, modifiers, and peeks are rejected', () => {
  const draft = /must match the regenerated reward draft/
  const modifiers = /must match the modifiers implied by the journal/
  const cases = [
    ['campaign-save-reward-v7.json', draft, (save) => {
      save.match.pendingReward.offers[0].cardId = 'c-AS'
    }],
    ['campaign-save-reward-v7.json', draft, (save) => {
      save.match.pendingReward.offers.splice(1, 1)
    }],
    ['campaign-save-reward-v7.json', draft, (save) => {
      save.match.pendingReward.offers[2].modifierId = 'vow-of-patience-v1'
    }],
    ['campaign-save-informed-v7.json', /entry 1 must match its regenerated reward draft/, (save) => {
      save.match.journal[1].offerId = 'mend'
    }],
    ['campaign-save-informed-v7.json', /route position implied by the journal/, (save) => {
      save.match.journal = []
    }],
    ['campaign-save-informed-v7.json', /opponent candidate must remain at index zero/, (save) => {
      save.match.holdChoice.opponentCandidate = save.match.encounter.zones.opponentSourcePile[1]
    }],
    ['campaign-save-informed-v7.json', modifiers, (save) => {
      save.match.activeModifiers.pop()
    }],
    ['campaign-save-modifiers-v7.json', modifiers, (save) => {
      save.match.activeModifiers[1].lifetime = 'campaign'
    }],
    ['campaign-save-modifiers-v7.json', modifiers, (save) => {
      save.match.activeModifiers.push({
        id: 'hold-insight-v1',
        lifetime: 'campaign',
        grantedAtNodeId: 'gate',
      })
    }],
    ['campaign-save-modifiers-v7.json', /must match the modifiers implied by the journal/, (save) => {
      save.match.activeModifiers[1].grantedAtNodeId = 'shrine'
    }],
    ['campaign-save-route-v7.json', /coins must match the journal/, (save) => {
      save.match.currency = 4
    }],
    ['campaign-save-route-v7.json', /route/, (save) => {
      save.match.route.nodes[2].state = 'bypassed'
    }],
    ['campaign-save-route-v7.json', /route/, (save) => {
      save.match.route.nodes[3].state = 'available'
    }],
    ['campaign-save-shop-v7.json', /regenerated shop stock/, (save) => {
      save.match.shop.items[0].cardId = 'c-9S'
    }],
    ['campaign-save-shop-v7.json', /regenerated shop stock/, (save) => {
      save.match.shop.items[1].price = 1
    }],
    ['campaign-save-shop-v7.json', /regenerated shop stock/, (save) => {
      save.match.shop.items[0].sold = true
    }],
    ['campaign-save-shop-v7.json', /shop/, (save) => {
      save.match.shop.nodeId = 'bazaar'
    }],
    ['campaign-save-event-v7.json', /event/, (save) => {
      save.match.nodeEvent.eventId = 'oathkeepers-vault'
    }],
    ['campaign-save-event-v7.json', /health must match/, (save) => {
      save.match.health = 2
    }],
    ['campaign-save-rest-v7.json', /restSite\.siteId must match the active route node/, (save) => {
      save.match.restSite.siteId = 'last-light-sanctum'
    }],
    ['campaign-save-rest-v7.json', /restSite must be a plain object/, (save) => {
      save.match.restSite = null
    }],
    ['campaign-save-route-v7.json', /rest site is allowed only while a rest site is open/, (save) => {
      save.match.restSite = { nodeId: 'camp', siteId: 'roadside-camp' }
    }],
    ['campaign-save-boss-v7.json', /health must match/, (save) => {
      save.match.health = 4
    }],
  ]
  for (const [name, message, mutate] of cases) {
    const stale = fixture(name)
    mutate(stale)
    assert.throws(() => restoreRunSave(stale), name)
    assert.throws(() => restoreRunSave(refingerprintSave(stale)), message)
  }

  for (const key of ['journal', 'route', 'currency', 'shop', 'nodeEvent', 'restSite']) {
    const missing = fixture('campaign-save-modifiers-v7.json')
    delete missing.match[key]
    assert.throws(() => restoreRunSave(missing), /save\.match must contain only/)
  }
  const legacyShape = fixture('campaign-save-modifiers-v7.json')
  legacyShape.match.rewardHistory = []
  assert.throws(() => restoreRunSave(legacyShape), /save\.match must contain only/)
})

test('awaiting Hold choices round-trip with their exact candidate and RNG snapshot', () => {
  const prepared = prepareCampaignReveal(campaign()).match
  const save = createRunSave(prepared, { savedAt: SAVED_AT })
  const restored = restoreRunSave(clone(save))

  assert.equal(restored.machineState, 'awaitingHoldChoice')
  assert.deepEqual(restored.holdChoice, prepared.holdChoice)
  assert.deepEqual(restored.rng, prepared.rng)
  assert.equal(restored.stateFingerprint, prepared.stateFingerprint)

  const corrupt = clone(save)
  corrupt.match.holdChoice.candidate = corrupt.match.cards[0].instanceId
  assert.throws(() => restoreRunSave(corrupt), /candidate|fingerprint/)
})

test('automatic campaign reveal saves the Hold boundary before normal resolution', async () => {
  const writes = []
  const repository = {
    async load() {
      return { status: 'empty' }
    },
    async save(run) {
      writes.push(run)
      return { status: 'saved', savedAt: SAVED_AT }
    },
  }
  const controller = createRunController({
    repository,
    initialMatch: campaign(4),
  })

  const result = await controller.revealOrContinue({ autoChooseNormal: true })
  assert.equal(writes.length, 2)
  assert.equal(writes[0].machineState, 'awaitingHoldChoice')
  assert.equal(writes[0].pendingEvent, null)
  assert.notEqual(writes[0].holdChoice.candidate, null)
  assert.equal(writes[1].turn, 1)
  assert.notEqual(writes[1].pendingEvent, null)
  assert.deepEqual(result.match, writes[1])
  await controller.destroy()
})

test('automatic campaign reveal stops at the saved choice when persistence fails', async () => {
  const writes = []
  const repository = {
    async load() {
      return { status: 'empty' }
    },
    async save(run) {
      writes.push(run)
      return { status: 'storage-unavailable', reason: 'quota-exceeded' }
    },
  }
  const controller = createRunController({
    repository,
    initialMatch: campaign(5),
  })

  const result = await controller.revealOrContinue({ autoChooseNormal: true })
  assert.equal(writes.length, 1)
  assert.equal(result.match.machineState, 'awaitingHoldChoice')
  assert.equal(result.event, null)
  assert.equal(result.save.status, 'storage-unavailable')
  await controller.destroy()
})

function recordingRepository(results = []) {
  const writes = []
  return {
    writes,
    async load() {
      return { status: 'empty' }
    },
    async save(run) {
      writes.push(run)
      return results[writes.length - 1] ?? { status: 'saved', savedAt: SAVED_AT }
    },
  }
}

test('reward selection waits for the saved draft and saves the route map', async () => {
  const draft = rewardFixtureRun()
  const repository = recordingRepository([
    { status: 'storage-unavailable', reason: 'quota-exceeded' },
  ])
  const controller = createRunController({ repository, initialMatch: draft })
  const selection = { nodeId: 'gate', step: 1, offerId: 'mend', targetInstanceId: null }

  assert.throws(
    () => controller.selectReward(selection),
    /reward draft must be saved before a reward can be selected/,
  )
  assert.equal((await controller.saveStable()).status, 'storage-unavailable')
  assert.equal(controller.getSnapshot().saveStatus, 'failed')
  assert.throws(() => controller.selectReward(selection), /must be saved/)
  assert.equal(controller.currentMatch.machineState, 'awaitingReward')

  assert.equal((await controller.saveStable()).status, 'saved')
  assert.throws(
    () => controller.selectReward({ ...selection, offerId: 'deck-edit', targetInstanceId: 'player-999' }),
    /eligible card/,
  )
  assert.throws(() => controller.selectReward({ ...selection, step: 0 }), /stale/)
  assert.equal(controller.currentMatch.machineState, 'awaitingReward')
  assert.equal(controller.getSnapshot().saveStatus, 'saved')

  const result = await controller.selectReward(selection)
  assert.deepEqual(result.match, claimReward(draft, 'mend'))
  assert.equal(result.save.status, 'saved')
  assert.equal(result.match.encounterIndex, 1)
  assert.equal(result.match.machineState, 'awaitingRoute')
  assert.equal(result.match.currency, 3)
  assert.deepEqual(repository.writes.at(-1), result.match)
  assert.equal(controller.getSnapshot().saveStatus, 'saved')
  assert.throws(() => controller.selectReward(selection), /no reward draft/)
  await controller.destroy()
})

test('route, shop, event, and rest decisions wait for their saved boundary and apply once', async () => {
  const route = routeFixtureRun()
  const repository = recordingRepository([
    { status: 'storage-unavailable', reason: 'quota-exceeded' },
  ])
  const controller = createRunController({ repository, initialMatch: route })
  const toMarket = { nodeId: 'market', step: 2 }

  assert.throws(() => controller.chooseRoute(toMarket), /route map must be saved/)
  assert.equal((await controller.saveStable()).status, 'storage-unavailable')
  assert.throws(() => controller.chooseRoute(toMarket), /route map must be saved/)
  assert.equal((await controller.saveStable()).status, 'saved')
  assert.throws(() => controller.chooseRoute({ nodeId: 'court', step: 2 }), /locked, not available/)
  assert.throws(() => controller.purchaseShopItem({
    nodeId: 'market',
    step: 2,
    itemId: 'card-1',
    targetInstanceId: null,
  }), /not at a shop/)

  const shopped = await controller.chooseRoute(toMarket)
  assert.deepEqual(shopped.match, chooseRoute(route, 'market'))
  assert.equal(shopped.save.status, 'saved')
  assert.throws(() => controller.chooseRoute(toMarket), /route map/)

  const target = getCampaignShopTargets(shopped.match, 'service-1')[0].instanceId
  const purchase = { nodeId: 'market', step: 3, itemId: 'service-1', targetInstanceId: target }
  const bought = await controller.purchaseShopItem(purchase)
  assert.deepEqual(bought.match, buyShopItem(shopped.match, 'service-1', target))
  assert.equal(bought.match.currency, 1)
  assert.equal(bought.match.shop.items[1].sold, true)
  assert.throws(() => controller.purchaseShopItem(purchase), /stale/)
  assert.throws(() => controller.purchaseShopItem({ ...purchase, step: 4 }), /sold/)

  const left = await controller.leaveShop({ nodeId: 'market', step: 4 })
  assert.equal(left.match.machineState, 'awaitingRoute')
  assert.equal(left.match.shop, null)
  assert.throws(() => controller.leaveShop({ nodeId: 'market', step: 4 }), /not at a shop/)
  assert.deepEqual(repository.writes.at(-1), left.match)
  await controller.destroy()

  const eventController = createRunController({
    repository: recordingRepository(),
    initialMatch: chooseRoute(route, 'shrine'),
  })
  const option = { nodeId: 'shrine', step: 3, optionId: 'bleed-for-fortune', targetInstanceId: null }
  assert.throws(() => eventController.chooseEventOption(option), /event must be saved/)
  await eventController.saveStable()
  const chosen = await eventController.chooseEventOption(option)
  assert.equal(chosen.match.machineState, 'awaitingRoute')
  assert.equal(chosen.match.currency, 8)
  assert.equal(chosen.match.health, 2)
  assert.throws(() => eventController.chooseEventOption(option), /not at an event/)
  await eventController.destroy()

  const rest = restFixtureRun()
  const restController = createRunController({
    repository: recordingRepository([{ status: 'storage-unavailable', reason: 'quota-exceeded' }]),
    initialMatch: rest,
  })
  const restOption = {
    nodeId: 'camp',
    step: rest.journal.length,
    optionId: 'rest',
    targetInstanceId: null,
  }
  assert.throws(
    () => restController.chooseRestOption(restOption),
    /rest site must be saved before an option can be chosen/,
  )
  assert.equal((await restController.saveStable()).status, 'storage-unavailable')
  assert.throws(() => restController.chooseRestOption(restOption), /rest site must be saved/)
  assert.equal((await restController.saveStable()).status, 'saved')
  assert.throws(
    () => restController.chooseRestOption({ ...restOption, optionId: 'cleanse' }),
    /Rest option is not part of the open rest site/,
  )
  assert.throws(() => restController.chooseRestOption({ ...restOption, step: 0 }), /stale/)
  const rested = await restController.chooseRestOption(restOption)
  assert.deepEqual(rested.match, chooseRestOption(rest, 'rest'))
  assert.equal(rested.match.health, rest.health + 2)
  assert.equal(rested.match.restSite, null)
  assert.equal(rested.save.status, 'saved')
  assert.throws(() => restController.chooseRestOption(restOption), /not at a rest site/)
  await restController.destroy()
})

test('a decision lost before its save reloads to the offered boundary and applies once', async () => {
  const route = routeFixtureRun()
  const repository = recordingRepository([
    { status: 'saved', savedAt: SAVED_AT },
    { status: 'storage-unavailable', reason: 'quota-exceeded' },
  ])
  const controller = createRunController({ repository, initialMatch: route })
  await controller.saveStable()
  const failed = await controller.chooseRoute({ nodeId: 'market', step: 2 })
  assert.equal(failed.save.status, 'storage-unavailable')
  assert.equal(controller.getSnapshot().saveStatus, 'failed')
  assert.throws(
    () => controller.purchaseShopItem({
      nodeId: 'market',
      step: 3,
      itemId: 'card-1',
      targetInstanceId: null,
    }),
    /shop must be saved/,
  )
  assert.equal((await controller.saveStable()).status, 'saved')
  assert.deepEqual(repository.writes.at(-1), failed.match)
  await controller.destroy()

  // A reload restores the last successful save: the route map the decision was made on.
  const restored = restoreRunSave(createRunSave(repository.writes[0], { savedAt: SAVED_AT }))
  assert.deepEqual(restored, route)
  const replayed = chooseRoute(restored, 'market')
  assert.deepEqual(replayed, failed.match)
  assert.throws(() => chooseRoute(replayed, 'market'), /route map/)
})

test('an encounter retry waits for the saved loss, applies once, and survives a reload', async () => {
  const lost = loseEncounter(campaign(6, 'campaign-retry-controller'))
  assert.equal(lost.machineState, 'awaitingRetry')
  const retry = { nodeId: 'gate', step: lost.journal.length }
  const repository = recordingRepository([
    { status: 'storage-unavailable', reason: 'quota-exceeded' },
  ])
  const controller = createRunController({ repository, initialMatch: lost })

  assert.throws(
    () => controller.retryEncounter(retry),
    /lost Campaign encounter must be saved before it can be retried/,
  )
  assert.equal((await controller.saveStable()).status, 'storage-unavailable')
  assert.throws(() => controller.retryEncounter(retry), /must be saved before it can be retried/)
  assert.equal(controller.currentMatch.machineState, 'awaitingRetry')
  assert.equal((await controller.saveStable()).status, 'saved')
  assert.throws(() => controller.retryEncounter({ ...retry, step: 0 }), /stale/)
  assert.throws(() => controller.retryEncounter({ ...retry, nodeId: 'market' }), /not the active node/)
  assert.deepEqual(controller.currentMatch, lost)
  assert.equal(repository.writes.length, 2)

  const result = await controller.retryEncounter(retry)
  assert.deepEqual(result.match, retryEncounter(lost))
  assert.equal(result.save.status, 'saved')
  assert.equal(result.match.machineState, 'ready')
  assert.equal(result.match.encounterAttempt, 2)
  assert.deepEqual(repository.writes.at(-1), result.match)
  assert.throws(() => controller.retryEncounter(retry), /not awaiting an encounter retry/)
  await controller.destroy()

  const flaky = recordingRepository([
    { status: 'saved', savedAt: SAVED_AT },
    { status: 'storage-unavailable', reason: 'quota-exceeded' },
  ])
  const reloading = createRunController({ repository: flaky, initialMatch: lost })
  await reloading.saveStable()
  const unsaved = await reloading.retryEncounter(retry)
  assert.equal(unsaved.save.status, 'storage-unavailable')
  assert.equal(reloading.getSnapshot().saveStatus, 'failed')
  await reloading.destroy()

  // A reload restores the saved loss; the same retry applies once to it.
  const restored = restoreRunSave(createRunSave(flaky.writes[0], { savedAt: SAVED_AT }))
  assert.deepEqual(restored, lost)
  assert.deepEqual(retryEncounter(restored), unsaved.match)
  assert.throws(() => retryEncounter(unsaved.match), /not awaiting an encounter retry/)
})

test('automatic reveal saves the informed Hold choice before resolving it', async () => {
  const insight = chooseRoute(
    chooseEventOption(chooseRoute(routeFixtureRun(), 'shrine'), 'walk-on'),
    'court',
  )
  const repository = recordingRepository()
  const controller = createRunController({ repository, initialMatch: insight })

  const result = await controller.revealOrContinue({ autoChooseNormal: true })
  const prepared = prepareCampaignReveal(insight).match
  assert.equal(repository.writes.length, 2)
  assert.deepEqual(repository.writes[0], prepared)
  assert.equal(repository.writes[0].machineState, 'awaitingInformedHoldChoice')
  assert.deepEqual(result.match, chooseCampaignReveal(prepared, 'normal').match)
  assert.deepEqual(repository.writes[1], result.match)
  await controller.destroy()

  const manual = createRunController({ repository: recordingRepository(), initialMatch: insight })
  const informed = await manual.revealOrContinue()
  assert.equal(informed.match.machineState, 'awaitingInformedHoldChoice')
  assert.equal(informed.event, null)
  const chosen = await manual.chooseHoldChoice('normal')
  assert.deepEqual(chosen.match, result.match)
  await manual.destroy()
})

test('automatic reveal never selects a pending reward', async () => {
  const draft = rewardFixtureRun()
  let reveals = 0
  let selections = 0
  const coordinator = createAutoRevealCoordinator({
    runController: {
      getSnapshot: () => ({ match: draft, saveStatus: 'saved' }),
      revealOrContinue() {
        reveals += 1
      },
      selectReward() {
        selections += 1
      },
    },
  })
  const result = await coordinator.continueAfterPresentation({
    active: true,
    enabled: true,
    saveSucceeded: true,
    presentationStatus: 'completed',
    runId: draft.runId,
    eventId: draft.pendingEvent.id,
    blocked: false,
  })
  assert.equal(result, null)
  assert.equal(reveals, 0)
  assert.equal(selections, 0)
  coordinator.destroy()

  const repository = recordingRepository()
  const controller = createRunController({ repository, initialMatch: draft })
  await controller.saveStable()
  assert.throws(
    () => controller.revealOrContinue({ autoChooseNormal: true }),
    /Only a ready campaign can prepare a reveal/,
  )
  assert.equal(controller.currentMatch.machineState, 'awaitingReward')
  assert.equal(repository.writes.length, 1)
  await controller.destroy()
})

const CONTROLLER_DECISIONS = Object.freeze([
  'revealOrContinue',
  'chooseHoldChoice',
  'captureHold',
  'selectReward',
  'chooseRoute',
  'purchaseShopItem',
  'leaveShop',
  'chooseEventOption',
  'chooseRestOption',
  'retryEncounter',
])

test('automatic reveal leaves restored route, shop, event, rest, and retry boundaries to the player', async () => {
  const lost = loseEncounter(campaign(27, 'campaign-auto-retry'))
  const notReady = /Only a ready campaign can prepare a reveal/
  const boundaries = [
    ['route', fixture('campaign-save-route-v7.json'), notReady],
    ['shop', fixture('campaign-save-shop-v7.json'), notReady],
    ['sold-out shop', fixture('campaign-save-shop-exhausted-v7.json'), notReady],
    ['event', fixture('campaign-save-event-v7.json'), notReady],
    ['elite choice', fixture('campaign-save-elite-choice-v7.json'), notReady],
    ['elite reward', fixture('campaign-save-elite-reward-v7.json'), notReady],
    ['rest', fixture('campaign-save-rest-v7.json'), notReady],
    ['victory', fixture('campaign-save-victory-v7.json'), /An ended match cannot reveal/],
    ['retry', clone(createRunSave(lost, { savedAt: SAVED_AT })), notReady],
  ]
  for (const [name, save, refusal] of boundaries) {
    const restored = restoreRunSave(save)
    const writes = []
    const controller = createRunController({
      repository: {
        load: async () => ({ status: 'resumable', savedAt: SAVED_AT, match: restored }),
        async save(run) {
          writes.push(run)
          return { status: 'saved', savedAt: SAVED_AT }
        },
      },
    })
    assert.equal((await controller.restore()).status, 'resumable', name)
    assert.equal(controller.getSnapshot().saveStatus, 'saved', name)
    const calls = []
    const runController = { getSnapshot: () => controller.getSnapshot() }
    for (const method of CONTROLLER_DECISIONS) {
      runController[method] = (...args) => {
        calls.push(method)
        return controller[method](...args)
      }
    }
    const coordinator = createAutoRevealCoordinator({ runController })
    const continuation = await coordinator.continueAfterPresentation({
      active: true,
      enabled: true,
      saveSucceeded: true,
      presentationStatus: 'completed',
      runId: restored.runId,
      eventId: restored.pendingEvent?.id,
      blocked: false,
    })
    assert.equal(continuation, null, name)
    assert.deepEqual(calls, [], name)
    assert.throws(
      () => controller.revealOrContinue({ autoChooseNormal: true }),
      refusal,
      name,
    )
    await controller.whenIdle()
    assert.deepEqual(writes, [], name)
    assert.deepEqual(controller.currentMatch, restored, name)
    coordinator.destroy()
    await controller.destroy()
  }
})

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
  getCampaignShopTargets,
  prepareCampaignReveal,
} from '../../src/domain/campaign-machine.js'
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
  buyShopItem,
  chooseEventOption,
  chooseRoute,
  claimReward,
  createExpeditionCounters,
  informedFixtureRun,
  leaveShop,
  rewardFixtureRun,
  routeFixtureRun,
  routeStates,
  shopFixtureRun,
  startCampaign,
  stepExpedition,
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

test('campaign saves use schema v6 and campaign rules v5 and restore exactly', () => {
  const map = createCampaignRun({
    runId: 'campaign-persistence-map',
    seed: 27,
    ruleset: BASELINE_RULESET,
  })
  const mapSave = createRunSave(map, { savedAt: SAVED_AT })
  assert.equal(SAVE_SCHEMA_VERSION, 6)
  assert.equal(CAMPAIGN_GAME_RULES_VERSION, 5)
  assert.equal(CAMPAIGN_VERSION, 3)
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
    'locked',
    'locked',
    'locked',
    'locked',
    'locked',
    'locked',
    'locked',
  ])
  assert.deepEqual(Object.keys(mapSave.match).slice(-6), [
    'holdChoice',
    'pendingReward',
    'shop',
    'nodeEvent',
    'journal',
    'stateFingerprint',
  ])
  assert.equal(validateRunSave(mapSave), mapSave)
  assert.deepEqual(restoreRunSave(clone(mapSave)), map)

  const run = campaign()
  const save = createRunSave(run, { savedAt: SAVED_AT })
  assert.deepEqual(save.match.journal, [{ type: 'route', nodeId: 'gate' }])
  assert.equal(save.match.machineState, 'ready')
  assert.notDeepEqual(save.rng, map.rng)
  assert.deepEqual(restoreRunSave(clone(save)), run)
})

test('campaign v6 fixtures regenerate exactly and restore their stable states', () => {
  for (const [name, build] of CAMPAIGN_SAVE_FIXTURES) {
    const run = build()
    const save = createRunSave(run, { savedAt: SAVED_AT })
    assert.deepEqual(save, fixture(name), name)
    assert.deepEqual(restoreRunSave(fixture(name)), run, name)
  }

  const reward = fixture('campaign-save-reward-v6.json')
  assert.equal(reward.match.machineState, 'awaitingReward')
  assert.deepEqual(reward.match.pendingReward.offers.map(({ offerId }) => offerId), [
    'new-card',
    'deck-edit',
    'modifier',
    'mend',
  ])
  assert.equal(reward.match.pendingReward.offers[2].modifierId, 'hold-insight-v1')

  const route = fixture('campaign-save-route-v6.json')
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
    watch: 'locked',
    bazaar: 'locked',
    vault: 'locked',
    finale: 'locked',
  })

  const shop = fixture('campaign-save-shop-v6.json')
  assert.equal(shop.match.machineState, 'awaitingShop')
  assert.equal(shop.match.shop.nodeId, 'market')
  assert.deepEqual(shop.match.shop.items.map(({ itemId, kind, price, sold }) => (
    [itemId, kind, price, sold]
  )), [
    ['card-1', 'add', 3, false],
    ['service-1', 'replace', 2, false],
    ['modifier-1', 'modifier', 4, false],
  ])

  const event = fixture('campaign-save-event-v6.json')
  assert.equal(event.match.machineState, 'awaitingEvent')
  assert.deepEqual(event.match.nodeEvent, { nodeId: 'shrine', eventId: 'crossroads-shrine' })

  const informed = fixture('campaign-save-informed-v6.json')
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

  const modifiers = fixture('campaign-save-modifiers-v6.json')
  assert.deepEqual(modifiers.match.activeModifiers, [
    { id: 'vitality-cap-v1', lifetime: 'campaign', grantedAtNodeId: null },
    { id: 'spoils-of-war-v1', lifetime: 'encounter', grantedAtNodeId: 'gate' },
  ])
  assert.notEqual(modifiers.match.hold, null)
})

test('the first fight and the court fight match their 21.2 saves exactly', () => {
  for (const kind of ['reward', 'informed', 'modifiers']) {
    const legacy = fixture(`campaign-save-${kind}-v5.json`)
    const current = fixture(`campaign-save-${kind}-v6.json`)
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
      'encounter',
      'holdChoice',
      'pendingReward',
    ]) {
      assert.deepEqual(current.match[key], legacy.match[key], `${kind} ${key}`)
    }
  }
})

test('restored boundaries continue exactly without RNG replay', () => {
  const reward = rewardFixtureRun()
  const restoredReward = restoreRunSave(fixture('campaign-save-reward-v6.json'))
  for (const offerId of ['new-card', 'modifier', 'mend']) {
    assert.deepEqual(claimReward(restoredReward, offerId), claimReward(reward, offerId))
  }

  const route = routeFixtureRun()
  const restoredRoute = restoreRunSave(fixture('campaign-save-route-v6.json'))
  for (const nodeId of ['market', 'shrine']) {
    assert.deepEqual(chooseRoute(restoredRoute, nodeId), chooseRoute(route, nodeId))
  }
  assert.deepEqual(chooseRoute(restoredRoute, 'market').rng, route.rng)

  const shop = shopFixtureRun()
  const restoredShop = restoreRunSave(fixture('campaign-save-shop-v6.json'))
  const target = getCampaignShopTargets(restoredShop, 'service-1')[0].instanceId
  assert.deepEqual(
    buyShopItem(restoredShop, 'service-1', target),
    buyShopItem(shop, 'service-1', target),
  )
  assert.deepEqual(leaveShop(restoredShop), leaveShop(shop))

  const restoredEvent = restoreRunSave(fixture('campaign-save-event-v6.json'))
  const bled = chooseEventOption(restoredEvent, 'bleed-for-fortune')
  assert.equal(bled.health, restoredEvent.health - 1)
  assert.equal(bled.currency, restoredEvent.currency + 4)
  assert.deepEqual(bled.rng, restoredEvent.rng)

  const informed = informedFixtureRun()
  const restoredInformed = restoreRunSave(fixture('campaign-save-informed-v6.json'))
  assert.deepEqual(restoredInformed.rng, informed.rng)
  const resumed = chooseCampaignReveal(restoredInformed, 'normal')
  assert.deepEqual(resumed, chooseCampaignReveal(informed, 'normal'))
  assert.equal(
    resumed.event.reveals.find(({ suppliedBy }) => suppliedBy === 'opponent').instanceId,
    restoredInformed.holdChoice.opponentCandidate,
  )
  assert.deepEqual(resumed.match.rng, restoredInformed.rng)
})

test('every expedition boundary round-trips and continues like an uninterrupted run', () => {
  // Seed 0 retries the gate, buys at the market, and surrenders Hold at the vault before
  // winning; seed 2 is defeated at the finale; seed 6 burns an offering at the shrine,
  // retries twice, and buys at the bazaar before winning.
  for (const [seed, plan, outcome] of [
    [0, EXPEDITION_PLANS.market, 'victory'],
    [2, EXPEDITION_PLANS.market, 'defeat'],
    [6, EXPEDITION_PLANS.shrine, 'victory'],
  ]) {
    const options = { runId: `expedition-boundaries-${seed}`, seed, ruleset: BASELINE_RULESET }
    let uninterrupted = createCampaignRun(options)
    let resumed = roundTrip(createCampaignRun(options))
    const straightCounters = createExpeditionCounters()
    const resumedCounters = createExpeditionCounters()
    const boundaries = new Set()
    for (let step = 0; uninterrupted.machineState !== 'ended'; step += 1) {
      assert.ok(step < 5000)
      boundaries.add(uninterrupted.machineState)
      uninterrupted = stepExpedition(uninterrupted, plan, straightCounters)
      resumed = roundTrip(stepExpedition(resumed, plan, resumedCounters))
      assert.deepEqual(resumed, uninterrupted)
    }
    assert.equal(uninterrupted.outcome.result, outcome)
    assert.deepEqual(resumedCounters, straightCounters)
    for (const state of [
      'awaitingRoute',
      'ready',
      'awaitingHoldChoice',
      'awaitingReward',
      plan === EXPEDITION_PLANS.market ? 'awaitingShop' : 'awaitingEvent',
      'awaitingEvent',
    ]) {
      assert.ok(boundaries.has(state), `seed ${seed} reaches ${state}`)
    }
    if (seed !== 2) assert.ok(boundaries.has('awaitingRetry'))
    if (outcome === 'victory') {
      assert.equal(routeStates(uninterrupted).finale, 'completed')
    } else {
      assert.equal(routeStates(uninterrupted).finale, 'active')
      assert.equal(uninterrupted.health, 0)
    }
  }
})

test('tampered drafts, journal, route, coins, shops, events, modifiers, and peeks are rejected', () => {
  const draft = /must match the regenerated reward draft/
  const modifiers = /must match the modifiers implied by the journal/
  const cases = [
    ['campaign-save-reward-v6.json', draft, (save) => {
      save.match.pendingReward.offers[0].cardId = 'c-AS'
    }],
    ['campaign-save-reward-v6.json', draft, (save) => {
      save.match.pendingReward.offers.splice(1, 1)
    }],
    ['campaign-save-reward-v6.json', draft, (save) => {
      save.match.pendingReward.offers[2].modifierId = 'vow-of-patience-v1'
    }],
    ['campaign-save-informed-v6.json', /entry 1 must match its regenerated reward draft/, (save) => {
      save.match.journal[1].offerId = 'mend'
    }],
    ['campaign-save-informed-v6.json', /route position implied by the journal/, (save) => {
      save.match.journal = []
    }],
    ['campaign-save-informed-v6.json', /opponent candidate must remain at index zero/, (save) => {
      save.match.holdChoice.opponentCandidate = save.match.encounter.zones.opponentSourcePile[1]
    }],
    ['campaign-save-informed-v6.json', modifiers, (save) => {
      save.match.activeModifiers.pop()
    }],
    ['campaign-save-modifiers-v6.json', modifiers, (save) => {
      save.match.activeModifiers[1].lifetime = 'campaign'
    }],
    ['campaign-save-modifiers-v6.json', modifiers, (save) => {
      save.match.activeModifiers.push({
        id: 'hold-insight-v1',
        lifetime: 'campaign',
        grantedAtNodeId: 'gate',
      })
    }],
    ['campaign-save-modifiers-v6.json', /must match the modifiers implied by the journal/, (save) => {
      save.match.activeModifiers[1].grantedAtNodeId = 'shrine'
    }],
    ['campaign-save-route-v6.json', /coins must match the journal/, (save) => {
      save.match.currency = 4
    }],
    ['campaign-save-route-v6.json', /route/, (save) => {
      save.match.route.nodes[2].state = 'bypassed'
    }],
    ['campaign-save-route-v6.json', /route/, (save) => {
      save.match.route.nodes[3].state = 'available'
    }],
    ['campaign-save-shop-v6.json', /regenerated shop stock/, (save) => {
      save.match.shop.items[0].cardId = 'c-9S'
    }],
    ['campaign-save-shop-v6.json', /regenerated shop stock/, (save) => {
      save.match.shop.items[1].price = 1
    }],
    ['campaign-save-shop-v6.json', /regenerated shop stock/, (save) => {
      save.match.shop.items[0].sold = true
    }],
    ['campaign-save-shop-v6.json', /shop/, (save) => {
      save.match.shop.nodeId = 'bazaar'
    }],
    ['campaign-save-event-v6.json', /event/, (save) => {
      save.match.nodeEvent.eventId = 'oathkeepers-vault'
    }],
    ['campaign-save-event-v6.json', /health must match/, (save) => {
      save.match.health = 2
    }],
  ]
  for (const [name, message, mutate] of cases) {
    const stale = fixture(name)
    mutate(stale)
    assert.throws(() => restoreRunSave(stale), name)
    assert.throws(() => restoreRunSave(refingerprintSave(stale)), message)
  }

  for (const key of ['journal', 'route', 'currency', 'shop', 'nodeEvent']) {
    const missing = fixture('campaign-save-modifiers-v6.json')
    delete missing.match[key]
    assert.throws(() => restoreRunSave(missing), /save\.match must contain only/)
  }
  const legacyShape = fixture('campaign-save-modifiers-v6.json')
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

test('route, shop, and event decisions wait for their saved boundary and apply once', async () => {
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
  assert.equal(chosen.match.currency, 7)
  assert.equal(chosen.match.health, 2)
  assert.throws(() => eventController.chooseEventOption(option), /not at an event/)
  await eventController.destroy()
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

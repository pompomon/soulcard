import assert from 'node:assert/strict'
import test from 'node:test'
import { getCampaignFight } from '../../src/domain/campaign-content.js'
import {
  JOURNAL_ENTRY_KEYS,
  JOURNAL_ENTRY_TYPES,
  JOURNAL_PHASES,
  assertCampaignJournalShape,
  replayCampaignJournal,
} from '../../src/domain/campaign-journal.js'
import {
  chooseCampaignEventOption,
  createCampaignRun,
  getCampaignRestTargets,
} from '../../src/domain/campaign-machine.js'
import { completeRouteNode, getCampaignMapNode } from '../../src/domain/campaign-map.js'
import { BASELINE_RULESET } from '../../src/domain/ruleset.js'
import {
  EXPEDITION_PLANS,
  activeNodeId,
  chooseRestOption,
  chooseRoute,
  claimReward,
  createExpeditionCounters,
  holdCard,
  loseEncounter,
  passThrough,
  restFixtureRun,
  retryEncounter,
  startCampaign,
  stepExpedition,
  winEncounter,
} from '../fixtures/campaign-route.js'

const STATE_FOR_PHASE = Object.freeze({
  route: 'awaitingRoute',
  fight: 'ready',
  shop: 'awaitingShop',
  event: 'awaitingEvent',
  rest: 'awaitingRest',
})

function gate(runId = 'campaign-journal') {
  return startCampaign({ runId, seed: 0, ruleset: BASELINE_RULESET })
}

function replay(journal) {
  return replayCampaignJournal({ seed: 0, ruleset: BASELINE_RULESET, journal })
}

function route(nodeId) {
  return { type: 'route', nodeId }
}

function nodeEntry(type, nodeId) {
  return { type, nodeId }
}

function event(nodeId, optionId, targetInstanceId = null, createdInstanceId = null) {
  return { type: 'event', nodeId, optionId, targetInstanceId, createdInstanceId }
}

function rest(nodeId, optionId, targetInstanceId = null, createdInstanceId = null) {
  return { type: 'rest', nodeId, optionId, targetInstanceId, createdInstanceId }
}

function purchaseOf(item, nodeId, targetInstanceId = null, createdInstanceId = null) {
  return {
    type: 'purchase',
    nodeId,
    itemId: item.itemId,
    kind: item.kind,
    cardId: item.cardId,
    modifierId: item.modifierId,
    price: item.price,
    targetInstanceId,
    createdInstanceId,
  }
}

function playerCards(run) {
  return run.cards.filter(({ campaignOwner }) => campaignOwner === 'player')
}

// Every journal entry is written at a node boundary or into a fresh fight, where the live
// run must equal a replay of its own journal.
function assertReplayMatches(run) {
  const replayed = replayCampaignJournal({
    seed: run.rng.seed,
    ruleset: run.ruleset,
    journal: run.journal,
  })
  assert.equal(run.machineState, STATE_FOR_PHASE[replayed.phase])
  assert.equal(activeNodeId(run), replayed.activeNodeId)
  assert.deepEqual(run.route.nodes, replayed.routeNodes)
  assert.deepEqual(playerCards(run), replayed.playerCards)
  assert.deepEqual(run.activeModifiers, replayed.activeModifiers)
  assert.equal(run.health, replayed.health)
  assert.equal(run.currency, replayed.currency)
  assert.ok(replayed.currency >= 0)
  assert.equal(run.encounterIndex, replayed.encounterIndex)
  assert.equal(run.encounterAttempt, replayed.encounterAttempt)
  assert.deepEqual(run.shop?.items ?? null, replayed.shopItems)
  return replayed
}

test('journal entries have fixed types and exact keys', () => {
  assert.deepEqual(
    JOURNAL_ENTRY_TYPES,
    ['route', 'retry', 'reward', 'purchase', 'leaveShop', 'event', 'rest'],
  )
  assert.deepEqual(Object.keys(JOURNAL_ENTRY_KEYS), JOURNAL_ENTRY_TYPES)
  assert.deepEqual(
    JOURNAL_ENTRY_KEYS.rest,
    ['type', 'nodeId', 'optionId', 'targetInstanceId', 'createdInstanceId'],
  )
  assert.deepEqual(JOURNAL_PHASES, ['route', 'fight', 'shop', 'event', 'rest'])

  const reward = {
    type: 'reward',
    nodeId: 'gate',
    offerId: 'mend',
    kind: 'mend',
    cardId: null,
    modifierId: null,
    targetInstanceId: null,
    createdInstanceId: null,
  }
  const purchase = {
    type: 'purchase',
    nodeId: 'market',
    itemId: 'card-1',
    kind: 'add',
    cardId: 'c-3S',
    modifierId: null,
    price: 3,
    targetInstanceId: null,
    createdInstanceId: 'player-027',
  }
  const walkOn = event('shrine', 'walk-on')
  const trained = rest('camp', 'train', 'player-002', 'player-027')
  const valid = [
    route('gate'),
    nodeEntry('retry', 'gate'),
    reward,
    route('market'),
    purchase,
    nodeEntry('leaveShop', 'market'),
    walkOn,
    trained,
  ]
  assert.equal(assertCampaignJournalShape(valid), valid)
  assert.deepEqual(assertCampaignJournalShape([]), [])

  const getter = { type: 'route' }
  Object.defineProperty(getter, 'nodeId', { enumerable: true, get: () => 'gate' })
  const typeGetter = { nodeId: 'gate' }
  Object.defineProperty(typeGetter, 'type', { enumerable: true, get: () => 'route' })
  const hiddenNode = { type: 'route' }
  Object.defineProperty(hiddenNode, 'nodeId', { enumerable: false, value: 'gate' })
  const cases = [
    ['an object', {}, /campaign\.journal must be a dense array/],
    ['a sparse array', [route('gate'), , route('market')], /must be a dense array/],
    ['an array with extra keys', Object.assign([route('gate')], { note: 1 }), /must be a dense array/],
    ['a null entry', [null], /campaign\.journal\[0\] must be a plain object/],
    ['an array entry', [[]], /campaign\.journal\[0\] must be a plain object/],
    ['an inherited entry', [Object.assign(Object.create({}), route('gate'))], /must be a plain object/],
    ['an unknown type', [{ type: 'teleport', nodeId: 'gate' }], /\[0\]\.type must be a known journal entry type/],
    ['a missing type', [{ nodeId: 'gate' }], /type must be a known journal entry type/],
    ['a type getter', [typeGetter], /type must be a known journal entry type/],
    ['an extra key', [{ ...route('gate'), note: 1 }], /\[0\] must contain only type, nodeId/],
    ['a missing key', [{ type: 'retry' }], /must contain only type, nodeId/],
    ['a symbol key', [{ ...route('gate'), [Symbol('note')]: 1 }], /must contain only type, nodeId/],
    ['a getter value', [getter], /\[0\]\.nodeId must be JSON-compatible data/],
    ['a hidden value', [hiddenNode], /\[0\]\.nodeId must be JSON-compatible data/],
    ['an untrimmed node', [route(' gate')], /\[0\]\.nodeId must be a nonempty trimmed string/],
    ['an empty node', [route('')], /nodeId must be a nonempty trimmed string/],
    ['a numeric offer', [{ ...reward, offerId: 3 }], /offerId must be a nonempty trimmed string/],
    ['an unknown reward', [{ ...reward, kind: 'gold' }], /\[0\]\.kind must be a known reward kind/],
    ['a mend purchase', [{ ...purchase, kind: 'mend' }], /kind must be a known shop item kind/],
    ['a negative price', [{ ...purchase, price: -1 }], /price must be a nonnegative safe integer/],
    ['a fractional price', [{ ...purchase, price: 1.5 }], /price must be a nonnegative safe integer/],
    ['a string price', [{ ...purchase, price: '3' }], /price must be a nonnegative safe integer/],
    ['an empty option', [{ ...walkOn, optionId: '' }], /optionId must be a nonempty trimmed string/],
    ['a numeric target', [{ ...walkOn, targetInstanceId: 7 }], /targetInstanceId must be a nonempty trimmed string/],
    ['an empty rest option', [{ ...trained, optionId: '' }], /optionId must be a nonempty trimmed string/],
    ['a rest without its created card', [{ type: 'rest', nodeId: 'camp', optionId: 'rest', targetInstanceId: null }],
      /\[0\] must contain only type, nodeId, optionId, targetInstanceId, createdInstanceId/],
    ['a rest with an item', [{ ...trained, itemId: 'card-1' }], /must contain only type, nodeId, optionId/],
    ['an untrimmed rest target', [{ ...trained, targetInstanceId: 'player-002 ' }],
      /targetInstanceId must be a nonempty trimmed string/],
    ['an untrimmed card', [{ ...purchase, cardId: ' c-3S' }], /\[0\]\.cardId must be a nonempty trimmed string/],
    ['an empty created card', [{ ...purchase, createdInstanceId: '' }], /createdInstanceId must be a nonempty/],
    ['a later bad entry', [...valid, { ...walkOn, nodeId: 4 }], /campaign\.journal\[8\]\.nodeId/],
  ]
  for (const [name, journal, message] of cases) {
    assert.throws(() => assertCampaignJournalShape(journal), message, name)
  }
  assert.throws(() => assertCampaignJournalShape({}, 'saved.journal'), /saved\.journal must be a dense array/)
})

test('replay rebuilds the live run after every decision of scripted expeditions', () => {
  const recorded = new Set()
  const outcomes = []
  for (const [seed, plan] of [[0, 'market'], [7, 'shrine'], [1, 'soldOut'], [2, 'market']]) {
    let run = createCampaignRun({ runId: `campaign-journal-${seed}`, seed, ruleset: BASELINE_RULESET })
    const counters = createExpeditionCounters()
    let decisions = 0
    assertReplayMatches(run)
    for (let step = 0; step < 5000 && run.machineState !== 'ended'; step += 1) {
      const before = run.journal.length
      run = stepExpedition(run, EXPEDITION_PLANS[plan], counters)
      if (run.journal.length !== before) {
        assert.equal(run.journal.length, before + 1)
        recorded.add(run.journal.at(-1).type)
        assertReplayMatches(run)
        decisions += 1
      }
    }
    assert.equal(run.machineState, 'ended')
    const replayed = replayCampaignJournal({ seed, ruleset: BASELINE_RULESET, journal: run.journal })
    const fight = getCampaignFight(getCampaignMapNode(replayed.activeNodeId).contentId)
    if (run.outcome.result === 'victory') {
      assert.equal(replayed.activeNodeId, 'finale')
      assert.deepEqual(run.route.nodes, completeRouteNode(replayed.routeNodes, 'finale'))
      assert.equal(run.health, replayed.health)
    } else {
      assert.deepEqual(run.route.nodes, replayed.routeNodes)
      assert.equal(run.health, Math.max(0, replayed.health - fight.damage))
    }
    assert.equal(run.currency, replayed.currency)
    assert.deepEqual(playerCards(run), replayed.playerCards)
    outcomes.push([seed, plan, run.outcome.result, decisions === run.journal.length])
  }
  assert.deepEqual(outcomes, [
    [0, 'market', 'defeat', true],
    [7, 'shrine', 'victory', true],
    [1, 'soldOut', 'victory', true],
    [2, 'market', 'defeat', true],
  ])
  assert.deepEqual([...recorded].sort(), [...JOURNAL_ENTRY_TYPES].sort())
})

test('replay rejects entries that were not legal at their point in the run', () => {
  const drafted = winEncounter(gate())
  const claimed = claimReward(drafted, 'mend')
  const base = claimed.journal
  const market = chooseRoute(claimed, 'market')
  const stock = Object.fromEntries(market.shop.items.map((item) => [item.itemId, item]))
  assert.equal(market.currency, 3)
  assert.deepEqual(
    market.shop.items.map(({ itemId, kind, price }) => [itemId, kind, price]),
    [['card-1', 'add', 3], ['service-1', 'remove', 2], ['modifier-1', 'modifier', 4]],
  )
  const added = claimReward(drafted, 'new-card').journal.at(-1)
  assert.equal(added.createdInstanceId, 'player-027')
  const vow = claimReward(drafted, 'modifier').journal.at(-1)
  const removed = claimReward(drafted, 'deck-edit', 'player-002').journal.at(-1)
  let weakened = retryEncounter(loseEncounter(gate('campaign-journal-weak')))
  weakened = retryEncounter(loseEncounter(weakened))
  const weakShrine = chooseRoute(claimReward(winEncounter(weakened), 'new-card'), 'shrine')
  assert.equal(weakShrine.health, 1)
  const finished = (() => {
    let run = gate('campaign-journal-final')
    const counters = createExpeditionCounters()
    while (run.machineState !== 'ended') run = stepExpedition(run, EXPEDITION_PLANS.market, counters)
    return run
  })()
  assert.deepEqual(finished.journal.at(-1), nodeEntry('retry', 'finale'))
  assert.equal(replay(finished.journal).phase, 'fight')
  const camp = restFixtureRun()
  assert.deepEqual(camp.journal.at(-1), route('camp'))
  const campStep = camp.journal.length
  const trainTarget = getCampaignRestTargets(camp, 'train')[0].instanceId
  const trained = chooseRestOption(camp, 'train', trainTarget).journal.at(-1)
  assert.match(trained.createdInstanceId, /^player-\d{3}$/)

  const cases = [
    ['an unknown node', [route('moon')], /entry 0 names an unknown route node/],
    ['a locked node', [route('market')], /entry 0 must choose an available route node/],
    ['a route during a fight', [route('gate'), route('market')], /entry 1 chooses a route node away from the route map/],
    ['a completed node', [...base, route('gate')], /entry 2 must choose an available route node/],
    ['a bypassed node', [...base, route('market'), nodeEntry('leaveShop', 'market'), route('shrine')],
      /entry 4 must choose an available route node/],
    ['entries out of order', [base[1], base[0]], /entry 0 must act on the active fight node/],
    ['a retry at a shop', [...base, route('market'), nodeEntry('retry', 'market')],
      /entry 3 must act on the active fight node/],
    ['a retry for another fight', [route('gate'), nodeEntry('retry', 'court')],
      /entry 1 must act on the active fight node/],
    ['a retry that ends the run', [route('gate'), ...Array(3).fill(nodeEntry('retry', 'gate'))],
      /entry 3 retries a fight that ended the run/],
    ['an unknown offer', [route('gate'), { ...added, offerId: 'treasure' }],
      /entry 1 must match its regenerated reward draft/],
    ['another card', [route('gate'), { ...added, cardId: 'c-2S' }], /must match its regenerated reward draft/],
    ['another kind', [route('gate'), { ...removed, kind: 'duplicate' }], /must match its regenerated reward draft/],
    ['a skipped instance', [route('gate'), { ...added, createdInstanceId: 'player-028' }],
      /entry 1 must record the next player instance ID/],
    ['a missing instance', [route('gate'), { ...added, createdInstanceId: null }],
      /must record the next player instance ID/],
    ['a modifier target', [route('gate'), { ...vow, targetInstanceId: 'player-002' }],
      /entry 1 must not record a target or created card/],
    ['a stranger removed', [route('gate'), { ...removed, targetInstanceId: 'opponent-1-1-001' }],
      /entry 1 must target an eligible player card/],
    ['an untargeted removal', [route('gate'), { ...removed, targetInstanceId: null }],
      /must target an eligible player card/],
    ['a reward for the final fight', [...finished.journal, { ...base[1], nodeId: 'finale' }],
      new RegExp(`entry ${finished.journal.length} claims a reward for the boss, which offers none`)],
    ['an unknown item', [...market.journal, purchaseOf({ ...stock['card-1'], itemId: 'card-9' }, 'market')],
      /entry 3 must match its regenerated shop stock/],
    ['another price', [...market.journal, purchaseOf({ ...stock['card-1'], price: 2 }, 'market')],
      /entry 3 must match its regenerated shop stock/],
    ['another stocked card', [...market.journal, purchaseOf({ ...stock['card-1'], cardId: 'c-4S' }, 'market')],
      /must match its regenerated shop stock/],
    ['a sold item', [
      ...market.journal,
      purchaseOf(stock['service-1'], 'market', 'player-002'),
      purchaseOf(stock['service-1'], 'market', 'player-003'),
    ], /entry 4 buys an unavailable item \(sold\)/],
    ['an unaffordable item', [...market.journal, purchaseOf(stock['modifier-1'], 'market')],
      /entry 3 buys an unavailable item \(unaffordable\)/],
    ['a purchase away from the shop', [...base, purchaseOf(stock['card-1'], 'market', null, 'player-027')],
      /entry 2 must act on the active shop node/],
    ['an event at a shop', [...market.journal, event('market', 'walk-on')],
      /entry 3 must act on the active event node/],
    ['leaving an event', [...base, route('shrine'), nodeEntry('leaveShop', 'shrine')],
      /entry 3 must act on the active shop node/],
    ['an unknown option', [...base, route('shrine'), event('shrine', 'pray')],
      /entry 3 must choose an option of its event/],
    ['a vault option at the shrine', [...base, route('shrine'), event('shrine', 'pay-for-a-copy', 'player-002', 'player-027')],
      /must choose an option of its event/],
    ['a blocked option', [...weakShrine.journal, event('shrine', 'bleed-for-fortune')],
      new RegExp(`entry ${weakShrine.journal.length} chooses an unavailable event option \\(health-too-low\\)`)],
    ['a target on walk-on', [...base, route('shrine'), event('shrine', 'walk-on', 'player-002')],
      /entry 3 must not record a target/],
    ['a card from walk-on', [...base, route('shrine'), event('shrine', 'walk-on', null, 'player-027')],
      /entry 3 must not record a created card/],
    ['an untargeted burn', [...base, route('shrine'), event('shrine', 'burn-an-offering')],
      /entry 3 must target an eligible player card/],
    ['a rest at the shrine', [...base, route('shrine'), rest('shrine', 'walk-on')],
      /entry 3 must act on the active rest node/],
  ]
  for (const [name, journal, message] of cases) {
    assert.throws(() => replay(journal), message, name)
  }

  // The camp fixture follows its own seed, so its cases replay with that seed.
  const campCases = [
    ['an event at the camp', [...camp.journal, event('camp', 'walk-on')],
      new RegExp(`entry ${campStep} must act on the active event node`)],
    ['leaving the camp like a shop', [...camp.journal, nodeEntry('leaveShop', 'camp')],
      new RegExp(`entry ${campStep} must act on the active shop node`)],
    ['an unknown rest option', [...camp.journal, rest('camp', 'pray')],
      new RegExp(`entry ${campStep} must choose an option of its rest site`)],
    ['a sanctum option at the camp', [...camp.journal, rest('camp', 'cleanse', trainTarget)],
      /must choose an option of its rest site/],
    ['a target on a rest', [...camp.journal, rest('camp', 'rest', trainTarget)],
      new RegExp(`entry ${campStep} must not record a target`)],
    ['a card from a rest', [...camp.journal, rest('camp', 'rest', null, trained.createdInstanceId)],
      new RegExp(`entry ${campStep} must not record a created card`)],
    ['an untargeted training', [...camp.journal, rest('camp', 'train')],
      new RegExp(`entry ${campStep} must target an eligible player card`)],
    ['a training without its copy', [...camp.journal, { ...trained, createdInstanceId: null }],
      new RegExp(`entry ${campStep} must record the next player instance ID`)],
    ['a training at the sanctum', [...camp.journal, { ...trained, nodeId: 'sanctum' }],
      new RegExp(`entry ${campStep} must act on the active rest node`)],
  ]
  for (const [name, journal, message] of campCases) {
    assert.throws(
      () => replayCampaignJournal({ seed: camp.rng.seed, ruleset: camp.ruleset, journal }),
      message,
      name,
    )
  }

  const bought = replay([
    ...market.journal,
    purchaseOf(stock['service-1'], 'market', 'player-002'),
    nodeEntry('leaveShop', 'market'),
  ])
  assert.equal(bought.currency, 1)
  assert.equal(bought.playerCards.length, 25)
  assert.equal(bought.phase, 'route')
  assert.equal(bought.shopItems, null)
})

test('replay cannot see Hold, so live decisions enforce Hold rules before logging', () => {
  const stageFour = claimReward(
    winEncounter(passThrough(
      claimReward(winEncounter(holdCard(gate(), 'player-001')), 'mend'),
      'shrine',
      'court',
    )),
    'mend',
  )
  const vault = chooseRoute(stageFour, 'vault')
  assert.equal(vault.hold, 'player-001')
  const step = vault.journal.length

  // A surrender of another card, or of a card while Hold is empty, replays because the
  // journal does not record Hold. The live vault refuses both before anything is logged.
  const surrendered = replay([...vault.journal, event('vault', 'surrender-held-card', 'player-005')])
  assert.ok(!surrendered.playerCards.some(({ instanceId }) => instanceId === 'player-005'))
  assert.ok(surrendered.playerCards.some(({ instanceId }) => instanceId === 'player-001'))
  assert.equal(surrendered.activeModifiers.at(-1).id, 'hold-insight-v1')
  assert.equal(surrendered.phase, 'route')
  assert.throws(
    () => chooseCampaignEventOption(vault, {
      nodeId: 'vault',
      step,
      optionId: 'surrender-held-card',
      targetInstanceId: 'player-005',
    }),
    /Surrendering Hold must name the held card/,
  )

  const emptyHold = chooseRoute(claimReward(winEncounter(passThrough(
    claimReward(winEncounter(gate('campaign-journal-empty')), 'mend'),
    'shrine',
    'court',
  )), 'mend'), 'vault')
  assert.equal(emptyHold.hold, null)
  assert.deepEqual(emptyHold.journal, vault.journal)
  assert.throws(
    () => chooseCampaignEventOption(emptyHold, {
      nodeId: 'vault',
      step,
      optionId: 'surrender-held-card',
      targetInstanceId: 'player-001',
    }),
    /Event option surrender-held-card is unavailable: hold-empty/,
  )

  // Burning the held card replays too; the live shrine leaves it out of the targets.
  assert.deepEqual(vault.journal[2], route('shrine'))
  const burned = replay([
    ...vault.journal.slice(0, 3),
    event('shrine', 'burn-an-offering', 'player-001'),
  ])
  assert.ok(!burned.playerCards.some(({ instanceId }) => instanceId === 'player-001'))

  for (const targetInstanceId of [null, 'player-099', 'opponent-4-1-001']) {
    assert.throws(
      () => replay([...vault.journal, event('vault', 'surrender-held-card', targetInstanceId)]),
      /must surrender a player card/,
    )
  }
  assert.throws(
    () => replay([...vault.journal, event('vault', 'surrender-held-card', 'player-001', 'player-027')]),
    /must not record a created card/,
  )
})

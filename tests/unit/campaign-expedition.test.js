import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CAMPAIGN_CARD_COPY_LIMIT,
  CAMPAIGN_DECK_SIZE_LIMITS,
  CAMPAIGN_MAX_HEALTH,
  CAMPAIGN_MEND_HEALTH,
  CAMPAIGN_SHOP_PRICES,
  CAMPAIGN_STARTER_CARD_IDS,
  CAMPAIGN_STARTING_HEALTH,
  getCampaignFight,
  getCampaignNodeEvent,
} from '../../src/domain/campaign-content.js'
import { deckEditRequiresTarget } from '../../src/domain/campaign-deck.js'
import { replayCampaignJournal } from '../../src/domain/campaign-journal.js'
import {
  HOLD_POSITION,
  createCampaignRun,
  getCampaignEventOptions,
  getCampaignEventTargets,
  getCampaignShopOffers,
  getCampaignShopTargets,
  validateCampaignState,
} from '../../src/domain/campaign-machine.js'
import {
  CAMPAIGN_MAP,
  CAMPAIGN_START_NODE_ID,
  getCampaignMapNode,
} from '../../src/domain/campaign-map.js'
import { VITALITY_CAP_MODIFIER_ID, getCampaignModifier } from '../../src/domain/campaign-modifiers.js'
import { BASELINE_RULESET } from '../../src/domain/ruleset.js'
import {
  activeNodeId,
  buyShopItem,
  chooseEventOption,
  createExpeditionCounters,
  leaveShop,
  stepExpedition,
} from '../fixtures/campaign-route.js'

// Whole expeditions checked against a ledger built only from the campaign content: fight
// bounties and damage, shop prices, event costs and gains, modifier healing, and deck edits.

function routesFrom(nodeId) {
  const { next } = getCampaignMapNode(nodeId)
  if (next.length === 0) return [[nodeId]]
  return next.flatMap((id) => routesFrom(id).map((rest) => [nodeId, ...rest]))
}

const ROUTES = Object.freeze(routesFrom(CAMPAIGN_START_NODE_ID))

// Contrasts the scripted policy: shops sell their last available item and events take their
// last available option other than Walk on, each with the last eligible target. Rewards
// rotate two places ahead of the scripted rotation, so the first claim is the modifier.
function contrastingStep(run, plan, counters) {
  if (run.machineState === 'awaitingShop') {
    const item = getCampaignShopOffers(run).findLast(({ blocker }) => blocker === null)
    if (item === undefined) return leaveShop(run)
    counters.purchases.push(item.itemId)
    return buyShopItem(
      run,
      item.itemId,
      deckEditRequiresTarget(item.kind)
        ? getCampaignShopTargets(run, item.itemId).at(-1).instanceId
        : null,
    )
  }
  if (run.machineState === 'awaitingEvent') {
    const option = getCampaignEventOptions(run)
      .findLast(({ blocker, optionId }) => blocker === null && optionId !== 'walk-on')
    if (option === undefined) return chooseEventOption(run, 'walk-on')
    counters.events.push(option.optionId)
    const target = getCampaignEventTargets(run, option.optionId).at(-1)
    return chooseEventOption(run, option.optionId, target?.instanceId ?? null)
  }
  return stepExpedition(run, plan, counters)
}

const POLICIES = Object.freeze({
  scripted: { step: stepExpedition, counters: createExpeditionCounters },
  contrasting: {
    step: contrastingStep,
    counters: () => ({ ...createExpeditionCounters(), rewards: 2 }),
  },
})

function instanceId(sequence) {
  return `player-${String(sequence).padStart(3, '0')}`
}

function cardEntries(cards) {
  return new Map(cards.map((card) => [card.instanceId, card.cardId]))
}

function playerCards(run) {
  return run.cards.filter(({ campaignOwner }) => campaignOwner === 'player')
}

function createLedger() {
  const cards = new Map(CAMPAIGN_STARTER_CARD_IDS.map((cardId, index) => [
    instanceId(index + 1),
    cardId,
  ]))
  return {
    health: CAMPAIGN_STARTING_HEALTH,
    flows: { bounties: 0, coinGains: 0, prices: 0, coinCosts: 0 },
    cards,
    issued: cards.size,
    modifiers: [{ id: VITALITY_CAP_MODIFIER_ID, grantedAtNodeId: null }],
    visited: [],
    sold: new Set(),
    coverage: new Set(),
  }
}

function heal(ledger, amount) {
  if (amount > 0 && ledger.health + amount > CAMPAIGN_MAX_HEALTH) {
    ledger.coverage.add('capped heal')
  }
  ledger.health = Math.min(CAMPAIGN_MAX_HEALTH, ledger.health + amount)
}

function gainModifier(ledger, modifierId, nodeId) {
  ledger.modifiers.push({ id: modifierId, grantedAtNodeId: nodeId })
  heal(ledger, getCampaignModifier(modifierId).healthOnGain)
}

// Targeted edits name an owned card other than the held one, and every created card takes
// the next instance ID never issued before.
function editDeck(ledger, held, { kind, cardId }, { targetInstanceId, createdInstanceId }) {
  if (kind === 'add') {
    assert.equal(targetInstanceId, null)
  } else {
    assert.ok(ledger.cards.has(targetInstanceId), `${kind} targets a player card`)
    assert.notEqual(targetInstanceId, held, `${kind} never targets the held card`)
  }
  if (kind === 'remove') {
    assert.equal(createdInstanceId, null)
  } else {
    ledger.issued += 1
    assert.equal(createdInstanceId, instanceId(ledger.issued), `${kind} issues the next instance`)
  }
  const createdCardId = kind === 'duplicate' ? ledger.cards.get(targetInstanceId) : cardId
  if (kind === 'remove' || kind === 'replace') ledger.cards.delete(targetInstanceId)
  if (kind !== 'remove') ledger.cards.set(createdInstanceId, createdCardId)
}

function slotOf(itemId) {
  return itemId.slice(0, itemId.lastIndexOf('-'))
}

function stateOf(run, nodeId) {
  return run.route.nodes.find(({ id }) => id === nodeId).state
}

function assertEncounterEntered(run, node) {
  const fight = getCampaignFight(node.contentId)
  assert.equal(run.machineState, 'ready')
  assert.equal(run.encounter.id, fight.id)
  assert.equal(run.encounter.damage, fight.damage)
  assert.deepEqual(
    run.cards
      .filter(({ campaignOwner }) => campaignOwner === 'opponent')
      .map(({ cardId }) => cardId)
      .sort(),
    [...fight.opponentCardIds].sort(),
  )
}

function recordReward(ledger, prev, entry, node) {
  assert.equal(prev.machineState, 'awaitingReward')
  const offer = prev.pendingReward.offers.find(({ offerId }) => offerId === entry.offerId)
  assert.deepEqual(
    [entry.kind, entry.cardId, entry.modifierId],
    [offer.kind, offer.cardId, offer.modifierId],
  )
  ledger.coverage.add(`reward ${offer.kind}`)
  const kept = ledger.modifiers
    .filter(({ id }) => getCampaignModifier(id).lifetime !== 'encounter')
  if (kept.length !== ledger.modifiers.length) ledger.coverage.add('expired modifier')
  ledger.modifiers = kept
  if (offer.kind === 'mend') heal(ledger, CAMPAIGN_MEND_HEALTH)
  else if (offer.kind === 'modifier') gainModifier(ledger, offer.modifierId, node.id)
  else editDeck(ledger, prev.hold, offer, entry)
  ledger.flows.bounties += getCampaignFight(node.contentId).bounty
}

function recordPurchase(ledger, prev, next, entry, node) {
  assert.equal(prev.machineState, 'awaitingShop')
  const item = prev.shop.items.find(({ itemId }) => itemId === entry.itemId)
  const key = `${node.id} ${item.itemId}`
  assert.ok(!ledger.sold.has(key), `${key} is sold at most once`)
  ledger.sold.add(key)
  assert.equal(entry.price, CAMPAIGN_SHOP_PRICES[slotOf(item.itemId)])
  ledger.coverage.add(`purchase ${item.kind}`)
  ledger.flows.prices += entry.price
  if (item.kind === 'modifier') gainModifier(ledger, item.modifierId, node.id)
  else editDeck(ledger, prev.hold, item, entry)
  assert.deepEqual(next.shop.items, prev.shop.items.map((candidate) => (
    candidate.itemId === item.itemId ? { ...candidate, sold: true } : candidate
  )))
  if (next.shop.items.every(({ sold }) => sold)) ledger.coverage.add('sold out')
}

function recordEvent(ledger, prev, entry, node) {
  assert.equal(prev.machineState, 'awaitingEvent')
  const option = getCampaignNodeEvent(node.contentId).options
    .find(({ id }) => id === entry.optionId)
  ledger.coverage.add(`event ${option.id}`)
  ledger.health -= option.healthCost
  ledger.flows.coinCosts += option.coinCost
  if (option.surrenderHold) {
    assert.notEqual(prev.hold, null)
    assert.equal(entry.targetInstanceId, prev.hold)
    assert.equal(entry.createdInstanceId, null)
    ledger.cards.delete(prev.hold)
  } else if (option.deckEdit !== null) {
    editDeck(ledger, prev.hold, option.deckEdit, entry)
  } else {
    assert.equal(entry.targetInstanceId, null)
    assert.equal(entry.createdInstanceId, null)
  }
  if (option.modifierId !== null) gainModifier(ledger, option.modifierId, node.id)
  heal(ledger, option.healthGain)
  ledger.flows.coinGains += option.coinGain
}

function recordDecision(ledger, prev, next, entry) {
  const node = getCampaignMapNode(entry.nodeId)
  ledger.coverage.add(entry.type)
  if (entry.type === 'route') {
    assert.equal(prev.machineState, 'awaitingRoute')
    assert.equal(stateOf(prev, node.id), 'available', `${node.id} is entered only when available`)
    ledger.visited.push(node.id)
    if (node.kind === 'fight') assertEncounterEntered(next, node)
    if (node.kind === 'shop') {
      for (const item of next.shop.items) {
        assert.equal(item.sold, false)
        assert.equal(item.price, CAMPAIGN_SHOP_PRICES[slotOf(item.itemId)])
      }
    }
    return
  }
  if (entry.type === 'retry') {
    assert.equal(prev.machineState, 'awaitingRetry')
    assert.equal(next.encounterAttempt, prev.encounterAttempt + 1)
    assertEncounterEntered(next, node)
    return
  }
  if (entry.type === 'reward') recordReward(ledger, prev, entry, node)
  else if (entry.type === 'purchase') recordPurchase(ledger, prev, next, entry, node)
  else if (entry.type === 'event') recordEvent(ledger, prev, entry, node)
  else assert.equal(prev.machineState, 'awaitingShop')
  if (entry.type !== 'purchase') {
    assert.equal(next.machineState, 'awaitingRoute')
    assert.equal(stateOf(next, node.id), 'completed')
  }
}

function recordStep(ledger, prev, next) {
  if (next.journal.length !== prev.journal.length) {
    assert.equal(next.journal.length, prev.journal.length + 1, 'one decision per step')
    recordDecision(ledger, prev, next, next.journal.at(-1))
    return
  }
  assert.notEqual(prev.encounter, null, 'only fights advance without a decision')
  if (next.machineState === 'awaitingRetry' || next.outcome?.result === 'defeat') {
    const { damage } = getCampaignFight(getCampaignMapNode(activeNodeId(prev)).contentId)
    ledger.coverage.add('lost fight')
    ledger.health = Math.max(0, ledger.health - damage)
  }
}

function assertLedger(ledger, run, where) {
  const { bounties, coinGains, prices, coinCosts } = ledger.flows
  assert.equal(run.currency, bounties + coinGains - prices - coinCosts, `${where}: coins`)
  assert.ok(run.currency >= 0, `${where}: coins never go negative`)
  assert.equal(run.health, ledger.health, `${where}: health`)
  assert.equal(run.maxHealth, CAMPAIGN_MAX_HEALTH)
  assert.deepEqual(
    run.activeModifiers.map(({ id, grantedAtNodeId }) => ({ id, grantedAtNodeId })),
    ledger.modifiers,
    `${where}: modifiers`,
  )
  const players = playerCards(run)
  assert.deepEqual(cardEntries(players), ledger.cards, `${where}: player cards`)
  assert.ok(players.length >= CAMPAIGN_DECK_SIZE_LIMITS.minimum)
  assert.ok(players.length <= CAMPAIGN_DECK_SIZE_LIMITS.maximum)
  const copies = new Map()
  for (const { cardId } of players) copies.set(cardId, (copies.get(cardId) ?? 0) + 1)
  assert.ok(Math.max(...copies.values()) <= CAMPAIGN_CARD_COPY_LIMIT, `${where}: copy limit`)
  assert.equal(run.deckLayout.includes(HOLD_POSITION), run.hold !== null)
  assert.deepEqual(
    run.deckLayout.map((entry) => (entry === HOLD_POSITION ? run.hold : entry)).sort(),
    [...ledger.cards.keys()].sort(),
    `${where}: deck layout`,
  )
  const ids = run.cards.map((card) => card.instanceId)
  assert.equal(new Set(ids).size, ids.length, `${where}: unique instances`)
  if (run.encounter === null) {
    assert.equal(players.length, ids.length)
    return
  }
  const { zones } = run.encounter
  const placed = [
    ...zones.playerSourcePile,
    ...zones.opponentSourcePile,
    ...zones.player.drawPile,
    ...zones.player.wonPile,
    ...zones.opponent.drawPile,
    ...zones.opponent.wonPile,
    ...zones.burnPile,
    ...[...zones.contestedPile, ...zones.inPlay].map((record) => record.instanceId),
    ...(run.hold === null ? [] : [run.hold]),
  ]
  assert.deepEqual(placed.sort(), ids.sort(), `${where}: each card is in exactly one zone`)
}

// The visited node of each stage is completed, or active for the fight that ended the run
// in defeat. Every other node of those stages is bypassed; later stages stay locked.
function assertFinalRoute(run, ledger, route, where) {
  const defeat = run.outcome.result === 'defeat'
  assert.deepEqual(ledger.visited, defeat ? route.slice(0, ledger.visited.length) : route)
  if (defeat) assert.equal(run.health, 0)
  const last = ledger.visited.at(-1)
  const lastStage = getCampaignMapNode(last).stage
  assert.deepEqual(run.route.nodes, CAMPAIGN_MAP.nodes.map(({ id, stage }) => {
    if (stage > lastStage) return { id, state: 'locked' }
    if (defeat && id === last) return { id, state: 'active' }
    return { id, state: ledger.visited.includes(id) ? 'completed' : 'bypassed' }
  }), `${where}: route`)
}

function playExpedition(policyName, seed, route) {
  const policy = POLICIES[policyName]
  const where = `${policyName} seed ${seed} via ${route.join('/')}`
  let run = createCampaignRun({
    runId: `campaign-expedition-${seed}`,
    seed,
    ruleset: BASELINE_RULESET,
  })
  const counters = policy.counters()
  const ledger = createLedger()
  assertLedger(ledger, run, where)
  for (let step = 0; run.machineState !== 'ended'; step += 1) {
    assert.ok(step < 5000, `${where} ends`)
    const next = policy.step(run, route, counters)
    recordStep(ledger, run, next)
    assertLedger(ledger, next, `${where} step ${step}`)
    run = next
  }
  ledger.coverage.add(run.outcome.result)
  assertFinalRoute(run, ledger, route, where)
  assert.doesNotThrow(() => validateCampaignState(run))
  const replayed = replayCampaignJournal({ seed, ruleset: BASELINE_RULESET, journal: run.journal })
  assert.equal(replayed.currency, run.currency)
  assert.deepEqual(cardEntries(replayed.playerCards), ledger.cards)
  return { run, ledger, counters }
}

test('every expedition route balances coins, health, cards, and modifiers with a content ledger', () => {
  assert.equal(ROUTES.length, 8)
  const outcomes = []
  const coverage = new Set()
  for (const [policy, seed] of [['scripted', 3], ['contrasting', 0]]) {
    for (const route of ROUTES) {
      const { run, ledger, counters } = playExpedition(policy, seed, route)
      outcomes.push(`${policy} ${route.slice(1, -1).join('/')}: ${run.outcome.result}, ${counters.retries} retries`)
      for (const item of ledger.coverage) coverage.add(item)
    }
  }
  assert.deepEqual(outcomes, [
    'scripted market/court/bazaar: victory, 0 retries',
    'scripted market/court/vault: victory, 0 retries',
    'scripted market/watch/bazaar: victory, 0 retries',
    'scripted market/watch/vault: victory, 0 retries',
    'scripted shrine/court/bazaar: victory, 0 retries',
    'scripted shrine/court/vault: victory, 0 retries',
    'scripted shrine/watch/bazaar: victory, 0 retries',
    'scripted shrine/watch/vault: defeat, 0 retries',
    'contrasting market/court/bazaar: victory, 1 retries',
    'contrasting market/court/vault: victory, 1 retries',
    'contrasting market/watch/bazaar: victory, 1 retries',
    'contrasting market/watch/vault: victory, 1 retries',
    'contrasting shrine/court/bazaar: victory, 1 retries',
    'contrasting shrine/court/vault: victory, 1 retries',
    'contrasting shrine/watch/bazaar: victory, 1 retries',
    'contrasting shrine/watch/vault: victory, 1 retries',
  ])
  assert.deepEqual([...coverage].sort(), [
    'capped heal',
    'defeat',
    'event',
    'event bleed-for-fortune',
    'event burn-an-offering',
    'event pay-for-a-copy',
    'event surrender-held-card',
    'leaveShop',
    'lost fight',
    'purchase',
    'purchase add',
    'purchase duplicate',
    'purchase modifier',
    'purchase remove',
    'purchase replace',
    'retry',
    'reward',
    'reward add',
    'reward mend',
    'reward modifier',
    'reward remove',
    'route',
    'sold out',
    'victory',
  ])
})

test('the same seed, route, and policy replay to an identical expedition', () => {
  // Seed 3 bleeds at the shrine, surrenders Hold at the vault, and falls at the finale. Seed
  // 6 drafts Spoils of War at the gate; it expires at the court reward and is bought again
  // at the bazaar.
  for (const [policy, seed, route, highlight] of [
    ['scripted', 3, ['gate', 'shrine', 'watch', 'vault', 'finale'], 'defeat'],
    ['contrasting', 6, ['gate', 'market', 'court', 'bazaar', 'finale'], 'expired modifier'],
  ]) {
    const first = playExpedition(policy, seed, route)
    const second = playExpedition(policy, seed, route)
    assert.deepEqual(second.run, first.run)
    assert.deepEqual(second.counters, first.counters)
    assert.ok(first.ledger.coverage.has(highlight), `${policy} seed ${seed} covers ${highlight}`)
  }
})

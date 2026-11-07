import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CAMPAIGN_CARD_COPY_LIMIT,
  CAMPAIGN_DECK_SIZE_LIMITS,
  CAMPAIGN_MAX_HEALTH,
  CAMPAIGN_MEND_HEALTH_BY_TIER,
  CAMPAIGN_NODE_HEAL_LIMIT,
  CAMPAIGN_SHOP_PRICES,
  CAMPAIGN_STARTER_CARD_IDS,
  CAMPAIGN_STARTING_HEALTH,
  getCampaignFight,
  getCampaignNodeEvent,
  getCampaignRestSite,
} from '../../src/domain/campaign-content.js'
import { deckEditRequiresTarget } from '../../src/domain/campaign-deck.js'
import { replayCampaignJournal } from '../../src/domain/campaign-journal.js'
import {
  CAMPAIGN_HOLD_DECISION_STATES,
  HOLD_POSITION,
  createCampaignRun,
  getCampaignEventOptions,
  getCampaignEventTargets,
  getCampaignRestOptions,
  getCampaignRestTargets,
  getCampaignShopOffers,
  getCampaignShopTargets,
  getEligibleHoldTargets,
  validateCampaignState,
} from '../../src/domain/campaign-machine.js'
import {
  CAMPAIGN_FINAL_NODE_ID,
  CAMPAIGN_MAP,
  CAMPAIGN_START_NODE_ID,
  getCampaignMapNode,
} from '../../src/domain/campaign-map.js'
import {
  VITALITY_CAP_MODIFIER_ID,
  encounterTraitIds,
  getCampaignModifier,
  isOpponentTraitId,
} from '../../src/domain/campaign-modifiers.js'
import { getCard } from '../../src/domain/cards.js'
import { createRng } from '../../src/domain/rng.js'
import { BASELINE_RULESET } from '../../src/domain/ruleset.js'
import {
  EDGE_COVERING_ROUTES,
  buyShopItem,
  chooseEventOption,
  chooseRestOption,
  chooseRoute,
  claimReward,
  createExpeditionCounters,
  leaveShop,
  stepExpedition,
  winEncounter,
} from '../fixtures/campaign-route.js'

// Whole expeditions checked against a ledger built only from the campaign content: fight
// bounties, damage, and Mend by tier; shop prices; event and rest costs and gains; modifier
// healing; deck edits; and the RNG draws each step may take.

const COURT_ETIQUETTE_TRAIT_ID = 'court-etiquette-v1'
const PLUNDER_TRAIT_ID = 'plunder-v1'
const SPOILS_OF_WAR_MODIFIER_ID = 'spoils-of-war-v1'
const ETIQUETTE_RANKS = getCampaignModifier(COURT_ETIQUETTE_TRAIT_ID).effect.ranks
// Mulberry32 advances its state by 0x6D2B79F5 per draw; this is its inverse modulo 2^32.
const MULBERRY32_INVERSE = 0xDC58AA5D

function routesFrom(nodeId) {
  const { next } = getCampaignMapNode(nodeId)
  if (next.length === 0) return [[nodeId]]
  return next.flatMap((id) => routesFrom(id).map((rest) => [nodeId, ...rest]))
}

const ROUTES = Object.freeze(routesFrom(CAMPAIGN_START_NODE_ID))

// Contrasts the scripted policy: shops sell their last available item and events take their
// last available option other than Walk on, each with the last eligible target. Rest sites
// walk on at full health and otherwise take their deck edit with the last eligible target,
// resting only when the edit is blocked. Rewards rotate two places ahead of the scripted
// rotation, so the first claim is the modifier.
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
  if (run.machineState === 'awaitingRest') {
    const options = getCampaignRestOptions(run)
    const option = run.health === run.maxHealth
      ? undefined
      : options.find(({ blocker, deckEdit }) => blocker === null && deckEdit !== null)
        ?? options.find(({ healthGain }) => healthGain > 0)
    if (option === undefined) {
      counters.rests.push('walk-on')
      return chooseRestOption(run, 'walk-on')
    }
    counters.rests.push(option.optionId)
    const target = getCampaignRestTargets(run, option.optionId).at(-1)
    return chooseRestOption(run, option.optionId, target?.instanceId ?? null)
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
  assert.equal(run.encounter.tier, fight.tier)
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
  const { tier, bounty } = getCampaignFight(node.contentId)
  if (offer.kind === 'mend') {
    if (tier === 'elite') ledger.coverage.add('greater mend')
    heal(ledger, CAMPAIGN_MEND_HEALTH_BY_TIER[tier])
  } else if (offer.kind === 'modifier') {
    gainModifier(ledger, offer.modifierId, node.id)
  } else {
    editDeck(ledger, prev.hold, offer, entry)
  }
  ledger.flows.bounties += bounty
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

// Event and rest options share one shape that states every cost, gain, and deck edit.
function recordOption(ledger, prev, entry, option, nodeId) {
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
  if (option.modifierId !== null) gainModifier(ledger, option.modifierId, nodeId)
  heal(ledger, option.healthGain)
  ledger.flows.coinGains += option.coinGain
}

function findOption({ options }, optionId) {
  return options.find(({ id }) => id === optionId)
}

function recordDecision(ledger, prev, next, entry) {
  const node = getCampaignMapNode(entry.nodeId)
  ledger.coverage.add(entry.type)
  if (entry.type === 'route') {
    assert.equal(prev.machineState, 'awaitingRoute')
    assert.equal(stateOf(prev, node.id), 'available', `${node.id} is entered only when available`)
    ledger.visited.push(node.id)
    if (node.kind === 'fight') {
      assertEncounterEntered(next, node)
      if (next.encounter.tier === 'elite') ledger.coverage.add('elite')
    } else if (node.kind === 'shop') {
      for (const item of next.shop.items) {
        assert.equal(item.sold, false)
        assert.equal(item.price, CAMPAIGN_SHOP_PRICES[slotOf(item.itemId)])
      }
    } else if (node.kind === 'rest') {
      assert.equal(next.machineState, 'awaitingRest')
      assert.deepEqual(next.restSite, { nodeId: node.id, siteId: node.contentId })
    }
    return
  }
  if (entry.type === 'retry') {
    assert.equal(prev.machineState, 'awaitingRetry')
    assert.equal(next.encounterAttempt, prev.encounterAttempt + 1)
    assertEncounterEntered(next, node)
    return
  }
  if (entry.type === 'reward') {
    recordReward(ledger, prev, entry, node)
  } else if (entry.type === 'purchase') {
    recordPurchase(ledger, prev, next, entry, node)
  } else if (entry.type === 'event') {
    assert.equal(prev.machineState, 'awaitingEvent')
    const option = findOption(getCampaignNodeEvent(node.contentId), entry.optionId)
    ledger.coverage.add(`event ${option.id}`)
    recordOption(ledger, prev, entry, option, node.id)
  } else if (entry.type === 'rest') {
    assert.equal(prev.machineState, 'awaitingRest')
    const option = findOption(getCampaignRestSite(node.contentId), entry.optionId)
    ledger.coverage.add(`rest ${option.healthGain > 0 ? 'heal' : option.id}`)
    recordOption(ledger, prev, entry, option, node.id)
  } else {
    assert.equal(prev.machineState, 'awaitingShop')
  }
  if (entry.type !== 'purchase') {
    assert.equal(next.machineState, 'awaitingRoute')
    assert.equal(stateOf(next, node.id), 'completed')
  }
}

// Under burn rules the clash loser's revealed cards burn, unless the winner holds the
// effect that claims them: Spoils of War for the player, or Plunder for the opponent.
// Plunder suspends Spoils of War, so the player's wins against it always burn.
function recordSettlement(ledger, prev, event) {
  if (!prev.ruleset.burn.enabled) {
    assert.deepEqual(event.burned, [])
    return
  }
  const loser = event.winner === 'player' ? 'opponent' : 'player'
  const lost = event.reveals
    .filter(({ suppliedBy }) => suppliedBy === loser)
    .map(({ instanceId: id }) => id)
  const plunder = prev.encounter.traitIds.includes(PLUNDER_TRAIT_ID)
  const claimed = event.winner === 'player'
    ? !plunder && prev.activeModifiers.some(({ id }) => id === SPOILS_OF_WAR_MODIFIER_ID)
    : plunder
  assert.deepEqual(event.burned, claimed ? [] : lost)
  if (claimed && lost.length > 0) {
    ledger.coverage.add(event.winner === 'player' ? 'spoils' : 'plunder')
  }
}

// Court Etiquette leaves only 2–10 Hold targets, withholding every J–A the player controls.
function recordHoldTargets(ledger, run) {
  if (!run.encounter.traitIds.includes(COURT_ETIQUETTE_TRAIT_ID)) return
  for (const { cardId } of getEligibleHoldTargets(run)) {
    assert.ok(ETIQUETTE_RANKS.includes(getCard(cardId).rank), `${cardId} is a 2–10`)
  }
  const { drawPile, wonPile } = run.encounter.zones.player
  if ([...drawPile, ...wonPile].some((id) => (
    ledger.cards.has(id) && !ETIQUETTE_RANKS.includes(getCard(ledger.cards.get(id)).rank)
  ))) {
    ledger.coverage.add('etiquette')
  }
}

function recordStep(ledger, prev, next) {
  if (next.journal.length !== prev.journal.length) {
    assert.equal(next.journal.length, prev.journal.length + 1, 'one decision per step')
    recordDecision(ledger, prev, next, next.journal.at(-1))
    return
  }
  assert.notEqual(prev.encounter, null, 'only fights advance without a decision')
  if (prev.machineState === 'ready') recordHoldTargets(ledger, prev)
  if (next.turn !== prev.turn && next.pendingEvent.type === 'clashSettled') {
    recordSettlement(ledger, prev, next.pendingEvent)
  }
  if (next.machineState === 'awaitingRetry' || next.outcome?.result === 'defeat') {
    ledger.coverage.add('lost fight')
    ledger.health = Math.max(0, ledger.health - getCampaignFight(prev.encounter.id).damage)
  }
}

function drawsBetween(before, after) {
  return Math.imul((after.state - before.state) >>> 0, MULBERRY32_INVERSE) >>> 0
}

// Shuffling n cards draws n − 1 times.
function shuffleDraws(count) {
  return Math.max(count - 1, 0)
}

// Mirrors prepareSupply: once a side's source pile is spent, an empty draw pile is refilled
// by shuffling that side's won pile.
function recycleDraws(run, side) {
  const { supplyMode, zones } = run.encounter
  if (supplyMode[side] === 'source' && zones[`${side}SourcePile`].length > 0) return 0
  return zones[side].drawPile.length === 0 ? shuffleDraws(zones[side].wonPile.length) : 0
}

// The draws a step may take, derived from visible state alone. Entering or retrying a fight
// shuffles the non-held layout, then the opponent deck. Preparing a Hold decision prepares
// the player's supply, and with Hold Insight the opponent's as well. A clash recycles a
// side's won pile whenever that side reveals from an empty draw pile. Nothing else draws.
function expectedDraws(prev, next) {
  if (next.journal.length !== prev.journal.length) {
    const { type, nodeId } = next.journal.at(-1)
    if (type !== 'retry' && (type !== 'route' || getCampaignMapNode(nodeId).kind !== 'fight')) {
      return 0
    }
    return shuffleDraws(next.deckLayout.filter((entry) => entry !== HOLD_POSITION).length)
      + shuffleDraws(getCampaignFight(next.encounter.id).opponentCardIds.length)
  }
  if (CAMPAIGN_HOLD_DECISION_STATES.includes(next.machineState)) {
    return recycleDraws(prev, 'player')
      + (next.machineState === 'awaitingInformedHoldChoice' ? recycleDraws(prev, 'opponent') : 0)
  }
  if (next.turn === prev.turn) return 0
  const piles = {}
  for (const side of ['player', 'opponent']) {
    const { drawPile, wonPile } = prev.encounter.zones[side]
    piles[side] = { draw: drawPile.length, won: wonPile.length }
  }
  let draws = 0
  for (const { suppliedBy, from } of next.pendingEvent.reveals) {
    if (from !== `${suppliedBy}.drawPile`) continue
    const pile = piles[suppliedBy]
    if (pile.draw === 0) {
      draws += shuffleDraws(pile.won)
      pile.draw = pile.won
      pile.won = 0
    }
    pile.draw -= 1
  }
  return draws
}

function assertRngStep(prev, next, where) {
  assert.equal(drawsBetween(prev.rng, next.rng), expectedDraws(prev, next), `${where}: RNG draws`)
}

// Per-step invariants: the RNG ledger; traits exactly as authored and only on elites; no
// trait among the modifiers or in the journal; and no step heals past the node limit or the
// maximum.
function assertStep(prev, next, where) {
  assertRngStep(prev, next, where)
  assert.ok(next.health - prev.health <= CAMPAIGN_NODE_HEAL_LIMIT, `${where}: heal limit`)
  assert.ok(next.health <= next.maxHealth, `${where}: maximum health`)
  assert.ok(
    !next.activeModifiers.some(({ id }) => isOpponentTraitId(id)),
    `${where}: traits are never player modifiers`,
  )
  if (next.journal.length !== prev.journal.length) {
    assert.ok(
      !Object.values(next.journal.at(-1)).some((value) => isOpponentTraitId(value)),
      `${where}: the journal never names a trait`,
    )
  }
  if (next.encounter !== null) {
    const fight = getCampaignFight(next.encounter.id)
    assert.equal(next.encounter.tier, fight.tier, `${where}: tier`)
    assert.deepEqual(
      next.encounter.traitIds,
      encounterTraitIds(fight, next.ruleset),
      `${where}: traits`,
    )
    assert.ok(
      next.encounter.traitIds.length === 0 || fight.tier === 'elite',
      `${where}: only elites have traits`,
    )
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

// Plays from a new run until it ends, checking every step against the ledger.
function playLedger(seed, route, step, where) {
  let run = createCampaignRun({
    runId: `campaign-expedition-${seed}`,
    seed,
    ruleset: BASELINE_RULESET,
  })
  assert.deepEqual(run.rng, createRng(seed).snapshot(), `${where}: a new run draws nothing`)
  const ledger = createLedger()
  assertLedger(ledger, run, where)
  for (let index = 0; run.machineState !== 'ended'; index += 1) {
    assert.ok(index < 10000, `${where} ends`)
    const next = step(run)
    const at = `${where} step ${index}`
    assertStep(run, next, at)
    recordStep(ledger, run, next)
    assertLedger(ledger, next, at)
    run = next
  }
  ledger.coverage.add(run.outcome.result)
  if (ledger.visited.at(-1) === CAMPAIGN_FINAL_NODE_ID) {
    ledger.coverage.add(`boss ${run.outcome.result}`)
  }
  assertFinalRoute(run, ledger, route, where)
  assert.doesNotThrow(() => validateCampaignState(run))
  const replayed = replayCampaignJournal({ seed, ruleset: BASELINE_RULESET, journal: run.journal })
  assert.equal(replayed.currency, run.currency)
  assert.deepEqual(cardEntries(replayed.playerCards), ledger.cards)
  return { run, ledger }
}

function playExpedition(policyName, seed, route) {
  const policy = POLICIES[policyName]
  const counters = policy.counters()
  const { run, ledger } = playLedger(
    seed,
    route,
    (current) => policy.step(current, route, counters),
    `${policyName} seed ${seed} via ${route.join('/')}`,
  )
  return { run, ledger, counters }
}

const firstPlays = new Map()

// The first play of an expedition, shared by the tests that inspect it.
function firstPlay(policyName, seed, route) {
  const key = `${policyName} ${seed} ${route.join('/')}`
  if (!firstPlays.has(key)) firstPlays.set(key, playExpedition(policyName, seed, route))
  return firstPlays.get(key)
}

// Wins every fight without playing a clash, takes Mend, and passes every other node.
function structuralStep(run, route) {
  switch (run.machineState) {
    case 'awaitingRoute':
      return chooseRoute(run, route.find((id) => stateOf(run, id) === 'available'))
    case 'ready':
      return winEncounter(run)
    case 'awaitingReward':
      return claimReward(run, 'mend')
    case 'awaitingShop':
      return leaveShop(run)
    case 'awaitingEvent':
      return chooseEventOption(run, 'walk-on')
    case 'awaitingRest':
      return chooseRestOption(run, 'walk-on')
    default:
      throw new Error(`A structural expedition cannot continue from ${run.machineState}`)
  }
}

function links(route) {
  return route.slice(1).map((id, index) => `${route[index]}>${id}`)
}

const MAP_LINKS = CAMPAIGN_MAP.nodes.flatMap(({ id, next }) => next.map((to) => `${id}>${to}`)).sort()

test('every route alternates fights with other stops, climbs at most two elites, and ends at the boss', () => {
  assert.equal(ROUTES.length, 24)
  const tally = { elites: {}, rests: {} }
  for (const route of ROUTES) {
    const where = `structural via ${route.join('/')}`
    const nodes = route.map((id) => getCampaignMapNode(id))
    assert.deepEqual(nodes.map(({ stage }) => stage), [1, 2, 3, 4, 5, 6, 7])
    assert.deepEqual(
      nodes.map(({ kind }) => kind === 'fight'),
      [true, false, true, false, true, false, true],
    )
    const { run } = playLedger(0, route, (current) => structuralStep(current, route), where)
    assert.deepEqual(run.outcome, { result: 'victory', reason: 'campaignCompleted' })
    const tiers = nodes
      .filter(({ kind }) => kind === 'fight')
      .map(({ contentId }) => getCampaignFight(contentId).tier)
    assert.equal(tiers[0], 'normal', where)
    assert.equal(tiers.at(-1), 'boss', where)
    assert.equal(route.at(-1), CAMPAIGN_FINAL_NODE_ID)
    const elites = tiers.filter((tier) => tier === 'elite').length
    const rests = nodes.filter(({ kind }) => kind === 'rest').length
    tally.elites[elites] = (tally.elites[elites] ?? 0) + 1
    tally.rests[rests] = (tally.rests[rests] ?? 0) + 1
  }
  assert.deepEqual(tally, { elites: { 0: 6, 1: 12, 2: 6 }, rests: { 1: 16, 2: 8 } })

  // The edge-covering routes together use every map link.
  assert.ok(EDGE_COVERING_ROUTES.every((route) => (
    ROUTES.some((candidate) => candidate.join() === route.join())
  )))
  assert.deepEqual([...new Set(EDGE_COVERING_ROUTES.flatMap(links))].sort(), MAP_LINKS)
})

// One seed per policy plays every edge-covering route.
const FULL_PLAY_SEEDS = Object.freeze({ scripted: 12, contrasting: 40 })

test('every map link balances coins, health, cards, modifiers, and RNG draws with a content ledger', () => {
  const outcomes = []
  const coverage = new Set()
  const traversed = new Set()
  for (const [policy, seed] of Object.entries(FULL_PLAY_SEEDS)) {
    for (const route of EDGE_COVERING_ROUTES) {
      const { run, ledger, counters } = firstPlay(policy, seed, route)
      // Every route rests at the sanctum before the boss, so neither is listed.
      const result = run.outcome.result === 'defeat'
        ? `defeat at ${ledger.visited.at(-1)}`
        : run.outcome.result
      outcomes.push(`${policy} ${route.slice(1, -2).join('/')}: ${result}, ${counters.retries} retries`)
      for (const item of ledger.coverage) coverage.add(item)
      for (const link of links(ledger.visited)) traversed.add(link)
    }
  }
  // Each link between stages 3 and 5 lies on one route only, so a play that falls before
  // the sanctum leaves its later links to the other policy.
  assert.deepEqual([...traversed].sort(), MAP_LINKS)
  assert.deepEqual(outcomes, [
    'scripted market/court/bazaar/watch: victory, 1 retries',
    'scripted shrine/court/vault/night-watch: victory, 2 retries',
    'scripted market/court/camp/watch: victory, 0 retries',
    'scripted shrine/high-court/bazaar/night-watch: defeat at night-watch, 1 retries',
    'scripted market/high-court/vault/watch: defeat at high-court, 1 retries',
    'scripted shrine/high-court/camp/night-watch: defeat at night-watch, 1 retries',
    'contrasting market/court/bazaar/watch: defeat at finale, 1 retries',
    'contrasting shrine/court/vault/night-watch: defeat at night-watch, 2 retries',
    'contrasting market/court/camp/watch: defeat at finale, 1 retries',
    'contrasting shrine/high-court/bazaar/night-watch: defeat at night-watch, 3 retries',
    'contrasting market/high-court/vault/watch: defeat at finale, 2 retries',
    'contrasting shrine/high-court/camp/night-watch: defeat at finale, 3 retries',
  ])
  assert.deepEqual([...coverage].sort(), [
    'boss defeat',
    'boss victory',
    'capped heal',
    'defeat',
    'elite',
    'etiquette',
    'event',
    'event bleed-for-fortune',
    'event burn-an-offering',
    'event pay-for-a-copy',
    'event surrender-held-card',
    'expired modifier',
    'greater mend',
    'leaveShop',
    'lost fight',
    'plunder',
    'purchase',
    'purchase add',
    'purchase duplicate',
    'purchase modifier',
    'purchase remove',
    'purchase replace',
    'rest',
    'rest cleanse',
    'rest heal',
    'rest train',
    'rest walk-on',
    'retry',
    'reward',
    'reward add',
    'reward mend',
    'reward modifier',
    'reward remove',
    'route',
    'sold out',
    'spoils',
    'victory',
  ])
})

test('the RNG ledger rejects a step that draws once more or once less than visible state allows', () => {
  const samples = new Map()
  const route = EDGE_COVERING_ROUTES[0]
  let run = createCampaignRun({
    runId: 'campaign-expedition-ledger',
    seed: FULL_PLAY_SEEDS.scripted,
    ruleset: BASELINE_RULESET,
  })
  const counters = createExpeditionCounters()
  while (samples.size < 4 && run.machineState !== 'ended') {
    const next = stepExpedition(run, route, counters)
    const draws = expectedDraws(run, next)
    const decision = next.journal.length !== run.journal.length
    const kind = `${decision ? 'decision' : 'fight step'} ${draws > 0 ? 'with' : 'without'} draws`
    if (!samples.has(kind)) samples.set(kind, [run, next])
    run = next
  }
  assert.deepEqual([...samples.keys()].sort(), [
    'decision with draws',
    'decision without draws',
    'fight step with draws',
    'fight step without draws',
  ])
  for (const [kind, [prev, next]] of samples) {
    assert.doesNotThrow(() => assertRngStep(prev, next, kind))
    for (const offset of [1, -1]) {
      const state = (next.rng.state + offset * 0x6D2B79F5) >>> 0
      const perturbed = { ...next, rng: { ...next.rng, state } }
      assert.throws(() => assertRngStep(prev, perturbed, kind), /RNG draws/, `${kind} ${offset}`)
    }
  }
})

test('the same seed, route, and policy replay to an identical expedition', () => {
  // The scripted play falls at the High Court elite after one retry; the contrasting play
  // falls at the Ace Sovereign after one retry.
  for (const [policy, seed, route, highlight] of [
    ['scripted', FULL_PLAY_SEEDS.scripted, EDGE_COVERING_ROUTES[4], 'elite'],
    ['contrasting', FULL_PLAY_SEEDS.contrasting, EDGE_COVERING_ROUTES[0], 'boss defeat'],
  ]) {
    const first = firstPlay(policy, seed, route)
    const second = playExpedition(policy, seed, route)
    assert.deepEqual(second.run, first.run)
    assert.deepEqual(second.counters, first.counters)
    assert.ok(first.ledger.coverage.has(highlight), `${policy} seed ${seed} covers ${highlight}`)
  }
})

import {
  CAMPAIGN_HOLD_DECISION_STATES,
  captureCampaignHold,
  chooseCampaignEventOption,
  chooseCampaignReveal,
  chooseCampaignRoute,
  createCampaignRun,
  createCampaignStateFingerprint,
  getCampaignEventOptions,
  getCampaignEventTargets,
  getCampaignRewardTargets,
  getCampaignShopOffers,
  getCampaignShopTargets,
  getEligibleHoldTargets,
  leaveCampaignShop,
  prepareCampaignReveal,
  purchaseCampaignShopItem,
  retryCampaignEncounter,
  selectCampaignReward,
  validateCampaignState,
  HOLD_POSITION,
} from '../../src/domain/campaign-machine.js'
import { deckEditRequiresTarget } from '../../src/domain/campaign-deck.js'
import { getCampaignMapNode } from '../../src/domain/campaign-map.js'
import { BASELINE_RULESET } from '../../src/domain/ruleset.js'

// Shared Campaign route helpers for domain, persistence, and UI tests.

export function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

export function activeNodeId(run) {
  return run.route.nodes.find(({ state }) => state === 'active')?.id ?? null
}

export function routeStates(run) {
  return Object.fromEntries(run.route.nodes.map(({ id, state }) => [id, state]))
}

export function chooseRoute(run, nodeId) {
  return chooseCampaignRoute(run, { nodeId, step: run.journal.length })
}

// Creates a run and enters the start fight, which matches the 21.2 first encounter.
export function startCampaign(options) {
  return chooseRoute(createCampaignRun(options), 'gate')
}

export function claimReward(run, offerId, targetInstanceId = null) {
  return selectCampaignReward(run, {
    nodeId: activeNodeId(run),
    step: run.journal.length,
    offerId,
    targetInstanceId,
  })
}

export function buyShopItem(run, itemId, targetInstanceId = null) {
  return purchaseCampaignShopItem(run, {
    nodeId: run.shop.nodeId,
    step: run.journal.length,
    itemId,
    targetInstanceId,
  })
}

export function leaveShop(run) {
  return leaveCampaignShop(run, { nodeId: run.shop.nodeId, step: run.journal.length })
}

export function chooseEventOption(run, optionId, targetInstanceId = null) {
  return chooseCampaignEventOption(run, {
    nodeId: run.nodeEvent.nodeId,
    step: run.journal.length,
    optionId,
    targetInstanceId,
  })
}

export function retryEncounter(run) {
  return retryCampaignEncounter(run, { nodeId: activeNodeId(run), step: run.journal.length })
}

// Passes through a shop or event node without changing the run, then enters `fightId`.
export function passThrough(run, viaNodeId, fightId) {
  let next = chooseRoute(run, viaNodeId)
  next = getCampaignMapNode(viaNodeId).kind === 'shop'
    ? leaveShop(next)
    : chooseEventOption(next, 'walk-on')
  return fightId === undefined ? next : chooseRoute(next, fightId)
}

export function refingerprint(run) {
  run.stateFingerprint = createCampaignStateFingerprint(run)
  if (run.pendingEvent !== null) {
    run.pendingEvent.stateFingerprint = run.stateFingerprint
  }
  return run
}

export function fingerprint(run) {
  refingerprint(run)
  validateCampaignState(run)
  return run
}

function emptyZones() {
  return {
    playerSourcePile: [],
    opponentSourcePile: [],
    player: { drawPile: [], wonPile: [] },
    opponent: { drawPile: [], wonPile: [] },
    contestedPile: [],
    burnPile: [],
    inPlay: [],
  }
}

export function mutableReady(input) {
  const run = clone(input)
  run.machineState = 'ready'
  run.status = 'active'
  run.outcome = null
  run.encounter.outcome = null
  run.holdChoice = null
  run.pendingReward = null
  run.pendingEvent = null
  return run
}

// Rearranges a ready fight so the next reveal ends it: the unable side has one card left
// to reveal against nothing (opponent) or nothing against one card (player).
export function arrangeInability(input, unableSide) {
  const run = mutableReady(input)
  const playerIds = run.cards
    .filter(({ campaignOwner, instanceId }) => (
      campaignOwner === 'player' && instanceId !== run.hold
    ))
    .map(({ instanceId }) => instanceId)
  const opponentIds = run.cards
    .filter(({ campaignOwner }) => campaignOwner === 'opponent')
    .map(({ instanceId }) => instanceId)
  run.encounter.zones = emptyZones()
  run.encounter.supplyMode = { player: 'source', opponent: 'source' }
  if (unableSide === 'player') {
    run.encounter.zones.opponentSourcePile.push(opponentIds.shift())
    run.encounter.zones.opponent.wonPile.push(...playerIds, ...opponentIds)
  } else {
    run.encounter.zones.playerSourcePile.push(playerIds.shift())
    run.encounter.zones.player.wonPile.push(...playerIds, ...opponentIds)
  }
  return fingerprint(run)
}

export function resolvePrepared(input, choice = 'normal') {
  const prepared = prepareCampaignReveal(input)
  return CAMPAIGN_HOLD_DECISION_STATES.includes(prepared.match.machineState)
    ? chooseCampaignReveal(prepared.match, choice)
    : prepared
}

export function winEncounter(input) {
  return resolvePrepared(arrangeInability(input, 'opponent')).match
}

export function loseEncounter(input) {
  return resolvePrepared(arrangeInability(input, 'player')).match
}

// Places the player card `instanceId` into Hold at a ready boundary without drawing RNG,
// keeping its layout position as the Hold placeholder.
export function holdCard(input, instanceId) {
  const run = clone(input)
  for (const pile of [
    run.encounter.zones.playerSourcePile,
    run.encounter.zones.player.drawPile,
    run.encounter.zones.player.wonPile,
  ]) {
    const index = pile.indexOf(instanceId)
    if (index >= 0) pile.splice(index, 1)
  }
  run.deckLayout[run.deckLayout.indexOf(instanceId)] = HOLD_POSITION
  run.hold = instanceId
  run.pendingEvent = null
  return fingerprint(run)
}

// Plays one reveal, answering a Hold choice with a normal reveal unless only Hold can.
export function advanceClash(run) {
  const prepared = prepareCampaignReveal(run)
  if (!CAMPAIGN_HOLD_DECISION_STATES.includes(prepared.match.machineState)) return prepared.match
  const choice = prepared.match.holdChoice.candidate === null ? 'hold' : 'normal'
  return chooseCampaignReveal(prepared.match, choice).match
}

export function playUntilTransition(run) {
  let current = run
  for (let clash = 0; current.machineState === 'ready'; clash += 1) {
    if (clash >= 1000) throw new Error('Campaign fight did not reach a transition')
    current = advanceClash(current)
  }
  return current
}

const SCRIPTED_REWARDS = ['deck-edit', 'new-card', 'modifier', 'mend']

// One deterministic step of a scripted expedition. `plan` lists preferred route nodes;
// fights capture an eligible card every seventh clash, rewards rotate through the draft,
// shops buy the first available item, and events take the first available non-walk-on
// option. Targeted edits use the first eligible card.
export function stepExpedition(run, plan, counters) {
  switch (run.machineState) {
    case 'awaitingRoute': {
      const available = run.route.nodes
        .filter(({ state }) => state === 'available')
        .map(({ id }) => id)
      return chooseRoute(run, plan.find((id) => available.includes(id)) ?? available[0])
    }
    case 'ready': {
      counters.clashes += 1
      if (run.hold === null && counters.clashes % 7 === 3) {
        const target = getEligibleHoldTargets(run)[0]
        if (target !== undefined) return captureCampaignHold(run, target.instanceId)
      }
      return prepareCampaignReveal(run).match
    }
    case 'awaitingHoldChoice':
    case 'awaitingInformedHoldChoice':
      return chooseCampaignReveal(run, run.holdChoice.candidate === null ? 'hold' : 'normal').match
    case 'awaitingRetry':
      counters.retries += 1
      return retryEncounter(run)
    case 'awaitingReward': {
      const offerId = SCRIPTED_REWARDS[counters.rewards % SCRIPTED_REWARDS.length]
      counters.rewards += 1
      const offer = run.pendingReward.offers.find((candidate) => candidate.offerId === offerId)
      if (!deckEditRequiresTarget(offer.kind)) return claimReward(run, offerId)
      const target = getCampaignRewardTargets(run, offerId)[0]
      return target === undefined
        ? claimReward(run, 'mend')
        : claimReward(run, offerId, target.instanceId)
    }
    case 'awaitingShop': {
      const item = getCampaignShopOffers(run).find(({ blocker }) => blocker === null)
      if (item === undefined) return leaveShop(run)
      counters.purchases.push(item.itemId)
      return buyShopItem(
        run,
        item.itemId,
        deckEditRequiresTarget(item.kind)
          ? getCampaignShopTargets(run, item.itemId)[0].instanceId
          : null,
      )
    }
    case 'awaitingEvent': {
      const option = getCampaignEventOptions(run)
        .find(({ blocker, optionId }) => blocker === null && optionId !== 'walk-on')
      if (option === undefined) return chooseEventOption(run, 'walk-on')
      counters.events.push(option.optionId)
      const targets = getCampaignEventTargets(run, option.optionId)
      return chooseEventOption(run, option.optionId, targets[0]?.instanceId ?? null)
    }
    default:
      throw new Error(`A scripted expedition cannot continue from ${run.machineState}`)
  }
}

export function createExpeditionCounters() {
  return { clashes: 0, retries: 0, rewards: 0, purchases: [], events: [] }
}

// Market, Royal Court, and Oathkeeper's Vault; Crossroads Shrine, Watch of Tens, and
// Ember Bazaar; or Crossroads Shrine, Royal Court, and Ember Bazaar, where bleeding at the
// shrine and both bounties pay exactly the bazaar's full stock. All end at the Ace Assembly.
export const EXPEDITION_PLANS = Object.freeze({
  market: Object.freeze(['gate', 'market', 'court', 'vault', 'finale']),
  shrine: Object.freeze(['gate', 'shrine', 'watch', 'bazaar', 'finale']),
  soldOut: Object.freeze(['gate', 'shrine', 'court', 'bazaar', 'finale']),
})

// Stable states behind the JSON Campaign save fixtures. Seed 48 wins its first fight
// without a retry and drafts Hold Insight; seed 6 does the same and drafts Spoils of War.
function fixtureCampaign(seed, runId) {
  return startCampaign({ runId, seed, ruleset: BASELINE_RULESET })
}

export function rewardFixtureRun(runId = 'fixture-campaign-reward') {
  return playUntilTransition(fixtureCampaign(48, runId))
}

// The route map after Hold Insight is claimed: the market and shrine are available.
export function routeFixtureRun(runId = 'fixture-campaign-route') {
  return claimReward(rewardFixtureRun(runId), 'modifier')
}

export function shopFixtureRun() {
  return chooseRoute(routeFixtureRun('fixture-campaign-shop'), 'market')
}

export function eventFixtureRun() {
  return chooseRoute(routeFixtureRun('fixture-campaign-event'), 'shrine')
}

export function informedFixtureRun() {
  const insight = passThrough(routeFixtureRun('fixture-campaign-informed'), 'shrine', 'court')
  return prepareCampaignReveal(insight).match
}

export function modifiersFixtureRun() {
  let run = claimReward(
    playUntilTransition(fixtureCampaign(6, 'fixture-campaign-modifiers')),
    'modifier',
  )
  run = passThrough(run, 'shrine', 'court')
  for (let clash = 0; clash < 3; clash += 1) run = advanceClash(run)
  return captureCampaignHold(run, getEligibleHoldTargets(run)[0].instanceId)
}

// Ember Bazaar after its last item is bought. Seed 1 bleeds at the shrine, so the gate
// bounty, the shrine coins, and the court bounty pay exactly the bazaar's 12-coin stock.
export function exhaustedShopFixtureRun(runId = 'fixture-campaign-shop-exhausted') {
  let run = fixtureCampaign(1, runId)
  const counters = createExpeditionCounters()
  for (let step = 0; step < 5000 && run.machineState !== 'ended'; step += 1) {
    if (
      run.machineState === 'awaitingShop'
      && run.shop.nodeId === 'bazaar'
      && run.shop.items.every(({ sold }) => sold)
    ) {
      return run
    }
    run = stepExpedition(run, EXPEDITION_PLANS.soldOut, counters)
  }
  throw new Error('The scripted expedition did not sell out Ember Bazaar')
}

export const CAMPAIGN_SAVE_FIXTURES = Object.freeze([
  ['campaign-save-reward-v6.json', rewardFixtureRun],
  ['campaign-save-route-v6.json', routeFixtureRun],
  ['campaign-save-shop-v6.json', shopFixtureRun],
  ['campaign-save-shop-exhausted-v6.json', exhaustedShopFixtureRun],
  ['campaign-save-event-v6.json', eventFixtureRun],
  ['campaign-save-informed-v6.json', informedFixtureRun],
  ['campaign-save-modifiers-v6.json', modifiersFixtureRun],
])

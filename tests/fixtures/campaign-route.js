import {
  CAMPAIGN_HOLD_DECISION_STATES,
  captureCampaignHold,
  chooseCampaignEventOption,
  chooseCampaignRestOption,
  chooseCampaignReveal,
  chooseCampaignRoute,
  createCampaignRun,
  createCampaignStateFingerprint,
  getCampaignEventOptions,
  getCampaignEventTargets,
  getCampaignRestOptions,
  getCampaignRestTargets,
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

export function chooseRestOption(run, optionId, targetInstanceId = null) {
  return chooseCampaignRestOption(run, {
    nodeId: run.restSite.nodeId,
    step: run.journal.length,
    optionId,
    targetInstanceId,
  })
}

export function retryEncounter(run) {
  return retryCampaignEncounter(run, { nodeId: activeNodeId(run), step: run.journal.length })
}

// Passes through a shop, event, or rest node without changing the run, then enters
// `fightId`.
export function passThrough(run, viaNodeId, fightId) {
  let next = chooseRoute(run, viaNodeId)
  const { kind } = getCampaignMapNode(viaNodeId)
  if (kind === 'shop') next = leaveShop(next)
  else if (kind === 'rest') next = chooseRestOption(next, 'walk-on')
  else next = chooseEventOption(next, 'walk-on')
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
// option. Rest sites heal below maximum health, otherwise take the first available deck
// edit, otherwise walk on. Targeted edits use the first eligible card.
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
    case 'awaitingRest': {
      const options = getCampaignRestOptions(run)
      const option = run.health < run.maxHealth
        ? options.find(({ healthGain }) => healthGain > 0)
        : options.find(({ blocker, deckEdit }) => blocker === null && deckEdit !== null)
      if (option === undefined) {
        counters.rests.push('walk-on')
        return chooseRestOption(run, 'walk-on')
      }
      counters.rests.push(option.optionId)
      const targets = getCampaignRestTargets(run, option.optionId)
      return chooseRestOption(run, option.optionId, targets[0]?.instanceId ?? null)
    }
    default:
      throw new Error(`A scripted expedition cannot continue from ${run.machineState}`)
  }
}

export function createExpeditionCounters() {
  return { clashes: 0, retries: 0, rewards: 0, purchases: [], events: [], rests: [] }
}

// The normal path through the market and Oathkeeper's Vault; the elite ladder through the
// shrine, High Court, Roadside Camp, and Night Watch; or the shrine, Royal Court, and Ember
// Bazaar, where bleeding at the shrine and both bounties pay exactly the bazaar's full
// stock. All rest at the Last Light Sanctum and end at the Ace Sovereign.
export const EXPEDITION_PLANS = Object.freeze({
  market: Object.freeze(['gate', 'market', 'court', 'vault', 'watch', 'sanctum', 'finale']),
  shrine: Object.freeze([
    'gate', 'shrine', 'high-court', 'camp', 'night-watch', 'sanctum', 'finale',
  ]),
  soldOut: Object.freeze(['gate', 'shrine', 'court', 'bazaar', 'watch', 'sanctum', 'finale']),
})

// Six routes that together use every map link; each rests at the sanctum before the boss.
export const EDGE_COVERING_ROUTES = Object.freeze([
  ['gate', 'market', 'court', 'bazaar', 'watch', 'sanctum', 'finale'],
  ['gate', 'shrine', 'court', 'vault', 'night-watch', 'sanctum', 'finale'],
  ['gate', 'market', 'court', 'camp', 'watch', 'sanctum', 'finale'],
  ['gate', 'shrine', 'high-court', 'bazaar', 'night-watch', 'sanctum', 'finale'],
  ['gate', 'market', 'high-court', 'vault', 'watch', 'sanctum', 'finale'],
  ['gate', 'shrine', 'high-court', 'camp', 'night-watch', 'sanctum', 'finale'],
].map((route) => Object.freeze(route)))

// Fixture runs are deep-frozen machine states, so each is built once per runId and shared.
function buildOnce(build) {
  const runs = new Map()
  return (runId) => {
    if (!runs.has(runId)) runs.set(runId, build(runId))
    return runs.get(runId)
  }
}

// Stable states behind the JSON Campaign save fixtures. Seed 48 wins its first fight
// without a retry and drafts Hold Insight; seed 6 does the same and drafts Spoils of War.
function fixtureCampaign(seed, runId) {
  return startCampaign({ runId, seed, ruleset: BASELINE_RULESET })
}

export const rewardFixtureRun = buildOnce((runId = 'fixture-campaign-reward') => {
  return playUntilTransition(fixtureCampaign(48, runId))
})

// The route map after Hold Insight is claimed: the market and shrine are available.
export const routeFixtureRun = buildOnce((runId = 'fixture-campaign-route') => {
  return claimReward(rewardFixtureRun(runId), 'modifier')
})

export const shopFixtureRun = buildOnce(() => {
  return chooseRoute(routeFixtureRun('fixture-campaign-shop'), 'market')
})

export const eventFixtureRun = buildOnce(() => {
  return chooseRoute(routeFixtureRun('fixture-campaign-event'), 'shrine')
})

export const informedFixtureRun = buildOnce(() => {
  const insight = passThrough(routeFixtureRun('fixture-campaign-informed'), 'shrine', 'court')
  return prepareCampaignReveal(insight).match
})

export const modifiersFixtureRun = buildOnce(() => {
  let run = claimReward(
    playUntilTransition(fixtureCampaign(6, 'fixture-campaign-modifiers')),
    'modifier',
  )
  run = passThrough(run, 'shrine', 'court')
  for (let clash = 0; clash < 3; clash += 1) run = advanceClash(run)
  return captureCampaignHold(run, getEligibleHoldTargets(run)[0].instanceId)
})

// Ember Bazaar after its last item is bought. Seed 1 bleeds at the shrine, so the gate
// bounty, the shrine coins, and the court bounty pay exactly the bazaar's 12-coin stock.
export const exhaustedShopFixtureRun = buildOnce((runId = 'fixture-campaign-shop-exhausted') => {
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
})

// The route map after walking on from the shrine: Royal Court and the High Court are open.
export const eliteChoiceFixtureRun = buildOnce(() => {
  return passThrough(routeFixtureRun('fixture-campaign-elite-choice'), 'shrine')
})

// Seed 11 climbs the elite ladder of the shrine plan without a retry: it wins the High
// Court, rests at the Roadside Camp, wins the Night Watch, cleanses at the Last Light
// Sanctum, and defeats the Ace Sovereign.
function eliteLadderRun(runId, reached) {
  let run = fixtureCampaign(11, runId)
  const counters = createExpeditionCounters()
  for (let step = 0; step < 5000; step += 1) {
    if (reached(run)) return run
    if (run.machineState === 'ended') break
    run = stepExpedition(run, EXPEDITION_PLANS.shrine, counters)
  }
  throw new Error(`The scripted elite ladder did not reach the ${runId} state`)
}

export const eliteRewardFixtureRun = buildOnce(() => {
  return eliteLadderRun('fixture-campaign-elite-reward', (run) => (
    run.machineState === 'awaitingReward' && activeNodeId(run) === 'high-court'
  ))
})

export const restFixtureRun = buildOnce(() => {
  return eliteLadderRun('fixture-campaign-rest', (run) => (
    run.machineState === 'awaitingRest' && run.restSite.nodeId === 'camp'
  ))
})

// The boss fight just after the route choice, before its first reveal.
export const bossFixtureRun = buildOnce(() => {
  return eliteLadderRun('fixture-campaign-boss', (run) => {
    const last = run.journal.at(-1)
    return run.machineState === 'ready' && last.type === 'route' && last.nodeId === 'finale'
  })
})

export const victoryFixtureRun = buildOnce(() => {
  return eliteLadderRun('fixture-campaign-victory', (run) => (
    run.outcome?.reason === 'campaignCompleted'
  ))
})

export const CAMPAIGN_SAVE_FIXTURES = Object.freeze([
  ['campaign-save-reward-v7.json', rewardFixtureRun],
  ['campaign-save-route-v7.json', routeFixtureRun],
  ['campaign-save-shop-v7.json', shopFixtureRun],
  ['campaign-save-shop-exhausted-v7.json', exhaustedShopFixtureRun],
  ['campaign-save-event-v7.json', eventFixtureRun],
  ['campaign-save-informed-v7.json', informedFixtureRun],
  ['campaign-save-modifiers-v7.json', modifiersFixtureRun],
  ['campaign-save-elite-choice-v7.json', eliteChoiceFixtureRun],
  ['campaign-save-elite-reward-v7.json', eliteRewardFixtureRun],
  ['campaign-save-rest-v7.json', restFixtureRun],
  ['campaign-save-boss-v7.json', bossFixtureRun],
  ['campaign-save-victory-v7.json', victoryFixtureRun],
])

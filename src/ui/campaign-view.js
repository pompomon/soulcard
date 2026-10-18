import {
  CAMPAIGN_DECK_SIZE_LIMITS,
  CAMPAIGN_MEND_HEALTH,
  getCampaignFight,
  getCampaignNodeEvent,
  getCampaignShop,
} from '../domain/campaign-content.js'
import { applyJournalEntry, createJournalReplay } from '../domain/campaign-journal.js'
import {
  getCampaignEventOptions,
  getCampaignEventTargets,
  getCampaignRewardOffers,
  getCampaignRewardTargets,
  getCampaignShopOffers,
  getCampaignShopTargets,
} from '../domain/campaign-machine.js'
import {
  CAMPAIGN_STAGE_COUNT,
  getCampaignMapNode,
  getCampaignNodeContent,
} from '../domain/campaign-map.js'
import { getCampaignModifier } from '../domain/campaign-modifiers.js'
import { getCard } from '../domain/cards.js'

// Display-only text for Campaign overlays. Every value is derived from a validated,
// committed campaign snapshot; nothing here mutates state or draws RNG.

export function cardText(cardId) {
  const card = getCard(cardId)
  return `${card.rank}${card.suit}`
}

export function coinText(count) {
  return `${count} ${count === 1 ? 'coin' : 'coins'}`
}

function cardIdsByInstance(match) {
  return new Map(match.cards.map(({ instanceId, cardId }) => [instanceId, cardId]))
}

function deckSize(match) {
  return match.cards.filter(({ campaignOwner }) => campaignOwner === 'player').length
}

function heldCardText(match, cards = cardIdsByInstance(match)) {
  return match.hold === null ? 'Hold is empty' : `Held card: ${cardText(cards.get(match.hold))}`
}

function nodeName(nodeId) {
  return getCampaignNodeContent(getCampaignMapNode(nodeId)).name
}

const NODE_KIND_TEXT = Object.freeze({ fight: 'Fight', shop: 'Shop', event: 'Event' })
const NODE_STATE_TEXT = Object.freeze({
  locked: 'Locked',
  available: 'Available',
  active: 'Current',
  completed: 'Completed',
  bypassed: 'Bypassed',
})

function nodeKindText(node) {
  return node.kind === 'fight' && node.next.length === 0 ? 'Final fight' : NODE_KIND_TEXT[node.kind]
}

export function activeNodeId(match) {
  return match.route.nodes.find(({ state }) => state === 'active')?.id ?? null
}

// The stage of the active node, otherwise of the earliest available node. After victory
// no node is open and the whole route is complete.
export function routeStage(match) {
  const nodes = match.route.nodes.map(({ id, state }) => ({ ...getCampaignMapNode(id), state }))
  const active = nodes.find(({ state }) => state === 'active')
  if (active !== undefined) return active.stage
  const stages = nodes.filter(({ state }) => state === 'available').map(({ stage }) => stage)
  return stages.length === 0 ? CAMPAIGN_STAGE_COUNT : Math.min(...stages)
}

export function routeProgressText(match) {
  return `${routeStage(match)}/${CAMPAIGN_STAGE_COUNT}`
}

function lifetimeText(record, match) {
  if (record.lifetime === 'campaign') return 'Permanent'
  if (match.machineState === 'awaitingReward') return 'Ends when you choose a reward'
  return match.encounter === null
    ? 'Your next encounter, including retries'
    : 'This encounter, including retries'
}

export function activeModifierLines(match) {
  return match.activeModifiers.map((record) => {
    const modifier = getCampaignModifier(record.id)
    return `${modifier.name} (${lifetimeText(record, match)}): ${modifier.description}`
  })
}

const BLOCKER_TEXT = Object.freeze({
  sold: 'Sold.',
  unaffordable: 'Not enough coins.',
  'no-eligible-card': 'No card in your deck is eligible.',
  'deck-full': `Your deck is at its ${CAMPAIGN_DECK_SIZE_LIMITS.maximum}-card maximum.`,
  'deck-minimum': `Your deck is at its ${CAMPAIGN_DECK_SIZE_LIMITS.minimum}-card minimum.`,
  'copy-limit': 'You already own the most copies allowed.',
  'modifier-conflict': 'It clashes with a modifier you already have.',
  'modifier-unavailable': 'It cannot take effect in this run.',
  'health-too-low': 'You need more health than it costs.',
  'hold-empty': 'Your Hold is empty.',
})

export function blockerText(blocker) {
  return BLOCKER_TEXT[blocker]
}

function deckEditText(kind, cardId) {
  if (kind === 'add') {
    return {
      title: `New card: ${cardText(cardId)}`,
      detail: `Add ${cardText(cardId)} to your deck.`,
    }
  }
  if (kind === 'duplicate') {
    return { title: 'Duplicate a card', detail: 'Choose a card in your deck to copy.' }
  }
  if (kind === 'remove') {
    return { title: 'Remove a card', detail: 'Choose a card to remove from your deck.' }
  }
  return {
    title: `Replace a card with ${cardText(cardId)}`,
    detail: `Choose a card in your deck to swap for ${cardText(cardId)}.`,
  }
}

function modifierText(modifierId) {
  const modifier = getCampaignModifier(modifierId)
  return { title: `Modifier: ${modifier.name}`, detail: modifier.description }
}

function offerText(match, offer) {
  if (offer.kind === 'modifier') return modifierText(offer.modifierId)
  if (offer.kind !== 'mend') return deckEditText(offer.kind, offer.cardId)
  return {
    title: 'Mend',
    detail: match.health < match.maxHealth
      ? `Restore ${CAMPAIGN_MEND_HEALTH} health (now ${match.health}/${match.maxHealth}) and keep your deck unchanged.`
      : 'Your health is full. Choose Mend to keep your deck unchanged.',
  }
}

export function rewardDraftView(match) {
  const { bounty } = getCampaignFight(match.encounter.id)
  return {
    description: bounty > 0
      ? `Choose one reward before returning to the map. The ${match.encounter.name} bounty pays ${coinText(bounty)} when you choose.`
      : 'Choose one reward before returning to the map.',
    offers: getCampaignRewardOffers(match).map((offer) => {
      const text = offerText(match, offer)
      return {
        offerId: offer.offerId,
        title: text.title,
        detail: offer.blocker === null ? text.detail : `${text.detail} ${blockerText(offer.blocker)}`,
        available: offer.blocker === null,
        reason: offer.blocker,
      }
    }),
    modifiers: activeModifierLines(match),
  }
}

const TARGET_HEADINGS = Object.freeze({
  duplicate: () => 'Choose a card to duplicate',
  remove: () => 'Choose a card to remove',
  replace: (cardId) => `Choose a card to replace with ${cardText(cardId)}`,
})

function targetView(match, heading, targets) {
  const totals = new Map()
  for (const { cardId } of targets) totals.set(cardId, (totals.get(cardId) ?? 0) + 1)
  const seen = new Map()
  return {
    heading,
    description: match.hold === null
      ? 'Choose one card from your campaign deck.'
      : 'Choose one card from your campaign deck. The held card cannot be chosen.',
    targets: targets.map(({ instanceId, cardId }) => {
      const copy = (seen.get(cardId) ?? 0) + 1
      seen.set(cardId, copy)
      return {
        instanceId,
        label: totals.get(cardId) > 1 ? `${cardText(cardId)} · copy ${copy}` : cardText(cardId),
      }
    }),
  }
}

export function rewardTargetView(match, offerId) {
  const offer = match.pendingReward.offers.find((candidate) => candidate.offerId === offerId)
  return targetView(
    match,
    TARGET_HEADINGS[offer.kind](offer.cardId),
    getCampaignRewardTargets(match, offerId),
  )
}

function shopItemText(item) {
  const text = item.kind === 'modifier'
    ? modifierText(item.modifierId)
    : deckEditText(item.kind, item.cardId)
  return { title: `${text.title} · ${coinText(item.price)}`, detail: text.detail }
}

export function shopView(match) {
  const shop = getCampaignShop(getCampaignMapNode(match.shop.nodeId).contentId)
  const offers = getCampaignShopOffers(match)
  return {
    title: shop.name,
    description: `${shop.description} You have ${coinText(match.currency)}.`,
    soldOut: offers.every(({ sold }) => sold),
    items: offers.map((item) => {
      const text = shopItemText(item)
      return {
        itemId: item.itemId,
        title: text.title,
        detail: item.blocker === null ? text.detail : `${text.detail} ${blockerText(item.blocker)}`,
        available: item.blocker === null,
        reason: item.blocker,
      }
    }),
    modifiers: activeModifierLines(match),
  }
}

export function shopTargetView(match, itemId) {
  const item = match.shop.items.find((candidate) => candidate.itemId === itemId)
  const view = targetView(
    match,
    TARGET_HEADINGS[item.kind](item.cardId),
    getCampaignShopTargets(match, itemId),
  )
  return { ...view, description: `${view.description} It costs ${coinText(item.price)}.` }
}

function capitalize(text) {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`
}

function eventOptionText(option, match, cards) {
  const costs = []
  const gains = []
  if (option.healthCost > 0) costs.push(`lose ${option.healthCost} health`)
  if (option.coinCost > 0) costs.push(`pay ${coinText(option.coinCost)}`)
  if (option.surrenderHold) {
    costs.push(match.hold === null
      ? 'surrender the held card'
      : `surrender the held card (${cardText(cards.get(match.hold))})`)
  }
  if (option.deckEdit?.kind === 'remove') costs.push('remove a chosen card')
  if (option.deckEdit?.kind === 'add') gains.push(`add ${cardText(option.deckEdit.cardId)}`)
  if (option.deckEdit?.kind === 'duplicate') gains.push('duplicate a chosen card')
  if (option.deckEdit?.kind === 'replace') {
    gains.push(`replace a chosen card with ${cardText(option.deckEdit.cardId)}`)
  }
  if (option.modifierId !== null) gains.push(`gain ${getCampaignModifier(option.modifierId).name}`)
  if (option.healthGain > 0) gains.push(`restore ${option.healthGain} health`)
  if (option.coinGain > 0) gains.push(`gain ${coinText(option.coinGain)}`)
  if (costs.length === 0 && gains.length === 0) return 'Leave without changing anything.'
  return `${capitalize(costs.join(', ') || 'no cost')} → ${gains.join(', ') || 'nothing'}.`
}

export function eventView(match) {
  const event = getCampaignNodeEvent(match.nodeEvent.eventId)
  const cards = cardIdsByInstance(match)
  return {
    title: event.name,
    description: event.description,
    summary: [
      `Health ${match.health}/${match.maxHealth}`,
      `Coins ${match.currency}`,
      `Deck ${deckSize(match)} cards`,
      heldCardText(match, cards),
    ],
    options: getCampaignEventOptions(match).map((option) => {
      const text = eventOptionText(option, match, cards)
      return {
        optionId: option.optionId,
        title: option.label,
        detail: option.blocker === null ? text : `${text} ${blockerText(option.blocker)}`,
        available: option.blocker === null,
        reason: option.blocker,
        needsTarget: option.deckEdit !== null
          && TARGET_HEADINGS[option.deckEdit.kind] !== undefined,
        surrenderHold: option.surrenderHold,
      }
    }),
    modifiers: activeModifierLines(match),
  }
}

export function eventTargetView(match, optionId) {
  const option = getCampaignEventOptions(match).find((candidate) => (
    candidate.optionId === optionId
  ))
  return targetView(
    match,
    TARGET_HEADINGS[option.deckEdit.kind](option.deckEdit.cardId),
    getCampaignEventTargets(match, optionId),
  )
}

function fightDetail(fight) {
  const bounty = fight.bounty > 0 ? ` · ${fight.bounty}-coin bounty` : ''
  return `${fight.damage} damage on a loss${bounty}`
}

export function routeMapView(match) {
  return {
    title: `Route map · Stage ${routeProgressText(match)}`,
    description: 'Choose your next stop. Paths you leave behind close for this run.',
    summary: [
      `Health ${match.health}/${match.maxHealth}`,
      `Coins ${match.currency}`,
      `Deck ${deckSize(match)} cards`,
      heldCardText(match),
    ],
    nodes: match.route.nodes.map(({ id, state }) => {
      const node = getCampaignMapNode(id)
      const content = getCampaignNodeContent(node)
      const kind = nodeKindText(node)
      const detail = node.kind === 'fight' ? `${kind} · ${fightDetail(content)}` : kind
      return {
        nodeId: id,
        title: `Stage ${node.stage} · ${content.name}`,
        detail: `${detail} · ${NODE_STATE_TEXT[state]}`,
        state,
        available: state === 'available',
      }
    }),
    modifiers: activeModifierLines(match),
  }
}

function deckEditLogText(kind, cardId, targetCardId) {
  if (kind === 'add') return `added ${cardText(cardId)}`
  if (kind === 'duplicate') return `duplicated ${cardText(targetCardId)}`
  if (kind === 'remove') return `removed ${cardText(targetCardId)}`
  return `replaced ${cardText(targetCardId)} with ${cardText(cardId)}`
}

function rewardLogText(entry, targetCardId) {
  if (entry.kind === 'modifier') return `gained ${getCampaignModifier(entry.modifierId).name}`
  if (entry.kind === 'mend') return 'chose Mend'
  return deckEditLogText(entry.kind, entry.cardId, targetCardId)
}

function journalLine(entry, targetCardId) {
  const node = getCampaignMapNode(entry.nodeId)
  const name = nodeName(entry.nodeId)
  if (entry.type === 'route') return `Stage ${node.stage}: entered ${name}`
  if (entry.type === 'retry') return `${name}: retried the encounter`
  if (entry.type === 'leaveShop') return `${name}: left the shop`
  if (entry.type === 'reward') {
    const { bounty } = getCampaignNodeContent(node)
    const paid = bounty > 0 ? ` and collected ${coinText(bounty)}` : ''
    return `${name}: ${rewardLogText(entry, targetCardId)}${paid}`
  }
  if (entry.type === 'purchase') {
    const bought = entry.kind === 'modifier'
      ? `bought ${getCampaignModifier(entry.modifierId).name}`
      : deckEditLogText(entry.kind, entry.cardId, targetCardId)
    return `${name}: ${bought} for ${coinText(entry.price)}`
  }
  const option = getCampaignNodeEvent(node.contentId).options
    .find(({ id }) => id === entry.optionId)
  const target = targetCardId === null ? '' : ` (${cardText(targetCardId)})`
  return `${name}: ${option.label}${target}`
}

// Replays the validated journal only to name each decision's target card.
export function expeditionLogLines(match) {
  const replay = createJournalReplay({ seed: match.rng.seed, ruleset: match.ruleset })
  return match.journal.map((entry, index) => {
    const target = replay.playerCards.find(({ instanceId }) => (
      instanceId === entry.targetInstanceId
    ))
    const line = journalLine(entry, target?.cardId ?? null)
    applyJournalEntry(replay, entry, index)
    return line
  })
}

function routeLines(match) {
  return match.route.nodes.map(({ id, state }) => {
    const node = getCampaignMapNode(id)
    return `Stage ${node.stage} · ${nodeName(id)} (${nodeKindText(node)}): ${NODE_STATE_TEXT[state]}`
  })
}

export function campaignInspectView(match) {
  return {
    summary: [
      `Health ${match.health}/${match.maxHealth}`,
      `Stage ${routeProgressText(match)}`,
      `Coins ${match.currency}`,
      `Deck ${deckSize(match)} cards`,
      heldCardText(match),
    ],
    route: routeLines(match),
    modifiers: activeModifierLines(match),
    log: expeditionLogLines(match),
  }
}

// The nodes the run entered, in route order, for the end-of-campaign summary.
export function routeSummaryText(match) {
  const visited = match.route.nodes
    .filter(({ state }) => state === 'completed' || state === 'active')
    .map(({ id }) => nodeName(id))
  return `Route: ${visited.join(' → ')}. Coins ${match.currency} · Deck ${deckSize(match)} cards.`
}

export function informedChoiceLines(match) {
  const cards = cardIdsByInstance(match)
  const { candidate, opponentCandidate } = match.holdChoice
  return [
    opponentCandidate === null
      ? 'The opponent has no card to reveal.'
      : `Opponent's next card: ${cardText(cards.get(opponentCandidate))}`,
    candidate === null
      ? 'Your prepared pile is empty.'
      : `Your next card: ${cardText(cards.get(candidate))}`,
    `${heldCardText(match, cards)}.`,
  ]
}

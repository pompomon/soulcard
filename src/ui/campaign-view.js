import { CAMPAIGN_ENCOUNTERS, CAMPAIGN_MEND_HEALTH } from '../domain/campaign-content.js'
import { getCampaignRewardTargets } from '../domain/campaign-machine.js'
import { getCampaignModifier } from '../domain/campaign-modifiers.js'
import {
  applyRewardToPlayerCards,
  createStarterPlayerCards,
  rewardRequiresTarget,
} from '../domain/campaign-rewards.js'
import { getCard } from '../domain/cards.js'

// Display-only text for Campaign overlays. Every value is derived from a validated,
// committed campaign snapshot; nothing here mutates state or draws RNG.

export function cardText(cardId) {
  const card = getCard(cardId)
  return `${card.rank}${card.suit}`
}

function cardIdsByInstance(match) {
  return new Map(match.cards.map(({ instanceId, cardId }) => [instanceId, cardId]))
}

export function encounterProgressText(match) {
  return `${match.encounterIndex + 1}/${CAMPAIGN_ENCOUNTERS.length}`
}

function lifetimeText(record, match) {
  if (record.lifetime === 'campaign') return 'Permanent'
  return match.machineState === 'awaitingReward'
    ? 'Ends when you choose a reward'
    : 'This encounter, including retries'
}

export function activeModifierLines(match) {
  return match.activeModifiers.map((record) => {
    const modifier = getCampaignModifier(record.id)
    return `${modifier.name} (${lifetimeText(record, match)}): ${modifier.description}`
  })
}

function offerText(match, offer) {
  if (offer.kind === 'add') {
    return {
      title: `New card: ${cardText(offer.cardId)}`,
      detail: `Add ${cardText(offer.cardId)} to your deck.`,
    }
  }
  if (offer.kind === 'duplicate') {
    return {
      title: 'Duplicate a card',
      detail: 'Choose a card in your deck to copy.',
    }
  }
  if (offer.kind === 'remove') {
    return {
      title: 'Remove a card',
      detail: 'Choose a card to remove from your deck.',
    }
  }
  if (offer.kind === 'replace') {
    return {
      title: `Replace a card with ${cardText(offer.cardId)}`,
      detail: `Choose a card in your deck to swap for ${cardText(offer.cardId)}.`,
    }
  }
  if (offer.kind === 'modifier') {
    const modifier = getCampaignModifier(offer.modifierId)
    return {
      title: `Modifier: ${modifier.name}`,
      detail: modifier.description,
    }
  }
  return {
    title: 'Mend',
    detail: match.health < match.maxHealth
      ? `Restore ${CAMPAIGN_MEND_HEALTH} health (now ${match.health}/${match.maxHealth}) and keep your deck unchanged.`
      : 'Your health is full. Choose Mend to keep your deck unchanged.',
  }
}

export function rewardDraftView(match) {
  return {
    offers: match.pendingReward.offers.map((offer) => {
      const text = offerText(match, offer)
      const available = !rewardRequiresTarget(offer.kind)
        || getCampaignRewardTargets(match, offer.offerId).length > 0
      return {
        offerId: offer.offerId,
        title: text.title,
        detail: available ? text.detail : `${text.detail} No card in your deck is eligible.`,
        available,
      }
    }),
    modifiers: activeModifierLines(match),
  }
}

const TARGET_HEADINGS = Object.freeze({
  duplicate: () => 'Choose a card to duplicate',
  remove: () => 'Choose a card to remove',
  replace: (offer) => `Choose a card to replace with ${cardText(offer.cardId)}`,
})

export function rewardTargetView(match, offerId) {
  const offer = match.pendingReward.offers.find((candidate) => candidate.offerId === offerId)
  const targets = getCampaignRewardTargets(match, offerId)
  const totals = new Map()
  for (const { cardId } of targets) totals.set(cardId, (totals.get(cardId) ?? 0) + 1)
  const seen = new Map()
  return {
    heading: TARGET_HEADINGS[offer.kind](offer),
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

function historyText(entry, targetCardId) {
  if (entry.kind === 'add') return `Added ${cardText(entry.cardId)}`
  if (entry.kind === 'duplicate') return `Duplicated ${cardText(targetCardId)}`
  if (entry.kind === 'remove') return `Removed ${cardText(targetCardId)}`
  if (entry.kind === 'replace') {
    return `Replaced ${cardText(targetCardId)} with ${cardText(entry.cardId)}`
  }
  if (entry.kind === 'modifier') return `Gained ${getCampaignModifier(entry.modifierId).name}`
  return 'Chose Mend'
}

export function rewardHistoryLines(match) {
  let playerCards = createStarterPlayerCards()
  return match.rewardHistory.map((entry) => {
    const target = playerCards.find(({ instanceId }) => instanceId === entry.targetInstanceId)
    const text = historyText(entry, target?.cardId ?? null)
    playerCards = applyRewardToPlayerCards(
      playerCards,
      entry,
      entry.targetInstanceId,
      entry.createdInstanceId,
    )
    return `Encounter ${entry.encounterIndex + 1}: ${text}`
  })
}

function heldCardText(match, cards) {
  return match.hold === null ? 'Hold is empty' : `Held card: ${cardText(cards.get(match.hold))}`
}

export function campaignInspectView(match) {
  const cards = cardIdsByInstance(match)
  const deckSize = match.cards.filter(({ campaignOwner }) => campaignOwner === 'player').length
  return {
    summary: [
      `Health ${match.health}/${match.maxHealth}`,
      `Encounter ${encounterProgressText(match)}`,
      `Deck ${deckSize} cards`,
      heldCardText(match, cards),
    ],
    modifiers: activeModifierLines(match),
    history: rewardHistoryLines(match),
  }
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

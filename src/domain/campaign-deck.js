import {
  CAMPAIGN_CARD_COPY_LIMIT,
  CAMPAIGN_DECK_SIZE_LIMITS,
  CAMPAIGN_STARTER_CARD_IDS,
} from './campaign-content.js'
import { CARD_IDS } from './cards.js'

// Deck edits shared by reward drafts, shop purchases, and node events.
export const DECK_EDIT_KINDS = Object.freeze(['add', 'duplicate', 'remove', 'replace'])

const TARGETED_KINDS = new Set(['duplicate', 'remove', 'replace'])
const CREATING_KINDS = new Set(['add', 'duplicate', 'replace'])
const CARD_ORDER = new Map(CARD_IDS.map((cardId, index) => [cardId, index]))

export function isDeckEditKind(kind) {
  return DECK_EDIT_KINDS.includes(kind)
}

export function deckEditRequiresTarget(kind) {
  return TARGETED_KINDS.has(kind)
}

export function deckEditCreatesInstance(kind) {
  return CREATING_KINDS.has(kind)
}

export function playerInstanceId(sequence) {
  return `player-${String(sequence).padStart(3, '0')}`
}

export function createStarterPlayerCards() {
  return CAMPAIGN_STARTER_CARD_IDS.map((cardId, index) => ({
    instanceId: playerInstanceId(index + 1),
    cardId,
    campaignOwner: 'player',
  }))
}

export function countCardCopies(cardIds) {
  const copies = new Map()
  for (const cardId of cardIds) copies.set(cardId, (copies.get(cardId) ?? 0) + 1)
  return copies
}

export function compareCardsForDisplay(first, second) {
  return CARD_ORDER.get(first.cardId) - CARD_ORDER.get(second.cardId)
    || (first.instanceId < second.instanceId ? -1 : first.instanceId > second.instanceId ? 1 : 0)
}

// Size and copy-limit checks that do not depend on the chosen target. Returns null when
// the edit fits the deck, otherwise a stable reason code.
export function deckEditBlocker({ kind, cardId }, playerCardIds) {
  const size = playerCardIds.length
  const copies = countCardCopies(playerCardIds)
  if ((kind === 'add' || kind === 'duplicate') && size >= CAMPAIGN_DECK_SIZE_LIMITS.maximum) {
    return 'deck-full'
  }
  if (kind === 'remove' && size <= CAMPAIGN_DECK_SIZE_LIMITS.minimum) {
    return 'deck-minimum'
  }
  if (
    (kind === 'add' || kind === 'replace')
    && (copies.get(cardId) ?? 0) >= CAMPAIGN_CARD_COPY_LIMIT
  ) {
    return 'copy-limit'
  }
  return null
}

export function isDeckEditTargetEligible(kind, cardId, copies) {
  if (kind === 'duplicate') return (copies.get(cardId) ?? 0) < CAMPAIGN_CARD_COPY_LIMIT
  return TARGETED_KINDS.has(kind)
}

// Eligible targets among `candidates`, sorted for display. Copy limits count every player
// card, including a held card that is not itself a candidate.
export function collectDeckEditTargets(kind, playerCards, candidates) {
  if (!deckEditRequiresTarget(kind)) return []
  const copies = countCardCopies(playerCards.map(({ cardId }) => cardId))
  return candidates
    .filter(({ cardId }) => isDeckEditTargetEligible(kind, cardId, copies))
    .map(({ instanceId, cardId }) => Object.freeze({ instanceId, cardId }))
    .sort(compareCardsForDisplay)
}

// Availability of a deck edit for the given target candidates: null, a deck-limit reason,
// or `no-eligible-card` when the edit needs a target and none qualifies.
export function deckEditAvailability(edit, playerCards, candidates) {
  const blocker = deckEditBlocker(edit, playerCards.map(({ cardId }) => cardId))
  if (blocker !== null) return blocker
  if (
    deckEditRequiresTarget(edit.kind)
    && collectDeckEditTargets(edit.kind, playerCards, candidates).length === 0
  ) {
    return 'no-eligible-card'
  }
  return null
}

// Player card records stay in ascending instance-ID order: removals delete the target and
// created instances (always the highest ID issued so far) are appended.
export function applyDeckEditToCards(cards, { kind, cardId }, targetInstanceId, createdInstanceId) {
  const target = cards.find((card) => card.instanceId === targetInstanceId) ?? null
  const next = cards
    .filter((card) => !(
      (kind === 'remove' || kind === 'replace')
      && card.instanceId === targetInstanceId
    ))
    .map((card) => ({ ...card }))
  if (deckEditCreatesInstance(kind)) {
    next.push({
      instanceId: createdInstanceId,
      cardId: kind === 'duplicate' ? target.cardId : cardId,
      campaignOwner: 'player',
    })
  }
  return next
}

// Additions join the end of the retained layout, removals close their gap, and a
// replacement takes its target's exact position. The Hold token shifts naturally.
export function applyDeckEditToLayout(layout, { kind }, targetInstanceId, createdInstanceId) {
  const next = layout.slice()
  if (kind === 'add' || kind === 'duplicate') {
    next.push(createdInstanceId)
    return next
  }
  const index = next.indexOf(targetInstanceId)
  if (index < 0) {
    throw new Error('Deck edit target must occupy its campaign layout position')
  }
  if (kind === 'remove') {
    next.splice(index, 1)
  } else {
    next[index] = createdInstanceId
  }
  return next
}

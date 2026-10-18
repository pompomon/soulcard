import {
  CAMPAIGN_CARD_COPY_LIMIT,
  CAMPAIGN_DECK_SIZE_LIMITS,
  CAMPAIGN_MEND_OFFER_ID,
} from './campaign-content.js'
import {
  countCardCopies,
  deckEditCreatesInstance,
  deckEditRequiresTarget,
} from './campaign-deck.js'
import { getDraftableModifierPool } from './campaign-modifiers.js'
import { CARD_IDS } from './cards.js'
import { createDerivedRng, drawIndex } from './rng.js'

export const REWARD_DRAFT_STREAM = 'campaign-reward-draft-v1'
export const REWARD_KINDS = Object.freeze([
  'add',
  'duplicate',
  'remove',
  'replace',
  'modifier',
  'mend',
])
export const REWARD_OFFER_KEYS = Object.freeze(['offerId', 'kind', 'cardId', 'modifierId'])

export function rewardRequiresTarget(kind) {
  return deckEditRequiresTarget(kind)
}

export function rewardCreatesInstance(kind) {
  return deckEditCreatesInstance(kind)
}

// Pool construction is RNG-free. Each non-empty seeded slot then consumes exactly one draw
// in slot order: new card, deck-edit operation, replacement card (replace only), modifier.
// `encounterIndex` counts the fights whose rewards were already claimed.
export function generateRewardDraft({
  seed,
  encounterIndex,
  playerCardIds,
  activeModifiers,
  ruleset,
}) {
  const rng = createDerivedRng(seed, REWARD_DRAFT_STREAM, encounterIndex)
  const copies = countCardCopies(playerCardIds)
  const deckSize = playerCardIds.length
  const canGrow = deckSize < CAMPAIGN_DECK_SIZE_LIMITS.maximum
  const unowned = CARD_IDS.filter((cardId) => !copies.has(cardId))
  const offers = []

  let newCardId = null
  if (canGrow && unowned.length > 0) {
    newCardId = unowned[drawIndex(unowned.length, rng)]
    offers.push({ offerId: 'new-card', kind: 'add', cardId: newCardId, modifierId: null })
  }

  const replacementPool = unowned.filter((cardId) => cardId !== newCardId)
  const operations = []
  if (canGrow && [...copies.values()].some((count) => count < CAMPAIGN_CARD_COPY_LIMIT)) {
    operations.push('duplicate')
  }
  if (deckSize > CAMPAIGN_DECK_SIZE_LIMITS.minimum) operations.push('remove')
  if (replacementPool.length > 0) operations.push('replace')
  if (operations.length > 0) {
    const kind = operations[drawIndex(operations.length, rng)]
    const cardId = kind === 'replace'
      ? replacementPool[drawIndex(replacementPool.length, rng)]
      : null
    offers.push({ offerId: 'deck-edit', kind, cardId, modifierId: null })
  }

  const modifierPool = getDraftableModifierPool(activeModifiers, ruleset)
  if (modifierPool.length > 0) {
    offers.push({
      offerId: 'modifier',
      kind: 'modifier',
      cardId: null,
      modifierId: modifierPool[drawIndex(modifierPool.length, rng)],
    })
  }

  offers.push({ offerId: CAMPAIGN_MEND_OFFER_ID, kind: 'mend', cardId: null, modifierId: null })
  return { encounterIndex, offers }
}

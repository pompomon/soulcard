import {
  CAMPAIGN_CARD_COPY_LIMIT,
  CAMPAIGN_DECK_SIZE_LIMITS,
  CAMPAIGN_ELITE_CARD_RANKS,
  CAMPAIGN_MEND_HEALTH_BY_TIER,
  CAMPAIGN_MEND_OFFER_ID,
} from './campaign-content.js'
import {
  countCardCopies,
  deckEditCreatesInstance,
  deckEditRequiresTarget,
} from './campaign-deck.js'
import { getDraftableModifierPool } from './campaign-modifiers.js'
import { CARD_IDS, getCard } from './cards.js'
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
export const REWARD_TIERS = Object.freeze(Object.keys(CAMPAIGN_MEND_HEALTH_BY_TIER))

export function rewardRequiresTarget(kind) {
  return deckEditRequiresTarget(kind)
}

export function rewardCreatesInstance(kind) {
  return deckEditCreatesInstance(kind)
}

// Elite new cards come from unowned J–A while any remain, otherwise from every unowned card.
function newCardPool(unowned, tier) {
  if (tier === 'normal') return unowned
  const court = unowned.filter((cardId) => (
    CAMPAIGN_ELITE_CARD_RANKS.includes(getCard(cardId).rank)
  ))
  return court.length > 0 ? court : unowned
}

// Pool construction is RNG-free. Each non-empty seeded slot then consumes exactly one draw
// in slot order: new card, deck-edit operation, replacement card (replace only), modifier.
// `encounterIndex` counts the fights whose rewards were already claimed. The tier changes
// only the new-card pool, so both tiers draw the same number of times.
export function generateRewardDraft({
  seed,
  encounterIndex,
  tier,
  playerCardIds,
  activeModifiers,
  ruleset,
}) {
  if (!REWARD_TIERS.includes(tier)) {
    throw new RangeError(`Reward drafts follow only normal or elite fights, not ${String(tier)}`)
  }
  const rng = createDerivedRng(seed, REWARD_DRAFT_STREAM, encounterIndex)
  const copies = countCardCopies(playerCardIds)
  const deckSize = playerCardIds.length
  const canGrow = deckSize < CAMPAIGN_DECK_SIZE_LIMITS.maximum
  const unowned = CARD_IDS.filter((cardId) => !copies.has(cardId))
  const offers = []

  let newCardId = null
  if (canGrow && unowned.length > 0) {
    const pool = newCardPool(unowned, tier)
    newCardId = pool[drawIndex(pool.length, rng)]
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

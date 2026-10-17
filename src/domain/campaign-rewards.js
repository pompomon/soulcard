import {
  CAMPAIGN_CARD_COPY_LIMIT,
  CAMPAIGN_DECK_SIZE_LIMITS,
  CAMPAIGN_MEND_OFFER_ID,
  CAMPAIGN_STARTER_CARD_IDS,
} from './campaign-content.js'
import {
  assertDistinctModifierHooks,
  createModifierRecord,
  createStartingModifierRecords,
  expireEncounterModifiers,
  getDraftableModifierPool,
} from './campaign-modifiers.js'
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
export const REWARD_HISTORY_KEYS = Object.freeze([
  'encounterIndex',
  'offerId',
  'kind',
  'cardId',
  'modifierId',
  'targetInstanceId',
  'createdInstanceId',
])

const TARGETED_KINDS = new Set(['duplicate', 'remove', 'replace'])
const CREATING_KINDS = new Set(['add', 'duplicate', 'replace'])
const CARD_ORDER = new Map(CARD_IDS.map((cardId, index) => [cardId, index]))

export function rewardRequiresTarget(kind) {
  return TARGETED_KINDS.has(kind)
}

export function rewardCreatesInstance(kind) {
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

// Pool construction is RNG-free. Each non-empty seeded slot then consumes exactly one draw
// in slot order: new card, deck-edit operation, replacement card (replace only), modifier.
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

export function isRewardTargetEligible(kind, cardId, copies) {
  if (kind === 'duplicate') return copies.get(cardId) < CAMPAIGN_CARD_COPY_LIMIT
  return TARGETED_KINDS.has(kind)
}

export function compareCardsForDisplay(first, second) {
  return CARD_ORDER.get(first.cardId) - CARD_ORDER.get(second.cardId)
    || (first.instanceId < second.instanceId ? -1 : first.instanceId > second.instanceId ? 1 : 0)
}

// Player card records stay in ascending instance-ID order: removals delete the target and
// created instances (always the highest ID issued so far) are appended.
export function applyRewardToPlayerCards(cards, offer, targetInstanceId, createdInstanceId) {
  const target = cards.find((card) => card.instanceId === targetInstanceId) ?? null
  const next = cards
    .filter((card) => !(
      ['remove', 'replace'].includes(offer.kind)
      && card.instanceId === targetInstanceId
    ))
    .map((card) => ({ ...card }))
  if (rewardCreatesInstance(offer.kind)) {
    next.push({
      instanceId: createdInstanceId,
      cardId: offer.kind === 'duplicate' ? target.cardId : offer.cardId,
      campaignOwner: 'player',
    })
  }
  return next
}

// Replays validated history entries from the starter deck. Every entry must be a legal pick
// from the draft regenerated for that point in the history.
export function replayRewardHistory({ seed, ruleset, history }) {
  let playerCards = createStarterPlayerCards()
  let activeModifiers = createStartingModifierRecords()
  let issuedCount = playerCards.length
  for (let index = 0; index < history.length; index += 1) {
    const entry = history[index]
    if (entry.encounterIndex !== index) {
      throw new Error('Reward history entries must follow completed encounter order')
    }
    const draft = generateRewardDraft({
      seed,
      encounterIndex: index,
      playerCardIds: playerCards.map(({ cardId }) => cardId),
      activeModifiers,
      ruleset,
    })
    const offer = draft.offers.find(({ offerId }) => offerId === entry.offerId)
    if (
      offer === undefined
      || offer.kind !== entry.kind
      || offer.cardId !== entry.cardId
      || offer.modifierId !== entry.modifierId
    ) {
      throw new Error(`Reward history entry ${index} must match its regenerated draft`)
    }
    if (rewardRequiresTarget(offer.kind)) {
      const copies = countCardCopies(playerCards.map(({ cardId }) => cardId))
      const target = playerCards.find(({ instanceId }) => instanceId === entry.targetInstanceId)
      if (target === undefined || !isRewardTargetEligible(offer.kind, target.cardId, copies)) {
        throw new Error(`Reward history entry ${index} must target an eligible player card`)
      }
    } else if (entry.targetInstanceId !== null) {
      throw new Error(`Reward history entry ${index} must not record a target`)
    }
    const createdInstanceId = rewardCreatesInstance(offer.kind)
      ? playerInstanceId(issuedCount + 1)
      : null
    if (entry.createdInstanceId !== createdInstanceId) {
      throw new Error(`Reward history entry ${index} must record the next player instance ID`)
    }
    if (createdInstanceId !== null) issuedCount += 1
    activeModifiers = expireEncounterModifiers(activeModifiers)
    playerCards = applyRewardToPlayerCards(
      playerCards,
      offer,
      entry.targetInstanceId,
      createdInstanceId,
    )
    if (offer.kind === 'modifier') {
      activeModifiers = [...activeModifiers, createModifierRecord(offer.modifierId, index)]
      assertDistinctModifierHooks(activeModifiers)
    }
  }
  return { playerCards, activeModifiers, issuedCount }
}

import {
  CAMPAIGN_CARD_COPY_LIMIT,
  CAMPAIGN_DECK_SIZE_LIMITS,
  CAMPAIGN_SHOP_PRICES,
  getCampaignShop,
} from './campaign-content.js'
import { countCardCopies, deckEditAvailability } from './campaign-deck.js'
import { getAvailableModifierPool, modifierGainBlocker } from './campaign-modifiers.js'
import { CARD_IDS } from './cards.js'
import { createDerivedRng, drawIndex } from './rng.js'

export const SHOP_STOCK_STREAM = 'campaign-shop-stock-v1'
export const SHOP_ITEM_KEYS = Object.freeze([
  'itemId',
  'kind',
  'cardId',
  'modifierId',
  'price',
  'sold',
])

// Stock is generated once, when the route enters the shop, from a stream indexed by the
// shop node's map position. Pools are RNG-free in canonical card or modifier-ID order.
// Each non-empty slot then takes one draw in slot order, plus one more for the card of a
// replace service. A shop never offers the same card twice.
export function generateShopStock({
  seed,
  nodeIndex,
  shopId,
  playerCardIds,
  activeModifiers,
  ruleset,
}) {
  const shop = getCampaignShop(shopId)
  const rng = createDerivedRng(seed, SHOP_STOCK_STREAM, nodeIndex)
  const copies = countCardCopies(playerCardIds)
  const deckSize = playerCardIds.length
  const canGrow = deckSize < CAMPAIGN_DECK_SIZE_LIMITS.maximum
  const offered = new Set()
  const ordinals = new Map()
  const items = []
  const unofferedUnowned = () => CARD_IDS.filter((cardId) => (
    !copies.has(cardId) && !offered.has(cardId)
  ))

  for (const slot of shop.slots) {
    const ordinal = (ordinals.get(slot) ?? 0) + 1
    ordinals.set(slot, ordinal)
    const itemId = `${slot}-${ordinal}`
    const price = CAMPAIGN_SHOP_PRICES[slot]
    if (slot === 'card') {
      const pool = canGrow ? unofferedUnowned() : []
      if (pool.length === 0) continue
      const cardId = pool[drawIndex(pool.length, rng)]
      offered.add(cardId)
      items.push({ itemId, kind: 'add', cardId, modifierId: null, price, sold: false })
    } else if (slot === 'service') {
      const replacementPool = unofferedUnowned()
      const operations = []
      if (canGrow && [...copies.values()].some((count) => count < CAMPAIGN_CARD_COPY_LIMIT)) {
        operations.push('duplicate')
      }
      if (deckSize > CAMPAIGN_DECK_SIZE_LIMITS.minimum) operations.push('remove')
      if (replacementPool.length > 0) operations.push('replace')
      if (operations.length === 0) continue
      const kind = operations[drawIndex(operations.length, rng)]
      const cardId = kind === 'replace'
        ? replacementPool[drawIndex(replacementPool.length, rng)]
        : null
      if (cardId !== null) offered.add(cardId)
      items.push({ itemId, kind, cardId, modifierId: null, price, sold: false })
    } else {
      const pool = getAvailableModifierPool(activeModifiers, ruleset)
      if (pool.length === 0) continue
      items.push({
        itemId,
        kind: 'modifier',
        cardId: null,
        modifierId: pool[drawIndex(pool.length, rng)],
        price,
        sold: false,
      })
    }
  }
  return items
}

export function modifierAvailability(activeModifiers, modifierId, ruleset) {
  const blocker = modifierGainBlocker(activeModifiers, modifierId, ruleset)
  if (blocker === null) return null
  return ['active', 'hook-conflict'].includes(blocker) ? 'modifier-conflict' : 'modifier-unavailable'
}

// Context: health, currency, ruleset, activeModifiers, every player card, and the cards a
// decision may target. Live decisions exclude the held card from those candidates;
// journal replay cannot know Hold contents and passes every player card instead.
export function shopItemBlocker(item, context) {
  if (item.sold) return 'sold'
  const blocker = item.kind === 'modifier'
    ? modifierAvailability(context.activeModifiers, item.modifierId, context.ruleset)
    : deckEditAvailability(item, context.playerCards, context.targetCandidates)
  if (blocker !== null) return blocker
  if (context.currency < item.price) return 'unaffordable'
  return null
}

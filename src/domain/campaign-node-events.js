import { CAMPAIGN_DECK_SIZE_LIMITS } from './campaign-content.js'
import { deckEditAvailability } from './campaign-deck.js'
import { modifierAvailability } from './campaign-shop.js'

// Uses the shop decision context. `holdOccupied` is a boolean for live decisions and null
// during journal replay, which cannot know Hold contents and therefore skips that check.
export function eventOptionBlocker(option, context) {
  if (option.healthCost > 0 && context.health <= option.healthCost) return 'health-too-low'
  if (option.surrenderHold) {
    if (context.holdOccupied === false) return 'hold-empty'
    if (context.playerCards.length <= CAMPAIGN_DECK_SIZE_LIMITS.minimum) return 'deck-minimum'
  }
  if (option.deckEdit !== null) {
    const blocker = deckEditAvailability(
      option.deckEdit,
      context.playerCards,
      context.targetCandidates,
    )
    if (blocker !== null) return blocker
  }
  if (option.modifierId !== null) {
    const blocker = modifierAvailability(
      context.activeModifiers,
      option.modifierId,
      context.ruleset,
    )
    if (blocker !== null) return blocker
  }
  if (context.currency < option.coinCost) return 'unaffordable'
  return null
}

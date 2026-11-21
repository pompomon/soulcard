import { SHORT_DECK, STANDARD_DECK } from '../domain/cards.js'
import {
  BASELINE_RULESET,
  NO_BURN_RULESET,
  SHORT_DECK_BASELINE_RULESET,
  SHORT_DECK_NO_BURN_RULESET,
} from '../domain/ruleset.js'

function assertBurnEnabled(burnEnabled) {
  if (typeof burnEnabled !== 'boolean') {
    throw new TypeError('burnEnabled must be a boolean')
  }
}

export function classicRuleset({ burnEnabled, classicDeck }) {
  assertBurnEnabled(burnEnabled)
  switch (classicDeck) {
    case STANDARD_DECK:
      return burnEnabled ? BASELINE_RULESET : NO_BURN_RULESET
    case SHORT_DECK:
      return burnEnabled ? SHORT_DECK_BASELINE_RULESET : SHORT_DECK_NO_BURN_RULESET
    default:
      throw new RangeError(`classicDeck must be ${STANDARD_DECK} or ${SHORT_DECK}`)
  }
}

// Campaign builds its own decks, so the Classic deck setting never reaches it.
export function campaignRuleset({ burnEnabled }) {
  assertBurnEnabled(burnEnabled)
  return burnEnabled ? BASELINE_RULESET : NO_BURN_RULESET
}

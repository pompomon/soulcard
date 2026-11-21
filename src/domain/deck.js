import { CARD_IDS } from './cards.js'
import { shuffle } from './rng.js'

export function createSourceDeck(rng, cardIds = CARD_IDS) {
  return shuffle(cardIds, rng)
}

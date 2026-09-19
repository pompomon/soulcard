import { CARD_IDS } from './cards.js'
import { shuffle } from './rng.js'

export function createSourceDeck(rng) {
  return shuffle(CARD_IDS, rng)
}

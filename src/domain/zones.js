import { createSourceDeck } from './deck.js'

export function createInitialZones(rng) {
  return {
    sourceDeck: createSourceDeck(rng),
    player: {
      drawPile: [],
      wonPile: [],
    },
    opponent: {
      drawPile: [],
      wonPile: [],
    },
    contestedPile: [],
    burnPile: [],
    inPlay: [],
  }
}

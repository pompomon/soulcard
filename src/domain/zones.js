import { createSourceDeck } from './deck.js'

export function createInitialZones(rng, cardIds) {
  return {
    sourceDeck: createSourceDeck(rng, cardIds),
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

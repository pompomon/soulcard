function deepFreeze(value) {
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === 'object') {
      deepFreeze(child)
    }
  }
  return Object.freeze(value)
}

export const BASELINE_RULESET_FIXTURE = deepFreeze({
  id: 'mvp-baseline-v1',
  burn: {
    enabled: true,
    eligibleScope: 'all-losing-side-cards-in-resolved-contested-pile',
    decisiveWinningCard: 'winner.wonPile',
  },
})

export const NO_BURN_RULESET_FIXTURE = deepFreeze({
  id: 'debug-no-burn-v1',
  burn: {
    enabled: false,
  },
})

export const PRECEDENCE_RULESET_FIXTURE = deepFreeze({
  id: 'test-ordered-predicates-v1',
  burn: {
    enabled: true,
    eligibleScope: 'all-losing-side-cards-in-resolved-contested-pile',
    decisiveWinningCard: 'winner.wonPile',
    rules: [
      { match: { cardIds: ['c-2S'] }, outcome: 'transfer' },
      { match: { ranks: ['K'], suits: ['H', 'D'] }, outcome: 'burn' },
      { match: { chance: 0.5 }, outcome: 'burn' },
    ],
    defaultOutcome: 'transfer',
  },
})

import { CARDS } from './cards.js'

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

const bySuits = (...suits) => suits.flatMap((suit) => CARDS
  .filter((card) => card.suit === suit)
  .map((card) => card.id))

const byRanks = (...ranks) => CARDS
  .filter((card) => ranks.includes(card.rank))
  .map((card) => card.id)

export const CAMPAIGN_STARTING_HEALTH = 3
export const CAMPAIGN_MAX_HEALTH = 5

export const CAMPAIGN_STARTER_CARD_IDS = deepFreeze(bySuits('D', 'H'))

export const CAMPAIGN_ENCOUNTERS = deepFreeze([
  {
    id: 'suit-opposition',
    name: 'Suit Opposition',
    opponentCardIds: bySuits('S', 'C'),
    damage: 1,
    reward: {
      type: 'add-aces',
      cardIds: ['c-AS', 'c-AC'],
    },
  },
  {
    id: 'royal-court',
    name: 'Royal Court',
    opponentCardIds: byRanks('J', 'Q', 'K'),
    damage: 1,
    reward: {
      type: 'restore-health',
      amount: 1,
    },
  },
  {
    id: 'ace-assembly',
    name: 'Ace Assembly',
    opponentCardIds: byRanks('A'),
    damage: 2,
    reward: null,
  },
])

export const CAMPAIGN_MODIFIER = deepFreeze({
  id: 'vitality-cap-v1',
  lifetime: 'campaign',
  effect: {
    type: 'maximum-health',
    value: CAMPAIGN_MAX_HEALTH,
  },
})

export function getCampaignEncounter(index) {
  const encounter = CAMPAIGN_ENCOUNTERS[index]
  if (encounter === undefined) {
    throw new RangeError('encounter index is outside the authored campaign')
  }
  return encounter
}

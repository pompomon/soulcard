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
  },
  {
    id: 'royal-court',
    name: 'Royal Court',
    opponentCardIds: byRanks('J', 'Q', 'K'),
    damage: 1,
  },
  {
    id: 'ace-assembly',
    name: 'Ace Assembly',
    opponentCardIds: byRanks('A'),
    damage: 2,
  },
])

// Reward drafts: seeded slots in draw order, followed by the unseeded Mend offer.
export const CAMPAIGN_REWARD_SLOTS = deepFreeze(['new-card', 'deck-edit', 'modifier'])
export const CAMPAIGN_MEND_OFFER_ID = 'mend'
export const CAMPAIGN_MEND_HEALTH = 1
export const CAMPAIGN_DECK_SIZE_LIMITS = deepFreeze({ minimum: 20, maximum: 40 })
export const CAMPAIGN_CARD_COPY_LIMIT = 2

export function getCampaignEncounter(index) {
  const encounter = CAMPAIGN_ENCOUNTERS[index]
  if (encounter === undefined) {
    throw new RangeError('encounter index is outside the authored campaign')
  }
  return encounter
}

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

// Fights are referenced by ID from route nodes. A fight's bounty is paid in coins when
// its reward is claimed; the final fight ends the run instead of opening a reward.
export const CAMPAIGN_FIGHTS = deepFreeze([
  {
    id: 'suit-opposition',
    name: 'Suit Opposition',
    opponentCardIds: bySuits('S', 'C'),
    damage: 1,
    bounty: 3,
  },
  {
    id: 'royal-court',
    name: 'Royal Court',
    opponentCardIds: byRanks('J', 'Q', 'K'),
    damage: 1,
    bounty: 4,
  },
  {
    id: 'watch-of-tens',
    name: 'Watch of Tens',
    opponentCardIds: byRanks('8', '9', '10'),
    damage: 1,
    bounty: 2,
  },
  {
    id: 'ace-assembly',
    name: 'Ace Assembly',
    opponentCardIds: byRanks('A'),
    damage: 2,
    bounty: 0,
  },
])

// Reward drafts: seeded slots in draw order, followed by the unseeded Mend offer.
export const CAMPAIGN_REWARD_SLOTS = deepFreeze(['new-card', 'deck-edit', 'modifier'])
export const CAMPAIGN_MEND_OFFER_ID = 'mend'
export const CAMPAIGN_MEND_HEALTH = 1
export const CAMPAIGN_DECK_SIZE_LIMITS = deepFreeze({ minimum: 20, maximum: 40 })
export const CAMPAIGN_CARD_COPY_LIMIT = 2

// Shop slots in draw order. A card slot offers an unowned card, a service slot offers a
// duplicate, remove, or replace edit, and a modifier slot offers one modifier.
export const CAMPAIGN_SHOP_SLOT_KINDS = deepFreeze(['card', 'service', 'modifier'])
export const CAMPAIGN_SHOP_PRICES = deepFreeze({ card: 3, service: 2, modifier: 4 })
export const CAMPAIGN_SHOPS = deepFreeze([
  {
    id: 'wayside-market',
    name: 'Wayside Market',
    description: 'A roadside stall trades cards and charms for coins.',
    slots: ['card', 'service', 'modifier'],
  },
  {
    id: 'ember-bazaar',
    name: 'Ember Bazaar',
    description: 'The last market before the finale stocks two cards.',
    slots: ['card', 'card', 'service', 'modifier'],
  },
])

const WALK_ON = {
  id: 'walk-on',
  label: 'Walk on',
  healthCost: 0,
  coinCost: 0,
  surrenderHold: false,
  deckEdit: null,
  modifierId: null,
  healthGain: 0,
  coinGain: 0,
}

// Event options state every cost and gain explicitly and draw no randomness. A health
// cost needs more health than it takes, so an event can never end the run.
export const CAMPAIGN_NODE_EVENTS = deepFreeze([
  {
    id: 'crossroads-shrine',
    name: 'Crossroads Shrine',
    description: 'A shrine at the fork trades blood for coins, or mends you for an offering.',
    options: [
      {
        ...WALK_ON,
        id: 'bleed-for-fortune',
        label: 'Bleed for fortune',
        healthCost: 1,
        coinGain: 4,
      },
      {
        ...WALK_ON,
        id: 'burn-an-offering',
        label: 'Burn an offering',
        deckEdit: { kind: 'remove', cardId: null },
        healthGain: 2,
      },
      WALK_ON,
    ],
  },
  {
    id: 'oathkeepers-vault',
    name: "Oathkeeper's Vault",
    description: 'An oathkeeper trades insight for the card you guard, or a copy for coins.',
    options: [
      {
        ...WALK_ON,
        id: 'surrender-held-card',
        label: 'Surrender the held card',
        surrenderHold: true,
        modifierId: 'hold-insight-v1',
      },
      {
        ...WALK_ON,
        id: 'pay-for-a-copy',
        label: 'Pay 3 coins',
        coinCost: 3,
        deckEdit: { kind: 'duplicate', cardId: null },
      },
      WALK_ON,
    ],
  },
])

function findById(entries, id, kind) {
  const entry = entries.find((candidate) => candidate.id === id)
  if (entry === undefined) {
    throw new RangeError(`Unknown campaign ${kind}: ${String(id)}`)
  }
  return entry
}

export function getCampaignFight(id) {
  return findById(CAMPAIGN_FIGHTS, id, 'fight')
}

export function getCampaignShop(id) {
  return findById(CAMPAIGN_SHOPS, id, 'shop')
}

export function getCampaignNodeEvent(id) {
  return findById(CAMPAIGN_NODE_EVENTS, id, 'event')
}

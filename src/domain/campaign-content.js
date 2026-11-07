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

// Lists the given cards in canonical deck order: suit-major, then rank.
const inDeckOrder = (cardIds) => CARDS
  .filter((card) => cardIds.includes(card.id))
  .map((card) => card.id)

export const CAMPAIGN_STARTING_HEALTH = 3
export const CAMPAIGN_MAX_HEALTH = 5

// No single node may restore more health than this: rewards, rests, events, or vows.
export const CAMPAIGN_NODE_HEAL_LIMIT = 2

export const CAMPAIGN_STARTER_CARD_IDS = deepFreeze(bySuits('D', 'H'))

// An archetype is an opponent family defined by its core deck.
export const CAMPAIGN_ARCHETYPES = deepFreeze([
  {
    id: 'legion',
    name: 'Suit Legion',
    description: 'Every spade and club, from 2 to ace.',
    coreCardIds: bySuits('S', 'C'),
  },
  {
    id: 'court',
    name: 'Court',
    description: 'The jacks, queens and kings of every suit.',
    coreCardIds: byRanks('J', 'Q', 'K'),
  },
  {
    id: 'watch',
    name: 'Watch',
    description: 'The 8s, 9s and 10s of every suit.',
    coreCardIds: byRanks('8', '9', '10'),
  },
  {
    id: 'sovereign',
    name: 'Sovereign',
    description: 'The kings and aces of every suit.',
    coreCardIds: byRanks('K', 'A'),
  },
])

export const CAMPAIGN_FIGHT_TIERS = deepFreeze(['normal', 'elite', 'boss'])

// Fights are referenced by ID from route nodes. A normal fight fields its archetype's
// core; an elite or the boss adds cards so that every rank can lose a clash. A fight's
// bounty is paid in coins when its reward is claimed; the boss is the final fight and
// ends the run instead of opening a reward. Traits are opponent-owned catalogue entries.
export const CAMPAIGN_FIGHTS = deepFreeze([
  {
    id: 'suit-opposition',
    name: 'Suit Opposition',
    archetypeId: 'legion',
    tier: 'normal',
    opponentCardIds: bySuits('S', 'C'),
    damage: 1,
    bounty: 3,
    traitIds: [],
  },
  {
    id: 'royal-court',
    name: 'Royal Court',
    archetypeId: 'court',
    tier: 'normal',
    opponentCardIds: byRanks('J', 'Q', 'K'),
    damage: 1,
    bounty: 4,
    traitIds: [],
  },
  {
    id: 'high-court',
    name: 'High Court',
    archetypeId: 'court',
    tier: 'elite',
    opponentCardIds: inDeckOrder([...byRanks('J', 'Q', 'K'), 'c-AS', 'c-AC']),
    damage: 2,
    bounty: 6,
    traitIds: ['court-etiquette-v1'],
  },
  {
    id: 'watch-of-tens',
    name: 'Watch of Tens',
    archetypeId: 'watch',
    tier: 'normal',
    opponentCardIds: byRanks('8', '9', '10'),
    damage: 1,
    bounty: 0,
    traitIds: [],
  },
  {
    id: 'night-watch',
    name: 'Night Watch',
    archetypeId: 'watch',
    tier: 'elite',
    opponentCardIds: inDeckOrder([...byRanks('8', '9', '10'), 'c-AS', 'c-AC']),
    damage: 2,
    bounty: 0,
    traitIds: ['plunder-v1'],
  },
  {
    id: 'ace-sovereign',
    name: 'Ace Sovereign',
    archetypeId: 'sovereign',
    tier: 'boss',
    opponentCardIds: byRanks('K', 'A'),
    damage: 2,
    bounty: 0,
    traitIds: [],
  },
])

// Reward drafts: seeded slots in draw order, followed by the unseeded Mend offer.
export const CAMPAIGN_REWARD_SLOTS = deepFreeze(['new-card', 'deck-edit', 'modifier'])
export const CAMPAIGN_MEND_OFFER_ID = 'mend'
// Mend after a normal fight restores 1 health; Greater Mend after an elite restores 2.
export const CAMPAIGN_MEND_HEALTH_BY_TIER = deepFreeze({ normal: 1, elite: 2 })
// Elite new-card offers draw from unowned cards of these ranks while any remain.
export const CAMPAIGN_ELITE_CARD_RANKS = deepFreeze(['J', 'Q', 'K', 'A'])
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
        coinGain: 5,
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

// Rest sites offer cost-free options in the event option shape: each either heals or
// edits the deck, and the last is always Walk on.
export const CAMPAIGN_REST_SITES = deepFreeze([
  {
    id: 'roadside-camp',
    name: 'Roadside Camp',
    description: 'A sheltered fire offers rest, or a quiet hour to train a card.',
    options: [
      {
        ...WALK_ON,
        id: 'rest',
        label: 'Rest by the fire',
        healthGain: 2,
      },
      {
        ...WALK_ON,
        id: 'train',
        label: 'Train a card',
        deckEdit: { kind: 'duplicate', cardId: null },
      },
      WALK_ON,
    ],
  },
  {
    id: 'last-light-sanctum',
    name: 'Last Light Sanctum',
    description: 'The last shelter before the sovereign offers rest, or a rite to cleanse a card.',
    options: [
      {
        ...WALK_ON,
        id: 'rest',
        label: 'Rest in the sanctum',
        healthGain: 2,
      },
      {
        ...WALK_ON,
        id: 'cleanse',
        label: 'Cleanse a card',
        deckEdit: { kind: 'remove', cardId: null },
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

export function getCampaignArchetype(id) {
  return findById(CAMPAIGN_ARCHETYPES, id, 'archetype')
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

export function getCampaignRestSite(id) {
  return findById(CAMPAIGN_REST_SITES, id, 'rest site')
}

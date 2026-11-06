import { CAMPAIGN_MAX_HEALTH, CAMPAIGN_NODE_HEAL_LIMIT } from './campaign-content.js'
import { compareCards, getCard, RANKS } from './cards.js'

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

// Rule hooks frozen since campaign rules version 4. Later rules versions may add hooks.
export const CAMPAIGN_MODIFIER_HOOKS = deepFreeze([
  'maximumHealth',
  'holdDecision',
  'holdCaptureEligibility',
  'holdReplacementEligibility',
  'burnSettlement',
])

export const CAMPAIGN_MODIFIER_LIFETIMES = deepFreeze(['campaign', 'encounter'])

// Player modifiers are gained during the run. Opponent traits belong to an authored fight
// and exist only while its encounter does.
export const CAMPAIGN_MODIFIER_OWNERS = deepFreeze(['player', 'opponent'])

const OPPONENT_TRAIT_HOOKS = Object.freeze([
  'holdCaptureEligibility',
  'holdReplacementEligibility',
  'burnSettlement',
])

// The effect types each hook understands. Replacement-not-weaker compares against the
// held card, so it cannot restrict a capture into an empty Hold.
const HOOK_EFFECT_TYPES = Object.freeze({
  maximumHealth: Object.freeze(['maximum-health']),
  holdDecision: Object.freeze(['informed-hold-choice']),
  holdCaptureEligibility: Object.freeze(['capture-from-zones', 'capture-ranks']),
  holdReplacementEligibility: Object.freeze([
    'capture-from-zones',
    'capture-ranks',
    'replacement-not-weaker',
  ]),
  burnSettlement: Object.freeze(['winner-claims-burns']),
})

const NUMBER_RANKS = Object.freeze(RANKS.slice(0, 9).map(({ rank }) => rank))

export const HOLD_INSIGHT_MODIFIER_ID = 'hold-insight-v1'
export const VITALITY_CAP_MODIFIER_ID = 'vitality-cap-v1'

const MODIFIER_ID_PATTERN = /^[a-z]+(?:-[a-z]+)*-v[1-9][0-9]*$/

// Sorted by ID; draft modifier pools preserve this order.
export const CAMPAIGN_MODIFIER_CATALOGUE = deepFreeze([
  {
    id: 'court-etiquette-v1',
    name: 'Court Etiquette',
    owner: 'opponent',
    description: 'Opponent trait. In this encounter, an empty Hold can capture only a 2–10, and an occupied Hold can be replaced only by a 2–10.',
    lifetime: 'encounter',
    hooks: ['holdCaptureEligibility', 'holdReplacementEligibility'],
    effect: { type: 'capture-ranks', ranks: NUMBER_RANKS },
    draftable: false,
    applicability: null,
    healthOnGain: 0,
  },
  {
    id: HOLD_INSIGHT_MODIFIER_ID,
    name: 'Hold Insight',
    owner: 'player',
    description: 'Before each Hold decision, see the next card your opponent will reveal.',
    lifetime: 'campaign',
    hooks: ['holdDecision'],
    effect: { type: 'informed-hold-choice' },
    draftable: true,
    applicability: null,
    healthOnGain: 0,
  },
  {
    id: 'plunder-v1',
    name: 'Plunder',
    owner: 'opponent',
    description: 'Opponent trait. Clashes this opponent wins send your cards to its won pile instead of burning them. They return to your deck after the encounter. Spoils of War has no effect against it.',
    lifetime: 'encounter',
    hooks: ['burnSettlement'],
    effect: { type: 'winner-claims-burns', winner: 'opponent' },
    draftable: false,
    applicability: { burnEnabled: true },
    healthOnGain: 0,
  },
  {
    id: 'spoils-of-war-v1',
    name: 'Spoils of War',
    owner: 'player',
    description: 'For your next encounter, including retries, clashes you win send your opponent\'s cards to your won pile instead of burning them.',
    lifetime: 'encounter',
    hooks: ['burnSettlement'],
    effect: { type: 'winner-claims-burns', winner: 'player' },
    draftable: true,
    applicability: { burnEnabled: true },
    healthOnGain: 0,
  },
  {
    id: VITALITY_CAP_MODIFIER_ID,
    name: 'Vitality Cap',
    owner: 'player',
    description: 'Maximum health is 5.',
    lifetime: 'campaign',
    hooks: ['maximumHealth'],
    effect: { type: 'maximum-health', value: CAMPAIGN_MAX_HEALTH },
    draftable: false,
    applicability: null,
    healthOnGain: 0,
  },
  {
    id: 'vow-of-constancy-v1',
    name: 'Vow of Constancy',
    owner: 'player',
    description: 'Restore 2 health. An occupied Hold can be replaced only by a card that does not lose to the held card (2 still beats A).',
    lifetime: 'campaign',
    hooks: ['holdReplacementEligibility'],
    effect: { type: 'replacement-not-weaker' },
    draftable: true,
    applicability: null,
    healthOnGain: 2,
  },
  {
    id: 'vow-of-patience-v1',
    name: 'Vow of Patience',
    owner: 'player',
    description: 'Restore 2 health. An empty Hold can capture only from your won pile.',
    lifetime: 'campaign',
    hooks: ['holdCaptureEligibility'],
    effect: { type: 'capture-from-zones', zones: ['player.wonPile'] },
    draftable: true,
    applicability: null,
    healthOnGain: 2,
  },
  {
    id: 'vow-of-the-court-v1',
    name: 'Vow of the Court',
    owner: 'player',
    description: 'Restore 2 health. An empty Hold can capture only a J, Q, K, or A.',
    lifetime: 'campaign',
    hooks: ['holdCaptureEligibility'],
    effect: { type: 'capture-ranks', ranks: ['J', 'Q', 'K', 'A'] },
    draftable: true,
    applicability: null,
    healthOnGain: 2,
  },
])

export function validateModifierCatalogue(catalogue) {
  if (!Array.isArray(catalogue) || catalogue.length === 0) {
    throw new TypeError('Modifier catalogue must be a non-empty array')
  }
  let previousId = null
  for (const entry of catalogue) {
    if (typeof entry?.id !== 'string' || !MODIFIER_ID_PATTERN.test(entry.id)) {
      throw new TypeError('Modifier IDs must be versioned lowercase names')
    }
    if (previousId !== null && entry.id <= previousId) {
      throw new Error('Modifier catalogue entries must be sorted by unique ID')
    }
    previousId = entry.id
    if (
      typeof entry.name !== 'string'
      || entry.name.length === 0
      || typeof entry.description !== 'string'
      || entry.description.length === 0
    ) {
      throw new TypeError(`Modifier ${entry.id} requires a name and description`)
    }
    if (!CAMPAIGN_MODIFIER_LIFETIMES.includes(entry.lifetime)) {
      throw new TypeError(`Modifier ${entry.id} has an unknown lifetime`)
    }
    if (
      !Array.isArray(entry.hooks)
      || entry.hooks.length === 0
      || new Set(entry.hooks).size !== entry.hooks.length
      || entry.hooks.some((hook) => !CAMPAIGN_MODIFIER_HOOKS.includes(hook))
    ) {
      throw new TypeError(`Modifier ${entry.id} requires distinct known rule hooks`)
    }
    if (entry.effect === null || typeof entry.effect !== 'object' || typeof entry.effect.type !== 'string') {
      throw new TypeError(`Modifier ${entry.id} requires effect parameters`)
    }
    if (typeof entry.draftable !== 'boolean') {
      throw new TypeError(`Modifier ${entry.id} requires a draftable flag`)
    }
    if (
      entry.applicability !== null
      && (
        typeof entry.applicability !== 'object'
        || typeof entry.applicability.burnEnabled !== 'boolean'
      )
    ) {
      throw new TypeError(`Modifier ${entry.id} has an unsupported applicability condition`)
    }
    if (!Number.isSafeInteger(entry.healthOnGain) || entry.healthOnGain < 0) {
      throw new TypeError(`Modifier ${entry.id} requires non-negative health on gain`)
    }
    if (entry.healthOnGain > CAMPAIGN_NODE_HEAL_LIMIT) {
      throw new RangeError(
        `Modifier ${entry.id} cannot restore more than ${CAMPAIGN_NODE_HEAL_LIMIT} health`,
      )
    }
    if (!CAMPAIGN_MODIFIER_OWNERS.includes(entry.owner)) {
      throw new TypeError(`Modifier ${entry.id} must be owned by the player or the opponent`)
    }
    if (entry.owner === 'opponent') validateOpponentTrait(entry)
    for (const hook of entry.hooks) {
      if (!HOOK_EFFECT_TYPES[hook].includes(entry.effect.type)) {
        throw new TypeError(`Modifier ${entry.id} cannot apply ${entry.effect.type} to ${hook}`)
      }
    }
    if (entry.effect.type === 'winner-claims-burns' && entry.effect.winner !== entry.owner) {
      throw new TypeError(`Modifier ${entry.id} may only claim burns for its owner`)
    }
  }
  return catalogue
}

// Traits last one encounter, are never gained, and touch only Hold eligibility and burns.
function validateOpponentTrait(entry) {
  if (entry.lifetime !== 'encounter' || entry.draftable || entry.healthOnGain !== 0) {
    throw new TypeError(
      `Opponent trait ${entry.id} must last one encounter, restore no health, and never be drafted`,
    )
  }
  if (entry.hooks.some((hook) => !OPPONENT_TRAIT_HOOKS.includes(hook))) {
    throw new TypeError(`Opponent trait ${entry.id} may modify only Hold eligibility or burns`)
  }
}

validateModifierCatalogue(CAMPAIGN_MODIFIER_CATALOGUE)

const MODIFIER_BY_ID = new Map(CAMPAIGN_MODIFIER_CATALOGUE.map((entry) => [entry.id, entry]))

export function isCampaignModifierId(id) {
  return typeof id === 'string' && MODIFIER_BY_ID.has(id)
}

export function isOpponentTraitId(id) {
  return isCampaignModifierId(id) && MODIFIER_BY_ID.get(id).owner === 'opponent'
}

export function getCampaignModifier(id) {
  const modifier = MODIFIER_BY_ID.get(id)
  if (modifier === undefined) throw new RangeError(`Unknown campaign modifier: ${String(id)}`)
  return modifier
}

// Records name the route node that granted them; the starting modifier has none. Opponent
// traits are never records.
export function createModifierRecord(id, grantedAtNodeId) {
  const modifier = getCampaignModifier(id)
  if (modifier.owner !== 'player') {
    throw new Error(`Opponent trait ${modifier.id} cannot become an active modifier`)
  }
  return { id: modifier.id, lifetime: modifier.lifetime, grantedAtNodeId }
}

// The traits of an authored fight that apply under the ruleset, in catalogue order.
export function encounterTraitIds(fight, ruleset) {
  return CAMPAIGN_MODIFIER_CATALOGUE
    .filter((modifier) => (
      fight.traitIds.includes(modifier.id) && isModifierApplicable(modifier, ruleset)
    ))
    .map((modifier) => modifier.id)
}

export function createStartingModifierRecords() {
  return [createModifierRecord(VITALITY_CAP_MODIFIER_ID, null)]
}

export function assertDistinctModifierHooks(records) {
  const owners = new Map()
  for (const record of records) {
    for (const hook of getCampaignModifier(record.id).hooks) {
      if (owners.has(hook)) {
        throw new Error(
          `Campaign modifiers ${owners.get(hook)} and ${record.id} both modify ${hook}`,
        )
      }
      owners.set(hook, record.id)
    }
  }
}

export function findModifierForHook(records, hook) {
  for (const record of records) {
    const modifier = getCampaignModifier(record.id)
    if (modifier.hooks.includes(hook)) return modifier
  }
  return null
}

// A hook carries at most one player modifier and at most one opponent trait. Returns the
// effects on the hook, player first.
function hookEffects({ activeModifiers, traitIds }, hook) {
  return [
    findModifierForHook(activeModifiers, hook),
    findModifierForHook(traitIds.map((id) => ({ id })), hook),
  ]
    .filter((modifier) => modifier !== null)
    .map(({ effect }) => effect)
}

export function hasCampaignModifier(records, id) {
  return records.some((record) => record.id === id)
}

export function expireEncounterModifiers(records) {
  return records.filter((record) => record.lifetime !== 'encounter')
}

export function isModifierApplicable(modifier, ruleset) {
  return modifier.applicability === null
    || modifier.applicability.burnEnabled === ruleset.burn.enabled
}

// Returns null when a draftable modifier can join `records`, otherwise why it cannot:
// it is already active, shares a hook with an active modifier, or does not apply to the
// ruleset. Pure and RNG-free.
export function modifierGainBlocker(records, id, ruleset) {
  const modifier = getCampaignModifier(id)
  if (!modifier.draftable) return 'not-draftable'
  if (records.some((record) => record.id === id)) return 'active'
  const occupiedHooks = new Set(
    records.flatMap((record) => getCampaignModifier(record.id).hooks),
  )
  if (modifier.hooks.some((hook) => occupiedHooks.has(hook))) return 'hook-conflict'
  if (!isModifierApplicable(modifier, ruleset)) return 'inapplicable'
  return null
}

// Shops and events: no teardown precedes the gain, so unexpired encounter modifiers still
// occupy their hooks. The pool keeps catalogue ID order.
export function getAvailableModifierPool(records, ruleset) {
  return CAMPAIGN_MODIFIER_CATALOGUE
    .filter((modifier) => modifierGainBlocker(records, modifier.id, ruleset) === null)
    .map((modifier) => modifier.id)
}

// Reward drafts: the pool excludes modifiers that survive the upcoming teardown,
// anything sharing a hook with them, and anything inapplicable to the ruleset.
export function getDraftableModifierPool(records, ruleset) {
  return getAvailableModifierPool(expireEncounterModifiers(records), ruleset)
}

export function maximumHealthFor(records) {
  const modifier = findModifierForHook(records, 'maximumHealth')
  if (modifier === null) throw new Error('Campaign requires a maximum-health modifier')
  return modifier.effect.value
}

export function hasInformedHoldChoice(records) {
  return findModifierForHook(records, 'holdDecision')?.effect.type === 'informed-hold-choice'
}

// Returns whether a settled contest card burns. Only cards supplied by the clash loser can
// burn, and not when an effect claims burns for the clash winner. An opponent trait on the
// hook suspends the player's modifier for the encounter, so Plunder and Spoils of War never
// apply together and the player's wins still burn the opponent's cards.
export function contestCardBurns({ ruleset, activeModifiers, traitIds, winner, suppliedBy }) {
  if (!ruleset.burn.enabled || suppliedBy === winner) return false
  const traitEffects = hookEffects({ activeModifiers: [], traitIds }, 'burnSettlement')
  const effects = traitEffects.length > 0
    ? traitEffects
    : hookEffects({ activeModifiers, traitIds: [] }, 'burnSettlement')
  return !effects.some((effect) => (
    effect.type === 'winner-claims-burns' && effect.winner === winner
  ))
}

function narrowByEffect(effect, targets, heldCardId) {
  if (effect.type === 'capture-from-zones') {
    return targets.filter((target) => effect.zones.includes(target.zone))
  }
  if (effect.type === 'capture-ranks') {
    return targets.filter((target) => effect.ranks.includes(getCard(target.cardId).rank))
  }
  if (effect.type === 'replacement-not-weaker') {
    return targets.filter((target) => compareCards(target.cardId, heldCardId) >= 0)
  }
  throw new Error(`Unsupported Hold eligibility effect: ${effect.type}`)
}

// Hold restrictions can only remove targets from the unrestricted list, never add them. The
// player modifier and the opponent trait both filter, so their order does not matter and
// together they may leave no target.
export function narrowHoldTargets({ activeModifiers, traitIds }, targets, heldCardId) {
  const hook = heldCardId === null ? 'holdCaptureEligibility' : 'holdReplacementEligibility'
  return hookEffects({ activeModifiers, traitIds }, hook)
    .reduce((remaining, effect) => narrowByEffect(effect, remaining, heldCardId), targets)
}

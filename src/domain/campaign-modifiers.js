import { CAMPAIGN_MAX_HEALTH } from './campaign-content.js'
import { compareCards, getCard } from './cards.js'

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

// Rule hooks frozen for campaign rules version 4. Later rules versions may add hooks.
export const CAMPAIGN_MODIFIER_HOOKS = deepFreeze([
  'maximumHealth',
  'holdDecision',
  'holdCaptureEligibility',
  'holdReplacementEligibility',
  'burnSettlement',
])

export const CAMPAIGN_MODIFIER_LIFETIMES = deepFreeze(['campaign', 'encounter'])

export const HOLD_INSIGHT_MODIFIER_ID = 'hold-insight-v1'
export const VITALITY_CAP_MODIFIER_ID = 'vitality-cap-v1'

const MODIFIER_ID_PATTERN = /^[a-z]+(?:-[a-z]+)*-v[1-9][0-9]*$/

// Sorted by ID; draft modifier pools preserve this order.
export const CAMPAIGN_MODIFIER_CATALOGUE = deepFreeze([
  {
    id: HOLD_INSIGHT_MODIFIER_ID,
    name: 'Hold Insight',
    description: 'Before each Hold decision, see the next card your opponent will reveal.',
    lifetime: 'campaign',
    hooks: ['holdDecision'],
    effect: { type: 'informed-hold-choice' },
    draftable: true,
    applicability: null,
    healthOnGain: 0,
  },
  {
    id: 'spoils-of-war-v1',
    name: 'Spoils of War',
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
  }
  return catalogue
}

validateModifierCatalogue(CAMPAIGN_MODIFIER_CATALOGUE)

const MODIFIER_BY_ID = new Map(CAMPAIGN_MODIFIER_CATALOGUE.map((entry) => [entry.id, entry]))

export function isCampaignModifierId(id) {
  return typeof id === 'string' && MODIFIER_BY_ID.has(id)
}

export function getCampaignModifier(id) {
  const modifier = MODIFIER_BY_ID.get(id)
  if (modifier === undefined) throw new RangeError(`Unknown campaign modifier: ${String(id)}`)
  return modifier
}

export function createModifierRecord(id, grantedAtEncounterIndex) {
  const modifier = getCampaignModifier(id)
  return { id: modifier.id, lifetime: modifier.lifetime, grantedAtEncounterIndex }
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

// Pure and RNG-free: the pool excludes modifiers that survive the upcoming teardown,
// anything sharing a hook with them, and anything inapplicable to the ruleset.
export function getDraftableModifierPool(records, ruleset) {
  const surviving = expireEncounterModifiers(records)
  const activeIds = new Set(surviving.map((record) => record.id))
  const occupiedHooks = new Set(
    surviving.flatMap((record) => getCampaignModifier(record.id).hooks),
  )
  return CAMPAIGN_MODIFIER_CATALOGUE
    .filter((modifier) => (
      modifier.draftable
      && !activeIds.has(modifier.id)
      && modifier.hooks.every((hook) => !occupiedHooks.has(hook))
      && isModifierApplicable(modifier, ruleset)
    ))
    .map((modifier) => modifier.id)
}

export function maximumHealthFor(records) {
  const modifier = findModifierForHook(records, 'maximumHealth')
  if (modifier === null) throw new Error('Campaign requires a maximum-health modifier')
  return modifier.effect.value
}

export function hasInformedHoldChoice(records) {
  return findModifierForHook(records, 'holdDecision')?.effect.type === 'informed-hold-choice'
}

// Returns whether a settled contest card burns. Only cards supplied by the clash loser can burn.
export function contestCardBurns({ ruleset, activeModifiers, winner, suppliedBy }) {
  if (!ruleset.burn.enabled || suppliedBy === winner) return false
  const modifier = findModifierForHook(activeModifiers, 'burnSettlement')
  return !(
    modifier?.effect.type === 'winner-claims-burns'
    && modifier.effect.winner === winner
  )
}

// Hold restrictions can only remove targets from the unrestricted list, never add them.
export function narrowHoldTargets(records, targets, heldCardId) {
  const hook = heldCardId === null ? 'holdCaptureEligibility' : 'holdReplacementEligibility'
  const modifier = findModifierForHook(records, hook)
  if (modifier === null) return targets
  const { effect } = modifier
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

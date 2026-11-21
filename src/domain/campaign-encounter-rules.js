import { CAMPAIGN_FIGHT_TIERS } from './campaign-content.js'
import { CAMPAIGN_MAP } from './campaign-map.js'
import { createDerivedRng, drawIndex } from './rng.js'

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

export const ENCOUNTER_RULE_STREAM = 'campaign-encounter-rules-v1'
export const ENCOUNTER_RULE_STARTS = Object.freeze(['either', 'both'])
export const ENCOUNTER_RULE_EFFECTS = Object.freeze(['race', 'stakes', 'attrition'])

const RULE_ID_PATTERN = /^[a-z]+(?:-[a-z]+)*-v[1-9][0-9]*$/
const RULE_KEYS = Object.freeze(['id', 'name', 'effect', 'start', 'parameter', 'tiers'])
const OVERRIDE_KEYS = Object.freeze(['start', 'parameter'])

// A rule starts once either side's supply, or both sides', has turned personal. Its
// parameter is the race target, the stake base (the k-th active clash stakes
// base^(k−1) − 1 cards a side), or the number of cards attrition burns. `tiers` may
// override the start or the parameter for a fight tier. Assignment draws an index into
// this list, so its order is part of the rules.
export const CAMPAIGN_ENCOUNTER_RULES = deepFreeze([
  {
    id: 'race-to-ten-v1',
    name: 'Race to 10',
    effect: 'race',
    start: 'both',
    parameter: 10,
    tiers: {},
  },
  {
    id: 'double-or-nothing-v1',
    name: 'Double or nothing',
    effect: 'stakes',
    start: 'either',
    parameter: 2,
    tiers: {},
  },
  {
    id: 'attrition-v1',
    name: 'Attrition',
    effect: 'attrition',
    start: 'both',
    parameter: 3,
    tiers: {},
  },
])

function isPlainObject(value) {
  return (
    value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
}

function assertKeys(value, allowed, name, { required = allowed } = {}) {
  if (!isPlainObject(value)) {
    throw new TypeError(`${name} must be a plain object`)
  }
  const keys = Object.keys(value)
  if (
    keys.some((key) => !allowed.includes(key))
    || required.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new TypeError(`${name} must contain only ${allowed.join(', ')}`)
  }
}

function assertStart(start, name) {
  if (!ENCOUNTER_RULE_STARTS.includes(start)) {
    throw new TypeError(`${name} must be ${ENCOUNTER_RULE_STARTS.join(' or ')}`)
  }
}

// A stake base of 1 would never stake a card.
function assertParameter(parameter, effect, name) {
  const minimum = effect === 'stakes' ? 2 : 1
  if (!Number.isSafeInteger(parameter) || parameter < minimum) {
    throw new TypeError(`${name} must be a safe integer of at least ${minimum}`)
  }
}

export function validateEncounterRuleCatalogue(catalogue) {
  if (!Array.isArray(catalogue) || catalogue.length === 0) {
    throw new TypeError('Encounter rule catalogue must be a non-empty array')
  }
  const ids = new Set()
  catalogue.forEach((entry, index) => {
    const name = `Encounter rule ${index}`
    assertKeys(entry, RULE_KEYS, name)
    if (typeof entry.id !== 'string' || !RULE_ID_PATTERN.test(entry.id)) {
      throw new TypeError(`${name}.id must be a versioned lowercase name`)
    }
    if (ids.has(entry.id)) {
      throw new Error(`Encounter rule ${entry.id} is duplicated`)
    }
    ids.add(entry.id)
    const path = `Encounter rule ${entry.id}`
    if (typeof entry.name !== 'string' || entry.name.length === 0) {
      throw new TypeError(`${path}.name must be a nonempty string`)
    }
    if (!ENCOUNTER_RULE_EFFECTS.includes(entry.effect)) {
      throw new TypeError(`${path}.effect must be ${ENCOUNTER_RULE_EFFECTS.join(', ')}`)
    }
    assertStart(entry.start, `${path}.start`)
    assertParameter(entry.parameter, entry.effect, `${path}.parameter`)
    assertKeys(entry.tiers, CAMPAIGN_FIGHT_TIERS, `${path}.tiers`, { required: [] })
    for (const [tier, override] of Object.entries(entry.tiers)) {
      const overridePath = `${path}.tiers.${tier}`
      assertKeys(override, OVERRIDE_KEYS, overridePath, { required: [] })
      if (Object.keys(override).length === 0) {
        throw new TypeError(`${overridePath} must override start or parameter`)
      }
      if (Object.hasOwn(override, 'start')) assertStart(override.start, `${overridePath}.start`)
      if (Object.hasOwn(override, 'parameter')) {
        assertParameter(override.parameter, entry.effect, `${overridePath}.parameter`)
      }
    }
  })
  return catalogue
}

validateEncounterRuleCatalogue(CAMPAIGN_ENCOUNTER_RULES)

const RULE_BY_ID = new Map(CAMPAIGN_ENCOUNTER_RULES.map((rule) => [rule.id, rule]))

export function isCampaignEncounterRuleId(id) {
  return typeof id === 'string' && RULE_BY_ID.has(id)
}

export function getCampaignEncounterRule(id) {
  const rule = RULE_BY_ID.get(id)
  if (rule === undefined) throw new RangeError(`Unknown campaign encounter rule: ${String(id)}`)
  return rule
}

// A catalogue rule as it plays at a fight tier, with that tier's overrides applied.
export function resolveEncounterRule(rule, tier) {
  if (!CAMPAIGN_FIGHT_TIERS.includes(tier)) {
    throw new RangeError(`Unknown campaign fight tier: ${String(tier)}`)
  }
  const override = rule.tiers[tier] ?? {}
  return Object.freeze({
    id: rule.id,
    name: rule.name,
    effect: rule.effect,
    start: override.start ?? rule.start,
    parameter: override.parameter ?? rule.parameter,
  })
}

// One draw per fight node, in map order, from a stream keyed by the node's map index.
// Other nodes draw nothing, and the run RNG is never touched.
export function assignCampaignEncounterRules(seed) {
  return deepFreeze(CAMPAIGN_MAP.nodes.flatMap(({ id, kind }, nodeIndex) => {
    if (kind !== 'fight') return []
    const rng = createDerivedRng(seed, ENCOUNTER_RULE_STREAM, nodeIndex)
    const rule = CAMPAIGN_ENCOUNTER_RULES[drawIndex(CAMPAIGN_ENCOUNTER_RULES.length, rng)]
    return [{ nodeId: id, ruleId: rule.id }]
  }))
}

// The rule of a Campaign encounter at its tier. These helpers read the encounter's tier,
// supply modes, and rule state.
export function getEncounterRule(encounter) {
  return resolveEncounterRule(getCampaignEncounterRule(encounter.rule.id), encounter.tier)
}

export function isEncounterRuleActive(encounter) {
  const { start } = getEncounterRule(encounter)
  const personal = [encounter.supplyMode.player, encounter.supplyMode.opponent]
    .filter((mode) => mode === 'personal')
  return start === 'either' ? personal.length > 0 : personal.length === 2
}

// The cards each side stakes in the next clash. A clash that activates Double or nothing
// stakes nothing, so the stake is known before the clash's first reveal.
export function getEncounterStake(encounter) {
  const rule = getEncounterRule(encounter)
  if (rule.effect !== 'stakes' || !isEncounterRuleActive(encounter)) return 0
  return rule.parameter ** encounter.rule.activeClashes - 1
}

// What the HUD shows for the encounter's rule. Fields that the rule does not use are null.
export function describeEncounterRule(encounter) {
  const rule = getEncounterRule(encounter)
  return deepFreeze({
    id: rule.id,
    name: rule.name,
    effect: rule.effect,
    start: rule.start,
    active: isEncounterRuleActive(encounter),
    activeClashes: encounter.rule.activeClashes,
    wins: { ...encounter.rule.wins },
    target: rule.effect === 'race' ? rule.parameter : null,
    stake: rule.effect === 'stakes' ? getEncounterStake(encounter) : null,
    attritionCards: rule.effect === 'attrition' ? rule.parameter : null,
  })
}

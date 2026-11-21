import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CAMPAIGN_ENCOUNTER_RULES,
  assignCampaignEncounterRules,
  describeEncounterRule,
  getCampaignEncounterRule,
  getEncounterStake,
  isEncounterRuleActive,
  resolveEncounterRule,
  validateEncounterRuleCatalogue,
} from '../../src/domain/campaign-encounter-rules.js'
import { CAMPAIGN_MAP } from '../../src/domain/campaign-map.js'

const RACE = 'race-to-ten-v1'
const DOUBLE = 'double-or-nothing-v1'
const ATTRITION = 'attrition-v1'

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function encounter(id, { player = 'source', opponent = 'source', activeClashes = 0, wins } = {}) {
  return {
    tier: 'normal',
    supplyMode: { player, opponent },
    rule: { id, activeClashes, wins: wins ?? { player: 0, opponent: 0 } },
  }
}

test('encounter rule catalogue validation names the offending entry and field', () => {
  const editing = (index, edit) => {
    const catalogue = clone(CAMPAIGN_ENCOUNTER_RULES)
    catalogue[index] = edit(catalogue[index])
    return catalogue
  }
  const cases = [
    [/non-empty array/, []],
    [/Encounter rule 0 must be a plain object/, editing(0, () => null)],
    [/Encounter rule 1 must contain only id, name, effect, start, parameter, tiers/,
      editing(1, (entry) => ({ ...entry, extra: true }))],
    [/Encounter rule 0.id must be a versioned lowercase name/,
      editing(0, (entry) => ({ ...entry, id: 'race-to-ten' }))],
    [/Encounter rule attrition-v1 is duplicated/,
      editing(0, (entry) => ({ ...entry, id: ATTRITION }))],
    [/Encounter rule attrition-v1.name must be a nonempty string/,
      editing(2, (entry) => ({ ...entry, name: '' }))],
    [/Encounter rule race-to-ten-v1.effect must be race, stakes, attrition/,
      editing(0, (entry) => ({ ...entry, effect: 'sprint' }))],
    [/Encounter rule double-or-nothing-v1.start must be either or both/,
      editing(1, (entry) => ({ ...entry, start: 'self' }))],
    [/Encounter rule race-to-ten-v1.parameter must be a safe integer of at least 1/,
      editing(0, (entry) => ({ ...entry, parameter: 0 }))],
    [/Encounter rule double-or-nothing-v1.parameter must be a safe integer of at least 2/,
      editing(1, (entry) => ({ ...entry, parameter: 1 }))],
    [/Encounter rule attrition-v1.tiers must contain only normal, elite, boss/,
      editing(2, (entry) => ({ ...entry, tiers: { minion: { parameter: 2 } } }))],
    [/Encounter rule attrition-v1.tiers.boss must override start or parameter/,
      editing(2, (entry) => ({ ...entry, tiers: { boss: {} } }))],
    [/Encounter rule attrition-v1.tiers.boss must contain only start, parameter/,
      editing(2, (entry) => ({ ...entry, tiers: { boss: { name: 'Bleed' } } }))],
    [/Encounter rule race-to-ten-v1.tiers.elite.start must be either or both/,
      editing(0, (entry) => ({ ...entry, tiers: { elite: { start: 'never' } } }))],
    [/Encounter rule double-or-nothing-v1.tiers.elite.parameter must be a safe integer of at least 2/,
      editing(1, (entry) => ({ ...entry, tiers: { elite: { parameter: 1.5 } } }))],
  ]
  for (const [expected, catalogue] of cases) {
    assert.throws(() => validateEncounterRuleCatalogue(catalogue), expected)
  }
  const overridden = editing(0, (entry) => ({
    ...entry,
    tiers: { elite: { parameter: 8 }, boss: { start: 'either' } },
  }))
  assert.equal(validateEncounterRuleCatalogue(overridden), overridden)
})

test('a tier override changes only the start or parameter it names', () => {
  const race = {
    ...getCampaignEncounterRule(RACE),
    tiers: { elite: { parameter: 8 }, boss: { start: 'either' } },
  }
  const fields = ({ start, parameter }) => ({ start, parameter })
  assert.deepEqual(fields(resolveEncounterRule(race, 'normal')), { start: 'both', parameter: 10 })
  assert.deepEqual(fields(resolveEncounterRule(race, 'elite')), { start: 'both', parameter: 8 })
  assert.deepEqual(fields(resolveEncounterRule(race, 'boss')), { start: 'either', parameter: 10 })
  assert.throws(() => resolveEncounterRule(race, 'minion'), RangeError)
  assert.throws(() => getCampaignEncounterRule('race-to-eight-v1'), RangeError)
})

test('each fight node draws its rule from its own seeded stream', () => {
  const fightNodes = CAMPAIGN_MAP.nodes
    .filter(({ kind }) => kind === 'fight')
    .map(({ id }) => id)
  assert.deepEqual(assignCampaignEncounterRules(0), [
    { nodeId: 'gate', ruleId: DOUBLE },
    { nodeId: 'court', ruleId: RACE },
    { nodeId: 'high-court', ruleId: ATTRITION },
    { nodeId: 'watch', ruleId: ATTRITION },
    { nodeId: 'night-watch', ruleId: DOUBLE },
    { nodeId: 'finale', ruleId: ATTRITION },
  ])
  const seen = new Map(fightNodes.map((nodeId) => [nodeId, new Set()]))
  for (let seed = 0; seed < 100; seed += 1) {
    const assignment = assignCampaignEncounterRules(seed)
    assert.ok(Object.isFrozen(assignment) && assignment.every(Object.isFrozen))
    assert.deepEqual(assignCampaignEncounterRules(seed), assignment)
    assert.deepEqual(assignment.map(({ nodeId }) => nodeId), fightNodes)
    for (const { nodeId, ruleId } of assignment) seen.get(nodeId).add(ruleId)
  }
  // Uniform draws without an anti-repeat rule: every fight sees every rule.
  for (const rules of seen.values()) assert.equal(rules.size, CAMPAIGN_ENCOUNTER_RULES.length)
})

test('a rule starts once either or both supplies turn personal', () => {
  for (const [id, either, both] of [
    [RACE, false, true],
    [DOUBLE, true, true],
    [ATTRITION, false, true],
  ]) {
    assert.equal(isEncounterRuleActive(encounter(id)), false, id)
    assert.equal(isEncounterRuleActive(encounter(id, { opponent: 'personal' })), either, id)
    assert.equal(isEncounterRuleActive(encounter(id, { player: 'personal' })), either, id)
    assert.equal(
      isEncounterRuleActive(encounter(id, { player: 'personal', opponent: 'personal' })),
      both,
      id,
    )
  }
})

test('the next stake doubles with each active clash and is zero until it starts', () => {
  assert.equal(getEncounterStake(encounter(DOUBLE)), 0)
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5].map((activeClashes) => getEncounterStake(
      encounter(DOUBLE, { opponent: 'personal', activeClashes }),
    )),
    [0, 1, 3, 7, 15, 31],
  )
  for (const id of [RACE, ATTRITION]) {
    assert.equal(getEncounterStake(encounter(id, {
      player: 'personal',
      opponent: 'personal',
      activeClashes: 3,
    })), 0)
  }
})

test('the rule display state gives each rule its own counts', () => {
  const race = describeEncounterRule(encounter(RACE, {
    player: 'personal',
    opponent: 'personal',
    activeClashes: 8,
    wins: { player: 3, opponent: 5 },
  }))
  assert.ok(Object.isFrozen(race) && Object.isFrozen(race.wins))
  assert.deepEqual(race, {
    id: RACE,
    name: 'Race to 10',
    effect: 'race',
    start: 'both',
    active: true,
    activeClashes: 8,
    wins: { player: 3, opponent: 5 },
    target: 10,
    stake: null,
    attritionCards: null,
  })
  const stakes = describeEncounterRule(encounter(DOUBLE, { opponent: 'personal', activeClashes: 2 }))
  assert.deepEqual(
    [stakes.name, stakes.active, stakes.target, stakes.stake, stakes.attritionCards],
    ['Double or nothing', true, null, 3, null],
  )
  const attrition = describeEncounterRule(encounter(ATTRITION, { opponent: 'personal' }))
  assert.deepEqual(
    [attrition.name, attrition.active, attrition.target, attrition.stake, attrition.attritionCards],
    ['Attrition', false, null, null, 3],
  )
})

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
import { CAMPAIGN_MAP, uncoveredCampaignRanks } from '../../src/domain/campaign-map.js'
import {
  chooseCampaignReveal,
  createCampaignStateFingerprint,
  prepareCampaignReveal,
  validateCampaignState,
} from '../../src/domain/campaign-machine.js'
import { restoreRng, shuffle } from '../../src/domain/rng.js'
import { BASELINE_RULESET, NO_BURN_RULESET } from '../../src/domain/ruleset.js'
import {
  attritionFixtureRun,
  claimReward,
  holdCard,
  mutableReady,
  passThrough,
  raceFixtureRun,
  refingerprint,
  resolvePrepared,
  retryEncounter,
  routeFixtureRun,
  stakesFixtureRun,
  startCampaign,
  winEncounter,
  fingerprint,
} from '../fixtures/campaign-route.js'

const RACE = 'race-to-ten-v1'
const DOUBLE = 'double-or-nothing-v1'
const ATTRITION = 'attrition-v1'

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

// A bare encounter for the rule helpers. `piles` sizes each side's [source, draw, won]
// piles with placeholder cards; only their lengths count.
function encounter(id, {
  tier = 'normal',
  player = 'source',
  opponent = 'source',
  activeClashes = 0,
  wins,
  piles = {},
} = {}) {
  const cards = (count, name) => Array.from({ length: count }, (_, index) => `${name}-${index}`)
  const zones = {}
  for (const side of ['player', 'opponent']) {
    const [source, draw, won] = piles[side] ?? [0, 40, 0]
    zones[`${side}SourcePile`] = cards(source, `${side}-source`)
    zones[side] = { drawPile: cards(draw, `${side}-draw`), wonPile: cards(won, `${side}-won`) }
  }
  return {
    tier,
    supplyMode: { player, opponent },
    rule: { id, activeClashes, wins: wins ?? { player: 0, opponent: 0 } },
    zones,
  }
}

// Seed 8 races at the gate, seed 0 plays Double or nothing, and seed 5 Attrition.
function gate(seed, ruleset = BASELINE_RULESET) {
  return startCampaign({ runId: `encounter-rules-${seed}`, seed, ruleset })
}

// Wins the gate, claims `offerId`, and enters the Royal Court through the shrine.
function court(seed, offerId = 'mend') {
  return passThrough(claimReward(winEncounter(gate(seed)), offerId), 'shrine', 'court')
}

// Mends after the gate and Royal Court, then enters the Night Watch through the vault.
function nightWatch(seed) {
  return passThrough(claimReward(winEncounter(court(seed)), 'mend'), 'vault', 'night-watch')
}

function instanceOf(run, side, cardId) {
  return run.cards.find((card) => (
    card.campaignOwner === side && card.cardId === `c-${cardId}`
  )).instanceId
}

// Rearranges a ready fight. Each side's piles list short card IDs ('KD' is c-KD); a side
// with a `source` list supplies from source and any other side is personal. Every other
// card except Hold is parked in the burn pile, and the rule state is set directly.
function arrange(input, { player = {}, opponent = {}, activeClashes = 0, wins } = {}) {
  const run = mutableReady(input)
  const free = run.cards.filter(({ instanceId }) => instanceId !== run.hold)
  const take = (side) => (cardId) => {
    const index = free.findIndex((card) => (
      card.campaignOwner === side && card.cardId === `c-${cardId}`
    ))
    assert.ok(index >= 0, `the ${side} has a free ${cardId}`)
    return free.splice(index, 1)[0].instanceId
  }
  const zones = {}
  for (const [side, piles] of [['player', player], ['opponent', opponent]]) {
    zones[`${side}SourcePile`] = (piles.source ?? []).map(take(side))
    zones[side] = {
      drawPile: (piles.draw ?? []).map(take(side)),
      wonPile: (piles.won ?? []).map(take(side)),
    }
    run.encounter.supplyMode[side] = piles.source === undefined ? 'personal' : 'source'
  }
  run.encounter.zones = {
    ...zones,
    contestedPile: [],
    burnPile: free.map(({ instanceId }) => instanceId),
    inPlay: [],
  }
  run.encounter.rule.activeClashes = activeClashes
  run.encounter.rule.wins = wins ?? { player: 0, opponent: 0 }
  run.turn = Math.max(run.turn, activeClashes)
  return fingerprint(run)
}

function play(run, choice = 'normal') {
  return resolvePrepared(run, choice)
}

// Short card IDs of event records, contest records, or instance IDs.
function cardsOf(run, entries) {
  const cards = new Map(run.cards.map(({ instanceId, cardId }) => [instanceId, cardId.slice(2)]))
  return entries.map((entry) => cards.get(typeof entry === 'string' ? entry : entry.instanceId))
}

function origins(records) {
  return records.map(({ cardId, from }) => [cardId.slice(2), from])
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
  // Double or nothing waits for both supplies at elites and the boss.
  for (const [id, tier, either, both] of [
    [RACE, 'normal', false, true],
    [DOUBLE, 'normal', true, true],
    [DOUBLE, 'elite', false, true],
    [DOUBLE, 'boss', false, true],
    [ATTRITION, 'normal', false, true],
  ]) {
    const where = `${id} at ${tier}`
    assert.equal(isEncounterRuleActive(encounter(id, { tier })), false, where)
    assert.equal(isEncounterRuleActive(encounter(id, { tier, opponent: 'personal' })), either, where)
    assert.equal(isEncounterRuleActive(encounter(id, { tier, player: 'personal' })), either, where)
    assert.equal(
      isEncounterRuleActive(encounter(id, { tier, player: 'personal', opponent: 'personal' })),
      both,
      where,
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
  assert.equal(getEncounterStake(encounter(DOUBLE, {
    tier: 'elite',
    opponent: 'personal',
    activeClashes: 3,
  })), 0)
  for (const id of [RACE, ATTRITION]) {
    assert.equal(getEncounterStake(encounter(id, {
      player: 'personal',
      opponent: 'personal',
      activeClashes: 3,
    })), 0)
  }
})

test('both sides stake the schedule, or what the shorter side can still supply', () => {
  const active = { player: 'personal', opponent: 'personal', activeClashes: 3 }
  // Source, draw and won piles all supply; the schedule asks for 7 cards a side.
  const playerShort = encounter(DOUBLE, { ...active, piles: { player: [1, 2, 3] } })
  assert.equal(getEncounterStake(playerShort), 6)
  assert.equal(getEncounterStake(playerShort, { player: 1, opponent: 1 }), 5)
  // A Hold reveal leaves the player's candidate in its pile.
  assert.equal(getEncounterStake(playerShort, { player: 0, opponent: 1 }), 6)
  assert.equal(describeEncounterRule(playerShort).stake, 5)

  const opponentShort = encounter(DOUBLE, { ...active, piles: { opponent: [0, 1, 2] } })
  assert.equal(getEncounterStake(opponentShort), 3)
  assert.equal(describeEncounterRule(opponentShort).stake, 2)

  // A side with nothing left to reveal never makes the stake negative.
  const spent = encounter(DOUBLE, { ...active, piles: { player: [0, 0, 0] } })
  assert.equal(getEncounterStake(spent, { player: 1, opponent: 1 }), 0)
  assert.equal(describeEncounterRule(spent).stake, 0)

  // The activating clash stakes nothing, however much both sides hold.
  assert.equal(describeEncounterRule(encounter(DOUBLE, { ...active, activeClashes: 0 })).stake, 0)
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
    ['Attrition', false, null, null, 2],
  )
})

test('a race ends the fight at its target for either side, and a retry resets it', () => {
  const nearTarget = { activeClashes: 18, wins: { player: 9, opponent: 9 } }
  const won = play(arrange(gate(8), {
    player: { draw: ['KD', '9D'] },
    opponent: { draw: ['5S', '6S', '7S'] },
    ...nearTarget,
  }))
  assert.deepEqual(won.match.encounter.outcome, {
    result: 'win',
    winner: 'player',
    reason: 'raceTargetReached',
  })
  assert.equal(won.match.machineState, 'awaitingReward')
  assert.deepEqual(won.match.encounter.rule, {
    id: RACE,
    activeClashes: 19,
    wins: { player: 10, opponent: 9 },
  })
  // The target ends the fight while the loser still has cards.
  assert.deepEqual(cardsOf(won.match, won.match.encounter.zones.opponent.drawPile), ['6S', '7S'])

  const lost = play(arrange(gate(8), {
    player: { draw: ['5D', '6D'] },
    opponent: { draw: ['KS'] },
    ...nearTarget,
  }))
  assert.deepEqual(lost.match.encounter.outcome, {
    result: 'win',
    winner: 'opponent',
    reason: 'raceTargetReached',
  })
  assert.equal(lost.match.machineState, 'awaitingRetry')
  const retried = retryEncounter(lost.match)
  assert.equal(retried.encounterAttempt, 2)
  assert.deepEqual(retried.encounter.rule, {
    id: RACE,
    activeClashes: 0,
    wins: { player: 0, opponent: 0 },
  })
  assert.deepEqual(retried.encounter.supplyMode, { player: 'source', opponent: 'source' })
})

test('a tie across the last source cards starts a race on the clash it settles', () => {
  const lastSourceCards = {
    player: { source: ['7D'], won: ['KD'] },
    opponent: { source: ['7S'], won: ['5S'] },
  }
  const raced = play(arrange(gate(8), lastSourceCards))
  assert.deepEqual(origins(raced.event.reveals), [
    ['7D', 'player.sourcePile'],
    ['7S', 'opponent.sourcePile'],
    ['KD', 'player.drawPile'],
    ['5S', 'opponent.drawPile'],
  ])
  assert.deepEqual(raced.match.encounter.supplyMode, { player: 'personal', opponent: 'personal' })
  assert.deepEqual(raced.match.encounter.rule, {
    id: RACE,
    activeClashes: 1,
    wins: { player: 1, opponent: 0 },
  })

  // Double or nothing sets its stake after the first-round reveals, while both sides
  // still supply from source, and then counts the clash.
  const staked = play(arrange(gate(0), lastSourceCards))
  assert.deepEqual(staked.event.stakes, [])
  assert.equal(staked.match.encounter.rule.activeClashes, 1)

  // A race waits for both supplies to turn personal.
  const waiting = play(arrange(gate(8), {
    player: { draw: ['KD', '9D'] },
    opponent: { source: ['5S', '6S'] },
  }))
  assert.equal(waiting.event.winner, 'player')
  assert.equal(waiting.match.encounter.rule.activeClashes, 0)
})

test('both sides stake the schedule player first, or what the shorter side can match', () => {
  const { event, match } = play(arrange(gate(0), {
    player: { draw: ['KD', '2D', '3D', '4D', '9D'] },
    opponent: { draw: ['5S', '2S', '3S', '4S', '9S'] },
    activeClashes: 2,
  }))
  assert.deepEqual(origins(event.stakes), [
    ['2D', 'player.drawPile'],
    ['3D', 'player.drawPile'],
    ['4D', 'player.drawPile'],
    ['2S', 'opponent.drawPile'],
    ['3S', 'opponent.drawPile'],
    ['4S', 'opponent.drawPile'],
  ])
  assert.deepEqual(cardsOf(match, event.transfers), ['KD', '2D', '3D', '4D'])
  assert.deepEqual(cardsOf(match, event.burned), ['5S', '2S', '3S', '4S'])
  assert.deepEqual(cardsOf(match, match.encounter.zones.burnPile.slice(-4)), event.burned.map(
    (instanceId) => cardsOf(match, [instanceId])[0],
  ))
  assert.equal(match.encounter.rule.activeClashes, 3)
  // The schedule now asks for 7, but the opponent has only 9S left, which its next reveal
  // takes.
  assert.equal(getEncounterStake(match.encounter), 1)
  assert.equal(describeEncounterRule(match.encounter).stake, 0)

  // After its reveal the player can match only 2 of the 7 the schedule asks for.
  const matched = play(arrange(gate(0), {
    player: { draw: ['5D', '2D', '3D'] },
    opponent: { draw: ['KS', '2S', '3S', '4S', '9S'] },
    activeClashes: 3,
  }))
  assert.deepEqual(cardsOf(matched.match, matched.event.stakes), ['2D', '3D', '2S', '3S'])
  assert.doesNotThrow(() => validateCampaignState(matched.match))
  assert.equal(matched.match.machineState, 'ready')
  const ended = play(matched.match)
  assert.equal(ended.match.encounter.outcome.reason, 'playerUnableToReveal')
  assert.deepEqual(cardsOf(ended.match, ended.event.reveals), ['4S'])
})

test('an all-in tie ends in inability, or in a draw that keeps the stakes on the table', () => {
  // The schedule asks for 3 a side; the player can match only 1, so it is all-in.
  const unable = play(arrange(gate(0), {
    player: { draw: ['7D', '2D'] },
    opponent: { draw: ['7S', '2S', '9S'] },
    activeClashes: 2,
  }))
  assert.deepEqual(cardsOf(unable.match, unable.event.reveals), ['7D', '7S', '9S'])
  assert.deepEqual(cardsOf(unable.match, unable.event.stakes), ['2D', '2S'])
  assert.deepEqual(cardsOf(unable.match, unable.event.transfers), ['7S', '2S', '9S'])
  assert.deepEqual(cardsOf(unable.match, unable.event.burned), ['7D', '2D'])
  assert.equal(unable.match.encounter.outcome.reason, 'playerUnableToReveal')
  // Inability does not advance the rule.
  assert.equal(unable.match.encounter.rule.activeClashes, 2)

  // Both sides are all-in at 2 cards, so their tie draws the fight.
  const drawn = play(arrange(gate(0), {
    player: { draw: ['7D', '2D', '3D'] },
    opponent: { draw: ['7S', '2S', '3S'] },
    activeClashes: 2,
  }))
  assert.equal(drawn.event.type, 'clashDrawn')
  assert.deepEqual(cardsOf(drawn.match, drawn.event.reveals), ['7D', '7S'])
  assert.deepEqual(cardsOf(drawn.match, drawn.event.stakes), ['2D', '3D', '2S', '3S'])
  assert.deepEqual(
    cardsOf(drawn.match, drawn.match.encounter.zones.contestedPile),
    ['7D', '7S', '2D', '3D', '2S', '3S'],
  )
  assert.equal(drawn.match.machineState, 'awaitingRetry')
  assert.equal(drawn.match.encounter.rule.activeClashes, 2)
})

test('stakes and tie reveals recycle won piles with the run RNG in supply order', () => {
  const ready = arrange(gate(0), {
    player: { draw: ['7D'], won: ['2D', '3D', '4D', '5D', '6D'] },
    opponent: { draw: ['7S'], won: ['8S', '9S', '10S', 'JS', 'QS'] },
    activeClashes: 2,
  })
  const rng = restoreRng(ready.rng)
  const player = shuffle(ready.encounter.zones.player.wonPile, rng)
  const opponent = shuffle(ready.encounter.zones.opponent.wonPile, rng)
  const { event, match } = play(ready)
  assert.deepEqual(
    event.stakes.map(({ instanceId }) => instanceId),
    [...player.slice(0, 3), ...opponent.slice(0, 3)],
  )
  assert.deepEqual(
    event.reveals.slice(2).map(({ instanceId }) => instanceId),
    [player[3], opponent[3]],
  )
  assert.equal(event.winner, 'opponent')
  assert.deepEqual(match.rng, rng.snapshot())
  assert.deepEqual(match.encounter.zones.player.drawPile, player.slice(4))
  assert.deepEqual(match.encounter.zones.opponent.drawPile, opponent.slice(4))
})

test('Plunder and Spoils of War claim stakes that would burn', () => {
  const plundered = play(arrange(nightWatch(0), {
    player: { draw: ['5D', '2D', '3D'] },
    opponent: { draw: ['9S', '8S', '10S'] },
    activeClashes: 1,
  }))
  assert.equal(plundered.match.encounter.rule.id, DOUBLE)
  assert.deepEqual(plundered.match.encounter.traitIds, ['plunder-v1'])
  assert.deepEqual(cardsOf(plundered.match, plundered.event.transfers), ['5D', '9S', '2D', '8S'])
  assert.deepEqual(plundered.event.burned, [])

  const spoils = play(arrange(court(25, 'modifier'), {
    player: { draw: ['AD', '2D', '3D'] },
    opponent: { draw: ['JS', 'QS', 'KS'] },
    activeClashes: 1,
  }))
  assert.equal(spoils.match.encounter.rule.id, DOUBLE)
  assert.ok(spoils.match.activeModifiers.some(({ id }) => id === 'spoils-of-war-v1'))
  assert.deepEqual(cardsOf(spoils.match, spoils.event.transfers), ['AD', 'JS', '2D', 'QS'])
  assert.deepEqual(spoils.event.burned, [])
})

test('Hold previews and Hold Insight peeks stay exact when stakes follow', () => {
  const insight = passThrough(routeFixtureRun('encounter-rules-insight'), 'shrine', 'court')
  const held = holdCard(insight, instanceOf(insight, 'player', 'AH'))
  // With 5 cards the player meets the schedule's 3 either way. With 2, a normal reveal
  // leaves it 1 to stake, while a Hold reveal leaves its candidate in the pile to stake too.
  for (const [won, counts] of [
    [['9D', '3D', '4D', '5D', '6D'], { normal: 3, hold: 3 }],
    [['9D', '3D'], { normal: 1, hold: 2 }],
  ]) {
    const ready = arrange(held, {
      player: { won },
      opponent: { won: ['JS', 'QS', 'KS', 'JC', 'QC'] },
      activeClashes: 2,
    })
    assert.equal(ready.encounter.rule.id, DOUBLE)
    assert.equal(describeEncounterRule(ready.encounter).stake, counts.normal)
    for (const choice of ['normal', 'hold']) {
      const where = `${won.length} cards, ${choice}`
      const prepared = prepareCampaignReveal(ready).match
      assert.equal(prepared.machineState, 'awaitingInformedHoldChoice')
      const { candidate, opponentCandidate } = prepared.holdChoice
      // Each choice's stake is known before it is made.
      const reveals = { player: choice === 'hold' ? 0 : 1, opponent: 1 }
      assert.equal(getEncounterStake(prepared.encounter, reveals), counts[choice], where)
      const { event } = chooseCampaignReveal(prepared, choice)
      assert.deepEqual(
        event.reveals.slice(0, 2).map(({ instanceId }) => instanceId),
        [choice === 'hold' ? held.hold : candidate, opponentCandidate],
        where,
      )
      assert.equal(event.stakes.length, 2 * counts[choice], where)
      assert.ok(event.stakes.every(({ from }) => from !== 'player.hold'), where)
      // A Hold reveal leaves the previewed card on top, so it becomes the first stake.
      if (choice === 'hold') assert.equal(event.stakes[0].instanceId, candidate)
    }
  }
})

test('attrition burns the loser\'s next cards under both burn settings', () => {
  for (const ruleset of [BASELINE_RULESET, NO_BURN_RULESET]) {
    const { event, match } = play(arrange(gate(5, ruleset), {
      player: { draw: ['KD', '9D'] },
      opponent: { draw: ['5S', '2S', '3S', '4S', '9S'] },
    }))
    const burns = ruleset.burn.enabled
    assert.equal(match.encounter.rule.id, ATTRITION)
    assert.deepEqual(origins(event.attrition), [
      ['2S', 'opponent.drawPile'],
      ['3S', 'opponent.drawPile'],
    ], ruleset.id)
    assert.deepEqual(cardsOf(match, event.transfers), burns ? ['KD'] : ['KD', '5S'], ruleset.id)
    assert.deepEqual(cardsOf(match, event.burned), burns ? ['5S'] : [], ruleset.id)
    const removed = [...event.burned, ...event.attrition.map(({ instanceId }) => instanceId)]
    assert.deepEqual(match.encounter.zones.burnPile.slice(-removed.length), removed, ruleset.id)
    assert.deepEqual(cardsOf(match, match.encounter.zones.opponent.drawPile), ['4S', '9S'], ruleset.id)
  }
})

test('attrition recycles, stops when the loser runs out, and never touches Hold', () => {
  const ready = arrange(gate(5), {
    player: { draw: ['KD', '9D'] },
    opponent: { draw: ['5S', '2S'], won: ['3S', '4S', '9S'] },
  })
  const rng = restoreRng(ready.rng)
  const recycled = shuffle(ready.encounter.zones.opponent.wonPile, rng)
  const { event, match } = play(ready)
  assert.deepEqual(
    event.attrition.map(({ instanceId }) => instanceId),
    [instanceOf(ready, 'opponent', '2S'), recycled[0]],
  )
  assert.deepEqual(match.rng, rng.snapshot())

  const short = play(arrange(gate(5), {
    player: { draw: ['KD', '9D'] },
    opponent: { draw: ['5S', '2S'] },
  }))
  assert.deepEqual(cardsOf(short.match, short.event.attrition), ['2S'])
  assert.equal(short.match.machineState, 'ready')
  assert.equal(play(short.match).match.encounter.outcome.reason, 'opponentUnableToReveal')

  const fresh = gate(5)
  const held = holdCard(fresh, instanceOf(fresh, 'player', 'AD'))
  const guarded = play(arrange(held, {
    player: { draw: ['5D', '2D'] },
    opponent: { draw: ['KS', '9S'] },
  }))
  assert.deepEqual(cardsOf(guarded.match, guarded.event.attrition), ['2D'])
  assert.equal(guarded.match.hold, held.hold)
  assert.equal(guarded.match.machineState, 'ready')
})

test('Plunder cannot claim attrition burns', () => {
  const { event, match } = play(arrange(nightWatch(5), {
    player: { draw: ['5D', '2D', '3D', '4D', '9D'] },
    opponent: { draw: ['9S', '10S'] },
  }))
  assert.equal(match.encounter.rule.id, ATTRITION)
  assert.deepEqual(match.encounter.traitIds, ['plunder-v1'])
  assert.deepEqual(cardsOf(match, event.transfers), ['5D', '9S'])
  assert.deepEqual(event.burned, [])
  assert.deepEqual(cardsOf(match, event.attrition), ['2D', '3D'])
  assert.deepEqual(
    match.encounter.zones.burnPile.slice(-2),
    event.attrition.map(({ instanceId }) => instanceId),
  )
})

test('a retry returns burned stakes and attrition cards, protected ranks included', () => {
  for (const [input, layout] of [
    [court(3), {
      player: { draw: ['5D', 'AD', 'AH'] },
      opponent: { draw: ['JS', 'QS', 'KS', 'JC', 'QC'] },
      activeClashes: 2,
    }],
    [court(1), {
      player: { draw: ['5D', 'AD', 'AH'] },
      opponent: { draw: ['JS', 'QS'] },
    }],
  ]) {
    const ruleId = input.encounter.rule.id
    // No Royal Court card ties or beats an Ace, so a revealed Ace never burns there.
    assert.deepEqual(uncoveredCampaignRanks(input.cards
      .filter(({ campaignOwner }) => campaignOwner === 'opponent')
      .map(({ cardId }) => cardId)), ['A'], ruleId)
    const { match } = play(arrange(input, layout))
    assert.deepEqual(cardsOf(match, match.encounter.zones.burnPile.slice(-3)), ['5D', 'AD', 'AH'])
    const lost = play(match).match
    assert.equal(lost.machineState, 'awaitingRetry', ruleId)
    const retried = retryEncounter(lost)
    assert.deepEqual(
      [...retried.encounter.zones.playerSourcePile].sort(),
      [...retried.deckLayout].sort(),
      ruleId,
    )
    assert.deepEqual(retried.encounter.zones.burnPile, [], ruleId)
    assert.deepEqual(retried.encounter.rule, {
      id: ruleId,
      activeClashes: 0,
      wins: { player: 0, opponent: 0 },
    })
  }
})

test('validation rejects tampered rule assignments and rule state', () => {
  const tampered = (input, edit) => {
    const run = clone(input)
    edit(run)
    return refingerprint(run)
  }
  const nearTarget = arrange(gate(8), {
    player: { draw: ['KD'] },
    opponent: { draw: ['5S'] },
    activeClashes: 18,
    wins: { player: 9, opponent: 9 },
  })
  const cases = [
    [gate(0), (run) => { run.encounterRules[1].ruleId = DOUBLE },
      /campaign\.encounterRules\[1\]\.ruleId must match the rules its seed assigns/],
    [gate(0), (run) => { run.encounterRules.pop() },
      /campaign\.encounterRules must match the rules its seed assigns/],
    [gate(0), (run) => { run.encounter.rule.id = RACE },
      /rule\.id must match the rule assigned to its fight/],
    [gate(0), (run) => { run.encounter.rule.target = 10 },
      /campaign\.encounter\.rule must contain only id, activeClashes, wins/],
    [gate(0), (run) => { run.encounter.rule.activeClashes = 1 },
      /cannot count more clashes than were played/],
    [gate(0), (run) => {
      run.turn = 1
      run.encounter.rule.activeClashes = 1
    }, /counts clashes only once it is active/],
    [raceFixtureRun(), (run) => { run.encounter.rule.wins.player += 1 },
      /Only a race counts clash wins, one for each active clash/],
    [stakesFixtureRun(), (run) => { run.encounter.rule.wins.player = 1 },
      /Only a race counts clash wins, one for each active clash/],
    [nearTarget, (run) => {
      run.turn = 19
      run.encounter.rule.activeClashes = 19
      run.encounter.rule.wins.player = 10
    }, /Only the winner of a finished race can reach the race target/],
  ]
  for (const [input, edit, expected] of cases) {
    assert.throws(() => validateCampaignState(tampered(input, edit)), expected)
  }
})

test('pending events bind stakes and attrition to the state they describe', () => {
  const first = play(gate(8))
  assert.deepEqual([first.event.stakes, first.event.attrition], [[], []])
  for (const run of [first.match, stakesFixtureRun(), attritionFixtureRun()]) {
    assert.equal(run.pendingEvent.stateFingerprint, createCampaignStateFingerprint(run))
    for (const key of ['stakes', 'attrition']) {
      const dropped = clone(run)
      delete dropped.pendingEvent[key]
      assert.notEqual(createCampaignStateFingerprint(dropped), run.stateFingerprint, key)
    }
  }

  const tampered = (input, edit) => {
    const run = clone(input)
    edit(run)
    return refingerprint(run)
  }
  const stakes = stakesFixtureRun()
  assert.ok(stakes.pendingEvent.stakes.length > 0)
  // One active clash fewer puts the stakes over the schedule; one more leaves them short
  // of it while neither side has run out.
  assert.throws(() => validateCampaignState(tampered(stakes, (run) => {
    run.encounter.rule.activeClashes -= 1
  })), /Both sides must stake the same count, at most the Double or nothing schedule/)
  assert.throws(() => validateCampaignState(tampered(stakes, (run) => {
    run.encounter.rule.activeClashes += 1
  })), /Stakes may fall short of the Double or nothing schedule only when a side runs out/)

  // Returning one side's last stake to its draw pile leaves the counts unequal; returning
  // both sides' leaves them short of the schedule while both still have cards.
  const staked = play(arrange(gate(0), {
    player: { draw: ['KD', '2D', '3D', '4D', '9D'] },
    opponent: { draw: ['5S', '2S', '3S', '4S', '9S'] },
    activeClashes: 2,
  })).match
  const unstake = (run, side) => {
    const event = run.pendingEvent
    const { instanceId } = event.stakes.findLast(({ suppliedBy }) => suppliedBy === side)
    const zones = run.encounter.zones
    event.stakes = event.stakes.filter((record) => record.instanceId !== instanceId)
    event.transfers = event.transfers.filter((record) => record.instanceId !== instanceId)
    event.burned = event.burned.filter((burned) => burned !== instanceId)
    zones.player.wonPile = zones.player.wonPile.filter((entry) => entry !== instanceId)
    zones.burnPile = zones.burnPile.filter((entry) => entry !== instanceId)
    zones[side].drawPile.unshift(instanceId)
  }
  for (const side of ['player', 'opponent']) {
    assert.throws(
      () => validateCampaignState(tampered(staked, (run) => unstake(run, side))),
      /Both sides must stake the same count, at most the Double or nothing schedule/,
      side,
    )
  }
  assert.throws(() => validateCampaignState(tampered(staked, (run) => {
    unstake(run, 'player')
    unstake(run, 'opponent')
  })), /Stakes may fall short of the Double or nothing schedule only when a side runs out/)

  const attrition = attritionFixtureRun()
  assert.equal(attrition.pendingEvent.attrition.length, 2)
  assert.throws(() => validateCampaignState(tampered(attrition, (run) => {
    const { instanceId } = run.pendingEvent.attrition.pop()
    const loser = run.pendingEvent.winner === 'player' ? 'opponent' : 'player'
    assert.equal(run.encounter.zones.burnPile.pop(), instanceId)
    run.encounter.zones[loser].drawPile.unshift(instanceId)
  })), /Attrition must burn its full count unless the loser runs out/)
  assert.throws(() => validateCampaignState(tampered(attrition, (run) => {
    const burnPile = run.encounter.zones.burnPile
    burnPile.push(...burnPile.splice(-2).reverse())
  })), /Campaign event burns must be the burn-pile suffix/)

  // A race won by inability cannot be relabelled as reaching the target.
  const inability = play(arrange(gate(8), {
    player: { draw: ['KD'] },
    opponent: {},
    activeClashes: 18,
    wins: { player: 9, opponent: 9 },
  })).match
  assert.equal(inability.encounter.outcome.reason, 'opponentUnableToReveal')
  assert.deepEqual(inability.encounter.rule.wins, { player: 9, opponent: 9 })
  assert.throws(() => validateCampaignState(tampered(inability, (run) => {
    run.encounter.outcome.reason = 'raceTargetReached'
    run.encounter.rule.activeClashes = 19
    run.encounter.rule.wins.player = 10
  })), /A race win requires a matching settled event with complete reveal rounds/)
})

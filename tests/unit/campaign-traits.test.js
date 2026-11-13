import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CAMPAIGN_FIGHTS,
  CAMPAIGN_NODE_EVENTS,
  getCampaignFight,
} from '../../src/domain/campaign-content.js'
import { replayCampaignJournal } from '../../src/domain/campaign-journal.js'
import {
  CAMPAIGN_HOLD_DECISION_STATES,
  HOLD_POSITION,
  captureCampaignHold,
  chooseCampaignReveal,
  getEligibleHoldTargets,
  prepareCampaignReveal,
  validateCampaignState,
} from '../../src/domain/campaign-machine.js'
import { validateCampaignEvents, validateCampaignFights } from '../../src/domain/campaign-map.js'
import {
  CAMPAIGN_MODIFIER_CATALOGUE,
  VITALITY_CAP_MODIFIER_ID,
  contestCardBurns,
  createModifierRecord,
  createStartingModifierRecords,
  encounterTraitIds,
  getAvailableModifierPool,
  getDraftableModifierPool,
  isOpponentTraitId,
  modifierGainBlocker,
  narrowHoldTargets,
  validateModifierCatalogue,
} from '../../src/domain/campaign-modifiers.js'
import { modifierAvailability } from '../../src/domain/campaign-shop.js'
import { compareCards, getCard } from '../../src/domain/cards.js'
import { restoreRng, shuffle } from '../../src/domain/rng.js'
import { BASELINE_RULESET, NO_BURN_RULESET } from '../../src/domain/ruleset.js'
import {
  bossFixtureRun,
  chooseRoute,
  claimReward,
  clone,
  fingerprint,
  holdCard,
  loseEncounter,
  mutableReady,
  passThrough,
  refingerprint,
  retryEncounter,
  startCampaign,
  winEncounter,
} from '../fixtures/campaign-route.js'

const COURT_ETIQUETTE = 'court-etiquette-v1'
const PLUNDER = 'plunder-v1'
const NUMBER_RANKS = Object.freeze(['2', '3', '4', '5', '6', '7', '8', '9', '10'])
// The multiplicative inverse of the Mulberry32 increment 0x6D2B79F5 modulo 2^32, so the
// state difference between two snapshots counts the draws between them.
const MULBERRY32_INVERSE = 0xDC58AA5D

function gate(seed, ruleset = BASELINE_RULESET) {
  return startCampaign({ runId: `campaign-traits-${seed}`, seed, ruleset })
}

// Wins the gate, claims `offerId`, and enters the High Court through the shrine.
function highCourt(seed, offerId = 'mend', input = gate(seed)) {
  return passThrough(claimReward(winEncounter(input), offerId), 'shrine', 'high-court')
}

// Mends after the gate and Royal Court, then enters the Night Watch through the vault.
function nightWatch(seed, ruleset = BASELINE_RULESET) {
  const court = passThrough(claimReward(winEncounter(gate(seed, ruleset)), 'mend'), 'shrine', 'court')
  return passThrough(claimReward(winEncounter(court), 'mend'), 'vault', 'night-watch')
}

function drawsBetween(before, after) {
  return Math.imul((after.rng.state - before.rng.state) >>> 0, MULBERRY32_INVERSE) >>> 0
}

function isNumberCard({ cardId }) {
  return NUMBER_RANKS.includes(getCard(cardId).rank)
}

function instanceIds(targets) {
  return targets.map(({ instanceId }) => instanceId)
}

// The player-owned cards in the piles Hold can capture from, in scan order.
function pileCards(run) {
  const cards = new Map(run.cards.map((card) => [card.instanceId, card]))
  return ['drawPile', 'wonPile'].flatMap((zone) => run.encounter.zones.player[zone]
    .filter((instanceId) => cards.get(instanceId).campaignOwner === 'player')
    .map((instanceId) => ({ instanceId, cardId: cards.get(instanceId).cardId, zone: `player.${zone}` })))
}

// Splits the non-held player cards between the player's draw and won piles, so every one
// of them is a Hold candidate, and leaves the opponent's deck in its source pile.
function arrangeHoldTargets(input) {
  const run = mutableReady(input)
  const players = run.deckLayout.filter((entry) => entry !== HOLD_POSITION)
  const half = Math.ceil(players.length / 2)
  run.encounter.zones = {
    playerSourcePile: [],
    opponentSourcePile: run.cards
      .filter(({ campaignOwner }) => campaignOwner === 'opponent')
      .map(({ instanceId }) => instanceId),
    player: { drawPile: players.slice(0, half), wonPile: players.slice(half) },
    opponent: { drawPile: [], wonPile: [] },
    contestedPile: [],
    burnPile: [],
    inPlay: [],
  }
  run.encounter.supplyMode = { player: 'personal', opponent: 'source' }
  return fingerprint(run)
}

// Plays one reveal, answering a Hold choice with a normal reveal unless only Hold can.
function clash(run) {
  const prepared = prepareCampaignReveal(run)
  if (!CAMPAIGN_HOLD_DECISION_STATES.includes(prepared.match.machineState)) return prepared
  const choice = prepared.match.holdChoice.candidate === null ? 'hold' : 'normal'
  return chooseCampaignReveal(prepared.match, choice)
}

function withModifier(modifierId) {
  return [
    ...createStartingModifierRecords(),
    ...(modifierId === null ? [] : [createModifierRecord(modifierId, 'gate')]),
  ]
}

test('opponent traits last one encounter, are never drafted, and touch only Hold and burns', () => {
  const traits = CAMPAIGN_MODIFIER_CATALOGUE.filter(({ owner }) => owner === 'opponent')
  assert.deepEqual(
    traits.map(({ id, description, ...entry }) => [id, entry]),
    [
      [COURT_ETIQUETTE, {
        name: 'Court Etiquette',
        owner: 'opponent',
        lifetime: 'encounter',
        hooks: ['holdCaptureEligibility', 'holdReplacementEligibility'],
        effect: { type: 'capture-ranks', ranks: NUMBER_RANKS },
        draftable: false,
        applicability: null,
        healthOnGain: 0,
      }],
      [PLUNDER, {
        name: 'Plunder',
        owner: 'opponent',
        lifetime: 'encounter',
        hooks: ['burnSettlement'],
        effect: { type: 'winner-claims-burns', winner: 'opponent' },
        draftable: false,
        applicability: { burnEnabled: true },
        healthOnGain: 0,
      }],
    ],
  )
  for (const { description } of traits) assert.match(description, /^Opponent trait\. /)
  assert.deepEqual(
    CAMPAIGN_MODIFIER_CATALOGUE.filter(({ id }) => isOpponentTraitId(id)),
    traits,
  )
  for (const id of ['spoils-of-war-v1', 'unknown-trait-v1', null, undefined]) {
    assert.equal(isOpponentTraitId(id), false)
  }
  for (const id of [COURT_ETIQUETTE, PLUNDER]) {
    assert.throws(
      () => createModifierRecord(id, 'high-court'),
      new RegExp(`Opponent trait ${id} cannot become an active modifier`),
    )
  }

  const valid = clone(CAMPAIGN_MODIFIER_CATALOGUE)
  const editing = (id, edit) => valid.map((entry) => (entry.id === id ? edit(clone(entry)) : entry))
  const cases = [
    [/Opponent trait court-etiquette-v1 must last one encounter, restore no health, and never be drafted/,
      editing(COURT_ETIQUETTE, (entry) => ({ ...entry, lifetime: 'campaign' }))],
    [/Opponent trait plunder-v1 must last one encounter/,
      editing(PLUNDER, (entry) => ({ ...entry, draftable: true }))],
    [/Opponent trait plunder-v1 must last one encounter/,
      editing(PLUNDER, (entry) => ({ ...entry, healthOnGain: 1 }))],
    [/Opponent trait court-etiquette-v1 may modify only Hold eligibility or burns/,
      editing(COURT_ETIQUETTE, (entry) => ({
        ...entry,
        hooks: ['holdDecision'],
        effect: { type: 'informed-hold-choice' },
      }))],
    [/Opponent trait plunder-v1 may modify only Hold eligibility or burns/,
      editing(PLUNDER, (entry) => ({
        ...entry,
        hooks: ['maximumHealth'],
        effect: { type: 'maximum-health', value: 5 },
      }))],
    [/Modifier vow-of-patience-v1 cannot apply replacement-not-weaker to holdCaptureEligibility/,
      editing('vow-of-patience-v1', (entry) => ({ ...entry, effect: { type: 'replacement-not-weaker' } }))],
    [/Modifier court-etiquette-v1 cannot apply replacement-not-weaker to holdCaptureEligibility/,
      editing(COURT_ETIQUETTE, (entry) => ({ ...entry, effect: { type: 'replacement-not-weaker' } }))],
    [/Modifier court-etiquette-v1 cannot apply winner-claims-burns to holdCaptureEligibility/,
      editing(COURT_ETIQUETTE, (entry) => ({
        ...entry,
        effect: { type: 'winner-claims-burns', winner: 'opponent' },
      }))],
    [/Modifier spoils-of-war-v1 cannot apply capture-ranks to burnSettlement/,
      editing('spoils-of-war-v1', (entry) => ({
        ...entry,
        effect: { type: 'capture-ranks', ranks: ['2'] },
      }))],
    [/Modifier hold-insight-v1 cannot apply maximum-health to holdDecision/,
      editing('hold-insight-v1', (entry) => ({
        ...entry,
        effect: { type: 'maximum-health', value: 5 },
      }))],
    [/Modifier vitality-cap-v1 cannot apply informed-hold-choice to maximumHealth/,
      editing(VITALITY_CAP_MODIFIER_ID, (entry) => ({
        ...entry,
        effect: { type: 'informed-hold-choice' },
      }))],
    [/Modifier plunder-v1 may only claim burns for its owner/,
      editing(PLUNDER, (entry) => ({ ...entry, effect: { ...entry.effect, winner: 'player' } }))],
    [/Modifier spoils-of-war-v1 may only claim burns for its owner/,
      editing('spoils-of-war-v1', (entry) => ({ ...entry, effect: { ...entry.effect, winner: 'opponent' } }))],
    [/Modifier hold-insight-v1 must be owned by the player or the opponent/,
      editing('hold-insight-v1', ({ owner, ...entry }) => entry)],
    [/Modifier plunder-v1 must be owned by the player or the opponent/,
      editing(PLUNDER, (entry) => ({ ...entry, owner: 'neutral' }))],
    [{ name: 'RangeError', message: /Modifier vow-of-the-court-v1 cannot restore more than 2 health/ },
      editing('vow-of-the-court-v1', (entry) => ({ ...entry, healthOnGain: 3 }))],
  ]
  for (const [expected, catalogue] of cases) {
    assert.throws(() => validateModifierCatalogue(catalogue), expected)
  }
  assert.equal(validateModifierCatalogue(valid), valid)
})

test('traits leave every reward, shop, and event modifier pool unchanged', () => {
  const playerCatalogue = CAMPAIGN_MODIFIER_CATALOGUE.filter(({ owner }) => owner === 'player')
  const draftable = playerCatalogue.filter((entry) => entry.draftable).map(({ id }) => id)
  assert.equal(draftable.length, 5)
  // The pool rules applied to the catalogue before opponent traits were added.
  const referencePool = (records, ruleset) => {
    const occupied = new Set(records.flatMap(({ id }) => (
      playerCatalogue.find((entry) => entry.id === id).hooks
    )))
    return playerCatalogue
      .filter((entry) => (
        entry.draftable
        && !records.some(({ id }) => id === entry.id)
        && !entry.hooks.some((hook) => occupied.has(hook))
        && (entry.applicability === null
          || entry.applicability.burnEnabled === ruleset.burn.enabled)
      ))
      .map(({ id }) => id)
  }
  for (let mask = 0; mask < 1 << draftable.length; mask += 1) {
    const records = [
      ...createStartingModifierRecords(),
      ...draftable
        .filter((id, bit) => (mask & (1 << bit)) !== 0)
        .map((id) => createModifierRecord(id, 'gate')),
    ]
    for (const ruleset of [BASELINE_RULESET, NO_BURN_RULESET]) {
      const label = `${records.map(({ id }) => id).join()} under ${ruleset.id}`
      assert.deepEqual(
        getAvailableModifierPool(records, ruleset),
        referencePool(records, ruleset),
        label,
      )
      assert.deepEqual(
        getDraftableModifierPool(records, ruleset),
        referencePool(records.filter(({ lifetime }) => lifetime !== 'encounter'), ruleset),
        label,
      )
      for (const id of [COURT_ETIQUETTE, PLUNDER]) {
        assert.equal(modifierGainBlocker(records, id, ruleset), 'not-draftable', label)
        assert.equal(modifierAvailability(records, id, ruleset), 'modifier-unavailable', label)
      }
    }
  }
})

test('traits exist exactly while their elite encounter does', () => {
  const opening = gate(0)
  assert.equal(opening.encounter.tier, 'normal')
  assert.deepEqual(opening.encounter.traitIds, [])
  const boss = bossFixtureRun()
  assert.equal(boss.encounter.tier, 'boss')
  assert.deepEqual(boss.encounter.traitIds, [])

  let run = highCourt(0)
  assert.equal(run.encounter.tier, 'elite')
  assert.deepEqual(run.encounter.traitIds, [COURT_ETIQUETTE])
  assert.deepEqual(run.activeModifiers, createStartingModifierRecords())
  run = loseEncounter(run)
  assert.equal(run.machineState, 'awaitingRetry')
  assert.deepEqual(run.encounter.traitIds, [COURT_ETIQUETTE])
  run = retryEncounter(validateCampaignState(clone(run)))
  assert.equal(run.encounterAttempt, 2)
  assert.deepEqual(run.encounter.traitIds, [COURT_ETIQUETTE])
  run = winEncounter(run)
  assert.equal(run.machineState, 'awaitingReward')
  assert.deepEqual(run.encounter.traitIds, [COURT_ETIQUETTE])
  run = claimReward(run, 'modifier')
  assert.equal(run.encounter, null)
  assert.ok(run.activeModifiers.every(({ id }) => !isOpponentTraitId(id)))
  assert.ok(run.journal.every(({ modifierId }) => !isOpponentTraitId(modifierId)))

  const watch = nightWatch(0)
  assert.equal(watch.encounter.tier, 'elite')
  assert.deepEqual(watch.encounter.traitIds, [PLUNDER])
  // Without burns Plunder has nothing to claim, so the Night Watch fields no trait.
  const calm = nightWatch(0, NO_BURN_RULESET)
  assert.equal(calm.encounter.tier, 'elite')
  assert.deepEqual(calm.encounter.traitIds, [])
  for (const ruleset of [BASELINE_RULESET, NO_BURN_RULESET]) {
    assert.deepEqual(
      CAMPAIGN_FIGHTS.map((fight) => [fight.id, encounterTraitIds(fight, ruleset)]),
      [
        ['suit-opposition', []],
        ['royal-court', []],
        ['high-court', [COURT_ETIQUETTE]],
        ['watch-of-tens', []],
        ['night-watch', ruleset.burn.enabled ? [PLUNDER] : []],
        ['ace-sovereign', []],
      ],
    )
  }
})

test('Court Etiquette and a player Hold modifier filter independently, in either order', () => {
  const targets = [
    { instanceId: 'two', cardId: 'c-2H', zone: 'player.drawPile', index: 0 },
    { instanceId: 'ten', cardId: 'c-10H', zone: 'player.drawPile', index: 1 },
    { instanceId: 'jack', cardId: 'c-JH', zone: 'player.drawPile', index: 2 },
    { instanceId: 'seven', cardId: 'c-7D', zone: 'player.wonPile', index: 0 },
    { instanceId: 'ace', cardId: 'c-AD', zone: 'player.wonPile', index: 1 },
  ]
  const narrowed = (modifierId, traitIds, held) => instanceIds(narrowHoldTargets(
    { activeModifiers: withModifier(modifierId), traitIds },
    targets,
    held,
  ))
  // Each row: the player modifier, then the targets under Court Etiquette for a capture
  // into an empty Hold and for replacing a held 7.
  const matrix = [
    [null, ['two', 'ten', 'seven'], ['two', 'ten', 'seven']],
    ['vow-of-the-court-v1', [], ['two', 'ten', 'seven']],
    ['vow-of-patience-v1', ['seven'], ['two', 'ten', 'seven']],
    ['vow-of-constancy-v1', ['two', 'ten', 'seven'], ['ten', 'seven']],
    ['hold-insight-v1', ['two', 'ten', 'seven'], ['two', 'ten', 'seven']],
  ]
  for (const [modifierId, capture, replacement] of matrix) {
    assert.deepEqual(narrowed(modifierId, [COURT_ETIQUETTE], null), capture, `${modifierId} capture`)
    assert.deepEqual(
      narrowed(modifierId, [COURT_ETIQUETTE], 'c-7C'),
      replacement,
      `${modifierId} replacement`,
    )
    for (const held of [null, 'c-2C', 'c-7C', 'c-AC']) {
      const trait = narrowed(null, [COURT_ETIQUETTE], held)
      assert.deepEqual(
        narrowed(modifierId, [COURT_ETIQUETTE], held),
        narrowed(modifierId, [], held).filter((id) => trait.includes(id)),
        `${modifierId} holding ${held}`,
      )
    }
  }
  // Only a 2 can replace a held A under Vow of Constancy, since a 2 beats an A.
  assert.deepEqual(narrowed('vow-of-constancy-v1', [COURT_ETIQUETTE], 'c-AC'), ['two'])
  assert.deepEqual(narrowed(null, [PLUNDER], null), instanceIds(targets))
  assert.deepEqual(narrowed(null, [PLUNDER], 'c-AC'), instanceIds(targets))
})

test('High Court Hold targets follow the stacking matrix, and a held J–A stays playable', () => {
  // Seeds whose gate draft offers each Hold modifier (see campaign-rewards.test.js).
  const cases = [
    [VITALITY_CAP_MODIFIER_ID, 0, 'mend', isNumberCard, isNumberCard],
    ['vow-of-the-court-v1', 0, 'modifier', () => false, isNumberCard],
    ['vow-of-patience-v1', 1, 'modifier',
      (target) => isNumberCard(target) && target.zone === 'player.wonPile', isNumberCard],
    ['vow-of-constancy-v1', 16, 'modifier', isNumberCard,
      (target, heldCardId) => isNumberCard(target) && compareCards(target.cardId, heldCardId) >= 0],
    ['hold-insight-v1', 8, 'modifier', isNumberCard, isNumberCard],
  ]
  for (const [modifierId, seed, offerId, capture, replacement] of cases) {
    const entered = highCourt(seed, offerId)
    assert.equal(entered.activeModifiers.at(-1).id, modifierId)
    assert.deepEqual(entered.encounter.traitIds, [COURT_ETIQUETTE])
    const run = arrangeHoldTargets(entered)
    const captures = getEligibleHoldTargets(run)
    assert.deepEqual(instanceIds(captures), instanceIds(pileCards(run).filter(capture)), modifierId)
    const courtCard = pileCards(run).find((target) => !isNumberCard(target))
    assert.throws(
      () => captureCampaignHold(run, courtCard.instanceId),
      /not eligible under the active Hold modifiers/,
    )
    if (modifierId === 'vow-of-the-court-v1') {
      assert.deepEqual(captures, [])
    }

    const seven = pileCards(run).find(({ cardId }) => getCard(cardId).rank === '7')
    const holding = holdCard(run, seven.instanceId)
    assert.deepEqual(
      instanceIds(getEligibleHoldTargets(holding)),
      instanceIds(pileCards(holding).filter((target) => replacement(target, seven.cardId))),
      `${modifierId} replacing a 7`,
    )
    const expectedState = modifierId === 'hold-insight-v1'
      ? 'awaitingInformedHoldChoice'
      : 'awaitingHoldChoice'
    assert.equal(prepareCampaignReveal(entered).match.machineState, expectedState)
  }

  const opening = gate(0)
  const ace = opening.cards.find(({ cardId }) => getCard(cardId).rank === 'A')
  const court = highCourt(0, 'mend', holdCard(opening, ace.instanceId))
  assert.equal(court.hold, ace.instanceId)
  assert.deepEqual(court.encounter.traitIds, [COURT_ETIQUETTE])
  const replacements = getEligibleHoldTargets(arrangeHoldTargets(court))
  assert.ok(replacements.length > 0)
  assert.ok(replacements.every(isNumberCard))
  const prepared = prepareCampaignReveal(court).match
  assert.equal(prepared.machineState, 'awaitingHoldChoice')
  const played = chooseCampaignReveal(prepared, 'hold')
  assert.deepEqual(played.event.reveals[0], {
    instanceId: ace.instanceId,
    cardId: ace.cardId,
    suppliedBy: 'player',
    from: 'player.hold',
  })
  assert.equal(played.match.hold, null)
})

test('burns follow the effect that names the clash winner, and Plunder suspends Spoils', () => {
  const spoils = createModifierRecord('spoils-of-war-v1', 'gate')
  const effects = {
    neither: { activeModifiers: createStartingModifierRecords(), traitIds: [] },
    spoils: { activeModifiers: [...createStartingModifierRecords(), spoils], traitIds: [] },
    plunder: { activeModifiers: createStartingModifierRecords(), traitIds: [PLUNDER] },
    both: { activeModifiers: [...createStartingModifierRecords(), spoils], traitIds: [PLUNDER] },
  }
  // Whether the cards the clash loser supplied burn under the burn ruleset. Plunder's
  // burnSettlement suspends Spoils of War, so with both the player's wins still burn.
  const loserCardsBurn = {
    player: { neither: true, spoils: false, plunder: true, both: true },
    opponent: { neither: true, spoils: true, plunder: false, both: false },
  }
  for (const winner of ['player', 'opponent']) {
    const loser = winner === 'player' ? 'opponent' : 'player'
    for (const [name, effect] of Object.entries(effects)) {
      const burns = (ruleset, suppliedBy) => contestCardBurns({
        ruleset,
        ...effect,
        winner,
        suppliedBy,
      })
      const label = `${winner} wins with ${name}`
      assert.equal(burns(BASELINE_RULESET, loser), loserCardsBurn[winner][name], label)
      assert.equal(burns(BASELINE_RULESET, winner), false, label)
      assert.equal(burns(NO_BURN_RULESET, loser), false, label)
      assert.equal(burns(NO_BURN_RULESET, winner), false, label)
    }
  }
})

test('Plunder suspends Spoils of War, so the Night Watch plays the same clashes with it', () => {
  // Seed 3 drafts Spoils of War after the Royal Court. Claiming it instead of Mend leaves
  // the deck and the main RNG stream unchanged, so both Night Watch fights shuffle alike.
  const court = passThrough(claimReward(winEncounter(gate(3)), 'mend'), 'shrine', 'court')
  const won = winEncounter(court)
  const offer = won.pendingReward.offers.find(({ offerId }) => offerId === 'modifier')
  assert.equal(offer.modifierId, 'spoils-of-war-v1')
  const [spoils, plain] = ['modifier', 'mend'].map((offerId) => {
    const entered = passThrough(claimReward(won, offerId), 'vault', 'night-watch')
    const settled = []
    let run = entered
    for (let step = 0; step < 2000 && run.machineState === 'ready'; step += 1) {
      const { match, event } = clash(run)
      const { type, winner, reveals, transfers, burned } = event
      settled.push({ type, winner, reveals, transfers, burned })
      run = match
    }
    assert.notEqual(run.machineState, 'ready')
    return { entered, settled, end: run.machineState, outcome: run.encounter.outcome }
  })
  assert.ok(spoils.entered.activeModifiers.some(({ id }) => id === 'spoils-of-war-v1'))
  assert.ok(!plain.entered.activeModifiers.some(({ id }) => id === 'spoils-of-war-v1'))
  assert.deepEqual(spoils.entered.encounter.traitIds, [PLUNDER])
  assert.deepEqual(spoils.settled, plain.settled)
  assert.equal(spoils.end, plain.end)
  assert.deepEqual(spoils.outcome, plain.outcome)
  // The player's wins still burn the opponent's cards, which Spoils of War would claim.
  assert.ok(spoils.settled.some(({ winner, burned }) => winner === 'player' && burned.length > 0))
})

test('plundered cards stay the player\'s, can burn for the opponent, and return after the fight', () => {
  // Seed 0 plunders early, has the opponent reveal a plundered card after recycling its won
  // pile, and still wins the Night Watch.
  const entered = nightWatch(0)
  const owners = new Map(entered.cards.map(({ instanceId, campaignOwner }) => [instanceId, campaignOwner]))
  const playerOwned = (instanceId) => owners.get(instanceId) === 'player'
  const seen = { plundered: false, revealedByOpponent: false, burnedForOpponent: false }
  let run = entered
  for (let step = 0; step < 400 && run.machineState === 'ready'; step += 1) {
    const { match, event } = clash(run)
    // The opponent reveals a plundered card only after recycling its won pile.
    for (const { instanceId, suppliedBy, from } of event.reveals) {
      if (suppliedBy === 'opponent' && playerOwned(instanceId)) {
        seen.revealedByOpponent = true
        assert.equal(from, 'opponent.drawPile')
      }
    }
    if (event.type === 'clashSettled') {
      const losing = event.reveals
        .filter(({ suppliedBy }) => suppliedBy !== event.winner)
        .map(({ instanceId }) => instanceId)
      if (event.winner === 'opponent') {
        assert.deepEqual(event.burned, [])
        assert.deepEqual(instanceIds(event.transfers), instanceIds(event.reveals))
        assert.ok(event.transfers.every(({ to }) => to === 'opponent.wonPile'))
        for (const instanceId of losing.filter(playerOwned)) {
          seen.plundered = true
          assert.ok(match.encounter.zones.opponent.wonPile.includes(instanceId))
          assert.equal(
            match.cards.find((card) => card.instanceId === instanceId).campaignOwner,
            'player',
          )
        }
        if (match.machineState === 'ready') {
          const targets = new Set(instanceIds(getEligibleHoldTargets(match)))
          assert.ok(match.encounter.zones.opponent.wonPile.every((id) => !targets.has(id)))
        }
      } else {
        // Plunder never helps the player: every opponent-supplied card burns, including the
        // player's own cards that the opponent revealed.
        assert.deepEqual(event.burned, losing)
        if (losing.some(playerOwned)) seen.burnedForOpponent = true
      }
    }
    run = match
  }
  assert.deepEqual(seen, { plundered: true, revealedByOpponent: true, burnedForOpponent: true })
  assert.equal(run.machineState, 'awaitingReward')

  const after = claimReward(run, 'mend')
  assert.equal(after.encounter, null)
  assert.deepEqual(after.deckLayout, entered.deckLayout)
  assert.deepEqual(
    after.cards,
    entered.cards.filter(({ campaignOwner }) => campaignOwner === 'player'),
  )
})

test('validation refuses opponent traits outside the encounter that carries them', () => {
  const court = highCourt(0, 'modifier')
  const traitMismatch = /campaign\.encounter\.traitIds(\[\d+\])? must match the traits its fight carries under the ruleset/
  const cases = [
    ['a trait record', court, (run) => {
      run.activeModifiers.push({ id: PLUNDER, lifetime: 'encounter', grantedAtNodeId: 'gate' })
    }, /campaign\.activeModifiers\[2\]\.id names an opponent trait, which only an encounter can carry/],
    ['no traits on an elite', court, (run) => { run.encounter.traitIds = [] }, traitMismatch],
    ['another fight\'s trait', court, (run) => { run.encounter.traitIds = [PLUNDER] }, traitMismatch],
    ['an extra trait', court, (run) => {
      run.encounter.traitIds = [COURT_ETIQUETTE, PLUNDER]
    }, traitMismatch],
    ['a trait on a normal fight', gate(0), (run) => {
      run.encounter.traitIds = [COURT_ETIQUETTE]
    }, traitMismatch],
    ['Plunder without burns', nightWatch(0, NO_BURN_RULESET), (run) => {
      run.encounter.traitIds = [PLUNDER]
    }, traitMismatch],
    ['a missing trait list', court, (run) => { delete run.encounter.traitIds }, /campaign\.encounter/],
    ['a normal tier on an elite', court, (run) => { run.encounter.tier = 'normal' },
      /Campaign encounter metadata must match its authored definition/],
    ['a journal gain of a trait', court, (run) => {
      run.journal.find(({ type }) => type === 'reward').modifierId = COURT_ETIQUETTE
    }, /must match its regenerated reward draft/],
  ]
  for (const [label, run, edit, message] of cases) {
    const forged = clone(run)
    edit(forged)
    refingerprint(forged)
    assert.throws(() => validateCampaignState(forged), message, label)
  }

  const journal = clone(court.journal)
  journal.find(({ type }) => type === 'reward').modifierId = PLUNDER
  assert.throws(
    () => replayCampaignJournal({ seed: court.rng.seed, ruleset: court.ruleset, journal }),
    /Campaign journal entry 1 must match its regenerated reward draft/,
  )

  const events = structuredClone(CAMPAIGN_NODE_EVENTS)
  events.find(({ id }) => id === 'oathkeepers-vault').options
    .find(({ id }) => id === 'surrender-held-card').modifierId = PLUNDER
  assert.throws(
    () => validateCampaignEvents(events),
    /Campaign event oathkeepers-vault option surrender-held-card cannot grant opponent trait plunder-v1/,
  )
  const fights = structuredClone(CAMPAIGN_FIGHTS)
  fights.find(({ id }) => id === 'high-court').traitIds = ['hold-insight-v1']
  assert.throws(
    () => validateCampaignFights(fights),
    /fight high-court may carry only opponent traits; hold-insight-v1 is not one/,
  )
})

test('entering or retrying an elite draws only its two shuffles', () => {
  assert.equal(Math.imul(0x6D2B79F5, MULBERRY32_INVERSE) >>> 0, 1)
  const routes = [
    ['high-court', passThrough(claimReward(winEncounter(gate(0)), 'mend'), 'shrine')],
    ['night-watch', (() => {
      const court = passThrough(claimReward(winEncounter(gate(0)), 'mend'), 'shrine', 'court')
      return passThrough(claimReward(winEncounter(court), 'mend'), 'vault')
    })()],
  ]
  for (const [nodeId, atMap] of routes) {
    const fight = getCampaignFight(nodeId)
    const entered = chooseRoute(atMap, nodeId)
    assert.equal(entered.encounter.id, fight.id)
    const players = entered.deckLayout.filter((entry) => entry !== HOLD_POSITION)
    const opponents = entered.cards
      .filter(({ campaignOwner }) => campaignOwner === 'opponent')
      .map(({ instanceId }) => instanceId)
    assert.equal(opponents.length, fight.opponentCardIds.length)
    const expectedDraws = (players.length - 1) + (opponents.length - 1)
    assert.equal(drawsBetween(atMap, entered), expectedDraws, `${nodeId} entry`)
    const control = restoreRng(atMap.rng)
    assert.deepEqual(entered.encounter.zones.playerSourcePile, shuffle(players, control))
    assert.deepEqual(entered.encounter.zones.opponentSourcePile, shuffle(opponents, control))

    const lost = loseEncounter(entered)
    const retried = retryEncounter(lost)
    assert.deepEqual(retried.encounter.traitIds, entered.encounter.traitIds)
    assert.equal(drawsBetween(lost, retried), expectedDraws, `${nodeId} retry`)
  }

  // Plunder is absent without burns, yet the Night Watch shuffles identically.
  const burning = nightWatch(0)
  const calm = nightWatch(0, NO_BURN_RULESET)
  assert.deepEqual(calm.rng, burning.rng)
  assert.deepEqual(calm.encounter.zones, burning.encounter.zones)
})

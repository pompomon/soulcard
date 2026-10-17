import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CAMPAIGN_CARD_COPY_LIMIT,
  CAMPAIGN_DECK_SIZE_LIMITS,
  CAMPAIGN_ENCOUNTERS,
  CAMPAIGN_MEND_HEALTH,
  CAMPAIGN_REWARD_SLOTS,
  CAMPAIGN_STARTER_CARD_IDS,
} from '../../src/domain/campaign-content.js'
import {
  CAMPAIGN_MODIFIER_CATALOGUE,
  CAMPAIGN_MODIFIER_HOOKS,
  assertDistinctModifierHooks,
  createStartingModifierRecords,
  getDraftableModifierPool,
  narrowHoldTargets,
  validateModifierCatalogue,
} from '../../src/domain/campaign-modifiers.js'
import {
  REWARD_DRAFT_STREAM,
  createStarterPlayerCards,
  generateRewardDraft,
} from '../../src/domain/campaign-rewards.js'
import {
  HOLD_POSITION,
  captureCampaignHold,
  chooseCampaignReveal,
  createCampaignRun,
  createCampaignStateFingerprint,
  getCampaignRewardTargets,
  getEligibleHoldTargets,
  prepareCampaignReveal,
  retryCampaignEncounter,
  selectCampaignReward,
  validateCampaignState,
} from '../../src/domain/campaign-machine.js'
import { CARD_IDS, compareCards, getCard } from '../../src/domain/cards.js'
import { BASELINE_RULESET, NO_BURN_RULESET } from '../../src/domain/ruleset.js'
import { createDerivedRng, restoreRng, shuffle } from '../../src/domain/rng.js'

const DECISION_STATES = ['awaitingHoldChoice', 'awaitingInformedHoldChoice']

// Seeds whose first baseline draft offers a specific modifier (see the draft tests below).
const SEEDS = Object.freeze({
  court: 0,
  patience: 1,
  replace: 2,
  spoils: 6,
  insight: 8,
  constancy: 16,
})

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function emptyZones() {
  return {
    playerSourcePile: [],
    opponentSourcePile: [],
    player: { drawPile: [], wonPile: [] },
    opponent: { drawPile: [], wonPile: [] },
    contestedPile: [],
    burnPile: [],
    inPlay: [],
  }
}

function refingerprint(run) {
  run.stateFingerprint = createCampaignStateFingerprint(run)
  if (run.pendingEvent !== null) run.pendingEvent.stateFingerprint = run.stateFingerprint
  return run
}

function fingerprint(run) {
  refingerprint(run)
  validateCampaignState(run)
  return run
}

function mutableReady(input) {
  const run = clone(input)
  run.machineState = 'ready'
  run.status = 'active'
  run.outcome = null
  run.encounter.outcome = null
  run.holdChoice = null
  run.pendingReward = null
  run.pendingEvent = null
  return run
}

function playerIds(run) {
  return run.cards
    .filter(({ campaignOwner, instanceId }) => campaignOwner === 'player' && instanceId !== run.hold)
    .map(({ instanceId }) => instanceId)
}

function opponentIds(run) {
  return run.cards
    .filter(({ campaignOwner }) => campaignOwner === 'opponent')
    .map(({ instanceId }) => instanceId)
}

function arrangeInability(input, unableSide) {
  const run = mutableReady(input)
  const players = playerIds(run)
  const opponents = opponentIds(run)
  run.encounter.zones = emptyZones()
  run.encounter.supplyMode = { player: 'source', opponent: 'source' }
  if (unableSide === 'player') {
    run.encounter.zones.opponentSourcePile.push(opponents.shift())
    run.encounter.zones.opponent.wonPile.push(...players, ...opponents)
  } else {
    run.encounter.zones.playerSourcePile.push(players.shift())
    run.encounter.zones.player.wonPile.push(...players, ...opponents)
  }
  return fingerprint(run)
}

function resolvePrepared(input, choice = null) {
  const prepared = prepareCampaignReveal(input)
  if (!DECISION_STATES.includes(prepared.match.machineState)) return prepared
  const selected = choice ?? (prepared.match.holdChoice.candidate === null ? 'hold' : 'normal')
  return chooseCampaignReveal(prepared.match, selected)
}

function winEncounter(input) {
  return resolvePrepared(arrangeInability(input, 'opponent')).match
}

function loseEncounter(input) {
  return resolvePrepared(arrangeInability(input, 'player')).match
}

function start(seed, ruleset = BASELINE_RULESET, runId = `campaign-rewards-${seed}`) {
  return createCampaignRun({ runId, seed, ruleset })
}

function pick(run, offerId, targetInstanceId = null) {
  return selectCampaignReward(run, { offerId, targetInstanceId })
}

function offer(run, offerId) {
  return run.pendingReward.offers.find((candidate) => candidate.offerId === offerId)
}

function starterCardIds() {
  return createStarterPlayerCards().map(({ cardId }) => cardId)
}

function expectedDraft({ seed, encounterIndex, cardIds, modifierPool }) {
  const rng = createDerivedRng(seed, REWARD_DRAFT_STREAM, encounterIndex)
  const owned = new Map()
  for (const cardId of cardIds) owned.set(cardId, (owned.get(cardId) ?? 0) + 1)
  const unowned = CARD_IDS.filter((cardId) => !owned.has(cardId))
  const draw = (size) => Math.floor(rng.next() * size)
  const offers = []
  let newCard = null
  if (cardIds.length < 40 && unowned.length > 0) {
    newCard = unowned[draw(unowned.length)]
    offers.push({ offerId: 'new-card', kind: 'add', cardId: newCard, modifierId: null })
  }
  const replacements = unowned.filter((cardId) => cardId !== newCard)
  const operations = [
    ...(cardIds.length < 40 && [...owned.values()].some((count) => count < 2) ? ['duplicate'] : []),
    ...(cardIds.length > 20 ? ['remove'] : []),
    ...(replacements.length > 0 ? ['replace'] : []),
  ]
  if (operations.length > 0) {
    const kind = operations[draw(operations.length)]
    offers.push({
      offerId: 'deck-edit',
      kind,
      cardId: kind === 'replace' ? replacements[draw(replacements.length)] : null,
      modifierId: null,
    })
  }
  if (modifierPool.length > 0) {
    offers.push({
      offerId: 'modifier',
      kind: 'modifier',
      cardId: null,
      modifierId: modifierPool[draw(modifierPool.length)],
    })
  }
  offers.push({ offerId: 'mend', kind: 'mend', cardId: null, modifierId: null })
  return { encounterIndex, offers }
}

function withHold(input, instanceId) {
  const run = mutableReady(input)
  const zones = run.encounter.zones
  for (const pile of [
    zones.playerSourcePile,
    zones.player.drawPile,
    zones.player.wonPile,
    zones.opponent.wonPile,
  ]) {
    const index = pile.indexOf(instanceId)
    if (index >= 0) pile.splice(index, 1)
  }
  run.deckLayout[run.deckLayout.indexOf(instanceId)] = HOLD_POSITION
  run.hold = instanceId
  return run
}

test('modifier catalogue is sorted by ID and uses only the frozen rule hooks', () => {
  assert.deepEqual(CAMPAIGN_MODIFIER_HOOKS, [
    'maximumHealth',
    'holdDecision',
    'holdCaptureEligibility',
    'holdReplacementEligibility',
    'burnSettlement',
  ])
  assert.ok(Object.isFrozen(CAMPAIGN_MODIFIER_HOOKS))
  assert.ok(Object.isFrozen(CAMPAIGN_MODIFIER_CATALOGUE))
  const ids = CAMPAIGN_MODIFIER_CATALOGUE.map(({ id }) => id)
  assert.deepEqual(ids, [...ids].sort())
  assert.deepEqual(ids, [
    'hold-insight-v1',
    'spoils-of-war-v1',
    'vitality-cap-v1',
    'vow-of-constancy-v1',
    'vow-of-patience-v1',
    'vow-of-the-court-v1',
  ])
  for (const entry of CAMPAIGN_MODIFIER_CATALOGUE) {
    assert.ok(Object.isFrozen(entry))
    assert.match(entry.id, /-v[1-9][0-9]*$/)
    assert.ok(['campaign', 'encounter'].includes(entry.lifetime))
    assert.ok(entry.hooks.length > 0)
    assert.equal(new Set(entry.hooks).size, entry.hooks.length)
    assert.ok(entry.hooks.every((hook) => CAMPAIGN_MODIFIER_HOOKS.includes(hook)))
  }
  assert.deepEqual(
    CAMPAIGN_MODIFIER_CATALOGUE.map(({ id, lifetime, hooks, draftable, healthOnGain }) => (
      [id, lifetime, hooks.join(), draftable, healthOnGain]
    )),
    [
      ['hold-insight-v1', 'campaign', 'holdDecision', true, 0],
      ['spoils-of-war-v1', 'encounter', 'burnSettlement', true, 0],
      ['vitality-cap-v1', 'campaign', 'maximumHealth', false, 0],
      ['vow-of-constancy-v1', 'campaign', 'holdReplacementEligibility', true, 2],
      ['vow-of-patience-v1', 'campaign', 'holdCaptureEligibility', true, 2],
      ['vow-of-the-court-v1', 'campaign', 'holdCaptureEligibility', true, 2],
    ],
  )

  const valid = clone(CAMPAIGN_MODIFIER_CATALOGUE)
  const invalid = [
    [valid[1], valid[0], ...valid.slice(2)],
    [valid[0], valid[0], ...valid.slice(1)],
    [{ ...valid[0], id: 'hold-insight' }, ...valid.slice(1)],
    [{ ...valid[0], hooks: [] }, ...valid.slice(1)],
    [{ ...valid[0], hooks: ['holdDecision', 'holdDecision'] }, ...valid.slice(1)],
    [{ ...valid[0], hooks: ['comparisonValue'] }, ...valid.slice(1)],
    [{ ...valid[0], lifetime: 'clash' }, ...valid.slice(1)],
    [{ ...valid[0], draftable: 'yes' }, ...valid.slice(1)],
    [{ ...valid[0], healthOnGain: -1 }, ...valid.slice(1)],
    [{ ...valid[0], applicability: { stacked: true } }, ...valid.slice(1)],
    [],
  ]
  for (const catalogue of invalid) {
    assert.throws(() => validateModifierCatalogue(catalogue))
  }
  assert.equal(validateModifierCatalogue(valid), valid)
})

test('modifier pools keep ID order and filter without consuming randomness', (t) => {
  t.mock.method(Math, 'random', () => assert.fail('Hidden Math.random use'))
  const starting = createStartingModifierRecords()
  assert.deepEqual(getDraftableModifierPool(starting, BASELINE_RULESET), [
    'hold-insight-v1',
    'spoils-of-war-v1',
    'vow-of-constancy-v1',
    'vow-of-patience-v1',
    'vow-of-the-court-v1',
  ])
  assert.deepEqual(getDraftableModifierPool(starting, NO_BURN_RULESET), [
    'hold-insight-v1',
    'vow-of-constancy-v1',
    'vow-of-patience-v1',
    'vow-of-the-court-v1',
  ])
  const patience = [...starting, {
    id: 'vow-of-patience-v1',
    lifetime: 'campaign',
    grantedAtEncounterIndex: 0,
  }]
  assert.deepEqual(getDraftableModifierPool(patience, BASELINE_RULESET), [
    'hold-insight-v1',
    'spoils-of-war-v1',
    'vow-of-constancy-v1',
  ])
  const expiringSpoils = [...starting, {
    id: 'spoils-of-war-v1',
    lifetime: 'encounter',
    grantedAtEncounterIndex: 0,
  }]
  assert.deepEqual(
    getDraftableModifierPool(expiringSpoils, BASELINE_RULESET),
    getDraftableModifierPool(starting, BASELINE_RULESET),
  )
})

test('drafts use fixed slots, one derived draw per non-empty slot, and a final Mend', () => {
  assert.deepEqual(CAMPAIGN_REWARD_SLOTS, ['new-card', 'deck-edit', 'modifier'])
  assert.equal(CAMPAIGN_MEND_HEALTH, 1)
  assert.deepEqual(CAMPAIGN_DECK_SIZE_LIMITS, { minimum: 20, maximum: 40 })
  assert.equal(CAMPAIGN_CARD_COPY_LIMIT, 2)
  const cardIds = starterCardIds()
  const modifiers = createStartingModifierRecords()
  for (let seed = 0; seed < 40; seed += 1) {
    for (const encounterIndex of [0, 1]) {
      for (const ruleset of [BASELINE_RULESET, NO_BURN_RULESET]) {
        const draft = generateRewardDraft({
          seed,
          encounterIndex,
          playerCardIds: cardIds,
          activeModifiers: modifiers,
          ruleset,
        })
        assert.deepEqual(draft, expectedDraft({
          seed,
          encounterIndex,
          cardIds,
          modifierPool: getDraftableModifierPool(modifiers, ruleset),
        }))
        assert.deepEqual(draft.offers.map(({ offerId }) => offerId), [
          'new-card',
          'deck-edit',
          'modifier',
          'mend',
        ])
        const added = draft.offers[0].cardId
        assert.equal(getCard(added).suit === 'S' || getCard(added).suit === 'C', true)
        const edit = draft.offers[1]
        if (edit.kind === 'replace') {
          assert.notEqual(edit.cardId, added)
          assert.ok(!cardIds.includes(edit.cardId))
        } else {
          assert.equal(edit.cardId, null)
        }
      }
    }
  }
})

test('deck size and copy limits close slots without spending draws', () => {
  const modifiers = createStartingModifierRecords()
  const draft = (cardIds, seed = 3) => generateRewardDraft({
    seed,
    encounterIndex: 1,
    playerCardIds: cardIds,
    activeModifiers: modifiers,
    ruleset: BASELINE_RULESET,
  })
  const pool = getDraftableModifierPool(modifiers, BASELINE_RULESET)

  const minimum = CARD_IDS.slice(0, 20)
  for (let seed = 0; seed < 20; seed += 1) {
    const result = draft(minimum, seed)
    assert.deepEqual(result, expectedDraft({
      seed,
      encounterIndex: 1,
      cardIds: minimum,
      modifierPool: pool,
    }))
    assert.notEqual(result.offers[1].kind, 'remove')
  }

  const fullDistinct = CARD_IDS.slice(0, 40)
  for (let seed = 0; seed < 20; seed += 1) {
    const result = draft(fullDistinct, seed)
    assert.deepEqual(result.offers.map(({ offerId }) => offerId), ['deck-edit', 'modifier', 'mend'])
    assert.ok(['remove', 'replace'].includes(result.offers[0].kind))
    assert.deepEqual(result, expectedDraft({
      seed,
      encounterIndex: 1,
      cardIds: fullDistinct,
      modifierPool: pool,
    }))
  }

  const fullDoubled = [...CARD_IDS.slice(0, 20), ...CARD_IDS.slice(0, 20)]
  for (let seed = 0; seed < 20; seed += 1) {
    const result = draft(fullDoubled, seed)
    assert.ok(['remove', 'replace'].includes(result.offers[0].kind))
  }

  const capped = [...CARD_IDS.slice(0, 13), ...CARD_IDS.slice(0, 13)]
  for (let seed = 0; seed < 20; seed += 1) {
    assert.ok(['remove', 'replace'].includes(draft(capped, seed).offers[1].kind))
  }
})

test('winning drafts are bound to the event fingerprint and leave the main RNG untouched', () => {
  const arranged = arrangeInability(start(SEEDS.insight), 'opponent')
  const won = resolvePrepared(arranged)
  assert.equal(won.match.machineState, 'awaitingReward')
  assert.deepEqual(won.match.rng, arranged.rng)
  assert.deepEqual(won.match.pendingReward, generateRewardDraft({
    seed: won.match.rng.seed,
    encounterIndex: 0,
    playerCardIds: starterCardIds(),
    activeModifiers: createStartingModifierRecords(),
    ruleset: BASELINE_RULESET,
  }))
  assert.equal(won.event.stateFingerprint, won.match.stateFingerprint)
  assert.equal(offer(won.match, 'modifier').modifierId, 'hold-insight-v1')

  const tampered = clone(won.match)
  tampered.pendingReward.offers[2].modifierId = 'vow-of-patience-v1'
  assert.notEqual(createCampaignStateFingerprint(tampered), won.match.stateFingerprint)
  refingerprint(tampered)
  assert.throws(() => validateCampaignState(tampered), /regenerated reward draft/)

  for (const mutate of [
    (run) => { run.pendingReward.offers.pop() },
    (run) => { run.pendingReward.offers.reverse() },
    (run) => { run.pendingReward.encounterIndex = 1 },
    (run) => { run.pendingReward.offers[0].cardId = 'c-AS' },
    (run) => { run.pendingReward.offers[3].extra = null },
    (run) => { run.pendingReward = null },
  ]) {
    const forged = clone(won.match)
    mutate(forged)
    refingerprint(forged)
    assert.throws(() => validateCampaignState(forged))
  }

  const lost = clone(loseEncounter(start(SEEDS.insight)))
  lost.pendingReward = clone(won.match.pendingReward)
  refingerprint(lost)
  assert.throws(() => validateCampaignState(lost), /pending reward is allowed only/)
})

test('every reward kind edits cards, layout, health, and history exactly', () => {
  const added = pick(winEncounter(start(SEEDS.court)), 'new-card')
  assert.equal(added.encounterIndex, 1)
  assert.equal(added.encounterAttempt, 1)
  assert.deepEqual(added.rewardHistory, [{
    encounterIndex: 0,
    offerId: 'new-card',
    kind: 'add',
    cardId: 'c-QC',
    modifierId: null,
    targetInstanceId: null,
    createdInstanceId: 'player-027',
  }])
  assert.deepEqual(
    added.cards.filter(({ campaignOwner }) => campaignOwner === 'player').at(-1),
    { instanceId: 'player-027', cardId: 'c-QC', campaignOwner: 'player' },
  )
  assert.equal(added.deckLayout.at(-1), 'player-027')
  assert.equal(added.deckLayout.length, 27)
  assert.ok(added.encounter.zones.playerSourcePile.includes('player-027'))

  const removing = winEncounter(start(SEEDS.court))
  assert.equal(offer(removing, 'deck-edit').kind, 'remove')
  const removeTargets = getCampaignRewardTargets(removing, 'deck-edit')
  assert.equal(removeTargets.length, 26)
  const removedId = removeTargets[3].instanceId
  const removedIndex = removing.deckLayout.indexOf(removedId)
  const removed = pick(removing, 'deck-edit', removedId)
  assert.equal(removed.deckLayout.length, 25)
  assert.ok(!removed.deckLayout.includes(removedId))
  assert.deepEqual(removed.deckLayout, removing.deckLayout.filter((id) => id !== removedId))
  assert.ok(!removed.cards.some(({ instanceId }) => instanceId === removedId))
  assert.equal(removed.rewardHistory[0].createdInstanceId, null)
  assert.equal(removed.rewardHistory[0].targetInstanceId, removedId)
  assert.ok(removedIndex >= 0)

  const duplicating = winEncounter(start(SEEDS.patience))
  assert.equal(offer(duplicating, 'deck-edit').kind, 'duplicate')
  const duplicateTarget = getCampaignRewardTargets(duplicating, 'deck-edit')[0]
  const duplicated = pick(duplicating, 'deck-edit', duplicateTarget.instanceId)
  assert.deepEqual(duplicated.cards.find(({ instanceId }) => instanceId === 'player-027'), {
    instanceId: 'player-027',
    cardId: duplicateTarget.cardId,
    campaignOwner: 'player',
  })
  assert.equal(duplicated.deckLayout.at(-1), 'player-027')

  const replacing = winEncounter(start(SEEDS.replace))
  const replaceOffer = offer(replacing, 'deck-edit')
  assert.equal(replaceOffer.kind, 'replace')
  const replacedId = getCampaignRewardTargets(replacing, 'deck-edit')[5].instanceId
  const replacedIndex = replacing.deckLayout.indexOf(replacedId)
  const replaced = pick(replacing, 'deck-edit', replacedId)
  assert.equal(replaced.deckLayout[replacedIndex], 'player-027')
  assert.equal(replaced.deckLayout.length, 26)
  assert.ok(!replaced.cards.some(({ instanceId }) => instanceId === replacedId))
  assert.equal(
    replaced.cards.find(({ instanceId }) => instanceId === 'player-027').cardId,
    replaceOffer.cardId,
  )

  const mended = pick(winEncounter(start(SEEDS.court)), 'mend')
  assert.equal(mended.health, 4)
  const vowed = pick(winEncounter(start(SEEDS.court)), 'modifier')
  assert.equal(vowed.health, 5)
  assert.deepEqual(vowed.activeModifiers.at(-1), {
    id: 'vow-of-the-court-v1',
    lifetime: 'campaign',
    grantedAtEncounterIndex: 0,
  })
  const capped = clone(winEncounter(start(SEEDS.court)))
  capped.health = 5
  refingerprint(capped)
  assert.equal(pick(capped, 'mend').health, 5)
  assert.equal(pick(capped, 'modifier').health, 5)

  for (const run of [added, removed, duplicated, replaced, mended, vowed]) {
    const players = run.cards.filter(({ campaignOwner }) => campaignOwner === 'player')
    const supplied = run.encounter.zones.playerSourcePile
    assert.equal(new Set(players.map(({ instanceId }) => instanceId)).size, players.length)
    assert.deepEqual([...supplied].sort(), players.map(({ instanceId }) => instanceId).sort())
    assert.deepEqual(validateCampaignState(clone(run)), clone(run))
  }
})

test('reward selection validates offers and targets without invoking accessors', () => {
  const won = winEncounter(start(SEEDS.patience))
  assert.throws(() => pick(start(SEEDS.patience), 'mend'), /no reward draft/)
  assert.throws(() => pick(won, 'missing'), /not part of the pending draft/)
  assert.throws(() => pick(won, 'deck-edit'), /eligible card/)
  assert.throws(() => pick(won, 'deck-edit', 'opponent-1-1-001'), /eligible card/)
  assert.throws(() => pick(won, 'deck-edit', 'player-999'), /eligible card/)
  assert.throws(() => pick(won, 'mend', 'player-001'), /does not take a target/)
  assert.throws(() => pick(won, 'new-card', 'player-001'), /does not take a target/)
  assert.throws(() => selectCampaignReward(won, { offerId: 'mend' }), /must contain only/)
  assert.throws(
    () => selectCampaignReward(won, { offerId: 'mend', targetInstanceId: null, extra: 1 }),
    /must contain only/,
  )
  assert.throws(() => selectCampaignReward(won, null), /plain object/)
  assert.throws(() => getCampaignRewardTargets(won, 'missing'), /not part of the pending draft/)
  assert.deepEqual(getCampaignRewardTargets(won, 'mend'), [])
  assert.deepEqual(getCampaignRewardTargets(start(SEEDS.patience), 'mend'), [])

  let invoked = false
  const selection = { targetInstanceId: null }
  Object.defineProperty(selection, 'offerId', {
    enumerable: true,
    get() {
      invoked = true
      return 'mend'
    },
  })
  assert.throws(() => selectCampaignReward(won, selection), /JSON-compatible data/)
  assert.equal(invoked, false)
})

test('reward targets exclude Hold and count the held card toward copy limits', () => {
  const ready = start(SEEDS.patience)
  const held = playerIds(ready)[0]
  const heldCardId = ready.cards.find(({ instanceId }) => instanceId === held).cardId
  const won = winEncounter(fingerprint(withHold(ready, held)))
  assert.equal(won.hold, held)
  assert.equal(offer(won, 'deck-edit').kind, 'duplicate')
  const targets = getCampaignRewardTargets(won, 'deck-edit')
  assert.equal(targets.length, 25)
  assert.ok(!targets.some(({ instanceId }) => instanceId === held))
  assert.ok(!targets.some(({ instanceId }) => instanceId === HOLD_POSITION))
  assert.deepEqual(
    targets.map(({ cardId }) => CARD_IDS.indexOf(cardId)),
    [...targets.map(({ cardId }) => CARD_IDS.indexOf(cardId))].sort((a, b) => a - b),
  )
  assert.throws(() => pick(won, 'deck-edit', held), /eligible card/)
  assert.throws(() => pick(won, 'deck-edit', HOLD_POSITION), /eligible card/)

  const next = pick(won, 'deck-edit', targets[0].instanceId)
  assert.equal(next.hold, held)
  assert.equal(next.deckLayout.filter((entry) => entry === HOLD_POSITION).length, 1)
  assert.equal(next.cards.filter(({ cardId }) => cardId === heldCardId).length, 1)

  // Seed 11 offers a duplicate in both of its first two drafts.
  const first = winEncounter(start(11))
  assert.equal(offer(first, 'deck-edit').kind, 'duplicate')
  const original = getCampaignRewardTargets(first, 'deck-edit')[0]
  const doubled = pick(first, 'deck-edit', original.instanceId)
  const heldCopy = fingerprint(withHold(doubled, 'player-027'))
  const second = winEncounter(heldCopy)
  assert.equal(second.hold, 'player-027')
  assert.equal(offer(second, 'deck-edit').kind, 'duplicate')
  const secondTargets = getCampaignRewardTargets(second, 'deck-edit')
  assert.equal(secondTargets.length, 25)
  assert.ok(!secondTargets.some(({ cardId }) => cardId === original.cardId))
  assert.throws(() => pick(second, 'deck-edit', original.instanceId), /eligible card/)
})

test('new instance IDs continue after the highest issued ID and are never reused', () => {
  const removing = winEncounter(start(SEEDS.court))
  const removedId = getCampaignRewardTargets(removing, 'deck-edit')[0].instanceId
  const afterRemoval = pick(winEncounter(pick(removing, 'deck-edit', removedId)), 'new-card')
  assert.equal(afterRemoval.rewardHistory[1].createdInstanceId, 'player-027')
  const removalIds = afterRemoval.cards
    .filter(({ campaignOwner }) => campaignOwner === 'player')
    .map(({ instanceId }) => instanceId)
  assert.equal(removalIds.length, 26)
  assert.ok(!removalIds.includes(removedId))
  assert.ok(removalIds.includes('player-026'))

  const replacing = winEncounter(start(SEEDS.replace))
  const replacedId = getCampaignRewardTargets(replacing, 'deck-edit')[0].instanceId
  const replaced = pick(replacing, 'deck-edit', replacedId)
  assert.equal(replaced.rewardHistory[0].createdInstanceId, 'player-027')
  const added = pick(winEncounter(replaced), 'new-card')
  assert.equal(added.rewardHistory[1].createdInstanceId, 'player-028')
  assert.ok(!added.cards.some(({ instanceId }) => instanceId === replacedId))

  for (const createdInstanceId of ['player-026', 'player-028', 'player-27']) {
    const forged = clone(replaced)
    forged.rewardHistory[0].createdInstanceId = createdInstanceId
    refingerprint(forged)
    assert.throws(() => validateCampaignState(forged), /next player instance ID|identifier/)
  }
})

test('same seed and reward choices replay a full campaign exactly', () => {
  const play = () => {
    const states = []
    const drafts = []
    let run = start(SEEDS.replace, BASELINE_RULESET, 'campaign-full-replay')
    for (let encounter = 0; encounter < CAMPAIGN_ENCOUNTERS.length; encounter += 1) {
      for (let step = 0; step < 400 && run.machineState === 'ready'; step += 1) {
        const resolved = resolvePrepared(run)
        states.push(resolved)
        run = resolved.match
        if (run.machineState === 'ready' && step % 5 === 0) {
          const target = getEligibleHoldTargets(run)[0]
          if (target !== undefined) run = captureCampaignHold(run, target.instanceId)
        }
      }
      if (run.machineState === 'awaitingRetry') run = retryCampaignEncounter(run)
      if (run.machineState === 'ready') run = winEncounter(run)
      if (run.machineState === 'awaitingReward') {
        drafts.push(run)
        const choice = run.encounterIndex === 0 ? 'deck-edit' : 'modifier'
        const target = getCampaignRewardTargets(run, choice)[0]?.instanceId ?? null
        run = pick(run, choice, target)
        states.push(run)
      }
      if (run.machineState === 'ended') break
    }
    return { states, drafts, run }
  }
  const first = play()
  const second = play()
  assert.deepEqual(second, first)
  assert.equal(first.run.rewardHistory.length, first.run.encounterIndex)
  const roundTrip = clone(first.run)
  assert.deepEqual(validateCampaignState(roundTrip), clone(first.run))

  assert.equal(first.drafts.length, first.run.rewardHistory.length)
  first.drafts.forEach((draftState, index) => {
    assert.equal(draftState.encounterIndex, index)
    const history = first.run.rewardHistory[index]
    const chosen = draftState.pendingReward.offers
      .find(({ offerId }) => offerId === history.offerId)
    assert.deepEqual(
      { ...chosen },
      {
        offerId: history.offerId,
        kind: history.kind,
        cardId: history.cardId,
        modifierId: history.modifierId,
      },
    )
    const forged = clone(first.run)
    forged.rewardHistory[index].offerId = draftState.pendingReward.offers
      .find(({ offerId }) => offerId !== history.offerId).offerId
    refingerprint(forged)
    assert.throws(() => validateCampaignState(forged), /must match its regenerated draft/)
  })
})

test('reward history and active modifiers must match their replay exactly', () => {
  const run = pick(winEncounter(start(SEEDS.patience)), 'modifier')
  assert.deepEqual(run.activeModifiers.map(({ id }) => id), [
    'vitality-cap-v1',
    'vow-of-patience-v1',
  ])
  const mutations = [
    [(state) => { state.rewardHistory = [] }, /one entry per completed encounter/],
    [(state) => { state.rewardHistory[0].encounterIndex = 1 }, /completed encounter order/],
    [(state) => { state.rewardHistory[0].kind = 'mend' }, /regenerated draft/],
    [(state) => { state.rewardHistory[0].kind = 'unknown' }, /known reward kind/],
    [(state) => { state.rewardHistory[0].modifierId = 'hold-insight-v1' }, /regenerated draft/],
    [(state) => { state.rewardHistory[0].targetInstanceId = 'player-001' }, /must not record a target/],
    [(state) => { state.rewardHistory[0].createdInstanceId = 'player-027' }, /next player instance ID/],
    [(state) => { delete state.rewardHistory[0].cardId }, /must contain only/],
    [(state) => { state.activeModifiers.pop() }, /activeModifiers/],
    [(state) => { state.activeModifiers.reverse() }, /activeModifiers/],
    [(state) => { state.activeModifiers[1].lifetime = 'encounter' }, /activeModifiers/],
    [(state) => { state.activeModifiers[1].grantedAtEncounterIndex = 1 }, /activeModifiers/],
    [(state) => { state.activeModifiers[1].id = 'vow-of-unknown-v1' }, /catalogue modifier/],
    [(state) => {
      state.activeModifiers.push({
        id: 'vow-of-the-court-v1',
        lifetime: 'campaign',
        grantedAtEncounterIndex: 0,
      })
    }, /both modify holdCaptureEligibility/],
    [(state) => { state.maxHealth = 6 }, /fixed maximum/],
    [(state) => {
      state.cards.find(({ instanceId }) => instanceId === 'player-001').cardId = 'c-AS'
    }, /reward history/],
  ]
  for (const [mutate, message] of mutations) {
    const forged = clone(run)
    mutate(forged)
    refingerprint(forged)
    assert.throws(() => validateCampaignState(forged), message)
  }
  assert.throws(
    () => assertDistinctModifierHooks([
      { id: 'vow-of-patience-v1' },
      { id: 'vow-of-the-court-v1' },
    ]),
    /both modify holdCaptureEligibility/,
  )
})

test('encounter modifiers survive retries and reloads, then expire exactly once', () => {
  let run = winEncounter(start(SEEDS.spoils))
  assert.equal(offer(run, 'modifier').modifierId, 'spoils-of-war-v1')
  run = pick(run, 'modifier')
  const spoils = { id: 'spoils-of-war-v1', lifetime: 'encounter', grantedAtEncounterIndex: 0 }
  assert.deepEqual(run.activeModifiers.at(-1), spoils)

  run = loseEncounter(run)
  assert.equal(run.machineState, 'awaitingRetry')
  assert.deepEqual(run.activeModifiers.at(-1), spoils)
  run = retryCampaignEncounter(run)
  assert.equal(run.encounterAttempt, 2)
  assert.deepEqual(run.activeModifiers.at(-1), spoils)
  run = validateCampaignState(clone(run))
  assert.deepEqual(run.activeModifiers.at(-1), spoils)

  run = winEncounter(run)
  assert.deepEqual(run.activeModifiers.at(-1), spoils)
  const mended = pick(run, 'mend')
  assert.deepEqual(mended.activeModifiers.map(({ id }) => id), ['vitality-cap-v1'])
  if (offer(run, 'modifier')?.modifierId === 'spoils-of-war-v1') {
    const renewed = pick(run, 'modifier')
    assert.deepEqual(renewed.activeModifiers.at(-1), { ...spoils, grantedAtEncounterIndex: 1 })
  }

  const unexpired = clone(mended)
  unexpired.activeModifiers.push(spoils)
  refingerprint(unexpired)
  assert.throws(() => validateCampaignState(unexpired), /activeModifiers/)

  let vowed = pick(winEncounter(start(SEEDS.court)), 'modifier')
  const vow = vowed.activeModifiers.at(-1)
  vowed = retryCampaignEncounter(loseEncounter(vowed))
  vowed = pick(winEncounter(validateCampaignState(clone(vowed))), 'mend')
  assert.deepEqual(vowed.activeModifiers.at(-1), vow)
  const victory = winEncounter(vowed)
  assert.equal(victory.status, 'ended')
  assert.deepEqual(victory.activeModifiers.at(-1), vow)
})

test('Spoils of War sends a player-won contest to the player without burning', () => {
  let run = pick(winEncounter(start(SEEDS.spoils)), 'modifier')
  let playerWin = null
  let opponentWin = null
  for (let step = 0; step < 200 && run.machineState === 'ready'; step += 1) {
    const resolved = resolvePrepared(run, 'normal')
    if (resolved.event.type === 'clashSettled' && resolved.event.winner === 'player') {
      playerWin ??= resolved
    } else if (resolved.event.type === 'clashSettled') {
      opponentWin ??= resolved
    }
    run = resolved.match
    if (playerWin !== null && opponentWin !== null) break
  }
  assert.ok(playerWin !== null && opponentWin !== null)
  assert.deepEqual(playerWin.event.burned, [])
  assert.deepEqual(
    playerWin.event.transfers.map(({ instanceId }) => instanceId),
    playerWin.event.reveals.map(({ instanceId }) => instanceId),
  )
  assert.ok(playerWin.event.reveals.some(({ suppliedBy }) => suppliedBy === 'opponent'))
  assert.deepEqual(
    opponentWin.event.burned,
    opponentWin.event.reveals
      .filter(({ suppliedBy }) => suppliedBy === 'player')
      .map(({ instanceId }) => instanceId),
  )

  const burnedInstead = clone(playerWin.match)
  const event = burnedInstead.pendingEvent
  const opponentCards = event.reveals
    .filter(({ suppliedBy }) => suppliedBy === 'opponent')
    .map(({ instanceId }) => instanceId)
  const wonPile = burnedInstead.encounter.zones.player.wonPile
  for (const instanceId of opponentCards) wonPile.splice(wonPile.indexOf(instanceId), 1)
  burnedInstead.encounter.zones.burnPile.push(...opponentCards)
  event.transfers = event.transfers.filter(({ instanceId }) => !opponentCards.includes(instanceId))
  event.burned = opponentCards
  refingerprint(burnedInstead)
  assert.throws(
    () => validateCampaignState(burnedInstead),
    /settlement must match the active burn ruleset and modifiers/,
  )
})

test('Hold vows only narrow eligible targets and keep the swap unchanged', () => {
  const unrestricted = (run) => {
    const instances = new Map(run.cards.map((card) => [card.instanceId, card]))
    return ['drawPile', 'wonPile'].flatMap((zone) => run.encounter.zones.player[zone]
      .filter((instanceId) => instances.get(instanceId).campaignOwner === 'player')
      .map((instanceId) => instanceId))
  }
  const arrange = (input) => {
    const run = mutableReady(input)
    const players = playerIds(run)
    run.encounter.zones = emptyZones()
    run.encounter.supplyMode = { player: 'personal', opponent: 'source' }
    run.encounter.zones.player.drawPile.push(...players.slice(0, 12))
    run.encounter.zones.player.wonPile.push(...players.slice(12), ...opponentIds(run).slice(0, 2))
    run.encounter.zones.opponentSourcePile.push(...opponentIds(run).slice(2))
    return fingerprint(run)
  }

  const court = arrange(pick(winEncounter(start(SEEDS.court)), 'modifier'))
  const courtTargets = getEligibleHoldTargets(court)
  assert.ok(courtTargets.length > 0)
  assert.ok(courtTargets.every(({ cardId }) => ['J', 'Q', 'K', 'A'].includes(getCard(cardId).rank)))
  assert.ok(courtTargets.every(({ instanceId }) => unrestricted(court).includes(instanceId)))
  const lowCard = unrestricted(court).find((instanceId) => (
    !['J', 'Q', 'K', 'A'].includes(getCard(court.cards.find((card) => card.instanceId === instanceId).cardId).rank)
  ))
  assert.throws(() => captureCampaignHold(court, lowCard), /active Hold modifiers/)
  const opponentCard = court.encounter.zones.player.wonPile
    .find((instanceId) => instanceId.startsWith('opponent-'))
  assert.throws(() => captureCampaignHold(court, opponentCard), /player-provenance/)

  const patience = arrange(pick(winEncounter(start(SEEDS.patience)), 'modifier'))
  const patienceTargets = getEligibleHoldTargets(patience)
  assert.ok(patienceTargets.length > 0)
  assert.ok(patienceTargets.every(({ zone }) => zone === 'player.wonPile'))
  assert.throws(
    () => captureCampaignHold(patience, patience.encounter.zones.player.drawPile[0]),
    /active Hold modifiers/,
  )
  const captured = captureCampaignHold(patience, patienceTargets[0].instanceId)
  assert.equal(captured.hold, patienceTargets[0].instanceId)
  const replacementTargets = getEligibleHoldTargets(captured)
  assert.deepEqual(
    replacementTargets.map(({ instanceId }) => instanceId),
    unrestricted(captured),
  )

  const constancy = arrange(pick(winEncounter(start(SEEDS.constancy)), 'modifier'))
  assert.deepEqual(
    getEligibleHoldTargets(constancy).map(({ instanceId }) => instanceId),
    unrestricted(constancy),
  )
  const aceId = constancy.cards.find(({ cardId, campaignOwner }) => (
    campaignOwner === 'player' && getCard(cardId).rank === 'A'
  )).instanceId
  const heldAce = fingerprint(withHold(constancy, aceId))
  const aceReplacements = getEligibleHoldTargets(heldAce)
  assert.ok(aceReplacements.length > 0)
  assert.ok(aceReplacements.every(({ cardId }) => compareCards(cardId, 'c-AD') >= 0))
  assert.ok(aceReplacements.some(({ cardId }) => getCard(cardId).rank === '2'))
  const twoId = constancy.cards.find(({ cardId, campaignOwner }) => (
    campaignOwner === 'player' && getCard(cardId).rank === '2'
  )).instanceId
  const heldTwo = fingerprint(withHold(constancy, twoId))
  assert.ok(getEligibleHoldTargets(heldTwo).every(({ cardId }) => getCard(cardId).rank !== 'A'))
  const twoReplacement = getEligibleHoldTargets(heldTwo)[0]
  const swapped = captureCampaignHold(heldTwo, twoReplacement.instanceId)
  const zone = twoReplacement.zone.slice('player.'.length)
  assert.equal(swapped.encounter.zones.player[zone][twoReplacement.index], twoId)
  assert.equal(swapped.hold, twoReplacement.instanceId)

  const targets = [
    { instanceId: 'a', cardId: 'c-2H', zone: 'player.drawPile', index: 0 },
    { instanceId: 'b', cardId: 'c-KH', zone: 'player.wonPile', index: 0 },
    { instanceId: 'c', cardId: 'c-AH', zone: 'player.wonPile', index: 1 },
  ]
  for (const id of ['vow-of-constancy-v1', 'vow-of-patience-v1', 'vow-of-the-court-v1']) {
    const records = [{ id, lifetime: 'campaign', grantedAtEncounterIndex: 0 }]
    for (const held of [null, 'c-2D', 'c-7D', 'c-AD']) {
      const narrowed = narrowHoldTargets(records, targets, held)
      assert.ok(narrowed.every((target) => targets.includes(target)))
    }
  }
})

test('new reward cards can be captured into Hold', () => {
  let run = pick(winEncounter(start(SEEDS.court)), 'new-card')
  run = mutableReady(run)
  const source = run.encounter.zones.playerSourcePile
  source.splice(source.indexOf('player-027'), 1)
  run.encounter.zones.player.wonPile.push('player-027')
  fingerprint(run)
  assert.ok(getEligibleHoldTargets(run).some(({ instanceId }) => instanceId === 'player-027'))
  const captured = captureCampaignHold(run, 'player-027')
  assert.equal(captured.hold, 'player-027')
  assert.equal(captured.deckLayout.at(-1), HOLD_POSITION)
})

function insightRun() {
  const run = pick(winEncounter(start(SEEDS.insight)), 'modifier')
  assert.ok(run.activeModifiers.some(({ id }) => id === 'hold-insight-v1'))
  return run
}

test('informed Hold choices prepare player then opponent with the normal draw order', () => {
  const run = mutableReady(insightRun())
  const players = playerIds(run)
  const opponents = opponentIds(run)
  run.encounter.zones = emptyZones()
  run.encounter.zones.player.wonPile.push(...players)
  run.encounter.zones.opponent.wonPile.push(...opponents)
  run.encounter.supplyMode = { player: 'personal', opponent: 'source' }
  fingerprint(run)

  const control = restoreRng(run.rng)
  const expectedPlayer = shuffle(players, control)
  const expectedOpponent = shuffle(opponents, control)
  const prepared = prepareCampaignReveal(run)
  assert.equal(prepared.event, null)
  assert.equal(prepared.match.machineState, 'awaitingInformedHoldChoice')
  assert.deepEqual(prepared.match.holdChoice, {
    from: 'player.drawPile',
    candidate: expectedPlayer[0],
    opponentFrom: 'opponent.drawPile',
    opponentCandidate: expectedOpponent[0],
  })
  assert.deepEqual(prepared.match.encounter.supplyMode, { player: 'personal', opponent: 'personal' })
  assert.deepEqual(prepared.match.rng, control.snapshot())
  assert.deepEqual(prepared.match.encounter.zones.inPlay, [])
  assert.deepEqual(prepared.match.encounter.zones.contestedPile, [])

  const reloaded = validateCampaignState(clone(prepared.match))
  const fromReload = chooseCampaignReveal(reloaded, 'normal')
  const resolved = chooseCampaignReveal(prepared.match, 'normal')
  assert.deepEqual(fromReload, resolved)
  assert.deepEqual(resolved.event.reveals.slice(0, 2).map(({ instanceId }) => instanceId), [
    expectedPlayer[0],
    expectedOpponent[0],
  ])
  assert.deepEqual(resolved.match.rng, control.snapshot())
  assert.equal(resolved.match.holdChoice, null)
})

test('informed and plain flows produce the same clashes for the same choices', () => {
  let informed = insightRun()
  let plain = pick(winEncounter(start(SEEDS.insight)), 'mend')
  assert.deepEqual(informed.encounter, plain.encounter)
  assert.deepEqual(informed.rng, plain.rng)
  let compared = 0
  for (let step = 0; step < 400 && informed.machineState === 'ready'; step += 1) {
    const informedPrepared = prepareCampaignReveal(informed)
    const plainPrepared = prepareCampaignReveal(plain)
    if (informedPrepared.event !== null) {
      assert.deepEqual(informedPrepared.event.reveals, plainPrepared.event.reveals)
      break
    }
    assert.equal(informedPrepared.match.machineState, 'awaitingInformedHoldChoice')
    assert.equal(plainPrepared.match.machineState, 'awaitingHoldChoice')
    const choice = informedPrepared.match.holdChoice.candidate === null || step % 4 === 3
      ? (informedPrepared.match.hold === null ? 'normal' : 'hold')
      : 'normal'
    const left = chooseCampaignReveal(informedPrepared.match, choice)
    const right = chooseCampaignReveal(plainPrepared.match, choice)
    for (const key of ['reveals', 'transfers', 'burned', 'type', 'winner']) {
      assert.deepEqual(left.event[key], right.event[key])
    }
    assert.deepEqual(left.match.encounter, right.match.encounter)
    assert.deepEqual(left.match.rng, right.match.rng)
    const opponentReveal = left.event.reveals.find(({ suppliedBy }) => suppliedBy === 'opponent')
    assert.equal(
      opponentReveal?.instanceId ?? null,
      informedPrepared.match.holdChoice.opponentCandidate,
    )
    informed = left.match
    plain = right.match
    compared += 1
    if (informed.machineState === 'ready' && step % 4 === 1) {
      const target = getEligibleHoldTargets(informed)[0]
      if (target !== undefined) {
        informed = captureCampaignHold(informed, target.instanceId)
        plain = captureCampaignHold(plain, target.instanceId)
      }
    }
  }
  assert.ok(compared > 5)
})

test('informed choices handle empty candidates, ties, and tampered peeks', () => {
  const base = insightRun()

  const opponentEmpty = prepareCampaignReveal(arrangeInability(base, 'opponent')).match
  assert.equal(opponentEmpty.machineState, 'awaitingInformedHoldChoice')
  assert.equal(opponentEmpty.holdChoice.opponentFrom, 'opponent.drawPile')
  assert.equal(opponentEmpty.holdChoice.opponentCandidate, null)
  const opponentEmptyResult = chooseCampaignReveal(opponentEmpty, 'normal')
  assert.equal(opponentEmptyResult.event.winner, 'player')
  assert.equal(opponentEmptyResult.match.machineState, 'awaitingReward')

  const ready = mutableReady(base)
  const [held, ...others] = playerIds(ready)
  const holding = withHold(ready, held)
  holding.encounter.zones = emptyZones()
  holding.encounter.supplyMode = { player: 'personal', opponent: 'source' }
  holding.encounter.zones.opponentSourcePile.push(...opponentIds(holding))
  holding.encounter.zones.opponent.wonPile.push(...others)
  fingerprint(holding)
  const playerEmpty = prepareCampaignReveal(holding).match
  assert.equal(playerEmpty.machineState, 'awaitingInformedHoldChoice')
  assert.equal(playerEmpty.holdChoice.candidate, null)
  assert.equal(playerEmpty.holdChoice.opponentCandidate, holding.encounter.zones.opponentSourcePile[0])
  assert.throws(() => chooseCampaignReveal(playerEmpty, 'normal'), /unavailable/)
  const heldResult = chooseCampaignReveal(playerEmpty, 'hold')
  assert.equal(heldResult.event.reveals[0].instanceId, held)
  assert.equal(heldResult.event.reveals[1].instanceId, playerEmpty.holdChoice.opponentCandidate)

  const tie = mutableReady(base)
  const tiePlayers = tie.cards.filter(({ campaignOwner }) => campaignOwner === 'player')
  const tieOpponents = tie.cards.filter(({ campaignOwner }) => campaignOwner === 'opponent')
  const playerQueen = tiePlayers.find(({ cardId }) => getCard(cardId).rank === 'Q').instanceId
  const opponentQueen = tieOpponents.find(({ cardId }) => getCard(cardId).rank === 'Q').instanceId
  const playerSeven = tiePlayers.find(({ cardId }) => getCard(cardId).rank === '7').instanceId
  const opponentKing = tieOpponents.find(({ cardId }) => getCard(cardId).rank === 'K').instanceId
  const used = [playerQueen, opponentQueen, playerSeven, opponentKing]
  tie.encounter.zones = emptyZones()
  tie.encounter.zones.playerSourcePile.push(playerQueen, playerSeven)
  tie.encounter.zones.opponentSourcePile.push(opponentQueen, opponentKing)
  tie.encounter.zones.burnPile.push(
    ...tie.cards.map(({ instanceId }) => instanceId).filter((id) => !used.includes(id)),
  )
  fingerprint(tie)
  const tied = prepareCampaignReveal(tie).match
  assert.equal(tied.holdChoice.candidate, playerQueen)
  assert.equal(tied.holdChoice.opponentCandidate, opponentQueen)
  const tieResult = chooseCampaignReveal(tied, 'normal')
  assert.deepEqual(tieResult.event.reveals.map(({ instanceId }) => instanceId), used)
  assert.equal(tieResult.event.winner, 'opponent')

  const prepared = prepareCampaignReveal(base).match
  const mutations = [
    [(state) => { state.holdChoice.opponentCandidate = state.encounter.zones.opponentSourcePile[1] }, /opponent candidate must remain at index zero/],
    [(state) => { state.holdChoice.opponentCandidate = null }, /opponent candidate must remain at index zero/],
    [(state) => { state.holdChoice.opponentFrom = 'opponent.drawPile' }, /opponent origin/],
    [(state) => { delete state.holdChoice.opponentFrom }, /must contain only/],
    [(state) => { state.machineState = 'awaitingHoldChoice' }, /Hold Insight requires the informed Hold choice/],
    [(state) => {
      state.machineState = 'awaitingHoldChoice'
      delete state.holdChoice.opponentFrom
      delete state.holdChoice.opponentCandidate
    }, /Hold Insight requires the informed Hold choice/],
    [(state) => {
      state.encounter.zones.opponentSourcePile.push(state.encounter.zones.opponentSourcePile.shift())
    }, /opponent candidate must remain at index zero/],
  ]
  for (const [mutate, message] of mutations) {
    const forged = clone(prepared)
    mutate(forged)
    refingerprint(forged)
    assert.throws(() => validateCampaignState(forged), message)
  }

  const plain = prepareCampaignReveal(pick(winEncounter(start(SEEDS.insight)), 'mend')).match
  const forgedInformed = clone(plain)
  forgedInformed.machineState = 'awaitingInformedHoldChoice'
  forgedInformed.holdChoice.opponentFrom = 'opponent.sourcePile'
  forgedInformed.holdChoice.opponentCandidate = forgedInformed.encounter.zones.opponentSourcePile[0]
  refingerprint(forgedInformed)
  assert.throws(
    () => validateCampaignState(forgedInformed),
    /informed Hold choice requires Hold Insight/,
  )

  const unprepared = clone(prepareCampaignReveal(arrangeInability(base, 'opponent')).match)
  unprepared.encounter.supplyMode.opponent = 'source'
  unprepared.holdChoice.opponentFrom = 'opponent.sourcePile'
  refingerprint(unprepared)
  assert.throws(
    () => validateCampaignState(unprepared),
    /requires completed opponent supply preparation/,
  )
})

test('starter content remains the authored Diamonds and Hearts deck', () => {
  assert.deepEqual(starterCardIds(), [...CAMPAIGN_STARTER_CARD_IDS])
  assert.ok(CAMPAIGN_ENCOUNTERS.every((encounter) => !Object.hasOwn(encounter, 'reward')))
})

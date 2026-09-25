import assert from 'node:assert/strict'
import test from 'node:test'
import {
  HOLD_POSITION,
  captureCampaignHold,
  chooseCampaignReveal,
  claimCampaignReward,
  createCampaignRun,
  createCampaignStateFingerprint,
  getEligibleHoldTargets,
  prepareCampaignReveal,
  retryCampaignEncounter,
  validateCampaignState,
} from '../../src/domain/campaign-machine.js'
import {
  CAMPAIGN_ENCOUNTERS,
  CAMPAIGN_STARTER_CARD_IDS,
} from '../../src/domain/campaign-content.js'
import { BASELINE_RULESET, NO_BURN_RULESET } from '../../src/domain/ruleset.js'
import { createRng, shuffle } from '../../src/domain/rng.js'

function clone(value) {
  return JSON.parse(JSON.stringify(value))
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

function fingerprint(run) {
  run.stateFingerprint = createCampaignStateFingerprint(run)
  validateCampaignState(run)
  return run
}

function arrangeInability(input, unableSide) {
  const run = mutableReady(input)
  const playerIds = run.cards
    .filter(({ campaignOwner }) => campaignOwner === 'player')
    .map(({ instanceId }) => instanceId)
  const opponentIds = run.cards
    .filter(({ campaignOwner }) => campaignOwner === 'opponent')
    .map(({ instanceId }) => instanceId)
  run.encounter.zones = emptyZones()
  run.encounter.supplyMode = { player: 'source', opponent: 'source' }
  if (unableSide === 'player') {
    run.encounter.zones.opponentSourcePile.push(opponentIds.shift())
    run.encounter.zones.opponent.wonPile.push(...playerIds, ...opponentIds)
  } else {
    run.encounter.zones.playerSourcePile.push(playerIds.shift())
    run.encounter.zones.player.wonPile.push(...playerIds, ...opponentIds)
  }
  return fingerprint(run)
}

function resolvePrepared(input, choice = 'normal') {
  const prepared = prepareCampaignReveal(input)
  return prepared.match.machineState === 'awaitingHoldChoice'
    ? chooseCampaignReveal(prepared.match, choice)
    : prepared
}

function winEncounter(input) {
  return resolvePrepared(arrangeInability(input, 'opponent')).match
}

function loseEncounter(input) {
  return resolvePrepared(arrangeInability(input, 'player')).match
}

test('campaign setup uses authored decks and player-then-opponent shuffle order', () => {
  const run = createCampaignRun({
    runId: 'campaign-setup',
    seed: 12345,
    ruleset: BASELINE_RULESET,
  })
  const rng = createRng(12345)
  const expectedPlayer = shuffle(
    CAMPAIGN_STARTER_CARD_IDS.map((_, index) => (
      `player-${String(index + 1).padStart(3, '0')}`
    )),
    rng,
  )
  const expectedOpponent = shuffle(
    CAMPAIGN_ENCOUNTERS[0].opponentCardIds.map((_, index) => (
      `opponent-1-1-${String(index + 1).padStart(3, '0')}`
    )),
    rng,
  )

  assert.equal(run.health, 3)
  assert.equal(run.maxHealth, 5)
  assert.deepEqual(run.encounter.zones.playerSourcePile, expectedPlayer)
  assert.deepEqual(run.encounter.zones.opponentSourcePile, expectedOpponent)
  assert.deepEqual(run.rng, rng.snapshot())
  assert.deepEqual(run.activeModifiers, [{
    id: 'vitality-cap-v1',
    lifetime: 'campaign',
    effect: { type: 'maximum-health', value: 5 },
  }])
})

test('manual reveal persists a candidate-bound Hold choice before emitting an event', () => {
  const run = createCampaignRun({
    runId: 'campaign-choice',
    seed: 1,
    ruleset: BASELINE_RULESET,
  })
  const candidate = run.encounter.zones.playerSourcePile[0]
  const prepared = prepareCampaignReveal(run)

  assert.equal(prepared.event, null)
  assert.equal(prepared.match.machineState, 'awaitingHoldChoice')
  assert.deepEqual(prepared.match.holdChoice, {
    from: 'player.sourcePile',
    candidate,
  })
  assert.deepEqual(prepared.match.rng, run.rng)

  const resolved = chooseCampaignReveal(prepared.match, 'normal')
  assert.equal(resolved.match.turn, 1)
  assert.equal(resolved.event.reveals[0].instanceId, candidate)
  assert.equal(resolved.event.reveals[0].from, 'player.sourcePile')
})

test('independent supply modes permit mixed source and personal reveals', () => {
  const run = mutableReady(createCampaignRun({
    runId: 'campaign-mixed',
    seed: 8,
    ruleset: NO_BURN_RULESET,
  }))
  run.encounter.zones.opponent.wonPile.push(
    ...run.encounter.zones.opponentSourcePile.splice(0),
  )
  fingerprint(run)

  const resolved = resolvePrepared(run)
  assert.equal(resolved.event.reveals[0].from, 'player.sourcePile')
  assert.equal(resolved.event.reveals[1].from, 'opponent.drawPile')
  assert.equal(resolved.match.encounter.supplyMode.player, 'source')
  assert.equal(resolved.match.encounter.supplyMode.opponent, 'personal')
})

test('Hold-only decisions accept Hold and reject a missing normal candidate', () => {
  const run = mutableReady(createCampaignRun({
    runId: 'campaign-hold-only',
    seed: 9,
    ruleset: BASELINE_RULESET,
  }))
  const [held, ...otherPlayers] = run.cards
    .filter(({ campaignOwner }) => campaignOwner === 'player')
    .map(({ instanceId }) => instanceId)
  const tokenIndex = run.deckLayout.indexOf(held)
  run.deckLayout[tokenIndex] = HOLD_POSITION
  run.hold = held
  run.encounter.zones = emptyZones()
  run.encounter.zones.opponentSourcePile.push(
    ...run.cards
      .filter(({ campaignOwner }) => campaignOwner === 'opponent')
      .map(({ instanceId }) => instanceId),
  )
  run.encounter.zones.opponent.wonPile.push(...otherPlayers)
  run.encounter.supplyMode = { player: 'personal', opponent: 'source' }
  fingerprint(run)

  const prepared = prepareCampaignReveal(run).match
  assert.deepEqual(prepared.holdChoice, {
    from: 'player.drawPile',
    candidate: null,
  })
  assert.throws(() => chooseCampaignReveal(prepared, 'normal'), /unavailable/)
  const resolved = chooseCampaignReveal(prepared, 'hold')
  assert.equal(resolved.event.reveals[0].instanceId, held)
  assert.equal(resolved.event.reveals[0].from, 'player.hold')
  assert.equal(resolved.match.hold, null)
  assert.equal(resolved.match.deckLayout[tokenIndex], held)
})

test('Hold capture, replacement, and play preserve exact encounter and layout order', () => {
  let run = createCampaignRun({
    runId: 'campaign-hold',
    seed: 3,
    ruleset: BASELINE_RULESET,
  })
  run = resolvePrepared(run).match
  const firstTarget = run.encounter.zones.player.wonPile[0]
  const firstLayoutIndex = run.deckLayout.indexOf(firstTarget)
  assert.deepEqual(getEligibleHoldTargets(run).map(({ instanceId }) => instanceId), [firstTarget])

  run = captureCampaignHold(run, firstTarget)
  assert.equal(run.hold, firstTarget)
  assert.equal(run.deckLayout[firstLayoutIndex], HOLD_POSITION)
  assert.equal(run.encounter.zones.player.wonPile.length, 0)

  const prepared = prepareCampaignReveal(run).match
  const normalCandidate = prepared.holdChoice.candidate
  const played = chooseCampaignReveal(prepared, 'hold').match
  assert.equal(played.pendingEvent.reveals[0].instanceId, firstTarget)
  assert.equal(played.encounter.zones.playerSourcePile[0], normalCandidate)
  assert.equal(played.hold, null)
  assert.equal(played.deckLayout[firstLayoutIndex], firstTarget)

  const replacement = mutableReady(played)
  replacement.pendingEvent = null
  const secondTarget = replacement.encounter.zones.playerSourcePile.shift()
  replacement.encounter.zones.player.wonPile.push(secondTarget)
  fingerprint(replacement)
  let captured = captureCampaignHold(replacement, firstTarget)
  const targetLayoutIndex = captured.deckLayout.indexOf(secondTarget)
  captured = captureCampaignHold(captured, secondTarget)
  assert.equal(captured.hold, secondTarget)
  assert.equal(captured.deckLayout[firstLayoutIndex], HOLD_POSITION)
  assert.equal(captured.deckLayout[targetLayoutIndex], firstTarget)
  assert.equal(captured.encounter.zones.player.wonPile.at(-1), firstTarget)
})

test('Hold capture rejects source, opponent-controlled, and opponent-provenance cards', () => {
  const run = createCampaignRun({
    runId: 'campaign-capture-reject',
    seed: 2,
    ruleset: BASELINE_RULESET,
  })
  assert.throws(
    () => captureCampaignHold(run, run.encounter.zones.playerSourcePile[0]),
    /current player control/,
  )
  assert.throws(
    () => captureCampaignHold(run, run.encounter.zones.opponentSourcePile[0]),
    /current player control/,
  )
})

test('burn settlement uses provenance-neutral control while retaining immutable owners', () => {
  const run = createCampaignRun({
    runId: 'campaign-burn',
    seed: 3,
    ruleset: BASELINE_RULESET,
  })
  const resolved = resolvePrepared(run).match
  const losingReveal = resolved.pendingEvent.reveals
    .find(({ suppliedBy }) => suppliedBy !== resolved.pendingEvent.winner)
  assert.ok(resolved.pendingEvent.burned.includes(losingReveal.instanceId))
  assert.ok(resolved.encounter.zones.burnPile.includes(losingReveal.instanceId))
  assert.equal(
    resolved.cards.find(({ instanceId }) => instanceId === losingReveal.instanceId)
      .campaignOwner,
    losingReveal.suppliedBy,
  )
})

test('terminal draws retain tied contests, remove health once, and retry deterministically', () => {
  const run = mutableReady(createCampaignRun({
    runId: 'campaign-draw',
    seed: 11,
    ruleset: BASELINE_RULESET,
  }))
  const player = run.cards.find(({ cardId, campaignOwner }) => (
    cardId === 'c-2D' && campaignOwner === 'player'
  )).instanceId
  const opponent = run.cards.find(({ cardId, campaignOwner }) => (
    cardId === 'c-2S' && campaignOwner === 'opponent'
  )).instanceId
  const allIds = run.cards.map(({ instanceId }) => instanceId)
  run.encounter.zones = emptyZones()
  run.encounter.zones.playerSourcePile.push(player)
  run.encounter.zones.opponentSourcePile.push(opponent)
  run.encounter.zones.burnPile.push(
    ...allIds.filter((instanceId) => ![player, opponent].includes(instanceId)),
  )
  run.encounter.supplyMode = { player: 'source', opponent: 'source' }
  fingerprint(run)

  const drawn = resolvePrepared(run).match
  assert.equal(drawn.pendingEvent.type, 'clashDrawn')
  assert.equal(drawn.encounter.zones.contestedPile.length, 2)
  assert.equal(drawn.health, 2)
  assert.equal(drawn.machineState, 'awaitingRetry')

  const retried = retryCampaignEncounter(drawn)
  assert.equal(retried.health, 2)
  assert.equal(retried.encounterAttempt, 2)
  assert.equal(retried.encounter.zones.playerSourcePile.length, 26)
  assert.equal(retried.encounter.zones.opponentSourcePile.length, 26)
})

test('scripted rewards add two new player Aces then restore health up to five', () => {
  let run = createCampaignRun({
    runId: 'campaign-rewards',
    seed: 4,
    ruleset: BASELINE_RULESET,
  })
  run = winEncounter(run)
  assert.equal(run.machineState, 'awaitingReward')
  run = claimCampaignReward(run)
  assert.equal(run.encounterIndex, 1)
  assert.deepEqual(
    run.cards
      .filter(({ campaignOwner, cardId }) => (
        campaignOwner === 'player' && ['c-AS', 'c-AC'].includes(cardId)
      ))
      .map(({ cardId }) => cardId),
    ['c-AS', 'c-AC'],
  )
  assert.equal(run.deckLayout.length, 28)

  run = clone(run)
  run.health = 4
  run.stateFingerprint = createCampaignStateFingerprint(run)
  validateCampaignState(run)
  run = winEncounter(run)
  run = claimCampaignReward(run)
  assert.equal(run.encounterIndex, 2)
  assert.equal(run.health, 5)
  assert.equal(run.deckLayout.length, 28)
})

test('campaign validation binds transition states to their encounter outcomes', () => {
  const awaitingReward = clone(winEncounter(createCampaignRun({
    runId: 'campaign-invalid-reward-outcome',
    seed: 4,
    ruleset: BASELINE_RULESET,
  })))
  awaitingReward.encounter.outcome = {
    result: 'win',
    winner: 'opponent',
    reason: 'playerUnableToReveal',
  }
  awaitingReward.pendingEvent = null
  awaitingReward.stateFingerprint = createCampaignStateFingerprint(awaitingReward)
  assert.throws(
    () => validateCampaignState(awaitingReward),
    /awaitingReward requires a player encounter win/,
  )

  const awaitingRetry = clone(loseEncounter(createCampaignRun({
    runId: 'campaign-invalid-retry-outcome',
    seed: 4,
    ruleset: BASELINE_RULESET,
  })))
  awaitingRetry.encounter.outcome = {
    result: 'win',
    winner: 'player',
    reason: 'opponentUnableToReveal',
  }
  awaitingRetry.pendingEvent = null
  awaitingRetry.stateFingerprint = createCampaignStateFingerprint(awaitingRetry)
  assert.throws(
    () => validateCampaignState(awaitingRetry),
    /awaitingRetry requires an opponent win or draw/,
  )
})

test('encounter damage retries while positive and ends at zero health', () => {
  let run = createCampaignRun({
    runId: 'campaign-health',
    seed: 6,
    ruleset: BASELINE_RULESET,
  })
  run = loseEncounter(run)
  assert.equal(run.health, 2)
  assert.equal(run.machineState, 'awaitingRetry')
  run = retryCampaignEncounter(run)
  run = loseEncounter(run)
  assert.equal(run.health, 1)
  run = retryCampaignEncounter(run)
  run = loseEncounter(run)
  assert.equal(run.health, 0)
  assert.equal(run.status, 'ended')
  assert.deepEqual(run.outcome, { result: 'defeat', reason: 'healthDepleted' })
})

test('final encounter deals two damage and the third win completes the campaign', () => {
  let run = createCampaignRun({
    runId: 'campaign-final',
    seed: 7,
    ruleset: NO_BURN_RULESET,
  })
  run = claimCampaignReward(winEncounter(run))
  run = claimCampaignReward(winEncounter(run))
  assert.equal(run.encounterIndex, 2)
  assert.equal(run.encounter.damage, 2)

  const losing = loseEncounter(run)
  assert.equal(losing.health, 2)
  run = retryCampaignEncounter(losing)
  const victory = winEncounter(run)
  assert.equal(victory.status, 'ended')
  assert.deepEqual(victory.outcome, {
    result: 'victory',
    reason: 'campaignCompleted',
  })
})

test('same seed and campaign choices replay exactly', () => {
  let first = createCampaignRun({
    runId: 'campaign-replay',
    seed: 19,
    ruleset: BASELINE_RULESET,
  })
  let second = createCampaignRun({
    runId: 'campaign-replay',
    seed: 19,
    ruleset: BASELINE_RULESET,
  })
  for (let index = 0; index < 20; index += 1) {
    const firstPrepared = prepareCampaignReveal(first)
    const secondPrepared = prepareCampaignReveal(second)
    assert.deepEqual(secondPrepared, firstPrepared)
    first = chooseCampaignReveal(firstPrepared.match, 'normal').match
    second = chooseCampaignReveal(secondPrepared.match, 'normal').match
    assert.deepEqual(second, first)
    if (first.machineState !== 'ready') break
  }
})

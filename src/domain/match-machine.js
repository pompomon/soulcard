import { evaluateBurn } from './burn-evaluator.js'
import { getCard } from './cards.js'
import {
  createClashDrawnEvent,
  createClashSettledEvent,
  validateCommittedEvent,
} from './events.js'
import { assertStableBoundary, assertZoneInvariants } from './invariants.js'
import { createRng, restoreRng, shuffle } from './rng.js'
import { validateRuleset } from './ruleset.js'
import { createInitialZones } from './zones.js'

const SIDES = Object.freeze(['player', 'opponent'])
const STAGES = Object.freeze(['source', 'personal'])
const STABLE_MACHINE_STATES = Object.freeze(['ready', 'ended'])
const DRAW_REASON = 'mutualInability'

function assertPlainObject(value, name) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new TypeError(`${name} must be a plain object`)
  }
}

function assertExactKeys(value, expected, name) {
  const keys = Reflect.ownKeys(value)
  if (
    keys.length !== expected.length ||
    keys.some((key) => typeof key !== 'string' || !expected.includes(key)) ||
    expected.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new TypeError(`${name} must contain only ${expected.join(', ')}`)
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`${name}.${key} must be JSON-compatible data`)
    }
  }
}

function assertRunId(runId) {
  if (typeof runId !== 'string' || runId.length === 0 || runId.trim() !== runId) {
    throw new TypeError('runId must be a nonempty trimmed string')
  }
}

function assertZonesShape(zones) {
  assertPlainObject(zones, 'zones')
  assertExactKeys(
    zones,
    ['sourceDeck', 'player', 'opponent', 'contestedPile', 'burnPile', 'inPlay'],
    'zones',
  )
  for (const side of SIDES) {
    assertPlainObject(zones[side], `zones.${side}`)
    assertExactKeys(zones[side], ['drawPile', 'wonPile'], `zones.${side}`)
  }
}

function assertRngSnapshot(rng) {
  assertPlainObject(rng, 'rng')
  assertExactKeys(rng, ['algorithm', 'seed', 'state'], 'rng')
  restoreRng(rng)
}

function assertOutcome(outcome, machineState, status) {
  if (machineState === 'ready') {
    if (status !== 'active' || outcome !== null) {
      throw new Error('A ready match must be active without a terminal outcome')
    }
    return
  }

  if (status !== 'ended') {
    throw new Error('An ended match must have ended status')
  }
  assertPlainObject(outcome, 'outcome')
  if (outcome.result === 'win') {
    assertExactKeys(outcome, ['result', 'winner', 'reason'], 'outcome')
    if (!SIDES.includes(outcome.winner)) {
      throw new TypeError('outcome.winner must be player or opponent')
    }
    const expectedReason = outcome.winner === 'player'
      ? 'opponentUnableToReveal'
      : 'playerUnableToReveal'
    if (outcome.reason !== expectedReason) {
      throw new TypeError(`outcome.reason must be ${expectedReason}`)
    }
    return
  }
  if (outcome.result === 'draw') {
    assertExactKeys(outcome, ['result', 'reason'], 'outcome')
    if (outcome.reason !== DRAW_REASON) {
      throw new TypeError(`outcome.reason must be ${DRAW_REASON}`)
    }
    return
  }
  throw new TypeError('outcome.result must be win or draw')
}

function assertStageZones(match) {
  const { zones } = match
  if (match.stage === 'source') {
    if (
      zones.sourceDeck.length < 2 ||
      zones.sourceDeck.length % 2 !== 0 ||
      zones.player.drawPile.length !== 0 ||
      zones.opponent.drawPile.length !== 0
    ) {
      throw new Error('A stable source-stage match requires paired source cards and empty draw piles')
    }
  } else if (zones.sourceDeck.length !== 0) {
    throw new Error('A personal-stage match requires an empty source deck')
  }

  if (match.machineState === 'ready' && zones.contestedPile.length !== 0) {
    throw new Error('A ready match cannot retain a contested pile')
  }
  if (match.machineState === 'ended') {
    if (match.stage !== 'personal') {
      throw new Error('A match can end only in the personal stage')
    }
    if (match.outcome.result === 'draw' && zones.contestedPile.length === 0) {
      throw new Error('A drawn match must retain its unresolved contested pile')
    }
    if (match.outcome.result === 'win' && zones.contestedPile.length !== 0) {
      throw new Error('A won match cannot retain a contested pile')
    }
    if (match.outcome.result === 'draw') {
      if (
        SIDES.some(
          (side) => zones[side].drawPile.length !== 0 || zones[side].wonPile.length !== 0,
        )
      ) {
        throw new Error('A drawn match requires both sides to be unable to reveal')
      }
    } else {
      const loser = match.outcome.winner === 'player' ? 'opponent' : 'player'
      if (zones[loser].drawPile.length !== 0 || zones[loser].wonPile.length !== 0) {
        throw new Error('A terminal winner requires the losing side to be unable to reveal')
      }
    }
  }

  if (
    match.machineState === 'ready' &&
    match.stage === 'personal' &&
    SIDES.every(
      (side) => zones[side].drawPile.length === 0 && zones[side].wonPile.length === 0,
    )
  ) {
    throw new Error('A ready personal-stage match requires at least one revealable card')
  }
}

function assertPendingEvent(match) {
  const { pendingEvent } = match
  if (match.machineState === 'ended' && match.turn === 0) {
    throw new Error('An ended match requires a completed terminal clash')
  }
  if (match.turn === 0) {
    if (pendingEvent !== null) {
      throw new Error('A match without completed clashes cannot have a pending event')
    }
    return
  }
  if (pendingEvent === null) {
    throw new Error('A completed clash requires its committed pending event')
  }

  validateCommittedEvent(pendingEvent)
  if (
    pendingEvent.id !== `${match.runId}:clash-${match.turn}` ||
    pendingEvent.turn !== match.turn ||
    pendingEvent.stage !== match.stage
  ) {
    throw new Error('The pending event must describe the latest committed clash')
  }
  if (
    (match.machineState === 'ready' && pendingEvent.type !== 'clashSettled') ||
    (match.machineState === 'ended' &&
      match.outcome.result === 'win' &&
      pendingEvent.type !== 'clashSettled') ||
    (match.machineState === 'ended' &&
      match.outcome.result === 'draw' &&
      pendingEvent.type !== 'clashDrawn')
  ) {
    throw new Error('The pending event must agree with the stable match outcome')
  }
  if (
    match.machineState === 'ended' &&
    match.outcome.result === 'win' &&
    pendingEvent.winner !== match.outcome.winner
  ) {
    throw new Error('The terminal event winner must match the match outcome')
  }
  if (pendingEvent.type === 'clashSettled') {
    const endedByInability = pendingEvent.reveals.length % 2 === 1
    if (
      (match.machineState === 'ended' && !endedByInability) ||
      (match.machineState === 'ready' && endedByInability)
    ) {
      throw new Error('One-sided inability must agree with the terminal machine state')
    }
    for (const { cardId } of pendingEvent.transfers) {
      if (
        !match.zones[pendingEvent.winner].drawPile.includes(cardId) &&
        !match.zones[pendingEvent.winner].wonPile.includes(cardId)
      ) {
        throw new Error('Committed transfers must belong to the event winner')
      }
    }
    for (const cardId of pendingEvent.burned) {
      if (!match.zones.burnPile.includes(cardId)) {
        throw new Error('Committed burns must be present in the burn pile')
      }
    }
  } else if (
    pendingEvent.reason !== match.outcome.reason ||
    pendingEvent.reveals.length !== match.zones.contestedPile.length ||
    pendingEvent.reveals.some(({ cardId, suppliedBy }, index) => (
      match.zones.contestedPile[index].cardId !== cardId ||
      match.zones.contestedPile[index].suppliedBy !== suppliedBy
    ))
  ) {
    throw new Error('The terminal draw event must match the retained contest')
  }
  if (pendingEvent.stateFingerprint !== createStateFingerprint(match, pendingEvent)) {
    throw new Error('The pending event must match the exact post-commit state')
  }
}

function createStateFingerprint(match, event) {
  const outcome = match.outcome === null
    ? null
    : match.outcome.result === 'win'
      ? [match.outcome.result, match.outcome.winner, match.outcome.reason]
      : [match.outcome.result, match.outcome.reason]
  const eventPayload = event.type === 'clashSettled'
    ? [
        event.type,
        event.winner,
        event.reveals.map(({ cardId, suppliedBy }) => [cardId, suppliedBy]),
        event.transfers.map(({ cardId, to }) => [cardId, to]),
        event.burned,
      ]
    : [
        event.type,
        event.reason,
        event.reveals.map(({ cardId, suppliedBy }) => [cardId, suppliedBy]),
      ]
  return JSON.stringify([
    match.runId,
    match.rng.algorithm,
    match.rng.seed,
    match.rng.state,
    match.stage,
    match.machineState,
    match.turn,
    match.status,
    outcome,
    match.zones.sourceDeck,
    match.zones.player.drawPile,
    match.zones.player.wonPile,
    match.zones.opponent.drawPile,
    match.zones.opponent.wonPile,
    match.zones.contestedPile.map(({ cardId, suppliedBy }) => [cardId, suppliedBy]),
    match.zones.burnPile,
    match.zones.inPlay.map(({ cardId, suppliedBy }) => [cardId, suppliedBy]),
    eventPayload,
  ])
}

function assertStableMatch(match) {
  assertStableBoundary(match.zones)
  assertOutcome(match.outcome, match.machineState, match.status)
  assertStageZones(match)
}

function cloneData(value) {
  if (Array.isArray(value)) {
    return value.map(cloneData)
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneData(child)]))
  }
  return value
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) {
      deepFreeze(child)
    }
    Object.freeze(value)
  }
  return value
}

export function validateMatchState(match) {
  assertPlainObject(match, 'match')
  assertExactKeys(match, [
    'runId',
    'ruleset',
    'rng',
    'stage',
    'machineState',
    'turn',
    'status',
    'outcome',
    'zones',
    'pendingEvent',
  ], 'match')
  assertRunId(match.runId)
  validateRuleset(match.ruleset)
  assertRngSnapshot(match.rng)
  if (!STAGES.includes(match.stage)) {
    throw new TypeError('stage must be source or personal')
  }
  if (!STABLE_MACHINE_STATES.includes(match.machineState)) {
    throw new TypeError('machineState must be ready or ended at a public boundary')
  }
  if (!Number.isSafeInteger(match.turn) || match.turn < 0) {
    throw new TypeError('turn must be a nonnegative safe integer')
  }
  if (!['active', 'ended'].includes(match.status)) {
    throw new TypeError('status must be active or ended')
  }
  assertZonesShape(match.zones)
  assertStableMatch(match)
  assertPendingEvent(match)
  return match
}

export function createMatch(options) {
  assertPlainObject(options, 'options')
  assertExactKeys(options, ['runId', 'seed', 'ruleset'], 'options')
  assertRunId(options.runId)
  validateRuleset(options.ruleset)

  const rng = createRng(options.seed)
  const match = {
    runId: options.runId,
    ruleset: cloneData(options.ruleset),
    rng: null,
    stage: 'source',
    machineState: 'ready',
    turn: 0,
    status: 'active',
    outcome: null,
    zones: createInitialZones(rng),
    pendingEvent: null,
  }
  match.rng = rng.snapshot()
  validateMatchState(match)
  return deepFreeze(match)
}

function revealFromPile(zones, pile, suppliedBy) {
  const cardId = pile.shift()
  zones.inPlay.push({ cardId, suppliedBy })
  assertZoneInvariants(zones)
  zones.contestedPile.push(zones.inPlay.shift())
  assertZoneInvariants(zones)
  return cardId
}

function recycleWonPile(zones, side, rng) {
  if (zones[side].drawPile.length !== 0 || zones[side].wonPile.length === 0) {
    return
  }
  const recycled = shuffle(zones[side].wonPile, rng)
  zones[side].wonPile.length = 0
  zones[side].drawPile.push(...recycled)
  assertZoneInvariants(zones)
}

function enterPersonalStage(match, rng) {
  match.machineState = 'stageTransition'
  recycleWonPile(match.zones, 'player', rng)
  recycleWonPile(match.zones, 'opponent', rng)
  match.stage = 'personal'
  match.machineState = 'resolving'
  assertZoneInvariants(match.zones)
}

function revealPersonalCard(match, side, rng) {
  recycleWonPile(match.zones, side, rng)
  if (match.zones[side].drawPile.length === 0) {
    return null
  }
  return revealFromPile(match.zones, match.zones[side].drawPile, side)
}

function assertSettlement(contestedPile, settlement, winner) {
  const transfers = new Map(settlement.transfers.map((transfer) => [transfer.cardId, transfer]))
  const burned = new Set(settlement.burned)
  if (
    transfers.size !== settlement.transfers.length ||
    burned.size !== settlement.burned.length ||
    transfers.size + burned.size !== contestedPile.length
  ) {
    throw new Error('Burn evaluation must settle every contested card exactly once')
  }

  const expectedDestination = `${winner}.wonPile`
  for (const { cardId } of contestedPile) {
    const transfer = transfers.get(cardId)
    if ((!transfer && !burned.has(cardId)) || (transfer && burned.has(cardId))) {
      throw new Error('Burn evaluation must settle every contested card exactly once')
    }
    if (transfer && transfer.to !== expectedDestination) {
      throw new Error(`Burn evaluation transfers must target ${expectedDestination}`)
    }
  }
}

function settleContest(match, winner, rng) {
  const reveals = cloneData(match.zones.contestedPile)
  const settlement = evaluateBurn(match.ruleset, winner, match.zones.contestedPile, rng)
  assertSettlement(match.zones.contestedPile, settlement, winner)
  const transfers = new Map(
    settlement.transfers.map((transfer) => [transfer.cardId, transfer]),
  )
  const burned = new Set(settlement.burned)

  while (match.zones.contestedPile.length > 0) {
    const [{ cardId }] = match.zones.contestedPile.splice(0, 1)
    if (transfers.has(cardId)) {
      match.zones[winner].wonPile.push(cardId)
    } else if (burned.has(cardId)) {
      match.zones.burnPile.push(cardId)
    }
    assertZoneInvariants(match.zones)
  }

  return {
    reveals,
    transfers: cloneData(settlement.transfers),
    burned: cloneData(settlement.burned),
  }
}

function winningOutcome(winner) {
  return {
    result: 'win',
    winner,
    reason: winner === 'player' ? 'opponentUnableToReveal' : 'playerUnableToReveal',
  }
}

function commitSettled(match, rng, winner, settlement, terminal) {
  if (match.stage === 'source' && match.zones.sourceDeck.length === 0) {
    enterPersonalStage(match, rng)
  }
  match.rng = rng.snapshot()
  match.machineState = terminal ? 'ended' : 'ready'
  match.status = terminal ? 'ended' : 'active'
  match.outcome = terminal ? winningOutcome(winner) : null
  assertStableMatch(match)

  const eventData = {
    runId: match.runId,
    turn: match.turn,
    stage: match.stage,
    winner,
    ...settlement,
  }
  const event = createClashSettledEvent({
    ...eventData,
    stateFingerprint: createStateFingerprint(match, {
      type: 'clashSettled',
      ...eventData,
    }),
  })
  match.pendingEvent = event
  validateMatchState(match)
  const committed = deepFreeze(match)
  return Object.freeze({ match: committed, event: committed.pendingEvent })
}

function commitDraw(match, rng) {
  match.rng = rng.snapshot()
  match.machineState = 'ended'
  match.status = 'ended'
  match.outcome = { result: 'draw', reason: DRAW_REASON }
  assertStableMatch(match)

  const eventData = {
    runId: match.runId,
    turn: match.turn,
    stage: match.stage,
    reason: DRAW_REASON,
    reveals: match.zones.contestedPile,
  }
  const event = createClashDrawnEvent({
    ...eventData,
    stateFingerprint: createStateFingerprint(match, {
      type: 'clashDrawn',
      ...eventData,
    }),
  })
  match.pendingEvent = event
  validateMatchState(match)
  const committed = deepFreeze(match)
  return Object.freeze({ match: committed, event: committed.pendingEvent })
}

function resolveSourceRound(match, rng) {
  const playerCard = revealFromPile(match.zones, match.zones.sourceDeck, 'player')
  const opponentCard = revealFromPile(match.zones, match.zones.sourceDeck, 'opponent')
  const comparison = getCard(playerCard).value - getCard(opponentCard).value

  if (comparison === 0) {
    if (match.zones.sourceDeck.length === 0) {
      enterPersonalStage(match, rng)
    }
    return null
  }

  const winner = comparison > 0 ? 'player' : 'opponent'
  return commitSettled(match, rng, winner, settleContest(match, winner, rng), false)
}

function resolvePersonalRound(match, rng) {
  const playerCard = revealPersonalCard(match, 'player', rng)
  const opponentCard = revealPersonalCard(match, 'opponent', rng)

  if (playerCard === null && opponentCard === null) {
    return commitDraw(match, rng)
  }
  if (playerCard === null || opponentCard === null) {
    const winner = playerCard === null ? 'opponent' : 'player'
    return commitSettled(match, rng, winner, settleContest(match, winner, rng), true)
  }

  const comparison = getCard(playerCard).value - getCard(opponentCard).value
  if (comparison === 0) {
    return null
  }
  const winner = comparison > 0 ? 'player' : 'opponent'
  return commitSettled(match, rng, winner, settleContest(match, winner, rng), false)
}

export function revealOrContinue(input) {
  validateMatchState(input)
  if (input.machineState === 'ended') {
    throw new Error('An ended match cannot reveal or continue')
  }

  const match = cloneData(input)
  const rng = restoreRng(match.rng)
  match.machineState = 'resolving'
  match.turn += 1
  match.pendingEvent = null

  while (true) {
    const transition = match.stage === 'source'
      ? resolveSourceRound(match, rng)
      : resolvePersonalRound(match, rng)
    if (transition !== null) {
      return transition
    }
  }
}

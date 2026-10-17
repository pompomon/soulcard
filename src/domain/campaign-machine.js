import { compareCards, isCardId } from './cards.js'
import {
  CAMPAIGN_CARD_COPY_LIMIT,
  CAMPAIGN_DECK_SIZE_LIMITS,
  CAMPAIGN_ENCOUNTERS,
  CAMPAIGN_MEND_HEALTH,
  CAMPAIGN_STARTING_HEALTH,
  getCampaignEncounter,
} from './campaign-content.js'
import {
  CAMPAIGN_EVENT_VERSION,
  createCampaignClashDrawnEvent,
  createCampaignClashSettledEvent,
  validateCampaignEvent,
} from './campaign-events.js'
import {
  assertDistinctModifierHooks,
  contestCardBurns,
  createModifierRecord,
  createStartingModifierRecords,
  expireEncounterModifiers,
  getCampaignModifier,
  hasInformedHoldChoice,
  isCampaignModifierId,
  maximumHealthFor,
  narrowHoldTargets,
} from './campaign-modifiers.js'
import {
  REWARD_HISTORY_KEYS,
  REWARD_KINDS,
  applyRewardToPlayerCards,
  compareCardsForDisplay,
  countCardCopies,
  createStarterPlayerCards,
  generateRewardDraft,
  isRewardTargetEligible,
  playerInstanceId,
  replayRewardHistory,
  rewardCreatesInstance,
  rewardRequiresTarget,
} from './campaign-rewards.js'
import { createRng, restoreRng, shuffle } from './rng.js'
import {
  BASELINE_RULESET,
  NO_BURN_RULESET,
  validateRuleset,
} from './ruleset.js'

export const CAMPAIGN_VERSION = 2
export const CAMPAIGN_GAME_RULES_VERSION = 4
export const HOLD_POSITION = 'holdPosition'
export const CAMPAIGN_HOLD_DECISION_STATES = Object.freeze([
  'awaitingHoldChoice',
  'awaitingInformedHoldChoice',
])

const SIDES = Object.freeze(['player', 'opponent'])
const SUPPLY_MODES = Object.freeze(['source', 'personal'])
const MACHINE_STATES = Object.freeze([
  'ready',
  'awaitingHoldChoice',
  'awaitingInformedHoldChoice',
  'awaitingRetry',
  'awaitingReward',
  'paused',
  'ended',
])
const CARD_OWNERS = Object.freeze(['player', 'opponent'])
const CAMPAIGN_KEYS = Object.freeze([
  'mode',
  'campaignVersion',
  'runId',
  'ruleset',
  'rng',
  'machineState',
  'turn',
  'status',
  'outcome',
  'health',
  'maxHealth',
  'encounterIndex',
  'encounterAttempt',
  'cards',
  'deckLayout',
  'hold',
  'activeModifiers',
  'encounter',
  'holdChoice',
  'pendingReward',
  'rewardHistory',
  'pendingEvent',
  'stateFingerprint',
])
const MODIFIER_RECORD_KEYS = Object.freeze(['id', 'lifetime', 'grantedAtEncounterIndex'])
const REWARD_OFFER_KEYS = Object.freeze(['offerId', 'kind', 'cardId', 'modifierId'])
const PLAIN_HOLD_CHOICE_KEYS = Object.freeze(['from', 'candidate'])
const INFORMED_HOLD_CHOICE_KEYS = Object.freeze([
  'from',
  'candidate',
  'opponentFrom',
  'opponentCandidate',
])
const ENCOUNTER_KEYS = Object.freeze([
  'id',
  'name',
  'damage',
  'supplyMode',
  'zones',
  'outcome',
])
const ZONE_KEYS = Object.freeze([
  'playerSourcePile',
  'opponentSourcePile',
  'player',
  'opponent',
  'contestedPile',
  'burnPile',
  'inPlay',
])

function assertPlainObject(value, name) {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new TypeError(`${name} must be a plain object`)
  }
}

function assertExactKeys(value, expected, name) {
  const keys = Reflect.ownKeys(value)
  if (
    keys.length !== expected.length
    || keys.some((key) => typeof key !== 'string' || !expected.includes(key))
    || expected.some((key) => !Object.hasOwn(value, key))
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

function assertDenseArray(value, name) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${name} must be a dense array`)
  }
  const names = Object.getOwnPropertyNames(value)
  if (
    names.length !== value.length + 1
    || names.at(-1) !== 'length'
    || Object.getOwnPropertySymbols(value).length !== 0
  ) {
    throw new TypeError(`${name} must be a dense array`)
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`${name} must be a dense array`)
    }
  }
}

function assertIdentifier(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${name} must be a nonempty trimmed string`)
  }
}

function cloneData(value) {
  if (Array.isArray(value)) return value.map(cloneData)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, cloneData(child)]),
    )
  }
  return value
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    )
  }
  return value
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function assertFixedData(value, expected, name, source = 'its authored value') {
  if (Array.isArray(expected)) {
    assertDenseArray(value, name)
    if (value.length !== expected.length) {
      throw new Error(`${name} must match ${source}`)
    }
    for (let index = 0; index < expected.length; index += 1) {
      assertFixedData(value[index], expected[index], `${name}[${index}]`, source)
    }
    return
  }
  if (expected !== null && typeof expected === 'object') {
    assertPlainObject(value, name)
    const keys = Object.keys(expected)
    assertExactKeys(value, keys, name)
    for (const key of keys) {
      assertFixedData(value[key], expected[key], `${name}.${key}`, source)
    }
    return
  }
  if (!Object.is(value, expected)) {
    throw new Error(`${name} must match ${source}`)
  }
}

function assertCampaignRuleset(ruleset) {
  validateRuleset(ruleset)
  if (![BASELINE_RULESET.id, NO_BURN_RULESET.id].includes(ruleset.id)) {
    throw new TypeError('Campaign Duel supports only the built-in burn rulesets')
  }
}

function cardMap(run) {
  return new Map(run.cards.map((card) => [card.instanceId, card]))
}

function playerCardRecords(run) {
  return run.cards.filter(({ campaignOwner }) => campaignOwner === 'player')
}

function assertNullableIdentifier(value, name) {
  if (value !== null) assertIdentifier(value, name)
}

function assertRewardHistory(run) {
  assertDenseArray(run.rewardHistory, 'campaign.rewardHistory')
  if (run.rewardHistory.length !== run.encounterIndex) {
    throw new Error('Campaign reward history must record one entry per completed encounter')
  }
  run.rewardHistory.forEach((entry, index) => {
    const name = `campaign.rewardHistory[${index}]`
    assertPlainObject(entry, name)
    assertExactKeys(entry, REWARD_HISTORY_KEYS, name)
    if (!Number.isSafeInteger(entry.encounterIndex)) {
      throw new TypeError(`${name}.encounterIndex must be a safe integer`)
    }
    assertIdentifier(entry.offerId, `${name}.offerId`)
    if (!REWARD_KINDS.includes(entry.kind)) {
      throw new TypeError(`${name}.kind must be a known reward kind`)
    }
    for (const key of ['cardId', 'modifierId', 'targetInstanceId', 'createdInstanceId']) {
      assertNullableIdentifier(entry[key], `${name}.${key}`)
    }
  })
  return replayRewardHistory({
    seed: run.rng.seed,
    ruleset: run.ruleset,
    history: run.rewardHistory,
  })
}

function assertActiveModifiers(run, expected) {
  assertDenseArray(run.activeModifiers, 'campaign.activeModifiers')
  run.activeModifiers.forEach((record, index) => {
    const name = `campaign.activeModifiers[${index}]`
    assertPlainObject(record, name)
    assertExactKeys(record, MODIFIER_RECORD_KEYS, name)
    if (!isCampaignModifierId(record.id)) {
      throw new TypeError(`${name}.id must name a catalogue modifier`)
    }
  })
  assertDistinctModifierHooks(run.activeModifiers)
  assertFixedData(
    run.activeModifiers,
    expected,
    'campaign.activeModifiers',
    'the modifiers implied by reward history',
  )
}

function assertDeckLimits(playerCards) {
  if (
    playerCards.length < CAMPAIGN_DECK_SIZE_LIMITS.minimum
    || playerCards.length > CAMPAIGN_DECK_SIZE_LIMITS.maximum
  ) {
    throw new Error('Campaign deck size must stay within its limits')
  }
  const copies = countCardCopies(playerCards.map(({ cardId }) => cardId))
  if ([...copies.values()].some((count) => count > CAMPAIGN_CARD_COPY_LIMIT)) {
    throw new Error('Campaign deck cannot exceed the copy limit for any card')
  }
}

function assertCardRecords(run, expectedPlayerCards) {
  assertDenseArray(run.cards, 'campaign.cards')
  const instances = new Map()
  for (let index = 0; index < run.cards.length; index += 1) {
    const card = run.cards[index]
    const name = `campaign.cards[${index}]`
    assertPlainObject(card, name)
    assertExactKeys(card, ['instanceId', 'cardId', 'campaignOwner'], name)
    assertIdentifier(card.instanceId, `${name}.instanceId`)
    if (!isCardId(card.cardId)) {
      throw new TypeError(`${name}.cardId must be canonical`)
    }
    if (!CARD_OWNERS.includes(card.campaignOwner)) {
      throw new TypeError(`${name}.campaignOwner must be player or opponent`)
    }
    if (instances.has(card.instanceId)) {
      throw new Error(`Campaign instance ${card.instanceId} is duplicated`)
    }
    instances.set(card.instanceId, card)
  }
  const expected = [
    ...expectedPlayerCards,
    ...createOpponentCards(run.encounterIndex, run.encounterAttempt),
  ]
  if (
    run.cards.length !== expected.length
    || run.cards.some((card, index) => (
      card.instanceId !== expected[index].instanceId
      || card.cardId !== expected[index].cardId
      || card.campaignOwner !== expected[index].campaignOwner
    ))
  ) {
    throw new Error('Campaign card instances must match the authored encounter content and reward history')
  }
  return instances
}

function collectEncounterInstances(run, instances) {
  const zones = run.encounter.zones
  const ordinary = [
    ['playerSourcePile', zones.playerSourcePile],
    ['opponentSourcePile', zones.opponentSourcePile],
    ['player.drawPile', zones.player.drawPile],
    ['player.wonPile', zones.player.wonPile],
    ['opponent.drawPile', zones.opponent.drawPile],
    ['opponent.wonPile', zones.opponent.wonPile],
    ['burnPile', zones.burnPile],
  ]
  const records = [
    ['contestedPile', zones.contestedPile],
    ['inPlay', zones.inPlay],
  ]
  const seen = new Set()
  const add = (instanceId, name) => {
    assertIdentifier(instanceId, name)
    if (!instances.has(instanceId)) {
      throw new Error(`${name} references an unknown campaign instance`)
    }
    if (seen.has(instanceId)) {
      throw new Error(`Campaign instance ${instanceId} occurs in more than one zone`)
    }
    seen.add(instanceId)
  }

  for (const [name, pile] of ordinary) {
    assertDenseArray(pile, `campaign.encounter.zones.${name}`)
    pile.forEach((instanceId, index) => add(
      instanceId,
      `campaign.encounter.zones.${name}[${index}]`,
    ))
  }
  for (const side of SIDES) {
    if (zones[`${side}SourcePile`].some((instanceId) => (
      instances.get(instanceId)?.campaignOwner !== side
    ))) {
      throw new Error('Campaign source piles must contain only matching-provenance instances')
    }
  }
  for (const [name, pile] of records) {
    assertDenseArray(pile, `campaign.encounter.zones.${name}`)
    pile.forEach((record, index) => {
      const recordName = `campaign.encounter.zones.${name}[${index}]`
      assertPlainObject(record, recordName)
      assertExactKeys(record, ['instanceId', 'suppliedBy'], recordName)
      if (!SIDES.includes(record.suppliedBy)) {
        throw new TypeError(`${recordName}.suppliedBy must be player or opponent`)
      }
      add(record.instanceId, `${recordName}.instanceId`)
    })
  }
  if (run.hold !== null) add(run.hold, 'campaign.hold')
  if (seen.size !== instances.size) {
    const missing = [...instances.keys()].filter((instanceId) => !seen.has(instanceId))
    throw new Error(`Every campaign instance must occupy one zone; missing: ${missing.join(', ')}`)
  }
}

function assertDeckLayout(run, instances) {
  assertDenseArray(run.deckLayout, 'campaign.deckLayout')
  const playerIds = [...instances.values()]
    .filter(({ campaignOwner }) => campaignOwner === 'player')
    .map(({ instanceId }) => instanceId)
  if (run.deckLayout.length !== playerIds.length) {
    throw new Error('Campaign layout must retain one position per player instance')
  }
  const tokenCount = run.deckLayout.filter((entry) => entry === HOLD_POSITION).length
  if (tokenCount !== (run.hold === null ? 0 : 1)) {
    throw new Error('Campaign layout must contain one Hold token exactly when Hold is occupied')
  }
  const entries = run.deckLayout.filter((entry) => entry !== HOLD_POSITION)
  const unique = new Set(entries)
  if (unique.size !== entries.length) {
    throw new Error('Campaign layout must not duplicate player instances')
  }
  for (const instanceId of entries) {
    if (instances.get(instanceId)?.campaignOwner !== 'player') {
      throw new Error('Campaign layout can contain only player-provenance instances')
    }
  }
  const expected = new Set(playerIds.filter((instanceId) => instanceId !== run.hold))
  if (
    unique.size !== expected.size
    || [...unique].some((instanceId) => !expected.has(instanceId))
  ) {
    throw new Error('Campaign layout must contain every non-held player instance')
  }
  if (run.hold !== null && instances.get(run.hold)?.campaignOwner !== 'player') {
    throw new Error('Hold can contain only a player-provenance instance')
  }
}

function hasRegularSupply(zones, side) {
  return (
    zones[`${side}SourcePile`].length > 0
    || zones[side].drawPile.length > 0
    || zones[side].wonPile.length > 0
  )
}

function assertEncounterShape(run) {
  const definition = getCampaignEncounter(run.encounterIndex)
  assertPlainObject(run.encounter, 'campaign.encounter')
  assertExactKeys(run.encounter, ENCOUNTER_KEYS, 'campaign.encounter')
  if (
    run.encounter.id !== definition.id
    || run.encounter.name !== definition.name
    || run.encounter.damage !== definition.damage
  ) {
    throw new Error('Campaign encounter metadata must match its authored definition')
  }
  assertPlainObject(run.encounter.supplyMode, 'campaign.encounter.supplyMode')
  assertExactKeys(
    run.encounter.supplyMode,
    ['player', 'opponent'],
    'campaign.encounter.supplyMode',
  )
  for (const side of SIDES) {
    if (!SUPPLY_MODES.includes(run.encounter.supplyMode[side])) {
      throw new TypeError(`campaign.encounter.supplyMode.${side} is invalid`)
    }
  }
  const zones = run.encounter.zones
  assertPlainObject(zones, 'campaign.encounter.zones')
  assertExactKeys(zones, ZONE_KEYS, 'campaign.encounter.zones')
  for (const side of SIDES) {
    assertPlainObject(zones[side], `campaign.encounter.zones.${side}`)
    assertExactKeys(
      zones[side],
      ['drawPile', 'wonPile'],
      `campaign.encounter.zones.${side}`,
    )
  }
  for (const [name, pile] of [
    ['playerSourcePile', zones.playerSourcePile],
    ['opponentSourcePile', zones.opponentSourcePile],
    ['player.drawPile', zones.player.drawPile],
    ['player.wonPile', zones.player.wonPile],
    ['opponent.drawPile', zones.opponent.drawPile],
    ['opponent.wonPile', zones.opponent.wonPile],
    ['contestedPile', zones.contestedPile],
    ['burnPile', zones.burnPile],
    ['inPlay', zones.inPlay],
  ]) {
    assertDenseArray(pile, `campaign.encounter.zones.${name}`)
  }
  for (const side of SIDES) {
    const source = zones[`${side}SourcePile`]
    if (run.encounter.supplyMode[side] === 'personal' && source.length > 0) {
      throw new Error(`Campaign ${side} personal supply mode requires an empty source pile`)
    }
    if (
      run.encounter.supplyMode[side] === 'source'
      && zones[side].drawPile.length > 0
    ) {
      throw new Error(`Campaign ${side} source supply mode requires an empty personal draw pile`)
    }
  }
  if (!run.ruleset.burn.enabled && zones.burnPile.length > 0) {
    throw new Error('A no-burn campaign cannot contain burned cards')
  }
  if (zones.inPlay.length !== 0) {
    throw new Error('Campaign stable boundaries require an empty inPlay zone')
  }
  if (
    ['ready', 'paused', ...CAMPAIGN_HOLD_DECISION_STATES].includes(run.machineState)
    && zones.contestedPile.length !== 0
  ) {
    throw new Error('An active campaign decision boundary cannot retain a contest')
  }
  if (run.encounter.outcome === null) {
    if (['awaitingRetry', 'awaitingReward', 'ended'].includes(run.machineState)) {
      throw new Error('A terminal campaign transition requires an encounter outcome')
    }
    return
  }
  assertPlainObject(run.encounter.outcome, 'campaign.encounter.outcome')
  const resultDescriptor = Object.getOwnPropertyDescriptor(run.encounter.outcome, 'result')
  if (!resultDescriptor?.enumerable || !Object.hasOwn(resultDescriptor, 'value')) {
    throw new TypeError('campaign.encounter.outcome.result must be JSON-compatible data')
  }
  if (resultDescriptor.value === 'win') {
    assertExactKeys(
      run.encounter.outcome,
      ['result', 'winner', 'reason'],
      'campaign.encounter.outcome',
    )
    if (!SIDES.includes(run.encounter.outcome.winner)) {
      throw new TypeError('campaign encounter winner must be player or opponent')
    }
    const expectedReason = run.encounter.outcome.winner === 'player'
      ? 'opponentUnableToReveal'
      : 'playerUnableToReveal'
    if (run.encounter.outcome.reason !== expectedReason) {
      throw new TypeError(`campaign encounter reason must be ${expectedReason}`)
    }
    if (zones.contestedPile.length !== 0) {
      throw new Error('A won campaign encounter cannot retain a contested pile')
    }
    const loser = run.encounter.outcome.winner === 'player' ? 'opponent' : 'player'
    if (hasRegularSupply(zones, loser)) {
      throw new Error('A campaign encounter loser must have no regular supply')
    }
  } else if (resultDescriptor.value === 'draw') {
    assertExactKeys(
      run.encounter.outcome,
      ['result', 'reason'],
      'campaign.encounter.outcome',
    )
    if (run.encounter.outcome.reason !== 'mutualInability') {
      throw new TypeError('campaign draw reason must be mutualInability')
    }
    if (zones.contestedPile.length === 0) {
      throw new Error('A drawn campaign encounter must retain its contest')
    }
    if (SIDES.some((side) => hasRegularSupply(zones, side))) {
      throw new Error('A drawn campaign encounter requires both sides to exhaust regular supply')
    }
  } else {
    throw new TypeError('campaign encounter outcome must be win or draw')
  }
}

function assertPreparedCandidate(run, side, from, candidate) {
  const mode = run.encounter.supplyMode[side]
  const zones = run.encounter.zones
  const label = side === 'player' ? '' : `${side} `
  if (
    (mode === 'source' && zones[`${side}SourcePile`].length === 0)
    || (
      mode === 'personal'
      && zones[side].drawPile.length === 0
      && zones[side].wonPile.length > 0
    )
  ) {
    throw new Error(`A Hold choice requires completed ${side} supply preparation`)
  }
  const expectedPile = mode === 'source' ? zones[`${side}SourcePile`] : zones[side].drawPile
  const expectedFrom = mode === 'source' ? `${side}.sourcePile` : `${side}.drawPile`
  if (from !== expectedFrom) {
    throw new Error(`Hold choice ${label}origin must match the prepared ${side} supply`)
  }
  if (candidate !== (expectedPile[0] ?? null)) {
    throw new Error(`Hold choice ${label}candidate must remain at index zero`)
  }
}

function assertHoldChoice(run) {
  if (!CAMPAIGN_HOLD_DECISION_STATES.includes(run.machineState)) {
    if (run.holdChoice !== null) {
      throw new Error('Hold choice metadata is allowed only while awaiting a choice')
    }
    return
  }
  const informed = run.machineState === 'awaitingInformedHoldChoice'
  if (informed !== hasInformedHoldChoice(run.activeModifiers)) {
    throw new Error(informed
      ? 'An informed Hold choice requires Hold Insight'
      : 'Hold Insight requires the informed Hold choice')
  }
  assertPlainObject(run.holdChoice, 'campaign.holdChoice')
  assertExactKeys(
    run.holdChoice,
    informed ? INFORMED_HOLD_CHOICE_KEYS : PLAIN_HOLD_CHOICE_KEYS,
    'campaign.holdChoice',
  )
  assertPreparedCandidate(run, 'player', run.holdChoice.from, run.holdChoice.candidate)
  if (run.holdChoice.candidate === null && run.hold === null) {
    throw new Error('An empty Hold choice requires an occupied Hold slot')
  }
  if (informed) {
    assertPreparedCandidate(
      run,
      'opponent',
      run.holdChoice.opponentFrom,
      run.holdChoice.opponentCandidate,
    )
  }
}

function eventWithoutFingerprint(event) {
  if (event === null) return null
  return Object.fromEntries(
    Object.entries(event).map(([key, value]) => [
      key,
      key === 'stateFingerprint' ? null : value,
    ]),
  )
}

function fingerprintPayload(run, machineState = run.machineState) {
  const payload = cloneData(run)
  delete payload.stateFingerprint
  payload.machineState = machineState === 'paused' ? 'ready' : machineState
  payload.pendingEvent = eventWithoutFingerprint(payload.pendingEvent)
  return canonicalize(payload)
}

export function createCampaignStateFingerprint(run) {
  return JSON.stringify(fingerprintPayload(run))
}

function refreshFingerprint(run) {
  run.stateFingerprint = createCampaignStateFingerprint(run)
}

function assertPendingEvent(run, instances) {
  const terminalTransition = ['awaitingRetry', 'awaitingReward', 'ended']
    .includes(run.machineState)
  if (run.pendingEvent === null) {
    if (terminalTransition) {
      throw new Error('A terminal campaign transition requires its pending event')
    }
    return
  }
  if (CAMPAIGN_HOLD_DECISION_STATES.includes(run.machineState)) {
    throw new Error('A Hold choice boundary cannot retain a pending event')
  }
  validateCampaignEvent(run.pendingEvent)
  if (
    run.pendingEvent.id !== `${run.runId}:clash-${run.turn}`
    || run.pendingEvent.turn !== run.turn
    || run.pendingEvent.encounterIndex !== run.encounterIndex
    || run.pendingEvent.encounterAttempt !== run.encounterAttempt
  ) {
    throw new Error('Campaign pending event must describe the latest clash')
  }
  const encounterOutcome = run.encounter.outcome
  if (encounterOutcome === null && run.pendingEvent.type === 'clashDrawn') {
    throw new Error('A campaign draw event requires a drawn encounter outcome')
  }
  if (
    encounterOutcome === null
    && run.pendingEvent.type === 'clashSettled'
    && run.pendingEvent.reveals.length % 2 !== 0
  ) {
    throw new Error('A nonterminal campaign event requires complete reveal rounds')
  }
  if (
    encounterOutcome?.result === 'draw'
    && run.pendingEvent.type !== 'clashDrawn'
  ) {
    throw new Error('A drawn campaign encounter requires a draw event')
  }
  if (
    encounterOutcome?.result === 'win'
    && (
      run.pendingEvent.type !== 'clashSettled'
      || run.pendingEvent.winner !== encounterOutcome.winner
      || run.pendingEvent.reveals.length % 2 !== 1
    )
  ) {
    throw new Error('A won campaign encounter requires a matching settled event with terminal inability')
  }
  if (
    encounterOutcome?.result === 'win'
    && encounterOutcome.winner === 'opponent'
    && run.hold !== null
    && run.pendingEvent.reveals.length === 1
  ) {
    throw new Error('A first-round player inability cannot bypass occupied Hold')
  }
  for (const reveal of run.pendingEvent.reveals) {
    if (instances.get(reveal.instanceId)?.cardId !== reveal.cardId) {
      throw new Error('Campaign event card identities must match their instances')
    }
  }
  if (run.pendingEvent.type === 'clashSettled') {
    const winner = run.pendingEvent.winner
    const transfers = run.pendingEvent.transfers.map(({ instanceId }) => instanceId)
    const burned = run.pendingEvent.burned
    const burns = ({ suppliedBy }) => contestCardBurns({
      ruleset: run.ruleset,
      activeModifiers: run.activeModifiers,
      winner,
      suppliedBy,
    })
    const expectedTransfers = run.pendingEvent.reveals
      .filter((reveal) => !burns(reveal))
      .map(({ instanceId }) => instanceId)
    const expectedBurned = run.pendingEvent.reveals
      .filter(burns)
      .map(({ instanceId }) => instanceId)
    if (
      transfers.length !== expectedTransfers.length
      || burned.length !== expectedBurned.length
      || transfers.some((instanceId, index) => expectedTransfers[index] !== instanceId)
      || burned.some((instanceId, index) => expectedBurned[index] !== instanceId)
    ) {
      throw new Error('Campaign event settlement must match the active burn ruleset and modifiers')
    }
    const wonPile = run.encounter.zones[winner].wonPile
    const transferStart = wonPile.length - transfers.length
    if (
      transferStart < 0
      || transfers.some((instanceId, index) => wonPile[transferStart + index] !== instanceId)
    ) {
      throw new Error('Campaign event transfers must be the winner won-pile suffix')
    }
    const burnPile = run.encounter.zones.burnPile
    const burnStart = burnPile.length - burned.length
    if (
      burnStart < 0
      || burned.some((instanceId, index) => burnPile[burnStart + index] !== instanceId)
    ) {
      throw new Error('Campaign event burns must be the burn-pile suffix')
    }
  } else if (
    run.pendingEvent.reveals.length !== run.encounter.zones.contestedPile.length
    || run.pendingEvent.reveals.some((reveal, index) => {
      const contested = run.encounter.zones.contestedPile[index]
      return (
        reveal.instanceId !== contested.instanceId
        || reveal.suppliedBy !== contested.suppliedBy
      )
    })
  ) {
    throw new Error('Campaign draw event must match its retained contest')
  }
  if (run.pendingEvent.stateFingerprint !== run.stateFingerprint) {
    throw new Error('Campaign event and state fingerprints must match')
  }
}

function assertCampaignOutcome(run) {
  if (run.status === 'active') {
    if (run.machineState === 'ended' || run.outcome !== null || run.health <= 0) {
      throw new Error('An active campaign must retain positive health and no outcome')
    }
    return
  }
  if (run.status !== 'ended' || run.machineState !== 'ended') {
    throw new Error('A completed campaign must use ended status and machine state')
  }
  assertPlainObject(run.outcome, 'campaign.outcome')
  assertExactKeys(run.outcome, ['result', 'reason'], 'campaign.outcome')
  if (run.outcome.result === 'victory') {
    if (
      run.outcome.reason !== 'campaignCompleted'
      || run.encounterIndex !== CAMPAIGN_ENCOUNTERS.length - 1
      || run.encounter.outcome?.winner !== 'player'
      || run.health <= 0
    ) {
      throw new Error('Campaign victory must follow the final encounter win with positive health')
    }
  } else if (run.outcome.result === 'defeat') {
    if (run.outcome.reason !== 'healthDepleted' || run.health !== 0) {
      throw new Error('Campaign defeat must follow health depletion')
    }
  } else {
    throw new TypeError('campaign outcome must be victory or defeat')
  }
}

function assertEncounterTransition(run) {
  const outcome = run.encounter.outcome
  const playerWon = outcome?.result === 'win' && outcome.winner === 'player'
  if (['ready', 'paused', ...CAMPAIGN_HOLD_DECISION_STATES].includes(run.machineState)) {
    if (outcome !== null) {
      throw new Error('An active campaign decision boundary cannot have an encounter outcome')
    }
  } else if (run.machineState === 'awaitingReward') {
    if (!playerWon) {
      throw new Error('awaitingReward requires a player encounter win')
    }
    if (run.encounterIndex >= CAMPAIGN_ENCOUNTERS.length - 1) {
      throw new Error('The final campaign encounter cannot open a reward draft')
    }
  } else if (run.machineState === 'awaitingRetry') {
    if (outcome === null || playerWon) {
      throw new Error('awaitingRetry requires an opponent win or draw')
    }
  } else if (
    run.machineState === 'ended'
    && (run.outcome.result === 'victory') !== playerWon
  ) {
    throw new Error('The terminal encounter outcome must match the campaign outcome')
  }
}

function createRewardDraft(run, playerCards, activeModifiers) {
  return generateRewardDraft({
    seed: run.rng.seed,
    encounterIndex: run.encounterIndex,
    playerCardIds: playerCards.map(({ cardId }) => cardId),
    activeModifiers,
    ruleset: run.ruleset,
  })
}

function assertPendingReward(run, replay) {
  if (run.machineState !== 'awaitingReward') {
    if (run.pendingReward !== null) {
      throw new Error('A pending reward is allowed only after an encounter victory')
    }
    return
  }
  assertPlainObject(run.pendingReward, 'campaign.pendingReward')
  assertExactKeys(run.pendingReward, ['encounterIndex', 'offers'], 'campaign.pendingReward')
  assertDenseArray(run.pendingReward.offers, 'campaign.pendingReward.offers')
  run.pendingReward.offers.forEach((offer, index) => {
    const name = `campaign.pendingReward.offers[${index}]`
    assertPlainObject(offer, name)
    assertExactKeys(offer, REWARD_OFFER_KEYS, name)
  })
  assertFixedData(
    run.pendingReward,
    createRewardDraft(run, replay.playerCards, replay.activeModifiers),
    'campaign.pendingReward',
    'the regenerated reward draft',
  )
}

export function isCampaignState(value) {
  if (value === null || typeof value !== 'object') return false
  const descriptor = Object.getOwnPropertyDescriptor(value, 'mode')
  return (
    descriptor?.enumerable === true
    && Object.hasOwn(descriptor, 'value')
    && descriptor.value === 'campaign'
  )
}

export function validateCampaignState(run) {
  assertPlainObject(run, 'campaign')
  assertExactKeys(run, CAMPAIGN_KEYS, 'campaign')
  if (run.mode !== 'campaign' || run.campaignVersion !== CAMPAIGN_VERSION) {
    throw new TypeError('Campaign state has an unsupported mode or version')
  }
  assertIdentifier(run.runId, 'campaign.runId')
  assertCampaignRuleset(run.ruleset)
  assertPlainObject(run.rng, 'campaign.rng')
  assertExactKeys(run.rng, ['algorithm', 'seed', 'state'], 'campaign.rng')
  restoreRng(run.rng)
  if (!MACHINE_STATES.includes(run.machineState)) {
    throw new TypeError('campaign.machineState is not a public stable boundary')
  }
  if (!Number.isSafeInteger(run.turn) || run.turn < 0) {
    throw new TypeError('campaign.turn must be a nonnegative safe integer')
  }
  if (
    !Number.isSafeInteger(run.health)
    || !Number.isSafeInteger(run.maxHealth)
    || run.health < 0
    || run.health > run.maxHealth
  ) {
    throw new TypeError('Campaign health must be an integer within its fixed maximum')
  }
  if (
    !Number.isSafeInteger(run.encounterIndex)
    || run.encounterIndex < 0
    || run.encounterIndex >= CAMPAIGN_ENCOUNTERS.length
    || !Number.isSafeInteger(run.encounterAttempt)
    || run.encounterAttempt < 1
  ) {
    throw new TypeError('Campaign encounter position is invalid')
  }
  const replay = assertRewardHistory(run)
  assertActiveModifiers(run, replay.activeModifiers)
  if (run.maxHealth !== maximumHealthFor(run.activeModifiers)) {
    throw new TypeError('Campaign health must be an integer within its fixed maximum')
  }
  assertDeckLimits(replay.playerCards)
  const instances = assertCardRecords(run, replay.playerCards)
  assertEncounterShape(run)
  collectEncounterInstances(run, instances)
  assertDeckLayout(run, instances)
  assertHoldChoice(run)
  assertPendingReward(run, replay)
  assertCampaignOutcome(run)
  assertEncounterTransition(run)
  assertPendingEvent(run, instances)
  if (typeof run.stateFingerprint !== 'string' || run.stateFingerprint.length === 0) {
    throw new TypeError('campaign.stateFingerprint must be a nonempty string')
  }
  if (run.stateFingerprint !== createCampaignStateFingerprint(run)) {
    throw new Error('Campaign fingerprint must bind the exact stable state')
  }
  return run
}

function createOpponentCards(encounterIndex, encounterAttempt) {
  return getCampaignEncounter(encounterIndex).opponentCardIds.map((cardId, index) => ({
    instanceId: [
      'opponent',
      String(encounterIndex + 1),
      String(encounterAttempt),
      String(index + 1).padStart(3, '0'),
    ].join('-'),
    cardId,
    campaignOwner: 'opponent',
  }))
}

function createEmptyZones(playerSourcePile, opponentSourcePile) {
  return {
    playerSourcePile,
    opponentSourcePile,
    player: { drawPile: [], wonPile: [] },
    opponent: { drawPile: [], wonPile: [] },
    contestedPile: [],
    burnPile: [],
    inPlay: [],
  }
}

function setUpEncounter(run, rng) {
  assertDistinctModifierHooks(run.activeModifiers)
  const definition = getCampaignEncounter(run.encounterIndex)
  const opponentCards = createOpponentCards(run.encounterIndex, run.encounterAttempt)
  run.cards = [
    ...run.cards.filter(({ campaignOwner }) => campaignOwner === 'player'),
    ...opponentCards,
  ]
  const playerInput = run.deckLayout.filter((entry) => entry !== HOLD_POSITION)
  const opponentInput = opponentCards.map(({ instanceId }) => instanceId)
  run.encounter = {
    id: definition.id,
    name: definition.name,
    damage: definition.damage,
    supplyMode: { player: 'source', opponent: 'source' },
    zones: createEmptyZones(
      shuffle(playerInput, rng),
      shuffle(opponentInput, rng),
    ),
    outcome: null,
  }
  run.machineState = 'ready'
  run.status = 'active'
  run.outcome = null
  run.holdChoice = null
  run.pendingReward = null
  run.pendingEvent = null
  run.rng = rng.snapshot()
  refreshFingerprint(run)
}

export function createCampaignRun(options) {
  assertPlainObject(options, 'options')
  assertExactKeys(options, ['runId', 'seed', 'ruleset'], 'options')
  assertIdentifier(options.runId, 'options.runId')
  assertCampaignRuleset(options.ruleset)
  const rng = createRng(options.seed)
  const cards = createStarterPlayerCards()
  const activeModifiers = createStartingModifierRecords()
  const run = {
    mode: 'campaign',
    campaignVersion: CAMPAIGN_VERSION,
    runId: options.runId,
    ruleset: cloneData(options.ruleset),
    rng: rng.snapshot(),
    machineState: 'ready',
    turn: 0,
    status: 'active',
    outcome: null,
    health: CAMPAIGN_STARTING_HEALTH,
    maxHealth: maximumHealthFor(activeModifiers),
    encounterIndex: 0,
    encounterAttempt: 1,
    cards,
    deckLayout: cards.map(({ instanceId }) => instanceId),
    hold: null,
    activeModifiers,
    encounter: null,
    holdChoice: null,
    pendingReward: null,
    rewardHistory: [],
    pendingEvent: null,
    stateFingerprint: 'pending',
  }
  setUpEncounter(run, rng)
  validateCampaignState(run)
  return deepFreeze(run)
}

function sourcePile(zones, side) {
  return zones[`${side}SourcePile`]
}

function prepareSupply(run, side, rng) {
  const { encounter } = run
  const zones = encounter.zones
  if (encounter.supplyMode[side] === 'source') {
    const source = sourcePile(zones, side)
    if (source.length > 0) {
      return { pile: source, from: `${side}.sourcePile`, candidate: source[0] }
    }
    encounter.supplyMode[side] = 'personal'
  }
  const personal = zones[side]
  if (personal.drawPile.length === 0 && personal.wonPile.length > 0) {
    personal.drawPile = shuffle(personal.wonPile, rng)
    personal.wonPile = []
  }
  return {
    pile: personal.drawPile,
    from: `${side}.drawPile`,
    candidate: personal.drawPile[0] ?? null,
  }
}

function revealPrepared(run, prepared, suppliedBy, reveals) {
  if (prepared.candidate === null) return null
  const instanceId = prepared.pile.shift()
  if (instanceId !== prepared.candidate) {
    throw new Error('Prepared campaign candidate changed before reveal')
  }
  const record = { instanceId, suppliedBy }
  run.encounter.zones.inPlay.push(record)
  run.encounter.zones.contestedPile.push(run.encounter.zones.inPlay.shift())
  const card = cardMap(run).get(instanceId)
  reveals.push({
    instanceId,
    cardId: card.cardId,
    suppliedBy,
    from: prepared.from,
  })
  return card.cardId
}

function revealHeld(run, reveals) {
  if (run.hold === null) {
    throw new Error('Hold is empty')
  }
  const tokenIndex = run.deckLayout.indexOf(HOLD_POSITION)
  if (tokenIndex < 0) {
    throw new Error('Occupied Hold requires its campaign layout token')
  }
  const instanceId = run.hold
  run.deckLayout[tokenIndex] = instanceId
  run.hold = null
  const record = { instanceId, suppliedBy: 'player' }
  run.encounter.zones.inPlay.push(record)
  run.encounter.zones.contestedPile.push(run.encounter.zones.inPlay.shift())
  const card = cardMap(run).get(instanceId)
  reveals.push({
    instanceId,
    cardId: card.cardId,
    suppliedBy: 'player',
    from: 'player.hold',
  })
  return card.cardId
}

function settleContest(run, winner, reveals) {
  const transfers = []
  const burned = []
  while (run.encounter.zones.contestedPile.length > 0) {
    const record = run.encounter.zones.contestedPile.shift()
    if (contestCardBurns({
      ruleset: run.ruleset,
      activeModifiers: run.activeModifiers,
      winner,
      suppliedBy: record.suppliedBy,
    })) {
      run.encounter.zones.burnPile.push(record.instanceId)
      burned.push(record.instanceId)
    } else {
      run.encounter.zones[winner].wonPile.push(record.instanceId)
      transfers.push({
        instanceId: record.instanceId,
        to: `${winner}.wonPile`,
      })
    }
  }
  return { reveals: cloneData(reveals), transfers, burned }
}

function encounterWinningOutcome(winner) {
  return {
    result: 'win',
    winner,
    reason: winner === 'player' ? 'opponentUnableToReveal' : 'playerUnableToReveal',
  }
}

function applyTerminalTransition(run, encounterOutcome) {
  run.encounter.outcome = encounterOutcome
  if (encounterOutcome.result === 'win' && encounterOutcome.winner === 'player') {
    if (run.encounterIndex === CAMPAIGN_ENCOUNTERS.length - 1) {
      run.machineState = 'ended'
      run.status = 'ended'
      run.outcome = { result: 'victory', reason: 'campaignCompleted' }
      run.pendingReward = null
    } else {
      run.machineState = 'awaitingReward'
      run.pendingReward = createRewardDraft(run, playerCardRecords(run), run.activeModifiers)
    }
    return
  }

  run.health = Math.max(0, run.health - run.encounter.damage)
  run.pendingReward = null
  if (run.health === 0) {
    run.machineState = 'ended'
    run.status = 'ended'
    run.outcome = { result: 'defeat', reason: 'healthDepleted' }
  } else {
    run.machineState = 'awaitingRetry'
  }
}

function createEventEnvelope(run, type, payload) {
  const common = {
    eventVersion: CAMPAIGN_EVENT_VERSION,
    id: `${run.runId}:clash-${run.turn}`,
    type,
    turn: run.turn,
    encounterIndex: run.encounterIndex,
    encounterAttempt: run.encounterAttempt,
  }
  return type === 'clashSettled'
    ? {
        ...common,
        winner: payload.winner,
        reveals: payload.reveals,
        transfers: payload.transfers,
        burned: payload.burned,
        stateFingerprint: null,
        pendingPresentation: 'settlement-v1',
      }
    : {
        ...common,
        reason: 'mutualInability',
        reveals: payload.reveals,
        stateFingerprint: null,
        pendingPresentation: 'draw-v1',
      }
}

function commitSettled(run, rng, winner, settlement, terminal) {
  run.rng = rng.snapshot()
  run.holdChoice = null
  if (terminal) {
    applyTerminalTransition(run, encounterWinningOutcome(winner))
  } else {
    run.machineState = 'ready'
    run.encounter.outcome = null
  }
  const payload = { winner, ...settlement }
  run.pendingEvent = createEventEnvelope(run, 'clashSettled', payload)
  refreshFingerprint(run)
  run.pendingEvent = createCampaignClashSettledEvent({
    runId: run.runId,
    turn: run.turn,
    encounterIndex: run.encounterIndex,
    encounterAttempt: run.encounterAttempt,
    ...payload,
    stateFingerprint: run.stateFingerprint,
  })
  validateCampaignState(run)
  const committed = deepFreeze(run)
  return Object.freeze({ match: committed, event: committed.pendingEvent })
}

function commitDraw(run, rng, reveals) {
  run.rng = rng.snapshot()
  run.holdChoice = null
  applyTerminalTransition(run, { result: 'draw', reason: 'mutualInability' })
  run.pendingEvent = createEventEnvelope(run, 'clashDrawn', { reveals })
  refreshFingerprint(run)
  run.pendingEvent = createCampaignClashDrawnEvent({
    runId: run.runId,
    turn: run.turn,
    encounterIndex: run.encounterIndex,
    encounterAttempt: run.encounterAttempt,
    reveals: cloneData(reveals),
    stateFingerprint: run.stateFingerprint,
  })
  validateCampaignState(run)
  const committed = deepFreeze(run)
  return Object.freeze({ match: committed, event: committed.pendingEvent })
}

function resolvePreparedClash(run, rng, preparedPlayer, useHold, peekedOpponent = null) {
  const reveals = []
  run.turn += 1
  const playerCard = useHold
    ? revealHeld(run, reveals)
    : revealPrepared(run, preparedPlayer, 'player', reveals)
  const preparedOpponent = peekedOpponent ?? prepareSupply(run, 'opponent', rng)
  const opponentCard = revealPrepared(run, preparedOpponent, 'opponent', reveals)

  if (playerCard === null || opponentCard === null) {
    if (playerCard === null && opponentCard === null) {
      return commitDraw(run, rng, reveals)
    }
    const winner = playerCard === null ? 'opponent' : 'player'
    return commitSettled(run, rng, winner, settleContest(run, winner, reveals), true)
  }

  let comparison = compareCards(playerCard, opponentCard)
  while (comparison === 0) {
    const tiedPlayer = prepareSupply(run, 'player', rng)
    const tiedOpponent = prepareSupply(run, 'opponent', rng)
    const nextPlayer = revealPrepared(run, tiedPlayer, 'player', reveals)
    const nextOpponent = revealPrepared(run, tiedOpponent, 'opponent', reveals)
    if (nextPlayer === null || nextOpponent === null) {
      if (nextPlayer === null && nextOpponent === null) {
        return commitDraw(run, rng, reveals)
      }
      const winner = nextPlayer === null ? 'opponent' : 'player'
      return commitSettled(run, rng, winner, settleContest(run, winner, reveals), true)
    }
    comparison = compareCards(nextPlayer, nextOpponent)
  }

  const winner = comparison > 0 ? 'player' : 'opponent'
  return commitSettled(run, rng, winner, settleContest(run, winner, reveals), false)
}

export function prepareCampaignReveal(input) {
  validateCampaignState(input)
  if (input.machineState !== 'ready') {
    throw new Error('Only a ready campaign can prepare a reveal')
  }
  const run = cloneData(input)
  const rng = restoreRng(run.rng)
  run.pendingEvent = null
  const prepared = prepareSupply(run, 'player', rng)
  if (prepared.candidate === null && run.hold === null) {
    return resolvePreparedClash(run, rng, prepared, false)
  }
  if (hasInformedHoldChoice(run.activeModifiers)) {
    // Same draw order as the plain flow: player preparation, then opponent preparation.
    const preparedOpponent = prepareSupply(run, 'opponent', rng)
    run.machineState = 'awaitingInformedHoldChoice'
    run.holdChoice = {
      from: prepared.from,
      candidate: prepared.candidate,
      opponentFrom: preparedOpponent.from,
      opponentCandidate: preparedOpponent.candidate,
    }
  } else {
    run.machineState = 'awaitingHoldChoice'
    run.holdChoice = {
      from: prepared.from,
      candidate: prepared.candidate,
    }
  }
  run.rng = rng.snapshot()
  refreshFingerprint(run)
  validateCampaignState(run)
  return Object.freeze({ match: deepFreeze(run), event: null })
}

function peekedSupply(run, side, from, candidate) {
  const zones = run.encounter.zones
  const pile = from === `${side}.sourcePile` ? zones[`${side}SourcePile`] : zones[side].drawPile
  if ((pile[0] ?? null) !== candidate) {
    throw new Error('Prepared campaign candidate changed before reveal')
  }
  return { pile, from, candidate }
}

export function chooseCampaignReveal(input, choice) {
  validateCampaignState(input)
  if (!CAMPAIGN_HOLD_DECISION_STATES.includes(input.machineState)) {
    throw new Error('Campaign is not awaiting a Hold choice')
  }
  if (!['normal', 'hold'].includes(choice)) {
    throw new TypeError('Campaign reveal choice must be normal or hold')
  }
  if (choice === 'normal' && input.holdChoice.candidate === null) {
    throw new Error('Normal reveal is unavailable because the prepared pile is empty')
  }
  if (choice === 'hold' && input.hold === null) {
    throw new Error('Hold reveal is unavailable because Hold is empty')
  }

  const run = cloneData(input)
  const rng = restoreRng(run.rng)
  const prepared = peekedSupply(run, 'player', run.holdChoice.from, run.holdChoice.candidate)
  const peekedOpponent = run.machineState === 'awaitingInformedHoldChoice'
    ? peekedSupply(
        run,
        'opponent',
        run.holdChoice.opponentFrom,
        run.holdChoice.opponentCandidate,
      )
    : null
  run.holdChoice = null
  return resolvePreparedClash(run, rng, prepared, choice === 'hold', peekedOpponent)
}

function collectHoldTargets(run) {
  const instances = cardMap(run)
  const targets = []
  for (const zone of ['drawPile', 'wonPile']) {
    run.encounter.zones.player[zone].forEach((instanceId, index) => {
      const card = instances.get(instanceId)
      if (card?.campaignOwner === 'player') {
        targets.push(Object.freeze({
          instanceId,
          cardId: card.cardId,
          zone: `player.${zone}`,
          index,
        }))
      }
    })
  }
  return targets
}

export function getEligibleHoldTargets(input) {
  validateCampaignState(input)
  if (input.machineState !== 'ready') return Object.freeze([])
  const heldCardId = input.hold === null ? null : cardMap(input).get(input.hold).cardId
  return Object.freeze(narrowHoldTargets(
    input.activeModifiers,
    collectHoldTargets(input),
    heldCardId,
  ))
}

export function captureCampaignHold(input, instanceId) {
  validateCampaignState(input)
  assertIdentifier(instanceId, 'instanceId')
  if (input.machineState !== 'ready') {
    throw new Error('Hold capture requires a ready campaign')
  }
  if (!collectHoldTargets(input).some((candidate) => candidate.instanceId === instanceId)) {
    throw new Error('Hold target must be a player-provenance card under current player control')
  }
  const target = getEligibleHoldTargets(input)
    .find((candidate) => candidate.instanceId === instanceId)
  if (target === undefined) {
    throw new Error('Hold target is not eligible under the active Hold modifiers')
  }
  const run = cloneData(input)
  const zoneName = target.zone.slice('player.'.length)
  const pile = run.encounter.zones.player[zoneName]
  const layoutIndex = run.deckLayout.indexOf(instanceId)
  if (layoutIndex < 0) {
    throw new Error('Hold target must occupy its retained campaign layout position')
  }
  if (run.hold === null) {
    pile.splice(target.index, 1)
    run.deckLayout[layoutIndex] = HOLD_POSITION
  } else {
    const displaced = run.hold
    pile[target.index] = displaced
    run.deckLayout[layoutIndex] = displaced
  }
  run.hold = instanceId
  run.pendingEvent = null
  refreshFingerprint(run)
  validateCampaignState(run)
  return deepFreeze(run)
}

function tearDownEncounter(run) {
  validateCampaignState(run)
  run.cards = run.cards.filter(({ campaignOwner }) => campaignOwner === 'player')
  run.encounter = null
  run.holdChoice = null
  run.pendingEvent = null
}

function findPendingOffer(run, offerId) {
  return run.pendingReward.offers.find((offer) => offer.offerId === offerId)
}

function collectRewardTargets(run, offer) {
  if (!rewardRequiresTarget(offer.kind)) return []
  const instances = cardMap(run)
  const copies = countCardCopies(playerCardRecords(run).map(({ cardId }) => cardId))
  return run.deckLayout
    .filter((entry) => entry !== HOLD_POSITION)
    .map((instanceId) => instances.get(instanceId))
    .filter(({ cardId }) => isRewardTargetEligible(offer.kind, cardId, copies))
    .map(({ instanceId, cardId }) => Object.freeze({ instanceId, cardId }))
    .sort(compareCardsForDisplay)
}

// Eligible deck-layout targets for a pending offer, sorted for display. The Hold
// placeholder and the held card are never targets.
export function getCampaignRewardTargets(input, offerId) {
  validateCampaignState(input)
  if (input.machineState !== 'awaitingReward') return Object.freeze([])
  const offer = findPendingOffer(input, offerId)
  if (offer === undefined) {
    throw new Error('Reward offer is not part of the pending draft')
  }
  return Object.freeze(collectRewardTargets(input, offer))
}

function applyRewardToLayout(run, offer, targetInstanceId, createdInstanceId) {
  if (offer.kind === 'add' || offer.kind === 'duplicate') {
    run.deckLayout.push(createdInstanceId)
    return
  }
  if (offer.kind === 'remove' || offer.kind === 'replace') {
    const index = run.deckLayout.indexOf(targetInstanceId)
    if (index < 0) {
      throw new Error('Reward target must occupy its campaign layout position')
    }
    if (offer.kind === 'remove') {
      run.deckLayout.splice(index, 1)
    } else {
      run.deckLayout[index] = createdInstanceId
    }
  }
}

export function selectCampaignReward(input, selection) {
  validateCampaignState(input)
  if (input.machineState !== 'awaitingReward') {
    throw new Error('Campaign has no reward draft to select from')
  }
  assertPlainObject(selection, 'selection')
  assertExactKeys(selection, ['offerId', 'targetInstanceId'], 'selection')
  assertIdentifier(selection.offerId, 'selection.offerId')
  assertNullableIdentifier(selection.targetInstanceId, 'selection.targetInstanceId')
  const offer = findPendingOffer(input, selection.offerId)
  if (offer === undefined) {
    throw new Error('Reward offer is not part of the pending draft')
  }
  if (rewardRequiresTarget(offer.kind)) {
    if (!collectRewardTargets(input, offer).some(({ instanceId }) => (
      instanceId === selection.targetInstanceId
    ))) {
      throw new Error('Reward target must be an eligible card in the campaign deck layout')
    }
  } else if (selection.targetInstanceId !== null) {
    throw new Error('This reward does not take a target')
  }

  const run = cloneData(input)
  const reward = cloneData(offer)
  const { targetInstanceId } = selection
  const createdInstanceId = rewardCreatesInstance(reward.kind)
    ? playerInstanceId(replayRewardHistory({
        seed: run.rng.seed,
        ruleset: run.ruleset,
        history: run.rewardHistory,
      }).issuedCount + 1)
    : null
  tearDownEncounter(run)
  run.activeModifiers = expireEncounterModifiers(run.activeModifiers)
  run.cards = applyRewardToPlayerCards(run.cards, reward, targetInstanceId, createdInstanceId)
  applyRewardToLayout(run, reward, targetInstanceId, createdInstanceId)
  run.rewardHistory.push({
    encounterIndex: run.encounterIndex,
    offerId: reward.offerId,
    kind: reward.kind,
    cardId: reward.cardId,
    modifierId: reward.modifierId,
    targetInstanceId,
    createdInstanceId,
  })
  let restoredHealth = 0
  if (reward.kind === 'modifier') {
    run.activeModifiers.push(createModifierRecord(reward.modifierId, run.encounterIndex))
    assertDistinctModifierHooks(run.activeModifiers)
    restoredHealth = getCampaignModifier(reward.modifierId).healthOnGain
  } else if (reward.kind === 'mend') {
    restoredHealth = CAMPAIGN_MEND_HEALTH
  }
  run.maxHealth = maximumHealthFor(run.activeModifiers)
  run.health = Math.min(run.maxHealth, run.health + restoredHealth)
  run.pendingReward = null
  run.encounterIndex += 1
  run.encounterAttempt = 1
  const rng = restoreRng(run.rng)
  setUpEncounter(run, rng)
  validateCampaignState(run)
  return deepFreeze(run)
}

export function retryCampaignEncounter(input) {
  validateCampaignState(input)
  if (input.machineState !== 'awaitingRetry') {
    throw new Error('Campaign is not awaiting an encounter retry')
  }
  if (!Number.isSafeInteger(input.encounterAttempt + 1)) {
    throw new RangeError('Campaign encounter attempt limit reached')
  }
  const run = cloneData(input)
  tearDownEncounter(run)
  run.encounterAttempt += 1
  const rng = restoreRng(run.rng)
  setUpEncounter(run, rng)
  validateCampaignState(run)
  return deepFreeze(run)
}

export function pauseCampaign(input) {
  validateCampaignState(input)
  if (input.machineState !== 'ready') {
    throw new Error('Only a ready campaign can be paused')
  }
  const run = cloneData(input)
  run.machineState = 'paused'
  validateCampaignState(run)
  return deepFreeze(run)
}

export function resumeCampaign(input) {
  validateCampaignState(input)
  if (input.machineState !== 'paused') {
    throw new Error('Only a paused campaign can be resumed')
  }
  const run = cloneData(input)
  run.machineState = 'ready'
  validateCampaignState(run)
  return deepFreeze(run)
}

export function getCampaignCardId(run, instanceId) {
  validateCampaignState(run)
  return cardMap(run).get(instanceId)?.cardId
}

import { compareCards, isCardId } from './cards.js'
import {
  CAMPAIGN_CARD_COPY_LIMIT,
  CAMPAIGN_DECK_SIZE_LIMITS,
  getCampaignFight,
  getCampaignNodeEvent,
  getCampaignRestSite,
} from './campaign-content.js'
import {
  DECK_EDIT_KINDS,
  applyDeckEditToLayout,
  collectDeckEditTargets,
  countCardCopies,
  deckEditCreatesInstance,
  deckEditRequiresTarget,
  playerInstanceId,
} from './campaign-deck.js'
import {
  assignCampaignEncounterRules,
  getEncounterRule,
  getEncounterStake,
  isEncounterRuleActive,
} from './campaign-encounter-rules.js'
import {
  CAMPAIGN_EVENT_VERSION,
  createCampaignClashDrawnEvent,
  createCampaignClashSettledEvent,
  validateCampaignEvent,
} from './campaign-events.js'
import {
  applyJournalEntry,
  assertCampaignJournalShape,
  replayCampaignJournal,
} from './campaign-journal.js'
import {
  CAMPAIGN_MAP,
  completeRouteNode,
  createInitialRouteNodes,
  getCampaignMapNode,
  isCampaignMapNodeId,
  isFinalCampaignNode,
} from './campaign-map.js'
import {
  assertDistinctModifierHooks,
  contestCardBurns,
  createStartingModifierRecords,
  encounterTraitIds,
  hasInformedHoldChoice,
  isCampaignModifierId,
  isOpponentTraitId,
  maximumHealthFor,
  narrowHoldTargets,
} from './campaign-modifiers.js'
import { eventOptionBlocker } from './campaign-node-events.js'
import { REWARD_OFFER_KEYS, generateRewardDraft } from './campaign-rewards.js'
import { SHOP_ITEM_KEYS, shopItemBlocker } from './campaign-shop.js'
import { createRng, restoreRng, shuffle } from './rng.js'
import {
  BASELINE_RULESET,
  NO_BURN_RULESET,
  validateRuleset,
} from './ruleset.js'

export const CAMPAIGN_VERSION = 5
export const CAMPAIGN_GAME_RULES_VERSION = 8
export const HOLD_POSITION = 'holdPosition'
export const CAMPAIGN_HOLD_DECISION_STATES = Object.freeze([
  'awaitingHoldChoice',
  'awaitingInformedHoldChoice',
])
// Saved boundaries between fights: the route map, an open shop, event, or rest site.
export const CAMPAIGN_NODE_DECISION_STATES = Object.freeze([
  'awaitingRoute',
  'awaitingShop',
  'awaitingEvent',
  'awaitingRest',
])

const SIDES = Object.freeze(['player', 'opponent'])
const SUPPLY_MODES = Object.freeze(['source', 'personal'])
const FIGHT_STATES = Object.freeze([
  'ready',
  'awaitingHoldChoice',
  'awaitingInformedHoldChoice',
  'awaitingRetry',
  'awaitingReward',
  'paused',
  'ended',
])
const MACHINE_STATES = Object.freeze([...FIGHT_STATES, ...CAMPAIGN_NODE_DECISION_STATES])
const STATE_BY_PHASE = Object.freeze({
  route: 'awaitingRoute',
  shop: 'awaitingShop',
  event: 'awaitingEvent',
  rest: 'awaitingRest',
})
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
  'currency',
  'encounterIndex',
  'encounterAttempt',
  'route',
  'encounterRules',
  'cards',
  'deckLayout',
  'hold',
  'activeModifiers',
  'encounter',
  'holdChoice',
  'pendingReward',
  'shop',
  'nodeEvent',
  'restSite',
  'journal',
  'pendingEvent',
  'stateFingerprint',
])
const MODIFIER_RECORD_KEYS = Object.freeze(['id', 'lifetime', 'grantedAtNodeId'])
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
  'tier',
  'damage',
  'traitIds',
  'rule',
  'supplyMode',
  'zones',
  'outcome',
])
const ENCOUNTER_RULE_STATE_KEYS = Object.freeze(['id', 'activeClashes', 'wins'])
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

function assertActiveModifiers(run, expected) {
  assertDenseArray(run.activeModifiers, 'campaign.activeModifiers')
  run.activeModifiers.forEach((record, index) => {
    const name = `campaign.activeModifiers[${index}]`
    assertPlainObject(record, name)
    assertExactKeys(record, MODIFIER_RECORD_KEYS, name)
    if (!isCampaignModifierId(record.id)) {
      throw new TypeError(`${name}.id must name a catalogue modifier`)
    }
    if (isOpponentTraitId(record.id)) {
      throw new TypeError(`${name}.id names an opponent trait, which only an encounter can carry`)
    }
  })
  assertDistinctModifierHooks(run.activeModifiers)
  assertFixedData(
    run.activeModifiers,
    expected,
    'campaign.activeModifiers',
    'the modifiers implied by the journal',
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

function assertCardRecords(run, expectedPlayerCards, fight) {
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
    ...(fight === null
      ? []
      : createOpponentCards(run.encounterIndex, run.encounterAttempt, fight)),
  ]
  if (
    run.cards.length !== expected.length
    || run.cards.some((card, index) => (
      card.instanceId !== expected[index].instanceId
      || card.cardId !== expected[index].cardId
      || card.campaignOwner !== expected[index].campaignOwner
    ))
  ) {
    throw new Error('Campaign card instances must match the authored encounter content and journal')
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

function otherSide(side) {
  return side === 'player' ? 'opponent' : 'player'
}

function hasRegularSupply(zones, side) {
  return (
    zones[`${side}SourcePile`].length > 0
    || zones[side].drawPile.length > 0
    || zones[side].wonPile.length > 0
  )
}

function keepsMoreThanTransfers(zones, side, transfers) {
  return (
    zones[`${side}SourcePile`].length > 0
    || zones[side].drawPile.length > 0
    || zones[side].wonPile.length !== transfers
  )
}

// The rule state of the active fight. Race wins count every active clash; other rules
// count none. Whether a side may sit at the race target depends on the outcome.
function assertEncounterRuleState(run, ruleId) {
  const state = run.encounter.rule
  const name = 'campaign.encounter.rule'
  assertPlainObject(state, name)
  assertExactKeys(state, ENCOUNTER_RULE_STATE_KEYS, name)
  if (state.id !== ruleId) {
    throw new Error(`${name}.id must match the rule assigned to its fight`)
  }
  assertPlainObject(state.wins, `${name}.wins`)
  assertExactKeys(state.wins, SIDES, `${name}.wins`)
  for (const [key, count] of [
    ['activeClashes', state.activeClashes],
    ['wins.player', state.wins.player],
    ['wins.opponent', state.wins.opponent],
  ]) {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new TypeError(`${name}.${key} must be a nonnegative safe integer`)
    }
  }
  if (state.activeClashes > run.turn) {
    throw new Error('A campaign encounter rule cannot count more clashes than were played')
  }
  if (state.activeClashes > 0 && !isEncounterRuleActive(run.encounter)) {
    throw new Error('A campaign encounter rule counts clashes only once it is active')
  }
  const rule = getEncounterRule(run.encounter)
  const wins = state.wins.player + state.wins.opponent
  if (rule.effect === 'race' ? wins !== state.activeClashes : wins !== 0) {
    throw new Error('Only a race counts clash wins, one for each active clash')
  }
  return rule
}

// Only the winner of a race that ended at its target may have reached the target.
function assertRaceTarget(run, rule, raceWinner) {
  if (rule.effect !== 'race') {
    if (raceWinner !== null) {
      throw new Error('Only a race can end a campaign encounter at its target')
    }
    return
  }
  for (const side of SIDES) {
    const wins = run.encounter.rule.wins[side]
    if (side === raceWinner ? wins !== rule.parameter : wins >= rule.parameter) {
      throw new Error('Only the winner of a finished race can reach the race target')
    }
  }
}

function assertEncounterShape(run, definition, ruleId) {
  assertPlainObject(run.encounter, 'campaign.encounter')
  assertExactKeys(run.encounter, ENCOUNTER_KEYS, 'campaign.encounter')
  if (
    run.encounter.id !== definition.id
    || run.encounter.name !== definition.name
    || run.encounter.tier !== definition.tier
    || run.encounter.damage !== definition.damage
  ) {
    throw new Error('Campaign encounter metadata must match its authored definition')
  }
  assertFixedData(
    run.encounter.traitIds,
    encounterTraitIds(definition, run.ruleset),
    'campaign.encounter.traitIds',
    'the traits its fight carries under the ruleset',
  )
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
  const rule = assertEncounterRuleState(run, ruleId)
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
  if (!run.ruleset.burn.enabled && rule.effect !== 'attrition' && zones.burnPile.length > 0) {
    throw new Error('A no-burn campaign cannot contain burned cards outside Attrition')
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
    assertRaceTarget(run, rule, null)
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
    const { winner, reason } = run.encounter.outcome
    if (!SIDES.includes(winner)) {
      throw new TypeError('campaign encounter winner must be player or opponent')
    }
    const inabilityReason = winner === 'player'
      ? 'opponentUnableToReveal'
      : 'playerUnableToReveal'
    if (![inabilityReason, 'raceTargetReached'].includes(reason)) {
      throw new TypeError(
        `campaign encounter reason must be ${inabilityReason} or raceTargetReached`,
      )
    }
    if (zones.contestedPile.length !== 0) {
      throw new Error('A won campaign encounter cannot retain a contested pile')
    }
    // A race can end while its loser still has cards to reveal.
    if (reason === inabilityReason && hasRegularSupply(zones, otherSide(winner))) {
      throw new Error('A campaign encounter loser must have no regular supply')
    }
    assertRaceTarget(run, rule, reason === 'raceTargetReached' ? winner : null)
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
    assertRaceTarget(run, rule, null)
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

// A settled clash with complete reveal rounds was decided by a comparison; one with an odd
// count ended when a side could not reveal. Only a decided clash advances the rule.
function assertPendingRule(run, event) {
  const zones = run.encounter.zones
  const state = run.encounter.rule
  const rule = getEncounterRule(run.encounter)
  const settled = event.type === 'clashSettled'
  const counted = settled
    && event.reveals.length % 2 === 0
    && isEncounterRuleActive(run.encounter)
  const before = state.activeClashes - (counted ? 1 : 0)
  if (before < 0) {
    throw new Error('A clash settled under an active encounter rule must be counted')
  }
  const schedule = rule.effect === 'stakes' && event.reveals.length >= 2
    ? rule.parameter ** before - 1
    : 0
  const [playerStakes, opponentStakes] = SIDES.map((side) => (
    event.stakes.filter(({ suppliedBy }) => suppliedBy === side).length
  ))
  if (playerStakes !== opponentStakes || playerStakes > schedule) {
    throw new Error('Both sides must stake the same count, at most the Double or nothing schedule')
  }
  // Stakes fall short of the schedule only when the shorter side runs out. That side can
  // reveal nothing more; it keeps nothing if it loses, and only the clash's transfers if it
  // wins.
  const ranOut = (side) => !(
    event.reveals.slice(2).some(({ suppliedBy }) => suppliedBy === side)
    || (settled && (
      event.winner === side
        ? keepsMoreThanTransfers(zones, side, event.transfers.length)
        : hasRegularSupply(zones, side)
    ))
  )
  if (playerStakes < schedule && !SIDES.some(ranOut)) {
    throw new Error('Stakes may fall short of the Double or nothing schedule only when a side runs out')
  }
  if (!settled) return
  const attritionDue = counted && rule.effect === 'attrition'
  if (event.attrition.length > 0 && (!attritionDue || run.encounter.outcome !== null)) {
    throw new Error('Only Attrition burns cards, after an active clash that the fight survives')
  }
  if (
    attritionDue
    && event.attrition.length < rule.parameter
    && hasRegularSupply(zones, otherSide(event.winner))
  ) {
    throw new Error('Attrition must burn its full count unless the loser runs out')
  }
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
  const event = run.pendingEvent
  if (event.eventVersion !== CAMPAIGN_EVENT_VERSION) {
    throw new Error(`A campaign pending event must use event version ${CAMPAIGN_EVENT_VERSION}`)
  }
  if (
    event.id !== `${run.runId}:clash-${run.turn}`
    || event.turn !== run.turn
    || event.encounterIndex !== run.encounterIndex
    || event.encounterAttempt !== run.encounterAttempt
  ) {
    throw new Error('Campaign pending event must describe the latest clash')
  }
  const encounterOutcome = run.encounter.outcome
  const decided = event.type === 'clashSettled' && event.reveals.length % 2 === 0
  if (encounterOutcome === null && event.type === 'clashDrawn') {
    throw new Error('A campaign draw event requires a drawn encounter outcome')
  }
  if (encounterOutcome === null && event.type === 'clashSettled' && !decided) {
    throw new Error('A nonterminal campaign event requires complete reveal rounds')
  }
  if (
    encounterOutcome?.result === 'draw'
    && event.type !== 'clashDrawn'
  ) {
    throw new Error('A drawn campaign encounter requires a draw event')
  }
  if (encounterOutcome?.result === 'win') {
    const raceWon = encounterOutcome.reason === 'raceTargetReached'
    if (
      event.type !== 'clashSettled'
      || event.winner !== encounterOutcome.winner
      || decided !== raceWon
    ) {
      throw new Error(raceWon
        ? 'A race win requires a matching settled event with complete reveal rounds'
        : 'A won campaign encounter requires a matching settled event with terminal inability')
    }
  }
  if (
    encounterOutcome?.result === 'win'
    && encounterOutcome.winner === 'opponent'
    && run.hold !== null
    && event.reveals.length === 1
  ) {
    throw new Error('A first-round player inability cannot bypass occupied Hold')
  }
  // Stakes join the contest after the first reveal round and before any tie round.
  const contest = [...event.reveals.slice(0, 2), ...event.stakes, ...event.reveals.slice(2)]
  const attrition = event.type === 'clashSettled' ? event.attrition : []
  for (const record of [...contest, ...attrition]) {
    if (instances.get(record.instanceId)?.cardId !== record.cardId) {
      throw new Error('Campaign event card identities must match their instances')
    }
  }
  assertPendingRule(run, event)
  if (event.type === 'clashSettled') {
    const winner = event.winner
    const transfers = event.transfers.map(({ instanceId }) => instanceId)
    const burned = event.burned
    const burns = ({ suppliedBy }) => contestCardBurns({
      ruleset: run.ruleset,
      activeModifiers: run.activeModifiers,
      traitIds: run.encounter.traitIds,
      winner,
      suppliedBy,
    })
    const expectedTransfers = contest
      .filter((record) => !burns(record))
      .map(({ instanceId }) => instanceId)
    const expectedBurned = contest
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
    const removed = [...burned, ...attrition.map(({ instanceId }) => instanceId)]
    const burnStart = burnPile.length - removed.length
    if (
      burnStart < 0
      || removed.some((instanceId, index) => burnPile[burnStart + index] !== instanceId)
    ) {
      throw new Error('Campaign event burns must be the burn-pile suffix')
    }
  } else if (
    contest.length !== run.encounter.zones.contestedPile.length
    || contest.some((record, index) => {
      const contested = run.encounter.zones.contestedPile[index]
      return (
        record.instanceId !== contested.instanceId
        || record.suppliedBy !== contested.suppliedBy
      )
    })
  ) {
    throw new Error('Campaign draw event must match its retained contest')
  }
  if (event.stateFingerprint !== run.stateFingerprint) {
    throw new Error('Campaign event and state fingerprints must match')
  }
}

function assertCampaignOutcome(run, replay) {
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
      || !isFinalCampaignNode(replay.activeNodeId)
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

function assertEncounterTransition(run, replay) {
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
    if (isFinalCampaignNode(replay.activeNodeId)) {
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
    tier: run.encounter.tier,
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

function assertNoEncounter(run) {
  for (const key of ['encounter', 'holdChoice', 'pendingReward', 'pendingEvent']) {
    if (run[key] !== null) {
      throw new Error(`campaign.${key} must be empty away from a fight`)
    }
  }
  if (run.status !== 'active' || run.outcome !== null) {
    throw new Error('A campaign route boundary must remain active')
  }
}

function expectedRouteNodes(run, replay) {
  const victory = run.status === 'ended' && run.outcome.result === 'victory'
  return victory
    ? completeRouteNode(replay.routeNodes, replay.activeNodeId)
    : replay.routeNodes
}

function assertRoute(run, replay) {
  assertPlainObject(run.route, 'campaign.route')
  assertExactKeys(run.route, ['mapId', 'nodes'], 'campaign.route')
  if (run.route.mapId !== CAMPAIGN_MAP.id) {
    throw new Error('campaign.route.mapId must name the authored campaign map')
  }
  assertFixedData(
    run.route.nodes,
    expectedRouteNodes(run, replay),
    'campaign.route.nodes',
    'the route implied by the journal',
  )
}

function assertShop(run, replay) {
  if (run.machineState !== 'awaitingShop') {
    if (run.shop !== null) {
      throw new Error('Shop stock is allowed only while a shop is open')
    }
    return
  }
  assertPlainObject(run.shop, 'campaign.shop')
  assertExactKeys(run.shop, ['nodeId', 'items'], 'campaign.shop')
  assertDenseArray(run.shop.items, 'campaign.shop.items')
  run.shop.items.forEach((item, index) => {
    const name = `campaign.shop.items[${index}]`
    assertPlainObject(item, name)
    assertExactKeys(item, SHOP_ITEM_KEYS, name)
  })
  assertFixedData(
    run.shop,
    { nodeId: replay.activeNodeId, items: replay.shopItems },
    'campaign.shop',
    'the regenerated shop stock',
  )
}

function assertNodeEvent(run, replay) {
  if (run.machineState !== 'awaitingEvent') {
    if (run.nodeEvent !== null) {
      throw new Error('A node event is allowed only while an event is open')
    }
    return
  }
  assertPlainObject(run.nodeEvent, 'campaign.nodeEvent')
  assertFixedData(
    run.nodeEvent,
    {
      nodeId: replay.activeNodeId,
      eventId: getCampaignMapNode(replay.activeNodeId).contentId,
    },
    'campaign.nodeEvent',
    'the active route node',
  )
}

function assertRestSite(run, replay) {
  if (run.machineState !== 'awaitingRest') {
    if (run.restSite !== null) {
      throw new Error('A rest site is allowed only while a rest site is open')
    }
    return
  }
  assertPlainObject(run.restSite, 'campaign.restSite')
  assertFixedData(
    run.restSite,
    {
      nodeId: replay.activeNodeId,
      siteId: getCampaignMapNode(replay.activeNodeId).contentId,
    },
    'campaign.restSite',
    'the active route node',
  )
}

// A lost or drawn fight costs its damage once; the journal records that loss only when
// the player retries, so a pending retry or a defeat still owes it.
function expectedHealth(run, replay, fight) {
  const outcome = run.encounter?.outcome ?? null
  const pendingLoss = fight !== null
    && outcome !== null
    && !(outcome.result === 'win' && outcome.winner === 'player')
  return pendingLoss ? Math.max(0, replay.health - fight.damage) : replay.health
}

function inspectCampaignState(run) {
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
  const encounterRules = assignCampaignEncounterRules(run.rng.seed)
  assertFixedData(
    run.encounterRules,
    encounterRules,
    'campaign.encounterRules',
    'the rules its seed assigns',
  )
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
  if (!Number.isSafeInteger(run.currency) || run.currency < 0) {
    throw new TypeError('Campaign coins must be a nonnegative safe integer')
  }
  if (
    !Number.isSafeInteger(run.encounterIndex)
    || run.encounterIndex < 0
    || !Number.isSafeInteger(run.encounterAttempt)
    || run.encounterAttempt < 1
  ) {
    throw new TypeError('Campaign encounter position is invalid')
  }
  assertCampaignJournalShape(run.journal)
  const replay = replayCampaignJournal({
    seed: run.rng.seed,
    ruleset: run.ruleset,
    journal: run.journal,
  })
  const expectedState = replay.phase === 'fight' ? null : STATE_BY_PHASE[replay.phase]
  if (
    expectedState === null
      ? !FIGHT_STATES.includes(run.machineState)
      : run.machineState !== expectedState
  ) {
    throw new Error('Campaign machine state must match the route position implied by the journal')
  }
  if (
    run.encounterIndex !== replay.encounterIndex
    || run.encounterAttempt !== replay.encounterAttempt
  ) {
    throw new Error('Campaign encounter position must match the journal')
  }
  if (run.currency !== replay.currency) {
    throw new Error('Campaign coins must match the journal')
  }
  assertActiveModifiers(run, replay.activeModifiers)
  if (run.maxHealth !== maximumHealthFor(run.activeModifiers)) {
    throw new TypeError('Campaign health must be an integer within its fixed maximum')
  }
  assertDeckLimits(replay.playerCards)
  const fight = replay.phase === 'fight'
    ? getCampaignFight(getCampaignMapNode(replay.activeNodeId).contentId)
    : null
  const instances = assertCardRecords(run, replay.playerCards, fight)
  if (fight === null) {
    assertNoEncounter(run)
  } else {
    assertEncounterShape(run, fight, assignedRuleId(encounterRules, replay.activeNodeId))
    collectEncounterInstances(run, instances)
  }
  assertDeckLayout(run, instances)
  assertHoldChoice(run)
  assertPendingReward(run, replay)
  assertShop(run, replay)
  assertNodeEvent(run, replay)
  assertRestSite(run, replay)
  assertCampaignOutcome(run, replay)
  if (fight !== null) assertEncounterTransition(run, replay)
  assertRoute(run, replay)
  if (fight !== null) assertPendingEvent(run, instances)
  if (run.health !== expectedHealth(run, replay, fight)) {
    throw new Error('Campaign health must match the journal and the current fight')
  }
  if (typeof run.stateFingerprint !== 'string' || run.stateFingerprint.length === 0) {
    throw new TypeError('campaign.stateFingerprint must be a nonempty string')
  }
  if (run.stateFingerprint !== createCampaignStateFingerprint(run)) {
    throw new Error('Campaign fingerprint must bind the exact stable state')
  }
  return replay
}

export function validateCampaignState(run) {
  inspectCampaignState(run)
  return run
}

function createOpponentCards(encounterIndex, encounterAttempt, fight) {
  return fight.opponentCardIds.map((cardId, index) => ({
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

function assignedRuleId(encounterRules, nodeId) {
  return encounterRules.find((assignment) => assignment.nodeId === nodeId).ruleId
}

function setUpEncounter(run, rng, nodeId) {
  const fight = getCampaignFight(getCampaignMapNode(nodeId).contentId)
  assertDistinctModifierHooks(run.activeModifiers)
  const opponentCards = createOpponentCards(run.encounterIndex, run.encounterAttempt, fight)
  run.cards = [
    ...run.cards.filter(({ campaignOwner }) => campaignOwner === 'player'),
    ...opponentCards,
  ]
  const playerInput = run.deckLayout.filter((entry) => entry !== HOLD_POSITION)
  const opponentInput = opponentCards.map(({ instanceId }) => instanceId)
  // Tier, traits, and the assigned rule draw nothing, so shuffles are unchanged. A retry
  // starts the rule afresh.
  run.encounter = {
    id: fight.id,
    name: fight.name,
    tier: fight.tier,
    damage: fight.damage,
    traitIds: encounterTraitIds(fight, run.ruleset),
    rule: {
      id: assignedRuleId(run.encounterRules, nodeId),
      activeClashes: 0,
      wins: { player: 0, opponent: 0 },
    },
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

// A new run opens on the route map with only the start node available. Choosing the route
// never draws from the run RNG, so the first fight shuffles exactly as before routes.
// Encounter rules come from their own derived stream, so they draw nothing from it either.
export function createCampaignRun(options) {
  assertPlainObject(options, 'options')
  assertExactKeys(options, ['runId', 'seed', 'ruleset'], 'options')
  assertIdentifier(options.runId, 'options.runId')
  assertCampaignRuleset(options.ruleset)
  const rng = createRng(options.seed)
  const replay = replayCampaignJournal({
    seed: rng.snapshot().seed,
    ruleset: options.ruleset,
    journal: [],
  })
  const activeModifiers = createStartingModifierRecords()
  const run = {
    mode: 'campaign',
    campaignVersion: CAMPAIGN_VERSION,
    runId: options.runId,
    ruleset: cloneData(options.ruleset),
    rng: rng.snapshot(),
    machineState: 'awaitingRoute',
    turn: 0,
    status: 'active',
    outcome: null,
    health: replay.health,
    maxHealth: maximumHealthFor(activeModifiers),
    currency: replay.currency,
    encounterIndex: 0,
    encounterAttempt: 1,
    route: { mapId: CAMPAIGN_MAP.id, nodes: createInitialRouteNodes() },
    encounterRules: cloneData(assignCampaignEncounterRules(rng.snapshot().seed)),
    cards: cloneData(replay.playerCards),
    deckLayout: replay.playerCards.map(({ instanceId }) => instanceId),
    hold: null,
    activeModifiers,
    encounter: null,
    holdChoice: null,
    pendingReward: null,
    shop: null,
    nodeEvent: null,
    restSite: null,
    journal: [],
    pendingEvent: null,
    stateFingerprint: 'pending',
  }
  refreshFingerprint(run)
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

function settleContest(run, winner) {
  const transfers = []
  const burned = []
  while (run.encounter.zones.contestedPile.length > 0) {
    const record = run.encounter.zones.contestedPile.shift()
    if (contestCardBurns({
      ruleset: run.ruleset,
      activeModifiers: run.activeModifiers,
      traitIds: run.encounter.traitIds,
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
  return { transfers, burned }
}

// Attrition burns the loser's next cards through regular supply, never from Hold, and
// skips burn-settlement effects.
function burnAttrition(run, rng, side, count) {
  const instances = cardMap(run)
  const attrition = []
  while (attrition.length < count) {
    const prepared = prepareSupply(run, side, rng)
    if (prepared.candidate === null) break
    const instanceId = prepared.pile.shift()
    run.encounter.zones.burnPile.push(instanceId)
    attrition.push({
      instanceId,
      cardId: instances.get(instanceId).cardId,
      from: prepared.from,
    })
  }
  return attrition
}

function encounterWinningOutcome(winner) {
  return {
    result: 'win',
    winner,
    reason: winner === 'player' ? 'opponentUnableToReveal' : 'playerUnableToReveal',
  }
}

function activeRouteNodeId(run) {
  return run.route.nodes.find(({ state }) => state === 'active')?.id ?? null
}

function applyTerminalTransition(run, encounterOutcome) {
  run.encounter.outcome = encounterOutcome
  if (encounterOutcome.result === 'win' && encounterOutcome.winner === 'player') {
    const nodeId = activeRouteNodeId(run)
    if (isFinalCampaignNode(nodeId)) {
      run.machineState = 'ended'
      run.status = 'ended'
      run.outcome = { result: 'victory', reason: 'campaignCompleted' }
      run.pendingReward = null
      run.route.nodes = completeRouteNode(run.route.nodes, nodeId)
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

// The private envelope and the public event come from one payload, so the fingerprint
// covers every event field.
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
        ...payload,
        stateFingerprint: null,
        pendingPresentation: 'settlement-v1',
      }
    : {
        ...common,
        reason: 'mutualInability',
        ...payload,
        stateFingerprint: null,
        pendingPresentation: 'draw-v1',
      }
}

function commitEvent(run, type, payload) {
  const detached = cloneData(payload)
  run.pendingEvent = createEventEnvelope(run, type, detached)
  refreshFingerprint(run)
  const createEvent = type === 'clashSettled'
    ? createCampaignClashSettledEvent
    : createCampaignClashDrawnEvent
  run.pendingEvent = createEvent({
    runId: run.runId,
    turn: run.turn,
    encounterIndex: run.encounterIndex,
    encounterAttempt: run.encounterAttempt,
    ...detached,
    stateFingerprint: run.stateFingerprint,
  })
  validateCampaignState(run)
  const committed = deepFreeze(run)
  return Object.freeze({ match: committed, event: committed.pendingEvent })
}

function commitSettled(run, rng, payload, encounterOutcome) {
  run.rng = rng.snapshot()
  run.holdChoice = null
  if (encounterOutcome === null) {
    run.machineState = 'ready'
    run.encounter.outcome = null
  } else {
    applyTerminalTransition(run, encounterOutcome)
  }
  return commitEvent(run, 'clashSettled', payload)
}

function commitDraw(run, rng, payload) {
  run.rng = rng.snapshot()
  run.holdChoice = null
  applyTerminalTransition(run, { result: 'draw', reason: 'mutualInability' })
  return commitEvent(run, 'clashDrawn', payload)
}

// A side that cannot reveal loses the fight, taking the contest with it; when neither
// can, the fight is drawn and the contest stays on the table. The rule does not advance.
function concludeInability(run, rng, playerCard, opponentCard, reveals, stakes) {
  if (playerCard === null && opponentCard === null) {
    return commitDraw(run, rng, { reveals, stakes })
  }
  const winner = playerCard === null ? 'opponent' : 'player'
  return commitSettled(
    run,
    rng,
    { winner, reveals, stakes, ...settleContest(run, winner), attrition: [] },
    encounterWinningOutcome(winner),
  )
}

// After the first reveal round, Double or nothing has both sides stake the same count of
// face-down cards, player first.
// A decided clash then advances an active rule: a race win may end the fight at its
// target, and Attrition burns the loser's next cards.
function resolvePreparedClash(run, rng, preparedPlayer, useHold, peekedOpponent = null) {
  const reveals = []
  const stakes = []
  run.turn += 1
  const playerCard = useHold
    ? revealHeld(run, reveals)
    : revealPrepared(run, preparedPlayer, 'player', reveals)
  const preparedOpponent = peekedOpponent ?? prepareSupply(run, 'opponent', rng)
  const opponentCard = revealPrepared(run, preparedOpponent, 'opponent', reveals)

  if (playerCard === null || opponentCard === null) {
    return concludeInability(run, rng, playerCard, opponentCard, reveals, stakes)
  }

  const stake = getEncounterStake(run.encounter)
  for (const side of SIDES) {
    for (let staked = 0; staked < stake; staked += 1) {
      revealPrepared(run, prepareSupply(run, side, rng), side, stakes)
    }
  }

  let comparison = compareCards(playerCard, opponentCard)
  while (comparison === 0) {
    const tiedPlayer = prepareSupply(run, 'player', rng)
    const tiedOpponent = prepareSupply(run, 'opponent', rng)
    const nextPlayer = revealPrepared(run, tiedPlayer, 'player', reveals)
    const nextOpponent = revealPrepared(run, tiedOpponent, 'opponent', reveals)
    if (nextPlayer === null || nextOpponent === null) {
      return concludeInability(run, rng, nextPlayer, nextOpponent, reveals, stakes)
    }
    comparison = compareCards(nextPlayer, nextOpponent)
  }

  const winner = comparison > 0 ? 'player' : 'opponent'
  const settlement = settleContest(run, winner)
  let attrition = []
  let encounterOutcome = null
  if (isEncounterRuleActive(run.encounter)) {
    const rule = getEncounterRule(run.encounter)
    const state = run.encounter.rule
    state.activeClashes += 1
    if (rule.effect === 'race') {
      state.wins[winner] += 1
      if (state.wins[winner] >= rule.parameter) {
        encounterOutcome = { result: 'win', winner, reason: 'raceTargetReached' }
      }
    } else if (rule.effect === 'attrition') {
      attrition = burnAttrition(run, rng, otherSide(winner), rule.parameter)
    }
  }
  return commitSettled(
    run,
    rng,
    { winner, reveals, stakes, ...settlement, attrition },
    encounterOutcome,
  )
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
    { activeModifiers: input.activeModifiers, traitIds: input.encounter.traitIds },
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

function liveDecisionContext(run) {
  const instances = cardMap(run)
  return {
    health: run.health,
    currency: run.currency,
    ruleset: run.ruleset,
    activeModifiers: run.activeModifiers,
    playerCards: playerCardRecords(run),
    targetCandidates: run.deckLayout
      .filter((entry) => entry !== HOLD_POSITION)
      .map((instanceId) => instances.get(instanceId)),
    holdOccupied: run.hold !== null,
  }
}

// Eligible deck-layout targets for a deck edit, sorted for display. The Hold placeholder
// and the held card are never targets; copy limits still count the held card.
function collectLayoutTargets(run, kind) {
  const context = liveDecisionContext(run)
  return collectDeckEditTargets(kind, context.playerCards, context.targetCandidates)
}

function assertDeckEditTarget(run, kind, targetInstanceId, noun) {
  if (deckEditRequiresTarget(kind)) {
    if (!collectLayoutTargets(run, kind).some(({ instanceId }) => (
      instanceId === targetInstanceId
    ))) {
      throw new Error(`${noun} target must be an eligible card in the campaign deck layout`)
    }
  } else if (targetInstanceId !== null) {
    throw new Error(`This ${noun.toLowerCase()} does not take a target`)
  }
}

function createdInstanceFor(replay, kind) {
  return deckEditCreatesInstance(kind) ? playerInstanceId(replay.issuedCount + 1) : null
}

// Node decisions name the node they act on and the journal length at which they were
// offered. A stale step, another node, or a different boundary is refused, so a decision
// replayed after a reload cannot apply twice.
function assertNodeDecision(input, decision, keys) {
  assertPlainObject(decision, 'decision')
  assertExactKeys(decision, keys, 'decision')
  assertIdentifier(decision.nodeId, 'decision.nodeId')
  if (!Number.isSafeInteger(decision.step) || decision.step < 0) {
    throw new TypeError('decision.step must be a nonnegative safe integer')
  }
  for (const key of ['offerId', 'itemId', 'optionId']) {
    if (keys.includes(key)) assertIdentifier(decision[key], `decision.${key}`)
  }
  if (keys.includes('targetInstanceId')) {
    assertNullableIdentifier(decision.targetInstanceId, 'decision.targetInstanceId')
  }
  if (!isCampaignMapNodeId(decision.nodeId)) {
    throw new Error(`Route node ${decision.nodeId} is not part of the campaign map`)
  }
  if (input.machineState !== 'awaitingRoute' && activeRouteNodeId(input) !== decision.nodeId) {
    throw new Error(`Route node ${decision.nodeId} is not the active node`)
  }
  if (decision.step !== input.journal.length) {
    throw new Error(`Campaign decision step ${decision.step} is stale; the journal is at step ${input.journal.length}`)
  }
}

// Applies one journaled decision through the same replay step used for validation, then
// mirrors the replay into the saved boundary. Deck-layout and Hold changes are applied by
// the caller because the journal does not track Hold.
function commitNodeDecision(input, replay, entry, updateLayout = () => {}) {
  const run = cloneData(input)
  applyJournalEntry(replay, entry, run.journal.length)
  run.journal.push(entry)
  updateLayout(run)
  run.cards = cloneData(replay.playerCards)
  run.activeModifiers = cloneData(replay.activeModifiers)
  run.maxHealth = maximumHealthFor(run.activeModifiers)
  run.health = replay.health
  run.currency = replay.currency
  run.encounterIndex = replay.encounterIndex
  run.encounterAttempt = replay.encounterAttempt
  run.route = { mapId: CAMPAIGN_MAP.id, nodes: cloneData(replay.routeNodes) }
  run.encounter = null
  run.holdChoice = null
  run.pendingReward = null
  run.pendingEvent = null
  run.shop = replay.phase === 'shop'
    ? { nodeId: replay.activeNodeId, items: cloneData(replay.shopItems) }
    : null
  run.nodeEvent = replay.phase === 'event'
    ? {
        nodeId: replay.activeNodeId,
        eventId: getCampaignMapNode(replay.activeNodeId).contentId,
      }
    : null
  run.restSite = replay.phase === 'rest'
    ? {
        nodeId: replay.activeNodeId,
        siteId: getCampaignMapNode(replay.activeNodeId).contentId,
      }
    : null
  if (replay.phase === 'fight') {
    setUpEncounter(run, restoreRng(run.rng), replay.activeNodeId)
  } else {
    run.machineState = STATE_BY_PHASE[replay.phase]
    refreshFingerprint(run)
  }
  validateCampaignState(run)
  return deepFreeze(run)
}

export function chooseCampaignRoute(input, decision) {
  const replay = inspectCampaignState(input)
  if (input.machineState !== 'awaitingRoute') {
    throw new Error('Campaign is not on the route map')
  }
  assertNodeDecision(input, decision, ['nodeId', 'step'])
  const state = input.route.nodes.find(({ id }) => id === decision.nodeId).state
  if (state !== 'available') {
    throw new Error(`Route node ${decision.nodeId} is ${state}, not available`)
  }
  return commitNodeDecision(input, replay, { type: 'route', nodeId: decision.nodeId })
}

function findPendingOffer(run, offerId) {
  return run.pendingReward.offers.find((offer) => offer.offerId === offerId)
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
  return Object.freeze(collectLayoutTargets(input, offer.kind))
}

// Every offer of the pending draft with the reason it cannot be chosen now, or null.
export function getCampaignRewardOffers(input) {
  validateCampaignState(input)
  if (input.machineState !== 'awaitingReward') return Object.freeze([])
  return Object.freeze(input.pendingReward.offers.map((offer) => Object.freeze({
    ...offer,
    blocker: deckEditRequiresTarget(offer.kind)
      && collectLayoutTargets(input, offer.kind).length === 0
      ? 'no-eligible-card'
      : null,
  })))
}

// Claiming a reward ends the fight: encounter-lifetime modifiers expire, the reward and
// the fight bounty apply, and the run returns to the route map.
export function selectCampaignReward(input, selection) {
  const replay = inspectCampaignState(input)
  if (input.machineState !== 'awaitingReward') {
    throw new Error('Campaign has no reward draft to select from')
  }
  assertNodeDecision(input, selection, ['nodeId', 'step', 'offerId', 'targetInstanceId'])
  const offer = findPendingOffer(input, selection.offerId)
  if (offer === undefined) {
    throw new Error('Reward offer is not part of the pending draft')
  }
  assertDeckEditTarget(input, offer.kind, selection.targetInstanceId, 'Reward')
  const { targetInstanceId } = selection
  const createdInstanceId = createdInstanceFor(replay, offer.kind)
  return commitNodeDecision(input, replay, {
    type: 'reward',
    nodeId: selection.nodeId,
    offerId: offer.offerId,
    kind: offer.kind,
    cardId: offer.cardId,
    modifierId: offer.modifierId,
    targetInstanceId,
    createdInstanceId,
  }, (run) => {
    if (DECK_EDIT_KINDS.includes(offer.kind)) {
      run.deckLayout = applyDeckEditToLayout(
        run.deckLayout,
        offer,
        targetInstanceId,
        createdInstanceId,
      )
    }
  })
}

function shopItemsWithBlockers(run) {
  const context = liveDecisionContext(run)
  return run.shop.items.map((item) => Object.freeze({
    ...item,
    blocker: shopItemBlocker(item, context),
  }))
}

// Every item of the open shop with the reason it cannot be bought now, or null.
export function getCampaignShopOffers(input) {
  validateCampaignState(input)
  if (input.machineState !== 'awaitingShop') return Object.freeze([])
  return Object.freeze(shopItemsWithBlockers(input))
}

function findShopItem(run, itemId) {
  const item = run.shop.items.find((candidate) => candidate.itemId === itemId)
  if (item === undefined) {
    throw new Error('Shop item is not part of the open shop')
  }
  return item
}

export function getCampaignShopTargets(input, itemId) {
  validateCampaignState(input)
  if (input.machineState !== 'awaitingShop') return Object.freeze([])
  const item = findShopItem(input, itemId)
  if (item.kind === 'modifier') return Object.freeze([])
  return Object.freeze(collectLayoutTargets(input, item.kind))
}

export function purchaseCampaignShopItem(input, decision) {
  const replay = inspectCampaignState(input)
  if (input.machineState !== 'awaitingShop') {
    throw new Error('Campaign is not at a shop')
  }
  assertNodeDecision(input, decision, ['nodeId', 'step', 'itemId', 'targetInstanceId'])
  const item = findShopItem(input, decision.itemId)
  const blocker = shopItemBlocker(item, liveDecisionContext(input))
  if (blocker !== null) {
    throw new Error(`Shop item ${item.itemId} is unavailable: ${blocker}`)
  }
  const deckEdit = item.kind !== 'modifier'
  if (deckEdit) {
    assertDeckEditTarget(input, item.kind, decision.targetInstanceId, 'Shop item')
  } else if (decision.targetInstanceId !== null) {
    throw new Error('This shop item does not take a target')
  }
  const { targetInstanceId } = decision
  const createdInstanceId = deckEdit ? createdInstanceFor(replay, item.kind) : null
  return commitNodeDecision(input, replay, {
    type: 'purchase',
    nodeId: decision.nodeId,
    itemId: item.itemId,
    kind: item.kind,
    cardId: item.cardId,
    modifierId: item.modifierId,
    price: item.price,
    targetInstanceId,
    createdInstanceId,
  }, (run) => {
    if (deckEdit) {
      run.deckLayout = applyDeckEditToLayout(
        run.deckLayout,
        item,
        targetInstanceId,
        createdInstanceId,
      )
    }
  })
}

export function leaveCampaignShop(input, decision) {
  const replay = inspectCampaignState(input)
  if (input.machineState !== 'awaitingShop') {
    throw new Error('Campaign is not at a shop')
  }
  assertNodeDecision(input, decision, ['nodeId', 'step'])
  return commitNodeDecision(input, replay, { type: 'leaveShop', nodeId: decision.nodeId })
}

function nodeOptionsWithBlockers(run, options) {
  const context = liveDecisionContext(run)
  return options.map((option) => {
    const { id, ...effects } = option
    return Object.freeze({
      optionId: id,
      ...effects,
      blocker: eventOptionBlocker(option, context),
    })
  })
}

function findNodeOption(options, optionId, noun, site) {
  const option = options.find((candidate) => candidate.id === optionId)
  if (option === undefined) {
    throw new Error(`${noun} option is not part of the open ${site}`)
  }
  return option
}

function openEventOptions(run) {
  return getCampaignNodeEvent(run.nodeEvent.eventId).options
}

function openRestOptions(run) {
  return getCampaignRestSite(run.restSite.siteId).options
}

// Every option of the open event with the reason it cannot be chosen now, or null.
export function getCampaignEventOptions(input) {
  validateCampaignState(input)
  if (input.machineState !== 'awaitingEvent') return Object.freeze([])
  return Object.freeze(nodeOptionsWithBlockers(input, openEventOptions(input)))
}

// Deck-edit targets for an event option. Surrendering Hold always names the held card.
export function getCampaignEventTargets(input, optionId) {
  validateCampaignState(input)
  if (input.machineState !== 'awaitingEvent') return Object.freeze([])
  const option = findNodeOption(openEventOptions(input), optionId, 'Event', 'event')
  if (option.surrenderHold) {
    if (input.hold === null) return Object.freeze([])
    return Object.freeze([Object.freeze({
      instanceId: input.hold,
      cardId: cardMap(input).get(input.hold).cardId,
    })])
  }
  if (option.deckEdit === null) return Object.freeze([])
  return Object.freeze(collectLayoutTargets(input, option.deckEdit.kind))
}

// Checks a chosen event or rest option against the live boundary, then journals it.
function commitNodeOption(input, replay, decision, option, type, noun) {
  const blocker = eventOptionBlocker(option, liveDecisionContext(input))
  if (blocker !== null) {
    throw new Error(`${noun} option ${option.id} is unavailable: ${blocker}`)
  }
  const { targetInstanceId } = decision
  if (option.surrenderHold) {
    if (targetInstanceId !== input.hold) {
      throw new Error('Surrendering Hold must name the held card')
    }
  } else if (option.deckEdit !== null) {
    assertDeckEditTarget(input, option.deckEdit.kind, targetInstanceId, noun)
  } else if (targetInstanceId !== null) {
    throw new Error(`This ${noun.toLowerCase()} option does not take a target`)
  }
  const createdInstanceId = option.deckEdit === null
    ? null
    : createdInstanceFor(replay, option.deckEdit.kind)
  return commitNodeDecision(input, replay, {
    type,
    nodeId: decision.nodeId,
    optionId: option.id,
    targetInstanceId,
    createdInstanceId,
  }, (run) => {
    if (option.surrenderHold) {
      run.deckLayout = run.deckLayout.filter((entry) => entry !== HOLD_POSITION)
      run.hold = null
    }
    if (option.deckEdit !== null) {
      run.deckLayout = applyDeckEditToLayout(
        run.deckLayout,
        option.deckEdit,
        option.surrenderHold ? null : targetInstanceId,
        createdInstanceId,
      )
    }
  })
}

export function chooseCampaignEventOption(input, decision) {
  const replay = inspectCampaignState(input)
  if (input.machineState !== 'awaitingEvent') {
    throw new Error('Campaign is not at an event')
  }
  assertNodeDecision(input, decision, ['nodeId', 'step', 'optionId', 'targetInstanceId'])
  const option = findNodeOption(openEventOptions(input), decision.optionId, 'Event', 'event')
  return commitNodeOption(input, replay, decision, option, 'event', 'Event')
}

// Every option of the open rest site with the reason it cannot be chosen now, or null.
// Resting is allowed at full health and then changes nothing.
export function getCampaignRestOptions(input) {
  validateCampaignState(input)
  if (input.machineState !== 'awaitingRest') return Object.freeze([])
  return Object.freeze(nodeOptionsWithBlockers(input, openRestOptions(input)))
}

// Deck-edit targets for a rest option, sorted for display. The held card is never one.
export function getCampaignRestTargets(input, optionId) {
  validateCampaignState(input)
  if (input.machineState !== 'awaitingRest') return Object.freeze([])
  const option = findNodeOption(openRestOptions(input), optionId, 'Rest', 'rest site')
  if (option.deckEdit === null) return Object.freeze([])
  return Object.freeze(collectLayoutTargets(input, option.deckEdit.kind))
}

export function chooseCampaignRestOption(input, decision) {
  const replay = inspectCampaignState(input)
  if (input.machineState !== 'awaitingRest') {
    throw new Error('Campaign is not at a rest site')
  }
  assertNodeDecision(input, decision, ['nodeId', 'step', 'optionId', 'targetInstanceId'])
  const option = findNodeOption(openRestOptions(input), decision.optionId, 'Rest', 'rest site')
  return commitNodeOption(input, replay, decision, option, 'rest', 'Rest')
}

// A retry replays the active fight node with fresh setup shuffles. The journal records it
// so replay can account for the health the lost attempt cost. Like the other node
// decisions it names the lost fight node and the journal step it was offered at, so a
// retry replayed after a reload cannot apply twice.
export function retryCampaignEncounter(input, decision) {
  const replay = inspectCampaignState(input)
  if (input.machineState !== 'awaitingRetry') {
    throw new Error('Campaign is not awaiting an encounter retry')
  }
  assertNodeDecision(input, decision, ['nodeId', 'step'])
  if (!Number.isSafeInteger(input.encounterAttempt + 1)) {
    throw new RangeError('Campaign encounter attempt limit reached')
  }
  return commitNodeDecision(input, replay, { type: 'retry', nodeId: decision.nodeId })
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

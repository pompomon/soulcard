import {
  CAMPAIGN_MEND_HEALTH,
  CAMPAIGN_STARTING_HEALTH,
  getCampaignFight,
  getCampaignNodeEvent,
} from './campaign-content.js'
import {
  DECK_EDIT_KINDS,
  applyDeckEditToCards,
  collectDeckEditTargets,
  createStarterPlayerCards,
  deckEditCreatesInstance,
  deckEditRequiresTarget,
  playerInstanceId,
} from './campaign-deck.js'
import {
  completeRouteNode,
  createInitialRouteNodes,
  enterRouteNode,
  getCampaignMapNode,
  getCampaignMapNodeIndex,
  isCampaignMapNodeId,
  isFinalCampaignNode,
} from './campaign-map.js'
import {
  assertDistinctModifierHooks,
  createModifierRecord,
  createStartingModifierRecords,
  expireEncounterModifiers,
  getCampaignModifier,
  maximumHealthFor,
} from './campaign-modifiers.js'
import { eventOptionBlocker } from './campaign-node-events.js'
import { REWARD_KINDS, generateRewardDraft } from './campaign-rewards.js'
import { generateShopStock, shopItemBlocker } from './campaign-shop.js'

// The journal is the ordered log of every run decision. Replaying it from the starter deck
// rebuilds the cards, modifiers, coins, health, route, shop stock, and fight position, and
// rejects any decision that was not legal at its point in the run.
export const JOURNAL_ENTRY_TYPES = Object.freeze([
  'route',
  'retry',
  'reward',
  'purchase',
  'leaveShop',
  'event',
])
export const JOURNAL_ENTRY_KEYS = Object.freeze({
  route: Object.freeze(['type', 'nodeId']),
  retry: Object.freeze(['type', 'nodeId']),
  reward: Object.freeze([
    'type',
    'nodeId',
    'offerId',
    'kind',
    'cardId',
    'modifierId',
    'targetInstanceId',
    'createdInstanceId',
  ]),
  purchase: Object.freeze([
    'type',
    'nodeId',
    'itemId',
    'kind',
    'cardId',
    'modifierId',
    'price',
    'targetInstanceId',
    'createdInstanceId',
  ]),
  leaveShop: Object.freeze(['type', 'nodeId']),
  event: Object.freeze(['type', 'nodeId', 'optionId', 'targetInstanceId', 'createdInstanceId']),
})
export const JOURNAL_PHASES = Object.freeze(['route', 'fight', 'shop', 'event'])

const SHOP_ITEM_KINDS = Object.freeze([...DECK_EDIT_KINDS, 'modifier'])

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

function assertNullableIdentifier(value, name) {
  if (value !== null) assertIdentifier(value, name)
}

export function assertCampaignJournalShape(journal, name = 'campaign.journal') {
  assertDenseArray(journal, name)
  journal.forEach((entry, index) => {
    const entryName = `${name}[${index}]`
    assertPlainObject(entry, entryName)
    const typeDescriptor = Object.getOwnPropertyDescriptor(entry, 'type')
    if (
      !typeDescriptor?.enumerable
      || !Object.hasOwn(typeDescriptor, 'value')
      || !JOURNAL_ENTRY_TYPES.includes(typeDescriptor.value)
    ) {
      throw new TypeError(`${entryName}.type must be a known journal entry type`)
    }
    assertExactKeys(entry, JOURNAL_ENTRY_KEYS[entry.type], entryName)
    assertIdentifier(entry.nodeId, `${entryName}.nodeId`)
    if (entry.type === 'reward') {
      assertIdentifier(entry.offerId, `${entryName}.offerId`)
      if (!REWARD_KINDS.includes(entry.kind)) {
        throw new TypeError(`${entryName}.kind must be a known reward kind`)
      }
    } else if (entry.type === 'purchase') {
      assertIdentifier(entry.itemId, `${entryName}.itemId`)
      if (!SHOP_ITEM_KINDS.includes(entry.kind)) {
        throw new TypeError(`${entryName}.kind must be a known shop item kind`)
      }
      if (!Number.isSafeInteger(entry.price) || entry.price < 0) {
        throw new TypeError(`${entryName}.price must be a nonnegative safe integer`)
      }
    } else if (entry.type === 'event') {
      assertIdentifier(entry.optionId, `${entryName}.optionId`)
    }
    for (const key of ['cardId', 'modifierId', 'targetInstanceId', 'createdInstanceId']) {
      if (Object.hasOwn(entry, key)) assertNullableIdentifier(entry[key], `${entryName}.${key}`)
    }
  })
  return journal
}

export function createJournalReplay({ seed, ruleset }) {
  const playerCards = createStarterPlayerCards()
  return {
    seed,
    ruleset,
    playerCards,
    issuedCount: playerCards.length,
    activeModifiers: createStartingModifierRecords(),
    health: CAMPAIGN_STARTING_HEALTH,
    currency: 0,
    routeNodes: createInitialRouteNodes(),
    phase: 'route',
    activeNodeId: null,
    encounterIndex: 0,
    encounterAttempt: 1,
    shopItems: null,
  }
}

export function playerCardIdsOf(state) {
  return state.playerCards.map(({ cardId }) => cardId)
}

// Hold contents are not journaled, so replay cannot exclude the held card from targets or
// require a surrender to name it. Live decisions check those Hold rules before logging.
function replayContext(state) {
  return {
    health: state.health,
    currency: state.currency,
    ruleset: state.ruleset,
    activeModifiers: state.activeModifiers,
    playerCards: state.playerCards,
    targetCandidates: state.playerCards,
    holdOccupied: null,
  }
}

function heal(state, amount) {
  state.health = Math.min(maximumHealthFor(state.activeModifiers), state.health + amount)
}

function assertNoInstances(entry, label) {
  if (entry.targetInstanceId !== null || entry.createdInstanceId !== null) {
    throw new Error(`${label} must not record a target or created card`)
  }
}

function applyDeckEdit(state, edit, entry, label) {
  if (deckEditRequiresTarget(edit.kind)) {
    const targets = collectDeckEditTargets(edit.kind, state.playerCards, state.playerCards)
    if (!targets.some(({ instanceId }) => instanceId === entry.targetInstanceId)) {
      throw new Error(`${label} must target an eligible player card`)
    }
  } else if (entry.targetInstanceId !== null) {
    throw new Error(`${label} must not record a target`)
  }
  const createdInstanceId = deckEditCreatesInstance(edit.kind)
    ? playerInstanceId(state.issuedCount + 1)
    : null
  if (entry.createdInstanceId !== createdInstanceId) {
    throw new Error(`${label} must record the next player instance ID`)
  }
  if (createdInstanceId !== null) state.issuedCount += 1
  state.playerCards = applyDeckEditToCards(
    state.playerCards,
    edit,
    entry.targetInstanceId,
    createdInstanceId,
  )
}

function gainModifier(state, modifierId, nodeId) {
  state.activeModifiers = [...state.activeModifiers, createModifierRecord(modifierId, nodeId)]
  assertDistinctModifierHooks(state.activeModifiers)
  heal(state, getCampaignModifier(modifierId).healthOnGain)
}

function requireActive(state, node, phase, label) {
  if (state.phase !== phase || state.activeNodeId !== node.id) {
    throw new Error(`${label} must act on the active ${phase} node`)
  }
}

function leaveNode(state, node) {
  state.routeNodes = completeRouteNode(state.routeNodes, node.id)
  state.phase = 'route'
  state.activeNodeId = null
  state.shopItems = null
}

function applyRoute(state, node, label) {
  if (state.phase !== 'route') {
    throw new Error(`${label} chooses a route node away from the route map`)
  }
  if (state.routeNodes.find(({ id }) => id === node.id)?.state !== 'available') {
    throw new Error(`${label} must choose an available route node`)
  }
  state.routeNodes = enterRouteNode(state.routeNodes, node.id)
  state.activeNodeId = node.id
  state.phase = node.kind
  state.encounterAttempt = 1
  if (node.kind === 'shop') {
    state.shopItems = generateShopStock({
      seed: state.seed,
      nodeIndex: getCampaignMapNodeIndex(node.id),
      shopId: node.contentId,
      playerCardIds: playerCardIdsOf(state),
      activeModifiers: state.activeModifiers,
      ruleset: state.ruleset,
    })
  }
}

function applyRetry(state, node, label) {
  requireActive(state, node, 'fight', label)
  const { damage } = getCampaignFight(node.contentId)
  if (state.health - damage <= 0) {
    throw new Error(`${label} retries a fight that ended the run`)
  }
  if (!Number.isSafeInteger(state.encounterAttempt + 1)) {
    throw new RangeError('Campaign encounter attempt limit reached')
  }
  state.health -= damage
  state.encounterAttempt += 1
}

export function regenerateRewardDraft(state) {
  return generateRewardDraft({
    seed: state.seed,
    encounterIndex: state.encounterIndex,
    playerCardIds: playerCardIdsOf(state),
    activeModifiers: state.activeModifiers,
    ruleset: state.ruleset,
  })
}

function applyReward(state, node, entry, label) {
  requireActive(state, node, 'fight', label)
  if (isFinalCampaignNode(node.id)) {
    throw new Error(`${label} claims a reward for the final fight`)
  }
  const offer = regenerateRewardDraft(state).offers
    .find(({ offerId }) => offerId === entry.offerId)
  if (
    offer === undefined
    || offer.kind !== entry.kind
    || offer.cardId !== entry.cardId
    || offer.modifierId !== entry.modifierId
  ) {
    throw new Error(`${label} must match its regenerated reward draft`)
  }
  state.activeModifiers = expireEncounterModifiers(state.activeModifiers)
  if (DECK_EDIT_KINDS.includes(offer.kind)) {
    applyDeckEdit(state, offer, entry, label)
  } else {
    assertNoInstances(entry, label)
    if (offer.kind === 'modifier') {
      gainModifier(state, offer.modifierId, node.id)
    } else {
      heal(state, CAMPAIGN_MEND_HEALTH)
    }
  }
  state.currency += getCampaignFight(node.contentId).bounty
  state.encounterIndex += 1
  state.encounterAttempt = 1
  leaveNode(state, node)
}

function applyPurchase(state, node, entry, label) {
  requireActive(state, node, 'shop', label)
  const item = state.shopItems.find(({ itemId }) => itemId === entry.itemId)
  if (
    item === undefined
    || item.kind !== entry.kind
    || item.cardId !== entry.cardId
    || item.modifierId !== entry.modifierId
    || item.price !== entry.price
  ) {
    throw new Error(`${label} must match its regenerated shop stock`)
  }
  const blocker = shopItemBlocker(item, replayContext(state))
  if (blocker !== null) {
    throw new Error(`${label} buys an unavailable item (${blocker})`)
  }
  state.currency -= item.price
  if (item.kind === 'modifier') {
    assertNoInstances(entry, label)
    gainModifier(state, item.modifierId, node.id)
  } else {
    applyDeckEdit(state, item, entry, label)
  }
  state.shopItems = state.shopItems.map((candidate) => (
    candidate.itemId === item.itemId ? { ...candidate, sold: true } : candidate
  ))
}

function applyLeaveShop(state, node, label) {
  requireActive(state, node, 'shop', label)
  leaveNode(state, node)
}

function applyEvent(state, node, entry, label) {
  requireActive(state, node, 'event', label)
  const option = getCampaignNodeEvent(node.contentId).options
    .find(({ id }) => id === entry.optionId)
  if (option === undefined) {
    throw new Error(`${label} must choose an option of its event`)
  }
  const blocker = eventOptionBlocker(option, replayContext(state))
  if (blocker !== null) {
    throw new Error(`${label} chooses an unavailable event option (${blocker})`)
  }
  state.health -= option.healthCost
  state.currency -= option.coinCost
  if (option.surrenderHold) {
    if (!state.playerCards.some(({ instanceId }) => instanceId === entry.targetInstanceId)) {
      throw new Error(`${label} must surrender a player card`)
    }
    state.playerCards = state.playerCards
      .filter(({ instanceId }) => instanceId !== entry.targetInstanceId)
  }
  if (option.deckEdit !== null) {
    applyDeckEdit(state, option.deckEdit, option.surrenderHold
      ? { ...entry, targetInstanceId: null }
      : entry, label)
  } else if (!option.surrenderHold && entry.targetInstanceId !== null) {
    throw new Error(`${label} must not record a target`)
  }
  if (option.deckEdit === null && entry.createdInstanceId !== null) {
    throw new Error(`${label} must not record a created card`)
  }
  if (option.modifierId !== null) gainModifier(state, option.modifierId, node.id)
  heal(state, option.healthGain)
  state.currency += option.coinGain
  leaveNode(state, node)
}

export function applyJournalEntry(state, entry, index) {
  const label = `Campaign journal entry ${index}`
  if (!isCampaignMapNodeId(entry.nodeId)) {
    throw new Error(`${label} names an unknown route node`)
  }
  const node = getCampaignMapNode(entry.nodeId)
  if (entry.type === 'route') applyRoute(state, node, label)
  else if (entry.type === 'retry') applyRetry(state, node, label)
  else if (entry.type === 'reward') applyReward(state, node, entry, label)
  else if (entry.type === 'purchase') applyPurchase(state, node, entry, label)
  else if (entry.type === 'leaveShop') applyLeaveShop(state, node, label)
  else applyEvent(state, node, entry, label)
  return state
}

export function replayCampaignJournal({ seed, ruleset, journal }) {
  const state = createJournalReplay({ seed, ruleset })
  journal.forEach((entry, index) => applyJournalEntry(state, entry, index))
  return state
}

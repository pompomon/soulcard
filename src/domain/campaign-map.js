import {
  CAMPAIGN_DECK_SIZE_LIMITS,
  CAMPAIGN_FIGHTS,
  CAMPAIGN_NODE_EVENTS,
  CAMPAIGN_SHOP_PRICES,
  CAMPAIGN_SHOP_SLOT_KINDS,
  CAMPAIGN_SHOPS,
  getCampaignFight,
  getCampaignNodeEvent,
  getCampaignShop,
} from './campaign-content.js'
import { DECK_EDIT_KINDS } from './campaign-deck.js'
import { getCampaignModifier, isCampaignModifierId } from './campaign-modifiers.js'
import { isCardId } from './cards.js'

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

export const CAMPAIGN_NODE_KINDS = Object.freeze(['fight', 'shop', 'event'])
export const CAMPAIGN_NODE_STATES = Object.freeze([
  'locked',
  'available',
  'active',
  'completed',
  'bypassed',
])
export const CAMPAIGN_MAP_NODE_LIMIT = 16

const ID_PATTERN = /^[a-z]+(?:-[a-z]+)*$/

// Every route alternates fight, then shop or event, ending at the single final fight.
// Map order is stage order; saved node states follow it exactly.
export const CAMPAIGN_MAP = deepFreeze({
  id: 'expedition-v1',
  nodes: [
    { id: 'gate', stage: 1, kind: 'fight', contentId: 'suit-opposition', next: ['market', 'shrine'] },
    { id: 'market', stage: 2, kind: 'shop', contentId: 'wayside-market', next: ['court', 'watch'] },
    { id: 'shrine', stage: 2, kind: 'event', contentId: 'crossroads-shrine', next: ['court', 'watch'] },
    { id: 'court', stage: 3, kind: 'fight', contentId: 'royal-court', next: ['bazaar', 'vault'] },
    { id: 'watch', stage: 3, kind: 'fight', contentId: 'watch-of-tens', next: ['bazaar', 'vault'] },
    { id: 'bazaar', stage: 4, kind: 'shop', contentId: 'ember-bazaar', next: ['finale'] },
    { id: 'vault', stage: 4, kind: 'event', contentId: 'oathkeepers-vault', next: ['finale'] },
    { id: 'finale', stage: 5, kind: 'fight', contentId: 'ace-assembly', next: [] },
  ],
})

function contentFor(kind, contentId) {
  if (kind === 'fight') return getCampaignFight(contentId)
  if (kind === 'shop') return getCampaignShop(contentId)
  return getCampaignNodeEvent(contentId)
}

function assertNonnegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a nonnegative safe integer`)
  }
}

function validateFights(fights) {
  const ids = new Set()
  for (const fight of fights) {
    if (!ID_PATTERN.test(fight.id) || ids.has(fight.id)) {
      throw new TypeError('Campaign fights need unique lowercase IDs')
    }
    ids.add(fight.id)
    if (
      typeof fight.name !== 'string'
      || fight.name.length === 0
      || !Array.isArray(fight.opponentCardIds)
      || fight.opponentCardIds.length === 0
      || !fight.opponentCardIds.every(isCardId)
      || new Set(fight.opponentCardIds).size !== fight.opponentCardIds.length
      || !Number.isSafeInteger(fight.damage)
      || fight.damage < 1
    ) {
      throw new TypeError(`Campaign fight ${fight.id} is malformed`)
    }
    assertNonnegativeInteger(fight.bounty, `Campaign fight ${fight.id} bounty`)
  }
}

function validateShops(shops) {
  const ids = new Set()
  for (const kind of CAMPAIGN_SHOP_SLOT_KINDS) {
    if (!Number.isSafeInteger(CAMPAIGN_SHOP_PRICES[kind]) || CAMPAIGN_SHOP_PRICES[kind] < 1) {
      throw new TypeError(`Campaign shop price for ${kind} must be a positive integer`)
    }
  }
  for (const shop of shops) {
    if (!ID_PATTERN.test(shop.id) || ids.has(shop.id)) {
      throw new TypeError('Campaign shops need unique lowercase IDs')
    }
    ids.add(shop.id)
    if (
      typeof shop.name !== 'string'
      || shop.name.length === 0
      || !Array.isArray(shop.slots)
      || shop.slots.length === 0
      || !shop.slots.every((slot) => CAMPAIGN_SHOP_SLOT_KINDS.includes(slot))
    ) {
      throw new TypeError(`Campaign shop ${shop.id} is malformed`)
    }
  }
}

function validateEventOption(event, option) {
  const name = `Campaign event ${event.id} option ${option.id}`
  if (!ID_PATTERN.test(option.id) || typeof option.label !== 'string' || option.label.length === 0) {
    throw new TypeError(`${name} needs an ID and label`)
  }
  for (const key of ['healthCost', 'coinCost', 'healthGain', 'coinGain']) {
    assertNonnegativeInteger(option[key], `${name} ${key}`)
  }
  if (typeof option.surrenderHold !== 'boolean') {
    throw new TypeError(`${name} must declare whether it surrenders Hold`)
  }
  if (option.deckEdit !== null) {
    if (
      !DECK_EDIT_KINDS.includes(option.deckEdit.kind)
      || (['add', 'replace'].includes(option.deckEdit.kind)
        ? !isCardId(option.deckEdit.cardId)
        : option.deckEdit.cardId !== null)
    ) {
      throw new TypeError(`${name} has a malformed deck edit`)
    }
    if (option.surrenderHold && option.deckEdit.kind !== 'add') {
      throw new TypeError(`${name} cannot target two cards`)
    }
  }
  if (option.modifierId !== null) {
    if (!isCampaignModifierId(option.modifierId) || !getCampaignModifier(option.modifierId).draftable) {
      throw new TypeError(`${name} must grant a draftable catalogue modifier`)
    }
  }
}

function validateEvents(events) {
  const ids = new Set()
  for (const event of events) {
    if (!ID_PATTERN.test(event.id) || ids.has(event.id)) {
      throw new TypeError('Campaign events need unique lowercase IDs')
    }
    ids.add(event.id)
    if (
      typeof event.name !== 'string'
      || event.name.length === 0
      || !Array.isArray(event.options)
      || event.options.length === 0
    ) {
      throw new TypeError(`Campaign event ${event.id} is malformed`)
    }
    const optionIds = new Set()
    for (const option of event.options) {
      validateEventOption(event, option)
      if (optionIds.has(option.id)) {
        throw new TypeError(`Campaign event ${event.id} repeats option ${option.id}`)
      }
      optionIds.add(option.id)
    }
    const walkOn = event.options.at(-1)
    if (
      walkOn.healthCost !== 0
      || walkOn.coinCost !== 0
      || walkOn.surrenderHold
      || walkOn.deckEdit !== null
      || walkOn.modifierId !== null
      || walkOn.healthGain !== 0
      || walkOn.coinGain !== 0
    ) {
      throw new TypeError(`Campaign event ${event.id} must end with an effect-free option`)
    }
  }
}

function reachable(nodeById, startId) {
  const seen = new Set()
  const pending = [startId]
  while (pending.length > 0) {
    const id = pending.pop()
    if (seen.has(id)) continue
    seen.add(id)
    pending.push(...nodeById.get(id).next)
  }
  return seen
}

export function validateCampaignMap(map) {
  if (typeof map?.id !== 'string' || !/^[a-z]+(?:-[a-z0-9]+)*$/.test(map.id)) {
    throw new TypeError('Campaign map needs a lowercase versioned ID')
  }
  const { nodes } = map
  if (!Array.isArray(nodes) || nodes.length === 0 || nodes.length > CAMPAIGN_MAP_NODE_LIMIT) {
    throw new RangeError(`Campaign map must contain 1 to ${CAMPAIGN_MAP_NODE_LIMIT} nodes`)
  }
  const nodeById = new Map()
  let previousStage = 0
  for (const node of nodes) {
    if (typeof node?.id !== 'string' || !ID_PATTERN.test(node.id) || nodeById.has(node.id)) {
      throw new TypeError('Campaign map nodes need unique lowercase IDs')
    }
    if (!Number.isSafeInteger(node.stage) || node.stage < previousStage || node.stage < 1) {
      throw new TypeError('Campaign map nodes must be listed in stage order')
    }
    previousStage = node.stage
    if (!CAMPAIGN_NODE_KINDS.includes(node.kind)) {
      throw new TypeError(`Campaign map node ${node.id} has an unknown kind`)
    }
    contentFor(node.kind, node.contentId)
    if (!Array.isArray(node.next) || new Set(node.next).size !== node.next.length) {
      throw new TypeError(`Campaign map node ${node.id} needs unique links`)
    }
    nodeById.set(node.id, node)
  }
  for (const node of nodes) {
    for (const id of node.next) {
      if (!nodeById.has(id) || nodeById.get(id).stage <= node.stage) {
        throw new Error(`Campaign map node ${node.id} may link only to later stages`)
      }
    }
  }
  const linked = new Set(nodes.flatMap((node) => node.next))
  const starts = nodes.filter((node) => !linked.has(node.id))
  if (starts.length !== 1 || starts[0] !== nodes[0]) {
    throw new Error('Campaign map needs exactly one start node, listed first')
  }
  const finals = nodes.filter((node) => node.next.length === 0)
  if (finals.length !== 1 || finals[0] !== nodes.at(-1) || finals[0].kind !== 'fight') {
    throw new Error('Campaign map needs exactly one final fight, listed last')
  }
  if (reachable(nodeById, nodes[0].id).size !== nodes.length) {
    throw new Error('Every campaign map node must be reachable from the start')
  }
  for (const node of nodes) {
    if (!reachable(nodeById, node.id).has(finals[0].id)) {
      throw new Error(`Campaign map node ${node.id} must reach the final fight`)
    }
    if (node.kind === 'event') {
      const gainsCoins = getCampaignNodeEvent(node.contentId).options
        .some((option) => option.coinGain > 0)
      const shopAhead = [...reachable(nodeById, node.id)]
        .some((id) => id !== node.id && nodeById.get(id).kind === 'shop')
      if (gainsCoins && !shopAhead) {
        throw new Error(`Campaign event node ${node.id} cannot grant coins without a later shop`)
      }
    }
  }
  return map
}

export function validateCampaignContent() {
  validateFights(CAMPAIGN_FIGHTS)
  validateShops(CAMPAIGN_SHOPS)
  validateEvents(CAMPAIGN_NODE_EVENTS)
  if (CAMPAIGN_DECK_SIZE_LIMITS.minimum >= CAMPAIGN_DECK_SIZE_LIMITS.maximum) {
    throw new RangeError('Campaign deck limits must leave room to edit the deck')
  }
  return validateCampaignMap(CAMPAIGN_MAP)
}

validateCampaignContent()

const NODE_BY_ID = new Map(CAMPAIGN_MAP.nodes.map((node) => [node.id, node]))
const NODE_INDEX = new Map(CAMPAIGN_MAP.nodes.map((node, index) => [node.id, index]))
const REACHABLE = new Map(CAMPAIGN_MAP.nodes.map((node) => [
  node.id,
  reachable(NODE_BY_ID, node.id),
]))

export const CAMPAIGN_START_NODE_ID = CAMPAIGN_MAP.nodes[0].id
export const CAMPAIGN_FINAL_NODE_ID = CAMPAIGN_MAP.nodes.at(-1).id
export const CAMPAIGN_STAGE_COUNT = CAMPAIGN_MAP.nodes.at(-1).stage

export function isCampaignMapNodeId(id) {
  return typeof id === 'string' && NODE_BY_ID.has(id)
}

export function getCampaignMapNode(id) {
  const node = NODE_BY_ID.get(id)
  if (node === undefined) {
    throw new RangeError(`Unknown campaign route node: ${String(id)}`)
  }
  return node
}

// The node's position in map order also indexes its derived shop-stock stream.
export function getCampaignMapNodeIndex(id) {
  getCampaignMapNode(id)
  return NODE_INDEX.get(id)
}

export function getCampaignNodeContent(node) {
  return contentFor(node.kind, node.contentId)
}

export function isFinalCampaignNode(id) {
  return id === CAMPAIGN_FINAL_NODE_ID
}

export function createInitialRouteNodes() {
  return CAMPAIGN_MAP.nodes.map(({ id }) => ({
    id,
    state: id === CAMPAIGN_START_NODE_ID ? 'available' : 'locked',
  }))
}

// Entering a node makes it active and bypasses every unvisited node it cannot reach.
export function enterRouteNode(routeNodes, nodeId) {
  const ahead = REACHABLE.get(nodeId)
  return routeNodes.map(({ id, state }) => {
    if (id === nodeId) return { id, state: 'active' }
    if (['locked', 'available'].includes(state) && !ahead.has(id)) {
      return { id, state: 'bypassed' }
    }
    return { id, state }
  })
}

// Completing a node unlocks its locked successors.
export function completeRouteNode(routeNodes, nodeId) {
  const next = new Set(getCampaignMapNode(nodeId).next)
  return routeNodes.map(({ id, state }) => {
    if (id === nodeId) return { id, state: 'completed' }
    if (state === 'locked' && next.has(id)) return { id, state: 'available' }
    return { id, state }
  })
}

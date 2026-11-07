import {
  CAMPAIGN_ARCHETYPES,
  CAMPAIGN_DECK_SIZE_LIMITS,
  CAMPAIGN_FIGHT_TIERS,
  CAMPAIGN_FIGHTS,
  CAMPAIGN_MEND_HEALTH_BY_TIER,
  CAMPAIGN_NODE_EVENTS,
  CAMPAIGN_NODE_HEAL_LIMIT,
  CAMPAIGN_REST_SITES,
  CAMPAIGN_SHOP_PRICES,
  CAMPAIGN_SHOP_SLOT_KINDS,
  CAMPAIGN_SHOPS,
  getCampaignFight,
  getCampaignNodeEvent,
  getCampaignRestSite,
  getCampaignShop,
} from './campaign-content.js'
import { DECK_EDIT_KINDS } from './campaign-deck.js'
import {
  getCampaignModifier,
  isCampaignModifierId,
  isOpponentTraitId,
} from './campaign-modifiers.js'
import { CARD_IDS, compareCards, isCardId, RANKS } from './cards.js'

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

export const CAMPAIGN_NODE_KINDS = Object.freeze(['fight', 'shop', 'event', 'rest'])
export const CAMPAIGN_NODE_STATES = Object.freeze([
  'locked',
  'available',
  'active',
  'completed',
  'bypassed',
])
export const CAMPAIGN_MAP_NODE_LIMIT = 16

const ID_PATTERN = /^[a-z]+(?:-[a-z]+)*$/
const CARD_INDEX = new Map(CARD_IDS.map((cardId, index) => [cardId, index]))
const REST_DECK_EDIT_KINDS = Object.freeze(['duplicate', 'remove'])

// Every route alternates a fight with a shop, event, or rest, and ends at the boss. Each
// elite sits beside a normal fight that all of its predecessors also offer, so declining
// an elite is always possible. Map order is stage order; saved node states and shop-stock
// streams follow it exactly.
export const CAMPAIGN_MAP = deepFreeze({
  id: 'expedition-v2',
  nodes: [
    { id: 'gate', stage: 1, kind: 'fight', contentId: 'suit-opposition', next: ['market', 'shrine'] },
    { id: 'market', stage: 2, kind: 'shop', contentId: 'wayside-market', next: ['court', 'high-court'] },
    { id: 'shrine', stage: 2, kind: 'event', contentId: 'crossroads-shrine', next: ['court', 'high-court'] },
    { id: 'court', stage: 3, kind: 'fight', contentId: 'royal-court', next: ['bazaar', 'vault', 'camp'] },
    { id: 'high-court', stage: 3, kind: 'fight', contentId: 'high-court', next: ['bazaar', 'vault', 'camp'] },
    { id: 'bazaar', stage: 4, kind: 'shop', contentId: 'ember-bazaar', next: ['watch', 'night-watch'] },
    { id: 'vault', stage: 4, kind: 'event', contentId: 'oathkeepers-vault', next: ['watch', 'night-watch'] },
    { id: 'camp', stage: 4, kind: 'rest', contentId: 'roadside-camp', next: ['watch', 'night-watch'] },
    { id: 'watch', stage: 5, kind: 'fight', contentId: 'watch-of-tens', next: ['sanctum'] },
    { id: 'night-watch', stage: 5, kind: 'fight', contentId: 'night-watch', next: ['sanctum'] },
    { id: 'sanctum', stage: 6, kind: 'rest', contentId: 'last-light-sanctum', next: ['finale'] },
    { id: 'finale', stage: 7, kind: 'fight', contentId: 'ace-sovereign', next: [] },
  ],
})

function contentFor(kind, contentId) {
  if (kind === 'fight') return getCampaignFight(contentId)
  if (kind === 'shop') return getCampaignShop(contentId)
  if (kind === 'rest') return getCampaignRestSite(contentId)
  return getCampaignNodeEvent(contentId)
}

function assertNonnegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a nonnegative safe integer`)
  }
}

function isInDeckOrder(cardIds) {
  return cardIds.every((cardId, index) => (
    index === 0 || CARD_INDEX.get(cardIds[index - 1]) < CARD_INDEX.get(cardId)
  ))
}

function isSortedAndDistinct(ids) {
  return ids.every((id, index) => index === 0 || ids[index - 1] < id)
}

// A rank is covered when some deck card ties or beats it, so a player card of that rank
// can lose a clash. Under burn rules an uncovered rank can never be burned.
export function uncoveredCampaignRanks(cardIds) {
  return RANKS
    .map(({ rank }) => rank)
    .filter((rank) => !cardIds.some((cardId) => compareCards(cardId, `c-${rank}S`) >= 0))
}

export function validateCampaignArchetypes(archetypes) {
  const ids = new Set()
  const names = new Set()
  for (const archetype of archetypes) {
    if (!ID_PATTERN.test(archetype.id) || ids.has(archetype.id)) {
      throw new TypeError('Campaign archetypes need unique lowercase IDs')
    }
    ids.add(archetype.id)
    if (
      typeof archetype.name !== 'string'
      || archetype.name.length === 0
      || names.has(archetype.name)
      || typeof archetype.description !== 'string'
      || archetype.description.length === 0
      || !Array.isArray(archetype.coreCardIds)
      || archetype.coreCardIds.length === 0
      || !archetype.coreCardIds.every(isCardId)
      || !isInDeckOrder(archetype.coreCardIds)
    ) {
      throw new TypeError(`Campaign archetype ${archetype.id} is malformed`)
    }
    names.add(archetype.name)
  }
  return archetypes
}

export function validateCampaignFights(fights, archetypes = CAMPAIGN_ARCHETYPES) {
  const ids = new Set()
  for (const fight of fights) {
    if (!ID_PATTERN.test(fight.id) || ids.has(fight.id)) {
      throw new TypeError('Campaign fights need unique lowercase IDs')
    }
    ids.add(fight.id)
    const name = `Campaign fight ${fight.id}`
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
      throw new TypeError(`${name} is malformed`)
    }
    assertNonnegativeInteger(fight.bounty, `${name} bounty`)
    const archetype = archetypes.find(({ id }) => id === fight.archetypeId)
    if (archetype === undefined) {
      throw new TypeError(`${name} has an unknown archetype: ${String(fight.archetypeId)}`)
    }
    if (!CAMPAIGN_FIGHT_TIERS.includes(fight.tier)) {
      throw new TypeError(`${name} has an unknown tier: ${String(fight.tier)}`)
    }
    if (!isInDeckOrder(fight.opponentCardIds)) {
      throw new TypeError(`${name} must list its deck in canonical order`)
    }
    const deck = new Set(fight.opponentCardIds)
    if (!archetype.coreCardIds.every((cardId) => deck.has(cardId))) {
      throw new TypeError(`${name} must field the ${archetype.id} core`)
    }
    if (fight.tier === 'normal' && deck.size !== archetype.coreCardIds.length) {
      throw new TypeError(`${name} is a normal fight and must field exactly its core`)
    }
    if (fight.tier !== 'normal') {
      const uncovered = uncoveredCampaignRanks(fight.opponentCardIds)
      if (uncovered.length > 0) {
        throw new TypeError(`${name} must cover every rank; it leaves ${uncovered.join(', ')} uncovered`)
      }
    }
    if (fight.tier === 'boss' && fight.bounty !== 0) {
      throw new TypeError(`${name} is a boss and cannot pay a bounty`)
    }
    if (
      !Array.isArray(fight.traitIds)
      || !fight.traitIds.every((id) => typeof id === 'string')
      || !isSortedAndDistinct(fight.traitIds)
    ) {
      throw new TypeError(`${name} needs sorted, distinct trait IDs`)
    }
    if (fight.traitIds.length > 0 && fight.tier !== 'elite') {
      throw new TypeError(`${name} may carry traits only as an elite`)
    }
    const hooks = new Set()
    for (const traitId of fight.traitIds) {
      if (!isOpponentTraitId(traitId)) {
        throw new TypeError(`${name} may carry only opponent traits; ${traitId} is not one`)
      }
      for (const hook of getCampaignModifier(traitId).hooks) {
        if (hooks.has(hook)) {
          throw new TypeError(`${name} carries two traits that both modify ${hook}`)
        }
        hooks.add(hook)
      }
    }
  }
  return fights
}

// Mend heals after normal fights and Greater Mend after elites. The boss offers no draft.
export function validateCampaignMendTiers(healthByTier) {
  const tiers = Object.keys(healthByTier)
  if (tiers.length !== 2 || !['normal', 'elite'].every((tier) => tiers.includes(tier))) {
    throw new TypeError('Campaign Mend health must be set for exactly the normal and elite tiers')
  }
  for (const tier of tiers) {
    const health = healthByTier[tier]
    if (!Number.isSafeInteger(health) || health < 1) {
      throw new TypeError(`Campaign ${tier} Mend must restore a positive whole amount of health`)
    }
    if (health > CAMPAIGN_NODE_HEAL_LIMIT) {
      throw new RangeError(
        `Campaign ${tier} Mend cannot restore more than ${CAMPAIGN_NODE_HEAL_LIMIT} health`,
      )
    }
  }
  return healthByTier
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

function validateNodeOption(name, option) {
  if (!ID_PATTERN.test(option.id) || typeof option.label !== 'string' || option.label.length === 0) {
    throw new TypeError(`${name} needs an ID and label`)
  }
  for (const key of ['healthCost', 'coinCost', 'healthGain', 'coinGain']) {
    assertNonnegativeInteger(option[key], `${name} ${key}`)
  }
  if (option.healthGain > CAMPAIGN_NODE_HEAL_LIMIT) {
    throw new RangeError(`${name} cannot restore more than ${CAMPAIGN_NODE_HEAL_LIMIT} health`)
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
    if (isOpponentTraitId(option.modifierId)) {
      throw new TypeError(`${name} cannot grant opponent trait ${option.modifierId}`)
    }
    if (!isCampaignModifierId(option.modifierId) || !getCampaignModifier(option.modifierId).draftable) {
      throw new TypeError(`${name} must grant a draftable catalogue modifier`)
    }
  }
}

function validateEventOption(event, option) {
  validateNodeOption(`Campaign event ${event.id} option ${option.id}`, option)
}

function validateRestOption(site, option) {
  const name = `Campaign rest site ${site.id} option ${option.id}`
  validateNodeOption(name, option)
  if (option.healthCost !== 0 || option.coinCost !== 0) {
    throw new TypeError(`${name} cannot cost health or coins`)
  }
  if (option.surrenderHold || option.modifierId !== null || option.coinGain !== 0) {
    throw new TypeError(`${name} may only restore health or edit the deck`)
  }
  if (
    option.deckEdit !== null
    && (!REST_DECK_EDIT_KINDS.includes(option.deckEdit.kind) || option.deckEdit.cardId !== null)
  ) {
    throw new TypeError(`${name} may only duplicate or remove a chosen card`)
  }
}

function isEffectFree(option) {
  return option.healthCost === 0
    && option.coinCost === 0
    && !option.surrenderHold
    && option.deckEdit === null
    && option.modifierId === null
    && option.healthGain === 0
    && option.coinGain === 0
}

// Events and rest sites share the option shape: unique option IDs, ending with an
// effect-free option.
function validateOptionSites(sites, kind, validateOption) {
  const ids = new Set()
  for (const site of sites) {
    if (!ID_PATTERN.test(site.id) || ids.has(site.id)) {
      throw new TypeError(`Campaign ${kind}s need unique lowercase IDs`)
    }
    ids.add(site.id)
    if (
      typeof site.name !== 'string'
      || site.name.length === 0
      || !Array.isArray(site.options)
      || site.options.length === 0
    ) {
      throw new TypeError(`Campaign ${kind} ${site.id} is malformed`)
    }
    const optionIds = new Set()
    for (const option of site.options) {
      validateOption(site, option)
      if (optionIds.has(option.id)) {
        throw new TypeError(`Campaign ${kind} ${site.id} repeats option ${option.id}`)
      }
      optionIds.add(option.id)
    }
    if (!isEffectFree(site.options.at(-1))) {
      throw new TypeError(`Campaign ${kind} ${site.id} must end with an effect-free option`)
    }
  }
}

export function validateCampaignEvents(events) {
  validateOptionSites(events, 'event', validateEventOption)
  return events
}

// Rest options cost nothing. Each option before the final Walk on either restores health
// or edits the deck, never both.
export function validateCampaignRestSites(sites) {
  validateOptionSites(sites, 'rest site', validateRestOption)
  for (const site of sites) {
    if (site.options.at(-1).id !== 'walk-on') {
      throw new TypeError(`Campaign rest site ${site.id} must end with Walk on`)
    }
    for (const option of site.options.slice(0, -1)) {
      if ((option.healthGain > 0) === (option.deckEdit !== null)) {
        throw new TypeError(
          `Campaign rest site ${site.id} option ${option.id} must either restore health or edit the deck`,
        )
      }
    }
  }
  return sites
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
  const tierOf = (node) => (node.kind === 'fight' ? getCampaignFight(node.contentId).tier : null)
  if (tierOf(nodes[0]) !== 'normal') {
    throw new Error('Campaign map must start with a normal fight')
  }
  const bosses = nodes.filter((node) => tierOf(node) === 'boss')
  if (bosses.length !== 1 || bosses[0] !== finals[0]) {
    throw new Error('Campaign map needs exactly one boss fight, as its final node')
  }
  if (reachable(nodeById, nodes[0].id).size !== nodes.length) {
    throw new Error('Every campaign map node must be reachable from the start')
  }
  for (const elite of nodes.filter((node) => tierOf(node) === 'elite')) {
    const twins = nodes.filter((node) => node.stage === elite.stage && tierOf(node) === 'normal')
    if (twins.length === 0) {
      throw new Error(`Campaign elite node ${elite.id} needs a normal fight in stage ${elite.stage}`)
    }
    const predecessors = nodes.filter((node) => node.next.includes(elite.id))
    if (!twins.some((twin) => predecessors.every((node) => node.next.includes(twin.id)))) {
      throw new Error(`Campaign elite node ${elite.id} needs a normal twin that every predecessor offers`)
    }
  }
  for (const node of nodes) {
    const ahead = reachable(nodeById, node.id)
    if (!ahead.has(finals[0].id)) {
      throw new Error(`Campaign map node ${node.id} must reach the final fight`)
    }
    const shopAhead = [...ahead].some((id) => id !== node.id && nodeById.get(id).kind === 'shop')
    if (node.kind === 'event') {
      const gainsCoins = getCampaignNodeEvent(node.contentId).options
        .some((option) => option.coinGain > 0)
      if (gainsCoins && !shopAhead) {
        throw new Error(`Campaign event node ${node.id} cannot grant coins without a later shop`)
      }
    }
    if (node.kind === 'fight' && getCampaignFight(node.contentId).bounty > 0 && !shopAhead) {
      throw new Error(`Campaign fight node ${node.id} cannot pay a bounty without a later shop`)
    }
  }
  return map
}

export function validateCampaignContent() {
  validateCampaignArchetypes(CAMPAIGN_ARCHETYPES)
  validateCampaignFights(CAMPAIGN_FIGHTS)
  validateShops(CAMPAIGN_SHOPS)
  validateCampaignEvents(CAMPAIGN_NODE_EVENTS)
  validateCampaignRestSites(CAMPAIGN_REST_SITES)
  validateCampaignMendTiers(CAMPAIGN_MEND_HEALTH_BY_TIER)
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

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CAMPAIGN_SHOP_PRICES,
  CAMPAIGN_SHOPS,
} from '../../src/domain/campaign-content.js'
import { createStarterPlayerCards, playerInstanceId } from '../../src/domain/campaign-deck.js'
import {
  HOLD_POSITION,
  getCampaignShopOffers,
  getCampaignShopTargets,
  leaveCampaignShop,
  purchaseCampaignShopItem,
} from '../../src/domain/campaign-machine.js'
import { getCampaignMapNodeIndex } from '../../src/domain/campaign-map.js'
import {
  createModifierRecord,
  createStartingModifierRecords,
  getAvailableModifierPool,
} from '../../src/domain/campaign-modifiers.js'
import {
  SHOP_ITEM_KEYS,
  SHOP_STOCK_STREAM,
  generateShopStock,
  modifierAvailability,
  shopItemBlocker,
} from '../../src/domain/campaign-shop.js'
import { CARD_IDS } from '../../src/domain/cards.js'
import { BASELINE_RULESET, NO_BURN_RULESET } from '../../src/domain/ruleset.js'
import { createDerivedRng } from '../../src/domain/rng.js'
import {
  buyShopItem,
  chooseRoute,
  claimReward,
  holdCard,
  leaveShop,
  routeStates,
  startCampaign,
  winEncounter,
} from '../fixtures/campaign-route.js'

const SHOP_NODES = Object.freeze([
  ['market', 'wayside-market'],
  ['bazaar', 'ember-bazaar'],
])

function starterCardIds() {
  return createStarterPlayerCards().map(({ cardId }) => cardId)
}

function slotsOf(shopId) {
  return CAMPAIGN_SHOPS.find(({ id }) => id === shopId).slots
}

// Independent model of the documented stock rules: canonical pools, one derived draw per
// non-empty slot in slot order, one more for a replace card, and no card offered twice.
function expectedStock({ seed, nodeIndex, slots, cardIds, modifierPool }) {
  const rng = createDerivedRng(seed, SHOP_STOCK_STREAM, nodeIndex)
  const draw = (size) => Math.floor(rng.next() * size)
  const owned = new Map()
  for (const cardId of cardIds) owned.set(cardId, (owned.get(cardId) ?? 0) + 1)
  const offered = []
  const unowned = () => CARD_IDS.filter((cardId) => !owned.has(cardId) && !offered.includes(cardId))
  const canGrow = cardIds.length < 40
  const ordinals = {}
  const items = []
  for (const slot of slots) {
    ordinals[slot] = (ordinals[slot] ?? 0) + 1
    const base = {
      itemId: `${slot}-${ordinals[slot]}`,
      cardId: null,
      modifierId: null,
      price: CAMPAIGN_SHOP_PRICES[slot],
      sold: false,
    }
    if (slot === 'card') {
      const pool = canGrow ? unowned() : []
      if (pool.length === 0) continue
      const cardId = pool[draw(pool.length)]
      offered.push(cardId)
      items.push({ ...base, kind: 'add', cardId })
    } else if (slot === 'service') {
      const replacements = unowned()
      const operations = [
        ...(canGrow && [...owned.values()].some((count) => count < 2) ? ['duplicate'] : []),
        ...(cardIds.length > 20 ? ['remove'] : []),
        ...(replacements.length > 0 ? ['replace'] : []),
      ]
      if (operations.length === 0) continue
      const kind = operations[draw(operations.length)]
      const cardId = kind === 'replace' ? replacements[draw(replacements.length)] : null
      if (cardId !== null) offered.push(cardId)
      items.push({ ...base, kind, cardId })
    } else {
      if (modifierPool.length === 0) continue
      items.push({ ...base, kind: 'modifier', modifierId: modifierPool[draw(modifierPool.length)] })
    }
  }
  return items
}

function cardsOf(cardIds) {
  return cardIds.map((cardId, index) => ({
    instanceId: playerInstanceId(index + 1),
    cardId,
    campaignOwner: 'player',
  }))
}

function context({
  cardIds = starterCardIds(),
  currency = 20,
  activeModifiers = createStartingModifierRecords(),
  ruleset = BASELINE_RULESET,
  candidates = (cards) => cards,
} = {}) {
  const playerCards = cardsOf(cardIds)
  return {
    health: 3,
    currency,
    ruleset,
    activeModifiers,
    playerCards,
    targetCandidates: candidates(playerCards),
    holdOccupied: false,
  }
}

function item(kind, overrides = {}) {
  return {
    itemId: `${kind}-1`,
    kind,
    cardId: ['add', 'replace'].includes(kind) ? 'c-2S' : null,
    modifierId: kind === 'modifier' ? 'vow-of-patience-v1' : null,
    price: kind === 'modifier' ? 4 : 2,
    sold: false,
    ...overrides,
  }
}

function doubled(count) {
  return CARD_IDS.slice(0, count).flatMap((cardId) => [cardId, cardId])
}

// Seed 0 reaches Wayside Market with 3 coins, 4 health, and player-001 held. Its stock is
// a 3S card (3 coins), a remove service (2 coins), and Vow of Patience (4 coins).
function marketWithHold() {
  const gate = startCampaign({ runId: 'campaign-shop-hold', seed: 0, ruleset: BASELINE_RULESET })
  return chooseRoute(claimReward(winEncounter(holdCard(gate, 'player-001')), 'mend'), 'market')
}

test('shop stock takes one derived draw per non-empty slot from its node stream', (t) => {
  t.mock.method(Math, 'random', () => assert.fail('Hidden Math.random use'))
  assert.equal(SHOP_STOCK_STREAM, 'campaign-shop-stock-v1')
  assert.deepEqual(SHOP_ITEM_KEYS, ['itemId', 'kind', 'cardId', 'modifierId', 'price', 'sold'])
  assert.deepEqual(CAMPAIGN_SHOP_PRICES, { card: 3, service: 2, modifier: 4 })
  assert.deepEqual(slotsOf('wayside-market'), ['card', 'service', 'modifier'])
  assert.deepEqual(slotsOf('ember-bazaar'), ['card', 'card', 'service', 'modifier'])
  const cardIds = starterCardIds()
  const activeModifiers = createStartingModifierRecords()
  for (const [nodeId, shopId] of SHOP_NODES) {
    const nodeIndex = getCampaignMapNodeIndex(nodeId)
    for (let seed = 0; seed < 30; seed += 1) {
      for (const ruleset of [BASELINE_RULESET, NO_BURN_RULESET]) {
        const options = { seed, nodeIndex, shopId, playerCardIds: cardIds, activeModifiers, ruleset }
        const stock = generateShopStock(options)
        assert.deepEqual(stock, generateShopStock(options))
        assert.deepEqual(stock, expectedStock({
          seed,
          nodeIndex,
          slots: slotsOf(shopId),
          cardIds,
          modifierPool: getAvailableModifierPool(activeModifiers, ruleset),
        }))
        assert.deepEqual(
          stock.map(({ itemId }) => itemId),
          shopId === 'ember-bazaar'
            ? ['card-1', 'card-2', 'service-1', 'modifier-1']
            : ['card-1', 'service-1', 'modifier-1'],
        )
        const offered = stock.map(({ cardId }) => cardId).filter((cardId) => cardId !== null)
        assert.equal(new Set(offered).size, offered.length, `${shopId} seed ${seed}`)
        assert.ok(offered.every((cardId) => !cardIds.includes(cardId)))
      }
    }
  }

  // The stream is keyed by the node's map index, so another position stocks differently.
  const atIndex = (nodeIndex) => Array.from({ length: 10 }, (_, seed) => generateShopStock({
    seed,
    nodeIndex,
    shopId: 'wayside-market',
    playerCardIds: cardIds,
    activeModifiers,
    ruleset: BASELINE_RULESET,
  }))
  assert.notDeepEqual(atIndex(1), atIndex(5))
})

test('closed pools skip their slot without spending a draw', () => {
  const starting = createStartingModifierRecords()
  const allHooks = [
    ...starting,
    createModifierRecord('hold-insight-v1', 'gate'),
    createModifierRecord('spoils-of-war-v1', 'gate'),
    createModifierRecord('vow-of-constancy-v1', 'gate'),
    createModifierRecord('vow-of-patience-v1', 'gate'),
  ]
  assert.deepEqual(getAvailableModifierPool(allHooks, BASELINE_RULESET), [])
  const full = CARD_IDS.slice(0, 40)
  const bazaar = getCampaignMapNodeIndex('bazaar')

  for (let seed = 0; seed < 20; seed += 1) {
    const stock = generateShopStock({
      seed,
      nodeIndex: bazaar,
      shopId: 'ember-bazaar',
      playerCardIds: full,
      activeModifiers: allHooks,
      ruleset: BASELINE_RULESET,
    })
    // A full deck closes both card slots and duplication; no modifier is available.
    assert.deepEqual(stock.map(({ itemId }) => itemId), ['service-1'])
    const rng = createDerivedRng(seed, SHOP_STOCK_STREAM, bazaar)
    const kind = ['remove', 'replace'][Math.floor(rng.next() * 2)]
    assert.equal(stock[0].kind, kind, `seed ${seed} spends its first draw on the service`)
    assert.deepEqual(stock, expectedStock({
      seed,
      nodeIndex: bazaar,
      slots: slotsOf('ember-bazaar'),
      cardIds: full,
      modifierPool: [],
    }))
  }

  const minimum = CARD_IDS.slice(0, 20)
  const pool = getAvailableModifierPool(starting, NO_BURN_RULESET)
  assert.ok(!pool.includes('spoils-of-war-v1'))
  for (let seed = 0; seed < 20; seed += 1) {
    const stock = generateShopStock({
      seed,
      nodeIndex: 1,
      shopId: 'wayside-market',
      playerCardIds: minimum,
      activeModifiers: starting,
      ruleset: NO_BURN_RULESET,
    })
    assert.notEqual(stock[1].kind, 'remove')
    assert.ok(pool.includes(stock[2].modifierId))
    assert.deepEqual(stock, expectedStock({
      seed,
      nodeIndex: 1,
      slots: slotsOf('wayside-market'),
      cardIds: minimum,
      modifierPool: pool,
    }))
  }
})

test('shop blockers name the first reason an item cannot be bought', () => {
  const full = CARD_IDS.slice(0, 40)
  const withModifier = (id) => [...createStartingModifierRecords(), createModifierRecord(id, 'gate')]
  const cases = [
    ['an affordable card', item('add'), context(), null],
    ['a sold item before every other reason', item('add', { sold: true }), context({
      cardIds: full,
      currency: 0,
    }), 'sold'],
    ['a full deck before price', item('add'), context({ cardIds: full, currency: 0 }), 'deck-full'],
    ['a capped card', item('add'), context({ cardIds: [...starterCardIds(), 'c-2S', 'c-2S'] }), 'copy-limit'],
    ['a card the coins do not cover', item('add', { price: 3 }), context({ currency: 2 }), 'unaffordable'],
    ['a duplicate with no card under the copy limit', item('duplicate'), context({
      cardIds: doubled(13),
      currency: 0,
    }), 'no-eligible-card'],
    ['a duplicate whose only eligible card is held', item('duplicate'), context({
      cardIds: [...doubled(13), 'c-AC'],
      candidates: (cards) => cards.filter(({ cardId }) => cardId !== 'c-AC'),
    }), 'no-eligible-card'],
    ['the same duplicate with the card back in the deck', item('duplicate'), context({
      cardIds: [...doubled(13), 'c-AC'],
    }), null],
    ['a removal at the deck minimum', item('remove'), context({
      cardIds: CARD_IDS.slice(0, 20),
      currency: 0,
    }), 'deck-minimum'],
    ['a removal with no target', item('remove'), context({ candidates: () => [] }), 'no-eligible-card'],
    ['a replacement by a capped card', item('replace'), context({
      cardIds: [...starterCardIds(), 'c-2S', 'c-2S'],
    }), 'copy-limit'],
    ['an affordable modifier', item('modifier'), context({ currency: 4 }), null],
    ['a modifier the coins do not cover', item('modifier'), context({ currency: 3 }), 'unaffordable'],
    ['an active modifier before price', item('modifier'), context({
      activeModifiers: withModifier('vow-of-patience-v1'),
      currency: 0,
    }), 'modifier-conflict'],
    ['a modifier sharing a hook', item('modifier'), context({
      activeModifiers: withModifier('vow-of-the-court-v1'),
    }), 'modifier-conflict'],
    ['a burn modifier without burn', item('modifier', { modifierId: 'spoils-of-war-v1' }), context({
      ruleset: NO_BURN_RULESET,
    }), 'modifier-unavailable'],
    ['a sold modifier', item('modifier', { sold: true }), context({
      activeModifiers: withModifier('vow-of-patience-v1'),
    }), 'sold'],
  ]
  for (const [name, candidate, decisionContext, blocker] of cases) {
    assert.equal(shopItemBlocker(candidate, decisionContext), blocker, name)
  }

  const starting = createStartingModifierRecords()
  assert.equal(modifierAvailability(starting, 'hold-insight-v1', BASELINE_RULESET), null)
  assert.equal(
    modifierAvailability(starting, 'vitality-cap-v1', BASELINE_RULESET),
    'modifier-unavailable',
  )
  assert.equal(
    modifierAvailability(withModifier('hold-insight-v1'), 'hold-insight-v1', BASELINE_RULESET),
    'modifier-conflict',
  )
})

test('purchases apply once, refuse sold items, and target only cards outside Hold', () => {
  const market = marketWithHold()
  assert.equal(market.machineState, 'awaitingShop')
  assert.equal(market.hold, 'player-001')
  assert.equal(market.currency, 3)
  assert.deepEqual(
    getCampaignShopOffers(market).map(({ itemId, kind, cardId, modifierId, price, blocker }) => (
      [itemId, kind, cardId ?? modifierId, price, blocker]
    )),
    [
      ['card-1', 'add', 'c-3S', 3, null],
      ['service-1', 'remove', null, 2, null],
      ['modifier-1', 'modifier', 'vow-of-patience-v1', 4, 'unaffordable'],
    ],
  )
  const targets = getCampaignShopTargets(market, 'service-1').map(({ instanceId }) => instanceId)
  assert.equal(targets.length, 25)
  assert.ok(!targets.includes('player-001'))
  assert.deepEqual(getCampaignShopTargets(market, 'card-1'), [])
  assert.deepEqual(getCampaignShopTargets(market, 'modifier-1'), [])
  assert.throws(() => getCampaignShopTargets(market, 'card-9'), /not part of the open shop/)

  const decision = (itemId, targetInstanceId = null) => ({
    nodeId: 'market',
    step: market.journal.length,
    itemId,
    targetInstanceId,
  })
  for (const [selection, message] of [
    [decision('card-9'), /Shop item is not part of the open shop/],
    [decision('modifier-1'), /Shop item modifier-1 is unavailable: unaffordable/],
    [decision('card-1', 'player-002'), /This shop item does not take a target/],
    [decision('service-1'), /Shop item target must be an eligible card/],
    [decision('service-1', 'player-001'), /Shop item target must be an eligible card/],
    [decision('service-1', 'opponent-001'), /Shop item target must be an eligible card/],
    [{ ...decision('service-1', 'player-002'), nodeId: 'bazaar' }, /not the active node/],
    [{ ...decision('service-1', 'player-002'), step: 0 }, /stale/],
    [{ ...decision('service-1', 'player-002'), price: 0 }, /must contain only/],
  ]) {
    assert.throws(() => purchaseCampaignShopItem(market, selection), message)
  }

  const bought = purchaseCampaignShopItem(market, decision('service-1', 'player-002'))
  assert.equal(bought.machineState, 'awaitingShop')
  assert.equal(bought.currency, 1)
  assert.equal(bought.hold, 'player-001')
  assert.ok(!bought.cards.some(({ instanceId }) => instanceId === 'player-002'))
  assert.ok(!bought.deckLayout.includes('player-002'))
  assert.ok(bought.deckLayout.includes(HOLD_POSITION))
  assert.equal(bought.cards.length, market.cards.length - 1)
  assert.deepEqual(bought.journal.at(-1), {
    type: 'purchase',
    nodeId: 'market',
    itemId: 'service-1',
    kind: 'remove',
    cardId: null,
    modifierId: null,
    price: 2,
    targetInstanceId: 'player-002',
    createdInstanceId: null,
  })
  assert.deepEqual(
    getCampaignShopOffers(bought).map(({ itemId, sold, blocker }) => [itemId, sold, blocker]),
    [
      ['card-1', false, 'unaffordable'],
      ['service-1', true, 'sold'],
      ['modifier-1', false, 'unaffordable'],
    ],
  )
  assert.throws(
    () => purchaseCampaignShopItem(bought, decision('service-1', 'player-003')),
    /stale/,
  )
  assert.throws(
    () => buyShopItem(bought, 'service-1', 'player-003'),
    /Shop item service-1 is unavailable: sold/,
  )
  assert.throws(() => buyShopItem(bought, 'card-1'), /Shop item card-1 is unavailable: unaffordable/)
})

test('a new card joins the deck once and leaving keeps unsold stock behind', () => {
  const market = marketWithHold()
  const bought = buyShopItem(market, 'card-1')
  assert.equal(bought.currency, 0)
  assert.deepEqual(bought.cards.at(-1), {
    instanceId: 'player-027',
    cardId: 'c-3S',
    campaignOwner: 'player',
  })
  assert.equal(bought.deckLayout.at(-1), 'player-027')
  assert.equal(bought.journal.at(-1).createdInstanceId, 'player-027')
  assert.throws(() => buyShopItem(bought, 'card-1'), /Shop item card-1 is unavailable: sold/)

  assert.throws(
    () => leaveCampaignShop(bought, { nodeId: 'market', step: market.journal.length }),
    /stale/,
  )
  assert.throws(
    () => leaveCampaignShop(bought, { nodeId: 'market', step: bought.journal.length, itemId: 'card-1' }),
    /must contain only nodeId, step/,
  )
  const left = leaveShop(bought)
  assert.equal(left.machineState, 'awaitingRoute')
  assert.equal(left.shop, null)
  assert.equal(left.currency, 0)
  assert.equal(left.hold, 'player-001')
  assert.deepEqual(left.cards, bought.cards)
  assert.deepEqual(left.rng, bought.rng)
  assert.deepEqual(left.journal.at(-1), { type: 'leaveShop', nodeId: 'market' })
  assert.deepEqual(
    [
      routeStates(left).market,
      routeStates(left).shrine,
      routeStates(left).court,
      routeStates(left)['high-court'],
      routeStates(left).watch,
    ],
    ['completed', 'bypassed', 'available', 'available', 'locked'],
  )
  assert.throws(
    () => leaveCampaignShop(left, { nodeId: 'market', step: left.journal.length }),
    /Campaign is not at a shop/,
  )
})

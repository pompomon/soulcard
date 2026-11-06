import assert from 'node:assert/strict'
import test from 'node:test'
import { createCampaignRun } from '../../src/domain/campaign-machine.js'
import {
  CAMPAIGN_FINAL_NODE_ID,
  CAMPAIGN_MAP,
  CAMPAIGN_MAP_NODE_LIMIT,
  CAMPAIGN_NODE_KINDS,
  CAMPAIGN_NODE_STATES,
  CAMPAIGN_STAGE_COUNT,
  CAMPAIGN_START_NODE_ID,
  completeRouteNode,
  createInitialRouteNodes,
  enterRouteNode,
  getCampaignMapNode,
  getCampaignMapNodeIndex,
  getCampaignNodeContent,
  isCampaignMapNodeId,
  isFinalCampaignNode,
  validateCampaignContent,
  validateCampaignMap,
} from '../../src/domain/campaign-map.js'
import { BASELINE_RULESET } from '../../src/domain/ruleset.js'
import {
  chooseRoute,
  claimReward,
  leaveShop,
  routeStates,
  winEncounter,
} from '../fixtures/campaign-route.js'

// Every start-to-final path through the shipped map, in map link order.
function routePaths(nodeId = CAMPAIGN_START_NODE_ID) {
  const { next } = getCampaignMapNode(nodeId)
  if (next.length === 0) return [[nodeId]]
  return next.flatMap((id) => routePaths(id).map((path) => [nodeId, ...path]))
}

function states(routeNodes) {
  return Object.fromEntries(routeNodes.map(({ id, state }) => [id, state]))
}

function mutatedMap(edit) {
  const map = structuredClone(CAMPAIGN_MAP)
  edit(map, (id) => map.nodes.find((node) => node.id === id))
  return map
}

function availableNodes(run) {
  return run.route.nodes.filter(({ state }) => state === 'available').map(({ id }) => id)
}

test('the expedition map has eight five-stage routes that alternate fights and stops', () => {
  assert.equal(validateCampaignContent(), CAMPAIGN_MAP)
  assert.deepEqual(validateCampaignMap(structuredClone(CAMPAIGN_MAP)), CAMPAIGN_MAP)
  assert.ok(Object.isFrozen(CAMPAIGN_MAP.nodes[0].next))
  assert.deepEqual(CAMPAIGN_NODE_KINDS, ['fight', 'shop', 'event'])
  assert.deepEqual(CAMPAIGN_NODE_STATES, ['locked', 'available', 'active', 'completed', 'bypassed'])
  assert.equal(CAMPAIGN_MAP.id, 'expedition-v1')
  assert.ok(CAMPAIGN_MAP.nodes.length <= CAMPAIGN_MAP_NODE_LIMIT)
  assert.deepEqual(
    CAMPAIGN_MAP.nodes.map((node) => [
      node.id,
      node.stage,
      node.kind,
      getCampaignNodeContent(node).name,
    ]),
    [
      ['gate', 1, 'fight', 'Suit Opposition'],
      ['market', 2, 'shop', 'Wayside Market'],
      ['shrine', 2, 'event', 'Crossroads Shrine'],
      ['court', 3, 'fight', 'Royal Court'],
      ['watch', 3, 'fight', 'Watch of Tens'],
      ['bazaar', 4, 'shop', 'Ember Bazaar'],
      ['vault', 4, 'event', "Oathkeeper's Vault"],
      ['finale', 5, 'fight', 'Ace Assembly'],
    ],
  )
  assert.equal(CAMPAIGN_START_NODE_ID, 'gate')
  assert.equal(CAMPAIGN_FINAL_NODE_ID, 'finale')
  assert.equal(CAMPAIGN_STAGE_COUNT, 5)

  const paths = routePaths()
  assert.equal(paths.length, 8)
  assert.equal(new Set(paths.map((path) => path.join('>'))).size, 8)
  for (const path of paths) {
    const nodes = path.map(getCampaignMapNode)
    assert.deepEqual(nodes.map(({ stage }) => stage), [1, 2, 3, 4, 5], path.join('>'))
    assert.deepEqual(
      nodes.map(({ kind }) => kind === 'fight'),
      [true, false, true, false, true],
      path.join('>'),
    )
  }
  for (const node of CAMPAIGN_MAP.nodes) {
    if (node.kind === 'fight' && node.next.length > 0) {
      assert.deepEqual(
        node.next.map((id) => getCampaignMapNode(id).kind).sort(),
        ['event', 'shop'],
        `${node.id} offers a shop and an event`,
      )
    }
  }
})

test('map lookups index nodes in map order and name unknown nodes', () => {
  assert.deepEqual(
    CAMPAIGN_MAP.nodes.map(({ id }) => getCampaignMapNodeIndex(id)),
    [0, 1, 2, 3, 4, 5, 6, 7],
  )
  assert.equal(getCampaignMapNode('watch'), CAMPAIGN_MAP.nodes[4])
  assert.equal(isCampaignMapNodeId('watch'), true)
  for (const id of ['nowhere', 'Watch', '', null, undefined, 4]) {
    assert.equal(isCampaignMapNodeId(id), false, String(id))
  }
  assert.throws(() => getCampaignMapNode('nowhere'), {
    name: 'RangeError',
    message: 'Unknown campaign route node: nowhere',
  })
  assert.throws(() => getCampaignMapNodeIndex('nowhere'), /Unknown campaign route node: nowhere/)
  assert.equal(isFinalCampaignNode('finale'), true)
  assert.equal(isFinalCampaignNode('watch'), false)
})

test('map validation rejects malformed expedition graphs', () => {
  const cases = [
    [/lowercase versioned ID/, (map) => { map.id = 'Expedition' }],
    [/must contain 1 to 16 nodes/, (map) => { map.nodes = [] }],
    [/must contain 1 to 16 nodes/, (map) => {
      map.nodes = Array.from(
        { length: CAMPAIGN_MAP_NODE_LIMIT + 1 },
        (_, index) => ({ ...map.nodes[index % map.nodes.length] }),
      )
    }],
    [/unique lowercase IDs/, (map, node) => { node('shrine').id = 'market' }],
    [/unique lowercase IDs/, (map, node) => { node('market').id = 'Market' }],
    [/stage order/, (map, node) => { node('court').stage = 1 }],
    [/stage order/, (map, node) => { node('gate').stage = 0 }],
    [/node market has an unknown kind/, (map, node) => { node('market').kind = 'camp' }],
    [/Unknown campaign shop: night-market/, (map, node) => {
      node('market').contentId = 'night-market'
    }],
    [/Unknown campaign event: wayside-market/, (map, node) => { node('market').kind = 'event' }],
    [/node gate needs unique links/, (map, node) => { node('gate').next = ['market', 'market'] }],
    [/node market may link only to later stages/, (map, node) => {
      node('market').next.push('shrine')
    }],
    [/node court may link only to later stages/, (map, node) => {
      node('court').next.push('market')
    }],
    [/node bazaar may link only to later stages/, (map, node) => {
      node('bazaar').next = ['nowhere']
    }],
    [/exactly one start node, listed first/, (map, node) => { node('gate').next = ['market'] }],
    [/exactly one final fight, listed last/, (map, node) => { node('vault').next = [] }],
    [/exactly one final fight, listed last/, (map, node) => {
      Object.assign(node('finale'), { kind: 'shop', contentId: 'ember-bazaar' })
    }],
    [/event node vault cannot grant coins without a later shop/, (map, node) => {
      node('vault').contentId = 'crossroads-shrine'
    }],
  ]
  for (const [message, edit] of cases) {
    assert.throws(() => validateCampaignMap(mutatedMap(edit)), message)
  }
})

test('route states follow each path and bypass every node it can no longer reach', () => {
  const initial = createInitialRouteNodes()
  assert.deepEqual(states(initial), {
    gate: 'available',
    market: 'locked',
    shrine: 'locked',
    court: 'locked',
    watch: 'locked',
    bazaar: 'locked',
    vault: 'locked',
    finale: 'locked',
  })

  for (const path of routePaths()) {
    let nodes = initial
    path.forEach((nodeId, index) => {
      const { stage, next } = getCampaignMapNode(nodeId)
      nodes = enterRouteNode(nodes, nodeId)
      for (const node of CAMPAIGN_MAP.nodes) {
        let expected = 'locked'
        if (path.slice(0, index).includes(node.id)) expected = 'completed'
        else if (node.id === nodeId) expected = 'active'
        else if (node.stage <= stage) expected = 'bypassed'
        assert.equal(states(nodes)[node.id], expected, `${path.join('>')} at ${nodeId}: ${node.id}`)
      }
      nodes = completeRouteNode(nodes, nodeId)
      assert.equal(states(nodes)[nodeId], 'completed')
      for (const id of next) assert.equal(states(nodes)[id], 'available')
    })
    for (const { id } of CAMPAIGN_MAP.nodes) {
      assert.equal(
        states(nodes)[id],
        path.includes(id) ? 'completed' : 'bypassed',
        `${path.join('>')}: ${id}`,
      )
    }
  }
})

test('route choices refuse locked, bypassed, completed, and unknown nodes', () => {
  const fresh = createCampaignRun({
    runId: 'campaign-map-refusals',
    seed: 3,
    ruleset: BASELINE_RULESET,
  })
  assert.deepEqual(availableNodes(fresh), ['gate'])
  assert.throws(() => chooseRoute(fresh, 'market'), /Route node market is locked, not available/)
  assert.throws(
    () => chooseRoute(fresh, 'nowhere'),
    /Route node nowhere is not part of the campaign map/,
  )

  const stageTwo = claimReward(winEncounter(chooseRoute(fresh, 'gate')), 'mend')
  assert.deepEqual(availableNodes(stageTwo), ['market', 'shrine'])
  assert.throws(() => chooseRoute(stageTwo, 'gate'), /Route node gate is completed, not available/)
  assert.throws(() => chooseRoute(stageTwo, 'court'), /Route node court is locked, not available/)

  const stageThree = leaveShop(chooseRoute(stageTwo, 'market'))
  assert.deepEqual(availableNodes(stageThree), ['court', 'watch'])
  assert.equal(routeStates(stageThree).shrine, 'bypassed')
  assert.throws(
    () => chooseRoute(stageThree, 'shrine'),
    /Route node shrine is bypassed, not available/,
  )

  const watch = chooseRoute(stageThree, 'watch')
  assert.equal(watch.encounter.id, 'watch-of-tens')
  assert.equal(routeStates(watch).court, 'bypassed')
  assert.throws(() => chooseRoute(watch, 'court'), /Campaign is not on the route map/)
})

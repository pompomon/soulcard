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
  EDGE_COVERING_ROUTES,
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

test('the expedition map has 24 seven-stage routes that alternate fights and stops', () => {
  assert.equal(validateCampaignContent(), CAMPAIGN_MAP)
  assert.deepEqual(validateCampaignMap(structuredClone(CAMPAIGN_MAP)), CAMPAIGN_MAP)
  assert.ok(Object.isFrozen(CAMPAIGN_MAP.nodes[0].next))
  assert.deepEqual(CAMPAIGN_NODE_KINDS, ['fight', 'shop', 'event', 'rest'])
  assert.deepEqual(CAMPAIGN_NODE_STATES, ['locked', 'available', 'active', 'completed', 'bypassed'])
  assert.equal(CAMPAIGN_MAP.id, 'expedition-v2')
  assert.ok(CAMPAIGN_MAP.nodes.length <= CAMPAIGN_MAP_NODE_LIMIT)
  assert.deepEqual(
    CAMPAIGN_MAP.nodes.map((node) => [
      node.id,
      node.stage,
      node.kind,
      getCampaignNodeContent(node).name,
      node.kind === 'fight' ? getCampaignNodeContent(node).tier : null,
    ]),
    [
      ['gate', 1, 'fight', 'Suit Opposition', 'normal'],
      ['market', 2, 'shop', 'Wayside Market', null],
      ['shrine', 2, 'event', 'Crossroads Shrine', null],
      ['court', 3, 'fight', 'Royal Court', 'normal'],
      ['high-court', 3, 'fight', 'High Court', 'elite'],
      ['bazaar', 4, 'shop', 'Ember Bazaar', null],
      ['vault', 4, 'event', "Oathkeeper's Vault", null],
      ['camp', 4, 'rest', 'Roadside Camp', null],
      ['watch', 5, 'fight', 'Watch of Tens', 'normal'],
      ['night-watch', 5, 'fight', 'Night Watch', 'elite'],
      ['sanctum', 6, 'rest', 'Last Light Sanctum', null],
      ['finale', 7, 'fight', 'Ace Sovereign', 'boss'],
    ],
  )
  assert.equal(CAMPAIGN_START_NODE_ID, 'gate')
  assert.equal(CAMPAIGN_FINAL_NODE_ID, 'finale')
  assert.equal(CAMPAIGN_STAGE_COUNT, 7)
  assert.equal(CAMPAIGN_MAP.nodes.flatMap(({ next }) => next).length, 21)

  const paths = routePaths()
  assert.equal(paths.length, 24)
  assert.equal(new Set(paths.map((path) => path.join('>'))).size, 24)
  const eliteCounts = new Set()
  const restCounts = new Set()
  for (const path of paths) {
    const nodes = path.map(getCampaignMapNode)
    const tiers = nodes
      .filter(({ kind }) => kind === 'fight')
      .map((node) => getCampaignNodeContent(node).tier)
    assert.deepEqual(nodes.map(({ stage }) => stage), [1, 2, 3, 4, 5, 6, 7], path.join('>'))
    assert.deepEqual(
      nodes.map(({ kind }) => kind === 'fight'),
      [true, false, true, false, true, false, true],
      path.join('>'),
    )
    assert.equal(tiers[0], 'normal', path.join('>'))
    assert.equal(tiers.at(-1), 'boss', path.join('>'))
    assert.ok(!tiers.slice(0, -1).includes('boss'), path.join('>'))
    eliteCounts.add(tiers.filter((tier) => tier === 'elite').length)
    restCounts.add(nodes.filter(({ kind }) => kind === 'rest').length)
    assert.equal(nodes[5].id, 'sanctum', path.join('>'))
  }
  assert.deepEqual([...eliteCounts].sort(), [0, 1, 2])
  assert.deepEqual([...restCounts].sort(), [1, 2])
  for (const node of CAMPAIGN_MAP.nodes) {
    if (node.kind === 'fight') {
      assert.ok(
        node.next.every((id) => getCampaignMapNode(id).kind !== 'fight'),
        `${node.id} leads only to stops`,
      )
    }
  }
  assert.deepEqual(getCampaignMapNode('gate').next.map((id) => getCampaignMapNode(id).kind), ['shop', 'event'])
  assert.deepEqual(
    getCampaignMapNode('court').next.map((id) => getCampaignMapNode(id).kind),
    ['shop', 'event', 'rest'],
  )
})

// Together these routes use every link, so full play over them covers the whole map.
test('six edge-covering routes use all 21 links and end at the sanctum and boss', () => {
  const links = new Set(CAMPAIGN_MAP.nodes.flatMap(({ id, next }) => next.map((to) => `${id}>${to}`)))
  const covered = new Set()
  for (const route of EDGE_COVERING_ROUTES) {
    assert.ok(routePaths().some((path) => path.join('>') === route.join('>')), route.join('>'))
    route.slice(1).forEach((id, index) => covered.add(`${route[index]}>${id}`))
  }
  assert.deepEqual([...covered].sort(), [...links].sort())
})

test('map lookups index nodes in map order and name unknown nodes', () => {
  assert.deepEqual(
    CAMPAIGN_MAP.nodes.map(({ id }) => getCampaignMapNodeIndex(id)),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  )
  assert.equal(getCampaignMapNode('watch'), CAMPAIGN_MAP.nodes[8])
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
    [/Unknown campaign rest site: nowhere/, (map, node) => { node('camp').contentId = 'nowhere' }],
    [/Unknown campaign rest site: ember-bazaar/, (map, node) => { node('bazaar').kind = 'rest' }],
    [/must start with a normal fight/, (map, node) => { node('gate').contentId = 'high-court' }],
    [/exactly one boss fight, as its final node/, (map, node) => {
      node('watch').contentId = 'ace-sovereign'
    }],
    [/exactly one boss fight, as its final node/, (map, node) => {
      node('finale').contentId = 'royal-court'
      node('watch').contentId = 'ace-sovereign'
    }],
    [/exactly one boss fight, as its final node/, (map, node) => {
      node('finale').contentId = 'night-watch'
    }],
    [/elite node court needs a normal fight in stage 3/, (map, node) => {
      node('court').contentId = 'high-court'
    }],
    [/elite node high-court needs a normal twin that every predecessor offers/, (map, node) => {
      node('market').next = ['high-court']
    }],
    [/fight node watch cannot pay a bounty without a later shop/, (map, node) => {
      node('watch').contentId = 'royal-court'
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
    'high-court': 'locked',
    bazaar: 'locked',
    vault: 'locked',
    camp: 'locked',
    watch: 'locked',
    'night-watch': 'locked',
    sanctum: 'locked',
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
  assert.deepEqual(availableNodes(stageThree), ['court', 'high-court'])
  assert.equal(routeStates(stageThree).shrine, 'bypassed')
  assert.throws(
    () => chooseRoute(stageThree, 'shrine'),
    /Route node shrine is bypassed, not available/,
  )
  assert.throws(() => chooseRoute(stageThree, 'watch'), /Route node watch is locked, not available/)

  const elite = chooseRoute(stageThree, 'high-court')
  assert.equal(elite.encounter.id, 'high-court')
  assert.equal(routeStates(elite).court, 'bypassed')
  assert.throws(() => chooseRoute(elite, 'court'), /Campaign is not on the route map/)
})

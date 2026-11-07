import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CAMPAIGN_ARCHETYPES,
  CAMPAIGN_FIGHT_TIERS,
  CAMPAIGN_FIGHTS,
  CAMPAIGN_NODE_EVENTS,
  CAMPAIGN_NODE_HEAL_LIMIT,
  CAMPAIGN_REST_SITES,
  getCampaignArchetype,
  getCampaignRestSite,
} from '../../src/domain/campaign-content.js'
import {
  uncoveredCampaignRanks,
  validateCampaignArchetypes,
  validateCampaignEvents,
  validateCampaignFights,
  validateCampaignRestSites,
} from '../../src/domain/campaign-map.js'
import { CARD_IDS } from '../../src/domain/cards.js'

function edited(entries, id, edit) {
  const copy = structuredClone(entries)
  edit(copy.find((entry) => entry.id === id))
  return copy
}

function option(site, id) {
  return site.options.find((entry) => entry.id === id)
}

test('archetypes name four opponent families by their canonical core decks', () => {
  assert.equal(validateCampaignArchetypes(CAMPAIGN_ARCHETYPES), CAMPAIGN_ARCHETYPES)
  assert.ok(Object.isFrozen(CAMPAIGN_ARCHETYPES[0].coreCardIds))
  assert.deepEqual(
    CAMPAIGN_ARCHETYPES.map(({ id, name, coreCardIds }) => [id, name, coreCardIds.length]),
    [
      ['legion', 'Suit Legion', 26],
      ['court', 'Court', 12],
      ['watch', 'Watch', 12],
      ['sovereign', 'Sovereign', 8],
    ],
  )
  assert.deepEqual(getCampaignArchetype('sovereign').coreCardIds, [
    'c-KS', 'c-AS', 'c-KH', 'c-AH', 'c-KD', 'c-AD', 'c-KC', 'c-AC',
  ])
  assert.throws(() => getCampaignArchetype('horde'), {
    name: 'RangeError',
    message: 'Unknown campaign archetype: horde',
  })
})

test('every fight fields its archetype core at its tier', () => {
  assert.deepEqual(CAMPAIGN_FIGHT_TIERS, ['normal', 'elite', 'boss'])
  assert.equal(validateCampaignFights(CAMPAIGN_FIGHTS), CAMPAIGN_FIGHTS)
  assert.deepEqual(
    CAMPAIGN_FIGHTS.map((fight) => [
      fight.id,
      fight.name,
      fight.archetypeId,
      fight.tier,
      fight.opponentCardIds.length,
      fight.damage,
      fight.bounty,
    ]),
    [
      ['suit-opposition', 'Suit Opposition', 'legion', 'normal', 26, 1, 3],
      ['royal-court', 'Royal Court', 'court', 'normal', 12, 1, 4],
      ['high-court', 'High Court', 'court', 'elite', 14, 2, 6],
      ['watch-of-tens', 'Watch of Tens', 'watch', 'normal', 12, 1, 0],
      ['night-watch', 'Night Watch', 'watch', 'elite', 14, 2, 0],
      ['ace-sovereign', 'Ace Sovereign', 'sovereign', 'boss', 8, 2, 0],
    ],
  )
  for (const fight of CAMPAIGN_FIGHTS) {
    const { coreCardIds } = getCampaignArchetype(fight.archetypeId)
    const expected = fight.tier === 'elite'
      ? CARD_IDS.filter((cardId) => [...coreCardIds, 'c-AS', 'c-AC'].includes(cardId))
      : coreCardIds
    assert.deepEqual(fight.opponentCardIds, expected, fight.id)
  }
  assert.deepEqual(
    CAMPAIGN_FIGHTS.filter(({ traitIds }) => traitIds.length > 0).map(({ tier }) => tier),
    CAMPAIGN_FIGHTS.filter(({ traitIds }) => traitIds.length > 0).map(() => 'elite'),
  )
})

// Under burn rules only the clash loser's cards burn, so a player card that no opponent
// card ties or beats can never be lost. The normal Royal Court and Watch of Tens leave
// high ranks uncovered, which makes them the safe path past each elite.
test('elite and boss decks cover every rank, unlike the safe normal fights', () => {
  assert.deepEqual(
    Object.fromEntries(CAMPAIGN_FIGHTS.map(({ id, opponentCardIds }) => [
      id,
      uncoveredCampaignRanks(opponentCardIds),
    ])),
    {
      'suit-opposition': [],
      'royal-court': ['A'],
      'high-court': [],
      'watch-of-tens': ['J', 'Q', 'K', 'A'],
      'night-watch': [],
      'ace-sovereign': [],
    },
  )
  // A 2 beats an ace, so a 2 alone covers the ace.
  assert.deepEqual(uncoveredCampaignRanks(['c-2S']), ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'])
  assert.deepEqual(uncoveredCampaignRanks(['c-AS']), ['2'])
})

test('fight validation names each content error', () => {
  const cases = [
    [/fight royal-court has an unknown archetype: horde/, 'royal-court', (fight) => {
      fight.archetypeId = 'horde'
    }],
    [/fight royal-court has an unknown tier: champion/, 'royal-court', (fight) => {
      fight.tier = 'champion'
    }],
    [/fight royal-court must list its deck in canonical order/, 'royal-court', (fight) => {
      fight.opponentCardIds.reverse()
    }],
    [/fight high-court must field the court core/, 'high-court', (fight) => {
      fight.opponentCardIds = fight.opponentCardIds.filter((cardId) => cardId !== 'c-JS')
    }],
    [/fight royal-court is a normal fight and must field exactly its core/, 'royal-court', (fight) => {
      fight.opponentCardIds = CARD_IDS.filter((cardId) => [...fight.opponentCardIds, 'c-AS'].includes(cardId))
    }],
    [/fight night-watch must cover every rank; it leaves J, Q, K, A uncovered/, 'night-watch', (fight) => {
      fight.opponentCardIds = getCampaignArchetype('watch').coreCardIds.slice()
    }],
    [/fight ace-sovereign must cover every rank; it leaves A uncovered/, 'ace-sovereign', (fight) => {
      fight.archetypeId = 'court'
      fight.opponentCardIds = getCampaignArchetype('court').coreCardIds.slice()
    }],
    [/fight ace-sovereign is a boss and cannot pay a bounty/, 'ace-sovereign', (fight) => {
      fight.bounty = 1
    }],
    [/fight royal-court may carry traits only as an elite/, 'royal-court', (fight) => {
      fight.traitIds = ['plunder-v1']
    }],
    [/fight ace-sovereign may carry traits only as an elite/, 'ace-sovereign', (fight) => {
      fight.traitIds = ['plunder-v1']
    }],
    [/fight high-court needs sorted, distinct trait IDs/, 'high-court', (fight) => {
      fight.traitIds = ['plunder-v1', 'court-etiquette-v1']
    }],
    [/fight high-court needs sorted, distinct trait IDs/, 'high-court', (fight) => {
      fight.traitIds = ['plunder-v1', 'plunder-v1']
    }],
    [/fight high-court needs sorted, distinct trait IDs/, 'high-court', (fight) => {
      delete fight.traitIds
    }],
    [/fight watch-of-tens is malformed/, 'watch-of-tens', (fight) => { fight.damage = 0 }],
    [/fight watch-of-tens bounty must be a nonnegative safe integer/, 'watch-of-tens', (fight) => {
      fight.bounty = -1
    }],
    [/Campaign fights need unique lowercase IDs/, 'night-watch', (fight) => { fight.id = 'high-court' }],
  ]
  for (const [message, id, edit] of cases) {
    assert.throws(() => validateCampaignFights(edited(CAMPAIGN_FIGHTS, id, edit)), message)
  }
})

test('archetype validation refuses duplicates and non-canonical cores', () => {
  const cases = [
    [/Campaign archetypes need unique lowercase IDs/, 'watch', (archetype) => { archetype.id = 'court' }],
    [/archetype watch is malformed/, 'watch', (archetype) => { archetype.name = 'Court' }],
    [/archetype watch is malformed/, 'watch', (archetype) => { archetype.coreCardIds = [] }],
    [/archetype watch is malformed/, 'watch', (archetype) => { archetype.coreCardIds.reverse() }],
    [/archetype watch is malformed/, 'watch', (archetype) => { archetype.coreCardIds.push('c-1S') }],
    [/archetype watch is malformed/, 'watch', (archetype) => { archetype.description = '' }],
  ]
  for (const [message, id, edit] of cases) {
    assert.throws(() => validateCampaignArchetypes(edited(CAMPAIGN_ARCHETYPES, id, edit)), message)
  }
})

test('rest sites offer a bounded heal, one deck edit, and Walk on, at no cost', () => {
  assert.equal(CAMPAIGN_NODE_HEAL_LIMIT, 2)
  assert.equal(validateCampaignRestSites(CAMPAIGN_REST_SITES), CAMPAIGN_REST_SITES)
  assert.deepEqual(
    CAMPAIGN_REST_SITES.map((site) => [
      site.id,
      site.name,
      site.options.map(({ id, label, healthGain, deckEdit }) => [id, label, healthGain, deckEdit?.kind ?? null]),
    ]),
    [
      ['roadside-camp', 'Roadside Camp', [
        ['rest', 'Rest by the fire', 2, null],
        ['train', 'Train a card', 0, 'duplicate'],
        ['walk-on', 'Walk on', 0, null],
      ]],
      ['last-light-sanctum', 'Last Light Sanctum', [
        ['rest', 'Rest in the sanctum', 2, null],
        ['cleanse', 'Cleanse a card', 0, 'remove'],
        ['walk-on', 'Walk on', 0, null],
      ]],
    ],
  )
  for (const site of CAMPAIGN_REST_SITES) {
    for (const entry of site.options) {
      assert.deepEqual(
        [entry.healthCost, entry.coinCost, entry.surrenderHold, entry.modifierId, entry.coinGain],
        [0, 0, false, null, 0],
        `${site.id} ${entry.id}`,
      )
    }
  }
  assert.equal(getCampaignRestSite('roadside-camp'), CAMPAIGN_REST_SITES[0])
  assert.throws(() => getCampaignRestSite('nowhere'), {
    name: 'RangeError',
    message: 'Unknown campaign rest site: nowhere',
  })
})

test('rest-site validation names each malformed option', () => {
  const cases = [
    [/rest site roadside-camp option rest cannot cost health or coins/, (site) => {
      option(site, 'rest').healthCost = 1
    }],
    [/rest site roadside-camp option train cannot cost health or coins/, (site) => {
      option(site, 'train').coinCost = 2
    }],
    [/rest site roadside-camp option rest cannot restore more than 2 health/, (site) => {
      option(site, 'rest').healthGain = 3
    }],
    [/rest site roadside-camp option train must either restore health or edit the deck/, (site) => {
      option(site, 'train').healthGain = 1
    }],
    [/rest site roadside-camp option rest must either restore health or edit the deck/, (site) => {
      option(site, 'rest').healthGain = 0
    }],
    [/rest site roadside-camp option rest may only restore health or edit the deck/, (site) => {
      option(site, 'rest').coinGain = 2
    }],
    [/rest site roadside-camp option train may only restore health or edit the deck/, (site) => {
      option(site, 'train').surrenderHold = true
      option(site, 'train').deckEdit = { kind: 'add', cardId: 'c-AS' }
    }],
    [/rest site roadside-camp option rest may only restore health or edit the deck/, (site) => {
      option(site, 'rest').modifierId = 'hold-insight-v1'
    }],
    [/rest site roadside-camp option train may only duplicate or remove a chosen card/, (site) => {
      option(site, 'train').deckEdit = { kind: 'add', cardId: 'c-AS' }
    }],
    [/rest site roadside-camp option train has a malformed deck edit/, (site) => {
      option(site, 'train').deckEdit = { kind: 'duplicate', cardId: 'c-AS' }
    }],
    [/rest site roadside-camp must end with an effect-free option/, (site) => {
      site.options.pop()
    }],
    [/rest site roadside-camp must end with Walk on/, (site) => {
      Object.assign(site.options.at(-1), { id: 'linger', label: 'Linger' })
    }],
    [/rest site roadside-camp repeats option rest/, (site) => {
      option(site, 'train').id = 'rest'
    }],
    [/Campaign rest sites need unique lowercase IDs/, (site) => {
      site.id = 'last-light-sanctum'
    }],
  ]
  for (const [message, edit] of cases) {
    assert.throws(
      () => validateCampaignRestSites(edited(CAMPAIGN_REST_SITES, 'roadside-camp', edit)),
      message,
    )
  }
})

test('event options share the per-node heal limit', () => {
  assert.equal(validateCampaignEvents(CAMPAIGN_NODE_EVENTS), CAMPAIGN_NODE_EVENTS)
  assert.equal(
    option(CAMPAIGN_NODE_EVENTS[0], 'burn-an-offering').healthGain,
    CAMPAIGN_NODE_HEAL_LIMIT,
  )
  assert.throws(
    () => validateCampaignEvents(edited(CAMPAIGN_NODE_EVENTS, 'crossroads-shrine', (event) => {
      option(event, 'burn-an-offering').healthGain = CAMPAIGN_NODE_HEAL_LIMIT + 1
    })),
    { name: 'RangeError', message: /option burn-an-offering cannot restore more than 2 health/ },
  )
})

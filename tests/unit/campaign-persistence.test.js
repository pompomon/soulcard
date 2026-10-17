import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createRunController } from '../../src/app/run-controller.js'
import {
  CAMPAIGN_GAME_RULES_VERSION,
  captureCampaignHold,
  chooseCampaignReveal,
  createCampaignRun,
  createCampaignStateFingerprint,
  getEligibleHoldTargets,
  prepareCampaignReveal,
  selectCampaignReward,
} from '../../src/domain/campaign-machine.js'
import { BASELINE_RULESET } from '../../src/domain/ruleset.js'
import {
  SAVE_SCHEMA_VERSION,
  createRunSave,
  restoreRunSave,
  validateRunSave,
} from '../../src/persistence/run-schema.js'

const SAVED_AT = '2026-09-25T04:00:00.000Z'
const FIXTURE_ROOT = new URL('../fixtures/', import.meta.url)
const DECISION_STATES = ['awaitingHoldChoice', 'awaitingInformedHoldChoice']

function fixture(name) {
  return JSON.parse(readFileSync(new URL(name, FIXTURE_ROOT), 'utf8'))
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function campaign(seed = 27, runId = 'campaign-persistence') {
  return createCampaignRun({
    runId,
    seed,
    ruleset: BASELINE_RULESET,
  })
}

function advance(run) {
  const prepared = prepareCampaignReveal(run)
  if (!DECISION_STATES.includes(prepared.match.machineState)) return prepared.match
  const choice = prepared.match.holdChoice.candidate === null ? 'hold' : 'normal'
  return chooseCampaignReveal(prepared.match, choice).match
}

function playUntilTransition(run) {
  let current = run
  for (let clash = 0; current.machineState === 'ready'; clash += 1) {
    assert.ok(clash < 1000)
    current = advance(current)
  }
  return current
}

function select(run, offerId, targetInstanceId = null) {
  return selectCampaignReward(run, { offerId, targetInstanceId })
}

// Seed 48 wins its first encounter without a retry and drafts Hold Insight.
function rewardFixtureRun(runId = 'fixture-campaign-reward') {
  return playUntilTransition(campaign(48, runId))
}

function informedFixtureRun() {
  const insight = select(rewardFixtureRun('fixture-campaign-informed'), 'modifier')
  return prepareCampaignReveal(insight).match
}

// Seed 6 wins its first encounter without a retry and drafts Spoils of War.
function modifiersFixtureRun() {
  let run = select(playUntilTransition(campaign(6, 'fixture-campaign-modifiers')), 'modifier')
  for (let clash = 0; clash < 3; clash += 1) run = advance(run)
  return captureCampaignHold(run, getEligibleHoldTargets(run)[0].instanceId)
}

function refingerprintSave(save) {
  const state = {
    mode: 'campaign',
    runId: save.runId,
    ruleset: save.ruleset,
    rng: save.rng,
    pendingEvent: save.pendingEvent,
    ...save.match,
  }
  save.match.stateFingerprint = createCampaignStateFingerprint(state)
  if (save.pendingEvent !== null) save.pendingEvent.stateFingerprint = save.match.stateFingerprint
  return save
}

test('campaign saves use schema v5 and campaign rules v4 and restore exactly', () => {
  const run = campaign()
  const save = createRunSave(run, { savedAt: SAVED_AT })

  assert.equal(SAVE_SCHEMA_VERSION, 5)
  assert.equal(CAMPAIGN_GAME_RULES_VERSION, 4)
  assert.equal(save.saveSchemaVersion, SAVE_SCHEMA_VERSION)
  assert.equal(save.runType, 'campaign')
  assert.equal(save.gameRulesVersion, CAMPAIGN_GAME_RULES_VERSION)
  assert.equal(save.match.campaignVersion, 2)
  assert.deepEqual(save.match.rewardHistory, [])
  assert.deepEqual(Object.keys(save.match).slice(-3), [
    'pendingReward',
    'rewardHistory',
    'stateFingerprint',
  ])
  assert.equal(validateRunSave(save), save)
  assert.deepEqual(restoreRunSave(clone(save)), run)
})

test('campaign v5 fixtures regenerate exactly and restore their stable states', () => {
  for (const [name, build] of [
    ['campaign-save-reward-v5.json', rewardFixtureRun],
    ['campaign-save-informed-v5.json', informedFixtureRun],
    ['campaign-save-modifiers-v5.json', modifiersFixtureRun],
  ]) {
    const run = build()
    const save = createRunSave(run, { savedAt: SAVED_AT })
    assert.deepEqual(save, fixture(name), name)
    assert.deepEqual(restoreRunSave(fixture(name)), run, name)
  }

  const reward = fixture('campaign-save-reward-v5.json')
  assert.equal(reward.match.machineState, 'awaitingReward')
  assert.deepEqual(reward.match.pendingReward.offers.map(({ offerId }) => offerId), [
    'new-card',
    'deck-edit',
    'modifier',
    'mend',
  ])
  assert.equal(reward.match.pendingReward.offers[2].modifierId, 'hold-insight-v1')

  const informed = fixture('campaign-save-informed-v5.json')
  assert.equal(informed.match.machineState, 'awaitingInformedHoldChoice')
  assert.deepEqual(Object.keys(informed.match.holdChoice), [
    'from',
    'candidate',
    'opponentFrom',
    'opponentCandidate',
  ])
  assert.equal(informed.match.rewardHistory.length, 1)

  const modifiers = fixture('campaign-save-modifiers-v5.json')
  assert.deepEqual(modifiers.match.activeModifiers, [
    { id: 'vitality-cap-v1', lifetime: 'campaign', grantedAtEncounterIndex: null },
    { id: 'spoils-of-war-v1', lifetime: 'encounter', grantedAtEncounterIndex: 0 },
  ])
  assert.notEqual(modifiers.match.hold, null)
})

test('restored reward drafts and informed choices continue exactly without RNG replay', () => {
  const reward = rewardFixtureRun()
  const restoredReward = restoreRunSave(fixture('campaign-save-reward-v5.json'))
  for (const offerId of ['new-card', 'modifier', 'mend']) {
    assert.deepEqual(select(restoredReward, offerId), select(reward, offerId))
  }

  const informed = informedFixtureRun()
  const restoredInformed = restoreRunSave(fixture('campaign-save-informed-v5.json'))
  assert.deepEqual(restoredInformed.rng, informed.rng)
  const resumed = chooseCampaignReveal(restoredInformed, 'normal')
  assert.deepEqual(resumed, chooseCampaignReveal(informed, 'normal'))
  assert.equal(
    resumed.event.reveals.find(({ suppliedBy }) => suppliedBy === 'opponent').instanceId,
    restoredInformed.holdChoice.opponentCandidate,
  )
  assert.deepEqual(resumed.match.rng, restoredInformed.rng)
})

test('tampered drafts, reward history, modifiers, and peeks are rejected on restore', () => {
  const draft = /must match the regenerated reward draft/
  const history = /must match the modifiers implied by reward history/
  const cases = [
    ['campaign-save-reward-v5.json', draft, (save) => {
      save.match.pendingReward.offers[0].cardId = 'c-AS'
    }],
    ['campaign-save-reward-v5.json', draft, (save) => {
      save.match.pendingReward.offers.splice(1, 1)
    }],
    ['campaign-save-reward-v5.json', draft, (save) => {
      save.match.pendingReward.offers[2].modifierId = 'vow-of-patience-v1'
    }],
    ['campaign-save-informed-v5.json', /entry 0 must match its regenerated draft/, (save) => {
      save.match.rewardHistory[0].offerId = 'mend'
    }],
    ['campaign-save-informed-v5.json', /one entry per completed encounter/, (save) => {
      save.match.rewardHistory = []
    }],
    ['campaign-save-informed-v5.json', /opponent candidate must remain at index zero/, (save) => {
      save.match.holdChoice.opponentCandidate = save.match.encounter.zones.opponentSourcePile[1]
    }],
    ['campaign-save-informed-v5.json', history, (save) => {
      save.match.activeModifiers.pop()
    }],
    ['campaign-save-modifiers-v5.json', history, (save) => {
      save.match.activeModifiers[1].lifetime = 'campaign'
    }],
    ['campaign-save-modifiers-v5.json', history, (save) => {
      save.match.activeModifiers.push({
        id: 'hold-insight-v1',
        lifetime: 'campaign',
        grantedAtEncounterIndex: 0,
      })
    }],
  ]
  for (const [name, message, mutate] of cases) {
    const stale = fixture(name)
    mutate(stale)
    assert.throws(() => restoreRunSave(stale))
    assert.throws(() => restoreRunSave(refingerprintSave(stale)), message)
  }

  const missing = fixture('campaign-save-modifiers-v5.json')
  delete missing.match.rewardHistory
  assert.throws(() => restoreRunSave(missing), /save\.match must contain only/)
})

test('awaiting Hold choices round-trip with their exact candidate and RNG snapshot', () => {
  const prepared = prepareCampaignReveal(campaign()).match
  const save = createRunSave(prepared, { savedAt: SAVED_AT })
  const restored = restoreRunSave(clone(save))

  assert.equal(restored.machineState, 'awaitingHoldChoice')
  assert.deepEqual(restored.holdChoice, prepared.holdChoice)
  assert.deepEqual(restored.rng, prepared.rng)
  assert.equal(restored.stateFingerprint, prepared.stateFingerprint)

  const corrupt = clone(save)
  corrupt.match.holdChoice.candidate = corrupt.match.cards[0].instanceId
  assert.throws(() => restoreRunSave(corrupt), /candidate|fingerprint/)
})

test('automatic campaign reveal saves the Hold boundary before normal resolution', async () => {
  const writes = []
  const repository = {
    async load() {
      return { status: 'empty' }
    },
    async save(run) {
      writes.push(run)
      return { status: 'saved', savedAt: SAVED_AT }
    },
  }
  const controller = createRunController({
    repository,
    initialMatch: campaign(4),
  })

  const result = await controller.revealOrContinue({ autoChooseNormal: true })
  assert.equal(writes.length, 2)
  assert.equal(writes[0].machineState, 'awaitingHoldChoice')
  assert.equal(writes[0].pendingEvent, null)
  assert.notEqual(writes[0].holdChoice.candidate, null)
  assert.equal(writes[1].turn, 1)
  assert.notEqual(writes[1].pendingEvent, null)
  assert.deepEqual(result.match, writes[1])
  await controller.destroy()
})

test('automatic campaign reveal stops at the saved choice when persistence fails', async () => {
  const writes = []
  const repository = {
    async load() {
      return { status: 'empty' }
    },
    async save(run) {
      writes.push(run)
      return { status: 'storage-unavailable', reason: 'quota-exceeded' }
    },
  }
  const controller = createRunController({
    repository,
    initialMatch: campaign(5),
  })

  const result = await controller.revealOrContinue({ autoChooseNormal: true })
  assert.equal(writes.length, 1)
  assert.equal(result.match.machineState, 'awaitingHoldChoice')
  assert.equal(result.event, null)
  assert.equal(result.save.status, 'storage-unavailable')
  await controller.destroy()
})

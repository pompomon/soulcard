import assert from 'node:assert/strict'
import test from 'node:test'
import { createRunController } from '../../src/app/run-controller.js'
import {
  createCampaignRun,
  prepareCampaignReveal,
} from '../../src/domain/campaign-machine.js'
import { BASELINE_RULESET } from '../../src/domain/ruleset.js'
import {
  CAMPAIGN_GAME_RULES_VERSION,
} from '../../src/domain/campaign-machine.js'
import {
  SAVE_SCHEMA_VERSION,
  createRunSave,
  restoreRunSave,
  validateRunSave,
} from '../../src/persistence/run-schema.js'

const SAVED_AT = '2026-09-25T04:00:00.000Z'

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function campaign(seed = 27) {
  return createCampaignRun({
    runId: 'campaign-persistence',
    seed,
    ruleset: BASELINE_RULESET,
  })
}

test('campaign saves use schema v4 and campaign rules v3 and restore exactly', () => {
  const run = campaign()
  const save = createRunSave(run, { savedAt: SAVED_AT })

  assert.equal(save.saveSchemaVersion, SAVE_SCHEMA_VERSION)
  assert.equal(save.runType, 'campaign')
  assert.equal(save.gameRulesVersion, CAMPAIGN_GAME_RULES_VERSION)
  assert.equal(save.match.campaignVersion, 1)
  assert.equal(validateRunSave(save), save)
  assert.deepEqual(restoreRunSave(clone(save)), run)
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

import assert from 'node:assert/strict'
import test from 'node:test'
import { createNewCampaign } from '../../src/app/new-campaign.js'
import { validateCampaignState } from '../../src/domain/campaign-machine.js'
import { NO_BURN_RULESET } from '../../src/domain/ruleset.js'

test('new campaigns derive one deterministic seed and run ID from crypto', () => {
  let calls = 0
  const campaign = createNewCampaign({
    crypto: {
      getRandomValues(target) {
        calls += 1
        target.set([7, 1, 2, 3, 4])
        return target
      },
    },
    ruleset: NO_BURN_RULESET,
  })

  assert.equal(calls, 1)
  assert.equal(campaign.runId, 'campaign-00000001000000020000000300000004')
  assert.equal(campaign.rng.seed, 7)
  assert.deepEqual(campaign.ruleset, NO_BURN_RULESET)
  assert.equal(validateCampaignState(campaign), campaign)
})

test('new campaigns require a cryptographic entropy source', () => {
  assert.throws(() => createNewCampaign({ crypto: null }), /getRandomValues/)
  assert.throws(() => createNewCampaign({ crypto: {} }), /getRandomValues/)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { createNewMatch } from '../../src/app/new-match.js'
import { BASELINE_RULESET } from '../../src/domain/ruleset.js'

test('new matches use caller-independent entropy for a seeded baseline run', () => {
  const words = [
    0x12345678,
    0x01234567,
    0x89abcdef,
    0xfedcba98,
    0x76543210,
  ]
  let requestedLength = null
  const match = createNewMatch({
    crypto: {
      getRandomValues(target) {
        requestedLength = target.length
        target.set(words)
        return target
      },
    },
  })

  assert.equal(requestedLength, 5)
  assert.equal(
    match.runId,
    'run-0123456789abcdeffedcba9876543210',
  )
  assert.equal(match.rng.seed, words[0])
  assert.deepEqual(match.ruleset, BASELINE_RULESET)
  assert.equal(match.stage, 'source')
  assert.equal(match.machineState, 'ready')
  assert.equal(match.turn, 0)
  assert.equal(match.zones.sourceDeck.length, 52)
  assert.equal(Object.isFrozen(match), true)
})

test('new-match creation requires Web Crypto entropy', () => {
  assert.throws(() => createNewMatch({ crypto: null }), /getRandomValues/)
  assert.throws(() => createNewMatch({ crypto: {} }), /getRandomValues/)
})

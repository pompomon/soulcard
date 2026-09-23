import { createMatch } from '../domain/match-machine.js'
import { BASELINE_RULESET } from '../domain/ruleset.js'

const ENTROPY_WORD_COUNT = 5

function assertCrypto(crypto) {
  if (
    crypto === null
    || typeof crypto !== 'object'
    || typeof crypto.getRandomValues !== 'function'
  ) {
    throw new TypeError('crypto must provide getRandomValues')
  }
}

export function createNewMatch({
  crypto = globalThis.crypto,
  ruleset = BASELINE_RULESET,
} = {}) {
  assertCrypto(crypto)
  const entropy = new Uint32Array(ENTROPY_WORD_COUNT)
  crypto.getRandomValues(entropy)
  const [seed, ...runIdWords] = entropy
  const runId = `run-${runIdWords
    .map((word) => word.toString(16).padStart(8, '0'))
    .join('')}`

  return createMatch({
    runId,
    seed,
    ruleset,
  })
}

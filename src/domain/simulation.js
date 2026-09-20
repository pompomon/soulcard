import { createMatch, revealOrContinue } from './match-machine.js'
import { BASELINE_RULESET, validateRuleset } from './ruleset.js'

const UINT32_SIZE = 0x100000000
const TERMINAL_REASONS = Object.freeze([
  'opponentUnableToReveal',
  'playerUnableToReveal',
  'mutualInability',
])

export const SIMULATION_REPORT_VERSION = 1
export const DEFAULT_MAX_CLASHES = 10_000
export const MAX_SIMULATION_CLASHES = 1_000_000
export const MAX_SIMULATION_SEEDS = 10_000
export const CANONICAL_SIMULATION_SEEDS = Object.freeze(
  Array.from({ length: 1_000 }, (_, seed) => seed),
)
export const DEFAULT_TIMING_PROFILE = Object.freeze({
  id: 'mvp-presentation-estimate-v1',
  unit: 'milliseconds',
  revealMs: 400,
  settlementMs: 600,
  burnMs: 200,
  terminalMs: 1_200,
})

function assertPlainObject(value, name) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new TypeError(`${name} must be a plain object`)
  }
}

function assertOptions(options, allowedKeys) {
  assertPlainObject(options, 'options')
  const keys = Reflect.ownKeys(options)
  if (
    keys.some((key) => typeof key !== 'string' || !allowedKeys.includes(key))
  ) {
    throw new TypeError(`options may contain only ${allowedKeys.join(', ')}`)
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(options, key)
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`options.${key} must be JSON-compatible data`)
    }
  }
}

function assertSeed(seed, name = 'seed') {
  if (!Number.isInteger(seed) || seed < 0 || seed >= UINT32_SIZE) {
    throw new TypeError(`${name} must be an unsigned 32-bit integer`)
  }
}

function assertMaxClashes(maxClashes) {
  if (
    !Number.isSafeInteger(maxClashes) ||
    maxClashes < 1 ||
    maxClashes > MAX_SIMULATION_CLASHES
  ) {
    throw new TypeError(
      `maxClashes must be an integer from 1 through ${MAX_SIMULATION_CLASHES}`,
    )
  }
}

function assertSeeds(seeds) {
  if (
    !Array.isArray(seeds) ||
    Object.getPrototypeOf(seeds) !== Array.prototype ||
    seeds.length === 0 ||
    seeds.length > MAX_SIMULATION_SEEDS
  ) {
    throw new TypeError(
      `seeds must be a nonempty dense array of at most ${MAX_SIMULATION_SEEDS} seeds`,
    )
  }
  const propertyNames = Object.getOwnPropertyNames(seeds)
  if (
    propertyNames.length !== seeds.length + 1 ||
    propertyNames.at(-1) !== 'length' ||
    Object.getOwnPropertySymbols(seeds).length !== 0
  ) {
    throw new TypeError('seeds must be a nonempty dense array')
  }

  const seen = new Set()
  for (let index = 0; index < seeds.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(seeds, String(index))
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError('seeds must be a nonempty dense array')
    }
    assertSeed(seeds[index], `seeds[${index}]`)
    if (seen.has(seeds[index])) {
      throw new TypeError('seeds must not contain duplicates')
    }
    seen.add(seeds[index])
  }
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) {
      deepFreeze(child)
    }
    Object.freeze(value)
  }
  return value
}

function durationForEvent(event, terminal) {
  let durationMs = event.reveals.length * DEFAULT_TIMING_PROFILE.revealMs
  if (event.type === 'clashSettled') {
    durationMs += DEFAULT_TIMING_PROFILE.settlementMs
    durationMs += event.burned.length * DEFAULT_TIMING_PROFILE.burnMs
  }
  if (terminal) {
    durationMs += DEFAULT_TIMING_PROFILE.terminalMs
  }
  return durationMs
}

function terminalFields(match) {
  if (match.status !== 'ended') {
    return {
      terminalResult: null,
      terminalReason: null,
      winner: null,
    }
  }
  return {
    terminalResult: match.outcome.result,
    terminalReason: match.outcome.reason,
    winner: match.outcome.result === 'win' ? match.outcome.winner : null,
  }
}

export function simulateMatch(options) {
  assertOptions(options, ['seed', 'ruleset', 'maxClashes'])
  if (!Object.hasOwn(options, 'seed')) {
    throw new TypeError('options must contain seed')
  }

  const requestedSeed = options.seed
  const ruleset = Object.hasOwn(options, 'ruleset')
    ? options.ruleset
    : BASELINE_RULESET
  const maxClashes = Object.hasOwn(options, 'maxClashes')
    ? options.maxClashes
    : DEFAULT_MAX_CLASHES

  assertSeed(requestedSeed)
  const seed = requestedSeed >>> 0
  validateRuleset(ruleset)
  assertMaxClashes(maxClashes)

  let match = createMatch({
    runId: `simulation:${ruleset.id}:${seed}`,
    seed,
    ruleset,
  })
  let clashCount = 0
  let burnCount = 0
  let estimatedDurationMs = 0

  while (match.status === 'active' && clashCount < maxClashes) {
    const transition = revealOrContinue(match)
    match = transition.match
    clashCount += 1
    if (transition.event.type === 'clashSettled') {
      burnCount += transition.event.burned.length
    }
    estimatedDurationMs += durationForEvent(
      transition.event,
      match.status === 'ended',
    )
  }

  return deepFreeze({
    seed,
    rulesetId: ruleset.id,
    status: match.status === 'ended' ? 'completed' : 'truncated',
    clashCount,
    burnCount,
    ...terminalFields(match),
    estimatedDurationMs,
  })
}

function roundToThousandth(value) {
  return Math.round(value * 1_000) / 1_000
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
  return {
    min: sorted[0],
    max: sorted.at(-1),
    mean: roundToThousandth(
      values.reduce((total, value) => total + value, 0) / values.length,
    ),
    median: roundToThousandth(median),
  }
}

export function createSimulationReport(options) {
  assertOptions(options, ['seeds', 'ruleset', 'maxClashes'])

  const seeds = Object.hasOwn(options, 'seeds')
    ? options.seeds
    : CANONICAL_SIMULATION_SEEDS
  const ruleset = Object.hasOwn(options, 'ruleset')
    ? options.ruleset
    : BASELINE_RULESET
  const maxClashes = Object.hasOwn(options, 'maxClashes')
    ? options.maxClashes
    : DEFAULT_MAX_CLASHES

  assertSeeds(seeds)
  validateRuleset(ruleset)
  assertMaxClashes(maxClashes)

  const canonicalSeeds = seeds.map((seed) => seed >>> 0)
  const runs = canonicalSeeds.map(
    (seed) => simulateMatch({ seed, ruleset, maxClashes }),
  )
  const results = {
    playerWin: 0,
    opponentWin: 0,
    draw: 0,
  }
  const reasons = Object.fromEntries(TERMINAL_REASONS.map((reason) => [reason, 0]))
  let completed = 0

  for (const run of runs) {
    if (run.status === 'truncated') {
      continue
    }
    completed += 1
    reasons[run.terminalReason] += 1
    if (run.terminalResult === 'draw') {
      results.draw += 1
    } else if (run.winner === 'player') {
      results.playerWin += 1
    } else {
      results.opponentWin += 1
    }
  }

  return deepFreeze({
    reportVersion: SIMULATION_REPORT_VERSION,
    rulesetId: ruleset.id,
    timingProfile: { ...DEFAULT_TIMING_PROFILE },
    maxClashesPerRun: maxClashes,
    seedCount: canonicalSeeds.length,
    seeds: canonicalSeeds,
    runCounts: {
      completed,
      truncated: runs.length - completed,
    },
    terminalResults: results,
    terminalReasons: reasons,
    metrics: {
      clashCount: summarize(runs.map(({ clashCount }) => clashCount)),
      burnCount: summarize(runs.map(({ burnCount }) => burnCount)),
      estimatedDurationMs: summarize(
        runs.map(({ estimatedDurationMs }) => estimatedDurationMs),
      ),
    },
  })
}

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { createMatch, revealOrContinue } from '../../src/domain/match-machine.js'
import {
  CANONICAL_SIMULATION_SEEDS,
  DEFAULT_MAX_CLASHES,
  DEFAULT_TIMING_PROFILE,
  MAX_SIMULATION_CLASHES,
  MAX_SIMULATION_SEEDS,
  createSimulationReport,
  simulateMatch,
} from '../../src/domain/simulation.js'
import {
  BASELINE_RULESET,
  NO_BURN_RULESET,
} from '../../src/domain/ruleset.js'

const UINT32_SIZE = 0x100000000
const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const CLI_PATH = fileURLToPath(new URL('../../scripts/simulate.js', import.meta.url))
const REPORT_FIXTURE = JSON.parse(readFileSync(
  new URL('../fixtures/simulation-report.json', import.meta.url),
  'utf8',
))

function allObjects(value) {
  if (value === null || typeof value !== 'object') {
    return []
  }
  return [value, ...Object.values(value).flatMap(allObjects)]
}

function directBaselineRun(seed) {
  let match = createMatch({
    runId: `direct:${seed}`,
    seed,
    ruleset: BASELINE_RULESET,
  })
  const events = []
  while (match.status === 'active') {
    const transition = revealOrContinue(match)
    match = transition.match
    events.push(transition.event)
  }
  return { match, events }
}

function expectedDuration(events) {
  return events.reduce((durationMs, event, index) => {
    let eventDuration = event.reveals.length * DEFAULT_TIMING_PROFILE.revealMs
    if (event.type === 'clashSettled') {
      eventDuration += DEFAULT_TIMING_PROFILE.settlementMs
      eventDuration += event.burned.length * DEFAULT_TIMING_PROFILE.burnMs
    }
    if (index === events.length - 1) {
      eventDuration += DEFAULT_TIMING_PROFILE.terminalMs
    }
    return durationMs + eventDuration
  }, 0)
}

test('seed 12345 has a locked immutable simulation result', () => {
  const result = simulateMatch({ seed: 12345 })

  assert.deepEqual(result, {
    seed: 12345,
    rulesetId: 'mvp-baseline-v1',
    status: 'completed',
    clashCount: 46,
    burnCount: 48,
    terminalResult: 'win',
    terminalReason: 'opponentUnableToReveal',
    winner: 'player',
    estimatedDurationMs: 77200,
  })
  assert.ok(allObjects(result).every(Object.isFrozen))
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result)
})

test('simulation metrics reconcile with committed events and final zones', () => {
  const { match, events } = directBaselineRun(12345)
  const result = simulateMatch({ seed: 12345 })
  const burned = events.reduce(
    (total, event) => total + (event.type === 'clashSettled' ? event.burned.length : 0),
    0,
  )

  assert.equal(result.clashCount, events.length)
  assert.equal(result.clashCount, match.turn)
  assert.equal(result.burnCount, burned)
  assert.equal(result.burnCount, match.zones.burnPile.length)
  assert.equal(result.terminalResult, match.outcome.result)
  assert.equal(result.terminalReason, match.outcome.reason)
  assert.equal(result.winner, match.outcome.winner)
  assert.equal(result.estimatedDurationMs, expectedDuration(events))
})

test('repeated single and ordered corpus runs are deterministic', () => {
  assert.deepEqual(
    simulateMatch({ seed: 0 }),
    simulateMatch({ seed: 0 }),
  )

  const options = { seeds: [4, 0, 4294967295] }
  const first = createSimulationReport(options)
  const second = createSimulationReport(options)
  assert.deepEqual(first, second)
  assert.deepEqual(first.seeds, options.seeds)
  assert.ok(allObjects(first).every(Object.isFrozen))
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first)
})

test('canonical baseline corpus matches the statistical fixture exactly', () => {
  assert.deepEqual(CANONICAL_SIMULATION_SEEDS, Array.from(
    { length: 1000 },
    (_, seed) => seed,
  ))
  assert.deepEqual(createSimulationReport({}), REPORT_FIXTURE)
})

test('uint32 boundary seeds work without hidden Math.random calls', (t) => {
  t.mock.method(Math, 'random', () => assert.fail('Simulation must not use Math.random'))

  for (const seed of [0, UINT32_SIZE - 1]) {
    const result = simulateMatch({ seed, maxClashes: 1 })
    assert.equal(result.seed, seed)
    assert.equal(result.status, 'truncated')
    assert.equal(result.clashCount, 1)
  }
})

test('execution limits report truncation without inventing an outcome', () => {
  const result = simulateMatch({ seed: 12345, maxClashes: 1 })
  assert.deepEqual({
    status: result.status,
    clashCount: result.clashCount,
    terminalResult: result.terminalResult,
    terminalReason: result.terminalReason,
    winner: result.winner,
  }, {
    status: 'truncated',
    clashCount: 1,
    terminalResult: null,
    terminalReason: null,
    winner: null,
  })

  const report = createSimulationReport({
    seeds: [0, 1],
    maxClashes: 1,
  })
  assert.deepEqual(report.runCounts, { completed: 0, truncated: 2 })
  assert.deepEqual(report.terminalResults, {
    playerWin: 0,
    opponentWin: 0,
    draw: 0,
  })
  assert.deepEqual(report.terminalReasons, {
    opponentUnableToReveal: 0,
    playerUnableToReveal: 0,
    mutualInability: 0,
  })
})

test('burn-disabled and custom rulesets remain observable without baseline thresholds', () => {
  const disabled = simulateMatch({
    seed: 7,
    ruleset: NO_BURN_RULESET,
    maxClashes: 1,
  })
  assert.equal(disabled.rulesetId, NO_BURN_RULESET.id)
  assert.equal(disabled.burnCount, 0)
  assert.equal(disabled.status, 'truncated')

  const custom = simulateMatch({
    seed: 7,
    ruleset: {
      id: 'test-simulation-disabled-v1',
      burn: { enabled: false },
    },
    maxClashes: 1,
  })
  assert.equal(custom.rulesetId, 'test-simulation-disabled-v1')
  assert.equal(custom.burnCount, 0)
  assert.equal(custom.status, 'truncated')
})

test('simulation APIs reject malformed options and seed corpora', () => {
  const invalidRuns = [
    undefined,
    null,
    [],
    {},
    { seed: -1 },
    { seed: UINT32_SIZE },
    { seed: 1.5 },
    { seed: '1' },
    { seed: 1, maxClashes: 0 },
    { seed: 1, maxClashes: MAX_SIMULATION_CLASHES + 1 },
    { seed: 1, ruleset: {} },
    { seed: 1, extra: true },
  ]
  for (const options of invalidRuns) {
    assert.throws(() => simulateMatch(options), TypeError)
  }

  const symbolOptions = { seed: 1 }
  symbolOptions[Symbol('extra')] = true
  assert.throws(() => simulateMatch(symbolOptions), TypeError)

  const accessorOptions = {}
  Object.defineProperty(accessorOptions, 'seed', {
    enumerable: true,
    get: () => 1,
  })
  assert.throws(() => simulateMatch(accessorOptions), TypeError)

  const sparseSeeds = [0, 1]
  delete sparseSeeds[0]
  const invalidReports = [
    undefined,
    null,
    [],
    { seeds: [] },
    { seeds: sparseSeeds },
    { seeds: [0, 0] },
    { seeds: [-1] },
    { seeds: Array.from({ length: MAX_SIMULATION_SEEDS + 1 }, (_, seed) => seed) },
    { maxClashes: 0 },
    { ruleset: {} },
    { extra: true },
  ]
  for (const options of invalidReports) {
    assert.throws(() => createSimulationReport(options), TypeError)
  }
})

test('default limits and timing profile are stable immutable contracts', () => {
  assert.equal(DEFAULT_MAX_CLASHES, 10000)
  assert.deepEqual(DEFAULT_TIMING_PROFILE, {
    id: 'mvp-presentation-estimate-v1',
    unit: 'milliseconds',
    revealMs: 400,
    settlementMs: 600,
    burnMs: 200,
    terminalMs: 1200,
  })
  assert.ok(Object.isFrozen(DEFAULT_TIMING_PROFILE))
  assert.ok(Object.isFrozen(CANONICAL_SIMULATION_SEEDS))
})

test('CLI emits stable JSON and rejects malformed arguments', () => {
  const first = spawnSync(process.execPath, [CLI_PATH, '--seed', '12345'], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
  })
  const second = spawnSync(process.execPath, [CLI_PATH, '--seed', '12345'], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
  })
  assert.equal(first.status, 0, first.stderr)
  assert.equal(second.status, 0, second.stderr)
  assert.equal(first.stdout, second.stdout)
  assert.deepEqual(
    JSON.parse(first.stdout),
    createSimulationReport({ seeds: [12345] }),
  )

  const malformed = spawnSync(process.execPath, [CLI_PATH, '--seed', 'not-a-seed'], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
  })
  assert.equal(malformed.status, 1)
  assert.match(malformed.stderr, /--seed must be a base-10 integer/)
  assert.equal(malformed.stdout, '')
})

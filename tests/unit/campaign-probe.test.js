import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { CAMPAIGN_ENCOUNTER_RULES } from '../../src/domain/campaign-encounter-rules.js'
import { CAMPAIGN_MAP } from '../../src/domain/campaign-map.js'

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const CLI_PATH = fileURLToPath(new URL('../../scripts/campaign-probe.js', import.meta.url))
const runCli = promisify(execFile)

test('probe output is identical twice for a small seed range', async () => {
  const args = [CLI_PATH, '--start', '0', '--count', '2']
  const options = { cwd: REPOSITORY_ROOT, encoding: 'utf8' }
  const [first, second] = await Promise.all([
    runCli(process.execPath, args, options),
    runCli(process.execPath, args, options),
  ])
  assert.equal(first.stdout, second.stdout)

  const report = JSON.parse(first.stdout)
  assert.equal(report.reportVersion, 2)
  assert.equal(report.campaignGameRulesVersion, 8)
  assert.deepEqual(report.seeds, { start: 0, count: 2 })
  assert.deepEqual(
    report.cells.map(({ nodeId, ruleId, policy, fights }) => (
      `${nodeId}:${ruleId}:${policy}:${fights}`
    )),
    CAMPAIGN_MAP.nodes
      .filter(({ kind }) => kind === 'fight')
      .flatMap(({ id }) => CAMPAIGN_ENCOUNTER_RULES.flatMap((rule) => (
        ['never', 'blind', 'informed'].map((policy) => `${id}:${rule.id}:${policy}:2`)
      ))),
  )
  for (const cell of report.cells) {
    assert.ok(cell.ruleId === 'race-to-ten-v1' || cell.raceTargetPercent === 0)
  }
})

test('probe rejects malformed arguments', () => {
  for (const [args, message] of [
    [['--policy', 'sometimes'], /--policy must be one of never, blind, informed/],
    [
      ['--rule', 'sudden-death-v1'],
      /--rule must be one of race-to-ten-v1, double-or-nothing-v1, attrition-v1/,
    ],
  ]) {
    const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, message)
    assert.equal(result.stdout, '')
  }
})

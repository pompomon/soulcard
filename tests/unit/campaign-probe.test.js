import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
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
  assert.deepEqual(report.seeds, { start: 0, count: 2 })
  assert.deepEqual(
    report.cells.map(({ nodeId, policy, fights }) => `${nodeId}:${policy}:${fights}`),
    CAMPAIGN_MAP.nodes
      .filter(({ kind }) => kind === 'fight')
      .flatMap(({ id }) => ['never', 'blind', 'informed'].map((policy) => `${id}:${policy}:2`)),
  )
})

test('probe rejects malformed arguments', () => {
  const result = spawnSync(process.execPath, [CLI_PATH, '--policy', 'sometimes'], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /--policy must be one of never, blind, informed/)
  assert.equal(result.stdout, '')
})

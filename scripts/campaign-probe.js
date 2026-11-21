import { parseArgs } from 'node:util'
import { compareCards, getCard } from '../src/domain/cards.js'
import { CAMPAIGN_MEND_OFFER_ID } from '../src/domain/campaign-content.js'
import {
  CAMPAIGN_GAME_RULES_VERSION,
  CAMPAIGN_HOLD_DECISION_STATES,
  captureCampaignHold,
  chooseCampaignEventOption,
  chooseCampaignRestOption,
  chooseCampaignReveal,
  chooseCampaignRoute,
  createCampaignRun,
  createCampaignStateFingerprint,
  getCampaignCardId,
  getEligibleHoldTargets,
  leaveCampaignShop,
  prepareCampaignReveal,
  selectCampaignReward,
  validateCampaignState,
} from '../src/domain/campaign-machine.js'
import {
  CAMPAIGN_MAP,
  CAMPAIGN_START_NODE_ID,
  getCampaignMapNode,
} from '../src/domain/campaign-map.js'
import { createRng } from '../src/domain/rng.js'
import { BASELINE_RULESET, NO_BURN_RULESET } from '../src/domain/ruleset.js'
import { DEFAULT_TIMING_PROFILE } from '../src/domain/simulation.js'

// Plays first-attempt Campaign fights with the starter deck through the real Campaign
// machine. Each fight is reached by conceding the fights before it, taking Mend and walking
// on, then dealt from the seed's initial RNG state, as a run's first fight would be.

const REPORT_VERSION = 1
const UINT32_MAX = 0xffffffff
const MAX_SEEDS = 10_000
const MAX_FIGHT_CLASHES = 100_000
const AUTO_REVEAL_MS_PER_CLASH = 400
const WALK_ON_OPTION_ID = 'walk-on'
const BLIND_HOLD_MAX_NORMAL_VALUE = 7
const DEFAULT_SEEDS = Object.freeze({ start: 0, count: 200 })
const POLICIES = Object.freeze(['never', 'blind', 'informed'])
const RULESETS = Object.freeze([BASELINE_RULESET, NO_BURN_RULESET])
const FIGHT_NODES = Object.freeze(CAMPAIGN_MAP.nodes.filter(({ kind }) => kind === 'fight'))
const FIGHT_IDS = Object.freeze(FIGHT_NODES.map(({ contentId }) => contentId))
const RULESET_IDS = Object.freeze(RULESETS.map(({ id }) => id))

function usage() {
  return [
    'Usage: npm run probe:campaign -- [--seed UINT32 | --start UINT32 --count INTEGER]',
    '                                 [--fight FIGHT_ID] [--policy never|blind|informed]',
    `                                 [--ruleset ${RULESET_IDS.join('|')}]`,
    '',
    'Plays first-attempt Campaign fights with the starter deck. Without options it runs every',
    `fight and Hold policy under ${BASELINE_RULESET.id} for seeds 0 through 199.`,
    `Fights: ${FIGHT_IDS.join(', ')}.`,
  ].join('\n')
}

function parseInteger(value, name, { allowZero, maximum }) {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new TypeError(`${name} must be a base-10 integer`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || (!allowZero && parsed === 0) || parsed > maximum) {
    throw new TypeError(`${name} is outside its supported range`)
  }
  return parsed
}

function parseSeeds(values) {
  if (values.seed !== undefined) {
    if (values.start !== undefined || values.count !== undefined) {
      throw new TypeError('--seed cannot be combined with --start or --count')
    }
    return {
      start: parseInteger(values.seed, '--seed', { allowZero: true, maximum: UINT32_MAX }),
      count: 1,
    }
  }
  if ((values.start === undefined) !== (values.count === undefined)) {
    throw new TypeError('--start and --count must be provided together')
  }
  if (values.start === undefined) return { ...DEFAULT_SEEDS }
  const start = parseInteger(values.start, '--start', { allowZero: true, maximum: UINT32_MAX })
  const count = parseInteger(values.count, '--count', { allowZero: false, maximum: MAX_SEEDS })
  if (start + count > UINT32_MAX + 1) {
    throw new TypeError('The requested seed range exceeds uint32')
  }
  return { start, count }
}

function parseChoice(value, name, choices) {
  if (value === undefined) return choices
  if (!choices.includes(value)) {
    throw new TypeError(`${name} must be one of ${choices.join(', ')}`)
  }
  return [value]
}

function parseArguments(args) {
  const { values, tokens } = parseArgs({
    args,
    strict: true,
    tokens: true,
    options: {
      help: { type: 'boolean' },
      seed: { type: 'string' },
      start: { type: 'string' },
      count: { type: 'string' },
      fight: { type: 'string' },
      policy: { type: 'string' },
      ruleset: { type: 'string' },
    },
  })
  const names = tokens.filter(({ kind }) => kind === 'option').map(({ name }) => name)
  const repeated = names.find((name, index) => names.indexOf(name) !== index)
  if (repeated !== undefined) throw new TypeError(`--${repeated} may be provided only once`)
  if (values.help) {
    if (args.length !== 1) throw new TypeError('--help cannot be combined with other options')
    return { help: true }
  }
  const fightIds = parseChoice(values.fight, '--fight', FIGHT_IDS)
  const rulesetIds = parseChoice(values.ruleset ?? BASELINE_RULESET.id, '--ruleset', RULESET_IDS)
  return {
    seeds: parseSeeds(values),
    fightNodes: FIGHT_NODES.filter(({ contentId }) => fightIds.includes(contentId)),
    policies: parseChoice(values.policy, '--policy', POLICIES),
    rulesets: RULESETS.filter(({ id }) => rulesetIds.includes(id)),
  }
}

// The first route the map lists from the start node to `nodeId`, excluding `nodeId`.
function routeTo(nodeId, fromId = CAMPAIGN_START_NODE_ID) {
  if (fromId === nodeId) return []
  for (const nextId of getCampaignMapNode(fromId).next) {
    const rest = routeTo(nodeId, nextId)
    if (rest !== null) return [fromId, ...rest]
  }
  return null
}

function step(run) {
  return run.journal.length
}

// Re-seals a stable state edited by the probe, which the machine then validates in full.
function reseal(run) {
  run.stateFingerprint = createCampaignStateFingerprint(run)
  return validateCampaignState(run)
}

function revealNormally(run) {
  const transition = prepareCampaignReveal(run)
  return CAMPAIGN_HOLD_DECISION_STATES.includes(transition.match.machineState)
    ? chooseCampaignReveal(transition.match, 'normal')
    : transition
}

// Ends a fight on the way to the probed one as a win without drawing from the RNG: the
// opponent's undealt cards move to the player's won pile, so it can't reveal.
function concede(input) {
  const run = structuredClone(input)
  const { zones } = run.encounter
  zones.player.wonPile.push(...zones.opponentSourcePile.splice(0))
  const { match } = revealNormally(reseal(run))
  if (match.machineState !== 'awaitingReward') {
    throw new Error(`Conceding ${input.encounter.id} did not open its reward`)
  }
  return match
}

function passThrough(input, nodeId) {
  const run = chooseCampaignRoute(input, { nodeId, step: step(input) })
  const decision = { nodeId, step: step(run) }
  switch (getCampaignMapNode(nodeId).kind) {
    case 'fight': {
      const won = concede(run)
      return selectCampaignReward(won, {
        ...decision,
        step: step(won),
        offerId: CAMPAIGN_MEND_OFFER_ID,
        targetInstanceId: null,
      })
    }
    case 'shop':
      return leaveCampaignShop(run, decision)
    case 'event':
      return chooseCampaignEventOption(run, {
        ...decision,
        optionId: WALK_ON_OPTION_ID,
        targetInstanceId: null,
      })
    default:
      return chooseCampaignRestOption(run, {
        ...decision,
        optionId: WALK_ON_OPTION_ID,
        targetInstanceId: null,
      })
  }
}

function seatFight(nodeId, seed, ruleset) {
  let run = createCampaignRun({ runId: `probe-${seed}`, seed, ruleset })
  for (const viaId of routeTo(nodeId)) run = passThrough(run, viaId)
  const dealt = structuredClone(run)
  dealt.rng = createRng(seed).snapshot()
  return chooseCampaignRoute(reseal(dealt), { nodeId, step: step(run) })
}

function cardValue(run, instanceId) {
  return getCard(getCampaignCardId(run, instanceId)).value
}

// Blind and informed play capture the highest-ranked eligible card into an empty Hold.
function captureTarget(run, policy) {
  if (policy === 'never' || run.hold !== null) return null
  const targets = getEligibleHoldTargets(run)
  if (targets.length === 0) return null
  return targets.reduce((best, target) => (
    cardValue(run, target.instanceId) > cardValue(run, best.instanceId) ? target : best
  )).instanceId
}

// The opponent's next card, as Hold Insight shows it. The opponent's supply doesn't depend
// on the choice, so resolving a normal reveal on the frozen input reads it exactly.
function opponentNextCard(prepared) {
  const { reveals } = chooseCampaignReveal(prepared, 'normal').event
  return reveals.find(({ suppliedBy }) => suppliedBy === 'opponent')?.cardId ?? null
}

function revealChoice(prepared, policy) {
  const { candidate } = prepared.holdChoice
  if (prepared.hold === null) return 'normal'
  if (candidate === null) return 'hold'
  if (policy === 'blind') {
    const normal = cardValue(prepared, candidate)
    return normal <= BLIND_HOLD_MAX_NORMAL_VALUE && cardValue(prepared, prepared.hold) > normal
      ? 'hold'
      : 'normal'
  }
  const opponentCard = opponentNextCard(prepared)
  if (opponentCard === null) return 'normal'
  const normalWins = compareCards(getCampaignCardId(prepared, candidate), opponentCard) > 0
  const heldWins = compareCards(getCampaignCardId(prepared, prepared.hold), opponentCard) > 0
  return !normalWins && heldWins ? 'hold' : 'normal'
}

function eventDurationMs(event) {
  let durationMs = event.reveals.length * DEFAULT_TIMING_PROFILE.revealMs
  if (event.type === 'clashSettled') {
    durationMs += DEFAULT_TIMING_PROFILE.settlementMs
    durationMs += event.burned.length * DEFAULT_TIMING_PROFILE.burnMs
  }
  return durationMs
}

function playFight(seated, policy) {
  let run = seated
  let clashes = 0
  let durationMs = DEFAULT_TIMING_PROFILE.terminalMs
  while (run.machineState === 'ready') {
    if (clashes === MAX_FIGHT_CLASHES) {
      throw new Error(`${seated.encounter.id} did not end within ${MAX_FIGHT_CLASHES} clashes`)
    }
    const target = captureTarget(run, policy)
    if (target !== null) run = captureCampaignHold(run, target)
    let transition = prepareCampaignReveal(run)
    if (CAMPAIGN_HOLD_DECISION_STATES.includes(transition.match.machineState)) {
      transition = chooseCampaignReveal(transition.match, revealChoice(transition.match, policy))
    }
    run = transition.match
    clashes += 1
    durationMs += eventDurationMs(transition.event) + AUTO_REVEAL_MS_PER_CLASH
  }
  return { result: fightResult(run.encounter.outcome), clashes, seconds: durationMs / 1000 }
}

function fightResult(outcome) {
  if (outcome.result === 'draw') return 'draw'
  if (outcome.result === 'win') return outcome.winner === 'player' ? 'win' : 'loss'
  throw new Error(`Unknown encounter result ${outcome.result}`)
}

function round1(value) {
  return Math.round(value * 10) / 10
}

// Nearest-rank quantile of an ascending list.
function quantile(sorted, fraction) {
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)]
}

function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    median: round1(quantile(sorted, 0.5)),
    p95: round1(quantile(sorted, 0.95)),
    max: round1(sorted.at(-1)),
  }
}

function probeCell(node, ruleset, policy, seeds) {
  const fights = []
  for (let seed = seeds.start; seed < seeds.start + seeds.count; seed += 1) {
    fights.push(playFight(seatFight(node.id, seed, ruleset), policy))
  }
  const count = (result) => fights.filter((fight) => fight.result === result).length
  const percent = (result) => round1((100 * count(result)) / fights.length)
  const clashes = fights.map((fight) => fight.clashes)
  return {
    ruleset: ruleset.id,
    fightId: node.contentId,
    nodeId: node.id,
    policy,
    fights: fights.length,
    winPercent: percent('win'),
    lossPercent: percent('loss'),
    drawPercent: percent('draw'),
    clashes: {
      mean: round1(clashes.reduce((sum, value) => sum + value, 0) / clashes.length),
      ...distribution(clashes),
    },
    autoRevealSeconds: distribution(fights.map((fight) => fight.seconds)),
  }
}

function createReport({ seeds, fightNodes, policies, rulesets }) {
  const cells = []
  for (const ruleset of rulesets) {
    for (const node of fightNodes) {
      for (const policy of policies) cells.push(probeCell(node, ruleset, policy, seeds))
    }
  }
  return {
    reportVersion: REPORT_VERSION,
    campaignGameRulesVersion: CAMPAIGN_GAME_RULES_VERSION,
    timing: {
      profile: DEFAULT_TIMING_PROFILE.id,
      autoRevealMsPerClash: AUTO_REVEAL_MS_PER_CLASH,
    },
    seeds,
    cells,
  }
}

try {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(`${usage()}\n`)
  } else {
    process.stdout.write(`${JSON.stringify(createReport(options), null, 2)}\n`)
  }
} catch (error) {
  process.stderr.write(`${error.message}\n\n${usage()}\n`)
  process.exitCode = 1
}

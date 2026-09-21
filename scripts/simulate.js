import {
  CANONICAL_SIMULATION_SEEDS,
  MAX_SIMULATION_CLASHES,
  MAX_SIMULATION_SEEDS,
  createSimulationReport,
} from '../src/domain/simulation.js'

const UINT32_MAX = 0xffffffff

function usage() {
  return [
    'Usage: npm run simulate -- [--seed UINT32 | --start UINT32 --count INTEGER]',
    '                          [--max-clashes INTEGER]',
    '',
    'Without seed options, runs the canonical seed corpus 0 through 999.',
  ].join('\n')
}

function parseInteger(value, name, { allowZero, maximum }) {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d*)$/.test(value)
  ) {
    throw new TypeError(`${name} must be a base-10 integer`)
  }
  const parsed = Number(value)
  if (
    !Number.isSafeInteger(parsed) ||
    (!allowZero && parsed === 0) ||
    parsed > maximum
  ) {
    throw new TypeError(`${name} is outside its supported range`)
  }
  return parsed
}

function readOption(args, index, seen) {
  const name = args[index]
  if (seen.has(name)) {
    throw new TypeError(`${name} may be provided only once`)
  }
  if (index + 1 >= args.length || args[index + 1].startsWith('--')) {
    throw new TypeError(`${name} requires a value`)
  }
  seen.add(name)
  return args[index + 1]
}

function parseArguments(args) {
  const seen = new Set()
  const parsed = {}

  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]
    if (name === '--help') {
      if (args.length !== 1) {
        throw new TypeError('--help cannot be combined with other options')
      }
      return { help: true }
    }
    if (!['--seed', '--start', '--count', '--max-clashes'].includes(name)) {
      throw new TypeError(`Unknown option: ${name}`)
    }
    parsed[name] = readOption(args, index, seen)
  }

  if (Object.hasOwn(parsed, '--seed')) {
    if (Object.hasOwn(parsed, '--start') || Object.hasOwn(parsed, '--count')) {
      throw new TypeError('--seed cannot be combined with --start or --count')
    }
  } else if (
    Object.hasOwn(parsed, '--start') !== Object.hasOwn(parsed, '--count')
  ) {
    throw new TypeError('--start and --count must be provided together')
  }

  const options = {}
  if (Object.hasOwn(parsed, '--seed')) {
    options.seeds = [
      parseInteger(parsed['--seed'], '--seed', {
        allowZero: true,
        maximum: UINT32_MAX,
      }),
    ]
  } else if (Object.hasOwn(parsed, '--start')) {
    const start = parseInteger(parsed['--start'], '--start', {
      allowZero: true,
      maximum: UINT32_MAX,
    })
    const count = parseInteger(parsed['--count'], '--count', {
      allowZero: false,
      maximum: MAX_SIMULATION_SEEDS,
    })
    if (start + count > UINT32_MAX + 1) {
      throw new TypeError('The requested seed range exceeds uint32')
    }
    options.seeds = Array.from({ length: count }, (_, offset) => start + offset)
  } else {
    options.seeds = [...CANONICAL_SIMULATION_SEEDS]
  }

  if (Object.hasOwn(parsed, '--max-clashes')) {
    options.maxClashes = parseInteger(
      parsed['--max-clashes'],
      '--max-clashes',
      { allowZero: false, maximum: MAX_SIMULATION_CLASHES },
    )
  }
  return options
}

try {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(`${usage()}\n`)
  } else {
    const report = createSimulationReport(options)
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  }
} catch (error) {
  process.stderr.write(`${error.message}\n\n${usage()}\n`)
  process.exitCode = 1
}

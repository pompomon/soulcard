const ALGORITHM = 'mulberry32'
const UINT32_SIZE = 0x100000000

function validateUint32(value, name) {
  if (!Number.isInteger(value) || value < 0 || value >= UINT32_SIZE) {
    throw new TypeError(`${name} must be an unsigned 32-bit integer`)
  }
}

function generator(seed, initialState) {
  let state = initialState

  return Object.freeze({
    next() {
      state = (state + 0x6D2B79F5) >>> 0
      let value = Math.imul(state ^ (state >>> 15), state | 1)
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
      return ((value ^ (value >>> 14)) >>> 0) / UINT32_SIZE
    },
    snapshot() {
      return { algorithm: ALGORITHM, seed, state }
    },
  })
}

// Deterministic gameplay randomness, not suitable for cryptographic use.
export function createRng(seed) {
  validateUint32(seed, 'seed')
  return generator(seed >>> 0, seed >>> 0)
}

export function restoreRng(snapshot) {
  if (
    snapshot === null ||
    typeof snapshot !== 'object' ||
    Array.isArray(snapshot) ||
    Object.keys(snapshot).length !== 3 ||
    !['algorithm', 'seed', 'state'].every((key) => Object.hasOwn(snapshot, key))
  ) {
    throw new TypeError('RNG snapshot must contain algorithm, seed, and state')
  }
  if (snapshot.algorithm !== ALGORITHM) {
    throw new TypeError('Unsupported RNG algorithm')
  }
  validateUint32(snapshot.seed, 'seed')
  validateUint32(snapshot.state, 'state')
  return generator(snapshot.seed >>> 0, snapshot.state >>> 0)
}

export function shuffle(items, rng) {
  if (!Array.isArray(items)) {
    throw new TypeError('Shuffle input must be a dense array')
  }
  for (let index = 0; index < items.length; index += 1) {
    if (!Object.hasOwn(items, index)) {
      throw new TypeError('Shuffle input must be a dense array')
    }
  }
  if (typeof rng?.next !== 'function') {
    throw new TypeError('Shuffle requires an RNG with a next method')
  }

  const result = items.slice()
  // Descending Fisher–Yates: exactly one draw per index, including self-swaps.
  for (let index = result.length - 1; index > 0; index -= 1) {
    const draw = rng.next()
    if (!Number.isFinite(draw) || draw < 0 || draw >= 1) {
      throw new TypeError('RNG next() must return a finite number in [0, 1)')
    }
    const target = Math.floor(draw * (index + 1))
    const item = result[index]
    result[index] = result[target]
    result[target] = item
  }
  return result
}

const ALGORITHM = 'mulberry32'
const UINT32_SIZE = 0x100000000
const STREAM_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const FNV_OFFSET_BASIS = 0x811C9DC5
const FNV_PRIME = 0x01000193

function validateUint32(value, name) {
  if (!Number.isInteger(value) || value < 0 || value >= UINT32_SIZE) {
    throw new TypeError(`${name} must be an unsigned 32-bit integer`)
  }
}

function nextDraw(rng) {
  const draw = rng.next()
  if (!Number.isFinite(draw) || draw < 0 || draw >= 1) {
    throw new TypeError('RNG next() must return a finite number in [0, 1)')
  }
  return draw
}

// MurmurHash3 fmix32 finalizer.
function mix32(value) {
  let hash = value >>> 0
  hash = Math.imul(hash ^ (hash >>> 16), 0x85EBCA6B) >>> 0
  hash = Math.imul(hash ^ (hash >>> 13), 0xC2B2AE35) >>> 0
  return (hash ^ (hash >>> 16)) >>> 0
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

// Derives an independent stream seed: FNV-1a over the ASCII stream name, then
// fmix32(hash XOR seed), then fmix32(hash XOR index).
export function deriveRngSeed(seed, stream, index) {
  validateUint32(seed, 'seed')
  if (typeof stream !== 'string' || !STREAM_PATTERN.test(stream)) {
    throw new TypeError('stream must be a lowercase hyphenated ASCII name')
  }
  validateUint32(index, 'index')
  let hash = FNV_OFFSET_BASIS
  for (let offset = 0; offset < stream.length; offset += 1) {
    hash = Math.imul(hash ^ stream.charCodeAt(offset), FNV_PRIME) >>> 0
  }
  hash = mix32(hash ^ seed)
  return mix32(hash ^ index)
}

export function createDerivedRng(seed, stream, index) {
  return createRng(deriveRngSeed(seed, stream, index))
}

export function drawIndex(size, rng) {
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new RangeError('Index draws require a positive safe-integer size')
  }
  if (typeof rng?.next !== 'function') {
    throw new TypeError('Index draws require an RNG with a next method')
  }
  return Math.floor(nextDraw(rng) * size)
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
    const draw = nextDraw(rng)
    const target = Math.floor(draw * (index + 1))
    const item = result[index]
    result[index] = result[target]
    result[target] = item
  }
  return result
}

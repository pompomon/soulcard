// public/sw.js repeats this prefix and never deletes caches that start with it.
export const ART_CACHE_PREFIX = 'soulcard-art-'
export const TAROT_HD_CACHE_NAME = `${ART_CACHE_PREFIX}tarot-hd`
export const ART_PACK_CONTENT_TYPE = 'image/webp'
export const ART_PACK_FAILURE_CODES = Object.freeze([
  'network',
  'integrity',
  'quota',
  'unsupported',
  'missing',
])

const DEFAULT_CONCURRENCY = 4
const MAX_CONCURRENCY = 16
const ASSET_ID_PATTERN = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const DIGEST_PARAMETER = 'soulcard-sha256'

export class ArtPackError extends Error {
  constructor(code, message, { assetId = null, cause = undefined } = {}) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'ArtPackError'
    this.code = code
    this.assetId = assetId
  }
}

function defaultCacheStorage() {
  try {
    return globalThis.caches ?? null
  } catch {
    return null
  }
}

function defaultStorageManager() {
  try {
    return globalThis.navigator?.storage ?? null
  } catch {
    return null
  }
}

function defaultFetch(...args) {
  return globalThis.fetch(...args)
}

async function defaultDigest(buffer) {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) {
    throw new ArtPackError('unsupported', 'SubtleCrypto is unavailable in this context')
  }
  const digest = new Uint8Array(await subtle.digest('SHA-256', buffer))
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function isAbsoluteUrl(value) {
  try {
    return new URL(value).href.length > 0
  } catch {
    return false
  }
}

function normalizeManifest(manifest) {
  if (!Array.isArray(manifest) || manifest.length === 0) {
    throw new TypeError('manifest must be a non-empty array')
  }
  const ids = new Set()
  const keys = new Set()
  const entries = manifest.map((file, index) => {
    const name = `manifest[${index}]`
    if (file === null || typeof file !== 'object') {
      throw new TypeError(`${name} must be an object`)
    }
    const { id, url, bytes, sha256 } = file
    if (typeof id !== 'string' || !ASSET_ID_PATTERN.test(id)) {
      throw new TypeError(`${name}.id is invalid`)
    }
    if (typeof url !== 'string' || !isAbsoluteUrl(url)) {
      throw new TypeError(`${name}.url must be an absolute URL`)
    }
    if (!Number.isSafeInteger(bytes) || bytes < 1) {
      throw new TypeError(`${name}.bytes must be a positive integer`)
    }
    if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) {
      throw new TypeError(`${name}.sha256 must be a lowercase hex SHA-256 digest`)
    }
    // The digest is part of the key, so a revised file never matches a stale entry.
    const key = new URL(url)
    key.searchParams.set(DIGEST_PARAMETER, sha256)
    if (ids.has(id) || keys.has(key.href)) {
      throw new TypeError(`${name} duplicates another manifest entry`)
    }
    ids.add(id)
    keys.add(key.href)
    return Object.freeze({ id, url, bytes, sha256, key: key.href })
  })
  return Object.freeze(entries)
}

function assertConcurrency(concurrency) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    throw new TypeError(`concurrency must be an integer from 1 through ${MAX_CONCURRENCY}`)
  }
}

function contentType(response) {
  try {
    const value = response.headers?.get?.('content-type')
    return typeof value === 'string' ? value.split(';')[0].trim().toLowerCase() : ''
  } catch {
    return ''
  }
}

function storageFailure(error, entry) {
  if (error?.name === 'QuotaExceededError') {
    return new ArtPackError('quota', 'Storage is full', { assetId: entry.id, cause: error })
  }
  return new ArtPackError('unsupported', `Could not store ${entry.id}`, {
    assetId: entry.id,
    cause: error,
  })
}

function createCacheBackend(cache) {
  return Object.freeze({
    persistent: true,
    async listKeys() {
      const requests = await cache.keys()
      return requests.map((request) => (typeof request === 'string' ? request : request.url))
    },
    async get(key) {
      const response = await cache.match(key)
      return response ? response.blob() : null
    },
    async set(key, buffer) {
      await cache.put(key, new Response(buffer, {
        headers: {
          'content-length': String(buffer.byteLength),
          'content-type': ART_PACK_CONTENT_TYPE,
        },
      }))
    },
    async remove(key) {
      await cache.delete(key)
    },
  })
}

function createMemoryBackend() {
  const blobs = new Map()
  return Object.freeze({
    persistent: false,
    async listKeys() {
      return [...blobs.keys()]
    },
    async get(key) {
      return blobs.get(key) ?? null
    },
    async set(key, buffer) {
      blobs.set(key, new Blob([buffer], { type: ART_PACK_CONTENT_TYPE }))
    },
    async remove(key) {
      blobs.delete(key)
    },
    clear() {
      blobs.clear()
    },
  })
}

export function createArtPackStore({
  manifest,
  cacheName = TAROT_HD_CACHE_NAME,
  caches = defaultCacheStorage(),
  fetch = defaultFetch,
  digest = defaultDigest,
  storage = defaultStorageManager(),
  concurrency = DEFAULT_CONCURRENCY,
} = {}) {
  const entries = normalizeManifest(manifest)
  if (
    typeof cacheName !== 'string'
    || !cacheName.startsWith(ART_CACHE_PREFIX)
    || cacheName.length === ART_CACHE_PREFIX.length
  ) {
    throw new TypeError(`cacheName must start with ${ART_CACHE_PREFIX}`)
  }
  if (caches !== null && typeof caches?.open !== 'function') {
    throw new TypeError('caches must implement CacheStorage or be null')
  }
  if (typeof fetch !== 'function') throw new TypeError('fetch must be a function')
  if (typeof digest !== 'function') throw new TypeError('digest must be a function')
  assertConcurrency(concurrency)

  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const manifestKeys = new Set(entries.map((entry) => entry.key))
  const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0)
  let backendPromise = null
  let memoryBackend = null
  let persistent = caches !== null

  function useMemory() {
    persistent = false
    memoryBackend ??= createMemoryBackend()
    return memoryBackend
  }

  function openBackend() {
    backendPromise ??= (async () => {
      if (caches === null) return useMemory()
      try {
        return createCacheBackend(await caches.open(cacheName))
      } catch {
        return useMemory()
      }
    })()
    return backendPromise
  }

  async function storedKeys(backend) {
    try {
      return new Set(await backend.listKeys())
    } catch (error) {
      throw new ArtPackError('unsupported', 'Could not list stored art', { cause: error })
    }
  }

  // caches.open() creates a missing cache, so inspection checks first and never
  // leaves an empty art cache behind for a player who hasn't downloaded the pack.
  async function cacheMissing() {
    if (backendPromise !== null || caches === null || typeof caches.has !== 'function') {
      return false
    }
    try {
      return (await caches.has(cacheName)) === false && backendPromise === null
    } catch {
      return false
    }
  }

  async function inspect() {
    if (await cacheMissing()) {
      return Object.freeze({
        complete: false,
        storedFiles: 0,
        totalFiles: entries.length,
        storedBytes: 0,
        totalBytes,
        staleEntries: 0,
        persistent,
      })
    }
    const backend = await openBackend()
    const keys = await storedKeys(backend)
    let storedFiles = 0
    let storedBytes = 0
    for (const entry of entries) {
      if (!keys.has(entry.key)) continue
      storedFiles += 1
      storedBytes += entry.bytes
    }
    let staleEntries = 0
    for (const key of keys) {
      if (!manifestKeys.has(key)) staleEntries += 1
    }
    return Object.freeze({
      complete: storedFiles === entries.length,
      storedFiles,
      totalFiles: entries.length,
      storedBytes,
      totalBytes,
      staleEntries,
      persistent: backend.persistent,
    })
  }

  async function assertCapacity(missingBytes) {
    if (typeof storage?.estimate !== 'function') return
    let estimate
    try {
      estimate = await storage.estimate()
    } catch {
      return
    }
    const { quota, usage } = estimate ?? {}
    if (Number.isFinite(quota) && Number.isFinite(usage) && quota - usage < missingBytes) {
      throw new ArtPackError('quota', 'Not enough storage for the art pack')
    }
  }

  async function fetchVerified(entry, signal) {
    let response
    let buffer
    try {
      response = await fetch(entry.url, { signal })
    } catch (error) {
      signal.throwIfAborted()
      throw new ArtPackError('network', `Could not download ${entry.id}`, {
        assetId: entry.id,
        cause: error,
      })
    }
    if (!response?.ok) {
      throw new ArtPackError('network', `${entry.id} returned HTTP ${response?.status}`, {
        assetId: entry.id,
      })
    }
    if (contentType(response) !== ART_PACK_CONTENT_TYPE) {
      throw new ArtPackError('integrity', `${entry.id} is not ${ART_PACK_CONTENT_TYPE}`, {
        assetId: entry.id,
      })
    }
    try {
      buffer = await response.arrayBuffer()
    } catch (error) {
      signal.throwIfAborted()
      throw new ArtPackError('network', `Could not read ${entry.id}`, {
        assetId: entry.id,
        cause: error,
      })
    }
    if (buffer.byteLength !== entry.bytes) {
      throw new ArtPackError('integrity', `${entry.id} has an unexpected size`, {
        assetId: entry.id,
      })
    }
    let actual
    try {
      actual = await digest(buffer)
    } catch (error) {
      if (error instanceof ArtPackError) throw error
      throw new ArtPackError('unsupported', `Could not verify ${entry.id}`, {
        assetId: entry.id,
        cause: error,
      })
    }
    if (actual !== entry.sha256) {
      throw new ArtPackError('integrity', `${entry.id} failed its digest check`, {
        assetId: entry.id,
      })
    }
    return buffer
  }

  async function download({ signal = undefined, onProgress = () => {} } = {}) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) {
      throw new TypeError('signal must be an AbortSignal')
    }
    if (typeof onProgress !== 'function') throw new TypeError('onProgress must be a function')
    signal?.throwIfAborted()
    const backend = await openBackend()
    const keys = await storedKeys(backend)
    signal?.throwIfAborted()
    const missing = entries.filter((entry) => !keys.has(entry.key))
    let loadedBytes = totalBytes - missing.reduce((sum, entry) => sum + entry.bytes, 0)
    const report = () => {
      try {
        onProgress(Object.freeze({ loadedBytes, totalBytes }))
      } catch {}
    }
    report()

    if (missing.length > 0) {
      const controller = new AbortController()
      const forwardAbort = () => controller.abort(signal.reason)
      signal?.addEventListener('abort', forwardAbort, { once: true })
      let failure = null
      let next = 0
      const worker = async () => {
        while (!controller.signal.aborted && next < missing.length) {
          const entry = missing[next]
          next += 1
          try {
            const buffer = await fetchVerified(entry, controller.signal)
            controller.signal.throwIfAborted()
            try {
              await backend.set(entry.key, buffer)
            } catch (error) {
              throw storageFailure(error, entry)
            }
            loadedBytes += entry.bytes
            report()
          } catch (error) {
            if (!controller.signal.aborted) {
              failure = error instanceof ArtPackError
                ? error
                : new ArtPackError('network', `Could not download ${entry.id}`, {
                  assetId: entry.id,
                  cause: error,
                })
              controller.abort(failure)
            }
            return
          }
        }
      }
      try {
        if (backend.persistent) await assertCapacity(totalBytes - loadedBytes)
        signal?.throwIfAborted()
        await Promise.all(
          Array.from({ length: Math.min(concurrency, missing.length) }, worker),
        )
      } finally {
        signal?.removeEventListener('abort', forwardAbort)
      }
      if (failure) throw failure
      signal?.throwIfAborted()
    }

    let pruned = 0
    try {
      pruned = await prune()
    } catch {}
    return Object.freeze({
      downloadedFiles: missing.length,
      skippedFiles: entries.length - missing.length,
      loadedBytes,
      totalBytes,
      prunedEntries: pruned,
      persistent: backend.persistent,
    })
  }

  async function read(id) {
    const entry = byId.get(id)
    if (!entry) throw new RangeError(`Unknown art-pack asset: ${String(id)}`)
    const backend = await openBackend()
    let blob
    try {
      blob = await backend.get(entry.key)
    } catch (error) {
      throw new ArtPackError('missing', `Could not read ${id}`, { assetId: id, cause: error })
    }
    if (!blob) throw new ArtPackError('missing', `${id} is not stored`, { assetId: id })
    return blob
  }

  // Removes entries the manifest no longer lists, such as files from an older art
  // revision, but only once the current pack is complete.
  async function prune() {
    const backend = await openBackend()
    const keys = await storedKeys(backend)
    if (!entries.every((entry) => keys.has(entry.key))) return 0
    const stale = [...keys].filter((key) => !manifestKeys.has(key))
    await Promise.all(stale.map((key) => backend.remove(key)))
    return stale.length
  }

  async function clear() {
    memoryBackend?.clear()
    if (caches === null || !persistent) return true
    backendPromise = null
    try {
      await caches.delete(cacheName)
      return true
    } catch {
      return false
    }
  }

  return Object.freeze({
    inspect,
    download,
    read,
    prune,
    clear,
    get persistent() {
      return persistent
    },
    get totalBytes() {
      return totalBytes
    },
    get cacheName() {
      return cacheName
    },
  })
}

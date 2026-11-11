import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  ART_CACHE_PREFIX,
  ART_PACK_FAILURE_CODES,
  ArtPackError,
  TAROT_HD_CACHE_NAME,
  createArtPackStore,
} from '../../src/persistence/art-pack-store.js'

const BASE = 'https://example.test/soulcard/assets/'
const STALE_KEY = `${BASE}tarot-hd-art-c-2S-old.webp`

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function createPack(count = 6) {
  const files = new Map()
  const manifest = []
  for (let index = 0; index < count; index += 1) {
    const id = index === 0 ? 'back' : `c-${index + 1}S`
    const bytes = new TextEncoder().encode(`${id}:`.repeat(index + 2))
    const url = `${BASE}tarot-hd-art-${id}-h${index}.webp`
    files.set(url, bytes)
    manifest.push(Object.freeze({ id, url, bytes: bytes.byteLength, sha256: sha256(bytes) }))
  }
  return { files, manifest: Object.freeze(manifest) }
}

class FakeCache {
  constructor(storage) {
    this.storage = storage
    this.entries = new Map()
  }

  async keys() {
    return [...this.entries.keys()].map((url) => ({ url }))
  }

  async match(key) {
    return this.entries.get(String(key))?.clone()
  }

  async put(key, response) {
    const { quotaAfter } = this.storage
    if (quotaAfter !== null && this.entries.size >= quotaAfter) {
      throw new DOMException('Storage is full', 'QuotaExceededError')
    }
    this.storage.puts.push(String(key))
    this.entries.set(String(key), response)
  }

  async delete(key) {
    return this.entries.delete(String(key))
  }
}

class FakeCacheStorage {
  constructor({ failOpen = false, quotaAfter = null } = {}) {
    this.failOpen = failOpen
    this.quotaAfter = quotaAfter
    this.caches = new Map()
    this.deleted = []
    this.puts = []
    this.opens = 0
  }

  async has(name) {
    return this.caches.has(name)
  }

  async open(name) {
    this.opens += 1
    if (this.failOpen) throw new DOMException('Denied', 'SecurityError')
    if (!this.caches.has(name)) this.caches.set(name, new FakeCache(this))
    return this.caches.get(name)
  }

  async delete(name) {
    this.deleted.push(name)
    return this.caches.delete(name)
  }
}

function abortable(promise, signal) {
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then((value) => {
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    }, reject)
  })
}

function webp(bytes, init = {}) {
  return new Response(bytes, {
    ...init,
    headers: { 'content-type': 'image/webp', ...init.headers },
  })
}

function createFetch(files, {
  respond = undefined,
  wait = () => new Promise((resolve) => setTimeout(resolve, 1)),
  honourAbort = true,
} = {}) {
  const state = { inFlight: 0, maxInFlight: 0, requests: [] }
  async function fetch(url, { signal } = {}) {
    state.requests.push(url)
    state.inFlight += 1
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight)
    try {
      const pending = wait(url)
      await (honourAbort ? abortable(pending, signal) : pending)
      const custom = respond?.(url)
      if (custom) return custom
      const bytes = files.get(url)
      return bytes ? webp(bytes) : new Response('missing', { status: 404 })
    } finally {
      state.inFlight -= 1
    }
  }
  return { fetch, state }
}

function cacheKeys(cacheStorage) {
  const cache = cacheStorage.caches.get(TAROT_HD_CACHE_NAME)
  return cache ? [...cache.entries.keys()].sort() : []
}

function manifestKey(entry) {
  const key = new URL(entry.url)
  key.searchParams.set('soulcard-sha256', entry.sha256)
  return key.href
}

async function rejectsWithCode(promise, code, assetId = undefined) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ArtPackError, `expected ArtPackError, got ${error}`)
    assert.equal(error.code, code)
    if (assetId !== undefined) assert.equal(error.assetId, assetId)
    return true
  })
}

test('the art cache prefix matches the one the service worker preserves', async () => {
  const source = await readFile(new URL('../../public/sw.js', import.meta.url), 'utf8')
  const cachePrefix = source.match(/const CACHE_PREFIX = '([^']+)'/)[1]
  const artSuffix = source.match(/const ART_CACHE_PREFIX = `\$\{CACHE_PREFIX\}([^`]+)`/)[1]
  assert.equal(`${cachePrefix}${artSuffix}`, ART_CACHE_PREFIX)
  assert.equal(TAROT_HD_CACHE_NAME, 'soulcard-art-tarot-hd')
  assert.ok(TAROT_HD_CACHE_NAME.startsWith(ART_CACHE_PREFIX))
  assert.deepEqual(ART_PACK_FAILURE_CODES, [
    'network',
    'integrity',
    'quota',
    'unsupported',
    'missing',
  ])
})

test('inspection reports complete, incomplete, revised, and stale packs', async () => {
  const { files, manifest } = createPack()
  const caches = new FakeCacheStorage()
  const { fetch } = createFetch(files)
  const store = createArtPackStore({ manifest, caches, fetch })
  const totalBytes = manifest.reduce((sum, entry) => sum + entry.bytes, 0)

  assert.equal(store.totalBytes, totalBytes)
  assert.equal(store.cacheName, TAROT_HD_CACHE_NAME)
  assert.deepEqual(await store.inspect(), {
    complete: false,
    storedFiles: 0,
    totalFiles: 6,
    storedBytes: 0,
    totalBytes,
    staleEntries: 0,
    persistent: true,
  })

  await store.download()
  const complete = await store.inspect()
  assert.equal(complete.complete, true)
  assert.equal(complete.storedFiles, 6)
  assert.equal(complete.storedBytes, totalBytes)
  assert.ok(Object.isFrozen(complete))

  // A revised file keeps its URL in development builds; its digest changes the key.
  const revisedBytes = new TextEncoder().encode('revised back')
  const revised = [
    { ...manifest[0], bytes: revisedBytes.byteLength, sha256: sha256(revisedBytes) },
    ...manifest.slice(1),
  ]
  const revisedStore = createArtPackStore({ manifest: revised, caches, fetch })
  const inspection = await revisedStore.inspect()
  assert.equal(inspection.complete, false)
  assert.equal(inspection.storedFiles, 5)
  assert.equal(inspection.storedBytes, totalBytes - manifest[0].bytes)
  assert.equal(inspection.staleEntries, 1)
})

test('inspection never creates the art cache before a download does', async () => {
  const { files, manifest } = createPack()
  const caches = new FakeCacheStorage()
  const { fetch } = createFetch(files)
  const store = createArtPackStore({ manifest, caches, fetch })
  const totalBytes = manifest.reduce((sum, entry) => sum + entry.bytes, 0)

  const empty = await store.inspect()
  assert.deepEqual(empty, {
    complete: false,
    storedFiles: 0,
    totalFiles: 6,
    storedBytes: 0,
    totalBytes,
    staleEntries: 0,
    persistent: true,
  })
  assert.ok(Object.isFrozen(empty))
  assert.equal(caches.opens, 0)
  assert.equal(caches.caches.has(TAROT_HD_CACHE_NAME), false)

  await store.download()
  assert.equal((await store.inspect()).complete, true)
  assert.equal((await createArtPackStore({ manifest, caches, fetch }).inspect()).complete, true)

  assert.equal(await store.clear(), true)
  const opensAfterClear = caches.opens
  assert.equal((await store.inspect()).storedFiles, 0)
  assert.equal(caches.opens, opensAfterClear)
  assert.equal(caches.caches.has(TAROT_HD_CACHE_NAME), false)

  // If has() fails, inspection opens the cache as before.
  const failing = new FakeCacheStorage()
  failing.has = async () => {
    throw new DOMException('Denied', 'SecurityError')
  }
  assert.equal((await createArtPackStore({ manifest, caches: failing, fetch }).inspect()).storedFiles, 0)
  assert.equal(failing.opens, 1)
})

test('download stores only verified files with monotonic progress and bounded concurrency', async () => {
  const { files, manifest } = createPack(10)
  const caches = new FakeCacheStorage()
  const { fetch, state } = createFetch(files)
  const store = createArtPackStore({ manifest, caches, fetch, concurrency: 3 })
  const progress = []

  const summary = await store.download({ onProgress: (value) => progress.push(value) })
  const totalBytes = store.totalBytes
  assert.deepEqual(summary, {
    downloadedFiles: 10,
    skippedFiles: 0,
    loadedBytes: totalBytes,
    totalBytes,
    prunedEntries: 0,
    persistent: true,
  })
  assert.equal(state.requests.length, 10)
  assert.ok(state.maxInFlight <= 3, `max in flight ${state.maxInFlight}`)
  assert.ok(state.maxInFlight >= 2, 'downloads overlap')
  assert.equal(progress.length, 11)
  assert.deepEqual(progress[0], { loadedBytes: 0, totalBytes })
  assert.deepEqual(progress.at(-1), { loadedBytes: totalBytes, totalBytes })
  for (let index = 1; index < progress.length; index += 1) {
    assert.ok(progress[index].loadedBytes > progress[index - 1].loadedBytes)
    assert.equal(progress[index].totalBytes, totalBytes)
  }
  assert.deepEqual(cacheKeys(caches), manifest.map(manifestKey).sort())

  const stored = await caches.caches.get(TAROT_HD_CACHE_NAME).match(manifestKey(manifest[3]))
  assert.equal(stored.headers.get('content-type'), 'image/webp')
  assert.equal(stored.headers.get('content-length'), String(manifest[3].bytes))
  const blob = await store.read(manifest[3].id)
  assert.equal(blob.type, 'image/webp')
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), files.get(manifest[3].url))

  // Files already present are skipped; progress starts from the stored bytes.
  const cache = caches.caches.get(TAROT_HD_CACHE_NAME)
  await cache.delete(manifestKey(manifest[2]))
  await cache.delete(manifestKey(manifest[7]))
  state.requests.length = 0
  progress.length = 0
  const resumed = await store.download({ onProgress: (value) => progress.push(value) })
  assert.deepEqual(state.requests.sort(), [manifest[2].url, manifest[7].url].sort())
  assert.equal(resumed.downloadedFiles, 2)
  assert.equal(resumed.skippedFiles, 8)
  assert.equal(progress[0].loadedBytes, totalBytes - manifest[2].bytes - manifest[7].bytes)
  assert.equal(progress.at(-1).loadedBytes, totalBytes)

  state.requests.length = 0
  const throwingListener = await store.download({
    onProgress() {
      throw new Error('listener failed')
    },
  })
  assert.equal(throwingListener.downloadedFiles, 0)
  assert.deepEqual(state.requests, [])
})

test('an abort keeps finished verified files and stores nothing else', async () => {
  const { files, manifest } = createPack(4)
  const gates = new Map(manifest.map((entry) => [entry.url, Promise.withResolvers()]))
  const caches = new FakeCacheStorage()
  const { fetch, state } = createFetch(files, {
    wait: (url) => gates.get(url).promise,
    honourAbort: false,
  })
  const store = createArtPackStore({ manifest, caches, fetch, concurrency: 2 })
  const controller = new AbortController()
  const download = store.download({ signal: controller.signal })

  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(state.requests, [manifest[0].url, manifest[1].url])
  gates.get(manifest[0].url).resolve()
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.deepEqual(cacheKeys(caches), [manifestKey(manifest[0])])

  controller.abort()
  // These responses arrive after the abort; none may be stored.
  for (const gate of gates.values()) gate.resolve()
  await assert.rejects(download, { name: 'AbortError' })
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.deepEqual(cacheKeys(caches), [manifestKey(manifest[0])])
  assert.ok(state.requests.length <= 3)
  assert.equal((await store.inspect()).storedFiles, 1)

  const before = state.requests.length
  await assert.rejects(
    store.download({ signal: AbortSignal.abort() }),
    { name: 'AbortError' },
  )
  assert.equal(state.requests.length, before)
})

test('download failures map to network, integrity, quota, and unsupported codes', async () => {
  const { files, manifest } = createPack(3)
  const target = manifest[1]
  const cases = [
    ['network', () => new Response('error', { status: 500 })],
    ['network', () => {
      throw new TypeError('Failed to fetch')
    }],
    ['integrity', () => webp(files.get(target.url), { headers: { 'content-type': 'text/html' } })],
    ['integrity', () => webp(files.get(target.url).slice(1))],
    ['integrity', () => webp(files.get(target.url).map((byte) => byte ^ 1))],
  ]
  for (const [code, respond] of cases) {
    const caches = new FakeCacheStorage()
    const { fetch } = createFetch(files, {
      respond: (url) => (url === target.url ? respond() : undefined),
    })
    const store = createArtPackStore({ manifest, caches, fetch, concurrency: 1 })
    await rejectsWithCode(store.download(), code, target.id)
    assert.ok(!cacheKeys(caches).includes(manifestKey(target)))
    assert.deepEqual(cacheKeys(caches), [manifestKey(manifest[0])])
  }

  const fullCaches = new FakeCacheStorage({ quotaAfter: 1 })
  const fullStore = createArtPackStore({
    manifest,
    caches: fullCaches,
    fetch: createFetch(files).fetch,
    concurrency: 1,
  })
  await rejectsWithCode(fullStore.download(), 'quota', manifest[1].id)

  const estimated = createFetch(files)
  const estimatedStore = createArtPackStore({
    manifest,
    caches: new FakeCacheStorage(),
    fetch: estimated.fetch,
    storage: { estimate: async () => ({ quota: 100, usage: 99 }) },
  })
  await rejectsWithCode(estimatedStore.download(), 'quota')
  assert.deepEqual(estimated.state.requests, [])

  const unverifiable = createArtPackStore({
    manifest,
    caches: new FakeCacheStorage(),
    fetch: createFetch(files).fetch,
    digest: async () => {
      throw new Error('SubtleCrypto is unavailable')
    },
  })
  await rejectsWithCode(unverifiable.download(), 'unsupported')
})

test('prune removes only unlisted entries, and only once the pack is complete', async () => {
  const { files, manifest } = createPack()
  const caches = new FakeCacheStorage()
  const store = createArtPackStore({ manifest, caches, fetch: createFetch(files).fetch })
  const cache = await caches.open(TAROT_HD_CACHE_NAME)
  await cache.put(STALE_KEY, webp(new Uint8Array([1, 2, 3])))
  await cache.put(manifestKey(manifest[0]), webp(files.get(manifest[0].url)))

  assert.equal(await store.prune(), 0)
  assert.ok(cacheKeys(caches).includes(STALE_KEY))

  const summary = await store.download()
  assert.equal(summary.prunedEntries, 1)
  assert.equal(summary.skippedFiles, 1)
  assert.deepEqual(cacheKeys(caches), manifest.map(manifestKey).sort())
  assert.equal(await store.prune(), 0)
})

test('clear deletes the cache and later reads report missing files', async () => {
  const { files, manifest } = createPack()
  const caches = new FakeCacheStorage()
  const store = createArtPackStore({ manifest, caches, fetch: createFetch(files).fetch })
  await store.download()
  assert.equal(await store.clear(), true)
  assert.deepEqual(caches.deleted, [TAROT_HD_CACHE_NAME])
  assert.equal((await store.inspect()).storedFiles, 0)
  await rejectsWithCode(store.read('back'), 'missing', 'back')
  await assert.rejects(store.read('c-1S'), RangeError)
})

test('missing or failing Cache Storage falls back to a session-only store', async () => {
  const { files, manifest } = createPack()
  let estimates = 0
  const storage = {
    async estimate() {
      estimates += 1
      return { quota: 0, usage: 0 }
    },
  }
  const fallbacks = [
    ['no caches', null],
    ['open throws', new FakeCacheStorage({ failOpen: true })],
  ]
  for (const [label, caches] of fallbacks) {
    const store = createArtPackStore({
      manifest,
      caches,
      fetch: createFetch(files).fetch,
      storage,
    })
    const summary = await store.download()
    assert.equal(summary.persistent, false, label)
    assert.equal(store.persistent, false, label)
    const inspection = await store.inspect()
    assert.equal(inspection.complete, true, label)
    assert.equal(inspection.persistent, false, label)
    const blob = await store.read(manifest[2].id)
    assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), files.get(manifest[2].url))
    assert.equal(await store.clear(), true)
    assert.equal((await store.inspect()).storedFiles, 0, label)
  }
  assert.equal(estimates, 0, 'session-only storage skips the quota estimate')
})

test('the store validates its manifest, options, and download arguments', async () => {
  const { files, manifest } = createPack(2)
  const valid = { manifest, caches: null, fetch: createFetch(files).fetch }
  const entry = manifest[0]
  for (const [overrides, message] of [
    [{ manifest: [] }, /manifest/],
    [{ manifest: null }, /manifest/],
    [{ manifest: [null] }, /manifest\[0\]/],
    [{ manifest: [{ ...entry, id: 'bad id' }] }, /id/],
    [{ manifest: [{ ...entry, url: './relative.webp' }] }, /absolute URL/],
    [{ manifest: [{ ...entry, bytes: 0 }] }, /bytes/],
    [{ manifest: [{ ...entry, sha256: entry.sha256.toUpperCase() }] }, /sha256/],
    [{ manifest: [entry, { ...entry, url: `${entry.url}?copy` }] }, /duplicates/],
    [{ manifest: [entry, { ...entry, id: 'other' }] }, /duplicates/],
    [{ cacheName: 'soulcard-shell-art' }, /cacheName/],
    [{ cacheName: ART_CACHE_PREFIX }, /cacheName/],
    [{ caches: {} }, /caches/],
    [{ fetch: null }, /fetch/],
    [{ digest: 'sha256' }, /digest/],
    [{ concurrency: 0 }, /concurrency/],
    [{ concurrency: 1.5 }, /concurrency/],
    [{ concurrency: 17 }, /concurrency/],
  ]) {
    assert.throws(() => createArtPackStore({ ...valid, ...overrides }), message)
  }
  const store = createArtPackStore(valid)
  await assert.rejects(store.download({ signal: {} }), /AbortSignal/)
  await assert.rejects(store.download({ onProgress: 1 }), /onProgress/)
})

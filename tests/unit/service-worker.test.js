import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const SERVICE_WORKER_PATH = new URL('../../public/sw.js', import.meta.url)
const SCOPE = 'https://example.test/soulcard/'

function requestKey(request) {
  return typeof request === 'string' ? request : request.url
}

function createResponse(value, { ok = true, type = 'basic' } = {}) {
  return {
    value,
    ok,
    type,
    clone() {
      return createResponse(value, { ok, type })
    },
  }
}

class FakeCache {
  constructor(scope, { failAddAll = false } = {}) {
    this.scope = scope
    this.failAddAll = failAddAll
    this.entries = new Map()
    this.added = []
  }

  async addAll(paths) {
    this.added.push([...paths])
    if (this.failAddAll) throw new Error('precache failed')
    const entries = paths.map((path) => [
      new URL(path, this.scope).href,
      createResponse(`shell:${path}`),
    ])
    for (const [key, response] of entries) this.entries.set(key, response)
  }

  async match(request) {
    return this.entries.get(requestKey(request))
  }

  async put(request, response) {
    this.entries.set(requestKey(request), response)
  }

  async keys() {
    return [...this.entries.keys()].map((url) => ({ url }))
  }

  async delete(request) {
    return this.entries.delete(requestKey(request))
  }
}

class FakeCacheStorage {
  constructor(scope, options = {}) {
    this.scope = scope
    this.options = options
    this.caches = new Map()
    this.deleted = []
  }

  async open(name) {
    if (!this.caches.has(name)) {
      this.caches.set(name, new FakeCache(this.scope, {
        failAddAll: this.options.failAddAll === name,
      }))
    }
    return this.caches.get(name)
  }

  async keys() {
    return [...this.caches.keys()]
  }

  async delete(name) {
    this.deleted.push(name)
    return this.caches.delete(name)
  }
}

function createEvent(values = {}) {
  let lifetime = null
  let response = null
  return {
    ...values,
    waitUntil(promise) {
      lifetime = Promise.resolve(promise)
    },
    respondWith(promise) {
      response = Promise.resolve(promise)
    },
    get lifetime() {
      return lifetime
    },
    get response() {
      return response
    },
  }
}

async function createHarness({ failAddAll = null, fetchImpl, registration = {} } = {}) {
  const source = await readFile(SERVICE_WORKER_PATH, 'utf8')
  const listeners = new Map()
  const cacheStorage = new FakeCacheStorage(SCOPE, { failAddAll })
  let skipWaitingCalls = 0
  let claimCalls = 0
  let fetchCalls = 0
  const self = {
    registration: { scope: SCOPE, ...registration },
    clients: {
      async claim() {
        claimCalls += 1
      },
    },
    async skipWaiting() {
      skipWaitingCalls += 1
    },
    addEventListener(type, listener) {
      listeners.set(type, listener)
    },
  }
  const fetch = async (request) => {
    fetchCalls += 1
    return fetchImpl
      ? fetchImpl(request)
      : createResponse(`network:${request.url}`)
  }

  vm.runInNewContext(source, {
    self,
    caches: cacheStorage,
    fetch,
    URL,
    Set,
    Reflect,
    Promise,
  })

  return {
    cacheStorage,
    async dispatch(type, values) {
      const event = createEvent(values)
      listeners.get(type)?.(event)
      if (event.lifetime) await event.lifetime
      return event.response ? event.response : undefined
    },
    get claimCalls() {
      return claimCalls
    },
    get fetchCalls() {
      return fetchCalls
    },
    get skipWaitingCalls() {
      return skipWaitingCalls
    },
  }
}

function request(path, {
  method = 'GET',
  mode = 'no-cors',
  destination = 'image',
} = {}) {
  return {
    url: new URL(path, SCOPE).href,
    method,
    mode,
    destination,
  }
}

test('install atomically precaches the complete relative shell without activating', async () => {
  const harness = await createHarness()
  await harness.dispatch('install')

  const shell = harness.cacheStorage.caches.get('soulcard-shell-dev')
  assert.ok(shell)
  assert.deepEqual(shell.added, [[
    './',
    './index.html',
    './manifest.webmanifest',
    './icon.svg',
    './icon-192.png',
    './icon-512.png',
    './icon-maskable-512.png',
    './apple-touch-icon.png',
  ]])
  assert.equal(harness.skipWaitingCalls, 0)

  const failing = await createHarness({ failAddAll: 'soulcard-shell-dev' })
  failing.cacheStorage.caches.set('soulcard-shell-previous', new FakeCache(SCOPE))
  await assert.rejects(failing.dispatch('install'), /precache failed/)
  assert.equal(failing.cacheStorage.caches.has('soulcard-shell-dev'), false)
  assert.equal(failing.cacheStorage.caches.has('soulcard-shell-previous'), true)
})

test('only the exact activation message advances a waiting worker', async () => {
  const harness = await createHarness()

  await harness.dispatch('message', { data: { type: 'OTHER' } })
  await harness.dispatch('message', {
    data: { type: 'SOULCARD_ACTIVATE_UPDATE', extra: true },
  })
  assert.equal(harness.skipWaitingCalls, 0)

  await harness.dispatch('message', {
    data: { type: 'SOULCARD_ACTIVATE_UPDATE' },
  })
  assert.equal(harness.skipWaitingCalls, 1)
})

test('activation removes only obsolete Soulcard caches before claiming clients', async () => {
  const harness = await createHarness()
  for (const name of [
    'soulcard-old',
    'soulcard-shell-old',
    'soulcard-runtime-old',
    'soulcard-shell-dev',
    'soulcard-runtime-dev',
    'unrelated-cache',
  ]) {
    harness.cacheStorage.caches.set(name, new FakeCache(SCOPE))
  }

  await harness.dispatch('activate')

  assert.deepEqual(
    [...harness.cacheStorage.caches.keys()].sort(),
    [
      'soulcard-active-dev',
      'soulcard-runtime-dev',
      'soulcard-shell-dev',
      'unrelated-cache',
    ],
  )
  assert.equal(harness.claimCalls, 1)
})

test('activation preserves the latest shell for a newer viable worker', async () => {
  const harness = await createHarness({ registration: { installing: {} } })
  for (const name of [
    'soulcard-shell-obsolete',
    'soulcard-shell-dev',
    'soulcard-runtime-dev',
    'soulcard-shell-next',
  ]) {
    harness.cacheStorage.caches.set(name, new FakeCache(SCOPE))
  }

  await harness.dispatch('activate')

  assert.deepEqual(
    [...harness.cacheStorage.caches.keys()].sort(),
    [
      'soulcard-active-dev',
      'soulcard-runtime-dev',
      'soulcard-shell-dev',
      'soulcard-shell-next',
    ],
  )
})

test('install bounds superseded revisions while preserving active and waiting shells', async () => {
  const harness = await createHarness()
  for (const name of [
    'soulcard-active-live',
    'soulcard-shell-live',
    'soulcard-runtime-live',
    'soulcard-shell-superseded',
    'soulcard-shell-waiting',
    'soulcard-runtime-orphaned',
    'unrelated-cache',
  ]) {
    harness.cacheStorage.caches.set(name, new FakeCache(SCOPE))
  }

  await harness.dispatch('install')

  assert.deepEqual(
    [...harness.cacheStorage.caches.keys()].sort(),
    [
      'soulcard-active-live',
      'soulcard-runtime-live',
      'soulcard-shell-dev',
      'soulcard-shell-live',
      'soulcard-shell-waiting',
      'unrelated-cache',
    ],
  )
})

test('install bounds superseded revisions when upgrading from a markerless worker', async () => {
  const harness = await createHarness()
  for (const name of [
    'soulcard-shell-live',
    'soulcard-runtime-live',
    'soulcard-shell-superseded',
    'soulcard-shell-waiting',
    'soulcard-runtime-orphaned',
    'unrelated-cache',
  ]) {
    harness.cacheStorage.caches.set(name, new FakeCache(SCOPE))
  }

  await harness.dispatch('install')

  assert.deepEqual(
    [...harness.cacheStorage.caches.keys()].sort(),
    [
      'soulcard-runtime-live',
      'soulcard-shell-dev',
      'soulcard-shell-live',
      'soulcard-shell-waiting',
      'unrelated-cache',
    ],
  )
})

test('install preserves a legacy active cache before markerless waiting shells', async () => {
  const harness = await createHarness()
  for (const name of [
    'soulcard-live',
    'soulcard-shell-superseded',
    'soulcard-shell-waiting',
    'soulcard-runtime-orphaned',
    'unrelated-cache',
  ]) {
    harness.cacheStorage.caches.set(name, new FakeCache(SCOPE))
  }

  await harness.dispatch('install')

  assert.deepEqual(
    [...harness.cacheStorage.caches.keys()].sort(),
    [
      'soulcard-live',
      'soulcard-shell-dev',
      'soulcard-shell-waiting',
      'unrelated-cache',
    ],
  )
})

test('scoped navigation and shell assets use one coherent offline shell', async () => {
  const harness = await createHarness({
    fetchImpl: async () => {
      throw new Error('offline')
    },
  })
  await harness.dispatch('install')

  const navigation = await harness.dispatch('fetch', {
    request: request('./deep/link', { mode: 'navigate', destination: '' }),
  })
  assert.equal((await navigation).value, 'shell:./index.html')

  const icon = await harness.dispatch('fetch', {
    request: request('./icon.svg'),
  })
  assert.equal((await icon).value, 'shell:./icon.svg')
  assert.equal(harness.fetchCalls, 0)
})

test('runtime caching is same-origin, successful, asset-only, and bounded', async () => {
  const harness = await createHarness()
  for (let index = 0; index < 33; index += 1) {
    const response = await harness.dispatch('fetch', {
      request: request(`./runtime-${index}.png`),
    })
    assert.equal((await response).value, `network:${SCOPE}runtime-${index}.png`)
  }

  const runtime = harness.cacheStorage.caches.get('soulcard-runtime-dev')
  assert.equal(runtime.entries.size, 32)
  assert.equal(runtime.entries.has(`${SCOPE}runtime-0.png`), false)
  assert.equal(runtime.entries.has(`${SCOPE}runtime-32.png`), true)

  for (const rejectedRequest of [
    request('https://cdn.example.test/image.png'),
    request('./mutation.png', { method: 'POST' }),
    request('./dynamic.js', { destination: 'script' }),
  ]) {
    assert.equal(
      await harness.dispatch('fetch', { request: rejectedRequest }),
      undefined,
    )
  }

  const failedHarness = await createHarness({
    fetchImpl: () => createResponse('failed', { ok: false }),
  })
  const failed = await failedHarness.dispatch('fetch', {
    request: request('./failed.png'),
  })
  assert.equal((await failed).value, 'failed')
  assert.equal(
    failedHarness.cacheStorage.caches.get('soulcard-runtime-dev').entries.size,
    0,
  )
})

const CACHE_PREFIX = 'soulcard-'
const BUILD_REVISION = /* INJECT_BUILD_REVISION */ 'dev'
const SHELL_CACHE = `${CACHE_PREFIX}shell-${BUILD_REVISION}`
const RUNTIME_CACHE = `${CACHE_PREFIX}runtime-${BUILD_REVISION}`
const ACTIVE_CACHE_PREFIX = `${CACHE_PREFIX}active-`
const ACTIVE_CACHE = `${ACTIVE_CACHE_PREFIX}${BUILD_REVISION}`
const SHELL_CACHE_PREFIX = `${CACHE_PREFIX}shell-`
const RUNTIME_CACHE_PREFIX = `${CACHE_PREFIX}runtime-`
const BUILD_ASSETS = /* INJECT_BUILD_ASSETS */ []
const APP_SHELL = BUILD_ASSETS.length > 0
  ? BUILD_ASSETS
  : [
      './',
      './index.html',
      './manifest.webmanifest',
      './icon.svg',
      './icon-192.png',
      './icon-512.png',
      './icon-maskable-512.png',
      './apple-touch-icon.png',
    ]
const ACTIVATE_UPDATE_MESSAGE = 'SOULCARD_ACTIVATE_UPDATE'
const MAX_RUNTIME_ENTRIES = 32
const RUNTIME_DESTINATIONS = new Set(['audio', 'font', 'image'])
const SCOPE_URL = new URL('./', self.registration.scope)
const INDEX_URL = new URL('./index.html', SCOPE_URL).href
const SHELL_URLS = new Set(APP_SHELL.map((path) => new URL(path, SCOPE_URL).href))

function isExactActivationMessage(data) {
  return (
    data !== null
    && typeof data === 'object'
    && !Array.isArray(data)
    && Reflect.ownKeys(data).length === 1
    && data.type === ACTIVATE_UPDATE_MESSAGE
  )
}

function isScopedUrl(url) {
  return url.origin === SCOPE_URL.origin && url.href.startsWith(SCOPE_URL.href)
}

async function precacheShell() {
  try {
    const cache = await caches.open(SHELL_CACHE)
    await cache.addAll(APP_SHELL)
    await cleanSupersededInstallCaches()
  } catch (error) {
    await caches.delete(SHELL_CACHE)
    throw error
  }
}

async function cleanSupersededInstallCaches() {
  const keys = await caches.keys()
  const activeMarker = [...keys]
    .reverse()
    .find((key) => key.startsWith(ACTIVE_CACHE_PREFIX))
  const legacyCache = activeMarker
    ? null
    : keys.find((key) => (
        key.startsWith(CACHE_PREFIX)
        && !key.startsWith(ACTIVE_CACHE_PREFIX)
        && !key.startsWith(SHELL_CACHE_PREFIX)
        && !key.startsWith(RUNTIME_CACHE_PREFIX)
      ))
  const previousShells = keys.filter((key) => (
    key.startsWith(SHELL_CACHE_PREFIX)
    && key !== SHELL_CACHE
  ))
  const activeRevision = activeMarker
    ? activeMarker.slice(ACTIVE_CACHE_PREFIX.length)
    : legacyCache?.slice(CACHE_PREFIX.length)
      ?? previousShells.at(0)?.slice(SHELL_CACHE_PREFIX.length)
  if (!activeRevision) return

  const activeShell = legacyCache ? null : `${SHELL_CACHE_PREFIX}${activeRevision}`
  const activeRuntime = legacyCache ? null : `${RUNTIME_CACHE_PREFIX}${activeRevision}`
  const otherShells = previousShells.filter((key) => key !== activeShell)
  const currentWaitingShell = otherShells.at(-1)
  const preservedCaches = new Set([
    ...(legacyCache ? [legacyCache] : [activeShell, activeRuntime]),
    SHELL_CACHE,
    RUNTIME_CACHE,
    currentWaitingShell,
  ])
  if (activeMarker) preservedCaches.add(activeMarker)

  await Promise.all(
    keys
      .filter((key) => key.startsWith(CACHE_PREFIX) && !preservedCaches.has(key))
      .map((key) => caches.delete(key)),
  )
}

async function cleanObsoleteCaches() {
  const currentCaches = new Set([ACTIVE_CACHE, SHELL_CACHE, RUNTIME_CACHE])
  const keys = await caches.keys()
  const nextWorkerCount = Number(Boolean(self.registration.installing))
    + Number(Boolean(self.registration.waiting))
  const nextShells = nextWorkerCount > 0
    ? keys
        .filter((key) => key.startsWith(SHELL_CACHE_PREFIX) && key !== SHELL_CACHE)
        .slice(-nextWorkerCount)
    : []
  for (const nextShell of nextShells) currentCaches.add(nextShell)
  await Promise.all(
    keys
      .filter((key) => key.startsWith(CACHE_PREFIX) && !currentCaches.has(key))
      .map((key) => caches.delete(key)),
  )
  await caches.open(ACTIVE_CACHE)
}

async function trimRuntimeCache(cache) {
  const requests = await cache.keys()
  const excess = requests.length - MAX_RUNTIME_ENTRIES
  if (excess > 0) {
    await Promise.all(requests.slice(0, excess).map((request) => cache.delete(request)))
  }
}

function canRuntimeCache(request, url) {
  return (
    request.method === 'GET'
    && isScopedUrl(url)
    && RUNTIME_DESTINATIONS.has(request.destination)
  )
}

self.addEventListener('install', (event) => {
  event.waitUntil(precacheShell())
})

self.addEventListener('message', (event) => {
  if (!isExactActivationMessage(event.data)) return
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    cleanObsoleteCaches().then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (!isScopedUrl(url)) return

  if (request.mode === 'navigate') {
    event.respondWith(
      caches.open(SHELL_CACHE).then(async (cache) => (
        await cache.match(INDEX_URL)
        ?? await cache.match(new URL('./', SCOPE_URL).href)
        ?? fetch(request)
      )),
    )
    return
  }

  if (SHELL_URLS.has(url.href)) {
    event.respondWith(
      caches.open(SHELL_CACHE).then(async (cache) => (
        await cache.match(request)
        ?? fetch(request)
      )),
    )
    return
  }

  if (!canRuntimeCache(request, url)) return
  event.respondWith(
    caches.open(RUNTIME_CACHE).then(async (cache) => {
      const cached = await cache.match(request)
      if (cached) return cached

      const response = await fetch(request)
      if (response.ok && response.type !== 'opaque') {
        await cache.put(request, response.clone())
        await trimRuntimeCache(cache)
      }
      return response
    }),
  )
})

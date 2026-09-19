const CACHE_PREFIX = 'soulcard-'
const BUILD_REVISION = /* INJECT_BUILD_REVISION */ 'dev'
const CACHE_NAME = `${CACHE_PREFIX}${BUILD_REVISION}`
const BUILD_ASSETS = /* INJECT_BUILD_ASSETS */ []
const APP_SHELL = ['./', './index.html', './manifest.webmanifest', './icon.svg', ...BUILD_ASSETS]

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      ),
    ),
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(async (response) => {
          if (response.ok) {
            const cache = await caches.open(CACHE_NAME)
            await cache.put('./index.html', response.clone())
          }
          return response
        })
        .catch(() => caches.match('./index.html')),
    )
    return
  }

  event.respondWith(
    caches.match(event.request).then(
      (cached) =>
        cached ||
        fetch(event.request).then(async (response) => {
          if (response.ok && new URL(event.request.url).origin === self.location.origin) {
            const cache = await caches.open(CACHE_NAME)
            await cache.put(event.request, response.clone())
          }
          return response
        }),
    ),
  )
})

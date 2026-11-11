import { CARD_ART_OPTIONS } from '../app/settings.js'
import {
  CARD_ART_THEME_SELECTIONS,
  createCardArtRegistry,
} from '../app/card-art.js'

export const CARD_ART_HD_STATUSES = Object.freeze([
  'idle',
  'checking',
  'downloading',
  'preparing',
  'ready',
  'offline',
  'paused',
  'failed',
])
export const CARD_ART_FAILURE_REASONS = Object.freeze([
  'network',
  'integrity',
  'quota',
  'decode',
  'unsupported',
  'missing',
])

const PIXEL = 'tarot-pixel'
const HD = 'tarot-hd'
const RETRYABLE_STATUSES = new Set(['offline', 'paused', 'failed'])
// A read miss while HD is in use triggers one automatic re-check; a second miss
// means storage keeps losing files, so HD stops until the player retries.
const MAX_MISS_RECOVERIES = 1

// The HD theme, its manifest and the art-pack store load on first use, when
// Settings opens or HD is selected, so a pixel game never loads the HD code.
export async function loadTarotHd() {
  const [themes, assets, store] = await Promise.all([
    import('../presentation/themes/tarot-hd.js'),
    import('../presentation/themes/tarot-hd-assets.js'),
    import('../persistence/art-pack-store.js'),
  ])
  return Object.freeze({
    manifest: assets.TAROT_HD_ASSETS,
    createStore: () => store.createArtPackStore({ manifest: assets.TAROT_HD_ASSETS }),
    createThemes: () => themes.createTarotHdThemes(),
  })
}

export function supportsTarotHd() {
  try {
    return (
      typeof globalThis.createImageBitmap === 'function'
      && typeof globalThis.fetch === 'function'
      && typeof globalThis.crypto?.subtle?.digest === 'function'
    )
  } catch {
    return false
  }
}

function assertSettingsController(settingsController) {
  if (
    settingsController === null
    || typeof settingsController !== 'object'
    || typeof settingsController.getSnapshot !== 'function'
    || typeof settingsController.subscribe !== 'function'
  ) {
    throw new TypeError('settingsController must expose getSnapshot and subscribe')
  }
}

function assertThemeRegistry(registry) {
  const methods = ['registerFront', 'registerBack', 'resolveSelection', 'resolveFront', 'resolveBack']
  if (
    registry === null
    || typeof registry !== 'object'
    || methods.some((method) => typeof registry[method] !== 'function')
  ) {
    throw new TypeError('themeRegistry must implement the theme registry interface')
  }
}

function assertPack(pack) {
  if (
    pack === null
    || typeof pack !== 'object'
    || !Array.isArray(pack.manifest)
    || typeof pack.createStore !== 'function'
    || typeof pack.createThemes !== 'function'
  ) {
    throw new TypeError('loadHd must resolve to { manifest, createStore, createThemes }')
  }
}

function isAbort(error) {
  return error?.name === 'AbortError'
}

function failureReason(error, fallback) {
  return CARD_ART_FAILURE_REASONS.includes(error?.code) ? error.code : fallback
}

function reportError(error) {
  try {
    globalThis.reportError?.(error)
  } catch {}
}

// Owns the card-art choice: the theme registry, the effective theme selection
// that battlefields follow, and the HD pack's download and activation. Pixel
// stays in effect until HD is downloaded, verified and decoded.
export function createCardArtController({
  settingsController,
  themeRegistry = createCardArtRegistry(),
  loadHd = loadTarotHd,
  supportsHd = supportsTarotHd,
  windowObject = globalThis.window,
  navigatorObject = windowObject?.navigator ?? globalThis.navigator,
} = {}) {
  assertSettingsController(settingsController)
  assertThemeRegistry(themeRegistry)
  if (typeof loadHd !== 'function') throw new TypeError('loadHd must be a function')
  if (typeof supportsHd !== 'function') throw new TypeError('supportsHd must be a function')

  const listeners = new Set()
  const selectionListeners = new Set()
  let requested = null
  let effective = CARD_ART_THEME_SELECTIONS[PIXEL]
  let hd = Object.freeze({
    status: 'idle',
    loadedBytes: 0,
    totalBytes: null,
    reason: null,
    sessionOnly: false,
  })
  let snapshot = null
  let destroyed = false
  let job = null
  let packPromise = null
  let pack = null
  let themes = null
  let missRecoveries = 0
  let offlineUserInitiated = false

  function freezeSnapshot() {
    snapshot = Object.freeze({ requested: requested ?? PIXEL, effective, hd })
  }
  freezeSnapshot()

  function notify(collection, value) {
    for (const listener of [...collection]) {
      try {
        listener(value)
      } catch (error) {
        reportError(error)
      }
    }
  }

  // Theme-source listeners hear a selection change before snapshot subscribers,
  // and callers release HD bitmaps only after update() returns.
  function update({ option = undefined, ...changes } = {}) {
    let selectionChanged = false
    if (option !== undefined && CARD_ART_THEME_SELECTIONS[option] !== effective) {
      effective = CARD_ART_THEME_SELECTIONS[option]
      selectionChanged = true
    }
    if (Object.keys(changes).length > 0) hd = Object.freeze({ ...hd, ...changes })
    freezeSnapshot()
    if (selectionChanged) notify(selectionListeners, effective)
    notify(listeners, snapshot)
  }

  function isCurrent(current) {
    return !destroyed && job === current && !current.signal.aborted
  }

  // One job runs at a time. A new job aborts the previous one and waits for it to
  // settle, so downloads never overlap and nothing clears the pack mid-download.
  // The task always starts in a later microtask.
  function startJob(task) {
    const previous = job
    previous?.controller.abort()
    const controller = new AbortController()
    const current = { controller, signal: controller.signal, settled: null }
    job = current
    current.settled = (async () => {
      await previous?.settled
      if (!isCurrent(current)) return
      await task(current)
    })()
      .catch(reportError)
      .finally(() => {
        if (job === current) job = null
      })
    return current.settled
  }

  function isOffline() {
    try {
      return navigatorObject?.onLine === false
    } catch {
      return false
    }
  }

  function saveDataEnabled() {
    try {
      return navigatorObject?.connection?.saveData === true
    } catch {
      return false
    }
  }

  async function ensurePack() {
    packPromise ??= (async () => {
      const loaded = await loadHd()
      assertPack(loaded)
      const store = loaded.createStore()
      if (
        store === null
        || typeof store !== 'object'
        || ['inspect', 'download', 'read', 'clear'].some((method) => typeof store[method] !== 'function')
      ) {
        throw new TypeError('createStore must return an art-pack store')
      }
      pack = Object.freeze({ manifest: loaded.manifest, store, createThemes: loaded.createThemes })
      return pack
    })()
    try {
      return await packPromise
    } catch (error) {
      packPromise = null
      throw error
    }
  }

  // Registers the HD descriptors once, before any selection names them.
  function ensureThemes() {
    if (themes) return themes
    const created = pack.createThemes()
    themeRegistry.registerFront(created.frontTheme)
    themeRegistry.registerBack(created.backTheme)
    themes = created
    return themes
  }

  function releaseThemes() {
    try {
      themes?.release()
    } catch (error) {
      reportError(error)
    }
  }

  // Refinement reads go through here, so a file that disappears while HD is in
  // use returns the cards to pixel and checks the pack again.
  const trackedStore = Object.freeze({
    async read(id) {
      try {
        return await pack.store.read(id)
      } catch (error) {
        if (error?.code === 'missing') queueMicrotask(handleReadMiss)
        throw error
      }
    },
  })

  function enterOffline(userInitiated) {
    offlineUserInitiated = userInitiated
    update({ status: 'offline', reason: null })
  }

  async function runHd(current, { userInitiated, recheckedMissing = false }) {
    update({ status: 'checking', reason: null })
    if (!supportsHd()) {
      update({ status: 'failed', reason: 'unsupported' })
      return
    }
    let loaded
    try {
      loaded = await ensurePack()
    } catch {
      if (!isCurrent(current)) return
      if (isOffline()) enterOffline(userInitiated)
      else update({ status: 'failed', reason: 'network' })
      return
    }
    if (!isCurrent(current)) return

    const { store, manifest } = loaded
    let inspection
    try {
      inspection = await store.inspect()
    } catch (error) {
      if (!isCurrent(current)) return
      update({ status: 'failed', reason: failureReason(error, 'unsupported') })
      return
    }
    if (!isCurrent(current)) return
    update({ loadedBytes: inspection.storedBytes, totalBytes: inspection.totalBytes })

    if (!inspection.complete) {
      if (!userInitiated && saveDataEnabled()) {
        update({ status: 'paused' })
        return
      }
      if (isOffline()) {
        enterOffline(userInitiated)
        return
      }
      update({ status: 'downloading' })
      try {
        await store.download({
          signal: current.signal,
          onProgress({ loadedBytes, totalBytes }) {
            if (isCurrent(current)) update({ loadedBytes, totalBytes })
          },
        })
      } catch (error) {
        if (!isCurrent(current) || isAbort(error)) return
        if (failureReason(error, 'network') === 'network' && isOffline()) {
          enterOffline(userInitiated)
        } else {
          update({ status: 'failed', reason: failureReason(error, 'network') })
        }
        return
      }
      if (!isCurrent(current)) return
    }

    update({ status: 'preparing' })
    try {
      await ensureThemes().activate({ store: trackedStore, manifest, signal: current.signal })
    } catch (error) {
      if (!isCurrent(current) || isAbort(error)) return
      if (error?.code === 'missing' && !recheckedMissing) {
        await runHd(current, { userInitiated, recheckedMissing: true })
        return
      }
      update({ status: 'failed', reason: failureReason(error, 'decode') })
      return
    }
    if (!isCurrent(current)) return
    update({ option: HD, status: 'ready', reason: null, sessionOnly: store.persistent === false })
  }

  async function refreshStored(current) {
    if (!pack) return
    let inspection
    try {
      inspection = await pack.store.inspect()
    } catch {
      return
    }
    if (!isCurrent(current)) return
    update({ loadedBytes: inspection.storedBytes, totalBytes: inspection.totalBytes })
  }

  // Pixel art is always available, so returning to it never waits for a job.
  // Subscribers move their textures first; the HD bitmaps close afterwards.
  function switchToPixel(changes) {
    job?.controller.abort()
    update({ option: PIXEL, ...changes })
    releaseThemes()
  }

  function handleReadMiss() {
    if (destroyed || requested !== HD || hd.status !== 'ready' || job !== null) return
    if (missRecoveries >= MAX_MISS_RECOVERIES) {
      switchToPixel({ status: 'failed', reason: 'missing' })
      return
    }
    missRecoveries += 1
    switchToPixel({ status: 'checking', reason: null })
    void startJob((current) => runHd(current, { userInitiated: false }))
  }

  // While offline no HD job is running; at most a Settings refresh is, and the
  // new job supersedes it.
  const handleOnline = () => {
    if (destroyed || requested !== HD || hd.status !== 'offline') return
    void startJob((current) => runHd(current, { userInitiated: offlineUserInitiated }))
  }

  function handleSettings(settings) {
    if (destroyed) return
    const next = CARD_ART_OPTIONS.includes(settings?.cardArt) ? settings.cardArt : PIXEL
    if (next === requested) return
    const startup = requested === null
    requested = next
    if (next === HD) {
      missRecoveries = 0
      update()
      // A choice made in Settings overrides Save-Data; a choice remembered from
      // an earlier session doesn't.
      void startJob((current) => runHd(current, { userInitiated: !startup }))
    } else if (startup) {
      update()
    } else {
      switchToPixel({ status: 'idle', reason: null })
      void startJob(refreshStored)
    }
  }

  windowObject?.addEventListener?.('online', handleOnline)
  let unsubscribeSettings
  try {
    unsubscribeSettings = settingsController.subscribe(handleSettings)
  } catch (error) {
    destroyed = true
    job?.controller.abort()
    windowObject?.removeEventListener?.('online', handleOnline)
    throw error
  }

  function assertActive() {
    if (destroyed) throw new Error('Card art controller has been destroyed')
  }

  function subscribe(listener) {
    assertActive()
    if (typeof listener !== 'function') {
      throw new TypeError('Card art subscriber must be a function')
    }
    listeners.add(listener)
    try {
      listener(snapshot)
    } catch (error) {
      listeners.delete(listener)
      throw error
    }
    let subscribed = true
    return () => {
      if (!subscribed) return
      subscribed = false
      listeners.delete(listener)
    }
  }

  // Asks for HD again after a failure, while offline, or when Save-Data paused it.
  function retry() {
    if (destroyed || requested !== HD || !RETRYABLE_STATUSES.has(hd.status)) {
      return Promise.resolve(false)
    }
    missRecoveries = 0
    return startJob((current) => runHd(current, { userInitiated: true })).then(() => true)
  }

  // Deletes the downloaded pack. Only offered while the pixel deck is selected.
  function removeDownload() {
    if (destroyed || requested !== PIXEL) return Promise.resolve(false)
    let removed = false
    return startJob(async (current) => {
      try {
        await ensurePack()
      } catch {
        return
      }
      if (!isCurrent(current)) return
      removed = await pack.store.clear()
      if (destroyed) return
      if (removed) update({ loadedBytes: 0 })
      else await refreshStored(current)
    }).then(() => removed)
  }

  // Reports the pack size and the bytes already stored, for the Settings screen.
  // Loads the HD code on first use but never downloads art or creates storage.
  function refresh() {
    if (destroyed) return Promise.resolve()
    if (job !== null) return job.settled
    if (requested === HD && !RETRYABLE_STATUSES.has(hd.status)) return Promise.resolve()
    return startJob(async (current) => {
      try {
        await ensurePack()
      } catch {
        return
      }
      if (!isCurrent(current)) return
      await refreshStored(current)
    })
  }

  async function whenIdle() {
    while (job !== null) await job.settled
  }

  function destroy() {
    if (destroyed) return
    destroyed = true
    job?.controller.abort()
    windowObject?.removeEventListener?.('online', handleOnline)
    unsubscribeSettings?.()
    listeners.clear()
    selectionListeners.clear()
    releaseThemes()
  }

  const themeSource = Object.freeze({
    getSelection: () => effective,
    subscribe(listener) {
      if (typeof listener !== 'function') {
        throw new TypeError('Theme source listener must be a function')
      }
      if (destroyed) return () => {}
      selectionListeners.add(listener)
      let subscribed = true
      return () => {
        if (!subscribed) return
        subscribed = false
        selectionListeners.delete(listener)
      }
    },
  })

  return Object.freeze({
    getSnapshot: () => snapshot,
    subscribe,
    retry,
    removeDownload,
    refresh,
    whenIdle,
    destroy,
    themeRegistry,
    themeSource,
  })
}

import assert from 'node:assert/strict'
import test from 'node:test'
import { CARD_ART_THEME_SELECTIONS, createCardArtRegistry } from '../../src/app/card-art.js'
import { TAROT_HD_CACHE_NAME } from '../../src/persistence/art-pack-store.js'
import {
  SETTINGS_STORAGE_KEYS,
  createSettingsRepository,
} from '../../src/persistence/settings-repository.js'
import {
  TAROT_HD_BACK_THEME_ID,
  TAROT_HD_FRONT_THEME_ID,
} from '../../src/presentation/themes/tarot-hd.js'
import { TAROT_HD_ASSETS } from '../../src/presentation/themes/tarot-hd-assets.js'
import {
  CARD_ART_FAILURE_REASONS,
  CARD_ART_HD_STATUSES,
  createCardArtController,
  loadTarotHd,
  supportsTarotHd,
} from '../../src/ui/card-art-controller.js'
import { createSettingsController } from '../../src/ui/settings-controller.js'

const PIXEL = CARD_ART_THEME_SELECTIONS['tarot-pixel']
const HD = CARD_ART_THEME_SELECTIONS['tarot-hd']
const IDS = Object.freeze(['preview', 'back', 'c-2S', 'c-3S'])
const FILE_BYTES = 250
const TOTAL_BYTES = IDS.length * FILE_BYTES
const MANIFEST = Object.freeze(IDS.map((id) => Object.freeze({
  id,
  url: `https://example.test/assets/${id}.webp`,
  bytes: FILE_BYTES,
  sha256: '0'.repeat(64),
})))

function flush() {
  return new Promise((resolve) => setImmediate(resolve))
}

async function until(predicate, label = 'condition') {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return
    await flush()
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function packError(code) {
  return Object.assign(new Error(`art pack ${code}`), { name: 'ArtPackError', code })
}

function abortable(promise, signal) {
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
    })
  })
}

function createGate(id) {
  let open
  const opened = new Promise((resolve) => {
    open = resolve
  })
  return { id, opened, open: () => open() }
}

function createStore({ stored = [], persistent = true } = {}) {
  const files = new Set(stored)
  const state = {
    inspections: 0,
    downloads: 0,
    active: 0,
    maxActive: 0,
    signals: [],
    failure: null,
    gate: null,
    unreadable: new Set(),
    clears: 0,
  }
  const storedFiles = () => IDS.filter((id) => files.has(id)).length
  return {
    files,
    state,
    get persistent() {
      return persistent
    },
    get totalBytes() {
      return TOTAL_BYTES
    },
    async inspect() {
      state.inspections += 1
      const count = storedFiles()
      return Object.freeze({
        complete: count === IDS.length,
        storedFiles: count,
        totalFiles: IDS.length,
        storedBytes: count * FILE_BYTES,
        totalBytes: TOTAL_BYTES,
        staleEntries: 0,
        persistent,
      })
    },
    async download({ signal, onProgress }) {
      assert.ok(signal instanceof AbortSignal)
      state.downloads += 1
      state.active += 1
      state.maxActive = Math.max(state.maxActive, state.active)
      state.signals.push(signal)
      try {
        let loadedBytes = storedFiles() * FILE_BYTES
        onProgress({ loadedBytes, totalBytes: TOTAL_BYTES })
        for (const id of IDS) {
          if (files.has(id)) continue
          if (state.gate?.id === id) await abortable(state.gate.opened, signal)
          await Promise.resolve()
          signal.throwIfAborted()
          if (state.failure) {
            const failure = typeof state.failure === 'function' ? state.failure() : state.failure
            state.failure = null
            throw failure
          }
          files.add(id)
          loadedBytes += FILE_BYTES
          onProgress({ loadedBytes, totalBytes: TOTAL_BYTES })
        }
      } finally {
        state.active -= 1
      }
    },
    async read(id) {
      if (!files.has(id) || state.unreadable.has(id)) throw packError('missing')
      return { id }
    },
    async clear() {
      state.clears += 1
      files.clear()
      return true
    },
  }
}

// Mirrors createTarotHdThemes: activation reads the preview and back, and a later
// activate() or release() supersedes one in progress.
function createThemes(log) {
  let active = false
  let generation = 0
  const themes = {
    frontTheme: Object.freeze({ id: TAROT_HD_FRONT_THEME_ID, create: () => ({}), refine: async () => {} }),
    backTheme: Object.freeze({ id: TAROT_HD_BACK_THEME_ID, create: () => ({}) }),
    activations: [],
    activationError: null,
    async activate({ store, manifest, signal }) {
      generation += 1
      const token = generation
      themes.activations.push({ store, manifest, signal })
      log.push('activate')
      try {
        await store.read('preview')
        await store.read('back')
      } catch (error) {
        throw Object.assign(new Error('Tarot HD art is unavailable'), { code: 'missing', cause: error })
      }
      if (themes.activationError) {
        const error = themes.activationError
        themes.activationError = null
        throw error
      }
      if (signal?.aborted || token !== generation) {
        throw new DOMException('Tarot HD activation was aborted', 'AbortError')
      }
      active = true
    },
    release() {
      generation += 1
      active = false
      log.push('release')
    },
    get active() {
      return active
    },
  }
  return themes
}

function createWindow() {
  const listeners = new Map()
  return {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(listener)
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener)
    },
    dispatch(type) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener({ type })
    },
    count(type) {
      return listeners.get(type)?.size ?? 0
    },
  }
}

function createSettings(cardArt) {
  const values = new Map([[SETTINGS_STORAGE_KEYS.cardArt, JSON.stringify(cardArt)]])
  const controller = createSettingsController({
    repository: createSettingsRepository({
      storage: {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
        removeItem: (key) => values.delete(key),
      },
    }),
    matchMedia: null,
  })
  let subscriptions = 0
  return {
    getSnapshot: controller.getSnapshot,
    setCardArt: controller.setCardArt,
    subscribe(listener) {
      subscriptions += 1
      const unsubscribe = controller.subscribe(listener)
      return () => {
        subscriptions -= 1
        unsubscribe()
      }
    },
    get subscriptions() {
      return subscriptions
    },
  }
}

function createHarness({
  cardArt = 'tarot-pixel',
  stored = [],
  persistent = true,
  onLine = true,
  saveData = false,
  supported = true,
  loadFailure = null,
  loadHd = undefined,
} = {}) {
  const log = []
  const settings = createSettings(cardArt)
  const store = createStore({ stored, persistent })
  const themes = createThemes(log)
  const loads = { count: 0, failure: loadFailure, createStore: 0, createThemes: 0 }
  const navigatorObject = { onLine, connection: { saveData } }
  const windowObject = createWindow()
  const themeRegistry = createCardArtRegistry()
  const controller = createCardArtController({
    settingsController: settings,
    themeRegistry,
    windowObject,
    navigatorObject,
    supportsHd: () => supported,
    loadHd: loadHd ?? (async () => {
      loads.count += 1
      if (loads.failure) throw loads.failure
      return {
        manifest: MANIFEST,
        createStore() {
          loads.createStore += 1
          return store
        },
        createThemes() {
          loads.createThemes += 1
          return themes
        },
      }
    }),
  })
  const snapshots = []
  const selections = []
  controller.themeSource.subscribe((selection) => {
    selections.push(selection)
    log.push(selection === HD ? 'select:hd' : 'select:pixel')
  })
  controller.subscribe((snapshot) => snapshots.push(snapshot))
  const statuses = () => snapshots
    .map(({ hd }) => hd.status)
    .filter((status, index, list) => index === 0 || list[index - 1] !== status)
  return {
    controller,
    settings,
    store,
    themes,
    loads,
    navigatorObject,
    windowObject,
    themeRegistry,
    snapshots,
    selections,
    log,
    statuses,
    hd: () => controller.getSnapshot().hd,
  }
}

async function withReportedErrors(run) {
  const errors = []
  const had = Object.hasOwn(globalThis, 'reportError')
  const original = globalThis.reportError
  globalThis.reportError = (error) => errors.push(error)
  try {
    await run(errors)
  } finally {
    if (had) globalThis.reportError = original
    else delete globalThis.reportError
  }
}

test('pixel at startup loads no HD code and publishes the pixel selection', async () => {
  const h = createHarness()
  await h.controller.whenIdle()

  assert.equal(h.loads.count, 0)
  const snapshot = h.controller.getSnapshot()
  assert.deepEqual(snapshot, {
    requested: 'tarot-pixel',
    effective: PIXEL,
    hd: { status: 'idle', loadedBytes: 0, totalBytes: null, reason: null, sessionOnly: false },
  })
  assert.ok(Object.isFrozen(snapshot))
  assert.ok(Object.isFrozen(snapshot.hd))
  assert.equal(h.controller.themeSource.getSelection(), PIXEL)
  assert.equal(h.controller.themeRegistry, h.themeRegistry)
  assert.deepEqual(h.themeRegistry.listFrontThemes().map(({ id }) => id), [
    'classic-front-v1',
    'tarot-pixel-front-v1',
  ])
  assert.deepEqual(h.selections, [])
  assert.equal(h.windowObject.count('online'), 1)
  assert.deepEqual(CARD_ART_HD_STATUSES, [
    'idle', 'checking', 'downloading', 'preparing', 'ready', 'offline', 'paused', 'failed',
  ])
  assert.deepEqual(CARD_ART_FAILURE_REASONS, [
    'network', 'integrity', 'quota', 'decode', 'unsupported', 'missing',
  ])
})

test('choosing HD downloads and activates it before the selection changes', async () => {
  const h = createHarness()
  const registeredAtSelection = []
  h.controller.themeSource.subscribe((selection) => {
    registeredAtSelection.push([
      h.themeRegistry.resolveFront(selection.frontThemeId).id,
      h.themeRegistry.resolveBack(selection.backThemeId).id,
    ])
  })

  h.settings.setCardArt('tarot-hd')
  assert.equal(h.controller.getSnapshot().requested, 'tarot-hd')
  assert.equal(h.hd().status, 'idle', 'the job starts in a later microtask')
  await h.controller.whenIdle()

  assert.deepEqual(h.statuses(), ['idle', 'checking', 'downloading', 'preparing', 'ready'])
  for (const snapshot of h.snapshots) {
    assert.equal(snapshot.effective, snapshot.hd.status === 'ready' ? HD : PIXEL)
  }
  const progress = h.snapshots
    .filter(({ hd }) => hd.status === 'downloading')
    .map(({ hd }) => hd.loadedBytes)
  assert.deepEqual(progress.filter((bytes, index) => progress.indexOf(bytes) === index), [0, 250, 500, 750, 1000])
  assert.deepEqual(h.selections, [HD])
  assert.deepEqual(registeredAtSelection, [[TAROT_HD_FRONT_THEME_ID, TAROT_HD_BACK_THEME_ID]])
  assert.deepEqual(h.hd(), {
    status: 'ready',
    loadedBytes: TOTAL_BYTES,
    totalBytes: TOTAL_BYTES,
    reason: null,
    sessionOnly: false,
  })
  assert.equal(h.controller.themeSource.getSelection(), HD)
  assert.equal(h.themes.activations.length, 1)
  assert.equal(h.themes.activations[0].manifest, MANIFEST)
  assert.notEqual(h.themes.activations[0].store, h.store, 'reads go through the tracked store')

  // Switching away and back reuses the registered descriptors.
  h.settings.setCardArt('tarot-pixel')
  h.settings.setCardArt('tarot-hd')
  await h.controller.whenIdle()
  assert.equal(h.hd().status, 'ready')
  assert.equal(h.loads.count, 1)
  assert.equal(h.loads.createThemes, 1)
  assert.equal(h.store.state.downloads, 1)
  assert.deepEqual(h.selections, [HD, PIXEL, HD])
})

test('returning to pixel notifies subscribers before closing HD bitmaps', async () => {
  const h = createHarness({ cardArt: 'tarot-hd', stored: IDS })
  await h.controller.whenIdle()
  assert.equal(h.hd().status, 'ready')
  assert.equal(h.themes.active, true)

  h.controller.subscribe(() => h.log.push('snapshot'))
  h.log.length = 0
  h.settings.setCardArt('tarot-pixel')
  assert.deepEqual(h.log, ['select:pixel', 'snapshot', 'release'])
  assert.equal(h.controller.themeSource.getSelection(), PIXEL)
  assert.equal(h.themes.active, false)
  await h.controller.whenIdle()

  assert.deepEqual(h.controller.getSnapshot(), {
    requested: 'tarot-pixel',
    effective: PIXEL,
    hd: { status: 'idle', loadedBytes: TOTAL_BYTES, totalBytes: TOTAL_BYTES, reason: null, sessionOnly: false },
  })
  assert.equal(h.store.files.size, IDS.length, 'downloaded files stay')
})

test('a complete pack activates at startup without the network', async () => {
  for (const onLine of [true, false]) {
    const h = createHarness({ cardArt: 'tarot-hd', stored: IDS, onLine })
    await h.controller.whenIdle()
    assert.deepEqual(h.statuses(), ['idle', 'checking', 'preparing', 'ready'])
    assert.equal(h.store.state.downloads, 0)
    assert.deepEqual(h.selections, [HD])
  }

  const session = createHarness({ cardArt: 'tarot-hd', stored: IDS, persistent: false })
  await session.controller.whenIdle()
  assert.equal(session.hd().status, 'ready')
  assert.equal(session.hd().sessionOnly, true)
})

test('Save-Data pauses a remembered HD choice until the player asks for it', async () => {
  const h = createHarness({ cardArt: 'tarot-hd', saveData: true })
  await h.controller.whenIdle()
  assert.deepEqual(h.hd(), {
    status: 'paused',
    loadedBytes: 0,
    totalBytes: TOTAL_BYTES,
    reason: null,
    sessionOnly: false,
  })
  assert.equal(h.store.state.downloads, 0)
  assert.equal(h.controller.getSnapshot().effective, PIXEL)

  assert.equal(await h.controller.retry(), true)
  assert.equal(h.hd().status, 'ready')
  assert.equal(h.store.state.downloads, 1)
  assert.equal(await h.controller.retry(), false, 'retry only applies after a failure, offline or pause')

  const chosen = createHarness({ saveData: true })
  chosen.settings.setCardArt('tarot-hd')
  await chosen.controller.whenIdle()
  assert.equal(chosen.hd().status, 'ready', 'a choice made in Settings overrides Save-Data')
  assert.equal(await createHarness().controller.retry(), false, 'retry needs HD selected')
})

test('offline requests resume on the online event and remember who asked', async () => {
  const h = createHarness({ cardArt: 'tarot-hd', onLine: false })
  await h.controller.whenIdle()
  assert.equal(h.hd().status, 'offline')
  assert.equal(h.store.state.downloads, 0)

  h.windowObject.dispatch('online')
  await h.controller.whenIdle()
  assert.equal(h.hd().status, 'offline', 'still offline while navigator.onLine is false')
  h.navigatorObject.onLine = true
  h.windowObject.dispatch('online')
  await h.controller.whenIdle()
  assert.equal(h.hd().status, 'ready')
  const inspections = h.store.state.inspections
  h.windowObject.dispatch('online')
  await h.controller.whenIdle()
  assert.equal(h.store.state.inspections, inspections, 'online is ignored unless offline')

  // A remembered choice that went offline still respects Save-Data later.
  const remembered = createHarness({ cardArt: 'tarot-hd', onLine: false })
  await remembered.controller.whenIdle()
  remembered.navigatorObject.onLine = true
  remembered.navigatorObject.connection.saveData = true
  remembered.windowObject.dispatch('online')
  await remembered.controller.whenIdle()
  assert.equal(remembered.hd().status, 'paused')

  // A choice made in Settings while offline downloads once the connection returns.
  const chosen = createHarness({ onLine: false, saveData: true })
  chosen.settings.setCardArt('tarot-hd')
  await chosen.controller.whenIdle()
  assert.equal(chosen.hd().status, 'offline')
  chosen.navigatorObject.onLine = true
  chosen.windowObject.dispatch('online')
  await chosen.controller.whenIdle()
  assert.equal(chosen.hd().status, 'ready')
})

test('download, load and decode failures keep pixel and report their reason', async () => {
  for (const code of ['network', 'integrity', 'quota', 'unsupported']) {
    const h = createHarness()
    h.store.state.failure = packError(code)
    h.settings.setCardArt('tarot-hd')
    await h.controller.whenIdle()
    assert.equal(h.hd().status, 'failed', code)
    assert.equal(h.hd().reason, code)
    assert.equal(h.controller.getSnapshot().effective, PIXEL)
    assert.deepEqual(h.selections, [])
    assert.equal(await h.controller.retry(), true)
    assert.equal(h.hd().status, 'ready', code)
    assert.equal(h.hd().reason, null)
  }

  const dropped = createHarness()
  dropped.store.state.failure = () => {
    dropped.navigatorObject.onLine = false
    return packError('network')
  }
  dropped.settings.setCardArt('tarot-hd')
  await dropped.controller.whenIdle()
  assert.equal(dropped.hd().status, 'offline', 'a network failure while offline waits for online')
  assert.equal(dropped.hd().loadedBytes, 0)

  const unsupported = createHarness({ supported: false })
  unsupported.settings.setCardArt('tarot-hd')
  await unsupported.controller.whenIdle()
  assert.deepEqual([unsupported.hd().status, unsupported.hd().reason], ['failed', 'unsupported'])
  assert.equal(unsupported.loads.count, 0, 'unsupported browsers never load the HD code')

  const unloadable = createHarness({ loadFailure: new TypeError('Failed to fetch module') })
  unloadable.settings.setCardArt('tarot-hd')
  await unloadable.controller.whenIdle()
  assert.deepEqual([unloadable.hd().status, unloadable.hd().reason], ['failed', 'network'])
  unloadable.loads.failure = null
  await unloadable.controller.retry()
  assert.equal(unloadable.hd().status, 'ready', 'a failed module load is retried')

  const offlineLoad = createHarness({ loadFailure: new TypeError('Failed to fetch module'), onLine: false })
  offlineLoad.settings.setCardArt('tarot-hd')
  await offlineLoad.controller.whenIdle()
  assert.equal(offlineLoad.hd().status, 'offline')

  const undecodable = createHarness({ stored: IDS })
  undecodable.themes.activationError = Object.assign(new Error('bad image'), { code: 'decode' })
  undecodable.settings.setCardArt('tarot-hd')
  await undecodable.controller.whenIdle()
  assert.deepEqual([undecodable.hd().status, undecodable.hd().reason], ['failed', 'decode'])
  assert.equal(undecodable.controller.getSnapshot().effective, PIXEL)
  await undecodable.controller.retry()
  assert.equal(undecodable.hd().status, 'ready')
})

test('switching back to pixel aborts the download and keeps finished files', async () => {
  const h = createHarness()
  h.store.state.gate = createGate('c-2S')
  h.settings.setCardArt('tarot-hd')
  await until(() => h.hd().loadedBytes === 2 * FILE_BYTES, 'two stored files')
  assert.equal(h.hd().status, 'downloading')

  h.settings.setCardArt('tarot-pixel')
  assert.equal(h.store.state.signals[0].aborted, true)
  await h.controller.whenIdle()
  assert.deepEqual(h.controller.getSnapshot(), {
    requested: 'tarot-pixel',
    effective: PIXEL,
    hd: { status: 'idle', loadedBytes: 2 * FILE_BYTES, totalBytes: TOTAL_BYTES, reason: null, sessionOnly: false },
  })
  assert.deepEqual([...h.store.files], ['preview', 'back'])
  assert.deepEqual(h.selections, [])
  assert.equal(h.themes.activations.length, 0)

  h.store.state.gate = null
  h.settings.setCardArt('tarot-hd')
  await h.controller.whenIdle()
  assert.equal(h.hd().status, 'ready')
  assert.equal(h.store.files.size, IDS.length)
  assert.equal(h.store.state.maxActive, 1)
})

test('rapid switching runs one job at a time and settles on the last choice', async () => {
  const h = createHarness()
  for (const option of ['tarot-hd', 'tarot-pixel', 'tarot-hd', 'tarot-pixel', 'tarot-hd']) {
    h.settings.setCardArt(option)
  }
  await h.controller.whenIdle()
  assert.equal(h.hd().status, 'ready')
  assert.equal(h.store.state.maxActive, 1)
  assert.equal(h.loads.createThemes, 1)
  assert.deepEqual(h.selections, [HD])

  h.settings.setCardArt('tarot-pixel')
  h.settings.setCardArt('tarot-hd')
  h.settings.setCardArt('tarot-pixel')
  await h.controller.whenIdle()
  assert.equal(h.controller.getSnapshot().effective, PIXEL)
  assert.equal(h.hd().status, 'idle')
  assert.equal(h.themes.active, false)
})

test('a read miss while HD is in use returns to pixel and checks the pack again', async () => {
  const h = createHarness({ cardArt: 'tarot-hd', stored: IDS })
  await h.controller.whenIdle()
  assert.equal(h.hd().status, 'ready')

  h.store.files.delete('c-3S')
  h.log.length = 0
  await assert.rejects(h.themes.activations[0].store.read('c-3S'), { code: 'missing' })
  await flush()
  await h.controller.whenIdle()
  assert.deepEqual(h.log, ['select:pixel', 'release', 'activate', 'select:hd'])
  assert.equal(h.hd().status, 'ready')
  assert.equal(h.store.state.downloads, 1)
  assert.deepEqual(h.selections, [HD, PIXEL, HD])

  // A second miss stops HD until the player retries.
  h.store.files.delete('c-3S')
  await assert.rejects(h.themes.activations.at(-1).store.read('c-3S'), { code: 'missing' })
  await flush()
  await h.controller.whenIdle()
  assert.deepEqual([h.hd().status, h.hd().reason], ['failed', 'missing'])
  assert.equal(h.controller.getSnapshot().effective, PIXEL)
  assert.equal(h.themes.active, false)
  assert.equal(h.store.state.downloads, 1)

  assert.equal(await h.controller.retry(), true)
  assert.equal(h.hd().status, 'ready')
  assert.equal(h.store.state.downloads, 2)
})

test('an activation that cannot read the pack checks it once more, then fails', async () => {
  const h = createHarness({ cardArt: 'tarot-hd', stored: IDS })
  h.store.state.unreadable.add('back')
  await h.controller.whenIdle()
  assert.deepEqual([h.hd().status, h.hd().reason], ['failed', 'missing'])
  assert.equal(h.themes.activations.length, 2)
  assert.equal(h.store.state.inspections, 2)
  assert.equal(h.store.state.downloads, 0)
  assert.deepEqual(h.selections, [])

  const evicted = createHarness({ cardArt: 'tarot-hd', stored: IDS })
  const read = evicted.store.read
  let evict = true
  evicted.store.read = async (id) => {
    if (evict && id === 'back') {
      evict = false
      evicted.store.files.delete('back')
    }
    return read(id)
  }
  await evicted.controller.whenIdle()
  assert.equal(evicted.hd().status, 'ready', 'the second check downloads the evicted file')
  assert.equal(evicted.store.state.downloads, 1)
})

test('removing the download clears stored files only while pixel is selected', async () => {
  const h = createHarness({ cardArt: 'tarot-hd', stored: IDS })
  await h.controller.whenIdle()
  assert.equal(await h.controller.removeDownload(), false)
  assert.equal(h.store.state.clears, 0)

  h.settings.setCardArt('tarot-pixel')
  await h.controller.whenIdle()
  assert.equal(h.hd().loadedBytes, TOTAL_BYTES)
  assert.equal(await h.controller.removeDownload(), true)
  assert.equal(h.store.state.clears, 1)
  assert.equal(h.store.files.size, 0)
  assert.equal(h.hd().loadedBytes, 0)
  assert.equal(h.hd().totalBytes, TOTAL_BYTES)

  const failing = createHarness({ stored: IDS })
  failing.store.clear = async () => false
  assert.equal(await failing.controller.removeDownload(), false)
  assert.equal(failing.hd().loadedBytes, TOTAL_BYTES, 'a failed removal reports what is still stored')
})

test('refresh reports the pack size and stored bytes without downloading', async () => {
  const h = createHarness({ stored: ['preview'] })
  await h.controller.refresh()
  assert.deepEqual(h.hd(), {
    status: 'idle',
    loadedBytes: FILE_BYTES,
    totalBytes: TOTAL_BYTES,
    reason: null,
    sessionOnly: false,
  })
  assert.equal(h.loads.count, 1)
  assert.equal(h.loads.createThemes, 0)
  assert.equal(h.store.state.downloads, 0)

  const ready = createHarness({ cardArt: 'tarot-hd', stored: IDS })
  await ready.controller.whenIdle()
  const inspections = ready.store.state.inspections
  await ready.controller.refresh()
  assert.equal(ready.store.state.inspections, inspections, 'refresh leaves HD in use alone')

  const failed = createHarness({ loadFailure: new Error('offline') })
  await failed.controller.refresh()
  assert.equal(failed.hd().totalBytes, null)
  assert.equal(failed.hd().status, 'idle')
})

test('destroy aborts work, removes listeners and closes HD bitmaps', async () => {
  const h = createHarness()
  h.store.state.gate = createGate('back')
  h.settings.setCardArt('tarot-hd')
  await until(() => h.hd().status === 'downloading', 'downloading')
  const notifications = h.snapshots.length
  assert.equal(h.settings.subscriptions, 1)

  h.controller.destroy()
  h.controller.destroy()
  assert.equal(h.store.state.signals[0].aborted, true)
  assert.equal(h.windowObject.count('online'), 0)
  assert.equal(h.settings.subscriptions, 0)
  await h.controller.whenIdle()
  assert.equal(h.snapshots.length, notifications)
  assert.throws(() => h.controller.subscribe(() => {}), /has been destroyed/)
  assert.equal(await h.controller.retry(), false)
  assert.equal(await h.controller.removeDownload(), false)
  await h.controller.refresh()
  h.controller.themeSource.subscribe(() => {})()

  const ready = createHarness({ cardArt: 'tarot-hd', stored: IDS })
  await ready.controller.whenIdle()
  ready.controller.destroy()
  assert.equal(ready.themes.active, false)
  assert.equal(ready.log.at(-1), 'release')
})

test('listener errors are isolated and reported', async () => {
  await withReportedErrors(async (errors) => {
    const h = createHarness({ stored: IDS })
    const failure = new Error('listener failed')
    let later = 0
    h.controller.themeSource.subscribe(() => {
      throw failure
    })
    h.controller.themeSource.subscribe(() => {
      later += 1
    })
    h.settings.setCardArt('tarot-hd')
    await h.controller.whenIdle()
    assert.equal(h.hd().status, 'ready')
    assert.equal(later, 1)
    assert.deepEqual(errors, [failure])
  })
})

test('the controller validates its dependencies and listeners', async () => {
  const settings = createSettings('tarot-pixel')
  assert.throws(() => createCardArtController(), /settingsController/)
  assert.throws(() => createCardArtController({ settingsController: {} }), /settingsController/)
  assert.throws(
    () => createCardArtController({ settingsController: settings, themeRegistry: {} }),
    /themeRegistry/,
  )
  assert.throws(
    () => createCardArtController({ settingsController: settings, loadHd: null }),
    /loadHd/,
  )
  assert.throws(
    () => createCardArtController({ settingsController: settings, supportsHd: true }),
    /supportsHd/,
  )

  const windowObject = createWindow()
  const failure = new Error('subscribe failed')
  assert.throws(() => createCardArtController({
    settingsController: { getSnapshot() {}, subscribe() { throw failure } },
    windowObject,
  }), failure)
  assert.equal(windowObject.count('online'), 0)

  const malformed = createHarness({ cardArt: 'tarot-hd', loadHd: async () => ({ manifest: [] }) })
  await malformed.controller.whenIdle()
  assert.equal(malformed.hd().status, 'failed')
  assert.equal(malformed.controller.getSnapshot().effective, PIXEL)

  const h = createHarness()
  assert.throws(() => h.controller.subscribe(null), TypeError)
  assert.throws(() => h.controller.themeSource.subscribe('listener'), TypeError)
  const unsubscribe = h.controller.subscribe(() => {})
  unsubscribe()
  unsubscribe()
})

test('the default loader resolves the real HD modules on demand', async () => {
  const pack = await loadTarotHd()
  assert.equal(pack.manifest, TAROT_HD_ASSETS)
  const themes = pack.createThemes()
  assert.equal(themes.frontTheme.id, TAROT_HD_FRONT_THEME_ID)
  assert.equal(themes.backTheme.id, TAROT_HD_BACK_THEME_ID)
  const registry = createCardArtRegistry()
  registry.registerFront(themes.frontTheme)
  registry.registerBack(themes.backTheme)
  assert.equal(registry.resolveSelection(HD).frontThemeId, TAROT_HD_FRONT_THEME_ID)

  const store = pack.createStore()
  assert.equal(store.cacheName, TAROT_HD_CACHE_NAME)
  assert.equal(store.totalBytes, TAROT_HD_ASSETS.reduce((sum, { bytes }) => sum + bytes, 0))
  assert.equal(
    supportsTarotHd(),
    typeof globalThis.createImageBitmap === 'function'
      && typeof globalThis.fetch === 'function'
      && typeof globalThis.crypto?.subtle?.digest === 'function',
  )
})

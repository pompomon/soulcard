import { bootstrap } from '../../src/app/bootstrap.js'
import {
  TAROT_HD_THEME_SELECTION,
  TAROT_PIXEL_THEME_SELECTION,
} from '../../src/app/card-art.js'
import { createRunController } from '../../src/app/run-controller.js'
import { CARD_IDS, RANKS } from '../../src/domain/cards.js'
import { createMatch } from '../../src/domain/match-machine.js'
import { BASELINE_RULESET } from '../../src/domain/ruleset.js'
import {
  TAROT_HD_CACHE_NAME,
  createArtPackStore,
} from '../../src/persistence/art-pack-store.js'
import { createSettingsRepository } from '../../src/persistence/settings-repository.js'
import { mountBattlefield } from '../../src/presentation/battlefield.js'
import { EVENT_PRESENTATION_TIMING } from '../../src/presentation/event-player.js'
import { createTextureCache } from '../../src/presentation/texture-cache.js'
import {
  TAROT_ART_UNIT,
  TAROT_LAYOUT,
  getTarotComposition,
  mirrorTarotBox,
} from '../../src/presentation/themes/tarot-composition.js'
import { TAROT_HD_ASSETS } from '../../src/presentation/themes/tarot-hd-assets.js'
import { renderTarotPixelFront } from '../../src/presentation/themes/tarot-pixel.js'
import {
  createCardArtController,
  loadTarotHd,
} from '../../src/ui/card-art-controller.js'

const REPORT_VERSION = 1
const TEXTURE_CACHE_BOUND = 24
const HD_READY_TEXT = 'HD card art is ready and works offline.'
const OFFLINE_TEXT = 'Connect to the internet to download HD card art. Pixel card art is in use.'
const PIXEL_TEXT = 'Pixel card art is in use.'
const REMOVED_TEXT = 'HD card art download removed. Pixel card art is in use.'
const MIN_TARGET_PX = 44
const CLASSIC_RANK_FONT = '700 34px system-ui, sans-serif'
const CLASSIC_SUIT_FONT = '32px serif'
const SUIT_GLYPHS = Object.freeze(['♠', '♥', '♦', '♣'])
// Q's tail is a descender, so its ink is taller than the other rank glyphs.
const DESCENDER_RANKS = new Set(['Q'])

const output = document.querySelector('#card-art-results')
const consoleErrors = []
const originalConsoleError = console.error.bind(console)

console.error = (...values) => {
  consoleErrors.push(values.map(String).join(' '))
  originalConsoleError(...values)
}
globalThis.addEventListener('error', (event) => {
  consoleErrors.push(event.error?.message ?? event.message)
})
globalThis.addEventListener('unhandledrejection', (event) => {
  consoleErrors.push(event.reason instanceof Error ? event.reason.message : String(event.reason))
})

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function query(selector, name) {
  const element = document.querySelector(selector)
  if (element === null) throw new Error(`${name} was not found`)
  return element
}

async function waitFor(predicate, name, timeoutMs = 20_000) {
  const startedAt = performance.now()
  while (!predicate()) {
    if (performance.now() - startedAt >= timeoutMs) {
      throw new Error(`Timed out waiting for ${name}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 16))
  }
}

function round(value, digits = 1) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]
}

function canvasCount() {
  return document.querySelectorAll('#app canvas').length
}

function targetSize(element) {
  const { width, height } = element.getBoundingClientRect()
  return Object.freeze({
    width: round(width),
    height: round(height),
    meetsMinimum: width >= MIN_TARGET_PX && height >= MIN_TARGET_PX,
  })
}

function heapObservation() {
  if (!performance.memory) return Object.freeze({ supported: false })
  return Object.freeze({
    supported: true,
    usedJSHeapSize: performance.memory.usedJSHeapSize,
    totalJSHeapSize: performance.memory.totalJSHeapSize,
  })
}

function createUpdateController() {
  const snapshot = Object.freeze({
    status: 'idle',
    updateAvailable: false,
    activationStatus: 'idle',
    reason: null,
  })
  return Object.freeze({
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listener(snapshot)
      return () => {}
    },
    requestActivation: async () => Object.freeze({ status: 'skipped' }),
    destroy: async () => {},
  })
}

function textureKey({ kind, themeId, cardId, scale }) {
  return `${kind}|${themeId}|${cardId ?? ''}|${scale}`
}

// Wraps every Game battlefield's texture cache to record the theme of each
// acquisition and how long each HD front takes to refine.
function createTextureRecorder() {
  let phase = 'setup'
  const acquisitions = []
  const refinements = []
  const diagnostics = []
  const pending = new Map()
  const seenTextures = new WeakSet()
  const caches = []
  let maxEntries = 0

  function sample(cache) {
    maxEntries = Math.max(maxEntries, cache.getStats().entries)
  }

  function factory(options) {
    let cache = null
    cache = createTextureCache({
      ...options,
      onTextureUpdate(update) {
        const key = textureKey(update)
        const started = pending.get(key)
        pending.delete(key)
        refinements.push({
          phase,
          themeId: update.themeId,
          cardId: update.cardId,
          latencyMs: started === undefined ? null : performance.now() - started.at,
        })
        if (cache !== null) sample(cache)
        options.onTextureUpdate(update)
      },
      onDiagnostic(diagnostic) {
        diagnostics.push({ phase, ...diagnostic })
      },
    })
    const record = (lease) => {
      acquisitions.push({ phase, kind: lease.kind, themeId: lease.themeId })
      if (!seenTextures.has(lease.texture)) {
        seenTextures.add(lease.texture)
        if (lease.themeId === TAROT_HD_THEME_SELECTION.frontThemeId) {
          pending.set(textureKey(lease), { at: performance.now() })
        }
      }
      sample(cache)
      return lease
    }
    const wrapped = Object.freeze({
      ...cache,
      acquireFront: (frontOptions) => record(cache.acquireFront(frontOptions)),
      acquireBack: (backOptions) => record(cache.acquireBack(backOptions)),
    })
    caches.push(wrapped)
    return wrapped
  }

  return Object.freeze({
    factory,
    setPhase(next) {
      phase = next
    },
    get cacheCount() {
      return caches.length
    },
    get current() {
      return caches.at(-1) ?? null
    },
    get maxEntries() {
      return maxEntries
    },
    themes(phaseName) {
      return [...new Set(
        acquisitions.filter((entry) => entry.phase === phaseName).map((entry) => entry.themeId),
      )].sort()
    },
    acquisitionCount(phaseName) {
      return acquisitions.filter((entry) => entry.phase === phaseName).length
    },
    refinements(phaseName) {
      return refinements.filter((entry) => entry.phase === phaseName)
    },
    diagnostics,
  })
}

function latencySummary(refinements) {
  const latencies = refinements
    .map(({ latencyMs }) => latencyMs)
    .filter((latency) => latency !== null)
  if (latencies.length === 0) return Object.freeze({ samples: 0 })
  const { revealMs } = EVENT_PRESENTATION_TIMING
  return Object.freeze({
    samples: latencies.length,
    p50Ms: round(percentile(latencies, 0.5)),
    p95Ms: round(percentile(latencies, 0.95)),
    maxMs: round(Math.max(...latencies)),
    revealMs,
    withinReveal: latencies.filter((latency) => latency <= revealMs).length,
    // In completion order, so the burst of a Game mount comes first.
    samplesMs: latencies.map((latency) => round(latency, 0)),
  })
}

// Records the controller's states, and what the Settings screen showed.
function recordCardArt(controller) {
  const states = []
  let maxProgress = 0
  let totalBytes = null
  const unsubscribe = controller.subscribe(({ requested, hd }) => {
    const state = `${requested}:${hd.status}${hd.reason === null ? '' : `:${hd.reason}`}`
    if (states.at(-1) !== state) states.push(state)
    if (hd.status === 'downloading' && hd.totalBytes > 0) {
      maxProgress = Math.max(maxProgress, hd.loadedBytes / hd.totalBytes)
    }
    totalBytes = hd.totalBytes ?? totalBytes
  })
  return Object.freeze({
    states,
    unsubscribe,
    get maxProgress() {
      return maxProgress
    },
    get totalBytes() {
      return totalBytes
    },
  })
}

function observeSettingsStatus() {
  const block = query('#app [data-card-art-status-block]', 'card-art status block')
  const status = query('#app [data-card-art-status]', 'card-art status')
  const progress = query('#app [data-card-art-progress]', 'card-art progress')
  const texts = [status.textContent]
  let maxProgress = 0
  const observer = new MutationObserver(() => {
    if (texts.at(-1) !== status.textContent) texts.push(status.textContent)
    if (!progress.hidden && progress.max > 0) {
      maxProgress = Math.max(maxProgress, progress.value / progress.max)
    }
  })
  observer.observe(block, {
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  })
  return Object.freeze({
    block,
    status,
    texts,
    get maxProgress() {
      return maxProgress
    },
    disconnect: () => observer.disconnect(),
  })
}

function createCardArtFactory(captures, { navigatorObject, gate } = {}) {
  return (options) => {
    const controller = createCardArtController({
      ...options,
      ...(navigatorObject === undefined ? {} : { navigatorObject }),
      ...(gate === undefined ? {} : {
        loadHd: async () => {
          await gate
          return loadTarotHd()
        },
      }),
    })
    captures.push({ controller, settingsController: options.settingsController })
    return controller
  }
}

function launch({ recorder, captures, settingsRepository, seed, factoryOptions }) {
  const runController = createRunController({
    repository: {
      load: async () => Object.freeze({ status: 'empty' }),
      save: async () => Object.freeze({
        status: 'saved',
        savedAt: new Date().toISOString(),
      }),
      discard: async () => Object.freeze({ status: 'discarded' }),
    },
  })
  return bootstrap({
    root: document.querySelector('#app'),
    runController,
    settingsRepository,
    matchMedia: null,
    pageLifecycleFactory: () => ({ destroy() {} }),
    updateController: createUpdateController(),
    updateNoticeFactory: () => ({ teardown() {} }),
    mountBattlefield: (host, options) => mountBattlefield(host, {
      ...options,
      textureCacheFactory: recorder.factory,
    }),
    cardArtControllerFactory: createCardArtFactory(captures, factoryOptions),
    newMatchFactory: ({ ruleset = BASELINE_RULESET } = {}) => createMatch({
      runId: `card-art-browser-${seed}`,
      seed,
      ruleset,
    }),
    confirmStartOver: () => true,
  })
}

async function startGame(app) {
  query('#app [data-action="start"]', 'Start action').click()
  await waitFor(
    () => app.activeScreen === 'game' && app.runSnapshot.saveStatus === 'saved',
    'saved Classic game',
  )
}

async function reveal(app, count) {
  for (let index = 0; index < count; index += 1) {
    const button = query('#app [data-action="reveal"]', 'Reveal action')
    const status = query('#app [data-status-host]', 'presentation status')
    await waitFor(() => button.disabled === false, 'enabled Reveal')
    const turn = app.runSnapshot.match.turn
    button.click()
    await waitFor(
      () => (
        app.runSnapshot.match?.turn === turn + 1
        && app.runSnapshot.saveStatus === 'saved'
        && status.dataset.presentationState === 'completed'
        && button.disabled === false
      ),
      `presentation of clash ${turn + 1}`,
    )
  }
}

async function gameToSettings(app) {
  query('#app [data-action="pause"]', 'Pause action').click()
  const saveAndMain = query('#app [data-action="save-main"]', 'Save & Main Menu action')
  await waitFor(() => saveAndMain.disabled === false, 'enabled Save & Main Menu')
  saveAndMain.click()
  await waitFor(() => app.activeScreen === 'main', 'Main screen')
  query('#app [data-action="settings"]', 'Settings action').click()
  await waitFor(() => app.activeScreen === 'settings', 'Settings screen')
}

async function settingsToGame(app) {
  query('#app [data-action="back"]', 'Back action').click()
  await waitFor(() => app.activeScreen === 'main', 'Main screen')
  const resume = query('#app [data-action="resume"]', 'Resume action')
  await waitFor(() => resume.disabled === false, 'enabled Resume')
  resume.click()
  await waitFor(() => app.activeScreen === 'game', 'Game screen')
  // Save & Main Menu stores the paused match, so it reopens behind the pause overlay.
  if (app.runSnapshot.match?.machineState === 'paused') {
    const resumeGame = query('#app [data-action="resume"]', 'pause overlay Resume action')
    await waitFor(() => resumeGame.disabled === false, 'enabled pause overlay Resume')
    resumeGame.click()
    const reveal = query('#app [data-action="reveal"]', 'Reveal action')
    await waitFor(
      () => app.runSnapshot.match?.machineState !== 'paused' && reveal.disabled === false,
      'resumed Game',
    )
  }
}

function chooseCardArt(value) {
  const select = query('#app [data-setting="card-art"]', 'Card art setting')
  select.value = value
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

function onlyTheme(themes, prefix, name) {
  assert(themes.length > 0, `${name} acquired no textures`)
  assert(
    themes.every((themeId) => themeId.startsWith(prefix)),
    `${name} acquired ${themes.join(', ')}, not only ${prefix}*`,
  )
}

async function verifyArtCache() {
  const cache = await caches.open(TAROT_HD_CACHE_NAME)
  const requests = await cache.keys()
  const byKey = new Map(requests.map((request) => [request.url, request]))
  let verified = 0
  let bytes = 0
  for (const asset of TAROT_HD_ASSETS) {
    const key = new URL(asset.url)
    key.searchParams.set('soulcard-sha256', asset.sha256)
    if (!byKey.has(key.href)) continue
    const body = await (await cache.match(byKey.get(key.href))).arrayBuffer()
    const digest = await crypto.subtle.digest('SHA-256', body)
    const hex = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
    if (hex === asset.sha256 && body.byteLength === asset.bytes) {
      verified += 1
      bytes += body.byteLength
    }
  }
  return Object.freeze({ entries: requests.length, verified, bytes })
}

function guardArtFetches() {
  const originalFetch = globalThis.fetch
  const artUrls = new Set(TAROT_HD_ASSETS.map(({ url }) => url))
  const blocked = []
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href)
    url.search = ''
    if (artUrls.has(url.href)) {
      blocked.push(url.pathname)
      return Promise.reject(new TypeError('Failed to fetch'))
    }
    return originalFetch.call(globalThis, input, init)
  }
  return Object.freeze({
    blocked,
    restore() {
      globalThis.fetch = originalFetch
    },
  })
}

// Rows of index-colour ink in a logical box of a 75×105 pixel-art render. The
// render is upscaled without smoothing, so art rows map to logical pixels exactly.
function artInkHeight(buffer, logicalBox, hex) {
  const red = Number.parseInt(hex.slice(1, 3), 16)
  const green = Number.parseInt(hex.slice(3, 5), 16)
  const blue = Number.parseInt(hex.slice(5, 7), 16)
  const left = logicalBox.x / TAROT_ART_UNIT
  const top = logicalBox.y / TAROT_ART_UNIT
  const right = left + logicalBox.width / TAROT_ART_UNIT
  const bottom = top + logicalBox.height / TAROT_ART_UNIT
  let first = null
  let last = null
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const offset = (y * buffer.width + x) * 4
      if (
        buffer.data[offset] === red
        && buffer.data[offset + 1] === green
        && buffer.data[offset + 2] === blue
        && buffer.data[offset + 3] === 255
      ) {
        first ??= y
        last = y
        break
      }
    }
  }
  return first === null ? 0 : (last - first + 1) * TAROT_ART_UNIT
}

// The smallest rank and suit ink of every pixel front, at both corner indices.
function tarotIndexInk() {
  const ranks = {}
  const suits = {}
  const keepMin = (heights, label, height) => {
    heights[label] = Math.min(heights[label] ?? Number.POSITIVE_INFINITY, height)
  }
  for (const cardId of CARD_IDS) {
    const { index } = getTarotComposition(cardId)
    const buffer = renderTarotPixelFront(cardId)
    for (const box of [TAROT_LAYOUT.index.rank, mirrorTarotBox(TAROT_LAYOUT.index.rank)]) {
      keepMin(ranks, index.rank, artInkHeight(buffer, box, index.color))
    }
    for (const box of [TAROT_LAYOUT.index.suit, mirrorTarotBox(TAROT_LAYOUT.index.suit)]) {
      keepMin(suits, index.glyph, artInkHeight(buffer, box, index.color))
    }
  }
  return { ranks, suits }
}

// Compares classic's corner-index ink with the Tarot pixel index ink (Tarot must be no smaller).
function classicInkHeights() {
  const context = document.createElement('canvas').getContext('2d')
  const measure = (font, labels) => {
    context.font = font
    return Object.fromEntries(labels.map((label) => {
      const metrics = context.measureText(label)
      return [label, round(metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent)]
    }))
  }
  const ranks = measure(CLASSIC_RANK_FONT, RANKS.map(({ rank }) => rank))
  const suits = measure(CLASSIC_SUIT_FONT, SUIT_GLYPHS)
  const tarot = tarotIndexInk()
  const rankHeights = Object.entries(ranks)
    .filter(([label]) => !DESCENDER_RANKS.has(label))
    .map(([, height]) => height)
  const suitHeights = Object.values(suits)
  const tarotRank = Math.min(...Object.values(tarot.ranks))
  const tarotSuit = Math.min(...Object.values(tarot.suits))
  return Object.freeze({
    classicRankFont: CLASSIC_RANK_FONT,
    classicSuitFont: CLASSIC_SUIT_FONT,
    ranks,
    suits,
    tarot,
    tarotMinimum: { rank: tarotRank, suit: tarotSuit },
    tarotNoSmaller: tarotRank >= Math.max(...rankHeights)
      && tarotSuit >= Math.max(...suitHeights),
  })
}

async function run() {
  const recorder = createTextureRecorder()
  const captures = []
  const heap = {}
  const cacheExisted = await caches.delete(TAROT_HD_CACHE_NAME)

  // 1. The pixel deck is the default.
  const firstSettings = createSettingsRepository({ storage: null })
  firstSettings.setReducedMotionOverride(false)
  let app = launch({ recorder, captures, settingsRepository: firstSettings, seed: 7 })
  await app.ready
  const firstCardArt = recordCardArt(captures[0].controller)
  recorder.setPhase('pixel-default')
  await startGame(app)
  await reveal(app, 2)
  assert(canvasCount() === 1, 'Pixel Game must retain one canvas')
  onlyTheme(recorder.themes('pixel-default'), 'tarot-pixel-', 'Pixel Game')
  assert(
    captures[0].controller.getSnapshot().effective === TAROT_PIXEL_THEME_SELECTION,
    'Pixel must be the effective card art by default',
  )
  heap.pixel = heapObservation()

  // 2. Choose HD in Settings; the download completes and the cache verifies.
  recorder.setPhase('hd-download')
  await gameToSettings(app)
  const settingsCanvasCount = canvasCount()
  const settingsStatus = observeSettingsStatus()
  assert(settingsStatus.status.textContent === PIXEL_TEXT, 'Settings must report pixel art')
  const downloadStartedAt = performance.now()
  chooseCardArt('tarot-hd')
  await waitFor(() => settingsStatus.status.textContent === HD_READY_TEXT, 'HD ready status')
  const downloadMs = performance.now() - downloadStartedAt
  settingsStatus.disconnect()
  assert(firstCardArt.maxProgress === 1, 'HD download progress must reach 100 %')
  assert(settingsStatus.maxProgress === 1, 'Settings progress bar must reach 100 %')
  const cache = await verifyArtCache()
  assert(cache.entries === TAROT_HD_ASSETS.length, 'Art cache must hold every HD file')
  assert(cache.verified === TAROT_HD_ASSETS.length, 'Every cached HD file must verify')
  heap.hdReady = heapObservation()

  // 3. HD textures in Game, refined against the reveal dwell, within 24 entries.
  recorder.setPhase('hd-game')
  await settingsToGame(app)
  await reveal(app, 6)
  await waitFor(() => recorder.current.getStats().refining === 0, 'HD refinements')
  assert(canvasCount() === 1, 'HD Game must retain one canvas')
  onlyTheme(recorder.themes('hd-game'), 'tarot-hd-', 'HD Game')
  heap.hdGame = heapObservation()
  await app.destroy()
  firstCardArt.unsubscribe()
  assert(canvasCount() === 0, 'Destroyed app must remove its canvas')

  // 4. Relaunch offline: HD activates from the cache, and a Game that started with
  // pixel switches live once it does.
  const fetchGuard = guardArtFetches()
  let openGate
  const gate = new Promise((resolve) => {
    openGate = resolve
  })
  const relaunchSettings = createSettingsRepository({ storage: null })
  relaunchSettings.setReducedMotionOverride(false)
  relaunchSettings.setCardArt('tarot-hd')
  recorder.setPhase('relaunch-pixel')
  app = launch({
    recorder,
    captures,
    settingsRepository: relaunchSettings,
    seed: 11,
    factoryOptions: { navigatorObject: { onLine: false }, gate },
  })
  await app.ready
  const relaunch = captures[1]
  const relaunchCardArt = recordCardArt(relaunch.controller)
  await startGame(app)
  await waitFor(() => recorder.acquisitionCount('relaunch-pixel') > 0, 'relaunch textures')
  onlyTheme(recorder.themes('relaunch-pixel'), 'tarot-pixel-', 'Relaunch before HD')
  const cachesBeforeSwitch = recorder.cacheCount
  recorder.setPhase('relaunch-hd')
  openGate()
  await waitFor(() => relaunch.controller.getSnapshot().hd.status === 'ready', 'relaunch HD')
  assert(
    relaunch.controller.getSnapshot().effective === TAROT_HD_THEME_SELECTION,
    'Relaunch must activate HD',
  )
  onlyTheme(recorder.themes('relaunch-hd'), 'tarot-hd-', 'Live switch to HD')
  assert(recorder.cacheCount === cachesBeforeSwitch, 'The live switch must not remount')
  await reveal(app, 4)
  await waitFor(() => recorder.current.getStats().refining === 0, 'relaunch refinements')
  onlyTheme(recorder.themes('relaunch-hd'), 'tarot-hd-', 'Relaunched HD Game')
  assert(fetchGuard.blocked.length === 0, 'Offline relaunch must not fetch HD art')
  assert(
    !relaunchCardArt.states.some((state) => state.includes('downloading')),
    'Offline relaunch must not download',
  )
  assert(canvasCount() === 1, 'Relaunched Game must retain one canvas')

  // 5. Switch back to pixel live: refinements stop. Then remove the download.
  recorder.setPhase('pixel-live')
  relaunch.settingsController.setCardArt('tarot-pixel')
  const refiningAfterSwitch = recorder.current.getStats().refining
  assert(refiningAfterSwitch === 0, 'Switching to pixel must stop refinements')
  await reveal(app, 2)
  onlyTheme(recorder.themes('pixel-live'), 'tarot-pixel-', 'Live switch to pixel')
  assert(recorder.refinements('pixel-live').length === 0, 'Pixel art must not refine')
  assert(canvasCount() === 1, 'Pixel Game must retain one canvas')
  heap.pixelAgain = heapObservation()

  recorder.setPhase('remove')
  await gameToSettings(app)
  const removeStatus = query('#app [data-card-art-status]', 'card-art status')
  const remove = query('#app [data-action="remove-hd"]', 'Remove HD download action')
  await waitFor(() => remove.hidden === false, 'Remove HD download')
  const removeTarget = targetSize(remove)
  remove.click()
  await waitFor(() => removeStatus.textContent === REMOVED_TEXT, 'removal status')
  await waitFor(() => remove.hidden === true, 'hidden Remove HD download')
  const cacheRemoved = !(await caches.has(TAROT_HD_CACHE_NAME))
  assert(cacheRemoved, 'Remove HD download must delete the art cache')
  fetchGuard.restore()
  await app.destroy()
  relaunchCardArt.unsubscribe()

  // 6. Choosing HD offline offers Retry without fetching; back online, Retry downloads.
  const retryGuard = guardArtFetches()
  const retryNavigator = { onLine: false }
  const retrySettings = createSettingsRepository({ storage: null })
  retrySettings.setReducedMotionOverride(false)
  recorder.setPhase('retry')
  app = launch({
    recorder,
    captures,
    settingsRepository: retrySettings,
    seed: 13,
    factoryOptions: { navigatorObject: retryNavigator },
  })
  await app.ready
  const retryCardArt = recordCardArt(captures[2].controller)
  query('#app [data-action="settings"]', 'Settings action').click()
  await waitFor(() => app.activeScreen === 'settings', 'Settings screen')
  const retryStatus = observeSettingsStatus()
  chooseCardArt('tarot-hd')
  const retry = query('#app [data-action="retry-hd"]', 'Retry HD download action')
  await waitFor(() => retry.hidden === false, 'Retry HD download')
  assert(retryStatus.status.textContent === OFFLINE_TEXT, 'Settings must report offline')
  const offlineArtFetches = retryGuard.blocked.length
  assert(offlineArtFetches === 0, 'Offline HD must not fetch art')
  const targets = Object.freeze({
    cardArt: targetSize(query('#app [data-setting="card-art"]', 'Card art setting')),
    retry: targetSize(retry),
    remove: removeTarget,
  })
  assert(
    Object.values(targets).every(({ meetsMinimum }) => meetsMinimum),
    `Card art controls must be at least ${MIN_TARGET_PX}×${MIN_TARGET_PX} px`,
  )
  retryGuard.restore()
  retryNavigator.onLine = true
  retry.click()
  await waitFor(() => retryStatus.status.textContent === HD_READY_TEXT, 'HD ready after Retry')
  await waitFor(() => retry.hidden === true, 'hidden Retry HD download')
  const retryCache = await verifyArtCache()
  assert(retryCache.verified === TAROT_HD_ASSETS.length, 'Retry must store every HD file')
  // Leave the origin as the check found it: pixel selected and no HD download.
  chooseCardArt('tarot-pixel')
  const retryRemove = query('#app [data-action="remove-hd"]', 'Remove HD download action')
  await waitFor(() => retryRemove.hidden === false, 'Remove HD download after Retry')
  retryRemove.click()
  await waitFor(() => retryStatus.status.textContent === REMOVED_TEXT, 'removal after Retry')
  retryStatus.disconnect()
  assert(!(await caches.has(TAROT_HD_CACHE_NAME)), 'Removal after Retry must delete the cache')
  await app.destroy()
  retryCardArt.unsubscribe()

  const ink = classicInkHeights()
  assert(ink.tarotNoSmaller, 'Tarot index glyphs must be no smaller than classic ink')
  assert(recorder.maxEntries <= TEXTURE_CACHE_BOUND, 'Texture cache exceeded 24 entries')
  assert(recorder.diagnostics.length === 0, 'Texture refinement reported a diagnostic')
  assert(consoleErrors.length === 0, 'Card art check reported a relevant console error')

  const report = Object.freeze({
    reportVersion: REPORT_VERSION,
    pixelDefault: {
      themes: recorder.themes('pixel-default'),
      acquisitions: recorder.acquisitionCount('pixel-default'),
    },
    hdDownload: {
      cacheExistedBefore: cacheExisted,
      settingsCanvasCount,
      states: firstCardArt.states,
      announcements: settingsStatus.texts,
      maxProgress: firstCardArt.maxProgress,
      maxProgressBar: settingsStatus.maxProgress,
      totalBytes: firstCardArt.totalBytes,
      elapsedMs: round(downloadMs),
      cache,
    },
    hdGame: {
      themes: recorder.themes('hd-game'),
      acquisitions: recorder.acquisitionCount('hd-game'),
      refine: latencySummary(recorder.refinements('hd-game')),
    },
    relaunch: {
      offline: true,
      artFetches: fetchGuard.blocked.length,
      states: relaunchCardArt.states,
      themesBeforeHd: recorder.themes('relaunch-pixel'),
      themesAfterHd: recorder.themes('relaunch-hd'),
      liveSwitchRemounted: recorder.cacheCount !== cachesBeforeSwitch,
      refine: latencySummary(recorder.refinements('relaunch-hd')),
    },
    pixelLive: {
      themes: recorder.themes('pixel-live'),
      refiningAfterSwitch,
      refinementsAfterSwitch: recorder.refinements('pixel-live').length,
    },
    removal: {
      status: REMOVED_TEXT,
      cacheRemoved,
    },
    retry: {
      states: retryCardArt.states,
      announcements: retryStatus.texts,
      offlineArtFetches,
      cache: retryCache,
    },
    targets,
    textureCache: {
      maxEntries: recorder.maxEntries,
      bound: TEXTURE_CACHE_BOUND,
      caches: recorder.cacheCount,
      diagnostics: recorder.diagnostics.length,
    },
    legibility: ink,
    heap,
    consoleErrors,
  })
  globalThis.__SOULCARD_CARD_ART_REPORT__ = report
  output.dataset.status = 'complete'
  output.textContent = JSON.stringify(report, null, 2)
  console.info(`SOULCARD_CARD_ART ${JSON.stringify(report)}`)
}

run().catch((error) => {
  output.dataset.status = 'failed'
  output.textContent = JSON.stringify({
    reportVersion: REPORT_VERSION,
    error: error instanceof Error ? error.message : String(error),
    consoleErrors,
  }, null, 2)
  console.error(error)
})

import * as THREE from 'three'
import {
  TAROT_HD_THEME_SELECTION,
  TAROT_PIXEL_THEME_SELECTION,
  bindCardArt,
  createCardArtRegistry,
} from '../../src/app/card-art.js'
import { CARD_IDS } from '../../src/domain/cards.js'
import { createMatch, revealOrContinue } from '../../src/domain/match-machine.js'
import { BASELINE_RULESET } from '../../src/domain/ruleset.js'
import { createArtPackStore } from '../../src/persistence/art-pack-store.js'
import { mountBattlefield } from '../../src/presentation/battlefield.js'
import { createEventTimeline } from '../../src/presentation/event-player.js'
import { createTextureCache } from '../../src/presentation/texture-cache.js'
import {
  CLASSIC_BACK_THEME_ID,
  CLASSIC_FRONT_THEME_ID,
} from '../../src/presentation/themes/classic.js'
import { TAROT_HD_ASSETS } from '../../src/presentation/themes/tarot-hd-assets.js'
import { createTarotHdThemes } from '../../src/presentation/themes/tarot-hd.js'
import tarotPixelSpritesSource from '../../src/presentation/themes/tarot-pixel-sprites.js?raw'

const ZERO_TIMING = Object.freeze({
  revealMs: 0,
  settlementMs: 0,
  burnMs: 0,
})
const VIEWPORTS = Object.freeze([
  Object.freeze({ name: 'phone-portrait', width: 320, height: 480 }),
  Object.freeze({ name: 'phone-landscape', width: 844, height: 390 }),
  Object.freeze({ name: 'tablet', width: 768, height: 1024 }),
  Object.freeze({ name: 'desktop', width: 1280, height: 800 }),
])

function createSettingsController() {
  let snapshot = Object.freeze({
    quality: 'balanced',
    renderScaleCap: 1.5,
    animationSpeed: 1,
    reducedMotionOverride: false,
    reducedMotion: false,
  })
  const subscribers = new Set()
  return {
    getSnapshot: () => snapshot,
    subscribe(subscriber) {
      subscribers.add(subscriber)
      subscriber(snapshot)
      return () => subscribers.delete(subscriber)
    },
    emit(values) {
      snapshot = Object.freeze({ ...snapshot, ...values })
      for (const subscriber of [...subscribers]) subscriber(snapshot)
    },
  }
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]
}

async function measureFrameIntervals(count = 30) {
  const timestamps = []
  await new Promise((resolve) => {
    function frame(timestamp) {
      timestamps.push(timestamp)
      if (timestamps.length >= count + 1) {
        resolve()
      } else {
        requestAnimationFrame(frame)
      }
    }
    requestAnimationFrame(frame)
  })
  const intervals = timestamps.slice(1).map((value, index) => value - timestamps[index])
  return Object.freeze({
    samples: intervals.length,
    meanMs: intervals.reduce((sum, value) => sum + value, 0) / intervals.length,
    p50Ms: percentile(intervals, 0.5),
    p95Ms: percentile(intervals, 0.95),
    maxMs: Math.max(...intervals),
  })
}

const mountCardArtBattlefield = bindCardArt(mountBattlefield)
const CLASSIC_SELECTION = Object.freeze({
  frontThemeId: CLASSIC_FRONT_THEME_ID,
  backThemeId: CLASSIC_BACK_THEME_ID,
})

function createProfileMount(host, settingsController, onContextStatus) {
  return mountCardArtBattlefield(host, {
    settingsController,
    onContextStatus,
  })
}

function profileMatch(handle, seed) {
  let match = createMatch({
    runId: `milestone-19-profile-${seed}`,
    seed,
    ruleset: BASELINE_RULESET,
  })
  let ties = 0
  let stageTransitions = 0
  const maxima = {
    cacheEntries: 0,
    staticCards: 0,
    transientCards: 0,
    geometries: 0,
    textures: 0,
    drawCalls: 0,
  }
  const startedAt = performance.now()
  handle.syncSnapshot(match)
  while (match.status === 'active') {
    const previousStage = match.stage
    const transition = revealOrContinue(match)
    match = transition.match
    ties += Math.max(0, Math.floor(transition.event.reveals.length / 2) - 1)
    if (previousStage === 'source' && match.stage === 'personal') stageTransitions += 1
    handle.beginEvent(transition.event, match)
    for (const step of createEventTimeline(transition.event, ZERO_TIMING)) {
      handle.applyStep(step, { durationMs: 0 })
      const snapshot = handle.getPerformanceSnapshot()
      maxima.cacheEntries = Math.max(maxima.cacheEntries, snapshot.resources.cacheEntries)
      maxima.staticCards = Math.max(maxima.staticCards, snapshot.resources.staticCards)
      maxima.transientCards = Math.max(
        maxima.transientCards,
        snapshot.resources.transientCards,
      )
      maxima.geometries = Math.max(maxima.geometries, snapshot.renderer?.geometries ?? 0)
      maxima.textures = Math.max(maxima.textures, snapshot.renderer?.textures ?? 0)
      maxima.drawCalls = Math.max(maxima.drawCalls, snapshot.renderer?.calls ?? 0)
    }
    handle.syncSnapshot(match)
  }
  return {
    seed,
    elapsedMs: performance.now() - startedAt,
    clashes: match.turn,
    ties,
    stageTransitions,
    outcome: match.outcome,
    maxima,
    match,
  }
}

function profileTextures(
  scale,
  { frontThemeId, backThemeId } = CLASSIC_SELECTION,
  registry = createCardArtRegistry(),
) {
  const renderer = new THREE.WebGLRenderer({ alpha: true })
  const cache = createTextureCache({
    registry,
    maxEntries: 24,
    renderer,
  })
  const startedAt = performance.now()
  for (const cardId of CARD_IDS) {
    cache.acquireFront({ themeId: frontThemeId, cardId, scale }).release()
  }
  cache.acquireBack({ themeId: backThemeId, scale }).release()
  const elapsedMs = performance.now() - startedAt
  const residentEntries = cache.getStats().entries
  cache.destroy()
  renderer.dispose()
  return Object.freeze({
    frontThemeId,
    backThemeId,
    scale,
    generatedTextures: CARD_IDS.length + 1,
    elapsedMs,
    residentEntries,
    bound: 24,
  })
}

function withTimeout(promise, name, timeoutMs = 30_000) {
  let timer
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${name}`)), timeoutMs)
    }),
  ]).finally(() => clearTimeout(timer))
}

// Refines HD fronts held in one texture cache: one at a time for the latency of a
// single reveal, then all 52 at once for the burst of a full table.
async function profileTarotHdRefine(registry, scale) {
  const renderer = new THREE.WebGLRenderer({ alpha: true })
  const waiting = new Map()
  const diagnostics = []
  const cache = createTextureCache({
    registry,
    maxEntries: CARD_IDS.length + 1,
    renderer,
    onTextureUpdate({ cardId }) {
      waiting.get(cardId)?.()
      waiting.delete(cardId)
    },
    onDiagnostic(diagnostic) {
      diagnostics.push(diagnostic)
    },
  })
  const refined = (cardId) => new Promise((resolve) => {
    waiting.set(cardId, resolve)
  })
  const acquire = (cardId) => cache.acquireFront({
    themeId: TAROT_HD_THEME_SELECTION.frontThemeId,
    cardId,
    scale,
  })
  try {
    const latencies = []
    for (const cardId of CARD_IDS) {
      const done = refined(cardId)
      const startedAt = performance.now()
      const lease = acquire(cardId)
      await withTimeout(done, `HD refinement of ${cardId}`)
      latencies.push(performance.now() - startedAt)
      lease.release()
    }
    cache.clear()

    const burstStartedAt = performance.now()
    const burstDone = Promise.all(CARD_IDS.map(refined))
    const leases = CARD_IDS.map(acquire)
    await withTimeout(burstDone, 'HD burst refinement')
    const burstMs = performance.now() - burstStartedAt
    for (const lease of leases) lease.release()

    return Object.freeze({
      scale,
      single: Object.freeze({
        samples: latencies.length,
        p50Ms: percentile(latencies, 0.5),
        p95Ms: percentile(latencies, 0.95),
        maxMs: Math.max(...latencies),
      }),
      burst: Object.freeze({ textures: CARD_IDS.length, elapsedMs: burstMs }),
      diagnostics: diagnostics.length,
    })
  } finally {
    cache.destroy()
    renderer.dispose()
  }
}

// Downloads the HD pack into an in-memory store, so the profile never touches the
// player's art cache, then times activation, previews and refinement.
async function profileTarotHd() {
  const heapBefore = heapObservation()
  const store = createArtPackStore({ manifest: TAROT_HD_ASSETS, caches: null })
  const downloadStartedAt = performance.now()
  await store.download()
  const downloadMs = performance.now() - downloadStartedAt
  const themes = createTarotHdThemes()
  const registry = createCardArtRegistry()
  registry.registerFront(themes.frontTheme)
  registry.registerBack(themes.backTheme)
  const activationStartedAt = performance.now()
  await themes.activate({ store, manifest: TAROT_HD_ASSETS })
  const activationMs = performance.now() - activationStartedAt
  const heapActive = heapObservation()
  let result
  try {
    const preview = [1, 2].map((scale) => (
      profileTextures(scale, TAROT_HD_THEME_SELECTION, registry)
    ))
    const refine = await profileTarotHdRefine(registry, 2)
    result = {
      selection: TAROT_HD_THEME_SELECTION,
      packFiles: TAROT_HD_ASSETS.length,
      packBytes: TAROT_HD_ASSETS.reduce((total, { bytes }) => total + bytes, 0),
      downloadMs,
      activationMs,
      preview,
      refine,
    }
  } finally {
    themes.release()
    await store.clear()
  }
  // Heap figures are observations only: nothing forces a collection between them.
  return Object.freeze({
    ...result,
    heap: { before: heapBefore, active: heapActive, released: heapObservation() },
  })
}

async function gzipSize(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))
  return (await new Response(stream).arrayBuffer()).byteLength
}

async function profilePixelModule() {
  return Object.freeze({
    module: 'src/presentation/themes/tarot-pixel-sprites.js',
    bytes: new TextEncoder().encode(tarotPixelSpritesSource).byteLength,
    gzipBytes: await gzipSize(tarotPixelSpritesSource),
  })
}

function waitForContext(predicate, timeoutMs = 5_000) {
  const startedAt = performance.now()
  return new Promise((resolve, reject) => {
    function check() {
      if (predicate()) {
        resolve()
      } else if (performance.now() - startedAt >= timeoutMs) {
        reject(new Error('Timed out waiting for WebGL context state'))
      } else {
        setTimeout(check, 10)
      }
    }
    check()
  })
}

async function recoverContext(host, getContextState) {
  const canvas = host.querySelector('canvas')
  const before = getContextState().recoveryCount
  const startedAt = performance.now()
  let mode = 'synthetic'
  const context = canvas.getContext('webgl2') ?? canvas.getContext('webgl')
  const extension = context?.getExtension('WEBGL_lose_context')

  if (extension) {
    try {
      extension.loseContext()
      await waitForContext(() => getContextState().status === 'lost')
      mode = 'WEBGL_lose_context'
      extension.restoreContext()
      await waitForContext(() => (
        getContextState().status === 'ready'
        && getContextState().recoveryCount === before + 1
      ))
    } catch {
      const activeCanvas = host.querySelector('canvas') ?? canvas
      if (getContextState().status === 'ready') {
        activeCanvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }))
      }
      activeCanvas.dispatchEvent(new Event('webglcontextrestored'))
      await waitForContext(() => getContextState().status === 'ready')
      mode = 'synthetic-fallback'
    }
  } else {
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }))
    canvas.dispatchEvent(new Event('webglcontextrestored'))
    await waitForContext(() => (
      getContextState().status === 'ready'
      && getContextState().recoveryCount === before + 1
    ))
  }

  return Object.freeze({
    mode,
    elapsedMs: performance.now() - startedAt,
    recoveryCount: getContextState().recoveryCount,
  })
}

function heapObservation() {
  if (!performance.memory) return Object.freeze({ supported: false })
  return Object.freeze({
    supported: true,
    usedJSHeapSize: performance.memory.usedJSHeapSize,
    totalJSHeapSize: performance.memory.totalJSHeapSize,
    jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
  })
}

async function run() {
  const host = document.querySelector('#profile-battlefield')
  const output = document.querySelector('#profile-results')
  const settingsController = createSettingsController()
  let contextState = Object.freeze({ status: 'ready', recoveryCount: 0, reason: null })
  let handle = createProfileMount(
    host,
    settingsController,
    (state) => {
      contextState = state
    },
  )

  const viewportResults = []
  for (const viewport of VIEWPORTS) {
    host.style.width = `${viewport.width}px`
    host.style.height = `${viewport.height}px`
    const startedAt = performance.now()
    handle.resize()
    handle.syncSnapshot(createMatch({
      runId: `milestone-19-viewport-${viewport.name}`,
      seed: 0,
      ruleset: BASELINE_RULESET,
    }))
    viewportResults.push({
      ...viewport,
      elapsedMs: performance.now() - startedAt,
      layoutMode: handle.layout.mode,
      pixelRatio: handle.getPerformanceSnapshot().pixelRatio,
      resources: handle.getPerformanceSnapshot().resources,
    })
  }

  settingsController.emit({
    quality: 'low',
    renderScaleCap: 1,
    reducedMotion: true,
    reducedMotionOverride: true,
  })
  const reducedMotion = handle.getPerformanceSnapshot()
  settingsController.emit({
    quality: 'high',
    renderScaleCap: 2,
    reducedMotion: false,
    reducedMotionOverride: false,
  })
  const normalMotion = handle.getPerformanceSnapshot()
  const frameIntervals = await measureFrameIntervals()

  const seedZero = profileMatch(handle, 0)
  const terminalDraw = profileMatch(handle, 93)
  if (terminalDraw.outcome.result !== 'draw') {
    throw new Error('Milestone 19 terminal-draw profile seed no longer produces a draw')
  }
  const terminalBeforeRecovery = JSON.stringify(handle.getRetainedSnapshot())
  const recovery = [
    await recoverContext(host, () => contextState),
    await recoverContext(host, () => contextState),
  ]
  const terminalAfterRecovery = JSON.stringify(handle.getRetainedSnapshot())

  const remounts = []
  handle.teardown()
  for (let index = 0; index < 3; index += 1) {
    contextState = Object.freeze({ status: 'ready', recoveryCount: 0, reason: null })
    handle = createProfileMount(
      host,
      settingsController,
      (state) => {
        contextState = state
      },
    )
    handle.syncSnapshot(createMatch({
      runId: `milestone-19-remount-${index}`,
      seed: index,
      ruleset: BASELINE_RULESET,
    }))
    remounts.push(handle.getPerformanceSnapshot())
    handle.teardown()
  }

  const tarotHd = await profileTarotHd()
  const pixelModule = await profilePixelModule()

  const report = Object.freeze({
    reportVersion: 1,
    generatedAt: new Date().toISOString(),
    environment: {
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency ?? null,
      deviceMemoryGiB: navigator.deviceMemory ?? null,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
      },
    },
    frameIntervals,
    cardArt: TAROT_PIXEL_THEME_SELECTION,
    pixelModule,
    textureGeneration: [
      profileTextures(1),
      profileTextures(3),
      ...[1, 2, 3].map((scale) => profileTextures(scale, TAROT_PIXEL_THEME_SELECTION)),
    ],
    tarotHd,
    viewportResults,
    motion: {
      reduced: reducedMotion,
      normal: normalMotion,
    },
    matches: [
      {
        seed: seedZero.seed,
        elapsedMs: seedZero.elapsedMs,
        clashes: seedZero.clashes,
        ties: seedZero.ties,
        stageTransitions: seedZero.stageTransitions,
        outcome: seedZero.outcome,
        maxima: seedZero.maxima,
      },
      {
        seed: terminalDraw.seed,
        elapsedMs: terminalDraw.elapsedMs,
        clashes: terminalDraw.clashes,
        ties: terminalDraw.ties,
        stageTransitions: terminalDraw.stageTransitions,
        outcome: terminalDraw.outcome,
        maxima: terminalDraw.maxima,
      },
    ],
    contextRecovery: {
      attempts: recovery,
      statePreserved: terminalBeforeRecovery === terminalAfterRecovery,
    },
    remounts,
    heap: heapObservation(),
  })

  globalThis.__SOULCARD_MILESTONE_19_REPORT__ = report
  output.dataset.status = 'complete'
  output.textContent = JSON.stringify(report, null, 2)
  console.info(`SOULCARD_MILESTONE_19 ${JSON.stringify(report)}`)
}

run().catch((error) => {
  const output = document.querySelector('#profile-results')
  output.dataset.status = 'failed'
  output.textContent = JSON.stringify({
    reportVersion: 1,
    error: error instanceof Error ? error.message : String(error),
  })
  console.error(error)
})

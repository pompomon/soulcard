import * as THREE from 'three'
import { CARD_IDS } from '../../src/domain/cards.js'
import { createMatch, revealOrContinue } from '../../src/domain/match-machine.js'
import { BASELINE_RULESET } from '../../src/domain/ruleset.js'
import { mountBattlefield } from '../../src/presentation/battlefield.js'
import { createEventTimeline } from '../../src/presentation/event-player.js'
import { createTextureCache } from '../../src/presentation/texture-cache.js'
import { createThemeRegistry } from '../../src/presentation/themes/registry.js'

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

function createProfileMount(host, settingsController, onContextStatus) {
  return mountBattlefield(host, {
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

function profileTextures(scale) {
  const renderer = new THREE.WebGLRenderer({ alpha: true })
  const cache = createTextureCache({
    registry: createThemeRegistry(),
    maxEntries: 24,
    renderer,
  })
  const startedAt = performance.now()
  for (const cardId of CARD_IDS) {
    cache.acquireFront({ cardId, scale }).release()
  }
  cache.acquireBack({ scale }).release()
  const elapsedMs = performance.now() - startedAt
  const residentEntries = cache.getStats().entries
  cache.destroy()
  renderer.dispose()
  return Object.freeze({
    scale,
    generatedTextures: CARD_IDS.length + 1,
    elapsedMs,
    residentEntries,
    bound: 24,
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
    textureGeneration: [profileTextures(1), profileTextures(3)],
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

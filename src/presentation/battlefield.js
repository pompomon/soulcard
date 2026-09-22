import * as THREE from 'three'
import {
  BATTLEFIELD_ZONE_IDS,
  MINIMUM_VIEWPORT,
  createBattlefieldLayout,
} from './layout.js'
import {
  DEFAULT_SETTINGS,
  createSettingsSnapshot,
} from '../app/settings.js'
import { validateCommittedEvent } from '../domain/events.js'
import { validateMatchState } from '../domain/match-machine.js'
import { createTextureCache } from './texture-cache.js'
import { createThemeRegistry } from './themes/registry.js'

const FALLBACK_SETTINGS = createSettingsSnapshot(DEFAULT_SETTINGS, false)
const MAX_TRANSIENT_CARDS = 8
const MAX_CONTEST_CARDS = 4
const TEXTURE_CACHE_ENTRIES = 24
const TEXTURE_SCALE_BY_QUALITY = Object.freeze({
  low: 1,
  balanced: 2,
  high: 3,
})
const SAFE_AREA_PROPERTIES = Object.freeze({
  top: '--safe-area-top',
  right: '--safe-area-right',
  bottom: '--safe-area-bottom',
  left: '--safe-area-left',
})

function assertHost(host) {
  if (
    host === null
    || typeof host !== 'object'
    || typeof host.append !== 'function'
  ) {
    throw new TypeError('Battlefield host must support append')
  }
}

function assertSettingsController(settingsController) {
  if (
    settingsController !== undefined
    && (
      settingsController === null
      || typeof settingsController !== 'object'
      || typeof settingsController.getSnapshot !== 'function'
      || typeof settingsController.subscribe !== 'function'
    )
  ) {
    throw new TypeError('settingsController must expose getSnapshot and subscribe')
  }
}

function assertThemeRegistry(registry) {
  if (
    registry === null
    || typeof registry !== 'object'
    || typeof registry.resolveSelection !== 'function'
    || typeof registry.resolveFront !== 'function'
    || typeof registry.resolveBack !== 'function'
    || typeof registry.fallbackFrontThemeId !== 'string'
    || typeof registry.fallbackBackThemeId !== 'string'
  ) {
    throw new TypeError('themeRegistry must implement the theme registry interface')
  }
}

function assertTextureCache(cache) {
  if (
    cache === null
    || typeof cache !== 'object'
    || typeof cache.acquireFront !== 'function'
    || typeof cache.acquireBack !== 'function'
    || typeof cache.destroy !== 'function'
  ) {
    throw new TypeError('textureCacheFactory must return a compatible texture cache')
  }
}

function parsePixel(value) {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

function readSafeArea(host, windowObject) {
  let style
  try {
    style = windowObject?.getComputedStyle?.(host)
  } catch {
    style = null
  }
  return Object.fromEntries(
    Object.entries(SAFE_AREA_PROPERTIES).map(([side, property]) => [
      side,
      parsePixel(style?.getPropertyValue?.(property)),
    ]),
  )
}

function setStyleProperty(element, property, value) {
  element?.style?.setProperty?.(property, value)
}

function publishLayout(host, layout, onLayout) {
  if (host.dataset) {
    host.dataset.layoutMode = layout.mode
    host.dataset.letterboxed = String(layout.viewport.letterboxed)
  }
  setStyleProperty(host, '--battlefield-layout-scale', String(layout.viewport.scale))
  setStyleProperty(host, '--hud-control-min-size', `${44 / layout.viewport.scale}px`)
  setStyleProperty(host, '--battlefield-logical-width', `${layout.viewport.logicalWidth}px`)
  setStyleProperty(host, '--battlefield-logical-height', `${layout.viewport.logicalHeight}px`)
  setStyleProperty(host, '--hud-header-reserve', `${layout.hud.header.height}px`)
  setStyleProperty(host, '--hud-footer-reserve', `${layout.hud.footer.height}px`)
  setStyleProperty(host, '--hud-side-reserve', `${layout.hud.leftPanel.width}px`)
  onLayout?.(layout)
}

function getMeasuredSize(host, windowObject) {
  let rectangle
  try {
    rectangle = host.getBoundingClientRect?.()
  } catch {
    rectangle = null
  }
  const measuredWidth = rectangle?.width || host.clientWidth
  const measuredHeight = rectangle?.height || host.clientHeight
  const fallbackWidth = windowObject?.innerWidth
  const fallbackHeight = windowObject?.innerHeight
  return {
    width: Number.isFinite(measuredWidth) && measuredWidth > 0
      ? measuredWidth
      : Number.isFinite(fallbackWidth) && fallbackWidth > 0
        ? fallbackWidth
        : MINIMUM_VIEWPORT.width,
    height: Number.isFinite(measuredHeight) && measuredHeight > 0
      ? measuredHeight
      : Number.isFinite(fallbackHeight) && fallbackHeight > 0
        ? fallbackHeight
        : MINIMUM_VIEWPORT.height,
  }
}

export function mountBattlefield(host, {
  settingsController,
  onLayout,
  windowObject = globalThis.window,
  ResizeObserverClass = windowObject?.ResizeObserver ?? globalThis.ResizeObserver,
  rendererFactory = (options) => new THREE.WebGLRenderer(options),
  themeRegistry = createThemeRegistry(),
  themeSelection = undefined,
  textureCacheFactory = createTextureCache,
} = {}) {
  assertHost(host)
  assertSettingsController(settingsController)
  if (onLayout !== undefined && typeof onLayout !== 'function') {
    throw new TypeError('onLayout must be a function')
  }
  if (typeof rendererFactory !== 'function') {
    throw new TypeError('rendererFactory must be a function')
  }
  assertThemeRegistry(themeRegistry)
  if (typeof textureCacheFactory !== 'function') {
    throw new TypeError('textureCacheFactory must be a function')
  }
  const selectedThemes = themeRegistry.resolveSelection(themeSelection ?? {
    frontThemeId: themeRegistry.fallbackFrontThemeId,
    backThemeId: themeRegistry.fallbackBackThemeId,
  })

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100)
  const floorGeometry = new THREE.PlaneGeometry(12, 12)
  const floorMaterial = new THREE.MeshBasicMaterial({
    color: 0x120d2b,
    transparent: true,
    opacity: 0.88,
    depthWrite: false,
  })
  const floor = new THREE.Mesh(floorGeometry, floorMaterial)
  floor.position.z = -0.1
  scene.add(floor)

  const placeholderGeometry = new THREE.PlaneGeometry(1.05, 1.45)
  const placeholderMaterial = new THREE.MeshBasicMaterial({
    color: 0x8b64bb,
    transparent: true,
    opacity: 0.2,
    side: THREE.DoubleSide,
    depthWrite: false,
  })
  const zoneGroups = new Map()
  const placeholderMeshes = new Map()
  for (const zoneId of BATTLEFIELD_ZONE_IDS) {
    const group = new THREE.Group()
    group.name = `battlefield-zone:${zoneId}`
    const placeholder = new THREE.Mesh(placeholderGeometry, placeholderMaterial)
    placeholder.name = `battlefield-placeholder:${zoneId}`
    placeholderMeshes.set(zoneId, placeholder)
    group.add(placeholder)
    zoneGroups.set(zoneId, group)
    scene.add(group)
  }
  const cardGeometry = new THREE.PlaneGeometry(1.05, 1.45)

  let currentSettings = settingsController?.getSnapshot() ?? FALLBACK_SETTINGS
  let renderer = null
  let textureCache = null
  let currentLayout = null
  let currentMatch = null
  let currentEvent = null
  let paused = false
  let disposed = false
  let previousTime = null
  let animationTime = 0
  let pendingResizeFrame = null
  const staticVisuals = new Set()
  const transientVisuals = new Map()
  const tweens = new Set()
  const settledVisuals = new Set()

  const requestFrame = typeof windowObject?.requestAnimationFrame === 'function'
    ? windowObject.requestAnimationFrame.bind(windowObject)
    : null
  const cancelFrame = typeof windowObject?.cancelAnimationFrame === 'function'
    ? windowObject.cancelAnimationFrame.bind(windowObject)
    : null

  function publishPresentation(phase, cardId = null) {
    if (!host.dataset) return
    host.dataset.presentationPhase = phase
    host.dataset.presentationEvent = currentEvent?.id ?? ''
    host.dataset.presentationCard = cardId ?? ''
    host.dataset.presentationTurn = currentMatch === null ? '' : String(currentMatch.turn)
    host.dataset.presentationCards = String(staticVisuals.size + transientVisuals.size)
  }

  function ensureTextureCache() {
    if (textureCache) return textureCache
    const candidate = textureCacheFactory({
      registry: themeRegistry,
      maxEntries: TEXTURE_CACHE_ENTRIES,
      renderer,
    })
    assertTextureCache(candidate)
    textureCache = candidate
    return textureCache
  }

  function textureScale() {
    return TEXTURE_SCALE_BY_QUALITY[currentSettings.quality]
  }

  function releaseVisual(visual) {
    tweens.delete(visual)
    visual.parent.remove(visual.mesh)
    visual.material.map = null
    visual.material.dispose()
    visual.lease.release()
  }

  function clearCardVisuals() {
    for (const visual of staticVisuals) releaseVisual(visual)
    staticVisuals.clear()
    for (const visual of transientVisuals.values()) releaseVisual(visual)
    transientVisuals.clear()
    tweens.clear()
    settledVisuals.clear()
  }

  function createCardVisual({
    cardId,
    faceUp,
    parent,
    zoneId,
    offset = Object.freeze({ x: 0, y: 0, z: 0 }),
    transient = false,
  }) {
    const cache = ensureTextureCache()
    const scale = textureScale()
    const lease = faceUp
      ? cache.acquireFront({
          themeId: selectedThemes.frontThemeId,
          cardId,
          scale,
        })
      : cache.acquireBack({
          themeId: selectedThemes.backThemeId,
          scale,
        })
    let material
    try {
      material = new THREE.MeshBasicMaterial({
        map: lease.texture,
        transparent: true,
        side: THREE.DoubleSide,
      })
    } catch (error) {
      lease.release()
      throw error
    }
    const mesh = new THREE.Mesh(cardGeometry, material)
    mesh.name = `battlefield-card:${cardId}:${faceUp ? 'front' : 'back'}`
    mesh.position.set(offset.x, offset.y, offset.z)
    parent.add(mesh)
    return {
      cardId,
      faceUp,
      parent,
      zoneId,
      offset,
      transient,
      mesh,
      material,
      lease,
      tween: null,
    }
  }

  function firstVisibleCard(pile, excluded) {
    return pile.find((cardId) => !excluded.has(cardId)) ?? null
  }

  function lastVisibleCard(pile, excluded) {
    for (let index = pile.length - 1; index >= 0; index -= 1) {
      if (!excluded.has(pile[index])) return pile[index]
    }
    return null
  }

  function addPileRepresentative(zoneId, cardId, faceUp, stackIndex = 0) {
    if (cardId === null) return
    const visual = createCardVisual({
      cardId,
      faceUp,
      parent: zoneGroups.get(zoneId),
      zoneId,
      offset: Object.freeze({
        x: Math.min(stackIndex, 3) * 0.035,
        y: Math.min(stackIndex, 3) * 0.025,
        z: 0.02 + stackIndex * 0.012,
      }),
    })
    staticVisuals.add(visual)
  }

  function renderSnapshotCards(match, excluded = new Set()) {
    for (const placeholder of placeholderMeshes.values()) placeholder.visible = false
    const { zones } = match
    addPileRepresentative(
      'sourceDeck',
      firstVisibleCard(zones.sourceDeck, excluded),
      false,
    )
    for (const side of ['player', 'opponent']) {
      const prefix = side === 'player' ? 'player' : 'opponent'
      addPileRepresentative(
        `${prefix}DrawPile`,
        firstVisibleCard(zones[side].drawPile, excluded),
        false,
      )
      addPileRepresentative(
        `${prefix}WonPile`,
        lastVisibleCard(zones[side].wonPile, excluded),
        false,
      )
    }
    const contest = zones.contestedPile
      .filter(({ cardId }) => !excluded.has(cardId))
      .slice(-MAX_CONTEST_CARDS)
    contest.forEach(({ cardId }, index) => {
      addPileRepresentative('contestedPile', cardId, true, index)
    })
    addPileRepresentative(
      'burnPile',
      lastVisibleCard(zones.burnPile, excluded),
      true,
    )
    publishPresentation(currentEvent === null ? 'snapshot' : 'prepared')
  }

  function zoneWorldPosition(zoneId, offset) {
    const anchor = currentLayout?.zones[zoneId] ?? { x: 0, y: 0, z: 0 }
    return {
      x: anchor.x + offset.x,
      y: anchor.y + offset.y,
      z: anchor.z + offset.z,
    }
  }

  function placeTransient(visual) {
    const position = zoneWorldPosition(visual.zoneId, visual.offset)
    visual.mesh.position.set(position.x, position.y, position.z)
  }

  function startTween(visual, zoneId, offset, durationMs) {
    const target = zoneWorldPosition(zoneId, offset)
    visual.zoneId = zoneId
    visual.offset = offset
    visual.tween = {
      from: {
        x: visual.mesh.position.x,
        y: visual.mesh.position.y,
        z: visual.mesh.position.z,
      },
      to: target,
      elapsedMs: 0,
      durationMs,
    }
    tweens.add(visual)
    if (durationMs === 0) {
      visual.mesh.position.set(target.x, target.y, target.z)
      visual.tween = null
      tweens.delete(visual)
    }
  }

  function advanceTweens(deltaMs) {
    for (const visual of [...tweens]) {
      const tween = visual.tween
      if (tween === null) {
        tweens.delete(visual)
        continue
      }
      tween.elapsedMs = Math.min(tween.durationMs, tween.elapsedMs + deltaMs)
      const progress = tween.durationMs === 0 ? 1 : tween.elapsedMs / tween.durationMs
      const eased = progress * progress * (3 - 2 * progress)
      visual.mesh.position.set(
        tween.from.x + (tween.to.x - tween.from.x) * eased,
        tween.from.y + (tween.to.y - tween.from.y) * eased,
        tween.from.z + (tween.to.z - tween.from.z) * eased,
      )
      if (progress >= 1) {
        visual.tween = null
        tweens.delete(visual)
      }
    }
  }

  function transientOffset(step) {
    return Object.freeze({
      x: ((step.round % 4) - 1.5) * 0.13,
      y: Math.floor(step.round / 4) * 0.035,
      z: 0.08 + step.revealIndex * 0.008,
    })
  }

  function trimTransientCards() {
    while (transientVisuals.size >= MAX_TRANSIENT_CARDS) {
      const oldest = transientVisuals.entries().next().value
      if (!oldest) return
      const [cardId, visual] = oldest
      transientVisuals.delete(cardId)
      releaseVisual(visual)
    }
  }

  function ensureTransientCard(cardId, suppliedBy) {
    const existing = transientVisuals.get(cardId)
    if (existing) return existing
    trimTransientCards()
    const zoneId = `${suppliedBy}Reveal`
    const visual = createCardVisual({
      cardId,
      faceUp: true,
      parent: scene,
      zoneId,
      transient: true,
    })
    transientVisuals.set(cardId, visual)
    placeTransient(visual)
    return visual
  }

  function releaseSettledVisuals() {
    for (const visual of settledVisuals) {
      if (transientVisuals.get(visual.cardId) === visual) {
        transientVisuals.delete(visual.cardId)
      }
      releaseVisual(visual)
    }
    settledVisuals.clear()
  }

  function ensureSettlementCard(cardId, suppliedBy) {
    const existing = transientVisuals.get(cardId)
    if (existing) return existing
    const visual = createCardVisual({
      cardId,
      faceUp: true,
      parent: scene,
      zoneId: 'contestedPile',
      offset: Object.freeze({ x: 0, y: 0, z: 0.12 }),
      transient: true,
    })
    transientVisuals.set(cardId, visual)
    placeTransient(visual)
    return visual
  }

  function rescaleTweens(previousSpeed, nextSpeed) {
    if (Object.is(previousSpeed, nextSpeed)) return
    for (const visual of tweens) {
      const tween = visual.tween
      if (tween === null) continue
      const remaining = Math.max(0, tween.durationMs - tween.elapsedMs)
      tween.durationMs = tween.elapsedMs + remaining * previousSpeed / nextSpeed
    }
  }

  function renderCurrentFrame() {
    if (!renderer) return
    placeholderMaterial.opacity = 0.18 + Math.sin(animationTime * 0.0015) * 0.035
    renderer.render(scene, camera)
  }

  function animate(time) {
    if (previousTime !== null) {
      const delta = Math.max(0, time - previousTime)
      animationTime += delta * currentSettings.animationSpeed
      advanceTweens(delta)
    }
    previousTime = time
    renderCurrentFrame()
  }

  function shouldAnimate() {
    return !paused && !currentSettings.reducedMotion
  }

  function syncAnimationLoop() {
    if (!renderer) return
    previousTime = null
    if (shouldAnimate()) {
      renderer.setAnimationLoop(animate)
    } else {
      renderer.setAnimationLoop(null)
      renderCurrentFrame()
    }
  }

  function disposeRenderer() {
    if (!renderer) return
    renderer.setAnimationLoop(null)
    renderer.dispose()
    renderer.domElement?.remove?.()
    renderer = null
  }

  function createRenderer() {
    const nextRenderer = rendererFactory({
      antialias: currentSettings.quality !== 'low',
      alpha: true,
    })
    if (
      nextRenderer === null
      || typeof nextRenderer !== 'object'
      || typeof nextRenderer.render !== 'function'
      || typeof nextRenderer.setSize !== 'function'
      || typeof nextRenderer.setPixelRatio !== 'function'
      || typeof nextRenderer.setAnimationLoop !== 'function'
      || typeof nextRenderer.dispose !== 'function'
      || nextRenderer.domElement === null
      || typeof nextRenderer.domElement !== 'object'
    ) {
      throw new TypeError('rendererFactory must return a compatible renderer')
    }
    nextRenderer.domElement.setAttribute?.('aria-hidden', 'true')
    nextRenderer.domElement.setAttribute?.('role', 'presentation')
    host.append(nextRenderer.domElement)
    renderer = nextRenderer
  }

  function resize() {
    if (disposed || !renderer) return null
    const { width, height } = getMeasuredSize(host, windowObject)
    const layout = createBattlefieldLayout({
      width,
      height,
      safeArea: readSafeArea(host, windowObject),
    })
    currentLayout = layout

    camera.fov = layout.camera.fov
    camera.near = layout.camera.near
    camera.far = layout.camera.far
    camera.aspect = layout.camera.aspect
    camera.position.set(
      layout.camera.target.x,
      layout.camera.target.y,
      layout.camera.distance,
    )
    camera.lookAt(
      layout.camera.target.x,
      layout.camera.target.y,
      layout.camera.target.z,
    )
    camera.updateProjectionMatrix()

    floor.scale.set(layout.world.width / 12, layout.world.height / 12, 1)
    for (const [zoneId, group] of zoneGroups) {
      const position = layout.zones[zoneId]
      group.position.set(position.x, position.y, position.z)
    }
    for (const visual of transientVisuals.values()) {
      if (visual.tween === null) {
        placeTransient(visual)
      } else {
        visual.tween.to = zoneWorldPosition(visual.zoneId, visual.offset)
      }
    }

    const devicePixelRatio = Number.isFinite(windowObject?.devicePixelRatio)
      && windowObject.devicePixelRatio > 0
      ? windowObject.devicePixelRatio
      : 1
    renderer.setPixelRatio(Math.min(devicePixelRatio, currentSettings.renderScaleCap))
    renderer.setSize(width, height, false)
    publishLayout(host, layout, onLayout)
    renderCurrentFrame()
    return layout
  }

  function scheduleResize() {
    if (disposed || pendingResizeFrame !== null) return
    if (!requestFrame) {
      resize()
      return
    }
    pendingResizeFrame = requestFrame(() => {
      pendingResizeFrame = null
      resize()
    })
  }

  function rebuildRenderer() {
    disposeRenderer()
    createRenderer()
    resize()
    syncAnimationLoop()
  }

  createRenderer()
  resize()
  syncAnimationLoop()

  const resizeObserver = typeof ResizeObserverClass === 'function'
    ? new ResizeObserverClass(scheduleResize)
    : null
  resizeObserver?.observe(host)
  windowObject?.addEventListener?.('resize', scheduleResize)
  windowObject?.addEventListener?.('orientationchange', scheduleResize)
  scheduleResize()

  const unsubscribeSettings = settingsController?.subscribe((settings) => {
    if (disposed) return
    const qualityChanged = settings.quality !== currentSettings.quality
    rescaleTweens(currentSettings.animationSpeed, settings.animationSpeed)
    currentSettings = settings
    if (qualityChanged) {
      rebuildRenderer()
    } else {
      resize()
      syncAnimationLoop()
    }
  })

  function syncSnapshot(match, context = {}) {
    if (disposed) throw new Error('Battlefield has been destroyed')
    validateMatchState(match)
    clearCardVisuals()
    currentMatch = match
    currentEvent = null
    renderSnapshotCards(match)
    publishPresentation(context.reason === 'skipped' ? 'skipped' : 'snapshot')
    renderCurrentFrame()
  }

  function beginEvent(event, match) {
    if (disposed) throw new Error('Battlefield has been destroyed')
    validateMatchState(match)
    validateCommittedEvent(event)
    if (
      match.pendingEvent === null
      || match.pendingEvent.id !== event.id
      || match.pendingEvent.stateFingerprint !== event.stateFingerprint
    ) {
      throw new Error('Presentation event must match the committed snapshot')
    }
    clearCardVisuals()
    currentMatch = match
    currentEvent = event
    renderSnapshotCards(match, new Set(event.reveals.map(({ cardId }) => cardId)))
    publishPresentation('prepared')
    renderCurrentFrame()
  }

  function destinationZone(destination) {
    if (destination === 'player.wonPile') return 'playerWonPile'
    if (destination === 'opponent.wonPile') return 'opponentWonPile'
    if (destination === 'burnPile') return 'burnPile'
    throw new RangeError(`Unknown presentation destination: ${String(destination)}`)
  }

  function applyStep(step, context) {
    if (disposed) throw new Error('Battlefield has been destroyed')
    if (currentEvent === null || currentMatch === null) {
      throw new Error('A committed event must begin before applying presentation steps')
    }
    if (
      step === null
      || typeof step !== 'object'
      || context === null
      || typeof context !== 'object'
      || !Number.isFinite(context.durationMs)
      || context.durationMs < 0
    ) {
      throw new TypeError('Presentation step and duration are invalid')
    }

    if (step.kind === 'reveal') {
      const visual = ensureTransientCard(step.cardId, step.suppliedBy)
      const originZone = currentEvent.stage === 'source'
        ? 'sourceDeck'
        : `${step.suppliedBy}DrawPile`
      visual.zoneId = originZone
      visual.offset = Object.freeze({ x: 0, y: 0, z: 0.1 })
      placeTransient(visual)
      startTween(
        visual,
        `${step.suppliedBy}Reveal`,
        transientOffset(step),
        context.durationMs,
      )
      publishPresentation(step.tied ? 'tie-reveal' : 'reveal', step.cardId)
    } else if (step.kind === 'transfer' || step.kind === 'burn') {
      const reveal = currentEvent.reveals.find(({ cardId }) => cardId === step.cardId)
      if (!reveal) throw new Error('Settlement step must reference a revealed card')
      releaseSettledVisuals()
      const visual = ensureSettlementCard(step.cardId, reveal.suppliedBy)
      startTween(
        visual,
        destinationZone(step.to),
        Object.freeze({ x: 0, y: 0, z: 0.14 }),
        context.durationMs,
      )
      settledVisuals.add(visual)
      publishPresentation(step.kind, step.cardId)
    } else if (step.kind === 'retain') {
      publishPresentation('retained-draw')
    } else {
      throw new RangeError(`Unknown presentation step: ${String(step.kind)}`)
    }
    renderCurrentFrame()
  }

  function cancelEvent(reason = 'cancelled') {
    for (const visual of tweens) {
      visual.tween = null
    }
    tweens.clear()
    publishPresentation(reason)
    renderCurrentFrame()
  }

  const handle = {
    syncSnapshot,
    beginEvent,
    applyStep,
    cancelEvent,
    setPaused(nextPaused) {
      if (typeof nextPaused !== 'boolean') {
        throw new TypeError('paused must be a boolean')
      }
      if (disposed || paused === nextPaused) return
      paused = nextPaused
      syncAnimationLoop()
    },
    resize,
    teardown() {
      if (disposed) return
      disposed = true
      if (pendingResizeFrame !== null) {
        cancelFrame?.(pendingResizeFrame)
        pendingResizeFrame = null
      }
      resizeObserver?.disconnect()
      windowObject?.removeEventListener?.('resize', scheduleResize)
      windowObject?.removeEventListener?.('orientationchange', scheduleResize)
      unsubscribeSettings?.()
      let firstError = null
      const attempt = (operation) => {
        try {
          operation()
        } catch (error) {
          firstError ??= error
        }
      }
      attempt(clearCardVisuals)
      attempt(() => textureCache?.destroy())
      textureCache = null
      attempt(() => floorGeometry.dispose())
      attempt(() => floorMaterial.dispose())
      attempt(() => placeholderGeometry.dispose())
      attempt(() => placeholderMaterial.dispose())
      attempt(() => cardGeometry.dispose())
      attempt(disposeRenderer)
      scene.clear()
      if (firstError) throw firstError
    },
    getPresentationState() {
      return Object.freeze({
        eventId: currentEvent?.id ?? null,
        turn: currentMatch?.turn ?? null,
        phase: host.dataset?.presentationPhase ?? null,
        staticCards: staticVisuals.size,
        transientCards: transientVisuals.size,
        tweens: tweens.size,
        cacheEntries: textureCache?.getStats?.().entries ?? 0,
      })
    },
    get layout() {
      return currentLayout
    },
  }
  return Object.freeze(handle)
}

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
import {
  isCampaignState,
  resolveRunCardId,
  runVisualKey,
  validateRunState,
} from '../domain/run-state.js'
import { createTextureCache } from './texture-cache.js'
import { createThemeRegistry } from './themes/registry.js'
import { createInputController } from './input.js'

const FALLBACK_SETTINGS = createSettingsSnapshot(DEFAULT_SETTINGS, false)
const MAX_TRANSIENT_CARDS = 8
const MAX_CONTEST_CARDS = 4
const TEXTURE_CACHE_ENTRIES = 24
const LEGACY_REVEAL_ORIGIN_ZONE = 'contestedPile'
const MINIMUM_DECK_TARGET_SIZE = 44
const DECK_DRAG_LIFT = 0.35
const DEFAULT_CARD_COLOR = 0xffffff
const ACTIVE_DECK_COLOR = 0xd9fbff
const PILE_SCALE_MODE = 'pile'
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

function assertInputController(controller) {
  const methods = ['setEnabled', 'setBusy', 'destroy']
  if (
    controller === null
    || typeof controller !== 'object'
    || methods.some((method) => typeof controller[method] !== 'function')
  ) {
    throw new TypeError('inputControllerFactory must return a compatible input controller')
  }
}

function actionableDeckZone(match) {
  if (match?.status !== 'active') return null
  if (isCampaignState(match)) {
    if (
      match.encounter.supplyMode.player === 'source'
      && match.encounter.zones.playerSourcePile.length > 0
    ) {
      return 'playerSourcePile'
    }
    if (match.encounter.zones.player.drawPile.length > 0) return 'playerDrawPile'
    if (match.encounter.zones.player.wonPile.length > 0) return 'playerWonPile'
    return match.hold === null ? null : 'hold'
  }
  if (match.stage === 'source') {
    return match.zones.sourceDeck.length > 0 ? 'sourceDeck' : null
  }
  if (match.zones.player.drawPile.length > 0) return 'playerDrawPile'
  if (match.zones.player.wonPile.length > 0) return 'playerWonPile'
  return null
}

function decisiveWinningCardId(event) {
  if (event.type !== 'clashSettled') return null
  for (let index = event.reveals.length - 1; index >= 0; index -= 1) {
    if (event.reveals[index].suppliedBy === event.winner) {
      return runVisualKey(event.reveals[index])
    }
  }
  return null
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
  setStyleProperty(host, '--hud-comparison-reserve', `${layout.hud.comparison.height}px`)
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
  onDeckActivate,
  onContextStatus,
  windowObject = globalThis.window,
  ResizeObserverClass = windowObject?.ResizeObserver ?? globalThis.ResizeObserver,
  rendererFactory = (options) => new THREE.WebGLRenderer(options),
  inputControllerFactory = createInputController,
  themeRegistry = createThemeRegistry(),
  themeSelection = undefined,
  textureCacheFactory = createTextureCache,
} = {}) {
  assertHost(host)
  assertSettingsController(settingsController)
  if (onLayout !== undefined && typeof onLayout !== 'function') {
    throw new TypeError('onLayout must be a function')
  }
  if (onDeckActivate !== undefined && typeof onDeckActivate !== 'function') {
    throw new TypeError('onDeckActivate must be a function')
  }
  if (onContextStatus !== undefined && typeof onContextStatus !== 'function') {
    throw new TypeError('onContextStatus must be a function')
  }
  if (typeof rendererFactory !== 'function') {
    throw new TypeError('rendererFactory must be a function')
  }
  if (typeof inputControllerFactory !== 'function') {
    throw new TypeError('inputControllerFactory must be a function')
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
  const deckPointer = new THREE.Vector2()
  const deckRaycaster = new THREE.Raycaster()
  const deckCenter = new THREE.Vector3()
  const deckRightEdge = new THREE.Vector3()
  const deckTopEdge = new THREE.Vector3()
  const dropCenter = new THREE.Vector3()
  const dropRightEdge = new THREE.Vector3()
  const dropTopEdge = new THREE.Vector3()
  const deckDragPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1))
  const deckDragPoint = new THREE.Vector3()
  const deckWorldPosition = new THREE.Vector3()

  let currentSettings = settingsController?.getSnapshot() ?? FALLBACK_SETTINGS
  let renderer = null
  let deckInput = null
  let deckInputEnabled = false
  let deckInputBusy = false
  let activeDeckZoneId = null
  let activeDeckVisual = null
  let deckDrag = null
  let textureCache = null
  let currentLayout = null
  let currentMatch = null
  let currentEvent = null
  let currentDecisiveCardId = null
  let paused = false
  let disposed = false
  let contextRecoveryCount = 0
  let contextState = Object.freeze({
    status: 'ready',
    recoveryCount: contextRecoveryCount,
    reason: null,
  })
  let rendererContextListeners = null
  let previousTime = null
  let animationTime = 0
  let renderedFrames = 0
  let animatedFrames = 0
  let currentPixelRatio = null
  let pendingResizeFrame = null
  const staticVisuals = new Set()
  const transientVisuals = new Map()
  const tweens = new Set()
  const settledVisuals = new Set()
  const appliedEventSteps = []

  const requestFrame = typeof windowObject?.requestAnimationFrame === 'function'
    ? windowObject.requestAnimationFrame.bind(windowObject)
    : null
  const cancelFrame = typeof windowObject?.cancelAnimationFrame === 'function'
    ? windowObject.cancelAnimationFrame.bind(windowObject)
    : null

  if (host.dataset) {
    host.dataset.webglContext = contextState.status
    host.dataset.webglRecoveries = String(contextRecoveryCount)
  }

  function publishContextStatus(status, reason = null) {
    contextState = Object.freeze({
      status,
      recoveryCount: contextRecoveryCount,
      reason,
    })
    if (host.dataset) {
      host.dataset.webglContext = status
      host.dataset.webglRecoveries = String(contextRecoveryCount)
    }
    try {
      onContextStatus?.(contextState)
    } catch (error) {
      globalThis.reportError?.(error)
    }
  }

  function contextReady() {
    return contextState.status === 'ready'
  }

  function publishPresentation(phase, cardId = null) {
    if (!host.dataset) return
    host.dataset.presentationPhase = phase
    host.dataset.presentationEvent = currentEvent?.id ?? ''
    host.dataset.presentationCard = cardId ?? ''
    host.dataset.presentationTurn = currentMatch === null ? '' : String(currentMatch.turn)
    host.dataset.presentationCards = String(staticVisuals.size + transientVisuals.size)
  }

  function publishDeckInput() {
    if (!host.dataset) return
    host.dataset.activeDeckZone = activeDeckZoneId ?? ''
    host.dataset.deckInputEnabled = String(deckInputEnabled)
    host.dataset.deckInputBusy = String(deckInputBusy)
    host.dataset.deckInputAvailable = String(contextReady())
    host.dataset.deckDragging = String(deckDrag !== null)
  }

  function applyDeckInputState() {
    deckInput?.setEnabled(deckInputEnabled && contextReady())
    deckInput?.setBusy(deckInputBusy || !contextReady())
    publishDeckInput()
  }

  function visualScale(visual) {
    if (currentLayout === null) return 1
    if (visual.scaleMode === PILE_SCALE_MODE) {
      return currentLayout.visuals.secondaryPileScale
    }
    if (visual.transient) return currentLayout.visuals.revealScale
    if (visual.zoneId === activeDeckZoneId) {
      return currentLayout.visuals.activeDeckScale
    }
    return currentLayout.visuals.secondaryPileScale
  }

  function applyVisualAppearance(visual) {
    if (visual.tween === null || visual.tween.scale === null) {
      const scale = visualScale(visual)
      visual.mesh.scale.set(scale, scale, 1)
    }
    visual.material.color.setHex(
      !visual.transient && visual.zoneId === activeDeckZoneId
        ? ACTIVE_DECK_COLOR
        : DEFAULT_CARD_COLOR,
    )
  }

  function syncActiveDeckVisual() {
    activeDeckVisual = [...staticVisuals].find(
      (visual) => visual.zoneId === activeDeckZoneId,
    ) ?? null
    for (const visual of [...staticVisuals, ...transientVisuals.values()]) {
      applyVisualAppearance(visual)
    }
    publishDeckInput()
  }

  function hitTestActiveDeck(event) {
    const canvas = renderer?.domElement
    if (
      activeDeckVisual === null
      || canvas === null
      || canvas === undefined
      || !Number.isFinite(event.clientX)
      || !Number.isFinite(event.clientY)
      || typeof canvas.getBoundingClientRect !== 'function'
    ) {
      return false
    }

    const bounds = canvas.getBoundingClientRect()
    if (
      !Number.isFinite(bounds.width)
      || bounds.width <= 0
      || !Number.isFinite(bounds.height)
      || bounds.height <= 0
    ) {
      return false
    }
    deckPointer.set(
      (event.clientX - bounds.left) / bounds.width * 2 - 1,
      -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
    )
    scene.updateMatrixWorld(true)
    camera.updateMatrixWorld(true)
    deckRaycaster.setFromCamera(deckPointer, camera)
    if (deckRaycaster.intersectObject(activeDeckVisual.mesh, false).length > 0) {
      return true
    }

    const mesh = activeDeckVisual.mesh
    mesh.localToWorld(deckCenter.set(0, 0, 0)).project(camera)
    mesh.localToWorld(deckRightEdge.set(0.525, 0, 0)).project(camera)
    mesh.localToWorld(deckTopEdge.set(0, 0.725, 0)).project(camera)
    const centerX = bounds.left + (deckCenter.x + 1) / 2 * bounds.width
    const centerY = bounds.top + (1 - deckCenter.y) / 2 * bounds.height
    const halfWidth = Math.max(
      Math.abs(deckRightEdge.x - deckCenter.x) * bounds.width / 2,
      MINIMUM_DECK_TARGET_SIZE / 2,
    )
    const halfHeight = Math.max(
      Math.abs(deckTopEdge.y - deckCenter.y) * bounds.height / 2,
      MINIMUM_DECK_TARGET_SIZE / 2,
    )
    return (
      Math.abs(event.clientX - centerX) <= halfWidth
      && Math.abs(event.clientY - centerY) <= halfHeight
    )
  }

  function hitTestPlayerReveal(event) {
    const canvas = renderer?.domElement
    const target = currentLayout?.zones.playerReveal
    if (
      deckDrag === null
      || target === null
      || target === undefined
      || canvas === null
      || canvas === undefined
      || !Number.isFinite(event.clientX)
      || !Number.isFinite(event.clientY)
      || typeof canvas.getBoundingClientRect !== 'function'
    ) {
      return false
    }
    const bounds = canvas.getBoundingClientRect()
    if (
      !Number.isFinite(bounds.width)
      || bounds.width <= 0
      || !Number.isFinite(bounds.height)
      || bounds.height <= 0
    ) {
      return false
    }
    camera.updateMatrixWorld(true)
    const scale = currentLayout.visuals.revealScale
    dropCenter.set(target.x, target.y, target.z).project(camera)
    dropRightEdge.set(target.x + 0.525 * scale, target.y, target.z).project(camera)
    dropTopEdge.set(target.x, target.y + 0.725 * scale, target.z).project(camera)
    const centerX = bounds.left + (dropCenter.x + 1) / 2 * bounds.width
    const centerY = bounds.top + (1 - dropCenter.y) / 2 * bounds.height
    const halfWidth = Math.max(
      Math.abs(dropRightEdge.x - dropCenter.x) * bounds.width / 2,
      MINIMUM_DECK_TARGET_SIZE / 2,
    )
    const halfHeight = Math.max(
      Math.abs(dropTopEdge.y - dropCenter.y) * bounds.height / 2,
      MINIMUM_DECK_TARGET_SIZE / 2,
    )
    return (
      Math.abs(event.clientX - centerX) <= halfWidth
      && Math.abs(event.clientY - centerY) <= halfHeight
    )
  }

  function pointOnDeckDragPlane(event, z) {
    const canvas = renderer?.domElement
    if (
      canvas === null
      || canvas === undefined
      || !Number.isFinite(event.clientX)
      || !Number.isFinite(event.clientY)
      || typeof canvas.getBoundingClientRect !== 'function'
    ) {
      return null
    }
    const bounds = canvas.getBoundingClientRect()
    if (
      !Number.isFinite(bounds.width)
      || bounds.width <= 0
      || !Number.isFinite(bounds.height)
      || bounds.height <= 0
    ) {
      return null
    }
    deckPointer.set(
      (event.clientX - bounds.left) / bounds.width * 2 - 1,
      -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
    )
    camera.updateMatrixWorld(true)
    deckRaycaster.setFromCamera(deckPointer, camera)
    deckDragPlane.constant = -z
    return deckRaycaster.ray.intersectPlane(deckDragPlane, deckDragPoint)
  }

  function setDeckDragging(dragging) {
    if (renderer?.domElement?.dataset) {
      renderer.domElement.dataset.deckDragging = String(dragging)
    }
    publishDeckInput()
  }

  function beginDeckDrag(event, gesture) {
    const visual = activeDeckVisual
    if (visual === null || visual.mesh.parent === null) return
    scene.updateMatrixWorld(true)
    const originalParent = visual.mesh.parent
    const originalPosition = visual.mesh.position.clone()
    visual.mesh.getWorldPosition(deckWorldPosition)
    const planeZ = deckWorldPosition.z + DECK_DRAG_LIFT
    scene.attach(visual.mesh)
    visual.mesh.position.z = planeZ
    const startPoint = pointOnDeckDragPlane({
      clientX: gesture.startX,
      clientY: gesture.startY,
    }, planeZ)
    deckDrag = {
      visual,
      originalParent,
      originalPosition,
      planeZ,
      grabOffsetX: startPoint === null ? 0 : visual.mesh.position.x - startPoint.x,
      grabOffsetY: startPoint === null ? 0 : visual.mesh.position.y - startPoint.y,
    }
    setDeckDragging(true)
    renderCurrentFrame()
  }

  function moveDeckDrag(event) {
    if (deckDrag === null) return
    const point = pointOnDeckDragPlane(event, deckDrag.planeZ)
    if (point === null) return
    deckDrag.visual.mesh.position.set(
      point.x + deckDrag.grabOffsetX,
      point.y + deckDrag.grabOffsetY,
      deckDrag.planeZ,
    )
    renderCurrentFrame()
  }

  function finishDeckDrag() {
    const currentDrag = deckDrag
    if (currentDrag === null) return
    deckDrag = null
    currentDrag.originalParent.attach(currentDrag.visual.mesh)
    currentDrag.visual.mesh.position.copy(currentDrag.originalPosition)
    setDeckDragging(false)
    renderCurrentFrame()
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

  function acquireVisualLease(visual) {
    const cache = ensureTextureCache()
    const scale = textureScale()
    return visual.faceUp
      ? cache.acquireFront({
          themeId: selectedThemes.frontThemeId,
          cardId: visual.cardId,
          scale,
        })
      : cache.acquireBack({
          themeId: selectedThemes.backThemeId,
          scale,
        })
  }

  function refreshVisualTextures() {
    for (const visual of [...staticVisuals, ...transientVisuals.values()]) {
      const previousLease = visual.lease
      visual.lease = acquireVisualLease(visual)
      visual.material.map = visual.lease.texture
      visual.material.needsUpdate = true
      previousLease.release()
    }
  }

  function releaseVisual(visual) {
    tweens.delete(visual)
    visual.parent.remove(visual.mesh)
    visual.material.map = null
    visual.material.dispose()
    visual.lease.release()
  }

  function clearCardVisuals() {
    deckInput?.cancel?.()
    finishDeckDrag()
    for (const visual of staticVisuals) releaseVisual(visual)
    staticVisuals.clear()
    for (const visual of transientVisuals.values()) releaseVisual(visual)
    transientVisuals.clear()
    tweens.clear()
    settledVisuals.clear()
    activeDeckVisual = null
  }

  function createCardVisual({
    cardId,
    visualKey = cardId,
    faceUp,
    parent,
    zoneId,
    offset = Object.freeze({ x: 0, y: 0, z: 0 }),
    transient = false,
  }) {
    const lease = acquireVisualLease({ cardId, faceUp })
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
    const visual = {
      cardId,
      visualKey,
      faceUp,
      parent,
      zoneId,
      offset,
      transient,
      mesh,
      material,
      lease,
      scaleMode: null,
      tween: null,
    }
    applyVisualAppearance(visual)
    return visual
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

  function addPileRepresentative(zoneId, identity, faceUp, stackIndex = 0) {
    if (identity === null) return
    const cardId = resolveRunCardId(currentMatch, identity)
    if (cardId === undefined) {
      throw new Error(`Unknown card identity: ${String(identity)}`)
    }
    const visual = createCardVisual({
      cardId,
      visualKey: identity,
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
    activeDeckZoneId = actionableDeckZone(match)
    const zones = isCampaignState(match) ? match.encounter.zones : match.zones
    if (isCampaignState(match)) {
      addPileRepresentative(
        'playerSourcePile',
        firstVisibleCard(zones.playerSourcePile, excluded),
        false,
      )
      addPileRepresentative(
        'opponentSourcePile',
        firstVisibleCard(zones.opponentSourcePile, excluded),
        false,
      )
      addPileRepresentative('hold', match.hold, true)
    } else {
      addPileRepresentative(
        'sourceDeck',
        firstVisibleCard(zones.sourceDeck, excluded),
        false,
      )
    }
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
      .filter((record) => !excluded.has(runVisualKey(record)))
      .slice(-MAX_CONTEST_CARDS)
    contest.forEach((record, index) => {
      addPileRepresentative('contestedPile', runVisualKey(record), true, index)
    })
    addPileRepresentative(
      'burnPile',
      lastVisibleCard(zones.burnPile, excluded),
      true,
    )
    syncActiveDeckVisual()
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

  function startTween(visual, zoneId, offset, durationMs, scaleMode = null) {
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
      scale: scaleMode === null
        ? null
        : {
            from: visual.mesh.scale.x,
            to: currentLayout?.visuals.secondaryPileScale ?? 1,
            mode: scaleMode,
          },
      elapsedMs: 0,
      durationMs,
    }
    tweens.add(visual)
    if (durationMs === 0) {
      visual.mesh.position.set(target.x, target.y, target.z)
      if (visual.tween.scale !== null) {
        const { mode, to } = visual.tween.scale
        visual.mesh.scale.set(to, to, 1)
        visual.scaleMode = mode
      }
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
      if (tween.scale !== null) {
        const scale = tween.scale.from + (tween.scale.to - tween.scale.from) * eased
        visual.mesh.scale.set(scale, scale, 1)
      }
      if (progress >= 1) {
        if (tween.scale !== null) visual.scaleMode = tween.scale.mode
        visual.tween = null
        tweens.delete(visual)
      }
    }
  }

  function rebaseTween(visual) {
    const tween = visual.tween
    if (tween === null) return null
    tween.from = {
      x: visual.mesh.position.x,
      y: visual.mesh.position.y,
      z: visual.mesh.position.z,
    }
    if (tween.scale !== null) tween.scale.from = visual.mesh.scale.x
    tween.durationMs = Math.max(0, tween.durationMs - tween.elapsedMs)
    tween.elapsedMs = 0
    return tween
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
      const [visualKey, visual] = oldest
      transientVisuals.delete(visualKey)
      releaseVisual(visual)
    }
  }

  function ensureTransientCard(visualKey, cardId, suppliedBy) {
    const existing = transientVisuals.get(visualKey)
    if (existing) return existing
    trimTransientCards()
    const zoneId = `${suppliedBy}Reveal`
    const visual = createCardVisual({
      cardId,
      visualKey,
      faceUp: true,
      parent: scene,
      zoneId,
      transient: true,
    })
    transientVisuals.set(visualKey, visual)
    placeTransient(visual)
    return visual
  }

  function releaseSettledVisuals() {
    for (const visual of settledVisuals) {
      if (transientVisuals.get(visual.visualKey) === visual) {
        transientVisuals.delete(visual.visualKey)
      }
      releaseVisual(visual)
    }
    settledVisuals.clear()
  }

  function ensureSettlementCard(visualKey, cardId, suppliedBy) {
    const existing = transientVisuals.get(visualKey)
    if (existing) return existing
    const visual = createCardVisual({
      cardId,
      visualKey,
      faceUp: true,
      parent: scene,
      zoneId: 'contestedPile',
      offset: Object.freeze({ x: 0, y: 0, z: 0.12 }),
      transient: true,
    })
    transientVisuals.set(visualKey, visual)
    placeTransient(visual)
    return visual
  }

  function rescaleTweens(previousSpeed, nextSpeed) {
    if (Object.is(previousSpeed, nextSpeed)) return
    for (const visual of tweens) {
      const tween = rebaseTween(visual)
      if (tween === null) continue
      tween.durationMs *= previousSpeed / nextSpeed
    }
  }

  function renderCurrentFrame() {
    if (!renderer || !contextReady()) return
    placeholderMaterial.opacity = 0.18 + Math.sin(animationTime * 0.0015) * 0.035
    renderer.render(scene, camera)
    renderedFrames += 1
  }

  function animate(time) {
    if (!contextReady()) return
    animatedFrames += 1
    if (previousTime !== null) {
      const delta = Math.max(0, time - previousTime)
      animationTime += delta * currentSettings.animationSpeed
      advanceTweens(delta)
    }
    previousTime = time
    renderCurrentFrame()
  }

  function shouldAnimate() {
    return contextReady() && !paused && !currentSettings.reducedMotion
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
    const currentDeckInput = deckInput
    deckInput = null
    const currentRenderer = renderer
    renderer = null
    const contextListeners = rendererContextListeners
    rendererContextListeners = null
    if (contextListeners?.renderer === currentRenderer) {
      currentRenderer.domElement?.removeEventListener?.(
        'webglcontextlost',
        contextListeners.lost,
      )
      currentRenderer.domElement?.removeEventListener?.(
        'webglcontextrestored',
        contextListeners.restored,
      )
    }
    try {
      currentDeckInput?.destroy()
    } finally {
      try {
        currentRenderer.setAnimationLoop(null)
      } finally {
        try {
          currentRenderer.dispose()
        } finally {
          currentRenderer.domElement?.remove?.()
        }
      }
    }
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
    nextRenderer.domElement.disabled = false
    const lost = (event) => handleContextLost(event, nextRenderer)
    const restored = () => handleContextRestored(nextRenderer)
    nextRenderer.domElement.addEventListener?.('webglcontextlost', lost)
    nextRenderer.domElement.addEventListener?.('webglcontextrestored', restored)
    rendererContextListeners = { renderer: nextRenderer, lost, restored }
    host.append(nextRenderer.domElement)
    renderer = nextRenderer
    if (onDeckActivate !== undefined) {
      try {
        deckInput = inputControllerFactory({
          target: nextRenderer.domElement,
          onActivate: onDeckActivate,
          hitTest: hitTestActiveDeck,
          drag: {
            dropTest: hitTestPlayerReveal,
            onStart: beginDeckDrag,
            onMove: moveDeckDrag,
            onEnd: finishDeckDrag,
            onCancel: finishDeckDrag,
          },
          enabled: deckInputEnabled && contextReady(),
          busy: deckInputBusy || !contextReady(),
        })
        assertInputController(deckInput)
      } catch (error) {
        deckInput?.destroy?.()
        deckInput = null
        disposeRenderer()
        throw error
      }
    }
  }

  function contextFailureReason(error) {
    return error instanceof Error && error.message
      ? error.message
      : 'renderer-recreation-failed'
  }

  function handleContextLost(event, sourceRenderer) {
    event?.preventDefault?.()
    if (
      disposed
      || renderer !== sourceRenderer
      || contextState.status !== 'ready'
    ) {
      return
    }
    publishContextStatus('lost')
    previousTime = null
    sourceRenderer.setAnimationLoop(null)
    deckInput?.cancel?.()
    finishDeckDrag()
    applyDeckInputState()
  }

  function restoreContextResources() {
    const retainedMatch = currentMatch
    const retainedEvent = currentEvent
    const retainedSteps = [...appliedEventSteps]
    try {
      clearCardVisuals()
      textureCache?.destroy()
      textureCache = null
      disposeRenderer()
      createRenderer()
      currentMatch = retainedMatch
      currentEvent = retainedEvent
      currentDecisiveCardId = retainedEvent === null
        ? null
        : decisiveWinningCardId(retainedEvent)
      if (retainedMatch !== null) {
        const excluded = retainedEvent === null
          ? new Set()
          : new Set(retainedEvent.reveals.map(runVisualKey))
        renderSnapshotCards(retainedMatch, excluded)
        for (const step of retainedSteps) applyPresentationStep(step, 0)
      }
      contextRecoveryCount += 1
      publishContextStatus('ready')
      applyDeckInputState()
      resize()
      syncAnimationLoop()
    } catch (error) {
      try {
        clearCardVisuals()
      } catch {}
      try {
        textureCache?.destroy()
      } catch {}
      textureCache = null
      try {
        disposeRenderer()
      } catch {}
      publishContextStatus('failed', contextFailureReason(error))
      globalThis.reportError?.(error)
    }
  }

  function handleContextRestored(sourceRenderer) {
    if (
      disposed
      || renderer !== sourceRenderer
      || contextState.status !== 'lost'
    ) {
      return
    }
    publishContextStatus('restoring')
    restoreContextResources()
  }

  function resize() {
    if (disposed || !renderer) return null
    deckInput?.cancel?.()
    finishDeckDrag()
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
    for (const visual of [...staticVisuals, ...transientVisuals.values()]) {
      applyVisualAppearance(visual)
    }
    for (const visual of transientVisuals.values()) {
      if (visual.tween === null) {
        placeTransient(visual)
      } else {
        const tween = rebaseTween(visual)
        tween.to = zoneWorldPosition(visual.zoneId, visual.offset)
        if (tween.scale !== null) {
          tween.scale.to = currentLayout.visuals.secondaryPileScale
        }
      }
    }

    const devicePixelRatio = Number.isFinite(windowObject?.devicePixelRatio)
      && windowObject.devicePixelRatio > 0
      ? windowObject.devicePixelRatio
      : 1
    currentPixelRatio = Math.min(devicePixelRatio, currentSettings.renderScaleCap)
    renderer.setPixelRatio(currentPixelRatio)
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
    publishDeckInput()
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
    if (!contextReady()) {
      return
    }
    if (qualityChanged) {
      refreshVisualTextures()
      rebuildRenderer()
    } else {
      resize()
      syncAnimationLoop()
    }
  })

  function syncSnapshot(match, context = {}) {
    if (disposed) throw new Error('Battlefield has been destroyed')
    validateRunState(match)
    appliedEventSteps.length = 0
    if (!contextReady()) {
      currentMatch = match
      currentEvent = null
      currentDecisiveCardId = null
      publishPresentation(contextState.status)
      return
    }
    clearCardVisuals()
    currentMatch = match
    currentEvent = null
    currentDecisiveCardId = null
    renderSnapshotCards(match)
    publishPresentation(context.reason === 'skipped' ? 'skipped' : 'snapshot')
    renderCurrentFrame()
  }

  function beginEvent(event, match) {
    if (disposed) throw new Error('Battlefield has been destroyed')
    validateRunState(match)
    validateCommittedEvent(event)
    if (
      match.pendingEvent === null
      || match.pendingEvent.id !== event.id
      || match.pendingEvent.stateFingerprint !== event.stateFingerprint
    ) {
      throw new Error('Presentation event must match the committed snapshot')
    }
    appliedEventSteps.length = 0
    if (!contextReady()) {
      currentMatch = match
      currentEvent = event
      currentDecisiveCardId = decisiveWinningCardId(event)
      publishPresentation(contextState.status)
      return
    }
    clearCardVisuals()
    currentMatch = match
    currentEvent = event
    currentDecisiveCardId = decisiveWinningCardId(event)
    renderSnapshotCards(match, new Set(event.reveals.map(runVisualKey)))
    publishPresentation('prepared')
    renderCurrentFrame()
  }

  function destinationZone(destination) {
    if (destination === 'player.wonPile') return 'playerWonPile'
    if (destination === 'opponent.wonPile') return 'opponentWonPile'
    if (destination === 'burnPile') return 'burnPile'
    throw new RangeError(`Unknown presentation destination: ${String(destination)}`)
  }

  function applyPresentationStep(step, durationMs) {
    if (step.kind === 'reveal') {
      const visual = ensureTransientCard(step.visualKey ?? step.cardId, step.cardId, step.suppliedBy)
      const originZone = step.from === 'sourceDeck'
        ? 'sourceDeck'
        : step.from === 'player.sourcePile'
          ? 'playerSourcePile'
          : step.from === 'opponent.sourcePile'
            ? 'opponentSourcePile'
            : step.from === 'player.hold'
              ? 'hold'
        : step.from === 'player.drawPile'
          ? 'playerDrawPile'
          : step.from === 'opponent.drawPile'
            ? 'opponentDrawPile'
            : currentEvent.stage === 'source'
              ? 'sourceDeck'
              : LEGACY_REVEAL_ORIGIN_ZONE
      visual.zoneId = originZone
      visual.offset = Object.freeze({ x: 0, y: 0, z: 0.1 })
      placeTransient(visual)
      startTween(
        visual,
        `${step.suppliedBy}Reveal`,
        transientOffset(step),
        durationMs,
      )
      publishPresentation(step.tied ? 'tie-reveal' : 'reveal', step.cardId)
    } else if (step.kind === 'transfer' || step.kind === 'burn') {
      const stepKey = step.visualKey ?? step.cardId
      const reveal = currentEvent.reveals.find((record) => runVisualKey(record) === stepKey)
      if (!reveal) throw new Error('Settlement step must reference a revealed card')
      releaseSettledVisuals()
      const visual = ensureSettlementCard(stepKey, step.cardId, reveal.suppliedBy)
      startTween(
        visual,
        destinationZone(step.to),
        Object.freeze({ x: 0, y: 0, z: 0.14 }),
        durationMs,
        step.kind === 'transfer' && stepKey === currentDecisiveCardId
          ? PILE_SCALE_MODE
          : null,
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
    if (!contextReady()) {
      publishPresentation(contextState.status)
      return
    }

    applyPresentationStep(step, context.durationMs)
    appliedEventSteps.push(step)
  }

  function cancelEvent(reason = 'cancelled') {
    for (const visual of tweens) {
      visual.tween = null
    }
    tweens.clear()
    publishPresentation(reason)
    renderCurrentFrame()
  }

  function setDeckInputState({ enabled, busy } = {}) {
    if (typeof enabled !== 'boolean' || typeof busy !== 'boolean') {
      throw new TypeError('deck input enabled and busy must be booleans')
    }
    deckInputEnabled = enabled
    deckInputBusy = busy
    applyDeckInputState()
  }

  const handle = {
    syncSnapshot,
    beginEvent,
    applyStep,
    cancelEvent,
    setDeckInputState,
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
    getContextState() {
      return contextState
    },
    getRetainedSnapshot() {
      return currentMatch
    },
    getPerformanceSnapshot() {
      const renderInfo = renderer?.info?.render
      const memoryInfo = renderer?.info?.memory
      return Object.freeze({
        context: contextState,
        animationActive: shouldAnimate(),
        renderedFrames,
        animatedFrames,
        pixelRatio: currentPixelRatio,
        renderer: renderer === null
          ? null
          : Object.freeze({
              calls: renderInfo?.calls ?? null,
              triangles: renderInfo?.triangles ?? null,
              points: renderInfo?.points ?? null,
              lines: renderInfo?.lines ?? null,
              geometries: memoryInfo?.geometries ?? null,
              textures: memoryInfo?.textures ?? null,
            }),
        resources: Object.freeze({
          staticCards: staticVisuals.size,
          transientCards: transientVisuals.size,
          tweens: tweens.size,
          cacheEntries: textureCache?.getStats?.().entries ?? 0,
        }),
      })
    },
    getDeckInputState() {
      return Object.freeze({
        activeZone: activeDeckZoneId,
        enabled: deckInputEnabled,
        busy: deckInputBusy,
      })
    },
    get layout() {
      return currentLayout
    },
  }
  return Object.freeze(handle)
}

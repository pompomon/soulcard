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

const FALLBACK_SETTINGS = createSettingsSnapshot(DEFAULT_SETTINGS, false)
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
} = {}) {
  assertHost(host)
  assertSettingsController(settingsController)
  if (onLayout !== undefined && typeof onLayout !== 'function') {
    throw new TypeError('onLayout must be a function')
  }
  if (typeof rendererFactory !== 'function') {
    throw new TypeError('rendererFactory must be a function')
  }

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
  for (const zoneId of BATTLEFIELD_ZONE_IDS) {
    const group = new THREE.Group()
    group.name = `battlefield-zone:${zoneId}`
    group.add(new THREE.Mesh(placeholderGeometry, placeholderMaterial))
    zoneGroups.set(zoneId, group)
    scene.add(group)
  }

  let currentSettings = settingsController?.getSnapshot() ?? FALLBACK_SETTINGS
  let renderer = null
  let currentLayout = null
  let paused = false
  let disposed = false
  let previousTime = null
  let animationTime = 0
  let pendingResizeFrame = null

  const requestFrame = typeof windowObject?.requestAnimationFrame === 'function'
    ? windowObject.requestAnimationFrame.bind(windowObject)
    : null
  const cancelFrame = typeof windowObject?.cancelAnimationFrame === 'function'
    ? windowObject.cancelAnimationFrame.bind(windowObject)
    : null

  function renderCurrentFrame() {
    if (!renderer) return
    placeholderMaterial.opacity = 0.18 + Math.sin(animationTime * 0.0015) * 0.035
    renderer.render(scene, camera)
  }

  function animate(time) {
    if (previousTime !== null) {
      animationTime += Math.max(0, time - previousTime) * currentSettings.animationSpeed
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
    currentSettings = settings
    if (qualityChanged) {
      rebuildRenderer()
    } else {
      resize()
      syncAnimationLoop()
    }
  })

  const handle = {
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
      disposeRenderer()
      floorGeometry.dispose()
      floorMaterial.dispose()
      placeholderGeometry.dispose()
      placeholderMaterial.dispose()
      scene.clear()
    },
    get layout() {
      return currentLayout
    },
  }
  return Object.freeze(handle)
}

import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'
import { createMatch, revealOrContinue } from '../../src/domain/match-machine.js'
import { BASELINE_RULESET } from '../../src/domain/ruleset.js'
import { mountBattlefield } from '../../src/presentation/battlefield.js'
import { createEventTimeline } from '../../src/presentation/event-player.js'

class FakeStyle {
  constructor(values = {}) {
    this.values = new Map(Object.entries(values))
  }

  setProperty(property, value) {
    this.values.set(property, value)
  }

  getPropertyValue(property) {
    return this.values.get(property) ?? ''
  }
}

class FakeCanvas {
  constructor(host) {
    this.host = host
    this.attributes = {}
    this.dataset = {}
    this.disabled = false
    this.listeners = new Map()
    this.ownerDocument = null
    this.removeCalls = 0
    this.capturedPointers = new Set()
  }

  setAttribute(name, value) {
    this.attributes[name] = value
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener)
  }

  setPointerCapture(pointerId) {
    this.capturedPointers.add(pointerId)
  }

  hasPointerCapture(pointerId) {
    return this.capturedPointers.has(pointerId)
  }

  releasePointerCapture(pointerId) {
    this.capturedPointers.delete(pointerId)
  }

  dispatch(type, values = {}) {
    const event = {
      type,
      button: type.startsWith('pointer') ? 0 : undefined,
      detail: 0,
      isPrimary: true,
      pointerId: 1,
      pointerType: 'mouse',
      clientX: this.host.width / 2,
      clientY: this.host.height / 2,
      preventDefault() {},
      stopPropagation() {},
      ...values,
    }
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event)
    return event
  }

  getBoundingClientRect() {
    return {
      top: 0,
      right: this.host.width,
      bottom: this.host.height,
      left: 0,
      width: this.host.width,
      height: this.host.height,
    }
  }

  remove() {
    this.removeCalls += 1
    const index = this.host.children.indexOf(this)
    if (index >= 0) this.host.children.splice(index, 1)
  }
}

class FakeRenderer {
  constructor(host, options) {
    this.options = options
    this.domElement = new FakeCanvas(host)
    this.animationLoops = []
    this.pixelRatios = []
    this.sizes = []
    this.renderCalls = 0
    this.disposeCalls = 0
  }

  setAnimationLoop(loop) {
    this.animationLoops.push(loop)
    this.animationLoop = loop
  }

  setPixelRatio(value) {
    this.pixelRatios.push(value)
  }

  setSize(width, height, updateStyle) {
    this.sizes.push([width, height, updateStyle])
  }

  render(scene, camera) {
    this.scene = scene
    this.camera = camera
    this.renderCalls += 1
  }

  dispose() {
    this.onDispose?.()
    this.disposeCalls += 1
  }
}

function clientPointFor(mesh, renderer, host) {
  renderer.scene.updateMatrixWorld(true)
  renderer.camera.updateMatrixWorld(true)
  const point = mesh.getWorldPosition(new THREE.Vector3()).project(renderer.camera)
  return {
    clientX: (point.x + 1) / 2 * host.width,
    clientY: (1 - point.y) / 2 * host.height,
  }
}

function clientPointForPosition(position, renderer, host) {
  renderer.scene.updateMatrixWorld(true)
  renderer.camera.updateMatrixWorld(true)
  const point = new THREE.Vector3(position.x, position.y, position.z).project(renderer.camera)
  return {
    clientX: (point.x + 1) / 2 * host.width,
    clientY: (1 - point.y) / 2 * host.height,
  }
}

function createHost(width = 0, height = 0) {
  return {
    width,
    height,
    clientWidth: width,
    clientHeight: height,
    children: [],
    dataset: {},
    style: new FakeStyle({
      '--safe-area-top': '0px',
      '--safe-area-right': '0px',
      '--safe-area-bottom': '0px',
      '--safe-area-left': '0px',
    }),
    append(child) {
      this.children.push(child)
    },
    getBoundingClientRect() {
      return { width: this.width, height: this.height }
    },
  }
}

function createWindow({
  width = 360,
  height = 640,
  devicePixelRatio = 3,
} = {}) {
  const listeners = new Map()
  const frames = new Map()
  let nextFrame = 1
  return {
    innerWidth: width,
    innerHeight: height,
    devicePixelRatio,
    addEventListener(type, listener) {
      const values = listeners.get(type) ?? new Set()
      values.add(listener)
      listeners.set(type, values)
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener)
    },
    requestAnimationFrame(callback) {
      const id = nextFrame
      nextFrame += 1
      frames.set(id, callback)
      return id
    },
    cancelAnimationFrame(id) {
      frames.delete(id)
    },
    getComputedStyle: (element) => element.style,
    dispatch(type) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener({ type })
    },
    flushFrames() {
      const pending = [...frames.values()]
      frames.clear()
      for (const callback of pending) callback(16)
    },
    listenerCount(type) {
      return listeners.get(type)?.size ?? 0
    },
    get pendingFrames() {
      return frames.size
    },
  }
}

function createSettings(overrides = {}) {
  let snapshot = Object.freeze({
    quality: 'balanced',
    renderScaleCap: 1.5,
    animationSpeed: 1,
    reducedMotionOverride: null,
    reducedMotion: false,
    ...overrides,
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

function transitionAt(seed, turn) {
  let match = createMatch({
    runId: `battlefield-transition-${seed}`,
    seed,
    ruleset: BASELINE_RULESET,
  })
  while (match.status === 'active') {
    const transition = revealOrContinue(match)
    match = transition.match
    if (transition.event.turn === turn) return transition
  }
  throw new Error(`Seed ${seed} ended before turn ${turn}`)
}

function createObserverHarness() {
  const instances = []
  class FakeResizeObserver {
    constructor(callback) {
      this.callback = callback
      this.disconnectCalls = 0
      instances.push(this)
    }

    observe(target) {
      this.target = target
    }

    disconnect() {
      this.disconnectCalls += 1
    }
  }
  return { FakeResizeObserver, instances }
}

function createTextureCacheHarness() {
  const acquisitions = []
  const leases = []
  let destroyCalls = 0
  const cache = {
    acquireFront(options) {
      acquisitions.push(['front', options])
      return createLease('front', options.cardId)
    },
    acquireBack(options) {
      acquisitions.push(['back', options])
      return createLease('back', null)
    },
    destroy() {
      destroyCalls += 1
    },
    getStats() {
      return { entries: acquisitions.length }
    },
  }
  function createLease(kind, cardId) {
    const lease = {
      kind,
      cardId,
      texture: {},
      releaseCalls: 0,
      release() {
        this.releaseCalls += 1
      },
    }
    leases.push(lease)
    return lease
  }
  return {
    cache,
    acquisitions,
    leases,
    get destroyCalls() {
      return destroyCalls
    },
  }
}

test('battlefield remeasures a zero-size mount and responds to resize and orientation', () => {
  const host = createHost()
  const windowObject = createWindow()
  const settingsController = createSettings()
  const observer = createObserverHarness()
  const renderers = []
  const layouts = []
  const handle = mountBattlefield(host, {
    settingsController,
    windowObject,
    ResizeObserverClass: observer.FakeResizeObserver,
    rendererFactory(options) {
      const renderer = new FakeRenderer(host, options)
      renderers.push(renderer)
      return renderer
    },
    onLayout: (layout) => layouts.push(layout),
  })

  assert.equal(renderers.length, 1)
  assert.deepEqual(renderers[0].options, { antialias: true, alpha: true })
  assert.deepEqual(renderers[0].sizes.at(-1), [360, 640, false])
  assert.equal(renderers[0].pixelRatios.at(-1), 1.5)
  assert.equal(handle.layout.mode, 'phone-portrait')
  assert.equal(host.dataset.layoutMode, 'phone-portrait')
  assert.equal(host.style.getPropertyValue('--hud-comparison-reserve'), '80px')
  assert.equal(host.children.length, 1)
  assert.equal(host.children[0].attributes['aria-hidden'], 'true')
  assert.equal(host.children[0].attributes.role, 'presentation')
  assert.equal(observer.instances[0].target, host)
  assert.equal(windowObject.listenerCount('resize'), 1)
  assert.equal(windowObject.listenerCount('orientationchange'), 1)

  windowObject.flushFrames()
  host.width = 1280
  host.height = 800
  observer.instances[0].callback()
  windowObject.flushFrames()
  assert.equal(handle.layout.mode, 'desktop')
  assert.deepEqual(renderers[0].sizes.at(-1), [1280, 800, false])

  host.width = 844
  host.height = 390
  windowObject.dispatch('orientationchange')
  windowObject.flushFrames()
  assert.equal(handle.layout.mode, 'phone-landscape')
  assert.equal(handle.layout.viewport.letterboxed, false)
  assert.equal(layouts.at(-1).mode, 'phone-landscape')

  handle.teardown()
  handle.teardown()
  assert.equal(observer.instances[0].disconnectCalls, 1)
  assert.equal(renderers[0].disposeCalls, 1)
  assert.equal(renderers[0].domElement.removeCalls, 1)
  assert.equal(host.children.length, 0)
  assert.equal(windowObject.listenerCount('resize'), 0)
  assert.equal(windowObject.listenerCount('orientationchange'), 0)
})

test('quality rebuilds the renderer while pause and reduced motion stop presentation only', () => {
  const host = createHost(1024, 768)
  const windowObject = createWindow({ width: 1024, height: 768, devicePixelRatio: 2 })
  const settingsController = createSettings({ renderScaleCap: 2 })
  const observer = createObserverHarness()
  const renderers = []
  const handle = mountBattlefield(host, {
    settingsController,
    windowObject,
    ResizeObserverClass: observer.FakeResizeObserver,
    rendererFactory(options) {
      const renderer = new FakeRenderer(host, options)
      renderers.push(renderer)
      return renderer
    },
  })
  windowObject.flushFrames()

  assert.equal(typeof renderers[0].animationLoop, 'function')
  const sceneResources = new Set()
  renderers[0].scene.traverse((object) => {
    if (object.geometry) sceneResources.add(object.geometry)
    if (object.material) sceneResources.add(object.material)
  })
  assert.equal(sceneResources.size, 4)
  const resourceDisposals = new Map(
    [...sceneResources].map((resource) => [resource, 0]),
  )
  for (const resource of sceneResources) {
    resource.addEventListener('dispose', () => {
      resourceDisposals.set(resource, resourceDisposals.get(resource) + 1)
    })
  }
  handle.setPaused(true)
  assert.equal(renderers[0].animationLoop, null)

  const initialMatch = createMatch({
    runId: 'presentation-independent',
    seed: 12345,
    ruleset: BASELINE_RULESET,
  })
  const expected = revealOrContinue(initialMatch)
  assert.deepEqual(revealOrContinue(initialMatch), expected)

  renderers[0].onDispose = () => {
    assert.ok([...resourceDisposals.values()].every((count) => count === 0))
  }
  settingsController.emit({ quality: 'low', renderScaleCap: 1 })
  assert.equal(renderers.length, 2)
  assert.equal(renderers[0].disposeCalls, 1)
  assert.equal(renderers[0].domElement.removeCalls, 1)
  assert.deepEqual(renderers[1].options, { antialias: false, alpha: true })
  assert.equal(renderers[1].pixelRatios.at(-1), 1)
  assert.equal(renderers[1].animationLoop, null)

  handle.setPaused(false)
  assert.equal(typeof renderers[1].animationLoop, 'function')
  settingsController.emit({ reducedMotion: true })
  assert.equal(renderers[1].animationLoop, null)
  assert.ok(renderers[1].renderCalls > 0)
  assert.throws(() => handle.setPaused('yes'), /boolean/)

  renderers[1].onDispose = () => {
    assert.ok([...resourceDisposals.values()].every((count) => count === 1))
  }
  handle.teardown()
  assert.equal(renderers[1].disposeCalls, 1)
  assert.equal(host.children.length, 0)
})

test('context loss suspends rendering and input, then rebuilds resources from retained state', () => {
  const host = createHost(1024, 768)
  const windowObject = createWindow({ width: 1024, height: 768, devicePixelRatio: 2 })
  const observer = createObserverHarness()
  const renderers = []
  const textureCaches = []
  const contextStates = []
  const handle = mountBattlefield(host, {
    windowObject,
    ResizeObserverClass: observer.FakeResizeObserver,
    rendererFactory(options) {
      const renderer = new FakeRenderer(host, options)
      renderers.push(renderer)
      return renderer
    },
    textureCacheFactory() {
      const harness = createTextureCacheHarness()
      textureCaches.push(harness)
      return harness.cache
    },
    onDeckActivate() {},
    onContextStatus: (state) => contextStates.push(state),
  })
  windowObject.flushFrames()

  const initial = createMatch({
    runId: 'battlefield-context-recovery',
    seed: 0,
    ruleset: BASELINE_RULESET,
  })
  handle.syncSnapshot(initial)
  handle.setDeckInputState({ enabled: true, busy: false })
  const firstRenderer = renderers[0]
  const firstCanvas = firstRenderer.domElement
  const animate = firstRenderer.animationLoop
  const rendersBeforeLoss = firstRenderer.renderCalls
  let prevented = 0

  firstCanvas.dispatch('webglcontextlost', {
    preventDefault() {
      prevented += 1
    },
  })
  assert.equal(prevented, 1)
  assert.deepEqual(handle.getContextState(), {
    status: 'lost',
    recoveryCount: 0,
    reason: null,
  })
  assert.equal(firstRenderer.animationLoop, null)
  assert.equal(firstCanvas.disabled, true)
  animate(100)
  assert.equal(firstRenderer.renderCalls, rendersBeforeLoss)

  const transition = revealOrContinue(initial)
  handle.syncSnapshot(transition.match)
  assert.equal(handle.getPresentationState().turn, transition.match.turn)
  firstCanvas.dispatch('webglcontextrestored')

  assert.equal(renderers.length, 2)
  assert.equal(firstRenderer.disposeCalls, 1)
  assert.equal(firstRenderer.domElement.removeCalls, 1)
  assert.equal(textureCaches[0].destroyCalls, 1)
  assert.deepEqual(handle.getContextState(), {
    status: 'ready',
    recoveryCount: 1,
    reason: null,
  })
  assert.equal(handle.getPresentationState().turn, transition.match.turn)
  assert.ok(handle.getPresentationState().staticCards > 0)
  assert.equal(renderers[1].domElement.disabled, false)
  assert.equal(host.children.length, 1)
  assert.equal(firstCanvas.listeners.get('webglcontextlost')?.size ?? 0, 0)
  assert.equal(firstCanvas.listeners.get('webglcontextrestored')?.size ?? 0, 0)

  const timeline = createEventTimeline(transition.event)
  handle.beginEvent(transition.event, transition.match)
  handle.applyStep(timeline[0], { durationMs: 100 })
  assert.equal(handle.getPresentationState().eventId, transition.event.id)
  assert.ok(handle.getPresentationState().transientCards > 0)

  const secondCanvas = renderers[1].domElement
  secondCanvas.dispatch('webglcontextlost')
  secondCanvas.dispatch('webglcontextrestored')
  assert.equal(renderers.length, 3)
  assert.deepEqual(handle.getContextState(), {
    status: 'ready',
    recoveryCount: 2,
    reason: null,
  })
  assert.equal(handle.getPresentationState().eventId, transition.event.id)
  assert.equal(handle.getPresentationState().phase, 'prepared')
  assert.equal(handle.getPresentationState().transientCards, 0)
  handle.applyStep(timeline[1], { durationMs: 0 })
  assert.equal(handle.getPresentationState().eventId, transition.event.id)
  assert.equal(textureCaches[1].destroyCalls, 1)
  assert.deepEqual(
    contextStates.map(({ status }) => status),
    ['lost', 'restoring', 'ready', 'lost', 'restoring', 'ready'],
  )

  const finalCanvas = renderers[2].domElement
  handle.teardown()
  assert.equal(finalCanvas.listeners.get('webglcontextlost')?.size ?? 0, 0)
  assert.equal(finalCanvas.listeners.get('webglcontextrestored')?.size ?? 0, 0)
  assert.equal(textureCaches[2].destroyCalls, 1)
})

test('context restoration failures remain paused and expose a stable failure state', () => {
  const host = createHost(1024, 768)
  const windowObject = createWindow({ width: 1024, height: 768 })
  const observer = createObserverHarness()
  const renderer = new FakeRenderer(host, {})
  let rendererCalls = 0
  const contextStates = []
  const handle = mountBattlefield(host, {
    windowObject,
    ResizeObserverClass: observer.FakeResizeObserver,
    rendererFactory() {
      rendererCalls += 1
      if (rendererCalls > 1) throw new Error('replacement unavailable')
      return renderer
    },
    textureCacheFactory: () => createTextureCacheHarness().cache,
    onContextStatus: (state) => contextStates.push(state),
  })
  handle.syncSnapshot(createMatch({
    runId: 'battlefield-context-failure',
    seed: 1,
    ruleset: BASELINE_RULESET,
  }))

  renderer.domElement.dispatch('webglcontextlost')
  renderer.domElement.dispatch('webglcontextrestored')

  assert.deepEqual(handle.getContextState(), {
    status: 'failed',
    recoveryCount: 0,
    reason: 'replacement unavailable',
  })
  assert.equal(handle.getPerformanceSnapshot().animationActive, false)
  assert.equal(handle.getPerformanceSnapshot().renderer, null)
  assert.equal(host.children.length, 0)
  assert.deepEqual(
    contextStates.map(({ status }) => status),
    ['lost', 'restoring', 'failed'],
  )
  handle.teardown()
})

test('battlefield renders committed snapshots and routes event cards through bounded visuals', () => {
  const host = createHost(1024, 768)
  const windowObject = createWindow({ width: 1024, height: 768, devicePixelRatio: 2 })
  const settingsController = createSettings({ renderScaleCap: 2 })
  const observer = createObserverHarness()
  const renderers = []
  const textures = createTextureCacheHarness()
  const handle = mountBattlefield(host, {
    settingsController,
    windowObject,
    ResizeObserverClass: observer.FakeResizeObserver,
    rendererFactory(options) {
      const renderer = new FakeRenderer(host, options)
      renderers.push(renderer)
      return renderer
    },
    textureCacheFactory: () => textures.cache,
  })
  windowObject.flushFrames()

  const initial = createMatch({
    runId: 'battlefield-presentation',
    seed: 0,
    ruleset: BASELINE_RULESET,
  })
  handle.syncSnapshot(initial, { reason: 'snapshot' })
  assert.deepEqual(handle.getPresentationState(), {
    eventId: null,
    turn: 0,
    phase: 'snapshot',
    staticCards: 1,
    transientCards: 0,
    tweens: 0,
    cacheEntries: 1,
  })
  assert.equal(textures.acquisitions[0][0], 'back')
  settingsController.emit({ quality: 'high' })
  assert.equal(textures.acquisitions.at(-1)[1].scale, 3)
  assert.equal(textures.leases[0].releaseCalls, 1)

  const transition = revealOrContinue(initial)
  const timeline = createEventTimeline(transition.event)
  handle.beginEvent(transition.event, transition.match)
  for (const [index, step] of timeline.entries()) {
    handle.applyStep(step, {
      event: transition.event,
      match: transition.match,
      stepIndex: index,
      stepCount: timeline.length,
      durationMs: 10,
    })
    renderers.at(-1).animationLoop(index * 20)
  }

  const active = handle.getPresentationState()
  assert.equal(active.eventId, transition.event.id)
  assert.equal(active.turn, 1)
  assert.ok(active.transientCards > 0)
  assert.ok(active.transientCards <= 8)
  assert.equal(active.phase, timeline.at(-1).kind)
  assert.ok(textures.acquisitions.some(([kind]) => kind === 'front'))
  assert.ok(textures.acquisitions.slice(1).every(([, options]) => options.scale === 3))

  handle.syncSnapshot(transition.match, { reason: 'completed' })
  assert.equal(handle.getPresentationState().transientCards, 0)
  assert.equal(handle.getPresentationState().phase, 'snapshot')
  assert.ok(textures.leases.some(({ releaseCalls }) => releaseCalls === 1))

  handle.teardown()
  assert.equal(textures.destroyCalls, 1)
  assert.ok(textures.leases.every(({ releaseCalls }) => releaseCalls === 1))
})

test('opponent winning card scales down while moving to its pile', () => {
  const host = createHost(1024, 768)
  const windowObject = createWindow({ width: 1024, height: 768 })
  const observer = createObserverHarness()
  const renderer = new FakeRenderer(host, {})
  const handle = mountBattlefield(host, {
    windowObject,
    ResizeObserverClass: observer.FakeResizeObserver,
    rendererFactory: () => renderer,
    textureCacheFactory: () => createTextureCacheHarness().cache,
  })
  const transition = transitionAt(0, 1)
  const timeline = createEventTimeline(transition.event)
  handle.beginEvent(transition.event, transition.match)
  for (const step of timeline.filter(({ kind }) => kind === 'reveal')) {
    handle.applyStep(step, { durationMs: 0 })
  }

  const burn = timeline.find(({ kind }) => kind === 'burn')
  handle.applyStep(burn, { durationMs: 0 })
  const burnedMesh = renderer.scene.getObjectByName(
    `battlefield-card:${burn.cardId}:front`,
  )
  assert.equal(burnedMesh.scale.x, handle.layout.visuals.revealScale)

  const winningStep = timeline.find(({ kind }) => kind === 'transfer')
  handle.applyStep(winningStep, { durationMs: 100 })
  const winningMesh = renderer.scene.getObjectByName(
    `battlefield-card:${winningStep.cardId}:front`,
  )
  const start = winningMesh.position.clone()
  const destination = handle.layout.zones.opponentWonPile
  const revealScale = handle.layout.visuals.revealScale
  const pileScale = handle.layout.visuals.secondaryPileScale
  assert.equal(winningMesh.scale.x, revealScale)

  renderer.animationLoop(0)
  renderer.animationLoop(50)
  assert.equal(winningMesh.scale.x, (revealScale + pileScale) / 2)
  assert.ok(Math.abs(winningMesh.position.x - (start.x + destination.x) / 2) < 1e-12)
  assert.ok(Math.abs(winningMesh.position.y - (start.y + destination.y) / 2) < 1e-12)

  renderer.animationLoop(100)
  assert.equal(winningMesh.scale.x, pileScale)
  assert.equal(winningMesh.scale.y, pileScale)
  assert.equal(winningMesh.position.x, destination.x)
  assert.equal(winningMesh.position.y, destination.y)
  assert.equal(winningMesh.position.z, destination.z + 0.14)

  handle.teardown()
})

test('tied player win scales only its decisive card across speed and resize changes', () => {
  const host = createHost(1024, 768)
  const windowObject = createWindow({ width: 1024, height: 768 })
  const observer = createObserverHarness()
  const settings = createSettings({ animationSpeed: 1 })
  const renderer = new FakeRenderer(host, {})
  const handle = mountBattlefield(host, {
    settingsController: settings,
    windowObject,
    ResizeObserverClass: observer.FakeResizeObserver,
    rendererFactory: () => renderer,
    textureCacheFactory: () => createTextureCacheHarness().cache,
  })
  const transition = transitionAt(0, 26)
  const timeline = createEventTimeline(transition.event)
  handle.beginEvent(transition.event, transition.match)
  for (const step of timeline.filter(({ kind }) => kind === 'reveal')) {
    handle.applyStep(step, { durationMs: 0 })
  }

  const settlement = timeline.slice(transition.event.reveals.length)
  const decisiveCardId = transition.event.reveals.at(-2).cardId
  const decisiveIndex = settlement.findIndex(({ cardId }) => cardId === decisiveCardId)
  assert.ok(decisiveIndex > 1)

  handle.applyStep(settlement[0], { durationMs: 100 })
  const nonDecisiveMesh = renderer.scene.getObjectByName(
    `battlefield-card:${settlement[0].cardId}:front`,
  )
  renderer.animationLoop(0)
  renderer.animationLoop(50)
  assert.equal(nonDecisiveMesh.scale.x, handle.layout.visuals.revealScale)
  renderer.animationLoop(100)

  handle.applyStep(settlement[1], { durationMs: 100 })
  const burnedMesh = renderer.scene.getObjectByName(
    `battlefield-card:${settlement[1].cardId}:front`,
  )
  renderer.animationLoop(150)
  assert.equal(burnedMesh.scale.x, handle.layout.visuals.revealScale)
  renderer.animationLoop(200)

  const decisiveStep = settlement[decisiveIndex]
  handle.applyStep(decisiveStep, { durationMs: 200 })
  const decisiveMesh = renderer.scene.getObjectByName(
    `battlefield-card:${decisiveCardId}:front`,
  )
  renderer.animationLoop(250)
  const scaleBeforeResize = decisiveMesh.scale.x
  assert.ok(scaleBeforeResize < handle.layout.visuals.revealScale)
  assert.ok(scaleBeforeResize > handle.layout.visuals.secondaryPileScale)

  settings.emit({ animationSpeed: 2 })
  host.width = 844
  host.height = 390
  observer.instances[0].callback()
  windowObject.flushFrames()
  assert.equal(handle.layout.mode, 'phone-landscape')
  assert.equal(decisiveMesh.scale.x, scaleBeforeResize)

  renderer.animationLoop(250)
  assert.equal(decisiveMesh.scale.x, scaleBeforeResize)
  renderer.animationLoop(251)
  assert.ok(Math.abs(decisiveMesh.scale.x - scaleBeforeResize) < 0.01)
  renderer.animationLoop(325)
  assert.equal(decisiveMesh.scale.x, handle.layout.visuals.secondaryPileScale)
  assert.equal(decisiveMesh.position.x, handle.layout.zones.playerWonPile.x)
  assert.equal(decisiveMesh.position.y, handle.layout.zones.playerWonPile.y)

  handle.teardown()
})

test('one-sided terminal winning card scales immediately for a zero-duration transfer', () => {
  const host = createHost(1024, 768)
  const windowObject = createWindow({ width: 1024, height: 768 })
  const observer = createObserverHarness()
  const renderer = new FakeRenderer(host, {})
  const handle = mountBattlefield(host, {
    windowObject,
    ResizeObserverClass: observer.FakeResizeObserver,
    rendererFactory: () => renderer,
    textureCacheFactory: () => createTextureCacheHarness().cache,
  })
  const transition = transitionAt(0, 44)
  const timeline = createEventTimeline(transition.event)
  handle.beginEvent(transition.event, transition.match)
  const decisiveCardId = transition.event.reveals.at(-1).cardId
  const decisiveIndex = timeline.findIndex(
    ({ kind, cardId }) => kind === 'transfer' && cardId === decisiveCardId,
  )
  for (const step of timeline.slice(0, decisiveIndex)) {
    handle.applyStep(step, { durationMs: 0 })
  }
  handle.applyStep(timeline[decisiveIndex], { durationMs: 0 })

  const decisiveMesh = renderer.scene.getObjectByName(
    `battlefield-card:${decisiveCardId}:front`,
  )
  assert.equal(transition.event.reveals.length % 2, 1)
  assert.equal(decisiveMesh.scale.x, handle.layout.visuals.secondaryPileScale)
  assert.equal(decisiveMesh.scale.y, handle.layout.visuals.secondaryPileScale)
  assert.equal(decisiveMesh.position.x, handle.layout.zones.playerWonPile.x)
  assert.equal(decisiveMesh.position.y, handle.layout.zones.playerWonPile.y)

  handle.teardown()
})

test('battlefield scales prominent cards and hit tests only the enabled active deck', () => {
  const host = createHost(768, 1024)
  const windowObject = createWindow({ width: 768, height: 1024 })
  const observer = createObserverHarness()
  const renderer = new FakeRenderer(host, {})
  let activations = 0
  const handle = mountBattlefield(host, {
    windowObject,
    ResizeObserverClass: observer.FakeResizeObserver,
    rendererFactory: () => renderer,
    textureCacheFactory: () => createTextureCacheHarness().cache,
    onDeckActivate() {
      activations += 1
    },
  })
  windowObject.flushFrames()

  const initial = createMatch({
    runId: 'battlefield-deck-input',
    seed: 0,
    ruleset: BASELINE_RULESET,
  })
  handle.syncSnapshot(initial)
  const source = renderer.scene.getObjectByName(
    `battlefield-card:${initial.zones.sourceDeck[0]}:back`,
  )
  assert.ok(source)
  assert.equal(source.scale.x, 1.75)
  assert.equal(source.scale.y, 1.75)
  assert.equal(source.material.color.getHex(), 0xd9fbff)
  assert.deepEqual(handle.getDeckInputState(), {
    activeZone: 'sourceDeck',
    enabled: false,
    busy: false,
  })

  const canvas = renderer.domElement
  const sourcePoint = clientPointFor(source, renderer, host)
  handle.setDeckInputState({ enabled: true, busy: false })
  canvas.dispatch('pointerdown', { ...sourcePoint, pointerType: 'touch', pointerId: 7 })
  canvas.dispatch('pointerup', { ...sourcePoint, pointerType: 'touch', pointerId: 7 })
  canvas.dispatch('click', { ...sourcePoint, detail: 1 })
  assert.equal(activations, 1)

  canvas.dispatch('pointerdown', { clientX: 10, clientY: 10, pointerId: 8 })
  canvas.dispatch('pointerup', { clientX: 10, clientY: 10, pointerId: 8 })
  canvas.dispatch('click', { clientX: 10, clientY: 10, detail: 1 })
  assert.equal(activations, 1)

  const transition = revealOrContinue(initial)
  handle.syncSnapshot(transition.match)
  const activeSource = renderer.scene.getObjectByName(
    `battlefield-card:${transition.match.zones.sourceDeck[0]}:back`,
  )
  const secondary = []
  renderer.scene.traverse((object) => {
    if (object.name.startsWith('battlefield-card:') && object !== activeSource) {
      secondary.push(object)
    }
  })
  assert.ok(secondary.length > 0)
  assert.equal(activeSource.scale.x, 1.75)
  assert.ok(secondary.every((mesh) => mesh.scale.x === 1.2))
  assert.ok(secondary.every((mesh) => mesh.material.color.getHex() === 0xffffff))

  handle.setDeckInputState({ enabled: true, busy: true })
  const busyPoint = clientPointFor(activeSource, renderer, host)
  canvas.dispatch('pointerdown', { ...busyPoint, pointerId: 9 })
  canvas.dispatch('pointerup', { ...busyPoint, pointerId: 9 })
  assert.equal(activations, 1)

  host.width = 844
  host.height = 390
  observer.instances[0].callback()
  windowObject.flushFrames()
  assert.equal(handle.layout.mode, 'phone-landscape')
  assert.equal(activeSource.scale.x, 1.4)
  assert.ok(secondary.every((mesh) => mesh.scale.x === 1.02))

  handle.setDeckInputState({ enabled: true, busy: false })
  const resizedPoint = clientPointFor(activeSource, renderer, host)
  canvas.dispatch('pointerdown', { ...resizedPoint, pointerType: 'pen', pointerId: 10 })
  canvas.dispatch('pointerup', { ...resizedPoint, pointerType: 'pen', pointerId: 10 })
  canvas.dispatch('click', { ...resizedPoint, detail: 1 })
  assert.equal(activations, 2)

  let personal = initial
  while (personal.stage === 'source') {
    personal = revealOrContinue(personal).match
  }
  handle.syncSnapshot(personal)
  assert.equal(handle.getDeckInputState().activeZone, 'playerDrawPile')
  const playerDraw = renderer.scene.getObjectByName(
    `battlefield-card:${personal.zones.player.drawPile[0]}:back`,
  )
  assert.ok(playerDraw)
  assert.equal(playerDraw.scale.x, 1.4)
  assert.equal(playerDraw.material.color.getHex(), 0xd9fbff)

  while (
    personal.status === 'active'
    && (
      personal.zones.player.drawPile.length !== 0
      || personal.zones.player.wonPile.length === 0
    )
  ) {
    personal = revealOrContinue(personal).match
  }
  assert.equal(personal.status, 'active')
  handle.syncSnapshot(personal)
  assert.equal(handle.getDeckInputState().activeZone, 'playerWonPile')
  const recyclableWonPile = renderer.scene.getObjectByName(
    `battlefield-card:${personal.zones.player.wonPile.at(-1)}:back`,
  )
  assert.ok(recyclableWonPile)
  assert.equal(recyclableWonPile.scale.x, 1.4)
  assert.equal(recyclableWonPile.material.color.getHex(), 0xd9fbff)

  assert.throws(() => handle.setDeckInputState({ enabled: true }), /booleans/)

  handle.teardown()
  assert.ok([...canvas.listeners.values()].every((listeners) => listeners.size === 0))
})

test('active deck hit testing preserves a 44px target at minimum orientations', () => {
  for (const [width, height] of [[320, 480], [480, 320]]) {
    const host = createHost(width, height)
    const windowObject = createWindow({ width, height })
    const observer = createObserverHarness()
    const renderer = new FakeRenderer(host, {})
    let activations = 0
    const handle = mountBattlefield(host, {
      windowObject,
      ResizeObserverClass: observer.FakeResizeObserver,
      rendererFactory: () => renderer,
      textureCacheFactory: () => createTextureCacheHarness().cache,
      onDeckActivate() {
        activations += 1
      },
    })
    windowObject.flushFrames()
    const match = createMatch({
      runId: `minimum-target-${width}x${height}`,
      seed: 0,
      ruleset: BASELINE_RULESET,
    })
    handle.syncSnapshot(match)
    handle.setDeckInputState({ enabled: true, busy: false })
    const source = renderer.scene.getObjectByName(
      `battlefield-card:${match.zones.sourceDeck[0]}:back`,
    )
    const center = clientPointFor(source, renderer, host)
    const canvas = renderer.domElement

    for (const offset of [-21.9, 21.9]) {
      const point = { ...center, clientX: center.clientX + offset }
      canvas.dispatch('pointerdown', { ...point, pointerId: activations + 1 })
      canvas.dispatch('pointerup', { ...point, pointerId: activations + 1 })
      canvas.dispatch('click', { ...point, detail: 1 })
    }
    assert.equal(activations, 2)

    const outside = { ...center, clientX: center.clientX + 23.5 }
    canvas.dispatch('pointerdown', { ...outside, pointerId: 3 })
    canvas.dispatch('pointerup', { ...outside, pointerId: 3 })
    canvas.dispatch('click', { ...outside, detail: 1 })
    assert.equal(activations, 2)
    handle.teardown()
  }
})

test('battlefield drags only the active top card to the player reveal target and snaps back', () => {
  const host = createHost(768, 1024)
  const windowObject = createWindow({ width: 768, height: 1024 })
  const observer = createObserverHarness()
  const renderer = new FakeRenderer(host, {})
  let activations = 0
  const handle = mountBattlefield(host, {
    windowObject,
    ResizeObserverClass: observer.FakeResizeObserver,
    rendererFactory: () => renderer,
    textureCacheFactory: () => createTextureCacheHarness().cache,
    onDeckActivate() {
      activations += 1
    },
  })
  windowObject.flushFrames()
  handle.setDeckInputState({ enabled: true, busy: false })
  const canvas = renderer.domElement
  let pointerId = 1

  const drag = (mesh, dropPoint, expectedActivations) => {
    const start = clientPointFor(mesh, renderer, host)
    const originalParent = mesh.parent
    const originalPosition = mesh.position.clone()
    canvas.dispatch('pointerdown', { ...start, pointerId })
    canvas.dispatch('pointermove', { ...dropPoint, pointerId })
    assert.equal(mesh.parent, renderer.scene)
    assert.equal(host.dataset.deckDragging, 'true')
    assert.equal(canvas.dataset.deckDragging, 'true')
    canvas.dispatch('pointerup', { ...dropPoint, pointerId })
    canvas.dispatch('click', { ...dropPoint, detail: 1 })
    assert.equal(mesh.parent, originalParent)
    assert.deepEqual(mesh.position.toArray(), originalPosition.toArray())
    assert.equal(host.dataset.deckDragging, 'false')
    assert.equal(canvas.dataset.deckDragging, 'false')
    assert.equal(activations, expectedActivations)
    pointerId += 1
  }

  let match = createMatch({
    runId: 'battlefield-deck-drag',
    seed: 0,
    ruleset: BASELINE_RULESET,
  })
  handle.syncSnapshot(match)
  let target = clientPointForPosition(handle.layout.zones.playerReveal, renderer, host)
  let active = renderer.scene.getObjectByName(
    `battlefield-card:${match.zones.sourceDeck[0]}:back`,
  )
  drag(active, target, 1)

  while (match.stage === 'source') match = revealOrContinue(match).match
  handle.syncSnapshot(match)
  target = clientPointForPosition(handle.layout.zones.playerReveal, renderer, host)
  active = renderer.scene.getObjectByName(
    `battlefield-card:${match.zones.player.drawPile[0]}:back`,
  )
  drag(active, target, 2)

  while (
    match.status === 'active'
    && (match.zones.player.drawPile.length !== 0 || match.zones.player.wonPile.length === 0)
  ) {
    match = revealOrContinue(match).match
  }
  assert.equal(match.status, 'active')
  handle.syncSnapshot(match)
  active = renderer.scene.getObjectByName(
    `battlefield-card:${match.zones.player.wonPile.at(-1)}:back`,
  )
  drag(active, { clientX: host.width - 5, clientY: 5 }, 2)

  const start = clientPointFor(active, renderer, host)
  const originalParent = active.parent
  const originalPosition = active.position.clone()
  canvas.dispatch('pointerdown', { ...start, pointerId })
  canvas.dispatch('pointermove', { clientX: start.clientX + 40, clientY: start.clientY, pointerId })
  canvas.dispatch('pointercancel', {
    clientX: start.clientX + 40,
    clientY: start.clientY,
    pointerId,
  })
  assert.equal(active.parent, originalParent)
  assert.deepEqual(active.position.toArray(), originalPosition.toArray())
  assert.equal(activations, 2)

  handle.teardown()
  assert.ok([...canvas.listeners.values()].every((listeners) => listeners.size === 0))
})

test('source-to-personal events route each reveal from its committed origin', () => {
  const host = createHost(1024, 768)
  const windowObject = createWindow({ width: 1024, height: 768 })
  const observer = createObserverHarness()
  const renderer = new FakeRenderer(host, {})
  const handle = mountBattlefield(host, {
    windowObject,
    ResizeObserverClass: observer.FakeResizeObserver,
    rendererFactory: () => renderer,
    textureCacheFactory: () => createTextureCacheHarness().cache,
  })
  let match = createMatch({
    runId: 'battlefield-stage-transition',
    seed: 0,
    ruleset: BASELINE_RULESET,
  })
  let transition
  do {
    transition = revealOrContinue(match)
    match = transition.match
  } while (transition.event.turn < 26)

  assert.equal(transition.event.stage, 'personal')
  assert.deepEqual(
    transition.event.reveals.map(({ from }) => from),
    ['sourceDeck', 'sourceDeck', 'player.drawPile', 'opponent.drawPile'],
  )
  const timeline = createEventTimeline(transition.event)
  handle.beginEvent(transition.event, transition.match)

  const assertOrigin = (stepIndex, zoneId) => {
    const step = timeline[stepIndex]
    handle.applyStep(step, { durationMs: 100 })
    const mesh = renderer.scene.children.find(
      ({ name }) => name === `battlefield-card:${step.cardId}:front`,
    )
    assert.ok(mesh)
    assert.equal(mesh.position.x, handle.layout.zones[zoneId].x)
    assert.equal(mesh.position.y, handle.layout.zones[zoneId].y)
  }
  assertOrigin(0, 'sourceDeck')
  assertOrigin(2, 'playerDrawPile')
  handle.applyStep({ ...timeline[0], from: null }, { durationMs: 100 })
  const legacyMesh = renderer.scene.children.find(
    ({ name }) => name === `battlefield-card:${timeline[0].cardId}:front`,
  )
  assert.equal(legacyMesh.position.x, handle.layout.zones.contestedPile.x)
  assert.equal(legacyMesh.position.y, handle.layout.zones.contestedPile.y)

  handle.teardown()
})

test('battlefield keeps a bounded terminal draw contest and validates event adapters', () => {
  const host = createHost(800, 600)
  const windowObject = createWindow({ width: 800, height: 600 })
  const observer = createObserverHarness()
  const textures = createTextureCacheHarness()
  const handle = mountBattlefield(host, {
    windowObject,
    ResizeObserverClass: observer.FakeResizeObserver,
    rendererFactory: () => new FakeRenderer(host, {}),
    textureCacheFactory: () => textures.cache,
  })
  let match = createMatch({
    runId: 'battlefield-draw',
    seed: 32,
    ruleset: BASELINE_RULESET,
  })
  while (match.status === 'active') {
    match = revealOrContinue(match).match
  }
  assert.equal(match.pendingEvent.type, 'clashDrawn')
  assert.ok(match.pendingEvent.reveals.length > 4)

  handle.syncSnapshot(match, { reason: 'completed' })
  assert.equal(handle.getPresentationState().staticCards, 5)
  assert.equal(handle.getPresentationState().transientCards, 0)
  assert.ok(handle.getPresentationState().cacheEntries <= 24)

  assert.throws(() => handle.beginEvent(match.pendingEvent, createMatch({
    runId: 'different-run',
    seed: 1,
    ruleset: BASELINE_RULESET,
  })), /must match/)
  assert.throws(
    () => handle.applyStep({ kind: 'unknown' }, { durationMs: 0 }),
    /begin before/,
  )
  handle.teardown()
  assert.throws(() => handle.syncSnapshot(match), /destroyed/)
})

test('long tie settlements do not cascade texture recreation and live speed rescales tweens', () => {
  const host = createHost(1024, 768)
  const windowObject = createWindow({ width: 1024, height: 768 })
  const observer = createObserverHarness()
  const settings = createSettings({ animationSpeed: 1 })
  const textures = createTextureCacheHarness()
  const renderer = new FakeRenderer(host, {})
  const handle = mountBattlefield(host, {
    settingsController: settings,
    windowObject,
    ResizeObserverClass: observer.FakeResizeObserver,
    rendererFactory: () => renderer,
    textureCacheFactory: () => textures.cache,
  })
  let match = createMatch({
    runId: 'battlefield-long-tie',
    seed: 444,
    ruleset: BASELINE_RULESET,
  })
  let transition
  do {
    transition = revealOrContinue(match)
    match = transition.match
  } while (transition.event.turn < 30)
  assert.equal(transition.event.reveals.length, 10)

  const timeline = createEventTimeline(transition.event)
  handle.beginEvent(transition.event, transition.match)
  handle.applyStep(timeline[0], { durationMs: 200 })
  renderer.animationLoop(0)
  renderer.animationLoop(50)
  assert.equal(handle.getPresentationState().tweens, 1)
  settings.emit({ animationSpeed: 2 })
  renderer.animationLoop(125)
  renderer.animationLoop(200)
  assert.equal(handle.getPresentationState().tweens, 0)

  for (const step of timeline.slice(1)) {
    handle.applyStep(step, { durationMs: 0 })
  }
  const revealIds = new Set(transition.event.reveals.map(({ cardId }) => cardId))
  const eventFronts = textures.acquisitions
    .filter(([kind, options]) => kind === 'front' && revealIds.has(options.cardId))
    .map(([, options]) => options.cardId)
  const acquisitionCounts = new Map()
  for (const cardId of eventFronts) {
    acquisitionCounts.set(cardId, (acquisitionCounts.get(cardId) ?? 0) + 1)
  }
  assert.equal(eventFronts.length, 12)
  assert.equal([...acquisitionCounts.values()].filter((count) => count === 2).length, 2)
  assert.ok([...acquisitionCounts.values()].every((count) => count <= 2))
  assert.ok(handle.getPresentationState().transientCards <= 8)

  handle.teardown()
})

test('battlefield validates its adapters before creating renderer resources', () => {
  const host = createHost(320, 480)
  assert.throws(() => mountBattlefield(null), /host/)
  assert.throws(
    () => mountBattlefield(host, { settingsController: {} }),
    /settingsController/,
  )
  assert.throws(
    () => mountBattlefield(host, { onLayout: true }),
    /onLayout/,
  )
  assert.throws(
    () => mountBattlefield(host, { rendererFactory: null }),
    /rendererFactory/,
  )
  assert.throws(
    () => mountBattlefield(host, { onDeckActivate: true }),
    /onDeckActivate/,
  )
  assert.throws(
    () => mountBattlefield(host, { onContextStatus: true }),
    /onContextStatus/,
  )
  assert.throws(
    () => mountBattlefield(host, { inputControllerFactory: null }),
    /inputControllerFactory/,
  )
  assert.throws(
    () => mountBattlefield(host, { themeRegistry: {} }),
    /themeRegistry/,
  )
  assert.throws(
    () => mountBattlefield(host, { textureCacheFactory: null }),
    /textureCacheFactory/,
  )
})

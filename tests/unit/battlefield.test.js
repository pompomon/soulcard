import assert from 'node:assert/strict'
import test from 'node:test'
import { createMatch, revealOrContinue } from '../../src/domain/match-machine.js'
import { BASELINE_RULESET } from '../../src/domain/ruleset.js'
import { mountBattlefield } from '../../src/presentation/battlefield.js'

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
    this.removeCalls = 0
  }

  setAttribute(name, value) {
    this.attributes[name] = value
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

  render(scene) {
    this.scene = scene
    this.renderCalls += 1
  }

  dispose() {
    this.onDispose?.()
    this.disposeCalls += 1
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
  assert.equal(host.children.length, 1)
  assert.equal(host.children[0].attributes['aria-hidden'], 'true')
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
    assert.ok([...resourceDisposals.values()].every((count) => count === 1))
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
    assert.ok([...resourceDisposals.values()].every((count) => count === 2))
  }
  handle.teardown()
  assert.equal(renderers[1].disposeCalls, 1)
  assert.equal(host.children.length, 0)
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
})

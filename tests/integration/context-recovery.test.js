import assert from 'node:assert/strict'
import test from 'node:test'
import { createRunController } from '../../src/app/run-controller.js'
import { createMatch, revealOrContinue } from '../../src/domain/match-machine.js'
import { BASELINE_RULESET } from '../../src/domain/ruleset.js'
import { mountBattlefield } from '../../src/presentation/battlefield.js'
import { createEventPlayer } from '../../src/presentation/event-player.js'
import { createGameScreen } from '../../src/ui/hud.js'

const TIMING = Object.freeze({
  revealMs: 10,
  settlementMs: 10,
  burnMs: 10,
})

class FakeStyle {
  constructor() {
    this.values = new Map([
      ['--safe-area-top', '0px'],
      ['--safe-area-right', '0px'],
      ['--safe-area-bottom', '0px'],
      ['--safe-area-left', '0px'],
    ])
  }

  setProperty(name, value) {
    this.values.set(name, value)
  }

  getPropertyValue(name) {
    return this.values.get(name) ?? ''
  }
}

class FakeElement {
  constructor(tagName, width = 1024, height = 768) {
    this.tagName = tagName.toUpperCase()
    this.width = width
    this.height = height
    this.clientWidth = width
    this.clientHeight = height
    this.children = []
    this.dataset = {}
    this.attributes = {}
    this.listeners = new Map()
    this.className = ''
    this.textContent = ''
    this.hidden = false
    this.disabled = false
    this.inert = false
    this.ownerDocument = null
    this.parent = null
    this.style = new FakeStyle()
  }

  append(...children) {
    for (const child of children) child.parent = this
    this.children.push(...children)
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

  dispatch(type, values = {}) {
    const event = {
      type,
      target: this,
      currentTarget: this,
      button: type.startsWith('pointer') || type === 'click' ? 0 : undefined,
      detail: 0,
      isPrimary: true,
      pointerId: 1,
      pointerType: 'mouse',
      clientX: this.width / 2,
      clientY: this.height / 2,
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
      right: this.width,
      bottom: this.height,
      left: 0,
      width: this.width,
      height: this.height,
    }
  }

  remove() {
    if (this.parent === null) return
    this.parent.children = this.parent.children.filter((child) => child !== this)
    this.parent = null
  }
}

class FakeRenderer {
  constructor(host) {
    this.domElement = new FakeElement('canvas', host.width, host.height)
    this.animationLoop = null
    this.disposeCalls = 0
  }

  setAnimationLoop(loop) {
    this.animationLoop = loop
  }

  setPixelRatio() {}

  setSize() {}

  render(scene, camera) {
    this.scene = scene
    this.camera = camera
  }

  dispose() {
    this.disposeCalls += 1
  }
}

function descendants(element) {
  return [element, ...element.children.flatMap(descendants)]
}

function byAction(screen, action) {
  return descendants(screen.element).find((element) => element.dataset.action === action)
}

function createClock() {
  let now = 0
  let nextId = 1
  const timers = new Map()
  return {
    now: () => now,
    setTimeout(callback, delay) {
      const id = nextId
      nextId += 1
      timers.set(id, { callback, due: now + delay })
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
    advance(milliseconds) {
      now += milliseconds
      const due = [...timers]
        .filter(([, timer]) => timer.due <= now)
        .sort((left, right) => left[1].due - right[1].due)
      for (const [id, timer] of due) {
        if (!timers.delete(id)) continue
        timer.callback()
      }
    },
  }
}

function createSettings() {
  const snapshot = Object.freeze({
    quality: 'balanced',
    renderScaleCap: 1.5,
    animationSpeed: 1,
    reducedMotionOverride: false,
    reducedMotion: false,
  })
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listener(snapshot)
      return () => {}
    },
  }
}

function createWindow() {
  const listeners = new Map()
  return {
    innerWidth: 1024,
    innerHeight: 768,
    devicePixelRatio: 1,
    addEventListener(type, listener) {
      const values = listeners.get(type) ?? new Set()
      values.add(listener)
      listeners.set(type, values)
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener)
    },
    requestAnimationFrame: (callback) => setTimeout(() => callback(16), 0),
    cancelAnimationFrame: clearTimeout,
    getComputedStyle: (element) => element.style,
  }
}

function createTextureCache() {
  let entries = 0
  return {
    acquireFront() {
      entries += 1
      return Object.freeze({ texture: {}, release() {} })
    },
    acquireBack() {
      entries += 1
      return Object.freeze({ texture: {}, release() {} })
    },
    destroy() {
      entries = 0
    },
    getStats: () => ({ entries }),
  }
}

async function waitFor(predicate, rounds = 200) {
  for (let index = 0; index < rounds; index += 1) {
    if (predicate()) return
    await Promise.resolve()
  }
  assert.fail('Condition did not settle')
}

async function finishPresentation(clock, revealButton) {
  for (let index = 0; index < 200 && revealButton.disabled; index += 1) {
    clock.advance(100)
    await Promise.resolve()
  }
  assert.equal(revealButton.disabled, false)
}

test('idle and active context recovery preserve committed state and deterministic continuation', async (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  const initial = createMatch({
    runId: 'integration-context-recovery',
    seed: 0,
    ruleset: BASELINE_RULESET,
  })
  const saves = []
  const controller = createRunController({
    repository: {
      load: async () => ({ status: 'empty' }),
      async save(match) {
        saves.push(match)
        return {
          status: 'saved',
          savedAt: `2026-09-23T12:10:0${saves.length}.000Z`,
        }
      },
    },
    initialMatch: initial,
  })
  const windowObject = createWindow()
  const settingsController = createSettings()
  const clock = createClock()
  const renderers = []
  const screen = createGameScreen({
    runController: controller,
    settingsController,
    mountBattlefield: (host, options) => mountBattlefield(host, {
      ...options,
      windowObject,
      ResizeObserverClass: null,
      rendererFactory() {
        const renderer = new FakeRenderer(host)
        renderers.push(renderer)
        return renderer
      },
      textureCacheFactory: createTextureCache,
    }),
    eventPlayerFactory: (options) => createEventPlayer({
      ...options,
      timing: TIMING,
      clock,
    }),
  })
  const battlefield = descendants(screen.element).find(
    (element) => Object.hasOwn(element.dataset, 'battlefield'),
  )
  const reveal = byAction(screen, 'reveal')

  await waitFor(() => battlefield.dataset.presentationPhase === 'snapshot')
  const idleSnapshot = structuredClone(controller.currentMatch)
  let canvas = battlefield.children.find(({ tagName }) => tagName === 'CANVAS')
  canvas.dispatch('webglcontextlost')
  assert.equal(reveal.disabled, true)
  canvas.dispatch('webglcontextrestored')
  assert.deepEqual(controller.currentMatch, idleSnapshot)
  assert.equal(battlefield.dataset.webglRecoveries, '1')
  assert.equal(reveal.disabled, false)

  reveal.dispatch('click')
  await controller.whenIdle()
  await waitFor(() => battlefield.dataset.presentationPhase === 'reveal')
  const committed = structuredClone(controller.currentMatch)
  const expectedContinuation = revealOrContinue(controller.currentMatch).match
  const activePresentation = {
    phase: battlefield.dataset.presentationPhase,
    event: battlefield.dataset.presentationEvent,
    card: battlefield.dataset.presentationCard,
    cards: battlefield.dataset.presentationCards,
  }
  canvas = battlefield.children.find(({ tagName }) => tagName === 'CANVAS')
  canvas.dispatch('webglcontextlost')
  clock.advance(10_000)
  await Promise.resolve()

  assert.deepEqual(controller.currentMatch, committed)
  assert.deepEqual(controller.currentMatch.rng, committed.rng)
  assert.deepEqual(controller.currentMatch.zones, committed.zones)
  assert.equal(
    controller.currentMatch.pendingEvent.stateFingerprint,
    committed.pendingEvent.stateFingerprint,
  )
  assert.equal(reveal.disabled, true)

  canvas.dispatch('webglcontextrestored')
  assert.equal(battlefield.dataset.webglRecoveries, '2')
  assert.deepEqual(
    {
      phase: battlefield.dataset.presentationPhase,
      event: battlefield.dataset.presentationEvent,
      card: battlefield.dataset.presentationCard,
      cards: battlefield.dataset.presentationCards,
    },
    activePresentation,
  )
  await finishPresentation(clock, reveal)
  assert.deepEqual(controller.currentMatch, committed)

  reveal.dispatch('click')
  await controller.whenIdle()
  await finishPresentation(clock, reveal)
  assert.deepEqual(controller.currentMatch, expectedContinuation)
  assert.equal(saves.length, 2)
  assert.equal(renderers.length, 3)
  assert.equal(renderers[0].disposeCalls, 1)
  assert.equal(renderers[1].disposeCalls, 1)

  screen.teardown()
  await controller.destroy()
})

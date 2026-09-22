import assert from 'node:assert/strict'
import test from 'node:test'
import { createRunController } from '../../src/app/run-controller.js'
import { createMatch, revealOrContinue } from '../../src/domain/match-machine.js'
import { BASELINE_RULESET } from '../../src/domain/ruleset.js'
import { createGameScreen } from '../../src/ui/hud.js'

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase()
    this.children = []
    this.dataset = {}
    this.attributes = {}
    this.listeners = new Map()
    this.className = ''
    this.textContent = ''
    this.hidden = false
    this.disabled = false
    this.style = {
      values: new Map(),
      setProperty: (name, value) => this.style.values.set(name, value),
    }
  }

  append(...children) {
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

  dispatch(type) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener({ type, target: this, currentTarget: this })
    }
  }
}

function descendants(element) {
  return [element, ...element.children.flatMap(descendants)]
}

function byAction(screen, action) {
  return descendants(screen.element).find((element) => element.dataset.action === action)
}

function byValue(screen, value) {
  return descendants(screen.element).find((element) => element.dataset.value === value)
}

function deferred() {
  let resolve
  const promise = new Promise((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

test('Game owns a semantic pause overlay with live save status and Resume', async (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  const saves = []
  const controller = createRunController({
    repository: {
      load: async () => ({ status: 'empty' }),
      async save(match) {
        saves.push(match)
        return {
          status: 'saved',
          savedAt: '2026-09-21T11:00:00.000Z',
        }
      },
    },
    initialMatch: createMatch({
      runId: 'hud-pause',
      seed: 12345,
      ruleset: BASELINE_RULESET,
    }),
  })
  let battlefieldTeardowns = 0
  const battlefieldPauses = []
  const screen = createGameScreen({
    runController: controller,
    mountBattlefield: (host, { onLayout }) => {
      assert.ok(Object.hasOwn(host.dataset, 'battlefield'))
      onLayout({
        mode: 'phone-portrait',
        viewport: {
          letterboxed: false,
          scale: 1,
          logicalWidth: 320,
          logicalHeight: 480,
        },
        safeArea: { top: 1, right: 2, bottom: 3, left: 4 },
        hud: {
          header: { height: 72 },
          footer: { height: 210 },
          leftPanel: { width: 0 },
        },
      })
      return {
        setPaused(value) {
          battlefieldPauses.push(value)
        },
        teardown() {
          battlefieldTeardowns += 1
        },
      }
    },
  })
  const elements = descendants(screen.element)
  const overlayHost = elements.find(
    (element) => Object.hasOwn(element.dataset, 'overlayHost'),
  )
  const overlay = elements.find(
    (element) => Object.hasOwn(element.dataset, 'pauseOverlay'),
  )
  const saveStatus = elements.find(
    (element) => Object.hasOwn(element.dataset, 'saveStatus'),
  )
  const pause = byAction(screen, 'pause')
  const resume = byAction(screen, 'resume')

  assert.ok(overlayHost.children.includes(overlay))
  assert.equal(overlay.attributes.role, 'dialog')
  assert.equal(overlay.attributes['aria-modal'], 'true')
  assert.equal(overlay.hidden, true)
  assert.equal(pause.disabled, false)
  assert.equal(screen.element.dataset.layoutMode, 'phone-portrait')
  assert.equal(screen.element.dataset.letterboxed, 'false')
  assert.equal(screen.element.style.values.get('--hud-header-reserve'), '72px')
  assert.equal(screen.element.style.values.get('--hud-control-min-size'), '44px')
  assert.equal(screen.element.style.values.get('--battlefield-logical-width'), '320px')
  assert.equal(screen.element.style.values.get('--safe-area-left'), '4px')
  assert.deepEqual(battlefieldPauses, [false])

  pause.dispatch('click')
  assert.equal(controller.currentMatch.machineState, 'paused')
  assert.equal(overlay.hidden, false)
  assert.match(saveStatus.textContent, /Saving/)
  assert.deepEqual(battlefieldPauses, [false, true])
  await controller.whenIdle()
  await Promise.resolve()
  assert.equal(saves.length, 1)
  assert.equal(saves[0].machineState, 'paused')
  assert.equal(saveStatus.textContent, 'Game saved.')

  resume.dispatch('click')
  assert.equal(controller.currentMatch.machineState, 'ready')
  assert.equal(overlay.hidden, true)
  assert.equal(pause.disabled, false)
  assert.deepEqual(battlefieldPauses, [false, true, false])

  screen.teardown()
  pause.dispatch('click')
  assert.equal(controller.currentMatch.machineState, 'ready')
  assert.equal(battlefieldTeardowns, 1)
})

test('Game leaves pause disabled without a run controller and still tears down presentation', (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  let teardowns = 0
  const screen = createGameScreen({
    mountBattlefield: () => () => {
      teardowns += 1
    },
  })

  assert.equal(byAction(screen, 'pause').disabled, true)
  assert.equal(
    descendants(screen.element).find(
      (element) => Object.hasOwn(element.dataset, 'pauseOverlay'),
    ).hidden,
    true,
  )
  screen.teardown()
  assert.equal(teardowns, 1)
})

test('Game gates committed presentation on save completion and publishes live progress', async (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  const write = deferred()
  const controller = createRunController({
    repository: {
      load: async () => ({ status: 'empty' }),
      save: async () => write.promise,
    },
    initialMatch: createMatch({
      runId: 'hud-presentation',
      seed: 0,
      ruleset: BASELINE_RULESET,
    }),
  })
  const presented = []
  const paused = []
  let presentationState
  let destroyed = 0
  const screen = createGameScreen({
    runController: controller,
    mountBattlefield: () => ({
      syncSnapshot() {},
      beginEvent() {},
      applyStep() {},
      setPaused() {},
      teardown() {},
    }),
    eventPlayerFactory({ onStateChange }) {
      presentationState = onStateChange
      return {
        present(match) {
          presented.push(match)
          return Promise.resolve({ status: 'completed' })
        },
        setPaused(value) {
          paused.push(value)
        },
        destroy() {
          destroyed += 1
        },
      }
    },
  })
  const status = descendants(screen.element).find(
    (element) => Object.hasOwn(element.dataset, 'statusHost'),
  )

  assert.equal(presented.length, 1)
  assert.equal(presented[0].pendingEvent, null)
  const clash = controller.revealOrContinue()
  assert.equal(controller.currentMatch.turn, 1)
  assert.equal(presented.length, 1)
  assert.equal(status.textContent, 'Saving committed clash…')

  write.resolve({
    status: 'saved',
    savedAt: '2026-09-22T09:00:00.000Z',
  })
  await clash
  await Promise.resolve()
  assert.equal(presented.length, 2)
  assert.equal(presented[1].pendingEvent.id, controller.currentMatch.pendingEvent.id)
  assert.equal(byValue(screen, 'stage').textContent, 'source')
  assert.equal(
    byValue(screen, 'source-count').textContent,
    String(controller.currentMatch.zones.sourceDeck.length),
  )
  assert.ok(paused.length > 0)
  assert.ok(paused.every((value) => value === false))

  presentationState({
    status: 'playing',
    eventId: controller.currentMatch.pendingEvent.id,
    stepIndex: 0,
    stepCount: 3,
    stepKind: 'reveal',
    reason: null,
  })
  assert.equal(status.textContent, 'Revealing committed card.')
  presentationState({
    status: 'skipped',
    eventId: controller.currentMatch.pendingEvent.id,
    stepIndex: null,
    stepCount: 3,
    stepKind: null,
    reason: 'reduced-motion',
  })
  assert.equal(status.textContent, 'Presentation skipped for reduced motion.')
  assert.equal(status.dataset.presentationState, 'skipped')

  screen.teardown()
  assert.equal(destroyed, 1)
})

test('Game queues a restored paused event and tears down player before battlefield', (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  const ready = revealOrContinue(createMatch({
    runId: 'hud-restored-event',
    seed: 0,
    ruleset: BASELINE_RULESET,
  })).match
  const snapshot = {
    match: { ...ready, machineState: 'paused' },
    saveStatus: 'saved',
    saveReason: null,
  }
  const order = []
  const presented = []
  const pauses = []
  const runController = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listener(snapshot)
      return () => order.push('unsubscribe')
    },
    pause() {},
    resume() {},
  }
  const screen = createGameScreen({
    runController,
    mountBattlefield: () => ({
      teardown() {
        order.push('battlefield')
      },
    }),
    eventPlayerFactory() {
      return {
        present(match) {
          presented.push(match.pendingEvent.id)
          return Promise.resolve({ status: 'queued' })
        },
        setPaused(value) {
          pauses.push(value)
        },
        destroy() {
          order.push('player')
        },
      }
    },
  })

  assert.deepEqual(presented, [ready.pendingEvent.id])
  assert.deepEqual(pauses, [true])
  screen.teardown()
  assert.deepEqual(order, ['unsubscribe', 'player', 'battlefield'])
})

test('Game presents a committed event after a failed save without blocking play', async (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  const controller = createRunController({
    repository: {
      load: async () => ({ status: 'empty' }),
      save: async () => ({
        status: 'storage-unavailable',
        operation: 'save',
        reason: 'quota-exceeded',
      }),
    },
    initialMatch: createMatch({
      runId: 'hud-failed-save',
      seed: 0,
      ruleset: BASELINE_RULESET,
    }),
  })
  const presented = []
  const screen = createGameScreen({
    runController: controller,
    mountBattlefield: () => undefined,
    eventPlayerFactory: ({ onStateChange }) => ({
      present(match) {
        presented.push(match.pendingEvent?.id ?? null)
        if (match.pendingEvent !== null) {
          onStateChange({
            status: 'playing',
            eventId: match.pendingEvent.id,
            stepIndex: 0,
            stepCount: 1,
            stepKind: 'reveal',
            reason: null,
          })
        }
        return Promise.resolve({ status: 'completed' })
      },
      setPaused() {},
      destroy() {},
    }),
  })
  const status = descendants(screen.element).find(
    (element) => Object.hasOwn(element.dataset, 'statusHost'),
  )
  const saveWarning = descendants(screen.element).find(
    (element) => Object.hasOwn(element.dataset, 'saveWarning'),
  )

  await controller.revealOrContinue()
  await Promise.resolve()
  assert.deepEqual(presented, [null, controller.currentMatch.pendingEvent.id])
  assert.equal(status.textContent, 'Revealing committed card.')
  assert.equal(saveWarning.hidden, false)
  assert.equal(
    saveWarning.textContent,
    'Save failed (quota-exceeded). Your game remains available in this session.',
  )
  screen.teardown()
})

test('Game queues every committed event after its save attempt settles', async (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  const writes = [deferred(), deferred()]
  let writeIndex = 0
  const controller = createRunController({
    repository: {
      load: async () => ({ status: 'empty' }),
      save: async () => writes[writeIndex++].promise,
    },
    initialMatch: createMatch({
      runId: 'hud-ordered-presentation',
      seed: 0,
      ruleset: BASELINE_RULESET,
    }),
  })
  const presented = []
  const screen = createGameScreen({
    runController: controller,
    mountBattlefield: () => undefined,
    eventPlayerFactory: () => ({
      present(match) {
        presented.push(match.pendingEvent?.id ?? null)
        return Promise.resolve({ status: 'queued' })
      },
      setPaused() {},
      destroy() {},
    }),
  })

  const first = controller.revealOrContinue()
  const firstEventId = controller.currentMatch.pendingEvent.id
  const second = controller.revealOrContinue()
  const secondEventId = controller.currentMatch.pendingEvent.id
  assert.deepEqual(presented, [null])

  writes[0].resolve({ status: 'saved', savedAt: '2026-09-22T10:00:00.000Z' })
  await first
  await Promise.resolve()
  assert.deepEqual(presented, [null, firstEventId])

  writes[1].resolve({ status: 'saved', savedAt: '2026-09-22T10:00:01.000Z' })
  await second
  await Promise.resolve()
  assert.deepEqual(presented, [null, firstEventId, secondEventId])

  screen.teardown()
})

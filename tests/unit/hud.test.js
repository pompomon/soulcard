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

  dispatch(type, values = {}) {
    const event = {
      type,
      target: this,
      currentTarget: this,
      button: undefined,
      detail: 0,
      isPrimary: true,
      pointerId: 1,
      pointerType: 'mouse',
      preventDefault() {},
      stopPropagation() {},
      ...values,
    }
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event)
    }
    return event
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

async function flushMicrotasks(rounds = 6) {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve()
  }
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
          comparison: { height: 80 },
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
  assert.equal(screen.element.style.values.get('--hud-comparison-reserve'), '80px')
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
  await Promise.resolve()
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

test('Save & Main Menu retries failed persistence without leaving pause', async (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  let saveCalls = 0
  const controller = createRunController({
    repository: {
      load: async () => ({ status: 'empty' }),
      async save() {
        saveCalls += 1
        if (saveCalls === 2) {
          return {
            status: 'storage-unavailable',
            operation: 'save',
            reason: 'quota-exceeded',
          }
        }
        return {
          status: 'saved',
          savedAt: `2026-09-23T01:00:0${saveCalls}.000Z`,
        }
      },
    },
    initialMatch: createMatch({
      runId: 'hud-save-main',
      seed: 12345,
      ruleset: BASELINE_RULESET,
    }),
  })
  let mainMenuCalls = 0
  const screen = createGameScreen({
    runController: controller,
    mountBattlefield: () => undefined,
    onMainMenu() {
      mainMenuCalls += 1
    },
  })
  const pause = byAction(screen, 'pause')
  const saveAndMain = byAction(screen, 'save-main')
  const overlay = descendants(screen.element).find(
    (element) => Object.hasOwn(element.dataset, 'pauseOverlay'),
  )
  const saveStatus = descendants(screen.element).find(
    (element) => Object.hasOwn(element.dataset, 'saveStatus'),
  )

  pause.dispatch('click')
  await controller.whenIdle()
  await flushMicrotasks()
  assert.equal(controller.currentMatch.machineState, 'paused')
  assert.equal(overlay.hidden, false)

  saveAndMain.dispatch('click')
  await controller.whenIdle()
  await flushMicrotasks()
  assert.equal(mainMenuCalls, 0)
  assert.equal(controller.currentMatch.machineState, 'paused')
  assert.equal(overlay.hidden, false)
  assert.match(saveStatus.textContent, /quota-exceeded/)
  assert.match(saveStatus.textContent, /Stay paused/)

  saveAndMain.dispatch('click')
  await controller.whenIdle()
  await flushMicrotasks()
  assert.equal(mainMenuCalls, 1)
  assert.equal(saveCalls, 3)

  screen.teardown()
  await controller.destroy()
})

test('Pause restart remains open when replacement is declined', async (t) => {
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
        status: 'saved',
        savedAt: '2026-09-23T01:01:00.000Z',
      }),
    },
    initialMatch: createMatch({
      runId: 'hud-restart-declined',
      seed: 7,
      ruleset: BASELINE_RULESET,
    }),
  })
  let restarts = 0
  const screen = createGameScreen({
    runController: controller,
    mountBattlefield: () => undefined,
    onRestart() {
      restarts += 1
      return false
    },
  })

  byAction(screen, 'pause').dispatch('click')
  await controller.whenIdle()
  await flushMicrotasks()
  const overlay = descendants(screen.element).find(
    (element) => Object.hasOwn(element.dataset, 'pauseOverlay'),
  )
  const restart = byAction(screen, 'restart')
  restart.dispatch('click')
  await flushMicrotasks()

  assert.equal(restarts, 1)
  assert.equal(controller.currentMatch.machineState, 'paused')
  assert.equal(overlay.hidden, false)
  assert.equal(restart.disabled, false)
  screen.teardown()
  await controller.destroy()
})

test('Game resolves one pointer reveal, locks input through save and presentation, and updates HUD', async (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  const write = deferred()
  const animation = deferred()
  const saves = []
  const controller = createRunController({
    repository: {
      load: async () => ({ status: 'empty' }),
      save(match) {
        saves.push(match)
        return write.promise
      },
    },
    initialMatch: createMatch({
      runId: 'hud-pointer-reveal',
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
        if (match.pendingEvent === null) {
          return Promise.resolve({ status: 'synchronized' })
        }
        const eventId = match.pendingEvent.id
        presented.push(eventId)
        onStateChange({
          status: 'playing',
          eventId,
          stepIndex: 0,
          stepCount: 3,
          stepKind: 'reveal',
          reason: null,
        })
        return animation.promise.then(() => {
          onStateChange({
            status: 'completed',
            eventId,
            stepIndex: null,
            stepCount: 3,
            stepKind: null,
            reason: null,
          })
          return { status: 'completed', eventId, reason: null }
        })
      },
      setPaused() {},
      destroy() {},
    }),
  })
  const reveal = byAction(screen, 'reveal')
  const comparisonResult = descendants(screen.element).find(
    (element) => Object.hasOwn(element.dataset, 'comparisonResult'),
  )
  const comparisonDetails = descendants(screen.element).find(
    (element) => Object.hasOwn(element.dataset, 'comparisonDetails'),
  )
  const comparisonProgress = descendants(screen.element).find(
    (element) => Object.hasOwn(element.dataset, 'comparisonProgress'),
  )

  assert.equal(reveal.disabled, false)
  assert.equal(comparisonResult.textContent, 'Ready for the first reveal')
  reveal.dispatch('pointerdown', { pointerType: 'touch', pointerId: 7, button: 0 })
  reveal.dispatch('pointerup', { pointerType: 'touch', pointerId: 7, button: 0 })
  reveal.dispatch('click', { detail: 1, button: 0 })

  assert.equal(controller.currentMatch.turn, 1)
  assert.equal(reveal.disabled, true)
  assert.match(comparisonResult.textContent, /won clash 1/)
  assert.match(comparisonDetails.textContent, /cards? revealed · \d+ ties? · \d+ burned/)

  await flushMicrotasks()
  assert.equal(saves.length, 1)
  write.resolve({
    status: 'saved',
    savedAt: '2026-09-22T17:00:00.000Z',
  })
  await controller.whenIdle()
  await flushMicrotasks()
  assert.deepEqual(presented, [controller.currentMatch.pendingEvent.id])
  assert.equal(reveal.disabled, true)
  assert.equal(comparisonProgress.textContent, 'Revealing cards · 1 of 3')

  reveal.dispatch('pointerdown', { pointerType: 'pen', pointerId: 8, button: 0 })
  reveal.dispatch('pointerup', { pointerType: 'pen', pointerId: 8, button: 0 })
  assert.equal(controller.currentMatch.turn, 1)

  animation.resolve()
  await flushMicrotasks()
  assert.equal(reveal.disabled, false)
  assert.equal(comparisonProgress.textContent, 'Presentation complete.')

  screen.teardown()
  await controller.destroy()
})

test('Game routes active-deck and button activation through one Reveal busy gate', async (t) => {
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
        saves.push(match.turn)
        return {
          status: 'saved',
          savedAt: '2026-09-22T20:00:00.000Z',
        }
      },
    },
    initialMatch: createMatch({
      runId: 'hud-deck-reveal',
      seed: 1,
      ruleset: BASELINE_RULESET,
    }),
  })
  const deckStates = []
  const presented = []
  let activateDeck
  const screen = createGameScreen({
    runController: controller,
    mountBattlefield: (host, options) => {
      activateDeck = options.onDeckActivate
      return {
        setDeckInputState(state) {
          deckStates.push(state)
        },
        teardown() {},
      }
    },
    eventPlayerFactory: () => ({
      present(match) {
        if (match.pendingEvent !== null) presented.push(match.pendingEvent.id)
        return Promise.resolve({
          status: 'completed',
          eventId: match.pendingEvent?.id ?? null,
          reason: null,
        })
      },
      setPaused() {},
      destroy() {},
    }),
  })
  const reveal = byAction(screen, 'reveal')

  assert.equal(typeof activateDeck, 'function')
  assert.deepEqual(deckStates.at(-1), { enabled: true, busy: false })
  activateDeck()
  activateDeck()
  assert.equal(controller.currentMatch.turn, 1)
  assert.equal(reveal.disabled, true)
  assert.deepEqual(deckStates.at(-1), { enabled: true, busy: true })

  await controller.whenIdle()
  await flushMicrotasks()
  assert.equal(reveal.disabled, false)
  reveal.dispatch('click')
  assert.equal(controller.currentMatch.turn, 2)
  await controller.whenIdle()
  await flushMicrotasks()

  assert.deepEqual(saves, [1, 2])
  assert.equal(new Set(presented).size, 2)
  assert.deepEqual(deckStates.at(-1), { enabled: true, busy: false })

  screen.teardown()
  await controller.destroy()
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
  const reveal = byAction(screen, 'reveal')
  const comparisonProgress = descendants(screen.element).find(
    (element) => Object.hasOwn(element.dataset, 'comparisonProgress'),
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
  assert.equal(byValue(screen, 'stage').textContent, 'Source')
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
  assert.equal(comparisonProgress.textContent, 'Revealing cards · 1 of 3')
  assert.equal(reveal.disabled, true)
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
  assert.equal(comparisonProgress.textContent, 'Presentation skipped.')
  assert.equal(reveal.disabled, false)

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
    revealOrContinue() {},
    pause() {},
    resume() {},
    saveStable: async () => ({ status: 'saved' }),
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
        return Promise.resolve({ status: 'failed', reason: 'adapter-error' })
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
  assert.equal(
    status.textContent,
    'Presentation skipped after a rendering error.',
  )
  assert.equal(byAction(screen, 'reveal').disabled, false)
  assert.equal(saveWarning.hidden, false)
  assert.equal(
    saveWarning.textContent,
    'Save failed (quota-exceeded). Your game remains available in this session.',
  )
  screen.teardown()
})

test('Game exposes terminal outcome details and disables primary actions', (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  let terminal = createMatch({
    runId: 'hud-terminal',
    seed: 0,
    ruleset: BASELINE_RULESET,
  })
  while (terminal.status === 'active') {
    terminal = revealOrContinue(terminal).match
  }
  const controller = createRunController({
    repository: {
      load: async () => ({ status: 'empty' }),
      save: async () => ({ status: 'saved', savedAt: '2026-09-22T17:10:00.000Z' }),
    },
    initialMatch: terminal,
  })
  const screen = createGameScreen({
    runController: controller,
    mountBattlefield: () => undefined,
  })
  const result = descendants(screen.element).find(
    (element) => Object.hasOwn(element.dataset, 'comparisonResult'),
  )
  const details = descendants(screen.element).find(
    (element) => Object.hasOwn(element.dataset, 'comparisonDetails'),
  )
  const status = descendants(screen.element).find(
    (element) => Object.hasOwn(element.dataset, 'statusHost'),
  )

  assert.match(result.textContent, /won the match|ended in a draw/)
  assert.match(details.textContent, /^Final clash:/)
  assert.match(status.textContent, /won the match|ended in a draw/)
  assert.equal(byAction(screen, 'reveal').disabled, true)
  assert.equal(byAction(screen, 'pause').disabled, true)
  screen.teardown()
})

test('End overlay waits for terminal save and presentation before showing its summary', async (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  let terminal = createMatch({
    runId: 'hud-terminal-overlay',
    seed: 0,
    ruleset: BASELINE_RULESET,
  })
  while (terminal.status === 'active') {
    terminal = revealOrContinue(terminal).match
  }
  const write = deferred()
  const animation = deferred()
  const controller = createRunController({
    repository: {
      load: async () => ({ status: 'empty' }),
      save: async () => write.promise,
    },
    initialMatch: terminal,
  })
  let mainMenuCalls = 0
  const screen = createGameScreen({
    runController: controller,
    mountBattlefield: () => undefined,
    eventPlayerFactory: () => ({
      present: () => animation.promise,
      setPaused() {},
      destroy() {},
    }),
    onMainMenu() {
      mainMenuCalls += 1
    },
  })
  const pauseOverlay = descendants(screen.element).find(
    (element) => Object.hasOwn(element.dataset, 'pauseOverlay'),
  )
  const endOverlay = descendants(screen.element).find(
    (element) => Object.hasOwn(element.dataset, 'endOverlay'),
  )
  const summary = descendants(screen.element).find(
    (element) => Object.hasOwn(element.dataset, 'endSummary'),
  )

  const saving = controller.saveStable()
  assert.equal(endOverlay.hidden, true)
  write.resolve({
    status: 'saved',
    savedAt: '2026-09-23T01:02:00.000Z',
  })
  await saving
  await flushMicrotasks()
  assert.equal(endOverlay.hidden, true)

  animation.resolve({
    status: 'completed',
    eventId: terminal.pendingEvent.id,
    reason: null,
  })
  await flushMicrotasks()
  assert.equal(endOverlay.hidden, false)
  assert.equal(pauseOverlay.hidden, true)
  assert.equal(endOverlay.attributes.role, 'dialog')
  assert.equal(endOverlay.attributes['aria-modal'], 'true')
  assert.match(summary.textContent, new RegExp(`^${terminal.turn} clashes`))
  assert.match(summary.textContent, new RegExp(`${terminal.zones.burnPile.length} cards burned$`))

  byAction(screen, 'end-main').dispatch('click')
  assert.equal(mainMenuCalls, 1)
  screen.teardown()
  await controller.destroy()
})

test('restored terminal wins and draws reopen their completed summaries', async (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  for (const [seed, expectedHeading] of [[0, 'Victory'], [32, 'Match drawn']]) {
    let terminal = createMatch({
      runId: `hud-restored-terminal-${seed}`,
      seed,
      ruleset: BASELINE_RULESET,
    })
    while (terminal.status === 'active') {
      terminal = revealOrContinue(terminal).match
    }
    const controller = createRunController({
      repository: {
        load: async () => ({
          status: 'resumable',
          savedAt: '2026-09-23T01:03:00.000Z',
          migratedFrom: null,
          match: terminal,
        }),
        save: async () => assert.fail('Restored summary should not require another save'),
      },
    })
    await controller.restore()
    const before = JSON.parse(JSON.stringify(controller.currentMatch))
    const screen = createGameScreen({
      runController: controller,
      mountBattlefield: () => undefined,
      eventPlayerFactory: () => ({
        present(match) {
          return Promise.resolve({
            status: 'completed',
            eventId: match.pendingEvent.id,
            reason: null,
          })
        },
        setPaused() {},
        destroy() {},
      }),
    })
    await flushMicrotasks()
    const endOverlay = descendants(screen.element).find(
      (element) => Object.hasOwn(element.dataset, 'endOverlay'),
    )
    const heading = descendants(endOverlay).find(
      (element) => element.id === 'end-overlay-title',
    )
    const reason = descendants(endOverlay).find(
      (element) => Object.hasOwn(element.dataset, 'endReason'),
    )

    assert.equal(endOverlay.hidden, false)
    assert.equal(heading.textContent, expectedHeading)
    assert.ok(reason.textContent.length > 0)
    assert.deepEqual(controller.currentMatch, before)
    screen.teardown()
    await controller.destroy()
  }
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

test('Game ignores save completions from a replaced run', async (t) => {
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
      runId: 'replaced-old-run',
      seed: 0,
      ruleset: BASELINE_RULESET,
    }),
  })
  const oldSave = controller.revealOrContinue()
  await Promise.resolve()
  const newMatch = createMatch({
    runId: 'replacement-new-run',
    seed: 1,
    ruleset: BASELINE_RULESET,
  })
  controller.setMatch(newMatch)
  const newSave = controller.saveStable()
  const presentedRunIds = []
  const screen = createGameScreen({
    runController: controller,
    mountBattlefield: () => undefined,
    eventPlayerFactory: () => ({
      present(match) {
        presentedRunIds.push(match.runId)
        return Promise.resolve({ status: 'synchronized' })
      },
      setPaused() {},
      destroy() {},
    }),
  })

  assert.deepEqual(presentedRunIds, [newMatch.runId])
  writes[0].resolve({
    status: 'saved',
    savedAt: '2026-09-22T20:00:00.000Z',
  })
  await oldSave
  await flushMicrotasks()
  assert.deepEqual(presentedRunIds, [newMatch.runId])

  writes[1].resolve({
    status: 'saved',
    savedAt: '2026-09-22T20:00:01.000Z',
  })
  await newSave
  await flushMicrotasks()
  assert.ok(presentedRunIds.length >= 1)
  assert.ok(presentedRunIds.every((runId) => runId === newMatch.runId))

  screen.teardown()
  await controller.destroy()
})

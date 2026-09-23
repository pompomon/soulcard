import assert from 'node:assert/strict'
import test from 'node:test'
import { bootstrap } from '../../src/app/bootstrap.js'
import { createMatch, resumeMatch } from '../../src/domain/match-machine.js'
import { BASELINE_RULESET } from '../../src/domain/ruleset.js'
import { createRunSave, restoreRunSave } from '../../src/persistence/run-schema.js'
import { createSettingsRepository } from '../../src/persistence/settings-repository.js'

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
    this.style = { setProperty() {} }
  }

  append(...children) {
    this.children.push(...children)
  }

  replaceChildren(...children) {
    this.children = children
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
      button: type === 'click' ? 0 : undefined,
      detail: 0,
      preventDefault() {},
      stopPropagation() {},
      ...values,
    }
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event)
  }
}

function descendants(element) {
  return [element, ...element.children.flatMap(descendants)]
}

function byAction(root, action) {
  return descendants(root).find((element) => element.dataset.action === action)
}

function byData(root, key) {
  return descendants(root).find((element) => Object.hasOwn(element.dataset, key))
}

async function waitFor(predicate, rounds = 300) {
  for (let index = 0; index < rounds; index += 1) {
    if (predicate()) return
    await Promise.resolve()
  }
  assert.fail('Condition did not settle')
}

function createMemoryRepository() {
  let record = null
  let saveCount = 0
  return {
    async load() {
      if (record === null) return { status: 'empty' }
      return {
        status: 'resumable',
        savedAt: record.savedAt,
        migratedFrom: null,
        match: restoreRunSave(structuredClone(record)),
      }
    },
    async save(match) {
      saveCount += 1
      const savedAt = `2026-09-23T02:${String(saveCount).padStart(2, '0')}:00.000Z`
      record = structuredClone(createRunSave(match, { savedAt }))
      return { status: 'saved', savedAt }
    },
    async discard() {
      record = null
      return { status: 'discarded' }
    },
    close() {},
    get record() {
      return structuredClone(record)
    },
  }
}

function immediateEventPlayer({ onStateChange }) {
  return {
    present(match) {
      const eventId = match.pendingEvent?.id ?? null
      if (eventId !== null) {
        onStateChange({
          status: 'completed',
          eventId,
          stepIndex: null,
          stepCount: match.pendingEvent.reveals.length,
          stepKind: null,
          reason: null,
        })
      }
      return Promise.resolve({
        status: eventId === null ? 'synchronized' : 'completed',
        eventId,
        reason: null,
      })
    },
    setPaused() {},
    destroy() {},
  }
}

function appOptions(repository, overrides = {}) {
  return {
    runRepository: repository,
    settingsRepository: createSettingsRepository({ storage: null }),
    matchMedia: null,
    pageLifecycleFactory: () => ({ destroy() {} }),
    mountBattlefield: () => undefined,
    eventPlayerFactory: immediateEventPlayer,
    ...overrides,
  }
}

test('start, pause, save to Main, reload, and resume preserve the exact run', async (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  const repository = createMemoryRepository()
  const initial = createMatch({
    runId: 'integration-menu-lifecycle',
    seed: 12345,
    ruleset: BASELINE_RULESET,
  })
  const firstRoot = new FakeElement('div')
  const first = bootstrap({
    root: firstRoot,
    ...appOptions(repository, { newMatchFactory: () => initial }),
  })
  await first.ready
  byAction(firstRoot, 'start').dispatch('click')
  await waitFor(() => first.runSnapshot.saveStatus === 'saved')
  byAction(firstRoot, 'reveal').dispatch('click')
  await waitFor(() => (
    first.runSnapshot.match.turn === 1
    && first.runSnapshot.saveStatus === 'saved'
    && byAction(firstRoot, 'reveal').disabled === false
  ))
  byAction(firstRoot, 'pause').dispatch('click')
  await waitFor(() => (
    first.runSnapshot.match.machineState === 'paused'
    && first.runSnapshot.saveStatus === 'saved'
    && byAction(firstRoot, 'save-main').disabled === false
  ))
  const paused = structuredClone(first.runSnapshot.match)
  byAction(firstRoot, 'save-main').dispatch('click')
  await waitFor(() => first.activeScreen === 'main')
  assert.deepEqual(restoreRunSave(repository.record), paused)
  await first.destroy()

  const secondRoot = new FakeElement('div')
  const replacement = createMatch({
    runId: 'integration-menu-replacement',
    seed: 7,
    ruleset: BASELINE_RULESET,
  })
  const confirmations = [false, true]
  let confirmationCalls = 0
  const second = bootstrap({
    root: secondRoot,
    ...appOptions(repository, {
      confirmStartOver() {
        const result = confirmations[confirmationCalls]
        confirmationCalls += 1
        return result
      },
      newMatchFactory: () => replacement,
    }),
  })
  await second.ready
  assert.equal(second.resumeAvailable, true)
  assert.deepEqual(second.runSnapshot.match, paused)
  byAction(secondRoot, 'resume').dispatch('click')
  assert.equal(byData(secondRoot, 'pauseOverlay').hidden, false)
  byAction(secondRoot, 'resume').dispatch('click')
  assert.deepEqual(second.runSnapshot.match, resumeMatch(paused))
  assert.deepEqual(second.runSnapshot.match.rng, paused.rng)
  assert.deepEqual(second.runSnapshot.match.zones, paused.zones)
  assert.deepEqual(second.runSnapshot.match.pendingEvent, paused.pendingEvent)

  byAction(secondRoot, 'pause').dispatch('click')
  await waitFor(() => byAction(secondRoot, 'save-main').disabled === false)
  byAction(secondRoot, 'save-main').dispatch('click')
  await waitFor(() => second.activeScreen === 'main')
  const beforeOverwrite = second.runSnapshot.match
  byAction(secondRoot, 'start').dispatch('click')
  assert.deepEqual(second.runSnapshot.match, beforeOverwrite)
  assert.equal(second.activeScreen, 'main')
  byAction(secondRoot, 'start').dispatch('click')
  await waitFor(() => second.runSnapshot.match.runId === replacement.runId)
  assert.equal(confirmationCalls, 2)
  assert.equal(second.activeScreen, 'game')
  await waitFor(() => second.runSnapshot.saveStatus === 'saved')
  await second.destroy()
})

test('recovery discard enables a clean new run without a resume crash loop', async (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  let state = 'recovery'
  let savedMatch = null
  let confirmations = 0
  const repository = {
    async load() {
      if (state === 'recovery') {
        return {
          status: 'recovery-required',
          reason: 'invalid-save',
          message: 'This saved run is invalid and must be discarded.',
        }
      }
      return { status: 'empty' }
    },
    async save(match) {
      savedMatch = match
      state = 'saved'
      return {
        status: 'saved',
        savedAt: '2026-09-23T02:30:00.000Z',
      }
    },
    async discard() {
      state = 'empty'
      return { status: 'discarded' }
    },
    close() {},
  }
  const fresh = createMatch({
    runId: 'integration-recovered-run',
    seed: 9,
    ruleset: BASELINE_RULESET,
  })
  const root = new FakeElement('div')
  const app = bootstrap({
    root,
    ...appOptions(repository, {
      confirmStartOver() {
        confirmations += 1
        return true
      },
      newMatchFactory: () => fresh,
    }),
  })
  await app.ready
  assert.equal(app.resumeAvailable, false)
  assert.equal(byAction(root, 'resume').disabled, true)
  assert.equal(byAction(root, 'discard').hidden, false)

  byAction(root, 'discard').dispatch('click')
  await waitFor(() => app.runSnapshot.restoreStatus === 'empty')
  assert.equal(byAction(root, 'discard').hidden, true)
  byAction(root, 'start').dispatch('click')
  await waitFor(() => app.runSnapshot.saveStatus === 'saved')
  assert.equal(confirmations, 0)
  assert.deepEqual(savedMatch, fresh)
  assert.equal(app.resumeAvailable, true)
  await app.destroy()
})

test('terminal save and presentation gate the end summary, Main, and restart', async (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  const repository = createMemoryRepository()
  const firstMatch = createMatch({
    runId: 'integration-terminal-run',
    seed: 0,
    ruleset: BASELINE_RULESET,
  })
  const replacement = createMatch({
    runId: 'integration-after-terminal',
    seed: 5,
    ruleset: BASELINE_RULESET,
  })
  const matches = [firstMatch, replacement]
  let matchIndex = 0
  let confirmations = 0
  const root = new FakeElement('div')
  const app = bootstrap({
    root,
    ...appOptions(repository, {
      confirmStartOver() {
        confirmations += 1
        return true
      },
      newMatchFactory: () => matches[matchIndex++],
    }),
  })
  await app.ready
  byAction(root, 'start').dispatch('click')
  await waitFor(() => app.runSnapshot.saveStatus === 'saved')

  let guard = 0
  while (app.runSnapshot.match.status === 'active') {
    guard += 1
    assert.ok(guard < 100, 'terminal integration exceeded its clash guard')
    const nextTurn = app.runSnapshot.match.turn + 1
    byAction(root, 'reveal').dispatch('click')
    await waitFor(() => (
      app.runSnapshot.match.turn === nextTurn
      && app.runSnapshot.saveStatus === 'saved'
      && (
        app.runSnapshot.match.status === 'ended'
        || byAction(root, 'reveal').disabled === false
      )
    ))
  }

  await waitFor(() => byData(root, 'endOverlay').hidden === false)
  const terminal = structuredClone(app.runSnapshot.match)
  assert.deepEqual(restoreRunSave(repository.record), terminal)
  assert.equal(byData(root, 'pauseOverlay').hidden, true)
  assert.equal(byAction(root, 'reveal').disabled, true)
  assert.equal(byAction(root, 'pause').disabled, true)

  byAction(root, 'end-main').dispatch('click')
  assert.equal(app.activeScreen, 'main')
  assert.equal(app.resumeAvailable, true)
  byAction(root, 'resume').dispatch('click')
  await waitFor(() => byData(root, 'endOverlay').hidden === false)
  assert.deepEqual(app.runSnapshot.match, terminal)

  byAction(root, 'end-restart').dispatch('click')
  await waitFor(() => app.runSnapshot.match.runId === replacement.runId)
  assert.equal(confirmations, 1)
  assert.equal(app.activeScreen, 'game')
  assert.equal(app.runSnapshot.match.turn, 0)
  await waitFor(() => app.runSnapshot.saveStatus === 'saved')
  await app.destroy()
})

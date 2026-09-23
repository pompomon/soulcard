import assert from 'node:assert/strict'
import test from 'node:test'
import { createMainScreen } from '../../src/ui/menus.js'

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

test('Main reports restore, recovery, session-only, and resumable states', (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  let snapshot = {
    match: null,
    restoreStatus: 'loading',
    restoreReason: null,
    restoreMessage: null,
    saveStatus: 'idle',
    saveReason: null,
    discardStatus: 'idle',
    discardReason: null,
  }
  let listener
  let discarded = 0
  const runController = {
    getSnapshot: () => snapshot,
    subscribe(nextListener) {
      listener = nextListener
      listener(snapshot)
      return () => {
        listener = null
      }
    },
  }
  const screen = createMainScreen({
    resumeAvailable: true,
    runController,
    onStart() {},
    onResume() {},
    onSettings() {},
    onDiscard() {
      discarded += 1
    },
  })
  const status = descendants(screen.element).find(
    (element) => Object.hasOwn(element.dataset, 'mainStatus'),
  )
  const start = byAction(screen, 'start')
  const resume = byAction(screen, 'resume')
  const discard = byAction(screen, 'discard')

  assert.equal(status.attributes.role, 'status')
  assert.match(status.textContent, /Checking/)
  assert.equal(resume.disabled, true)
  assert.equal(discard.hidden, true)

  snapshot = {
    ...snapshot,
    restoreStatus: 'storage-unavailable',
    restoreReason: 'unavailable',
  }
  listener(snapshot)
  assert.match(status.textContent, /session/)
  assert.equal(start.disabled, false)
  assert.equal(resume.disabled, true)

  snapshot = {
    ...snapshot,
    restoreStatus: 'recovery-required',
    restoreReason: 'invalid-save',
    restoreMessage: 'This saved run is invalid and must be discarded.',
  }
  listener(snapshot)
  assert.equal(status.textContent, snapshot.restoreMessage)
  assert.equal(discard.hidden, false)
  discard.dispatch('click')
  assert.equal(discarded, 1)

  snapshot = {
    ...snapshot,
    discardStatus: 'discarding',
  }
  listener(snapshot)
  assert.equal(start.disabled, true)
  assert.equal(discard.disabled, true)
  discard.dispatch('click')
  assert.equal(discarded, 1)

  snapshot = {
    ...snapshot,
    discardStatus: 'failed',
    discardReason: 'transaction-aborted',
  }
  listener(snapshot)
  assert.match(status.textContent, /transaction-aborted/)
  assert.equal(discard.disabled, false)

  snapshot = {
    ...snapshot,
    match: { status: 'active', machineState: 'paused' },
    restoreStatus: 'resumable',
    saveStatus: 'saved',
    discardStatus: 'idle',
    discardReason: null,
  }
  listener(snapshot)
  assert.equal(status.textContent, 'Paused game available.')
  assert.equal(resume.disabled, false)
  assert.equal(discard.hidden, true)

  snapshot = {
    ...snapshot,
    match: { status: 'ended', machineState: 'ended' },
  }
  listener(snapshot)
  assert.match(status.textContent, /Completed game/)

  screen.teardown()
  assert.equal(listener, null)
})

test('Main guards Resume and discard callbacks against unavailable state', (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  const snapshot = {
    match: null,
    restoreStatus: 'empty',
    saveStatus: 'idle',
    discardStatus: 'idle',
  }
  let resumes = 0
  let discards = 0
  const screen = createMainScreen({
    resumeAvailable: true,
    runController: {
      getSnapshot: () => snapshot,
      subscribe(listener) {
        listener(snapshot)
        return () => {}
      },
    },
    onStart() {},
    onResume() {
      resumes += 1
    },
    onSettings() {},
    onDiscard() {
      discards += 1
    },
  })

  byAction(screen, 'resume').dispatch('click')
  byAction(screen, 'discard').dispatch('click')
  assert.equal(resumes, 0)
  assert.equal(discards, 0)
  screen.teardown()
})

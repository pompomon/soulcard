import assert from 'node:assert/strict'
import test from 'node:test'
import { createUpdateNotice } from '../../src/ui/update-notice.js'

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase()
    this.children = []
    this.dataset = {}
    this.listeners = new Map()
    this.className = ''
    this.textContent = ''
    this.hidden = false
    this.disabled = false
    this.inert = false
    this.parent = null
  }

  append(...children) {
    for (const child of children) child.parent = this
    this.children.push(...children)
  }

  setAttribute(name, value) {
    this[name] = value
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
      listener({ type })
    }
  }

  remove() {
    if (!this.parent) return
    this.parent.children = this.parent.children.filter((child) => child !== this)
    this.parent = null
  }
}

function descendants(element) {
  return [element, ...element.children.flatMap(descendants)]
}

function createController() {
  let snapshot = Object.freeze({
    status: 'current',
    reason: null,
    canActivate: false,
  })
  const subscribers = new Set()
  let activations = 0
  return {
    getSnapshot: () => snapshot,
    subscribe(subscriber) {
      subscribers.add(subscriber)
      subscriber(snapshot)
      return () => subscribers.delete(subscriber)
    },
    requestActivation() {
      activations += 1
      return Promise.resolve()
    },
    publish(nextSnapshot) {
      snapshot = Object.freeze(nextSnapshot)
      for (const subscriber of [...subscribers]) subscriber(snapshot)
    },
    get activations() {
      return activations
    },
    get subscribers() {
      return subscribers.size
    },
  }
}

test('update notice reports availability and blocks only underlying content during activation', (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  const host = new FakeElement('main')
  const content = new FakeElement('section')
  const alreadyInert = new FakeElement('section')
  alreadyInert.inert = true
  host.append(content, alreadyInert)
  const controller = createController()
  const notice = createUpdateNotice({ updateController: controller, host })
  const status = descendants(notice.element)
    .find((element) => Object.hasOwn(element.dataset, 'updateStatus'))
  const button = descendants(notice.element)
    .find((element) => element.dataset.action === 'update')
  const dismissButton = descendants(notice.element)
    .find((element) => element.dataset.action === 'dismiss-update')

  assert.equal(notice.element.hidden, true)
  controller.publish({
    status: 'available',
    reason: null,
    canActivate: true,
  })
  assert.equal(notice.element.hidden, false)
  assert.equal(status.textContent, 'An updated version of Soulcard is ready.')
  assert.equal(button.hidden, false)
  assert.equal(button.disabled, false)
  button.dispatch('click')
  assert.equal(controller.activations, 1)
  assert.equal(dismissButton.hidden, false)
  dismissButton.dispatch('click')
  assert.equal(notice.element.hidden, true)

  controller.publish({
    status: 'preparing',
    reason: null,
    canActivate: false,
  })
  assert.equal(content.inert, true)
  assert.equal(alreadyInert.inert, true)
  assert.equal(host.dataset.updateBlocked, 'true')
  assert.equal(notice.element.hidden, false)
  assert.equal(dismissButton.hidden, true)
  assert.equal(button.hidden, true)

  controller.publish({
    status: 'failed',
    reason: 'quota-exceeded',
    canActivate: true,
  })
  assert.equal(content.inert, false)
  assert.equal(alreadyInert.inert, true)
  assert.equal(Object.hasOwn(host.dataset, 'updateBlocked'), false)
  assert.match(status.textContent, /quota-exceeded/)
  assert.equal(button.hidden, false)
  assert.equal(button.disabled, false)

  notice.teardown()
  assert.equal(controller.subscribers, 0)
  assert.equal(host.children.includes(notice.element), false)
  button.dispatch('click')
  assert.equal(controller.activations, 1)
})

test('update notice validates its dependencies', (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  assert.throws(() => createUpdateNotice(), /updateController/)
  assert.throws(
    () => createUpdateNotice({
      updateController: createController(),
      host: null,
    }),
    /host/,
  )
})

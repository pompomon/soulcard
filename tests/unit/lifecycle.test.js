import assert from 'node:assert/strict'
import test from 'node:test'
import { createPageLifecycle } from '../../src/pwa/lifecycle.js'

class FakeEventTarget {
  constructor() {
    this.listeners = new Map()
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
}

test('hidden, pagehide, and freeze events request best-effort stable saves', async () => {
  const documentObject = new FakeEventTarget()
  documentObject.visibilityState = 'visible'
  documentObject.hidden = false
  const windowObject = new FakeEventTarget()
  const triggers = []
  const lifecycle = createPageLifecycle({
    documentObject,
    windowObject,
    onSave(trigger) {
      triggers.push(trigger)
      return Promise.resolve()
    },
  })

  documentObject.dispatch('visibilitychange')
  assert.deepEqual(triggers, [])
  documentObject.visibilityState = 'hidden'
  documentObject.hidden = true
  documentObject.dispatch('visibilitychange')
  windowObject.dispatch('pagehide')
  documentObject.dispatch('freeze')
  await Promise.resolve()

  assert.deepEqual(triggers, ['visibilitychange', 'pagehide', 'freeze'])
  assert.equal(windowObject.listeners.has('unload'), false)
  assert.equal(windowObject.listeners.has('beforeunload'), false)

  lifecycle.destroy()
  documentObject.dispatch('visibilitychange')
  windowObject.dispatch('pagehide')
  documentObject.dispatch('freeze')
  assert.deepEqual(triggers, ['visibilitychange', 'pagehide', 'freeze'])
  assert.equal(documentObject.listeners.get('visibilitychange').size, 0)
  assert.equal(documentObject.listeners.get('freeze').size, 0)
  assert.equal(windowObject.listeners.get('pagehide').size, 0)
})

test('lifecycle setup tolerates unavailable APIs and save failures', async () => {
  const lifecycle = createPageLifecycle({
    documentObject: null,
    windowObject: null,
    onSave() {
      throw new Error('best effort failure')
    },
  })
  lifecycle.destroy()
  lifecycle.destroy()

  const documentObject = new FakeEventTarget()
  documentObject.hidden = true
  const failing = createPageLifecycle({
    documentObject,
    windowObject: null,
    onSave: async () => {
      throw new Error('rejected best effort failure')
    },
  })
  assert.doesNotThrow(() => documentObject.dispatch('visibilitychange'))
  await Promise.resolve()
  failing.destroy()
})

test('lifecycle requires a save callback', () => {
  assert.throws(() => createPageLifecycle(), /onSave must be a function/)
  assert.throws(() => createPageLifecycle({ onSave: null }), /onSave must be a function/)
})

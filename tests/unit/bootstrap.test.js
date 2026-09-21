import assert from 'node:assert/strict'
import test from 'node:test'
import { bootstrap } from '../../src/app/bootstrap.js'
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
}

test('coordinator construction failure destroys the settings controller', () => {
  let listener = null
  let removedListener = null
  const mediaQueryList = {
    matches: false,
    addEventListener(type, callback) {
      assert.equal(type, 'change')
      listener = callback
    },
    removeEventListener(type, callback) {
      assert.equal(type, 'change')
      removedListener = callback
    },
  }

  assert.throws(
    () => bootstrap({
      root: null,
      settingsRepository: createSettingsRepository({ storage: null }),
      matchMedia: () => mediaQueryList,
    }),
    /root must support replaceChildren/,
  )
  assert.equal(typeof listener, 'function')
  assert.equal(removedListener, listener)
})

test('bootstrap owns run restoration, lifecycle wiring, and repository teardown', async (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  let closeCalls = 0
  let lifecycleDestroyCalls = 0
  let lifecycleSave
  const runRepository = {
    load: async () => ({ status: 'empty' }),
    async save() {
      assert.fail('No run should be saved while the repository is empty')
    },
    close() {
      closeCalls += 1
    },
  }
  const root = new FakeElement('div')
  const app = bootstrap({
    root,
    resumeAvailable: true,
    runRepository,
    settingsRepository: createSettingsRepository({ storage: null }),
    matchMedia: null,
    pageLifecycleFactory({ onSave }) {
      lifecycleSave = onSave
      return {
        destroy() {
          lifecycleDestroyCalls += 1
        },
      }
    },
    mountBattlefield: () => undefined,
  })

  assert.deepEqual(await app.ready, { status: 'empty' })
  assert.equal(app.resumeAvailable, false)
  assert.equal(app.runSnapshot.restoreStatus, 'empty')
  assert.deepEqual(await lifecycleSave(), {
    status: 'skipped',
    reason: 'no-active-run',
  })
  assert.equal(app.navigate('game'), 'game')
  assert.equal(root.children[0].dataset.screen, 'game')

  await app.destroy()
  assert.equal(lifecycleDestroyCalls, 1)
  assert.equal(closeCalls, 1)
  assert.deepEqual(root.children, [])
})

test('bootstrap enables Resume after restoring a resumable run', async (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  const restoreResult = Object.freeze({ status: 'resumable' })
  const runController = {
    currentMatch: null,
    getSnapshot: () => Object.freeze({}),
    restore: async () => restoreResult,
    saveStable: async () => Object.freeze({ status: 'skipped' }),
    subscribe: () => () => undefined,
    pause: () => undefined,
    resume: () => undefined,
    destroy: async () => undefined,
  }
  const app = bootstrap({
    root: new FakeElement('div'),
    runController,
    settingsRepository: createSettingsRepository({ storage: null }),
    matchMedia: null,
    pageLifecycleFactory: () => ({ destroy() {} }),
    mountBattlefield: () => undefined,
  })

  assert.equal(app.resumeAvailable, false)
  assert.equal(await app.ready, restoreResult)
  assert.equal(app.resumeAvailable, true)

  await app.destroy()
})

test('bootstrap does not refresh Resume after teardown', async (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  let resolveRestore
  const restore = new Promise((resolve) => {
    resolveRestore = resolve
  })
  const restoreResult = Object.freeze({ status: 'resumable' })
  const runController = {
    currentMatch: null,
    getSnapshot: () => Object.freeze({}),
    restore: () => restore,
    saveStable: async () => Object.freeze({ status: 'skipped' }),
    subscribe: () => () => undefined,
    pause: () => undefined,
    resume: () => undefined,
    destroy: async () => undefined,
  }
  const app = bootstrap({
    root: new FakeElement('div'),
    runController,
    settingsRepository: createSettingsRepository({ storage: null }),
    matchMedia: null,
    pageLifecycleFactory: () => ({ destroy() {} }),
    mountBattlefield: () => undefined,
  })

  await app.destroy()
  resolveRestore(restoreResult)
  assert.equal(await app.ready, restoreResult)
})

test('bootstrap tears down every owner when Game presentation teardown fails', async (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  let closeCalls = 0
  let lifecycleDestroyCalls = 0
  const app = bootstrap({
    root: new FakeElement('div'),
    runRepository: {
      load: async () => ({ status: 'empty' }),
      save: async () => assert.fail('Unexpected save'),
      close() {
        closeCalls += 1
      },
    },
    settingsRepository: createSettingsRepository({ storage: null }),
    matchMedia: null,
    pageLifecycleFactory: () => ({
      destroy() {
        lifecycleDestroyCalls += 1
      },
    }),
    mountBattlefield: () => () => {
      throw new Error('battlefield teardown failed')
    },
  })
  await app.ready
  app.navigate('game')

  await assert.rejects(app.destroy(), /battlefield teardown failed/)
  assert.equal(lifecycleDestroyCalls, 1)
  assert.equal(closeCalls, 1)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { bootstrap } from '../../src/app/bootstrap.js'
import { createRunController } from '../../src/app/run-controller.js'
import {
  createMatch,
  pauseMatch,
  revealOrContinue,
} from '../../src/domain/match-machine.js'
import { BASELINE_RULESET } from '../../src/domain/ruleset.js'
import {
  createRunSave,
  restoreRunSave,
} from '../../src/persistence/run-schema.js'
import { createSettingsRepository } from '../../src/persistence/settings-repository.js'
import {
  ACTIVATE_UPDATE_MESSAGE,
  createUpdateController,
} from '../../src/pwa/update-controller.js'

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

  replaceChildren(...children) {
    for (const child of children) child.parent = this
    this.children = children
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

  remove() {
    if (!this.parent) return
    this.parent.children = this.parent.children.filter((child) => child !== this)
    this.parent = null
  }
}

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

class FakeWorker extends FakeEventTarget {
  constructor() {
    super()
    this.state = 'installed'
    this.messages = []
  }

  postMessage(message) {
    this.messages.push(message)
  }

  activate() {
    this.state = 'activated'
    this.dispatch('statechange')
  }
}

class FakeRegistration extends FakeEventTarget {
  constructor(worker) {
    super()
    this.waiting = worker
    this.installing = null
  }
}

function deferred() {
  let resolve
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

async function waitFor(predicate, rounds = 100) {
  for (let index = 0; index < rounds; index += 1) {
    if (predicate()) return
    await Promise.resolve()
  }
  assert.fail('Condition did not settle')
}

function activeMatch(runId = 'pwa-update-run') {
  return createMatch({
    runId,
    seed: 12345,
    ruleset: BASELINE_RULESET,
  })
}

function endedMatch(runId) {
  let match = activeMatch(runId)
  while (match.status === 'active') {
    match = revealOrContinue(match).match
  }
  return match
}

function createUpdateFactory() {
  const worker = new FakeWorker()
  const registration = new FakeRegistration(worker)
  const windowObject = new FakeEventTarget()
  let reloads = 0
  windowObject.location = {
    reload() {
      reloads += 1
    },
  }
  let controller
  return {
    worker,
    factory(options) {
      controller = createUpdateController({
        ...options,
        production: true,
        navigatorObject: {
          serviceWorker: {
            controller: {},
            register: async () => registration,
          },
        },
        windowObject,
        documentObject: { readyState: 'complete' },
      })
      return controller
    },
    get controller() {
      return controller
    },
    get reloads() {
      return reloads
    },
  }
}

function appOptions(updateFactory) {
  return {
    root: new FakeElement('div'),
    settingsRepository: createSettingsRepository({ storage: null }),
    matchMedia: null,
    pageLifecycleFactory: () => ({ destroy() {} }),
    mountBattlefield: () => undefined,
    updateControllerFactory: updateFactory.factory,
  }
}

test('an update waits for outstanding and latest clash saves before activation', async (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  const writes = []
  const repository = {
    load: async () => ({ status: 'empty' }),
    save(match) {
      const operation = deferred()
      writes.push({ match, operation })
      return operation.promise
    },
  }
  const runController = createRunController({
    repository,
    initialMatch: activeMatch(),
  })
  const update = createUpdateFactory()
  const options = appOptions(update)
  const app = bootstrap({
    ...options,
    runController,
  })
  await update.controller.ready

  const clash = runController.revealOrContinue()
  await waitFor(() => writes.length === 1)
  const activation = update.controller.requestActivation()
  assert.equal(app.updateSnapshot.status, 'preparing')
  assert.equal(options.root.children[0].dataset.updateBlocked, 'true')
  assert.deepEqual(update.worker.messages, [])

  writes[0].operation.resolve({
    status: 'saved',
    savedAt: '2026-09-23T06:00:00.000Z',
  })
  await clash
  await waitFor(() => writes.length === 2)
  assert.deepEqual(update.worker.messages, [])
  assert.deepEqual(writes[1].match, runController.currentMatch)
  assert.notEqual(writes[1].match.pendingEvent, null)

  writes[1].operation.resolve({
    status: 'saved',
    savedAt: '2026-09-23T06:00:01.000Z',
  })
  assert.equal((await activation).status, 'activating')
  assert.deepEqual(update.worker.messages, [{ type: ACTIVATE_UPDATE_MESSAGE }])
  assert.deepEqual(
    restoreRunSave(createRunSave(writes[1].match, {
      savedAt: '2026-09-23T06:00:01.000Z',
    })),
    runController.currentMatch,
  )

  update.worker.activate()
  assert.equal(update.reloads, 1)
  await app.destroy()
})

test('activation waits for initial restore and permits an empty run without a save', async (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  const load = deferred()
  let saves = 0
  const update = createUpdateFactory()
  const app = bootstrap({
    ...appOptions(update),
    runRepository: {
      load: () => load.promise,
      save: async () => {
        saves += 1
        return { status: 'saved', savedAt: '2026-09-23T06:01:00.000Z' }
      },
    },
  })
  await update.controller.ready

  const activation = update.controller.requestActivation()
  await Promise.resolve()
  assert.deepEqual(update.worker.messages, [])
  load.resolve({ status: 'empty' })
  await app.ready
  assert.equal((await activation).status, 'activating')
  assert.equal(saves, 0)
  assert.deepEqual(update.worker.messages, [{ type: ACTIVATE_UPDATE_MESSAGE }])
  await app.destroy()
})

test('failed stable saves leave the update waiting and retryable', async (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  let fail = true
  let saves = 0
  const runController = createRunController({
    initialMatch: activeMatch('pwa-save-retry'),
    repository: {
      load: async () => ({ status: 'empty' }),
      async save() {
        saves += 1
        return fail
          ? {
              status: 'storage-unavailable',
              operation: 'save',
              reason: 'quota-exceeded',
            }
          : {
              status: 'saved',
              savedAt: '2026-09-23T06:02:00.000Z',
            }
      },
    },
  })
  const update = createUpdateFactory()
  const app = bootstrap({
    ...appOptions(update),
    runController,
  })
  await update.controller.ready

  assert.deepEqual(await update.controller.requestActivation(), {
    status: 'failed',
    reason: 'quota-exceeded',
  })
  assert.equal(app.updateSnapshot.canActivate, true)
  assert.deepEqual(update.worker.messages, [])

  fail = false
  assert.equal((await update.controller.requestActivation()).status, 'activating')
  assert.equal(saves, 2)
  assert.deepEqual(update.worker.messages, [{ type: ACTIVATE_UPDATE_MESSAGE }])
  await app.destroy()
})

test('paused and ended runs are saved unchanged before update activation', async (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  for (const match of [
    pauseMatch(activeMatch('pwa-paused-update')),
    endedMatch('pwa-ended-update'),
  ]) {
    const saves = []
    const runController = createRunController({
      initialMatch: match,
      repository: {
        load: async () => ({ status: 'empty' }),
        async save(savedMatch) {
          saves.push(savedMatch)
          return {
            status: 'saved',
            savedAt: '2026-09-23T06:03:00.000Z',
          }
        },
      },
    })
    const update = createUpdateFactory()
    const app = bootstrap({
      ...appOptions(update),
      runController,
    })
    await update.controller.ready

    assert.equal((await update.controller.requestActivation()).status, 'activating')
    assert.deepEqual(saves, [match])
    assert.deepEqual(saves[0].rng, match.rng)
    assert.deepEqual(saves[0].pendingEvent, match.pendingEvent)
    await app.destroy()
  }
})

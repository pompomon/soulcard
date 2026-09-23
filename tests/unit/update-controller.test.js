import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ACTIVATE_UPDATE_MESSAGE,
  createUpdateController,
} from '../../src/pwa/update-controller.js'

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
  constructor(state = 'installed') {
    super()
    this.state = state
    this.messages = []
  }

  postMessage(message) {
    this.messages.push(message)
  }

  setState(state) {
    this.state = state
    this.dispatch('statechange')
  }
}

class FakeRegistration extends FakeEventTarget {
  constructor({ waiting = null, installing = null } = {}) {
    super()
    this.waiting = waiting
    this.installing = installing
  }

  discover(worker) {
    this.installing = worker
    this.dispatch('updatefound')
  }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function createBrowser({
  registration = new FakeRegistration(),
  controlled = true,
  readyState = 'complete',
} = {}) {
  const windowObject = new FakeEventTarget()
  let reloads = 0
  windowObject.location = {
    reload() {
      reloads += 1
    },
  }
  const serviceWorker = {
    controller: controlled ? {} : null,
    registerCalls: [],
    register(url) {
      this.registerCalls.push(url)
      return Promise.resolve(registration)
    },
  }
  return {
    registration,
    windowObject,
    navigatorObject: { serviceWorker },
    documentObject: { readyState },
    get reloads() {
      return reloads
    },
  }
}

test('registration is production-only and unsupported environments remain current', async () => {
  const disabledBrowser = createBrowser()
  const disabled = createUpdateController({
    production: false,
    ...disabledBrowser,
  })
  assert.deepEqual(await disabled.ready, { status: 'disabled' })
  assert.deepEqual(disabled.getSnapshot(), {
    status: 'current',
    reason: null,
    canActivate: false,
  })
  assert.deepEqual(
    disabledBrowser.navigatorObject.serviceWorker.registerCalls,
    [],
  )

  const unsupported = createUpdateController({
    production: true,
    navigatorObject: {},
    windowObject: disabledBrowser.windowObject,
    documentObject: disabledBrowser.documentObject,
  })
  assert.deepEqual(await unsupported.ready, { status: 'unsupported' })
})

test('load registration reports an already-waiting controlled update', async () => {
  const worker = new FakeWorker()
  const browser = createBrowser({
    registration: new FakeRegistration({ waiting: worker }),
    readyState: 'loading',
  })
  const controller = createUpdateController({
    production: true,
    ...browser,
  })

  assert.deepEqual(browser.navigatorObject.serviceWorker.registerCalls, [])
  browser.windowObject.dispatch('load')
  assert.deepEqual(await controller.ready, { status: 'registered' })
  assert.deepEqual(browser.navigatorObject.serviceWorker.registerCalls, ['./sw.js'])
  assert.deepEqual(controller.getSnapshot(), {
    status: 'available',
    reason: null,
    canActivate: true,
  })
})

test('first installation is ignored while later installed workers are offered once', async () => {
  const firstInstall = new FakeWorker('installing')
  const registration = new FakeRegistration({ installing: firstInstall })
  const browser = createBrowser({ registration, controlled: false })
  const controller = createUpdateController({
    production: true,
    ...browser,
  })
  await controller.ready

  firstInstall.setState('installed')
  assert.equal(controller.getSnapshot().status, 'current')

  browser.navigatorObject.serviceWorker.controller = {}
  const update = new FakeWorker('installing')
  registration.waiting = update
  registration.discover(update)
  update.setState('installed')
  assert.equal(controller.getSnapshot().status, 'available')

  update.dispatch('statechange')
  assert.equal(controller.getSnapshot().status, 'available')
  assert.equal(update.listeners.get('statechange').size, 0)
})

test('activation is idempotent, waits for preparation, and reloads once after activation', async () => {
  const preparation = deferred()
  const worker = new FakeWorker()
  const browser = createBrowser({
    registration: new FakeRegistration({ waiting: worker }),
  })
  const statuses = []
  const controller = createUpdateController({
    production: true,
    prepareForActivation: () => preparation.promise,
    ...browser,
  })
  controller.subscribe(({ status }) => statuses.push(status))
  await controller.ready

  const first = controller.requestActivation()
  const second = controller.requestActivation()
  assert.equal(first, second)
  assert.equal(controller.getSnapshot().status, 'preparing')
  assert.deepEqual(worker.messages, [])

  preparation.resolve({ status: 'ready' })
  assert.deepEqual(await first, { status: 'activating', reason: null })
  assert.deepEqual(worker.messages, [{ type: ACTIVATE_UPDATE_MESSAGE }])
  assert.equal(browser.reloads, 0)

  worker.setState('activating')
  assert.equal(browser.reloads, 0)
  worker.setState('activated')
  worker.setState('activated')
  assert.equal(browser.reloads, 1)
  assert.deepEqual(statuses, ['current', 'available', 'preparing', 'activating'])
})

test('activation targets a replacement update discovered during preparation', async () => {
  const preparation = deferred()
  const original = new FakeWorker()
  const registration = new FakeRegistration({ waiting: original })
  const browser = createBrowser({ registration })
  const controller = createUpdateController({
    production: true,
    prepareForActivation: () => preparation.promise,
    ...browser,
  })
  await controller.ready

  const activation = controller.requestActivation()
  const replacement = new FakeWorker('installing')
  registration.waiting = replacement
  registration.discover(replacement)
  replacement.setState('installed')
  original.setState('redundant')
  preparation.resolve({ status: 'ready' })

  assert.deepEqual(await activation, { status: 'activating', reason: null })
  assert.deepEqual(original.messages, [])
  assert.deepEqual(replacement.messages, [{ type: ACTIVATE_UPDATE_MESSAGE }])
})

test('a replacement waiting worker republishes update availability', async () => {
  const original = new FakeWorker()
  const registration = new FakeRegistration({ waiting: original })
  const browser = createBrowser({ registration })
  const statuses = []
  const controller = createUpdateController({
    production: true,
    ...browser,
  })
  controller.subscribe(({ status }) => statuses.push(status))
  await controller.ready

  const replacement = new FakeWorker('installing')
  registration.waiting = replacement
  registration.discover(replacement)
  replacement.setState('installed')

  assert.deepEqual(statuses, ['current', 'available', 'available'])
})

test('requesting a redundant offered worker clears stale availability', async () => {
  const worker = new FakeWorker()
  const browser = createBrowser({
    registration: new FakeRegistration({ waiting: worker }),
  })
  const controller = createUpdateController({
    production: true,
    ...browser,
  })
  await controller.ready
  worker.setState('redundant')

  assert.deepEqual(await controller.requestActivation(), {
    status: 'skipped',
    reason: 'no-update',
  })
  assert.deepEqual(controller.getSnapshot(), {
    status: 'current',
    reason: null,
    canActivate: false,
  })
})

test('redundancy during preparation skips cleanly and permits a replacement', async () => {
  const preparation = deferred()
  const worker = new FakeWorker()
  const registration = new FakeRegistration({ waiting: worker })
  const browser = createBrowser({ registration })
  const controller = createUpdateController({
    production: true,
    prepareForActivation: () => preparation.promise,
    ...browser,
  })
  await controller.ready

  const activation = controller.requestActivation()
  worker.setState('redundant')
  preparation.resolve({ status: 'ready' })
  assert.deepEqual(await activation, {
    status: 'skipped',
    reason: 'no-update',
  })
  assert.equal(controller.getSnapshot().status, 'current')

  const replacement = new FakeWorker('installing')
  registration.waiting = replacement
  registration.discover(replacement)
  replacement.setState('installed')
  assert.equal((await controller.requestActivation()).status, 'activating')
  assert.deepEqual(replacement.messages, [{ type: ACTIVATE_UPDATE_MESSAGE }])
})

test('preparation failures leave the waiting update retryable', async () => {
  const worker = new FakeWorker()
  const browser = createBrowser({
    registration: new FakeRegistration({ waiting: worker }),
  })
  let fail = true
  const controller = createUpdateController({
    production: true,
    prepareForActivation() {
      if (fail) {
        const error = new Error('save failed')
        error.reason = 'quota-exceeded'
        throw error
      }
      return { status: 'ready' }
    },
    ...browser,
  })
  await controller.ready

  assert.deepEqual(await controller.requestActivation(), {
    status: 'failed',
    reason: 'quota-exceeded',
  })
  assert.deepEqual(controller.getSnapshot(), {
    status: 'failed',
    reason: 'quota-exceeded',
    canActivate: true,
  })
  assert.deepEqual(worker.messages, [])

  fail = false
  assert.equal((await controller.requestActivation()).status, 'activating')
  assert.deepEqual(worker.messages, [{ type: ACTIVATE_UPDATE_MESSAGE }])
})

test('destroy removes registration, worker, and pending load listeners', async () => {
  const installing = new FakeWorker('installing')
  const registration = new FakeRegistration({ installing })
  const browser = createBrowser({ registration })
  const controller = createUpdateController({
    production: true,
    ...browser,
  })
  await controller.ready
  assert.equal(registration.listeners.get('updatefound').size, 1)
  assert.equal(installing.listeners.get('statechange').size, 1)

  controller.destroy()
  assert.equal(registration.listeners.get('updatefound').size, 0)
  assert.equal(installing.listeners.get('statechange').size, 0)
  assert.throws(() => controller.subscribe(() => {}), /destroyed/)

  const loadingBrowser = createBrowser({ readyState: 'loading' })
  const loading = createUpdateController({
    production: true,
    ...loadingBrowser,
  })
  loading.destroy()
  loadingBrowser.windowObject.dispatch('load')
  assert.deepEqual(await loading.ready, { status: 'destroyed' })
  assert.deepEqual(
    loadingBrowser.navigatorObject.serviceWorker.registerCalls,
    [],
  )
})

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  createMatch,
  pauseMatch,
  revealOrContinue,
} from '../../src/domain/match-machine.js'
import { BASELINE_RULESET } from '../../src/domain/ruleset.js'
import {
  ACTIVE_RUN_KEY,
  QUARANTINED_RUN_KEY,
  RUN_DATABASE_NAME,
  RUN_DATABASE_VERSION,
  RUN_STORE_NAME,
  createRunRepository,
} from '../../src/persistence/run-repository.js'

const FIXTURE_ROOT = new URL('../fixtures/', import.meta.url)
const SAVED_AT = '2026-09-21T08:00:00.000Z'

function fixture(name) {
  return JSON.parse(readFileSync(new URL(name, FIXTURE_ROOT), 'utf8'))
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

function storageError(name, message = name) {
  const error = new Error(message)
  error.name = name
  return error
}

class FakeTransaction {
  constructor(factory, mode) {
    this.factory = factory
    this.mode = mode
    this.error = null
    this.oncomplete = null
    this.onerror = null
    this.onabort = null
    this.pending = 0
    this.completionScheduled = false
    this.finished = false
    this.aborted = false
    this.staged = new Map(
      [...factory.values].map(([key, value]) => [key, clone(value)]),
    )
  }

  objectStore(name) {
    if (name !== RUN_STORE_NAME) throw storageError('NotFoundError')
    return {
      get: (key) => this.request(() => this.staged.get(key), 'read'),
      put: (value, key) => this.request(() => {
        this.staged.set(key, clone(value))
        return key
      }, 'write'),
      delete: (key) => {
        const failure = this.factory.takeDeleteFailure()
        if (failure) throw failure
        return this.request(() => {
          this.staged.delete(key)
          return undefined
        }, 'write')
      },
    }
  }

  request(action, kind) {
    if (this.finished) throw storageError('TransactionInactiveError')
    const request = {
      result: undefined,
      error: null,
      onsuccess: null,
      onerror: null,
    }
    this.pending += 1
    queueMicrotask(() => {
      if (this.finished) return
      const forcedFailure = kind === 'write'
        ? this.factory.takeWriteFailure()
        : this.factory.takeReadFailure()
      if (forcedFailure) {
        request.error = forcedFailure
        request.onerror?.({ target: request })
        if (!this.aborted) this.abortWith(forcedFailure)
        return
      }

      try {
        request.result = clone(action())
        request.onsuccess?.({ target: request })
      } catch (error) {
        request.error = error
        request.onerror?.({ target: request })
        if (!this.aborted) this.abortWith(error)
        return
      } finally {
        if (!this.finished) {
          this.pending -= 1
          this.scheduleCompletion()
        }
      }
    })
    return request
  }

  scheduleCompletion() {
    if (this.pending !== 0 || this.completionScheduled || this.finished) return
    this.completionScheduled = true
    queueMicrotask(() => {
      this.completionScheduled = false
      if (this.pending !== 0 || this.finished) return
      const forcedAbort = this.factory.takeTransactionAbort()
      if (forcedAbort) {
        this.abortWith(forcedAbort)
        return
      }
      if (this.mode === 'readwrite') {
        this.factory.values = new Map(
          [...this.staged].map(([key, value]) => [key, clone(value)]),
        )
      }
      this.finished = true
      this.oncomplete?.()
    })
  }

  abortWith(error) {
    if (this.finished) return
    this.aborted = true
    this.finished = true
    this.error = error
    queueMicrotask(() => {
      this.onerror?.()
      this.onabort?.()
    })
  }

  abort() {
    this.abortWith(this.error ?? storageError('AbortError'))
  }
}

class FakeDatabase {
  constructor(factory) {
    this.factory = factory
    this.closed = false
    this.onclose = null
    this.onversionchange = null
    this.objectStoreNames = {
      contains: (name) => factory.initialized && name === RUN_STORE_NAME,
    }
  }

  createObjectStore(name) {
    if (name !== RUN_STORE_NAME) throw storageError('NotSupportedError')
    this.factory.initialized = true
    return {}
  }

  transaction(name, mode) {
    if (this.closed) throw storageError('InvalidStateError')
    if (!this.factory.initialized || name !== RUN_STORE_NAME) {
      throw storageError('NotFoundError')
    }
    return new FakeTransaction(this.factory, mode)
  }

  close() {
    this.closed = true
  }

  closeUnexpectedly() {
    this.closed = true
    this.onclose?.()
  }
}

class FakeIndexedDB {
  constructor() {
    this.values = new Map()
    this.initialized = false
    this.openCalls = []
    this.blockNextOpen = false
    this.openFailure = null
    this.writeFailure = null
    this.readFailure = null
    this.transactionAbort = null
    this.databases = []
  }

  open(name, version) {
    this.openCalls.push([name, version])
    const request = {
      result: null,
      error: null,
      transaction: { abort() {} },
      onupgradeneeded: null,
      onblocked: null,
      onerror: null,
      onsuccess: null,
    }
    queueMicrotask(() => {
      if (this.blockNextOpen) {
        this.blockNextOpen = false
        request.onblocked?.()
        return
      }
      if (this.openFailure) {
        request.error = this.openFailure
        this.openFailure = null
        request.onerror?.()
        return
      }

      const needsUpgrade = !this.initialized
      request.result = new FakeDatabase(this)
      this.databases.push(request.result)
      if (needsUpgrade) request.onupgradeneeded?.()
      request.onsuccess?.()
    })
    return request
  }

  seed(key, value) {
    this.initialized = true
    this.values.set(key, clone(value))
  }

  read(key) {
    return clone(this.values.get(key))
  }

  failNextWrite(name) {
    this.writeFailure = storageError(name)
  }

  failNextRead(name) {
    this.readFailure = storageError(name)
  }

  abortNextTransaction() {
    this.transactionAbort = storageError('AbortError')
  }

  failNextDelete(name) {
    this.deleteFailure = storageError(name)
  }

  takeDeleteFailure() {
    const failure = this.deleteFailure
    this.deleteFailure = null
    return failure
  }

  takeWriteFailure() {
    const error = this.writeFailure
    this.writeFailure = null
    return error
  }

  takeReadFailure() {
    const error = this.readFailure
    this.readFailure = null
    return error
  }

  takeTransactionAbort() {
    const error = this.transactionAbort
    this.transactionAbort = null
    return error
  }
}

function activeMatch(runId = 'repository-run', seed = 12345) {
  const match = createMatch({ runId, seed, ruleset: BASELINE_RULESET })
  return revealOrContinue(match).match
}

test('repository uses one versioned database and reports an empty initial state', async () => {
  const indexedDB = new FakeIndexedDB()
  const repository = createRunRepository({ indexedDB })

  assert.deepEqual(await repository.load(), { status: 'empty' })
  assert.deepEqual(indexedDB.openCalls, [[RUN_DATABASE_NAME, RUN_DATABASE_VERSION]])
  assert.equal(indexedDB.initialized, true)
  assert.equal(RUN_STORE_NAME, 'active-runs')
  assert.equal(ACTIVE_RUN_KEY, 'active')
  assert.equal(QUARANTINED_RUN_KEY, 'quarantine')
  repository.close()
})

test('save, load, and replacement atomically preserve valid stable snapshots', async () => {
  const indexedDB = new FakeIndexedDB()
  const repository = createRunRepository({
    indexedDB,
    now: () => new Date(SAVED_AT),
  })
  const first = activeMatch()

  assert.deepEqual(await repository.save(first), {
    status: 'saved',
    savedAt: SAVED_AT,
  })
  assert.equal(indexedDB.read(ACTIVE_RUN_KEY).saveSchemaVersion, 3)
  assert.equal(indexedDB.read(QUARANTINED_RUN_KEY), undefined)

  const loaded = await repository.load()
  assert.equal(loaded.status, 'resumable')
  assert.equal(loaded.savedAt, SAVED_AT)
  assert.equal(loaded.migratedFrom, null)
  assert.deepEqual(loaded.match, first)
  assert.ok(Object.isFrozen(loaded))
  assert.ok(Object.isFrozen(loaded.match))

  const replacement = activeMatch('replacement-run', 7)
  assert.deepEqual(await repository.replace(replacement, {
    savedAt: '2026-09-21T08:10:00.000Z',
  }), {
    status: 'saved',
    savedAt: '2026-09-21T08:10:00.000Z',
  })
  assert.equal((await repository.load()).match.runId, 'replacement-run')
})

test('paused snapshots save and restore without changing RNG or the pending event', async () => {
  const indexedDB = new FakeIndexedDB()
  const repository = createRunRepository({
    indexedDB,
    now: () => new Date(SAVED_AT),
  })
  const ready = activeMatch('fixture-active')
  const paused = pauseMatch(ready)

  assert.deepEqual(await repository.save(paused), {
    status: 'saved',
    savedAt: SAVED_AT,
  })
  assert.deepEqual(indexedDB.read(ACTIVE_RUN_KEY), fixture('run-save-paused-v3.json'))
  const loaded = await repository.load()
  assert.equal(loaded.status, 'resumable')
  assert.deepEqual(loaded.match, paused)
  assert.deepEqual(loaded.match.rng, ready.rng)
  assert.deepEqual(loaded.match.pendingEvent, ready.pendingEvent)
})

test('load migrates legacy saves and replaces them atomically', async () => {
  for (const version of [1, 2]) {
    const indexedDB = new FakeIndexedDB()
    indexedDB.seed(ACTIVE_RUN_KEY, fixture(`run-save-v${version}.json`))
    const repository = createRunRepository({
      indexedDB,
      now: () => SAVED_AT,
    })

    const loaded = await repository.load()
    assert.equal(loaded.status, 'resumable')
    assert.equal(loaded.migratedFrom, version)
    assert.equal(loaded.match.runId, 'fixture-active')
    assert.deepEqual(indexedDB.read(ACTIVE_RUN_KEY), fixture('run-save-v3.json'))
  }
})

test('invalid saves are quarantined once and require explicit discard', async () => {
  const indexedDB = new FakeIndexedDB()
  const corrupt = fixture('run-save-v3.json')
  corrupt.match.sourceDeck.pop()
  indexedDB.seed(ACTIVE_RUN_KEY, corrupt)
  const repository = createRunRepository({
    indexedDB,
    now: () => SAVED_AT,
  })

  const first = await repository.load()
  assert.deepEqual(first, {
    status: 'recovery-required',
    reason: 'invalid-save',
    message: 'This saved run is invalid and must be discarded before starting a new run.',
  })
  assert.equal(indexedDB.read(ACTIVE_RUN_KEY), undefined)
  assert.equal(indexedDB.read(QUARANTINED_RUN_KEY).reason, 'invalid-save')
  assert.deepEqual(indexedDB.read(QUARANTINED_RUN_KEY).record, corrupt)
  assert.deepEqual(await repository.load(), first)

  assert.deepEqual(await repository.discard(), { status: 'discarded' })
  assert.equal(indexedDB.read(QUARANTINED_RUN_KEY), undefined)
  assert.deepEqual(await repository.load(), { status: 'empty' })
})

test('future, incompatible, and malformed legacy saves expose distinct recovery reasons', async () => {
  for (const [fixtureName, field, value, reason] of [
    ['run-save-v3.json', 'saveSchemaVersion', 99, 'unsupported-save-version'],
    ['run-save-v3.json', 'gameRulesVersion', 99, 'incompatible-game-rules'],
    ['run-save-v1.json', 'gameRulesVersion', '1', 'invalid-save'],
  ]) {
    const indexedDB = new FakeIndexedDB()
    const save = fixture(fixtureName)
    save[field] = value
    indexedDB.seed(ACTIVE_RUN_KEY, save)
    const repository = createRunRepository({
      indexedDB,
      now: () => SAVED_AT,
    })

    const loaded = await repository.load()
    assert.equal(loaded.status, 'recovery-required')
    assert.equal(loaded.reason, reason)
    assert.equal(indexedDB.read(ACTIVE_RUN_KEY), undefined)
    assert.equal(indexedDB.read(QUARANTINED_RUN_KEY).reason, reason)
  }
})

test('unavailable, blocked, and failed storage return explicit failures', async () => {
  const match = activeMatch()
  const unavailable = createRunRepository({ indexedDB: null })
  assert.deepEqual(await unavailable.load(), {
    status: 'storage-unavailable',
    operation: 'load',
    reason: 'unavailable',
  })
  assert.deepEqual(await unavailable.save(match, { savedAt: SAVED_AT }), {
    status: 'storage-unavailable',
    operation: 'save',
    reason: 'unavailable',
  })
  assert.deepEqual(await unavailable.discard(), {
    status: 'storage-unavailable',
    operation: 'discard',
    reason: 'unavailable',
  })

  const blockedFactory = new FakeIndexedDB()
  blockedFactory.blockNextOpen = true
  assert.deepEqual(await createRunRepository({ indexedDB: blockedFactory }).load(), {
    status: 'storage-unavailable',
    operation: 'load',
    reason: 'blocked',
  })

  const failedFactory = new FakeIndexedDB()
  failedFactory.openFailure = storageError('UnknownError')
  assert.deepEqual(await createRunRepository({ indexedDB: failedFactory }).load(), {
    status: 'storage-unavailable',
    operation: 'load',
    reason: 'storage-error',
  })
})

test('close supersedes an in-flight open without leaking or blocking a later reopen', async () => {
  const indexedDB = new FakeIndexedDB()
  const repository = createRunRepository({ indexedDB })

  const loading = repository.load()
  repository.close()
  assert.deepEqual(await loading, {
    status: 'storage-unavailable',
    operation: 'load',
    reason: 'transaction-aborted',
  })
  assert.equal(indexedDB.databases.length, 1)
  assert.equal(indexedDB.databases[0].closed, true)

  assert.deepEqual(await repository.load(), { status: 'empty' })
  assert.equal(indexedDB.openCalls.length, 2)
  assert.equal(indexedDB.databases[1].closed, false)
})

test('a version change closes and invalidates the cached connection for reopening', async () => {
  const indexedDB = new FakeIndexedDB()
  const repository = createRunRepository({ indexedDB })

  assert.deepEqual(await repository.load(), { status: 'empty' })
  const firstDatabase = indexedDB.databases[0]
  firstDatabase.onversionchange()
  assert.equal(firstDatabase.closed, true)

  assert.deepEqual(await repository.load(), { status: 'empty' })
  assert.equal(indexedDB.openCalls.length, 2)
  assert.equal(indexedDB.databases[1].closed, false)
})

test('an unexpected close invalidates the cached connection for reopening', async () => {
  const indexedDB = new FakeIndexedDB()
  const repository = createRunRepository({ indexedDB })

  assert.deepEqual(await repository.load(), { status: 'empty' })
  const firstDatabase = indexedDB.databases[0]
  firstDatabase.closeUnexpectedly()
  assert.equal(firstDatabase.closed, true)

  assert.deepEqual(await repository.load(), { status: 'empty' })
  assert.equal(indexedDB.openCalls.length, 2)
  assert.equal(indexedDB.databases[1].closed, false)
})

test('quota and abort failures never report success or partially replace a save', async () => {
  const indexedDB = new FakeIndexedDB()
  indexedDB.seed(ACTIVE_RUN_KEY, fixture('run-save-v3.json'))
  indexedDB.seed(QUARANTINED_RUN_KEY, {
    quarantinedAt: SAVED_AT,
    reason: 'invalid-save',
    record: {},
  })
  const repository = createRunRepository({ indexedDB })
  const replacement = activeMatch('replacement-run', 7)

  indexedDB.failNextWrite('QuotaExceededError')
  assert.deepEqual(await repository.replace(replacement, { savedAt: SAVED_AT }), {
    status: 'storage-unavailable',
    operation: 'save',
    reason: 'quota-exceeded',
  })
  assert.deepEqual(indexedDB.read(ACTIVE_RUN_KEY), fixture('run-save-v3.json'))
  assert.notEqual(indexedDB.read(QUARANTINED_RUN_KEY), undefined)

  indexedDB.abortNextTransaction()
  assert.deepEqual(await repository.replace(replacement, { savedAt: SAVED_AT }), {
    status: 'storage-unavailable',
    operation: 'save',
    reason: 'transaction-aborted',
  })
  assert.deepEqual(indexedDB.read(ACTIVE_RUN_KEY), fixture('run-save-v3.json'))
  assert.notEqual(indexedDB.read(QUARANTINED_RUN_KEY), undefined)
})

test('synchronous execution failures abort queued transaction writes', async () => {
  const indexedDB = new FakeIndexedDB()
  indexedDB.seed(ACTIVE_RUN_KEY, fixture('run-save-v3.json'))
  indexedDB.seed(QUARANTINED_RUN_KEY, {
    quarantinedAt: SAVED_AT,
    reason: 'invalid-save',
    record: {},
  })
  const repository = createRunRepository({ indexedDB })

  indexedDB.failNextDelete('InvalidStateError')
  assert.deepEqual(await repository.replace(activeMatch('replacement-run', 7), {
    savedAt: SAVED_AT,
  }), {
    status: 'storage-unavailable',
    operation: 'save',
    reason: 'storage-error',
  })
  assert.deepEqual(indexedDB.read(ACTIVE_RUN_KEY), fixture('run-save-v3.json'))
  assert.notEqual(indexedDB.read(QUARANTINED_RUN_KEY), undefined)
})

test('failed reads and quarantine writes preserve the original active record', async () => {
  const indexedDB = new FakeIndexedDB()
  const corrupt = fixture('run-save-v3.json')
  corrupt.match.sourceDeck.pop()
  indexedDB.seed(ACTIVE_RUN_KEY, corrupt)
  const repository = createRunRepository({
    indexedDB,
    now: () => SAVED_AT,
  })

  indexedDB.failNextRead('UnknownError')
  assert.deepEqual(await repository.load(), {
    status: 'storage-unavailable',
    operation: 'load',
    reason: 'storage-error',
  })
  assert.deepEqual(indexedDB.read(ACTIVE_RUN_KEY), corrupt)
  assert.equal(indexedDB.read(QUARANTINED_RUN_KEY), undefined)

  indexedDB.failNextWrite('QuotaExceededError')
  assert.deepEqual(await repository.load(), {
    status: 'storage-unavailable',
    operation: 'load',
    reason: 'quota-exceeded',
  })
  assert.deepEqual(indexedDB.read(ACTIVE_RUN_KEY), corrupt)
  assert.equal(indexedDB.read(QUARANTINED_RUN_KEY), undefined)
})

test('invalid caller snapshots fail before IndexedDB is opened', async () => {
  const indexedDB = new FakeIndexedDB()
  const repository = createRunRepository({ indexedDB })

  await assert.rejects(
    repository.save({}, { savedAt: SAVED_AT }),
    /match must contain only/,
  )
  await assert.rejects(
    repository.save(activeMatch(), { savedAt: 'not-a-date' }),
    /canonical ISO timestamp/,
  )
  let invoked = false
  const options = {}
  Object.defineProperty(options, 'savedAt', {
    enumerable: true,
    get() {
      invoked = true
      return SAVED_AT
    },
  })
  await assert.rejects(
    repository.save(activeMatch(), options),
    /JSON-compatible data/,
  )
  assert.equal(invoked, false)
  assert.deepEqual(indexedDB.openCalls, [])
})

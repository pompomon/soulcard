import { migrateRunSave } from './migrations.js'
import {
  UnsupportedGameRulesVersionError,
  UnsupportedSaveVersionError,
  createRunSave,
  restoreRunSave,
} from './run-schema.js'

export const RUN_DATABASE_NAME = 'soulcard-runs'
export const RUN_DATABASE_VERSION = 1
export const RUN_STORE_NAME = 'active-runs'
export const ACTIVE_RUN_KEY = 'active'
export const QUARANTINED_RUN_KEY = 'quarantine'

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) {
      deepFreeze(child)
    }
    Object.freeze(value)
  }
  return value
}

function defaultIndexedDB() {
  try {
    return globalThis.indexedDB ?? null
  } catch {
    return null
  }
}

function createStorageError(name, message) {
  const error = new Error(message)
  error.name = name
  return error
}

function classifyStorageError(error) {
  if (error?.name === 'QuotaExceededError') return 'quota-exceeded'
  if (error?.name === 'AbortError') return 'transaction-aborted'
  if (error?.name === 'BlockedError') return 'blocked'
  if (error?.name === 'NotSupportedError') return 'unavailable'
  return 'storage-error'
}

function storageUnavailable(operation, error) {
  return deepFreeze({
    status: 'storage-unavailable',
    operation,
    reason: classifyStorageError(error),
  })
}

function recoveryReason(error) {
  if (error instanceof UnsupportedSaveVersionError) return 'unsupported-save-version'
  if (error instanceof UnsupportedGameRulesVersionError) return 'incompatible-game-rules'
  return 'invalid-save'
}

function recoveryMessage(reason) {
  if (reason === 'unsupported-save-version') {
    return 'This saved run was created by an unsupported app version and must be discarded.'
  }
  if (reason === 'incompatible-game-rules') {
    return 'This saved run uses incompatible game rules and must be discarded.'
  }
  return 'This saved run is invalid and must be discarded before starting a new run.'
}

function timestampFromClock(now) {
  const value = now()
  const timestamp = value instanceof Date ? value.toISOString() : value
  if (typeof timestamp !== 'string') {
    throw new TypeError('now must return a Date or canonical ISO timestamp')
  }
  return timestamp
}

function openDatabase(indexedDB) {
  if (
    indexedDB === null
    || typeof indexedDB !== 'object'
    || typeof indexedDB.open !== 'function'
  ) {
    return Promise.reject(createStorageError(
      'NotSupportedError',
      'IndexedDB is not available',
    ))
  }

  return new Promise((resolve, reject) => {
    let request
    let settled = false
    try {
      request = indexedDB.open(RUN_DATABASE_NAME, RUN_DATABASE_VERSION)
    } catch (error) {
      reject(error)
      return
    }

    request.onupgradeneeded = () => {
      try {
        const database = request.result
        if (!database.objectStoreNames.contains(RUN_STORE_NAME)) {
          database.createObjectStore(RUN_STORE_NAME)
        }
      } catch (error) {
        try {
          request.transaction?.abort()
        } catch {
          reject(error)
        }
      }
    }
    request.onblocked = () => {
      if (!settled) {
        settled = true
        reject(createStorageError('BlockedError', 'IndexedDB upgrade was blocked'))
      }
    }
    request.onerror = () => {
      if (!settled) {
        settled = true
        reject(request.error ?? createStorageError('UnknownError', 'IndexedDB open failed'))
      }
    }
    request.onsuccess = () => {
      if (settled) {
        request.result.close()
        return
      }
      settled = true
      const database = request.result
      database.onversionchange = () => database.close()
      resolve(database)
    }
  })
}

function runTransaction(database, mode, execute) {
  return new Promise((resolve, reject) => {
    let transaction
    let result
    let failure = null
    let settled = false

    function rejectOnce(error) {
      if (settled) return
      settled = true
      reject(error)
    }

    try {
      transaction = database.transaction(RUN_STORE_NAME, mode)
      const store = transaction.objectStore(RUN_STORE_NAME)
      execute({
        store,
        setResult(value) {
          result = value
        },
        fail(error) {
          failure = error
          try {
            transaction.abort()
          } catch {
            rejectOnce(error)
          }
        },
      })
    } catch (error) {
      reject(error)
      return
    }

    transaction.oncomplete = () => {
      if (settled) return
      settled = true
      if (failure) {
        reject(failure)
      } else {
        resolve(result)
      }
    }
    transaction.onerror = () => {
      rejectOnce(failure ?? transaction.error ?? createStorageError(
        'UnknownError',
        'IndexedDB transaction failed',
      ))
    }
    transaction.onabort = () => {
      rejectOnce(failure ?? transaction.error ?? createStorageError(
        'AbortError',
        'IndexedDB transaction was aborted',
      ))
    }
  })
}

function observeRequest(request, onSuccess, fail) {
  request.onsuccess = () => {
    try {
      onSuccess(request.result)
    } catch (error) {
      fail(error)
    }
  }
  request.onerror = () => {
    fail(request.error ?? createStorageError('UnknownError', 'IndexedDB request failed'))
  }
}

export function createRunRepository({
  indexedDB = defaultIndexedDB(),
  now = () => new Date(),
} = {}) {
  if (typeof now !== 'function') {
    throw new TypeError('now must be a function')
  }

  let database = null
  let opening = null

  async function getDatabase() {
    if (database) return database
    if (!opening) {
      opening = openDatabase(indexedDB)
        .then((opened) => {
          database = opened
          return opened
        })
        .catch((error) => {
          opening = null
          throw error
        })
    }
    return opening
  }

  async function load() {
    let db
    try {
      db = await getDatabase()
    } catch (error) {
      return storageUnavailable('load', error)
    }

    try {
      return await runTransaction(db, 'readwrite', ({ store, setResult, fail }) => {
        let active
        let quarantine
        let activeReady = false
        let quarantineReady = false

        function finish() {
          if (!activeReady || !quarantineReady) return
          if (active === undefined) {
            if (quarantine === undefined) {
              setResult(deepFreeze({ status: 'empty' }))
              return
            }
            const reason = typeof quarantine?.reason === 'string'
              ? quarantine.reason
              : 'invalid-save'
            setResult(deepFreeze({
              status: 'recovery-required',
              reason,
              message: recoveryMessage(reason),
            }))
            return
          }

          try {
            const sourceVersion = active?.saveSchemaVersion
            const save = migrateRunSave(active)
            const match = restoreRunSave(save)
            if (sourceVersion !== save.saveSchemaVersion) {
              store.put(save, ACTIVE_RUN_KEY)
            }
            if (quarantine !== undefined) {
              store.delete(QUARANTINED_RUN_KEY)
            }
            setResult(deepFreeze({
              status: 'resumable',
              savedAt: save.savedAt,
              migratedFrom: sourceVersion === save.saveSchemaVersion ? null : sourceVersion,
              match,
            }))
          } catch (error) {
            const reason = recoveryReason(error)
            store.put({
              quarantinedAt: timestampFromClock(now),
              reason,
              record: active,
            }, QUARANTINED_RUN_KEY)
            store.delete(ACTIVE_RUN_KEY)
            setResult(deepFreeze({
              status: 'recovery-required',
              reason,
              message: recoveryMessage(reason),
            }))
          }
        }

        observeRequest(store.get(ACTIVE_RUN_KEY), (value) => {
          active = value
          activeReady = true
          finish()
        }, fail)
        observeRequest(store.get(QUARANTINED_RUN_KEY), (value) => {
          quarantine = value
          quarantineReady = true
          finish()
        }, fail)
      })
    } catch (error) {
      return storageUnavailable('load', error)
    }
  }

  async function write(match, options = {}) {
    if (
      options === null
      || typeof options !== 'object'
      || Array.isArray(options)
      || Object.keys(options).some((key) => key !== 'savedAt')
    ) {
      throw new TypeError('options may contain only savedAt')
    }
    const savedAt = Object.hasOwn(options, 'savedAt')
      ? options.savedAt
      : timestampFromClock(now)
    const save = createRunSave(match, { savedAt })

    let db
    try {
      db = await getDatabase()
    } catch (error) {
      return storageUnavailable('save', error)
    }

    try {
      await runTransaction(db, 'readwrite', ({ store, setResult }) => {
        store.put(save, ACTIVE_RUN_KEY)
        store.delete(QUARANTINED_RUN_KEY)
        setResult(null)
      })
      return deepFreeze({ status: 'saved', savedAt: save.savedAt })
    } catch (error) {
      return storageUnavailable('save', error)
    }
  }

  async function discard() {
    let db
    try {
      db = await getDatabase()
    } catch (error) {
      return storageUnavailable('discard', error)
    }

    try {
      await runTransaction(db, 'readwrite', ({ store, setResult }) => {
        store.delete(ACTIVE_RUN_KEY)
        store.delete(QUARANTINED_RUN_KEY)
        setResult(null)
      })
      return deepFreeze({ status: 'discarded' })
    } catch (error) {
      return storageUnavailable('discard', error)
    }
  }

  function close() {
    database?.close()
    database = null
    opening = null
  }

  return Object.freeze({
    load,
    save: write,
    replace: write,
    discard,
    close,
  })
}

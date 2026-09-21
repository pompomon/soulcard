import {
  pauseMatch,
  resumeMatch,
  revealOrContinue as resolveClash,
  validateMatchState,
} from '../domain/match-machine.js'

const RESTORE_STATUSES = new Set([
  'empty',
  'resumable',
  'recovery-required',
  'storage-unavailable',
])

function assertRepository(repository) {
  if (
    repository === null
    || typeof repository !== 'object'
    || typeof repository.load !== 'function'
    || typeof repository.save !== 'function'
    || (repository.close !== undefined && typeof repository.close !== 'function')
  ) {
    throw new TypeError('repository must implement load, save, and optional close methods')
  }
}

function storageFailure(operation, error) {
  return Object.freeze({
    status: 'storage-unavailable',
    operation,
    reason: error?.name === 'QuotaExceededError' ? 'quota-exceeded' : 'storage-error',
  })
}

export function createRunController({
  repository,
  initialMatch = null,
  onSubscriberError = (error) => globalThis.reportError?.(error),
} = {}) {
  assertRepository(repository)
  if (typeof onSubscriberError !== 'function') {
    throw new TypeError('onSubscriberError must be a function')
  }
  if (initialMatch !== null) {
    validateMatchState(initialMatch)
  }

  let match = initialMatch
  let revision = 0
  let restoreStatus = 'idle'
  let restoreReason = null
  let restoreMessage = null
  let saveStatus = initialMatch === null ? 'idle' : 'unsaved'
  let savedAt = null
  let saveReason = null
  let restorePromise = null
  let writeTail = Promise.resolve()
  let latestSaveSequence = 0
  let destroyed = false
  let destroyPromise = null
  const listeners = new Set()

  function assertActive() {
    if (destroyed) {
      throw new Error('Run controller has been destroyed')
    }
  }

  function getSnapshot() {
    return Object.freeze({
      match,
      restoreStatus,
      restoreReason,
      restoreMessage,
      saveStatus,
      savedAt,
      saveReason,
    })
  }

  function publish() {
    const snapshot = getSnapshot()
    for (const listener of [...listeners]) {
      try {
        listener(snapshot)
      } catch (error) {
        try {
          onSubscriberError(error)
        } catch {}
      }
    }
  }

  function markMatch(nextMatch) {
    validateMatchState(nextMatch)
    match = nextMatch
    revision += 1
    saveStatus = 'unsaved'
    saveReason = null
    publish()
    return match
  }

  function normalizeSaveResult(result) {
    if (
      result !== null
      && typeof result === 'object'
      && (result.status === 'saved' || result.status === 'storage-unavailable')
    ) {
      return result
    }
    return storageFailure('save', new TypeError('repository.save returned an invalid result'))
  }

  function queueSave(snapshot) {
    const saveRevision = revision
    const sequence = latestSaveSequence + 1
    latestSaveSequence = sequence
    saveStatus = 'saving'
    saveReason = null
    publish()

    const operation = writeTail
      .then(() => repository.save(snapshot))
      .then(normalizeSaveResult)
      .catch((error) => storageFailure('save', error))

    const finalized = operation.then((result) => {
      if (sequence === latestSaveSequence && saveRevision === revision && !destroyed) {
        if (result.status === 'saved') {
          saveStatus = 'saved'
          savedAt = result.savedAt
          saveReason = null
        } else {
          saveStatus = 'failed'
          saveReason = result.reason
        }
        publish()
      }
      return result
    })
    writeTail = finalized.then(() => undefined)
    return finalized
  }

  function saveStable() {
    assertActive()
    if (match === null) {
      return Promise.resolve(Object.freeze({
        status: 'skipped',
        reason: 'no-active-run',
      }))
    }
    validateMatchState(match)
    return queueSave(match)
  }

  function restore() {
    assertActive()
    if (restorePromise) return restorePromise

    const restoreRevision = revision
    restoreStatus = 'loading'
    restoreReason = null
    restoreMessage = null
    publish()

    restorePromise = Promise.resolve()
      .then(() => repository.load())
      .catch((error) => storageFailure('load', error))
      .then((result) => {
        if (
          result === null
          || typeof result !== 'object'
          || !RESTORE_STATUSES.has(result.status)
        ) {
          result = storageFailure(
            'load',
            new TypeError('repository.load returned an invalid result'),
          )
        }

        restoreStatus = result.status
        restoreReason = result.reason ?? null
        restoreMessage = result.message ?? null
        if (result.status === 'resumable') {
          validateMatchState(result.match)
          if (restoreRevision === revision) {
            match = result.match
            revision += 1
            saveStatus = 'saved'
            savedAt = result.savedAt
            saveReason = null
          }
        } else if (result.status === 'empty' && restoreRevision === revision) {
          match = null
          saveStatus = 'idle'
          savedAt = null
          saveReason = null
        }
        publish()
        return result
      })
      .catch((error) => {
        const failure = storageFailure('load', error)
        restoreStatus = failure.status
        restoreReason = failure.reason
        restoreMessage = null
        if (!destroyed) publish()
        return failure
      })
      .finally(() => {
        restorePromise = null
      })

    return restorePromise
  }

  function setMatch(nextMatch) {
    assertActive()
    return markMatch(nextMatch)
  }

  function discardPendingRestore() {
    assertActive()
    if (restoreStatus === 'loading') {
      revision += 1
    }
  }

  function revealOrContinue() {
    assertActive()
    if (match === null) {
      throw new Error('No active match is available')
    }
    const transition = resolveClash(match)
    markMatch(transition.match)
    const save = queueSave(transition.match)
    return save.then((saveResult) => Object.freeze({
      match: transition.match,
      event: transition.event,
      save: saveResult,
    }))
  }

  function pause() {
    assertActive()
    if (match === null) {
      throw new Error('No active match is available')
    }
    const paused = pauseMatch(match)
    markMatch(paused)
    const save = queueSave(paused)
    return save.then((saveResult) => Object.freeze({
      match: paused,
      save: saveResult,
    }))
  }

  function resume() {
    assertActive()
    if (match === null) {
      throw new Error('No active match is available')
    }
    return markMatch(resumeMatch(match))
  }

  function subscribe(listener) {
    assertActive()
    if (typeof listener !== 'function') {
      throw new TypeError('listener must be a function')
    }
    listeners.add(listener)
    try {
      listener(getSnapshot())
    } catch (error) {
      listeners.delete(listener)
      throw error
    }
    return () => {
      listeners.delete(listener)
    }
  }

  function whenIdle() {
    return writeTail
  }

  function destroy() {
    if (destroyPromise) return destroyPromise
    destroyed = true
    listeners.clear()
    destroyPromise = Promise.allSettled([
      writeTail,
      restorePromise ?? Promise.resolve(),
    ]).then(() => {
      repository.close?.()
    })
    return destroyPromise
  }

  return Object.freeze({
    getSnapshot,
    subscribe,
    restore,
    setMatch,
    discardPendingRestore,
    revealOrContinue,
    pause,
    resume,
    saveStable,
    whenIdle,
    destroy,
    get currentMatch() {
      return match
    },
  })
}

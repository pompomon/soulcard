import { revealOrContinue as resolveClash } from '../domain/match-machine.js'
import {
  captureCampaignHold,
  chooseCampaignReveal,
  claimCampaignReward,
  prepareCampaignReveal,
  retryCampaignEncounter,
} from '../domain/campaign-machine.js'
import {
  isCampaignState,
  pauseRun,
  resumeRun,
  validateRunState,
} from '../domain/run-state.js'
import {
  createAiController,
  REVEAL_OR_CONTINUE_ACTION,
} from '../domain/ai-controller.js'

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
    || (repository.discard !== undefined && typeof repository.discard !== 'function')
    || (repository.close !== undefined && typeof repository.close !== 'function')
  ) {
    throw new TypeError(
      'repository must implement load, save, and optional discard and close methods',
    )
  }
}

function assertAiController(aiController) {
  if (
    aiController === null
    || typeof aiController !== 'object'
    || typeof aiController.chooseEncounterAction !== 'function'
  ) {
    throw new TypeError('aiController must expose chooseEncounterAction')
  }
}

function validateEncounterAction(action) {
  if (action !== REVEAL_OR_CONTINUE_ACTION) {
    throw new Error('aiController returned an unsupported encounter action')
  }
}

function immutableClone(value) {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(immutableClone))
  }
  if (value !== null && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, immutableClone(child)]),
    ))
  }
  return value
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
  aiController = createAiController(),
  onSubscriberError = (error) => globalThis.reportError?.(error),
} = {}) {
  assertRepository(repository)
  assertAiController(aiController)
  if (typeof onSubscriberError !== 'function') {
    throw new TypeError('onSubscriberError must be a function')
  }
  if (initialMatch !== null) {
    validateRunState(initialMatch)
  }

  let match = initialMatch === null ? null : immutableClone(initialMatch)
  let revision = 0
  let restoreStatus = 'idle'
  let restoreReason = null
  let restoreMessage = null
  let saveStatus = initialMatch === null ? 'idle' : 'unsaved'
  let savedAt = null
  let saveReason = null
  let discardStatus = 'idle'
  let discardReason = null
  let restorePromise = null
  let discardPromise = null
  let writeTail = Promise.resolve()
  let latestSaveSequence = 0
  let destroyed = false
  let destroyPromise = null
  const listeners = new Set()
  const saveListeners = new Set()

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
      discardStatus,
      discardReason,
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
    validateRunState(nextMatch)
    match = nextMatch
    revision += 1
    restoreStatus = 'current'
    restoreReason = null
    restoreMessage = null
    saveStatus = 'unsaved'
    savedAt = null
    saveReason = null
    discardStatus = 'idle'
    discardReason = null
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

  function normalizeDiscardResult(result) {
    if (
      result !== null
      && typeof result === 'object'
      && (result.status === 'discarded' || result.status === 'storage-unavailable')
    ) {
      return result
    }
    return storageFailure(
      'discard',
      new TypeError('repository.discard returned an invalid result'),
    )
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
      const completion = Object.freeze({ match: snapshot, result })
      for (const listener of [...saveListeners]) {
        try {
          listener(completion)
        } catch (error) {
          try {
            onSubscriberError(error)
          } catch {}
        }
      }
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
    validateRunState(match)
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

        if (restoreRevision !== revision || destroyed) {
          return result
        }
        restoreStatus = result.status
        restoreReason = result.reason ?? null
        restoreMessage = result.message ?? null
        if (result.status === 'resumable') {
          validateRunState(result.match)
          match = immutableClone(result.match)
          revision += 1
          saveStatus = 'saved'
          savedAt = result.savedAt
          saveReason = null
        } else if (result.status === 'empty') {
          match = null
          saveStatus = 'idle'
          savedAt = null
          saveReason = null
        }
        discardStatus = 'idle'
        discardReason = null
        publish()
        return result
      })
      .catch((error) => {
        const failure = storageFailure('load', error)
        if (restoreRevision === revision && !destroyed) {
          restoreStatus = failure.status
          restoreReason = failure.reason
          restoreMessage = null
          discardStatus = 'idle'
          discardReason = null
          publish()
        }
        return failure
      })
      .finally(() => {
        restorePromise = null
      })

    return restorePromise
  }

  function discardRecovery() {
    assertActive()
    if (restoreStatus !== 'recovery-required') {
      throw new Error('No recoverable saved run is available to discard')
    }
    if (discardPromise) return discardPromise

    revision += 1
    latestSaveSequence += 1
    const discardRevision = revision
    discardStatus = 'discarding'
    discardReason = null
    publish()

    const operation = writeTail
      .then(() => {
        if (typeof repository.discard !== 'function') {
          return storageFailure(
            'discard',
            new TypeError('repository.discard is unavailable'),
          )
        }
        return repository.discard()
      })
      .then(normalizeDiscardResult)
      .catch((error) => storageFailure('discard', error))

    discardPromise = operation.then((result) => {
      if (discardRevision === revision && !destroyed) {
        if (result.status === 'discarded') {
          match = null
          restoreStatus = 'empty'
          restoreReason = null
          restoreMessage = null
          saveStatus = 'idle'
          savedAt = null
          saveReason = null
          discardStatus = 'discarded'
          discardReason = null
        } else {
          discardStatus = 'failed'
          discardReason = result.reason
        }
        publish()
      }
      return result
    }).finally(() => {
      discardPromise = null
    })
    writeTail = discardPromise.then(() => undefined)
    return discardPromise
  }

  function setMatch(nextMatch) {
    assertActive()
    validateRunState(nextMatch)
    return markMatch(immutableClone(nextMatch))
  }

  function discardPendingRestore() {
    assertActive()
    if (restoreStatus === 'loading') {
      revision += 1
    }
  }

  function revealOrContinue({ autoChooseNormal = false } = {}) {
    assertActive()
    if (typeof autoChooseNormal !== 'boolean') {
      throw new TypeError('autoChooseNormal must be a boolean')
    }
    if (match === null) {
      throw new Error('No active match is available')
    }
    if (match.machineState === 'ended') {
      throw new Error('An ended match cannot reveal or continue')
    }
    if (match.machineState === 'paused') {
      throw new Error('A paused match cannot reveal or continue')
    }
    const currentMatch = match
    if (isCampaignState(currentMatch)) {
      const transition = prepareCampaignReveal(currentMatch)
      markMatch(transition.match)
      const preparedRevision = revision
      const preparedSave = queueSave(transition.match)
      return preparedSave.then((saveResult) => {
        if (
          !autoChooseNormal
          || transition.event !== null
          || transition.match.machineState !== 'awaitingHoldChoice'
          || saveResult.status !== 'saved'
        ) {
          return Object.freeze({
            match: transition.match,
            event: transition.event,
            save: saveResult,
          })
        }
        if (destroyed || revision !== preparedRevision || match !== transition.match) {
          throw new Error('Run changed while saving its Hold decision')
        }
        const choice = transition.match.holdChoice.candidate === null ? 'hold' : 'normal'
        const resolved = chooseCampaignReveal(transition.match, choice)
        markMatch(resolved.match)
        return queueSave(resolved.match).then((resolvedSave) => Object.freeze({
          match: resolved.match,
          event: resolved.event,
          save: resolvedSave,
        }))
      })
    }

    const currentRevision = revision
    validateEncounterAction(aiController.chooseEncounterAction(immutableClone(currentMatch)))
    if (destroyed || revision !== currentRevision) {
      throw new Error('Run changed while choosing an encounter action')
    }
    const transition = resolveClash(currentMatch)
    markMatch(transition.match)
    const save = queueSave(transition.match)
    return save.then((saveResult) => Object.freeze({
      match: transition.match,
      event: transition.event,
      save: saveResult,
    }))
  }

  function chooseHoldChoice(choice) {
    assertActive()
    if (match === null || !isCampaignState(match)) {
      throw new Error('No active campaign is available')
    }
    const transition = chooseCampaignReveal(match, choice)
    markMatch(transition.match)
    const save = queueSave(transition.match)
    return save.then((saveResult) => Object.freeze({
      match: transition.match,
      event: transition.event,
      save: saveResult,
    }))
  }

  function captureHold(instanceId) {
    assertActive()
    if (match === null || !isCampaignState(match)) {
      throw new Error('No active campaign is available')
    }
    const nextMatch = captureCampaignHold(match, instanceId)
    markMatch(nextMatch)
    const save = queueSave(nextMatch)
    return save.then((saveResult) => Object.freeze({
      match: nextMatch,
      save: saveResult,
    }))
  }

  function retryEncounter() {
    assertActive()
    if (match === null || !isCampaignState(match)) {
      throw new Error('No active campaign is available')
    }
    const nextMatch = retryCampaignEncounter(match)
    markMatch(nextMatch)
    const save = queueSave(nextMatch)
    return save.then((saveResult) => Object.freeze({
      match: nextMatch,
      save: saveResult,
    }))
  }

  function claimReward() {
    assertActive()
    if (match === null || !isCampaignState(match)) {
      throw new Error('No active campaign is available')
    }
    const nextMatch = claimCampaignReward(match)
    markMatch(nextMatch)
    const save = queueSave(nextMatch)
    return save.then((saveResult) => Object.freeze({
      match: nextMatch,
      save: saveResult,
    }))
  }

  function pause() {
    assertActive()
    if (match === null) {
      throw new Error('No active match is available')
    }
    const paused = pauseRun(match)
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
    return markMatch(resumeRun(match))
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

  function subscribeToSaves(listener) {
    assertActive()
    if (typeof listener !== 'function') {
      throw new TypeError('save listener must be a function')
    }
    saveListeners.add(listener)
    return () => {
      saveListeners.delete(listener)
    }
  }

  function whenIdle() {
    return writeTail
  }

  function destroy() {
    if (destroyPromise) return destroyPromise
    destroyed = true
    listeners.clear()
    saveListeners.clear()
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
    subscribeToSaves,
    restore,
    discardRecovery,
    setMatch,
    discardPendingRestore,
    revealOrContinue,
    chooseHoldChoice,
    captureHold,
    retryEncounter,
    claimReward,
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

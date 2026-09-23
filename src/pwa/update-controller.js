export const ACTIVATE_UPDATE_MESSAGE = 'SOULCARD_ACTIVATE_UPDATE'

const UPDATE_STATUSES = new Set([
  'current',
  'available',
  'preparing',
  'activating',
  'failed',
])

function canObserve(target) {
  return (
    target !== null
    && typeof target === 'object'
    && typeof target.addEventListener === 'function'
    && typeof target.removeEventListener === 'function'
  )
}

function createSnapshot(status, reason = null, canActivate = false) {
  if (!UPDATE_STATUSES.has(status)) {
    throw new TypeError(`Unknown update status: ${String(status)}`)
  }
  return Object.freeze({ status, reason, canActivate })
}

function failureReason(error, fallback) {
  return typeof error?.reason === 'string' && error.reason.length > 0
    ? error.reason
    : fallback
}

export function createUpdateController({
  production = import.meta.env?.PROD === true,
  navigatorObject = globalThis.navigator,
  windowObject = globalThis.window,
  documentObject = globalThis.document,
  prepareForActivation = async () => undefined,
  serviceWorkerUrl = './sw.js',
  onSubscriberError = (error) => globalThis.reportError?.(error),
} = {}) {
  if (typeof production !== 'boolean') {
    throw new TypeError('production must be a boolean')
  }
  if (typeof prepareForActivation !== 'function') {
    throw new TypeError('prepareForActivation must be a function')
  }
  if (typeof serviceWorkerUrl !== 'string' || serviceWorkerUrl.length === 0) {
    throw new TypeError('serviceWorkerUrl must be a nonempty string')
  }
  if (typeof onSubscriberError !== 'function') {
    throw new TypeError('onSubscriberError must be a function')
  }

  const subscribers = new Set()
  const serviceWorkers = navigatorObject?.serviceWorker
  let snapshot = createSnapshot('current')
  let registration = null
  let waitingWorker = null
  let requestedWorker = null
  let registrationStarted = false
  let destroyed = false
  let reloaded = false
  let activationPromise = null
  let removeLoadListener = () => {}
  let removeUpdateFoundListener = () => {}
  let removeInstallingListener = () => {}
  let removeActivationListener = () => {}
  let resolveReady
  let readySettled = false
  const ready = new Promise((resolve) => {
    resolveReady = resolve
  })

  function settleReady(result) {
    if (readySettled) return
    readySettled = true
    resolveReady(Object.freeze(result))
  }

  function publish(nextSnapshot) {
    snapshot = nextSnapshot
    for (const subscriber of [...subscribers]) {
      try {
        subscriber(snapshot)
      } catch (error) {
        try {
          onSubscriberError(error)
        } catch {}
      }
    }
  }

  function setStatus(status, reason = null, canActivate = false) {
    if (!destroyed) publish(createSnapshot(status, reason, canActivate))
  }

  function isWaitingWorker(worker) {
    return (
      worker !== null
      && typeof worker === 'object'
      && typeof worker.postMessage === 'function'
      && worker.state !== 'redundant'
    )
  }

  function latestWaitingWorker(excludedWorker = null) {
    for (const worker of [registration?.waiting, waitingWorker]) {
      if (worker !== excludedWorker && isWaitingWorker(worker)) return worker
    }
    return null
  }

  function offerUpdate(worker) {
    if (destroyed || !isWaitingWorker(worker)) return
    waitingWorker = worker
    if (snapshot.status === 'preparing' || snapshot.status === 'activating') return
    if (waitingWorker === worker && snapshot.status === 'available') return
    setStatus('available', null, true)
  }

  function watchInstallingWorker(worker) {
    removeInstallingListener()
    removeInstallingListener = () => {}
    if (!canObserve(worker)) return

    const handleStateChange = () => {
      if (worker.state === 'installed') {
        if (serviceWorkers.controller) {
          offerUpdate(registration?.waiting ?? worker)
        }
        removeInstallingListener()
        removeInstallingListener = () => {}
      } else if (worker.state === 'redundant') {
        removeInstallingListener()
        removeInstallingListener = () => {}
      }
    }
    worker.addEventListener('statechange', handleStateChange)
    removeInstallingListener = () => worker.removeEventListener('statechange', handleStateChange)
    handleStateChange()
  }

  function watchRegistration(nextRegistration) {
    registration = nextRegistration
    if (canObserve(registration)) {
      const handleUpdateFound = () => watchInstallingWorker(registration.installing)
      registration.addEventListener('updatefound', handleUpdateFound)
      removeUpdateFoundListener = () => {
        registration?.removeEventListener('updatefound', handleUpdateFound)
      }
    }
    if (registration.waiting && serviceWorkers.controller) {
      offerUpdate(registration.waiting)
    }
    if (registration.installing) {
      watchInstallingWorker(registration.installing)
    }
  }

  function startRegistration() {
    if (registrationStarted || destroyed) return
    registrationStarted = true
    removeLoadListener()
    removeLoadListener = () => {}

    let registrationResult
    try {
      registrationResult = serviceWorkers.register(serviceWorkerUrl)
    } catch (error) {
      setStatus('failed', failureReason(error, 'registration-failed'), false)
      settleReady({ status: 'registration-failed' })
      return
    }
    Promise.resolve(registrationResult)
      .then((nextRegistration) => {
        if (destroyed) {
          settleReady({ status: 'destroyed' })
          return
        }
        if (nextRegistration === null || typeof nextRegistration !== 'object') {
          throw new TypeError('Service worker registration returned an invalid result')
        }
        watchRegistration(nextRegistration)
        settleReady({ status: 'registered' })
      })
      .catch((error) => {
        setStatus('failed', failureReason(error, 'registration-failed'), false)
        settleReady({ status: 'registration-failed' })
      })
  }

  function reloadAfterActivation() {
    if (destroyed || reloaded || requestedWorker?.state !== 'activated') return
    reloaded = true
    removeActivationListener()
    removeActivationListener = () => {}
    windowObject?.location?.reload?.()
  }

  function watchRequestedWorker(worker) {
    removeActivationListener()
    removeActivationListener = () => {}
    requestedWorker = worker

    if (canObserve(worker)) {
      const handleStateChange = () => {
        if (worker.state === 'activated') {
          reloadAfterActivation()
        } else if (worker.state === 'redundant') {
          removeActivationListener()
          removeActivationListener = () => {}
          requestedWorker = null
          activationPromise = null
          const replacement = latestWaitingWorker(worker)
          waitingWorker = replacement
          if (replacement) {
            setStatus('available', null, true)
          } else {
            setStatus('failed', 'activation-failed', false)
          }
        }
      }
      worker.addEventListener('statechange', handleStateChange)
      removeActivationListener = () => worker.removeEventListener('statechange', handleStateChange)
    }
    reloadAfterActivation()
  }

  function requestActivation() {
    if (activationPromise) return activationPromise
    if (destroyed) {
      return Promise.resolve(Object.freeze({ status: 'skipped', reason: 'destroyed' }))
    }
    if (latestWaitingWorker() === null) {
      return Promise.resolve(Object.freeze({ status: 'skipped', reason: 'no-update' }))
    }

    setStatus('preparing', null, false)
    activationPromise = Promise.resolve()
      .then(() => prepareForActivation())
      .then((result) => {
        if (destroyed) {
          return Object.freeze({ status: 'skipped', reason: 'destroyed' })
        }
        if (result === false || result?.status === 'failed') {
          const error = new Error('Update preparation failed')
          error.reason = result?.reason ?? 'preparation-failed'
          throw error
        }

        const targetWorker = latestWaitingWorker()
        if (targetWorker === null) {
          const error = new Error('The waiting update is no longer available')
          error.reason = 'no-update'
          throw error
        }
        waitingWorker = targetWorker
        setStatus('activating', null, false)
        watchRequestedWorker(targetWorker)
        targetWorker.postMessage(Object.freeze({ type: ACTIVATE_UPDATE_MESSAGE }))
        reloadAfterActivation()
        return Object.freeze({ status: 'activating', reason: null })
      })
      .catch((error) => {
        removeActivationListener()
        removeActivationListener = () => {}
        requestedWorker = null
        activationPromise = null
        waitingWorker = latestWaitingWorker()
        setStatus(
          'failed',
          failureReason(error, 'activation-failed'),
          waitingWorker !== null,
        )
        return Object.freeze({
          status: 'failed',
          reason: failureReason(error, 'activation-failed'),
        })
      })
    return activationPromise
  }

  function subscribe(subscriber) {
    if (destroyed) {
      throw new Error('Update controller has been destroyed')
    }
    if (typeof subscriber !== 'function') {
      throw new TypeError('subscriber must be a function')
    }
    subscribers.add(subscriber)
    try {
      subscriber(snapshot)
    } catch (error) {
      subscribers.delete(subscriber)
      throw error
    }
    return () => subscribers.delete(subscriber)
  }

  function destroy() {
    if (destroyed) return
    destroyed = true
    removeLoadListener()
    removeUpdateFoundListener()
    removeInstallingListener()
    removeActivationListener()
    subscribers.clear()
    settleReady({ status: 'destroyed' })
  }

  if (!production || !serviceWorkers || typeof serviceWorkers.register !== 'function') {
    settleReady({ status: production ? 'unsupported' : 'disabled' })
  } else if (documentObject?.readyState === 'complete' || !canObserve(windowObject)) {
    startRegistration()
  } else {
    const handleLoad = () => startRegistration()
    windowObject.addEventListener('load', handleLoad, { once: true })
    removeLoadListener = () => windowObject.removeEventListener('load', handleLoad)
  }

  return Object.freeze({
    ready,
    getSnapshot: () => snapshot,
    subscribe,
    requestActivation,
    destroy,
  })
}

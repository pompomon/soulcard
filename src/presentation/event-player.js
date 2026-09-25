import { compareCards } from '../domain/cards.js'
import { validateCommittedEvent } from '../domain/events.js'
import { runVisualKey, validateRunState } from '../domain/run-state.js'

export const EVENT_PRESENTATION_TIMING = Object.freeze({
  revealMs: 400,
  settlementMs: 600,
  burnMs: 200,
})

const FALLBACK_MOTION_SETTINGS = Object.freeze({
  animationSpeed: 1,
  reducedMotion: false,
})

function assertAdapter(adapter) {
  if (
    adapter === null
    || typeof adapter !== 'object'
    || typeof adapter.syncSnapshot !== 'function'
    || typeof adapter.applyStep !== 'function'
  ) {
    throw new TypeError('adapter must expose syncSnapshot and applyStep')
  }
  for (const method of ['beginEvent', 'cancelEvent', 'setPaused']) {
    if (adapter[method] !== undefined && typeof adapter[method] !== 'function') {
      throw new TypeError(`adapter.${method} must be a function`)
    }
  }
}

function assertSettingsController(settingsController) {
  if (
    settingsController !== undefined
    && (
      settingsController === null
      || typeof settingsController !== 'object'
      || typeof settingsController.getSnapshot !== 'function'
      || typeof settingsController.subscribe !== 'function'
    )
  ) {
    throw new TypeError('settingsController must expose getSnapshot and subscribe')
  }
}

function assertMotionSettings(settings) {
  if (
    settings === null
    || typeof settings !== 'object'
    || !Number.isFinite(settings.animationSpeed)
    || settings.animationSpeed <= 0
    || typeof settings.reducedMotion !== 'boolean'
  ) {
    throw new TypeError('motion settings must contain animationSpeed and reducedMotion')
  }
}

function assertTimingProfile(timing) {
  if (
    timing === null
    || typeof timing !== 'object'
    || Array.isArray(timing)
    || Object.keys(timing).length !== 3
    || !['revealMs', 'settlementMs', 'burnMs'].every((key) => (
      Object.hasOwn(timing, key)
      && Number.isFinite(timing[key])
      && timing[key] >= 0
    ))
  ) {
    throw new TypeError('timing must contain nonnegative revealMs, settlementMs, and burnMs')
  }
}

function assertClock(clock) {
  if (
    clock === null
    || typeof clock !== 'object'
    || typeof clock.now !== 'function'
    || typeof clock.setTimeout !== 'function'
    || typeof clock.clearTimeout !== 'function'
  ) {
    throw new TypeError('clock must expose now, setTimeout, and clearTimeout')
  }
}

function defaultClock() {
  return {
    now: () => globalThis.performance?.now?.() ?? Date.now(),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  }
}

function cloneData(value) {
  if (Array.isArray(value)) return value.map(cloneData)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, cloneData(child)]),
    )
  }
  return value
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function detachMatch(match) {
  validateRunState(match)
  const detached = cloneData(match)
  validateRunState(detached)
  return deepFreeze(detached)
}

function eventKey(match) {
  return JSON.stringify([match.runId, match.pendingEvent.id])
}

function snapshotKey(match) {
  return JSON.stringify([
    match.runId,
    match.turn,
    match.machineState,
    match.pendingEvent?.id ?? null,
    match.stateFingerprint ?? null,
  ])
}

function roundIsTied(reveals, round) {
  const first = reveals[round * 2]
  const second = reveals[round * 2 + 1]
  return second !== undefined && compareCards(first.cardId, second.cardId) === 0
}

export function createEventTimeline(event, timing = EVENT_PRESENTATION_TIMING) {
  validateCommittedEvent(event)
  assertTimingProfile(timing)

  const steps = event.reveals.map((reveal, index) => {
    const round = Math.floor(index / 2)
    return {
      kind: 'reveal',
      cardId: reveal.cardId,
      ...(reveal.instanceId === undefined
        ? {}
        : { instanceId: reveal.instanceId, visualKey: reveal.instanceId }),
      suppliedBy: reveal.suppliedBy,
      from: reveal.from ?? null,
      revealIndex: index,
      round,
      tied: roundIsTied(event.reveals, round),
      durationMs: timing.revealMs,
    }
  })

  if (event.type === 'clashSettled') {
    const transfers = new Map(
      event.transfers.map((transfer) => [runVisualKey(transfer), transfer]),
    )
    const burned = new Set(event.burned)
    const transferDuration = event.transfers.length === 0
      ? 0
      : timing.settlementMs / event.transfers.length

    for (const reveal of event.reveals) {
      const visualKey = runVisualKey(reveal)
      const transfer = transfers.get(visualKey)
      if (transfer) {
        steps.push({
          kind: 'transfer',
          cardId: reveal.cardId,
          ...(reveal.instanceId === undefined
            ? {}
            : { instanceId: reveal.instanceId, visualKey }),
          to: transfer.to,
          durationMs: transferDuration,
        })
      } else if (burned.has(visualKey)) {
        steps.push({
          kind: 'burn',
          cardId: reveal.cardId,
          ...(reveal.instanceId === undefined
            ? {}
            : { instanceId: reveal.instanceId, visualKey }),
          to: 'burnPile',
          durationMs: timing.burnMs,
        })
      }
    }
  } else {
    steps.push({
      kind: 'retain',
      reason: event.reason,
      cardIds: event.reveals.map(({ cardId }) => cardId),
      ...(event.eventVersion === 5
        ? { visualKeys: event.reveals.map(runVisualKey) }
        : {}),
      durationMs: 0,
    })
  }

  return deepFreeze(steps)
}

function createScaledDelay(baseDurationMs, initialSpeed, clock) {
  let remainingBaseMs = baseDurationMs
  let speed = initialSpeed
  let startedAt = null
  let timer = null
  let settled = false
  let resolvePromise
  const promise = new Promise((resolve) => {
    resolvePromise = resolve
  })

  function consumeElapsed() {
    if (startedAt === null) return
    const elapsed = Math.max(0, clock.now() - startedAt)
    remainingBaseMs = Math.max(0, remainingBaseMs - elapsed * speed)
    startedAt = null
  }

  function clearTimer() {
    if (timer !== null) {
      clock.clearTimeout(timer)
      timer = null
    }
  }

  function finish() {
    if (settled) return
    consumeElapsed()
    clearTimer()
    remainingBaseMs = 0
    settled = true
    resolvePromise()
  }

  function schedule() {
    if (settled || startedAt !== null) return
    if (remainingBaseMs <= 0) {
      finish()
      return
    }
    startedAt = clock.now()
    timer = clock.setTimeout(finish, remainingBaseMs / speed)
  }

  return {
    promise,
    pause() {
      if (settled) return
      consumeElapsed()
      clearTimer()
    },
    resume() {
      schedule()
    },
    setSpeed(nextSpeed) {
      if (settled || Object.is(speed, nextSpeed)) return
      const running = startedAt !== null
      consumeElapsed()
      clearTimer()
      speed = nextSpeed
      if (running) schedule()
    },
    finish,
  }
}

function immutableResult(status, eventId = null, reason = null) {
  return Object.freeze({ status, eventId, reason })
}

export function createEventPlayer({
  adapter,
  settingsController = undefined,
  timing = EVENT_PRESENTATION_TIMING,
  clock = defaultClock(),
  onStateChange = () => {},
  onError = (error) => globalThis.reportError?.(error),
} = {}) {
  assertAdapter(adapter)
  assertSettingsController(settingsController)
  assertTimingProfile(timing)
  assertClock(clock)
  if (typeof onStateChange !== 'function') {
    throw new TypeError('onStateChange must be a function')
  }
  if (typeof onError !== 'function') {
    throw new TypeError('onError must be a function')
  }

  let settings = settingsController?.getSnapshot() ?? FALLBACK_MOTION_SETTINGS
  assertMotionSettings(settings)
  let destroyed = false
  let paused = false
  let processing = false
  let currentJob = null
  let currentDelay = null
  let lastSnapshotKey = null
  let state = Object.freeze({
    status: 'idle',
    eventId: null,
    stepIndex: null,
    stepCount: 0,
    stepKind: null,
    reason: null,
  })
  const queue = []
  const jobs = new Map()
  const presented = new Set()
  const resumeWaiters = new Set()

  function reportError(error) {
    try {
      onError(error)
    } catch {}
  }

  function publish(values) {
    state = Object.freeze({
      status: values.status,
      eventId: values.eventId ?? null,
      stepIndex: values.stepIndex ?? null,
      stepCount: values.stepCount ?? 0,
      stepKind: values.stepKind ?? null,
      reason: values.reason ?? null,
    })
    try {
      onStateChange(state)
    } catch (error) {
      reportError(error)
    }
  }

  function wakeResumeWaiters() {
    for (const resolve of [...resumeWaiters]) resolve()
    resumeWaiters.clear()
  }

  function waitUntilPlayable(job) {
    if (!paused || job.skipReason !== null || job.cancelReason !== null || destroyed) {
      return Promise.resolve()
    }
    return new Promise((resolve) => resumeWaiters.add(resolve))
  }

  async function synchronize(match, reason, event = null) {
    await adapter.syncSnapshot(match, Object.freeze({ reason, event }))
    lastSnapshotKey = snapshotKey(match)
  }

  async function runJob(job) {
    const { match, event, key, steps } = job
    currentJob = job
    publish({
      status: paused ? 'paused' : 'playing',
      eventId: event.id,
      stepCount: steps.length,
    })

    try {
      await waitUntilPlayable(job)
      if (destroyed) job.cancelReason ??= 'destroyed'
      if (settings.reducedMotion) job.skipReason ??= 'reduced-motion'

      if (job.cancelReason === null && job.skipReason === null) {
        await adapter.beginEvent?.(event, match)
      }

      for (let index = 0; index < steps.length; index += 1) {
        await waitUntilPlayable(job)
        if (destroyed) job.cancelReason ??= 'destroyed'
        if (settings.reducedMotion) job.skipReason ??= 'reduced-motion'
        if (job.cancelReason !== null || job.skipReason !== null) break

        const step = steps[index]
        const durationMs = step.durationMs / settings.animationSpeed
        publish({
          status: 'playing',
          eventId: event.id,
          stepIndex: index,
          stepCount: steps.length,
          stepKind: step.kind,
        })
        await adapter.applyStep(step, Object.freeze({
          event,
          match,
          stepIndex: index,
          stepCount: steps.length,
          durationMs,
        }))

        currentDelay = createScaledDelay(step.durationMs, settings.animationSpeed, clock)
        if (!paused) currentDelay.resume()
        await currentDelay.promise
        currentDelay = null
      }

      const resultStatus = job.cancelReason !== null
        ? 'cancelled'
        : job.skipReason !== null
          ? 'skipped'
          : 'completed'
      const reason = job.cancelReason ?? job.skipReason
      if (!destroyed) {
        await synchronize(match, resultStatus, event)
      }
      presented.add(key)
      if (!destroyed) {
        publish({
          status: resultStatus,
          eventId: event.id,
          stepCount: steps.length,
          reason,
        })
      }
      return immutableResult(resultStatus, event.id, reason)
    } catch (error) {
      if (!destroyed) {
        try {
          adapter.cancelEvent?.('adapter-error')
        } catch (cancelError) {
          reportError(cancelError)
        }
      }
      let synchronized = false
      if (!destroyed) {
        try {
          await synchronize(match, 'adapter-error', event)
          synchronized = true
        } catch (syncError) {
          reportError(syncError)
        }
      }
      if (destroyed || synchronized) presented.add(key)
      reportError(error)
      if (!destroyed) {
        publish({
          status: 'failed',
          eventId: event.id,
          stepCount: steps.length,
          reason: 'adapter-error',
        })
      }
      return immutableResult('failed', event.id, 'adapter-error')
    } finally {
      currentDelay = null
      currentJob = null
    }
  }

  async function processQueue() {
    if (processing || destroyed) return
    processing = true
    try {
      while (queue.length > 0 && !destroyed) {
        const job = queue.shift()
        const result = await runJob(job)
        jobs.delete(job.key)
        job.resolve(result)
      }
    } finally {
      processing = false
      if (!destroyed && queue.length > 0) void processQueue()
    }
  }

  async function present(input) {
    if (destroyed) throw new Error('Event player has been destroyed')
    const match = detachMatch(input)
    if (match.pendingEvent === null) {
      const key = snapshotKey(match)
      if (key === lastSnapshotKey) return immutableResult('duplicate')
      try {
        await synchronize(match, 'snapshot')
        publish({ status: 'idle' })
        return immutableResult('synchronized')
      } catch (error) {
        reportError(error)
        publish({ status: 'failed', reason: 'adapter-error' })
        return immutableResult('failed', null, 'adapter-error')
      }
    }

    const key = eventKey(match)
    if (jobs.has(key)) return jobs.get(key).promise
    if (presented.has(key)) return immutableResult('duplicate', match.pendingEvent.id)

    const event = match.pendingEvent
    const steps = createEventTimeline(event, timing)
    let resolve
    const promise = new Promise((settle) => {
      resolve = settle
    })
    const job = {
      key,
      match,
      event,
      steps,
      promise,
      resolve,
      cancelReason: null,
      skipReason: settings.reducedMotion ? 'reduced-motion' : null,
    }
    jobs.set(key, job)
    queue.push(job)
    publish({
      status: 'queued',
      eventId: event.id,
      stepCount: steps.length,
    })
    void processQueue()
    return promise
  }

  function setPaused(nextPaused) {
    if (typeof nextPaused !== 'boolean') {
      throw new TypeError('paused must be a boolean')
    }
    if (destroyed || paused === nextPaused) return
    paused = nextPaused
    adapter.setPaused?.(paused)
    if (paused) {
      currentDelay?.pause()
      publish({
        ...state,
        status: currentJob === null ? 'paused' : 'paused',
      })
    } else {
      currentDelay?.resume()
      wakeResumeWaiters()
      publish({
        ...state,
        status: currentJob === null ? 'idle' : 'playing',
      })
      void processQueue()
    }
  }

  function cancel(reason = 'cancelled') {
    if (typeof reason !== 'string' || reason.length === 0) {
      throw new TypeError('cancel reason must be a nonempty string')
    }
    if (destroyed && reason !== 'destroyed') return

    if (currentJob !== null) {
      currentJob.cancelReason ??= reason
      currentDelay?.finish()
      try {
        adapter.cancelEvent?.(reason)
      } catch (error) {
        reportError(error)
      }
    }
    for (const job of queue.splice(0)) {
      jobs.delete(job.key)
      job.resolve(immutableResult('cancelled', job.event.id, reason))
    }
    wakeResumeWaiters()
  }

  const unsubscribeSettings = settingsController?.subscribe((nextSettings) => {
    assertMotionSettings(nextSettings)
    const wasReduced = settings.reducedMotion
    settings = nextSettings
    currentDelay?.setSpeed(settings.animationSpeed)
    if (!wasReduced && settings.reducedMotion && currentJob !== null) {
      currentJob.skipReason ??= 'reduced-motion'
      currentDelay?.finish()
      try {
        adapter.cancelEvent?.('reduced-motion')
      } catch (error) {
        reportError(error)
      }
      wakeResumeWaiters()
    }
  })
  adapter.setPaused?.(false)

  return Object.freeze({
    present,
    setPaused,
    cancel,
    destroy() {
      if (destroyed) return
      destroyed = true
      unsubscribeSettings?.()
      cancel('destroyed')
      publish({ status: 'destroyed' })
    },
    getState: () => state,
  })
}

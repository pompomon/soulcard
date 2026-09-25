const CONTINUING_PRESENTATION_STATUSES = new Set(['completed', 'skipped'])

export function createAutoRevealCoordinator({ runController } = {}) {
  if (
    runController === null
    || typeof runController !== 'object'
    || typeof runController.getSnapshot !== 'function'
    || typeof runController.revealOrContinue !== 'function'
  ) {
    throw new TypeError('runController must support automatic reveal coordination')
  }

  let generation = 0
  let destroyed = false

  return Object.freeze({
    continueAfterPresentation({
      active,
      enabled,
      saveSucceeded,
      presentationStatus,
      runId,
      eventId,
      blocked,
    }) {
      const requestGeneration = generation
      if (
        destroyed
        || !active
        || !enabled
        || !saveSucceeded
        || blocked
        || !CONTINUING_PRESENTATION_STATUSES.has(presentationStatus)
      ) {
        return Promise.resolve(null)
      }

      return Promise.resolve().then(() => {
        const match = runController.getSnapshot()?.match
        if (
          destroyed
          || generation !== requestGeneration
          || match?.runId !== runId
          || match.pendingEvent?.id !== eventId
          || match.status !== 'active'
          || match.machineState !== 'ready'
        ) {
          return null
        }
        return runController.revealOrContinue({ autoChooseNormal: true })
      })
    },
    stop() {
      generation += 1
    },
    destroy() {
      destroyed = true
      generation += 1
    },
  })
}

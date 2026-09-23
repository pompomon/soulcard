const BLOCKING_STATUSES = new Set(['preparing', 'activating'])

function assertUpdateController(updateController) {
  const methods = ['getSnapshot', 'subscribe', 'requestActivation']
  if (
    updateController === null
    || typeof updateController !== 'object'
    || methods.some((method) => typeof updateController[method] !== 'function')
  ) {
    throw new TypeError('updateController must implement the update controller interface')
  }
}

function noticeText(snapshot) {
  switch (snapshot.status) {
    case 'available':
      return 'An updated version of Soulcard is ready.'
    case 'preparing':
      return 'Saving your game before updating…'
    case 'activating':
      return 'Game saved. Activating the update…'
    case 'failed':
      return snapshot.canActivate
        ? `The update is waiting because saving or activation failed${snapshot.reason ? ` (${snapshot.reason})` : ''}. Try again.`
        : 'The update check failed. The current version remains available.'
    default:
      return ''
  }
}

export function createUpdateNotice({ updateController, host } = {}) {
  assertUpdateController(updateController)
  if (
    host === null
    || typeof host !== 'object'
    || typeof host.append !== 'function'
  ) {
    throw new TypeError('host must support append')
  }

  const underlyingContent = [...(host.children ?? [])]
  const priorInert = new Map(
    underlyingContent.map((element) => [element, element.inert === true]),
  )
  const element = document.createElement('aside')
  element.className = 'update-notice'
  element.dataset.updateNotice = ''
  element.hidden = true

  const status = document.createElement('p')
  status.className = 'update-notice__status'
  status.dataset.updateStatus = ''
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')
  status.setAttribute('aria-atomic', 'true')

  const updateButton = document.createElement('button')
  updateButton.type = 'button'
  updateButton.className = 'game-button game-button--primary update-notice__action'
  updateButton.dataset.action = 'update'
  updateButton.textContent = 'Update now'

  const dismissButton = document.createElement('button')
  dismissButton.type = 'button'
  dismissButton.className = 'game-button update-notice__action'
  dismissButton.dataset.action = 'dismiss-update'
  dismissButton.textContent = 'Dismiss'

  let dismissed = false
  const handleUpdate = () => {
    if (!updateButton.disabled) {
      void updateController.requestActivation()
    }
  }
  const handleDismiss = () => {
    dismissed = true
    element.hidden = true
  }
  updateButton.addEventListener('click', handleUpdate)
  dismissButton.addEventListener('click', handleDismiss)
  element.append(status, dismissButton, updateButton)
  host.append(element)

  function setBlocked(blocked) {
    for (const child of underlyingContent) {
      child.inert = blocked || priorInert.get(child)
    }
    if (blocked) {
      host.dataset.updateBlocked = 'true'
    } else {
      delete host.dataset.updateBlocked
    }
  }

  const unsubscribe = updateController.subscribe((snapshot) => {
    const visible = snapshot.status !== 'current'
    const blocked = BLOCKING_STATUSES.has(snapshot.status)
    if (!visible || snapshot.status === 'available') dismissed = false
    element.hidden = !visible || (dismissed && !blocked)
    status.textContent = noticeText(snapshot)
    dismissButton.hidden = blocked
    updateButton.hidden = !snapshot.canActivate && snapshot.status !== 'available'
    updateButton.disabled = blocked || !snapshot.canActivate
    setBlocked(blocked)
  })

  return Object.freeze({
    element,
    teardown() {
      unsubscribe()
      updateButton.removeEventListener('click', handleUpdate)
      dismissButton.removeEventListener('click', handleDismiss)
      setBlocked(false)
      element.remove?.()
    },
  })
}

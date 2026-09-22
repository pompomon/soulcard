const POINTER_TYPES = new Set(['mouse', 'touch', 'pen'])

function assertTarget(target) {
  if (
    target === null
    || typeof target !== 'object'
    || typeof target.addEventListener !== 'function'
    || typeof target.removeEventListener !== 'function'
    || !('disabled' in target)
  ) {
    throw new TypeError('target must be a disableable event target')
  }
}

function assertBoolean(value, name) {
  if (typeof value !== 'boolean') {
    throw new TypeError(`${name} must be a boolean`)
  }
}

function isPrimaryPointer(event) {
  return (
    event.isPrimary !== false
    && POINTER_TYPES.has(event.pointerType)
    && (event.button === undefined || event.button === 0)
  )
}

export function createInputController({
  target,
  onActivate,
  enabled = true,
  busy = false,
} = {}) {
  assertTarget(target)
  if (typeof onActivate !== 'function') {
    throw new TypeError('onActivate must be a function')
  }
  assertBoolean(enabled, 'enabled')
  assertBoolean(busy, 'busy')

  let currentEnabled = enabled
  let currentBusy = busy
  let pendingPointerId = null
  let suppressCompatibilityClick = false
  let destroyed = false

  const canActivate = () => !destroyed && currentEnabled && !currentBusy

  function syncTarget() {
    target.disabled = !currentEnabled || currentBusy
    if (target.dataset) {
      target.dataset.inputEnabled = String(currentEnabled)
      target.dataset.inputBusy = String(currentBusy)
    }
  }

  function handlePointerDown(event) {
    if (!canActivate() || !isPrimaryPointer(event)) return
    pendingPointerId = event.pointerId
  }

  function handlePointerUp(event) {
    if (
      pendingPointerId === null
      || event.pointerId !== pendingPointerId
      || !isPrimaryPointer(event)
    ) {
      return
    }
    pendingPointerId = null
    if (!canActivate()) return
    suppressCompatibilityClick = true
    onActivate(event)
  }

  function handlePointerCancel(event) {
    if (event.pointerId === pendingPointerId) {
      pendingPointerId = null
    }
  }

  function handleClick(event) {
    if (suppressCompatibilityClick && event.detail !== 0) {
      suppressCompatibilityClick = false
      event.preventDefault?.()
      event.stopPropagation?.()
      return
    }
    suppressCompatibilityClick = false
    if (
      !canActivate()
      || (event.button !== undefined && event.button !== 0)
    ) {
      return
    }
    onActivate(event)
  }

  target.addEventListener('pointerdown', handlePointerDown)
  target.addEventListener('pointerup', handlePointerUp)
  target.addEventListener('pointercancel', handlePointerCancel)
  target.addEventListener('click', handleClick)
  syncTarget()

  return Object.freeze({
    setEnabled(nextEnabled) {
      assertBoolean(nextEnabled, 'enabled')
      if (destroyed || currentEnabled === nextEnabled) return
      currentEnabled = nextEnabled
      if (!currentEnabled) pendingPointerId = null
      syncTarget()
    },
    setBusy(nextBusy) {
      assertBoolean(nextBusy, 'busy')
      if (destroyed || currentBusy === nextBusy) return
      currentBusy = nextBusy
      if (currentBusy) pendingPointerId = null
      syncTarget()
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      pendingPointerId = null
      suppressCompatibilityClick = false
      target.removeEventListener('pointerdown', handlePointerDown)
      target.removeEventListener('pointerup', handlePointerUp)
      target.removeEventListener('pointercancel', handlePointerCancel)
      target.removeEventListener('click', handleClick)
    },
    getState() {
      return Object.freeze({
        enabled: currentEnabled,
        busy: currentBusy,
        pendingPointerId,
        destroyed,
      })
    },
  })
}

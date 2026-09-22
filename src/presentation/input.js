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

function isPointerInside(target, event) {
  if (
    !Number.isFinite(event.clientX)
    || !Number.isFinite(event.clientY)
    || typeof target.getBoundingClientRect !== 'function'
  ) {
    return true
  }
  const bounds = target.getBoundingClientRect()
  return (
    event.clientX >= bounds.left
    && event.clientX <= bounds.right
    && event.clientY >= bounds.top
    && event.clientY <= bounds.bottom
  )
}

export function createInputController({
  target,
  onActivate,
  hitTest,
  enabled = true,
  busy = false,
} = {}) {
  assertTarget(target)
  if (typeof onActivate !== 'function') {
    throw new TypeError('onActivate must be a function')
  }
  if (hitTest !== undefined && typeof hitTest !== 'function') {
    throw new TypeError('hitTest must be a function')
  }
  assertBoolean(enabled, 'enabled')
  assertBoolean(busy, 'busy')

  let currentEnabled = enabled
  let currentBusy = busy
  let pendingPointerId = null
  let suppressCompatibilityClick = false
  let destroyed = false
  const pointerRoot = (
    target.ownerDocument !== null
    && typeof target.ownerDocument === 'object'
    && typeof target.ownerDocument.addEventListener === 'function'
    && typeof target.ownerDocument.removeEventListener === 'function'
  )
    ? target.ownerDocument
    : null

  const canActivate = () => !destroyed && currentEnabled && !currentBusy
  const hitsTarget = (event) => hitTest?.(event) ?? true

  function syncTarget() {
    target.disabled = !currentEnabled || currentBusy
    if (target.dataset) {
      target.dataset.inputEnabled = String(currentEnabled)
      target.dataset.inputBusy = String(currentBusy)
    }
  }

  function handlePointerDown(event) {
    if (!isPrimaryPointer(event)) return
    suppressCompatibilityClick = false
    if (!canActivate() || !hitsTarget(event)) {
      pendingPointerId = null
      suppressCompatibilityClick = true
      return
    }
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
    suppressCompatibilityClick = true
    if (
      !canActivate()
      || !isPointerInside(target, event)
      || !hitsTarget(event)
    ) {
      return
    }
    onActivate(event)
  }

  function handlePointerCancel(event) {
    if (event.pointerId === pendingPointerId) {
      pendingPointerId = null
    }
  }

  function handleRootPointerEnd(event) {
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
      || !hitsTarget(event)
    ) {
      return
    }
    onActivate(event)
  }

  target.addEventListener('pointerdown', handlePointerDown)
  target.addEventListener('pointerup', handlePointerUp)
  target.addEventListener('pointercancel', handlePointerCancel)
  target.addEventListener('click', handleClick)
  pointerRoot?.addEventListener('pointerup', handleRootPointerEnd)
  pointerRoot?.addEventListener('pointercancel', handleRootPointerEnd)
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
      pointerRoot?.removeEventListener('pointerup', handleRootPointerEnd)
      pointerRoot?.removeEventListener('pointercancel', handleRootPointerEnd)
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

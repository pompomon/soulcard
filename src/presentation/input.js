const POINTER_TYPES = new Set(['mouse', 'touch', 'pen'])
const DEFAULT_DRAG_THRESHOLD = 8

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

function assertDragOptions(drag) {
  if (drag === undefined) return null
  if (drag === null || typeof drag !== 'object' || Array.isArray(drag)) {
    throw new TypeError('drag must be an object')
  }
  if (typeof drag.dropTest !== 'function') {
    throw new TypeError('drag.dropTest must be a function')
  }
  for (const name of ['onStart', 'onMove', 'onEnd', 'onCancel']) {
    if (drag[name] !== undefined && typeof drag[name] !== 'function') {
      throw new TypeError(`drag.${name} must be a function`)
    }
  }
  const threshold = drag.threshold ?? DEFAULT_DRAG_THRESHOLD
  if (!Number.isFinite(threshold) || threshold < 0) {
    throw new TypeError('drag.threshold must be a nonnegative finite number')
  }
  return Object.freeze({
    threshold,
    dropTest: drag.dropTest,
    onStart: drag.onStart,
    onMove: drag.onMove,
    onEnd: drag.onEnd,
    onCancel: drag.onCancel,
  })
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
  drag,
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
  const dragOptions = assertDragOptions(drag)

  let currentEnabled = enabled
  let currentBusy = busy
  let pendingPointer = null
  let suppressCompatibilityClick = false
  let destroyed = false
  let lastPointerMoveEvent = null
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
      target.dataset.inputDragging = String(pendingPointer?.dragging === true)
    }
  }

  function releasePointerCapture(pointer) {
    if (!pointer?.captured || typeof target.releasePointerCapture !== 'function') return
    try {
      target.releasePointerCapture(pointer.id)
    } catch {}
  }

  function clearPendingPointer(event, notifyDragCancel = false) {
    const pointer = pendingPointer
    pendingPointer = null
    lastPointerMoveEvent = null
    syncTarget()
    releasePointerCapture(pointer)
    if (notifyDragCancel && pointer?.dragging) {
      dragOptions?.onCancel?.(event)
    }
    return pointer
  }

  function cancelPendingPointer(event, suppressClick = true) {
    if (pendingPointer === null) return
    if (suppressClick) suppressCompatibilityClick = true
    clearPendingPointer(event, true)
  }

  function capturePointer(pointer) {
    if (typeof target.setPointerCapture !== 'function') return
    try {
      target.setPointerCapture(pointer.id)
      pointer.captured = typeof target.hasPointerCapture === 'function'
        ? target.hasPointerCapture(pointer.id)
        : true
    } catch {
      pointer.captured = false
    }
  }

  function handlePointerDown(event) {
    if (pendingPointer !== null) {
      if (event.pointerId !== pendingPointer.id) {
        cancelPendingPointer(event)
      }
      return
    }
    if (!isPrimaryPointer(event)) return
    suppressCompatibilityClick = false
    if (!canActivate() || !hitsTarget(event)) {
      suppressCompatibilityClick = true
      return
    }
    pendingPointer = {
      id: event.pointerId,
      pointerType: event.pointerType,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
      captured: false,
    }
    syncTarget()
  }

  function handlePointerMove(event) {
    if (event === lastPointerMoveEvent) return
    lastPointerMoveEvent = event
    const pointer = pendingPointer
    if (
      pointer === null
      || event.pointerId !== pointer.id
      || dragOptions === null
    ) {
      return
    }
    if (!canActivate()) {
      cancelPendingPointer(event)
      return
    }
    if (
      !Number.isFinite(pointer.startX)
      || !Number.isFinite(pointer.startY)
      || !Number.isFinite(event.clientX)
      || !Number.isFinite(event.clientY)
    ) {
      return
    }
    if (!pointer.dragging) {
      const distance = Math.hypot(
        event.clientX - pointer.startX,
        event.clientY - pointer.startY,
      )
      if (distance < dragOptions.threshold) return
      pointer.dragging = true
      capturePointer(pointer)
      syncTarget()
      try {
        dragOptions.onStart?.(event, Object.freeze({
          pointerId: pointer.id,
          pointerType: pointer.pointerType,
          startX: pointer.startX,
          startY: pointer.startY,
        }))
      } catch (error) {
        cancelPendingPointer(event)
        throw error
      }
    }
    if (pendingPointer !== pointer || !pointer.dragging) return
    event.preventDefault?.()
    try {
      dragOptions.onMove?.(event)
    } catch (error) {
      cancelPendingPointer(event)
      throw error
    }
  }

  function finishDrag(event) {
    const pointer = clearPendingPointer(event)
    suppressCompatibilityClick = true
    event.preventDefault?.()
    let accepted = false
    try {
      accepted = canActivate() && dragOptions.dropTest(event)
      dragOptions.onEnd?.(event, accepted)
    } catch (error) {
      dragOptions.onCancel?.(event)
      throw error
    }
    if (accepted && canActivate()) onActivate(event)
  }

  function handlePointerUp(event) {
    const pointer = pendingPointer
    if (
      pointer === null
      || event.pointerId !== pointer.id
      || !isPrimaryPointer(event)
    ) {
      return
    }
    if (pointer.dragging) {
      finishDrag(event)
      return
    }
    clearPendingPointer(event)
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
    if (event.pointerId === pendingPointer?.id) {
      cancelPendingPointer(event)
    }
  }

  function handleRootPointerEnd(event) {
    const pointer = pendingPointer
    if (event.pointerId !== pointer?.id) return
    if (pointer.dragging && event.type === 'pointerup' && isPrimaryPointer(event)) {
      finishDrag(event)
    } else {
      cancelPendingPointer(event)
    }
  }

  function handleLostPointerCapture(event) {
    if (event.pointerId === pendingPointer?.id) {
      cancelPendingPointer(event)
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
  if (dragOptions !== null) target.addEventListener('pointermove', handlePointerMove)
  target.addEventListener('pointerup', handlePointerUp)
  target.addEventListener('pointercancel', handlePointerCancel)
  if (dragOptions !== null) {
    target.addEventListener('lostpointercapture', handleLostPointerCapture)
  }
  target.addEventListener('click', handleClick)
  if (dragOptions !== null) pointerRoot?.addEventListener('pointermove', handlePointerMove)
  pointerRoot?.addEventListener('pointerup', handleRootPointerEnd)
  pointerRoot?.addEventListener('pointercancel', handleRootPointerEnd)
  syncTarget()

  return Object.freeze({
    setEnabled(nextEnabled) {
      assertBoolean(nextEnabled, 'enabled')
      if (destroyed || currentEnabled === nextEnabled) return
      currentEnabled = nextEnabled
      if (!currentEnabled) cancelPendingPointer()
      syncTarget()
    },
    setBusy(nextBusy) {
      assertBoolean(nextBusy, 'busy')
      if (destroyed || currentBusy === nextBusy) return
      currentBusy = nextBusy
      if (currentBusy) cancelPendingPointer()
      syncTarget()
    },
    cancel() {
      if (destroyed) return
      cancelPendingPointer()
    },
    destroy() {
      if (destroyed) return
      cancelPendingPointer()
      destroyed = true
      suppressCompatibilityClick = false
      target.removeEventListener('pointerdown', handlePointerDown)
      if (dragOptions !== null) target.removeEventListener('pointermove', handlePointerMove)
      target.removeEventListener('pointerup', handlePointerUp)
      target.removeEventListener('pointercancel', handlePointerCancel)
      if (dragOptions !== null) {
        target.removeEventListener('lostpointercapture', handleLostPointerCapture)
      }
      target.removeEventListener('click', handleClick)
      if (dragOptions !== null) {
        pointerRoot?.removeEventListener('pointermove', handlePointerMove)
      }
      pointerRoot?.removeEventListener('pointerup', handleRootPointerEnd)
      pointerRoot?.removeEventListener('pointercancel', handleRootPointerEnd)
    },
    getState() {
      return Object.freeze({
        enabled: currentEnabled,
        busy: currentBusy,
        pendingPointerId: pendingPointer?.id ?? null,
        dragging: pendingPointer?.dragging === true,
        destroyed,
      })
    },
  })
}

function canObserve(target) {
  return (
    target !== null
    && typeof target === 'object'
    && typeof target.addEventListener === 'function'
    && typeof target.removeEventListener === 'function'
  )
}

export function createPageLifecycle({
  onSave,
  documentObject = globalThis.document,
  windowObject = globalThis.window,
} = {}) {
  if (typeof onSave !== 'function') {
    throw new TypeError('onSave must be a function')
  }

  const removals = []
  let destroyed = false

  function requestSave(trigger) {
    if (destroyed) return
    try {
      Promise.resolve(onSave(trigger)).catch(() => {})
    } catch {}
  }

  function observe(target, type, listener) {
    if (!canObserve(target)) return
    target.addEventListener(type, listener)
    removals.push(() => target.removeEventListener(type, listener))
  }

  observe(documentObject, 'visibilitychange', () => {
    if (
      documentObject.visibilityState === 'hidden'
      || documentObject.hidden === true
    ) {
      requestSave('visibilitychange')
    }
  })
  observe(windowObject, 'pagehide', () => requestSave('pagehide'))
  observe(documentObject, 'freeze', () => requestSave('freeze'))

  return Object.freeze({
    destroy() {
      if (destroyed) return
      destroyed = true
      for (const remove of removals.splice(0)) {
        remove()
      }
    },
  })
}

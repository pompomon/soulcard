import assert from 'node:assert/strict'
import test from 'node:test'
import { createInputController } from '../../src/presentation/input.js'

class FakeTarget {
  constructor() {
    this.dataset = {}
    this.disabled = false
    this.listeners = new Map()
    this.ownerDocument = null
    this.capturedPointers = new Set()
    this.captureCalls = []
    this.releaseCalls = []
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener)
  }

  setPointerCapture(pointerId) {
    this.captureCalls.push(pointerId)
    this.capturedPointers.add(pointerId)
  }

  hasPointerCapture(pointerId) {
    return this.capturedPointers.has(pointerId)
  }

  releasePointerCapture(pointerId) {
    this.releaseCalls.push(pointerId)
    this.capturedPointers.delete(pointerId)
  }

  dispatch(type, values = {}) {
    const event = {
      type,
      button: type.startsWith('pointer') ? 0 : undefined,
      detail: 0,
      isPrimary: true,
      pointerId: 1,
      pointerType: 'mouse',
      clientX: 50,
      clientY: 50,
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() {
        this.defaultPrevented = true
      },
      stopPropagation() {
        this.propagationStopped = true
      },
      ...values,
    }
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event)
    return event
  }

  getBoundingClientRect() {
    return { top: 0, right: 100, bottom: 100, left: 0 }
  }
}

function pointerSequence(target, pointerType, pointerId) {
  target.dispatch('pointerdown', { pointerType, pointerId })
  target.dispatch('pointerup', { pointerType, pointerId })
  return target.dispatch('click', { detail: 1 })
}

test('primary mouse, touch, and pen sequences activate once and suppress compatibility clicks', () => {
  const target = new FakeTarget()
  const activations = []
  createInputController({
    target,
    onActivate: (event) => activations.push(event.pointerType),
  })

  for (const [index, pointerType] of ['mouse', 'touch', 'pen'].entries()) {
    const compatibilityClick = pointerSequence(target, pointerType, index + 1)
    assert.equal(compatibilityClick.defaultPrevented, true)
    assert.equal(compatibilityClick.propagationStopped, true)
  }

  assert.deepEqual(activations, ['mouse', 'touch', 'pen'])
})

test('secondary, non-primary, mismatched, and cancelled pointers do not activate', () => {
  const target = new FakeTarget()
  let activations = 0
  createInputController({
    target,
    onActivate: () => {
      activations += 1
    },
  })

  target.dispatch('pointerdown', { button: 2, pointerId: 1 })
  target.dispatch('pointerup', { button: 2, pointerId: 1 })
  target.dispatch('pointerdown', { isPrimary: false, pointerId: 2 })
  target.dispatch('pointerup', { isPrimary: false, pointerId: 2 })
  target.dispatch('pointerdown', { pointerId: 3 })
  target.dispatch('pointerup', { pointerId: 4 })
  target.dispatch('pointercancel', { pointerId: 3 })
  target.dispatch('pointerup', { pointerId: 3 })
  target.dispatch('pointerdown', { pointerId: 5, pointerType: 'unknown' })
  target.dispatch('pointerup', { pointerId: 5, pointerType: 'unknown' })

  assert.equal(activations, 0)
})

test('release outside the target cancels mouse and implicit-capture pointer sequences', () => {
  const root = new FakeTarget()
  const target = new FakeTarget()
  target.ownerDocument = root
  let activations = 0
  createInputController({
    target,
    onActivate: () => {
      activations += 1
    },
  })

  target.dispatch('pointerdown', { pointerId: 1 })
  root.dispatch('pointerup', { pointerId: 1, clientX: 150 })
  target.dispatch('pointerup', { pointerId: 1 })

  target.dispatch('pointerdown', { pointerId: 2, pointerType: 'touch' })
  target.dispatch('pointerup', {
    pointerId: 2,
    pointerType: 'touch',
    clientX: 150,
  })
  const compatibilityClick = target.dispatch('click', { detail: 1 })

  assert.equal(activations, 0)
  assert.equal(compatibilityClick.defaultPrevented, true)
})

test('hit testing requires press and release on the interactive sub-target', () => {
  const target = new FakeTarget()
  let activations = 0
  createInputController({
    target,
    onActivate: () => {
      activations += 1
    },
    hitTest: (event) => event.clientX <= 60,
  })

  target.dispatch('pointerdown', { pointerId: 1, clientX: 50 })
  target.dispatch('pointerup', { pointerId: 1, clientX: 80 })
  const cancelledClick = target.dispatch('click', { detail: 1, clientX: 80 })
  target.dispatch('pointerdown', { pointerId: 2, clientX: 80 })
  target.dispatch('pointerup', { pointerId: 2, clientX: 50 })
  const dragInClick = target.dispatch('click', { detail: 1, clientX: 50 })
  target.dispatch('click', { detail: 0, clientX: 80 })
  target.dispatch('pointerdown', { pointerId: 3, clientX: 50 })
  target.dispatch('pointerup', { pointerId: 3, clientX: 50 })
  target.dispatch('click', { detail: 1, clientX: 50 })

  assert.equal(cancelledClick.defaultPrevented, true)
  assert.equal(dragInClick.defaultPrevented, true)
  assert.equal(activations, 1)
})

test('thresholded mouse, touch, and pen drags activate only on an accepted drop', () => {
  for (const [index, pointerType] of ['mouse', 'touch', 'pen'].entries()) {
    const target = new FakeTarget()
    const lifecycle = []
    let activations = 0
    const controller = createInputController({
      target,
      onActivate: () => {
        activations += 1
      },
      hitTest: (event) => event.clientX <= 60,
      drag: {
        threshold: 10,
        dropTest: (event) => event.clientX >= 80,
        onStart: (event, gesture) => lifecycle.push(['start', gesture.startX, event.clientX]),
        onMove: (event) => lifecycle.push(['move', event.clientX]),
        onEnd: (event, accepted) => lifecycle.push(['end', event.clientX, accepted]),
      },
    })
    const pointerId = index + 1

    target.dispatch('pointerdown', { pointerId, pointerType, clientX: 50 })
    target.dispatch('pointermove', { pointerId, pointerType, clientX: 57 })
    assert.equal(controller.getState().dragging, false)
    target.dispatch('pointerup', { pointerId, pointerType, clientX: 57 })
    target.dispatch('click', { detail: 1, clientX: 57 })
    assert.equal(activations, 1)
    assert.deepEqual(lifecycle, [])

    target.dispatch('pointerdown', { pointerId, pointerType, clientX: 50 })
    const move = target.dispatch('pointermove', {
      pointerId,
      pointerType,
      clientX: 70,
    })
    assert.equal(move.defaultPrevented, true)
    assert.equal(controller.getState().dragging, true)
    target.dispatch('pointerup', { pointerId, pointerType, clientX: 90 })
    const compatibilityClick = target.dispatch('click', { detail: 1, clientX: 90 })

    assert.equal(activations, 2)
    assert.equal(compatibilityClick.defaultPrevented, true)
    assert.deepEqual(lifecycle, [
      ['start', 50, 70],
      ['move', 70],
      ['end', 90, true],
    ])
    assert.deepEqual(target.captureCalls, [pointerId])
    assert.deepEqual(target.releaseCalls, [pointerId])
  }
})

test('invalid drops, drag-in attempts, and cancelled drags do not activate', () => {
  const target = new FakeTarget()
  const endings = []
  let cancellations = 0
  let activations = 0
  const controller = createInputController({
    target,
    onActivate: () => {
      activations += 1
    },
    hitTest: (event) => event.clientX <= 60,
    drag: {
      threshold: 5,
      dropTest: (event) => event.clientX >= 90,
      onEnd: (event, accepted) => endings.push([event.clientX, accepted]),
      onCancel: () => {
        cancellations += 1
      },
    },
  })

  target.dispatch('pointerdown', { pointerId: 1, clientX: 50 })
  target.dispatch('pointermove', { pointerId: 1, clientX: 75 })
  target.dispatch('pointerup', { pointerId: 1, clientX: 80 })

  target.dispatch('pointerdown', { pointerId: 2, clientX: 80 })
  target.dispatch('pointermove', { pointerId: 2, clientX: 50 })
  target.dispatch('pointerup', { pointerId: 2, clientX: 95 })

  target.dispatch('pointerdown', { pointerId: 3, clientX: 50 })
  target.dispatch('pointermove', { pointerId: 3, clientX: 75 })
  target.dispatch('pointercancel', { pointerId: 3, clientX: 75 })

  target.dispatch('pointerdown', { pointerId: 4, clientX: 50 })
  target.dispatch('pointermove', { pointerId: 4, clientX: 75 })
  target.dispatch('lostpointercapture', { pointerId: 4, clientX: 75 })

  assert.equal(activations, 0)
  assert.deepEqual(endings, [[80, false]])
  assert.equal(cancellations, 2)
  assert.equal(controller.getState().pendingPointerId, null)
})

test('drag uses document movement and release as a pointer-capture fallback', () => {
  const root = new FakeTarget()
  const target = new FakeTarget()
  target.ownerDocument = root
  target.setPointerCapture = undefined
  target.hasPointerCapture = undefined
  target.releasePointerCapture = undefined
  const moves = []
  let activations = 0
  createInputController({
    target,
    onActivate: () => {
      activations += 1
    },
    drag: {
      threshold: 5,
      dropTest: (event) => event.clientX === 90,
      onMove: (event) => moves.push(event.clientX),
    },
  })

  target.dispatch('pointerdown', { pointerId: 7, clientX: 50 })
  root.dispatch('pointermove', { pointerId: 7, clientX: 70 })
  root.dispatch('pointerup', { pointerId: 7, clientX: 90 })

  assert.deepEqual(moves, [70])
  assert.equal(activations, 1)
})

test('busy, disabled, multi-pointer, and teardown transitions cancel active drags', () => {
  const target = new FakeTarget()
  let cancellations = 0
  const controller = createInputController({
    target,
    onActivate() {},
    drag: {
      threshold: 5,
      dropTest: () => true,
      onCancel: () => {
        cancellations += 1
      },
    },
  })
  const startDrag = (pointerId) => {
    target.dispatch('pointerdown', { pointerId, clientX: 20 })
    target.dispatch('pointermove', { pointerId, clientX: 40 })
  }

  startDrag(1)
  controller.setBusy(true)
  controller.setBusy(false)
  startDrag(2)
  controller.setEnabled(false)
  controller.setEnabled(true)
  startDrag(3)
  target.dispatch('pointerdown', {
    pointerId: 4,
    isPrimary: false,
    pointerType: 'touch',
    clientX: 40,
  })
  startDrag(5)
  controller.destroy()

  assert.equal(cancellations, 4)
  assert.equal(controller.getState().destroyed, true)
  assert.ok([...target.listeners.values()].every((listeners) => listeners.size === 0))
})

test('busy and enabled gates update synchronously and allow later legitimate actions', () => {
  const target = new FakeTarget()
  let activations = 0
  let controller
  controller = createInputController({
    target,
    onActivate: () => {
      activations += 1
      controller.setBusy(true)
    },
  })

  target.dispatch('pointerdown', { pointerId: 1 })
  target.dispatch('pointerup', { pointerId: 1 })
  target.dispatch('pointerdown', { pointerId: 2 })
  target.dispatch('pointerup', { pointerId: 2 })
  assert.equal(activations, 1)
  assert.equal(target.disabled, true)
  assert.equal(controller.getState().busy, true)

  controller.setBusy(false)
  controller.setEnabled(false)
  target.dispatch('click')
  assert.equal(activations, 1)
  assert.equal(target.disabled, true)

  controller.setEnabled(true)
  target.dispatch('click')
  assert.equal(activations, 2)
})

test('native keyboard and programmatic clicks remain available as fallback', () => {
  const target = new FakeTarget()
  const activations = []
  createInputController({
    target,
    onActivate: (event) => activations.push(event.detail),
  })

  target.dispatch('click', { detail: 0 })
  target.dispatch('click', { detail: 0 })
  target.dispatch('click', { detail: 1, button: 2 })

  assert.deepEqual(activations, [0, 0])
})

test('teardown is idempotent and removes every listener', () => {
  const target = new FakeTarget()
  let activations = 0
  const controller = createInputController({
    target,
    onActivate: () => {
      activations += 1
    },
  })

  controller.destroy()
  controller.destroy()
  pointerSequence(target, 'touch', 1)
  target.dispatch('click')

  assert.equal(activations, 0)
  assert.equal(controller.getState().destroyed, true)
  assert.ok([...target.listeners.values()].every((listeners) => listeners.size === 0))
})

test('teardown removes document-level pointer termination listeners', () => {
  const root = new FakeTarget()
  const target = new FakeTarget()
  target.ownerDocument = root
  const controller = createInputController({ target, onActivate() {} })

  controller.destroy()

  assert.ok([...root.listeners.values()].every((listeners) => listeners.size === 0))
})

test('invalid construction and gate values are rejected', () => {
  const target = new FakeTarget()
  assert.throws(() => createInputController(), /target/)
  assert.throws(() => createInputController({ target }), /onActivate/)
  assert.throws(
    () => createInputController({ target, onActivate() {}, enabled: 'yes' }),
    /enabled/,
  )
  assert.throws(
    () => createInputController({ target, onActivate() {}, hitTest: true }),
    /hitTest/,
  )
  assert.throws(
    () => createInputController({ target, onActivate() {}, drag: {} }),
    /dropTest/,
  )
  assert.throws(
    () => createInputController({
      target,
      onActivate() {},
      drag: { dropTest() {}, threshold: -1 },
    }),
    /threshold/,
  )

  const controller = createInputController({ target, onActivate() {} })
  assert.throws(() => controller.setBusy(1), /busy/)
  assert.throws(() => controller.setEnabled(null), /enabled/)
})

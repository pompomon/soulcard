import assert from 'node:assert/strict'
import test from 'node:test'
import { createInputController } from '../../src/presentation/input.js'

class FakeTarget {
  constructor() {
    this.dataset = {}
    this.disabled = false
    this.listeners = new Map()
    this.ownerDocument = null
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener)
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

  const controller = createInputController({ target, onActivate() {} })
  assert.throws(() => controller.setBusy(1), /busy/)
  assert.throws(() => controller.setEnabled(null), /enabled/)
})

export const SCREEN_IDS = Object.freeze(['main', 'settings', 'game'])

const SCREEN_ID_SET = new Set(SCREEN_IDS)

function assertScreenId(screenId) {
  if (!SCREEN_ID_SET.has(screenId)) {
    throw new RangeError(`Unknown top-level screen: ${String(screenId)}`)
  }
}

function assertScreenFactories(screenFactories) {
  if (screenFactories === null || typeof screenFactories !== 'object') {
    throw new TypeError('screenFactories must define the three top-level screens')
  }

  const keys = Object.keys(screenFactories)
  if (
    keys.length !== SCREEN_IDS.length
    || keys.some((screenId) => !SCREEN_ID_SET.has(screenId))
  ) {
    throw new TypeError('screenFactories must contain only main, settings, and game')
  }

  for (const screenId of SCREEN_IDS) {
    if (typeof screenFactories[screenId] !== 'function') {
      throw new TypeError(`screenFactories.${screenId} must be a function`)
    }
  }
}

function validateMount(mount, screenId) {
  if (
    mount === null
    || typeof mount !== 'object'
    || mount.element === null
    || typeof mount.element !== 'object'
  ) {
    throw new TypeError(`${screenId} screen factory must return an element mount`)
  }
  if (mount.teardown !== undefined && typeof mount.teardown !== 'function') {
    throw new TypeError(`${screenId} screen teardown must be a function`)
  }
  return {
    element: mount.element,
    teardown: mount.teardown ?? (() => {}),
  }
}

export function createScreenCoordinator({
  root,
  screenFactories,
  initialScreen = 'main',
  resumeAvailable = false,
} = {}) {
  if (root === null || typeof root !== 'object' || typeof root.replaceChildren !== 'function') {
    throw new TypeError('root must support replaceChildren')
  }
  assertScreenFactories(screenFactories)
  assertScreenId(initialScreen)
  if (typeof resumeAvailable !== 'boolean') {
    throw new TypeError('resumeAvailable must be a boolean')
  }

  let activeScreen = null
  let currentMount = null
  let currentResumeAvailability = resumeAvailable
  let started = false
  let destroyed = false

  function assertActiveLifecycle() {
    if (destroyed) {
      throw new Error('Screen coordinator has been destroyed')
    }
  }

  function mount(screenId, force = false) {
    assertScreenId(screenId)
    if (!force && activeScreen === screenId) {
      return activeScreen
    }

    const nextMount = validateMount(screenFactories[screenId]({
      navigate,
      resumeAvailable: currentResumeAvailability,
    }), screenId)

    currentMount?.teardown()
    root.replaceChildren(nextMount.element)
    currentMount = nextMount
    activeScreen = screenId
    return activeScreen
  }

  function start() {
    assertActiveLifecycle()
    if (!started) {
      started = true
      mount(initialScreen)
    }
    return activeScreen
  }

  function navigate(screenId) {
    assertActiveLifecycle()
    assertScreenId(screenId)
    if (!started) {
      throw new Error('Screen coordinator has not been started')
    }
    return mount(screenId)
  }

  function setResumeAvailable(available) {
    assertActiveLifecycle()
    if (typeof available !== 'boolean') {
      throw new TypeError('Resume availability must be a boolean')
    }
    if (currentResumeAvailability === available) {
      return currentResumeAvailability
    }

    currentResumeAvailability = available
    if (started && activeScreen === 'main') {
      mount('main', true)
    }
    return currentResumeAvailability
  }

  function destroy() {
    if (destroyed) return
    currentMount?.teardown()
    root.replaceChildren()
    currentMount = null
    activeScreen = null
    destroyed = true
  }

  return Object.freeze({
    start,
    navigate,
    setResumeAvailable,
    destroy,
    get activeScreen() {
      return activeScreen
    },
    get resumeAvailable() {
      return currentResumeAvailability
    },
  })
}

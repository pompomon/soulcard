import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SCREEN_IDS,
  createScreenCoordinator,
} from '../../src/app/screen-coordinator.js'

function createRoot() {
  return {
    children: [],
    replaceChildren(...children) {
      this.children = children
    },
  }
}

function createFactories(log) {
  return Object.fromEntries(SCREEN_IDS.map((screenId) => [
    screenId,
    ({ resumeAvailable }) => {
      const element = {
        screenId,
        resumeAvailable,
        children: screenId === 'game' ? [{ role: 'dialog' }] : [],
      }
      log.push(`mount:${screenId}:${resumeAvailable}`)
      return {
        element,
        teardown() {
          log.push(`teardown:${screenId}`)
        },
      }
    },
  ]))
}

test('coordinator mounts exactly one of the three allowed top-level screens', () => {
  const root = createRoot()
  const coordinator = createScreenCoordinator({
    root,
    screenFactories: createFactories([]),
  })

  assert.deepEqual(SCREEN_IDS, ['main', 'settings', 'game'])
  assert.equal(coordinator.start(), 'main')
  assert.equal(coordinator.activeScreen, 'main')
  assert.equal(root.children.length, 1)
  assert.equal(root.children[0].screenId, 'main')

  for (const screenId of ['settings', 'game', 'main']) {
    assert.equal(coordinator.navigate(screenId), screenId)
    assert.equal(coordinator.activeScreen, screenId)
    assert.equal(root.children.length, 1)
    assert.equal(root.children[0].screenId, screenId)
  }

  assert.throws(() => coordinator.navigate('pause'), /Unknown top-level screen/)
  assert.equal(coordinator.activeScreen, 'main')
  assert.equal(root.children.length, 1)
})

test('navigation and destruction tear down mounted screens', () => {
  const root = createRoot()
  const log = []
  const coordinator = createScreenCoordinator({
    root,
    screenFactories: createFactories(log),
  })

  assert.throws(() => coordinator.navigate('game'), /has not been started/)
  coordinator.start()
  coordinator.navigate('settings')
  coordinator.navigate('settings')
  coordinator.destroy()
  coordinator.destroy()

  assert.deepEqual(log, [
    'mount:main:false',
    'mount:settings:false',
    'teardown:main',
    'teardown:settings',
  ])
  assert.equal(coordinator.activeScreen, null)
  assert.deepEqual(root.children, [])
  assert.throws(() => coordinator.start(), /has been destroyed/)
})

test('start can retry after the initial mount fails', () => {
  const root = createRoot()
  const factories = createFactories([])
  let attempts = 0
  const coordinator = createScreenCoordinator({
    root,
    screenFactories: {
      ...factories,
      main: () => {
        attempts += 1
        if (attempts === 1) {
          throw new Error('mount failed')
        }
        return factories.main({ resumeAvailable: false })
      },
    },
  })

  assert.throws(() => coordinator.start(), /mount failed/)
  assert.equal(coordinator.start(), 'main')
  assert.equal(attempts, 2)
  assert.equal(coordinator.activeScreen, 'main')
})

test('resume availability is injectable and refreshes only the active Main screen', () => {
  const root = createRoot()
  const log = []
  const factories = createFactories(log)
  let failRefresh = true
  const coordinator = createScreenCoordinator({
    root,
    resumeAvailable: false,
    screenFactories: {
      ...factories,
      main: (options) => {
        if (options.resumeAvailable && failRefresh) {
          failRefresh = false
          throw new Error('refresh failed')
        }
        return factories.main(options)
      },
    },
  })

  coordinator.start()
  assert.equal(root.children[0].resumeAvailable, false)

  assert.throws(() => coordinator.setResumeAvailable(true), /refresh failed/)
  assert.equal(coordinator.resumeAvailable, false)
  assert.equal(root.children[0].resumeAvailable, false)
  assert.equal(coordinator.setResumeAvailable(true), true)
  assert.equal(coordinator.resumeAvailable, true)
  assert.equal(root.children[0].resumeAvailable, true)
  assert.deepEqual(log, [
    'mount:main:false',
    'mount:main:true',
    'teardown:main',
  ])

  coordinator.navigate('settings')
  coordinator.setResumeAvailable(false)
  assert.equal(root.children[0].screenId, 'settings')
  coordinator.navigate('main')
  assert.equal(root.children[0].resumeAvailable, false)
  assert.throws(() => coordinator.setResumeAvailable('yes'), /must be a boolean/)
})

test('Game overlays remain children of Game rather than coordinator states', () => {
  const root = createRoot()
  const coordinator = createScreenCoordinator({
    root,
    initialScreen: 'game',
    screenFactories: createFactories([]),
  })

  coordinator.start()
  assert.equal(coordinator.activeScreen, 'game')
  assert.equal(root.children.length, 1)
  assert.deepEqual(root.children[0].children, [{ role: 'dialog' }])
  assert.throws(() => coordinator.navigate('overlay'), /Unknown top-level screen/)
  assert.equal(coordinator.activeScreen, 'game')
})

test('constructor rejects incomplete or expanded screen registries', () => {
  const root = createRoot()
  const factories = createFactories([])

  assert.throws(
    () => createScreenCoordinator({
      root,
      screenFactories: { main: factories.main, settings: factories.settings },
    }),
    /only main, settings, and game/,
  )
  assert.throws(
    () => createScreenCoordinator({
      root,
      screenFactories: { ...factories, pause: () => ({ element: {} }) },
    }),
    /only main, settings, and game/,
  )

  const invalidMountCoordinator = createScreenCoordinator({
    root,
    screenFactories: { ...factories, main: () => ({ element: null }) },
  })
  assert.throws(
    () => invalidMountCoordinator.start(),
    /must return an element mount/,
  )
})

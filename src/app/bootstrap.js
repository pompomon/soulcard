import { createScreenCoordinator } from './screen-coordinator.js'
import { createRunController } from './run-controller.js'
import { createRunRepository } from '../persistence/run-repository.js'
import { createSettingsRepository } from '../persistence/settings-repository.js'
import { createPageLifecycle } from '../pwa/lifecycle.js'
import { createMainScreen, createSettingsScreen } from '../ui/menus.js'
import { createSettingsController } from '../ui/settings-controller.js'
import { createGameScreen } from '../ui/hud.js'
import { mountPrototypeScene } from '../presentation/prototype-scene.js'

function assertRunController(runController) {
  const methods = [
    'getSnapshot',
    'restore',
    'discardPendingRestore',
    'saveStable',
    'subscribe',
    'pause',
    'resume',
    'destroy',
  ]
  if (
    runController === null
    || typeof runController !== 'object'
    || methods.some((method) => typeof runController[method] !== 'function')
    || !Object.hasOwn(runController, 'currentMatch')
  ) {
    throw new TypeError('runController must implement the application run controller interface')
  }
}

export function registerServiceWorker({
  production = import.meta.env?.PROD === true,
  windowObject = globalThis.window,
  navigatorObject = globalThis.navigator,
} = {}) {
  if (
    !production
    || !windowObject
    || !navigatorObject
    || !('serviceWorker' in navigatorObject)
  ) {
    return
  }

  windowObject.addEventListener(
    'load',
    () => navigatorObject.serviceWorker.register('./sw.js'),
    { once: true },
  )
}

export function bootstrap({
  root,
  resumeAvailable = false,
  mountBattlefield = mountPrototypeScene,
  settingsRepository = createSettingsRepository(),
  matchMedia = undefined,
  runRepository = undefined,
  runController = undefined,
  pageLifecycleFactory = createPageLifecycle,
} = {}) {
  const settingsController = createSettingsController({
    repository: settingsRepository,
    matchMedia,
  })
  let activeRunController
  try {
    activeRunController = runController ?? createRunController({
      repository: runRepository ?? createRunRepository(),
    })
    assertRunController(activeRunController)
  } catch (error) {
    settingsController.destroy()
    throw error
  }

  let pageLifecycle
  try {
    if (typeof pageLifecycleFactory !== 'function') {
      throw new TypeError('pageLifecycleFactory must be a function')
    }
    pageLifecycle = pageLifecycleFactory({
      onSave: () => activeRunController.saveStable(),
    })
    if (
      pageLifecycle === null
      || typeof pageLifecycle !== 'object'
      || typeof pageLifecycle.destroy !== 'function'
    ) {
      throw new TypeError('pageLifecycleFactory must return a destroyable lifecycle')
    }
  } catch (error) {
    settingsController.destroy()
    void activeRunController.destroy()
    throw error
  }
  let coordinator
  try {
    coordinator = createScreenCoordinator({
      root,
      resumeAvailable,
      screenFactories: {
        main: ({ navigate, resumeAvailable: canResume }) => createMainScreen({
          resumeAvailable: canResume,
          onStart: () => {
            activeRunController.discardPendingRestore()
            navigate('game')
          },
          onResume: () => navigate('game'),
          onSettings: () => navigate('settings'),
        }),
        settings: ({ navigate }) => createSettingsScreen({
          onBack: () => navigate('main'),
          settingsController,
        }),
        game: () => createGameScreen({
          mountBattlefield,
          settingsController,
          runController: activeRunController,
        }),
      },
    })
    if (activeRunController.currentMatch !== null) {
      coordinator.setResumeAvailable(true)
    }
    coordinator.start()
  } catch (error) {
    pageLifecycle.destroy()
    void activeRunController.destroy()
    settingsController.destroy()
    throw error
  }
  let destroyed = false
  const ready = activeRunController.currentMatch === null
    ? activeRunController.restore().then((result) => {
      if (!destroyed) {
        coordinator.setResumeAvailable(
          result.status === 'resumable' && activeRunController.currentMatch !== null,
        )
      }
      return result
    })
    : Promise.resolve(Object.freeze({ status: 'current' }))
  registerServiceWorker()

  return Object.freeze({
    ready,
    start: coordinator.start,
    navigate: coordinator.navigate,
    setResumeAvailable: coordinator.setResumeAvailable,
    async destroy() {
      destroyed = true
      let firstError = null
      const attempt = async (teardown) => {
        try {
          await teardown()
        } catch (error) {
          firstError ??= error
        }
      }

      await attempt(() => pageLifecycle.destroy())
      await attempt(() => coordinator.destroy())
      await attempt(() => settingsController.destroy())
      await attempt(() => activeRunController.destroy())
      if (firstError) {
        throw firstError
      }
    },
    get activeScreen() {
      return coordinator.activeScreen
    },
    get resumeAvailable() {
      return coordinator.resumeAvailable
    },
    get runSnapshot() {
      return activeRunController.getSnapshot()
    },
  })
}

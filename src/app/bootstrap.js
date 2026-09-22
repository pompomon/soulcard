import { createScreenCoordinator } from './screen-coordinator.js'
import { createRunController } from './run-controller.js'
import { createNewMatch } from './new-match.js'
import { createRunRepository } from '../persistence/run-repository.js'
import { createSettingsRepository } from '../persistence/settings-repository.js'
import { createPageLifecycle } from '../pwa/lifecycle.js'
import { createMainScreen, createSettingsScreen } from '../ui/menus.js'
import { createSettingsController } from '../ui/settings-controller.js'
import { createGameScreen } from '../ui/hud.js'
import { mountBattlefield as mountResponsiveBattlefield } from '../presentation/battlefield.js'

const START_OVER_MESSAGE = 'Start a new game? Your current saved game will be replaced.'

function defaultConfirmStartOver() {
  return globalThis.confirm?.(START_OVER_MESSAGE) === true
}

function assertRunController(runController) {
  const methods = [
    'getSnapshot',
    'restore',
    'discardPendingRestore',
    'setMatch',
    'saveStable',
    'subscribe',
    'revealOrContinue',
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
  mountBattlefield = mountResponsiveBattlefield,
  settingsRepository = createSettingsRepository(),
  matchMedia = undefined,
  runRepository = undefined,
  runController = undefined,
  pageLifecycleFactory = createPageLifecycle,
  eventPlayerFactory = undefined,
  inputControllerFactory = undefined,
  newMatchFactory = createNewMatch,
  confirmStartOver = defaultConfirmStartOver,
} = {}) {
  if (typeof newMatchFactory !== 'function') {
    throw new TypeError('newMatchFactory must be a function')
  }
  if (typeof confirmStartOver !== 'function') {
    throw new TypeError('confirmStartOver must be a function')
  }
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

  let restorePending = activeRunController.currentMatch === null
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
            if (
              (restorePending || activeRunController.currentMatch !== null)
              && !confirmStartOver()
            ) {
              return
            }
            const match = newMatchFactory()
            activeRunController.discardPendingRestore()
            activeRunController.setMatch(match)
            const save = activeRunController.saveStable()
            navigate('game')
            coordinator.setResumeAvailable(true)
            void save
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
          eventPlayerFactory,
          inputControllerFactory,
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
  const ready = restorePending
    ? activeRunController.restore().then((result) => {
      if (!destroyed) {
        coordinator.setResumeAvailable(activeRunController.currentMatch !== null)
      }
      return result
    }).finally(() => {
      restorePending = false
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

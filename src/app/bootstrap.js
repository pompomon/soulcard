import { createScreenCoordinator } from './screen-coordinator.js'
import { createRunController } from './run-controller.js'
import { createNewMatch } from './new-match.js'
import { createRunRepository } from '../persistence/run-repository.js'
import { createSettingsRepository } from '../persistence/settings-repository.js'
import { createPageLifecycle } from '../pwa/lifecycle.js'
import { createUpdateController } from '../pwa/update-controller.js'
import { createMainScreen, createSettingsScreen } from '../ui/menus.js'
import { createSettingsController } from '../ui/settings-controller.js'
import { createGameScreen } from '../ui/hud.js'
import { createUpdateNotice } from '../ui/update-notice.js'
import { mountBattlefield as mountResponsiveBattlefield } from '../presentation/battlefield.js'

const START_OVER_MESSAGE = 'Start a new game? Your current saved game will be replaced.'

function defaultConfirmStartOver() {
  return globalThis.confirm?.(START_OVER_MESSAGE) === true
}

function assertRunController(runController) {
  const methods = [
    'getSnapshot',
    'restore',
    'discardRecovery',
    'discardPendingRestore',
    'setMatch',
    'saveStable',
    'whenIdle',
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

function assertUpdateController(updateController) {
  const methods = ['getSnapshot', 'subscribe', 'requestActivation', 'destroy']
  if (
    updateController === null
    || typeof updateController !== 'object'
    || methods.some((method) => typeof updateController[method] !== 'function')
  ) {
    throw new TypeError('updateController must implement the application update interface')
  }
}

function attachUpdateNotice(mount, updateController, updateNoticeFactory) {
  if (
    mount === null
    || typeof mount !== 'object'
    || mount.element === null
    || typeof mount.element !== 'object'
  ) {
    return mount
  }
  let notice
  try {
    notice = updateNoticeFactory({
      updateController,
      host: mount.element,
    })
    if (
      notice === null
      || typeof notice !== 'object'
      || typeof notice.teardown !== 'function'
    ) {
      throw new TypeError('updateNoticeFactory must return a teardown-capable notice')
    }
  } catch (error) {
    mount.teardown?.()
    throw error
  }

  return {
    element: mount.element,
    teardown() {
      let firstError = null
      try {
        notice.teardown()
      } catch (error) {
        firstError = error
      }
      try {
        mount.teardown?.()
      } catch (error) {
        firstError ??= error
      }
      if (firstError) throw firstError
    },
  }
}

export function registerServiceWorker(options = {}) {
  return createUpdateController(options)
}

export function bootstrap({
  root,
  mountBattlefield = mountResponsiveBattlefield,
  settingsRepository = createSettingsRepository(),
  matchMedia = undefined,
  runRepository = undefined,
  runController = undefined,
  pageLifecycleFactory = createPageLifecycle,
  updateController = undefined,
  updateControllerFactory = createUpdateController,
  updateNoticeFactory = createUpdateNotice,
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
  let activeUpdateController
  let destroyed = false
  let unsubscribeResumeAvailability = () => {}
  let ready = Promise.resolve(Object.freeze({ status: 'current' }))

  const prepareForUpdate = async () => {
    await ready
    await activeRunController.whenIdle()
    if (activeRunController.currentMatch === null) {
      return Object.freeze({ status: 'ready', reason: 'no-active-run' })
    }
    const saveResult = await activeRunController.saveStable()
    if (saveResult.status !== 'saved') {
      const error = new Error('The active run could not be saved before updating')
      error.reason = saveResult.reason ?? 'save-failed'
      throw error
    }
    return Object.freeze({ status: 'ready', reason: null })
  }

  const requiresReplacementConfirmation = () => {
    const snapshot = activeRunController.getSnapshot()
    return (
      restorePending
      || activeRunController.currentMatch !== null
      || snapshot.restoreStatus === 'recovery-required'
    )
  }

  const startNewGame = () => {
    if (requiresReplacementConfirmation() && !confirmStartOver()) {
      return false
    }

    const match = newMatchFactory()
    activeRunController.discardPendingRestore()
    if (coordinator?.activeScreen === 'game') {
      coordinator.navigate('main')
    }
    activeRunController.setMatch(match)
    const save = activeRunController.saveStable()
    coordinator.setResumeAvailable(true)
    coordinator.navigate('game')
    void save
    return true
  }

  try {
    if (typeof updateControllerFactory !== 'function') {
      throw new TypeError('updateControllerFactory must be a function')
    }
    if (typeof updateNoticeFactory !== 'function') {
      throw new TypeError('updateNoticeFactory must be a function')
    }
    activeUpdateController = updateController ?? updateControllerFactory({
      prepareForActivation: prepareForUpdate,
    })
    assertUpdateController(activeUpdateController)
    coordinator = createScreenCoordinator({
      root,
      resumeAvailable: activeRunController.currentMatch !== null,
      screenFactories: {
        main: ({ navigate, resumeAvailable: canResume }) => attachUpdateNotice(
          createMainScreen({
            resumeAvailable: canResume,
            runController: activeRunController,
            onStart: startNewGame,
            onResume: () => {
              if (activeRunController.currentMatch !== null) navigate('game')
            },
            onSettings: () => navigate('settings'),
            onDiscard: () => activeRunController.discardRecovery(),
          }),
          activeUpdateController,
          updateNoticeFactory,
        ),
        settings: ({ navigate }) => attachUpdateNotice(
          createSettingsScreen({
            onBack: () => navigate('main'),
            settingsController,
          }),
          activeUpdateController,
          updateNoticeFactory,
        ),
        game: () => attachUpdateNotice(
          createGameScreen({
            mountBattlefield,
            settingsController,
            runController: activeRunController,
            eventPlayerFactory,
            inputControllerFactory,
            onMainMenu: () => coordinator.navigate('main'),
            onRestart: startNewGame,
          }),
          activeUpdateController,
          updateNoticeFactory,
        ),
      },
    })
    coordinator.start()
    unsubscribeResumeAvailability = activeRunController.subscribe(({ match }) => {
      if (!destroyed) coordinator.setResumeAvailable(match !== null)
    })
  } catch (error) {
    activeUpdateController?.destroy()
    pageLifecycle.destroy()
    void activeRunController.destroy()
    settingsController.destroy()
    throw error
  }
  ready = restorePending
    ? activeRunController.restore().then((result) => {
      if (!destroyed) {
        coordinator.setResumeAvailable(activeRunController.currentMatch !== null)
      }
      return result
    }).finally(() => {
      restorePending = false
    })
    : Promise.resolve(Object.freeze({ status: 'current' }))

  return Object.freeze({
    ready,
    start: coordinator.start,
    navigate: coordinator.navigate,
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
      await attempt(() => unsubscribeResumeAvailability())
      await attempt(() => coordinator.destroy())
      await attempt(() => activeUpdateController.destroy())
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
    get updateSnapshot() {
      return activeUpdateController.getSnapshot()
    },
  })
}

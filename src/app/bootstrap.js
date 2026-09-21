import { createScreenCoordinator } from './screen-coordinator.js'
import { createSettingsRepository } from '../persistence/settings-repository.js'
import { createMainScreen, createSettingsScreen } from '../ui/menus.js'
import { createSettingsController } from '../ui/settings-controller.js'
import { createGameScreen } from '../ui/hud.js'
import { mountPrototypeScene } from '../presentation/prototype-scene.js'

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
} = {}) {
  const settingsController = createSettingsController({
    repository: settingsRepository,
    matchMedia,
  })
  const coordinator = createScreenCoordinator({
    root,
    resumeAvailable,
    screenFactories: {
      main: ({ navigate, resumeAvailable: canResume }) => createMainScreen({
        resumeAvailable: canResume,
        onStart: () => navigate('game'),
        onResume: () => navigate('game'),
        onSettings: () => navigate('settings'),
      }),
      settings: ({ navigate }) => createSettingsScreen({
        onBack: () => navigate('main'),
        settingsController,
      }),
      game: () => createGameScreen({ mountBattlefield, settingsController }),
    },
  })

  try {
    coordinator.start()
  } catch (error) {
    settingsController.destroy()
    throw error
  }
  registerServiceWorker()

  return Object.freeze({
    start: coordinator.start,
    navigate: coordinator.navigate,
    setResumeAvailable: coordinator.setResumeAvailable,
    destroy() {
      try {
        coordinator.destroy()
      } finally {
        settingsController.destroy()
      }
    },
    get activeScreen() {
      return coordinator.activeScreen
    },
    get resumeAvailable() {
      return coordinator.resumeAvailable
    },
  })
}

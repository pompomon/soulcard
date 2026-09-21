import { createScreenCoordinator } from './screen-coordinator.js'
import { createMainScreen, createSettingsScreen } from '../ui/menus.js'
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
} = {}) {
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
      }),
      game: () => createGameScreen({ mountBattlefield }),
    },
  })

  coordinator.start()
  registerServiceWorker()
  return coordinator
}

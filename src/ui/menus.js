function assertCallback(callback, name) {
  if (typeof callback !== 'function') {
    throw new TypeError(`${name} must be a function`)
  }
}

function createButton(label, action) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'menu-button'
  button.textContent = label
  button.addEventListener('click', action)
  return button
}

export function createMainScreen({
  resumeAvailable = false,
  onStart,
  onResume,
  onSettings,
} = {}) {
  if (typeof resumeAvailable !== 'boolean') {
    throw new TypeError('resumeAvailable must be a boolean')
  }
  assertCallback(onStart, 'onStart')
  assertCallback(onResume, 'onResume')
  assertCallback(onSettings, 'onSettings')

  const element = document.createElement('main')
  element.className = 'screen screen--menu'
  element.dataset.screen = 'main'
  element.setAttribute('aria-labelledby', 'main-screen-title')

  const panel = document.createElement('section')
  panel.className = 'menu-panel'

  const eyebrow = document.createElement('p')
  eyebrow.className = 'menu-eyebrow'
  eyebrow.textContent = 'A deterministic card duel'

  const heading = document.createElement('h1')
  heading.id = 'main-screen-title'
  heading.className = 'game-title'
  heading.textContent = 'Soulcard'

  const actions = document.createElement('div')
  actions.className = 'menu-actions'

  const startButton = createButton('Start New Game', onStart)
  startButton.dataset.action = 'start'

  const resumeButton = createButton('Resume Game', () => {
    if (resumeAvailable) onResume()
  })
  resumeButton.dataset.action = 'resume'
  resumeButton.disabled = !resumeAvailable

  const settingsButton = createButton('Settings', onSettings)
  settingsButton.dataset.action = 'settings'

  actions.append(startButton, resumeButton, settingsButton)
  panel.append(eyebrow, heading, actions)
  element.append(panel)

  return {
    element,
    teardown() {
      startButton.removeEventListener('click', onStart)
      settingsButton.removeEventListener('click', onSettings)
    },
  }
}

export function createSettingsScreen({ onBack } = {}) {
  assertCallback(onBack, 'onBack')

  const element = document.createElement('main')
  element.className = 'screen screen--menu'
  element.dataset.screen = 'settings'
  element.setAttribute('aria-labelledby', 'settings-screen-title')

  const panel = document.createElement('section')
  panel.className = 'menu-panel'

  const heading = document.createElement('h1')
  heading.id = 'settings-screen-title'
  heading.className = 'screen-title'
  heading.textContent = 'Settings'

  const settingsHost = document.createElement('section')
  settingsHost.className = 'settings-host'
  settingsHost.dataset.settingsHost = ''
  settingsHost.setAttribute('aria-labelledby', 'settings-controls-title')

  const controlsHeading = document.createElement('h2')
  controlsHeading.id = 'settings-controls-title'
  controlsHeading.textContent = 'Graphics and animation'

  const placeholder = document.createElement('p')
  placeholder.textContent = 'Settings controls will be available in the next milestone.'

  const backButton = createButton('Back to Main Menu', onBack)
  backButton.dataset.action = 'back'

  settingsHost.append(controlsHeading, placeholder)
  panel.append(heading, settingsHost, backButton)
  element.append(panel)

  return {
    element,
    teardown() {
      backButton.removeEventListener('click', onBack)
    },
  }
}

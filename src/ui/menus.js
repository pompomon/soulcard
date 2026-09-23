import {
  ANIMATION_SPEEDS,
  QUALITY_PRESETS,
  RENDER_SCALE_CAPS,
} from '../app/settings.js'

function assertCallback(callback, name) {
  if (typeof callback !== 'function') {
    throw new TypeError(`${name} must be a function`)
  }
}

function assertSettingsController(settingsController) {
  const methods = [
    'getSnapshot',
    'subscribe',
    'setBurnEnabled',
    'setQuality',
    'setRenderScaleCap',
    'setAnimationSpeed',
    'setReducedMotionOverride',
  ]
  if (
    settingsController === null
    || typeof settingsController !== 'object'
    || methods.some((method) => typeof settingsController[method] !== 'function')
  ) {
    throw new TypeError('settingsController must implement the settings controller interface')
  }
}

function assertRunController(runController) {
  if (
    runController === null
    || typeof runController !== 'object'
    || typeof runController.getSnapshot !== 'function'
    || typeof runController.subscribe !== 'function'
  ) {
    throw new TypeError('runController must expose getSnapshot and subscribe')
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

function createSelectField({ id, label, setting, options, onChange }) {
  const field = document.createElement('div')
  field.className = 'settings-field'

  const labelElement = document.createElement('label')
  labelElement.htmlFor = id
  labelElement.textContent = label

  const select = document.createElement('select')
  select.id = id
  select.dataset.setting = setting

  for (const { value, text } of options) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = text
    select.append(option)
  }

  select.addEventListener('change', onChange)
  field.append(labelElement, select)
  return { field, select }
}

function mainStatusText(snapshot) {
  if (snapshot.discardStatus === 'discarding') {
    return 'Discarding saved game…'
  }
  if (snapshot.discardStatus === 'failed') {
    return `Discard failed${snapshot.discardReason ? ` (${snapshot.discardReason})` : ''}. Try again.`
  }

  const match = snapshot.match
  if (match?.status === 'ended') {
    return snapshot.saveStatus === 'failed'
      ? 'Completed game available in this session. Saving is unavailable.'
      : 'Completed game available. Resume Game opens its summary.'
  }
  if (match?.machineState === 'paused') {
    return snapshot.saveStatus === 'failed'
      ? 'Paused game available in this session. Saving is unavailable.'
      : 'Paused game available.'
  }
  if (match !== null && match !== undefined) {
    return snapshot.saveStatus === 'failed'
      ? 'Game available in this session. Saving is unavailable.'
      : 'Saved game available.'
  }

  switch (snapshot.restoreStatus) {
    case 'loading':
    case 'idle':
      return 'Checking for a saved game…'
    case 'empty':
      return 'No saved game found.'
    case 'recovery-required':
      return snapshot.restoreMessage
        ?? 'The saved game cannot be resumed. Discard it or start a new game.'
    case 'storage-unavailable':
      return 'Saved games are unavailable. New games remain available in this session.'
    default:
      return 'No saved game is available.'
  }
}

export function createMainScreen({
  resumeAvailable = false,
  runController,
  onStart,
  onResume,
  onSettings,
  onDiscard,
} = {}) {
  if (typeof resumeAvailable !== 'boolean') {
    throw new TypeError('resumeAvailable must be a boolean')
  }
  assertRunController(runController)
  assertCallback(onStart, 'onStart')
  assertCallback(onResume, 'onResume')
  assertCallback(onSettings, 'onSettings')
  assertCallback(onDiscard, 'onDiscard')

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

  const handleResume = () => {
    if (resumeAvailable && runController.getSnapshot().match != null) onResume()
  }
  const resumeButton = createButton('Resume Game', handleResume)
  resumeButton.dataset.action = 'resume'
  resumeButton.disabled = !resumeAvailable

  const settingsButton = createButton('Settings', onSettings)
  settingsButton.dataset.action = 'settings'

  const handleDiscard = () => {
    const snapshot = runController.getSnapshot()
    if (
      snapshot.restoreStatus !== 'recovery-required'
      || snapshot.discardStatus === 'discarding'
    ) {
      return
    }
    try {
      Promise.resolve(onDiscard()).catch(() => {})
    } catch {}
  }
  const discardButton = createButton('Discard Saved Game', handleDiscard)
  discardButton.dataset.action = 'discard'
  discardButton.hidden = true

  const status = document.createElement('p')
  status.className = 'main-status'
  status.dataset.mainStatus = ''
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')

  actions.append(startButton, resumeButton, discardButton, settingsButton)
  panel.append(eyebrow, heading, status, actions)
  element.append(panel)

  const unsubscribe = runController.subscribe((snapshot) => {
    const discarding = snapshot.discardStatus === 'discarding'
    const resumable = resumeAvailable && snapshot.match !== null && snapshot.match !== undefined
    status.textContent = mainStatusText(snapshot)
    startButton.disabled = discarding
    resumeButton.disabled = discarding || !resumable
    discardButton.hidden = snapshot.restoreStatus !== 'recovery-required'
    discardButton.disabled = discarding
  })

  return {
    element,
    teardown() {
      unsubscribe()
      startButton.removeEventListener('click', onStart)
      resumeButton.removeEventListener('click', handleResume)
      settingsButton.removeEventListener('click', onSettings)
      discardButton.removeEventListener('click', handleDiscard)
    },
  }
}

export function createSettingsScreen({ onBack, settingsController } = {}) {
  assertCallback(onBack, 'onBack')
  assertSettingsController(settingsController)

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

  const gameplayHost = document.createElement('section')
  gameplayHost.className = 'settings-host'
  gameplayHost.dataset.gameplaySettingsHost = ''
  gameplayHost.setAttribute('aria-labelledby', 'gameplay-settings-title')

  const gameplayHeading = document.createElement('h2')
  gameplayHeading.id = 'gameplay-settings-title'
  gameplayHeading.textContent = 'Gameplay'

  const gameplayControls = document.createElement('div')
  gameplayControls.className = 'settings-grid'

  const burnValues = Object.freeze({
    enabled: true,
    disabled: false,
  })
  const handleBurnEnabled = (event) => {
    settingsController.setBurnEnabled(burnValues[event.currentTarget.value])
  }
  const burnEnabled = createSelectField({
    id: 'burn-enabled-setting',
    label: 'Turn burning',
    setting: 'burn-enabled',
    options: [
      { value: 'enabled', text: 'On' },
      { value: 'disabled', text: 'Off' },
    ],
    onChange: handleBurnEnabled,
  })

  const gameplayNote = document.createElement('p')
  gameplayNote.className = 'settings-note'
  gameplayNote.textContent = 'Applies to newly started or restarted games. Resumed games keep their saved rules.'

  gameplayControls.append(burnEnabled.field)
  gameplayHost.append(gameplayHeading, gameplayControls, gameplayNote)

  const presentationHost = document.createElement('section')
  presentationHost.className = 'settings-host'
  presentationHost.dataset.settingsHost = ''
  presentationHost.setAttribute('aria-labelledby', 'settings-controls-title')

  const controlsHeading = document.createElement('h2')
  controlsHeading.id = 'settings-controls-title'
  controlsHeading.textContent = 'Graphics and animation'

  const controls = document.createElement('div')
  controls.className = 'settings-grid'

  const handleQuality = (event) => settingsController.setQuality(event.currentTarget.value)
  const quality = createSelectField({
    id: 'quality-setting',
    label: 'Quality preset',
    setting: 'quality',
    options: QUALITY_PRESETS.map((value) => ({
      value,
      text: value[0].toUpperCase() + value.slice(1),
    })),
    onChange: handleQuality,
  })

  const handleRenderScale = (event) => {
    settingsController.setRenderScaleCap(Number(event.currentTarget.value))
  }
  const renderScale = createSelectField({
    id: 'render-scale-setting',
    label: 'Render scale cap',
    setting: 'render-scale-cap',
    options: RENDER_SCALE_CAPS.map((value) => ({
      value: String(value),
      text: `${value}×`,
    })),
    onChange: handleRenderScale,
  })

  const handleAnimationSpeed = (event) => {
    settingsController.setAnimationSpeed(Number(event.currentTarget.value))
  }
  const animationSpeed = createSelectField({
    id: 'animation-speed-setting',
    label: 'Animation speed',
    setting: 'animation-speed',
    options: ANIMATION_SPEEDS.map((value) => ({
      value: String(value),
      text: `${value}×`,
    })),
    onChange: handleAnimationSpeed,
  })

  const reductionValues = Object.freeze({
    system: null,
    reduce: true,
    full: false,
  })
  const handleReducedMotion = (event) => {
    settingsController.setReducedMotionOverride(reductionValues[event.currentTarget.value])
  }
  const reducedMotion = createSelectField({
    id: 'reduced-motion-setting',
    label: 'Animation reduction',
    setting: 'reduced-motion',
    options: [
      { value: 'system', text: 'Use system preference' },
      { value: 'reduce', text: 'Reduce motion' },
      { value: 'full', text: 'Full motion' },
    ],
    onChange: handleReducedMotion,
  })

  controls.append(
    quality.field,
    renderScale.field,
    animationSpeed.field,
    reducedMotion.field,
  )

  const storageStatus = document.createElement('p')
  storageStatus.className = 'settings-status'
  storageStatus.dataset.settingsStatus = ''
  storageStatus.setAttribute('role', 'status')
  storageStatus.setAttribute('aria-live', 'polite')
  storageStatus.textContent = 'Storage is unavailable. Changes apply to this session only.'

  const backButton = createButton('Back to Main Menu', onBack)
  backButton.dataset.action = 'back'

  presentationHost.append(controlsHeading, controls, storageStatus)
  panel.append(heading, gameplayHost, presentationHost, backButton)
  element.append(panel)

  const unsubscribe = settingsController.subscribe((settings) => {
    burnEnabled.select.value = settings.burnEnabled ? 'enabled' : 'disabled'
    quality.select.value = settings.quality
    renderScale.select.value = String(settings.renderScaleCap)
    animationSpeed.select.value = String(settings.animationSpeed)
    reducedMotion.select.value = settings.reducedMotionOverride === null
      ? 'system'
      : settings.reducedMotionOverride ? 'reduce' : 'full'
    storageStatus.hidden = settingsController.persistent
  })

  return {
    element,
    teardown() {
      unsubscribe()
      burnEnabled.select.removeEventListener('change', handleBurnEnabled)
      quality.select.removeEventListener('change', handleQuality)
      renderScale.select.removeEventListener('change', handleRenderScale)
      animationSpeed.select.removeEventListener('change', handleAnimationSpeed)
      reducedMotion.select.removeEventListener('change', handleReducedMotion)
      backButton.removeEventListener('click', onBack)
    },
  }
}

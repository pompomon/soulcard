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

  const handleResume = () => {
    if (resumeAvailable) onResume()
  }
  const resumeButton = createButton('Resume Game', handleResume)
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
      resumeButton.removeEventListener('click', handleResume)
      settingsButton.removeEventListener('click', onSettings)
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

  const settingsHost = document.createElement('section')
  settingsHost.className = 'settings-host'
  settingsHost.dataset.settingsHost = ''
  settingsHost.setAttribute('aria-labelledby', 'settings-controls-title')

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

  settingsHost.append(controlsHeading, controls, storageStatus)
  panel.append(heading, settingsHost, backButton)
  element.append(panel)

  const unsubscribe = settingsController.subscribe((settings) => {
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
      quality.select.removeEventListener('change', handleQuality)
      renderScale.select.removeEventListener('change', handleRenderScale)
      animationSpeed.select.removeEventListener('change', handleAnimationSpeed)
      reducedMotion.select.removeEventListener('change', handleReducedMotion)
      backButton.removeEventListener('click', onBack)
    },
  }
}

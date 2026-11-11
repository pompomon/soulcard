import { CARD_ART_LABELS } from '../app/card-art.js'
import {
  ANIMATION_SPEEDS,
  CARD_ART_OPTIONS,
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
    'setCardArt',
  ]
  if (
    settingsController === null
    || typeof settingsController !== 'object'
    || methods.some((method) => typeof settingsController[method] !== 'function')
  ) {
    throw new TypeError('settingsController must implement the settings controller interface')
  }
}

function assertCardArt(cardArt) {
  const methods = ['getSnapshot', 'subscribe', 'retry', 'removeDownload', 'refresh']
  if (
    cardArt !== undefined
    && (
      cardArt === null
      || typeof cardArt !== 'object'
      || methods.some((method) => typeof cardArt[method] !== 'function')
    )
  ) {
    throw new TypeError('cardArt must implement the card-art controller interface')
  }
}

function reportError(error) {
  try {
    globalThis.reportError?.(error)
  } catch {}
}

function runReported(operation) {
  try {
    return Promise.resolve(operation()).catch((error) => {
      reportError(error)
      return undefined
    })
  } catch (error) {
    reportError(error)
    return Promise.resolve(undefined)
  }
}

const CARD_ART_SUITS = 'Suits: Cups ♥, Pentacles ♦, Wands ♣, Swords ♠.'
const RETRYABLE_HD_STATUSES = new Set(['failed', 'offline', 'paused'])
const HD_FAILURE_TEXT = Object.freeze({
  quota: "There isn't enough storage for HD card art. Pixel card art is in use.",
  network: "HD card art couldn't be downloaded. Pixel card art is in use.",
  integrity: "HD card art couldn't be downloaded. Pixel card art is in use.",
  decode: "HD card art couldn't be loaded. Pixel card art is in use.",
  missing: "HD card art couldn't be loaded. Pixel card art is in use.",
  unsupported: "This browser can't show HD card art. Pixel card art is in use.",
})

function megabytes(bytes) {
  return (bytes / 1_000_000).toFixed(1)
}

function knownTotal(hd) {
  return Number.isFinite(hd.totalBytes) && hd.totalBytes > 0
}

function cardArtHintText(hd) {
  return knownTotal(hd)
    ? `HD downloads about ${megabytes(hd.totalBytes)} MB once and then works offline. ${CARD_ART_SUITS}`
    : `HD downloads once and then works offline. ${CARD_ART_SUITS}`
}

function cardArtStatusText({ requested, hd }) {
  if (requested !== 'tarot-hd') return 'Pixel card art is in use.'
  switch (hd.status) {
    case 'downloading':
      return knownTotal(hd)
        ? `Downloading HD card art: ${megabytes(hd.loadedBytes)} of ${megabytes(hd.totalBytes)} MB. Pixel card art is in use until it finishes.`
        : 'Downloading HD card art. Pixel card art is in use until it finishes.'
    case 'preparing':
      return 'Preparing HD card art…'
    case 'ready':
      return hd.sessionOnly
        ? 'HD card art is in use for this session only. It downloads again next time.'
        : 'HD card art is ready and works offline.'
    case 'offline':
      return 'Connect to the internet to download HD card art. Pixel card art is in use.'
    case 'paused':
      return 'Data saver is on. Select Retry to download HD card art.'
    case 'failed':
      return HD_FAILURE_TEXT[hd.reason] ?? HD_FAILURE_TEXT.network
    default:
      return 'Checking HD card art…'
  }
}

// The live status changes only with the state or a quarter of the download, so
// screen readers aren't flooded with progress.
function cardArtStatusKey({ requested, hd }) {
  const quarter = hd.status === 'downloading' && knownTotal(hd)
    ? Math.min(4, Math.floor((hd.loadedBytes / hd.totalBytes) * 4))
    : null
  return [requested, hd.status, hd.reason, hd.sessionOnly, quarter].join('|')
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
  onCampaign = () => {},
  onResume,
  onSettings,
  onDiscard,
} = {}) {
  if (typeof resumeAvailable !== 'boolean') {
    throw new TypeError('resumeAvailable must be a boolean')
  }
  assertRunController(runController)
  assertCallback(onStart, 'onStart')
  assertCallback(onCampaign, 'onCampaign')
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
  const campaignButton = createButton('Campaign', onCampaign)
  campaignButton.dataset.action = 'campaign'

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
  status.setAttribute('aria-atomic', 'true')

  actions.append(startButton, campaignButton, resumeButton, discardButton, settingsButton)
  panel.append(eyebrow, heading, status, actions)
  element.append(panel)

  const unsubscribe = runController.subscribe((snapshot) => {
    const discarding = snapshot.discardStatus === 'discarding'
    const resumable = resumeAvailable && snapshot.match !== null && snapshot.match !== undefined
    status.textContent = mainStatusText(snapshot)
    startButton.disabled = discarding
    campaignButton.disabled = discarding
    resumeButton.disabled = discarding || !resumable
    discardButton.hidden = snapshot.restoreStatus !== 'recovery-required'
    discardButton.disabled = discarding
  })

  return {
    element,
    teardown() {
      unsubscribe()
      startButton.removeEventListener('click', onStart)
      campaignButton.removeEventListener('click', onCampaign)
      resumeButton.removeEventListener('click', handleResume)
      settingsButton.removeEventListener('click', onSettings)
      discardButton.removeEventListener('click', handleDiscard)
    },
  }
}

export function createSettingsScreen({ onBack, settingsController, cardArt } = {}) {
  assertCallback(onBack, 'onBack')
  assertSettingsController(settingsController)
  assertCardArt(cardArt)

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

  const handleCardArt = (event) => settingsController.setCardArt(event.currentTarget.value)
  const cardArtField = createSelectField({
    id: 'card-art-setting',
    label: 'Card art',
    setting: 'card-art',
    options: CARD_ART_OPTIONS.map((value) => ({ value, text: CARD_ART_LABELS[value] })),
    onChange: handleCardArt,
  })
  const cardArtHint = document.createElement('p')
  cardArtHint.id = 'card-art-hint'
  cardArtHint.className = 'settings-hint'
  cardArtHint.textContent = cardArtHintText({ totalBytes: null })
  cardArtField.select.setAttribute('aria-describedby', cardArtHint.id)
  cardArtField.field.append(cardArtHint)

  const cardArtStatusBlock = document.createElement('div')
  cardArtStatusBlock.className = 'card-art-status'
  cardArtStatusBlock.dataset.cardArtStatusBlock = ''
  cardArtStatusBlock.hidden = cardArt === undefined

  const cardArtStatus = document.createElement('p')
  cardArtStatus.className = 'card-art-status__text'
  cardArtStatus.dataset.cardArtStatus = ''
  cardArtStatus.setAttribute('role', 'status')
  cardArtStatus.setAttribute('aria-live', 'polite')
  cardArtStatus.setAttribute('aria-atomic', 'true')

  const cardArtProgress = document.createElement('progress')
  cardArtProgress.className = 'card-art-status__progress'
  cardArtProgress.dataset.cardArtProgress = ''
  cardArtProgress.setAttribute('aria-label', 'HD card art download')
  cardArtProgress.hidden = true

  let tornDown = false
  let removePending = false
  let lastStatusKey = null

  const handleRetry = () => {
    if (cardArt === undefined) return
    void runReported(() => cardArt.retry())
  }
  const retryButton = createButton('Retry HD download', handleRetry)
  retryButton.dataset.action = 'retry-hd'
  retryButton.hidden = true

  // Removal takes moments, so repeated clicks are ignored rather than disabling
  // the focused button.
  const handleRemove = () => {
    if (cardArt === undefined || removePending) return
    removePending = true
    void runReported(() => cardArt.removeDownload()).then((removed) => {
      removePending = false
      if (tornDown) return
      renderCardArt(cardArt.getSnapshot())
      if (removed === true) {
        cardArtStatus.textContent = 'HD card art download removed. Pixel card art is in use.'
      }
    })
  }
  const removeButton = createButton('Remove HD download', handleRemove)
  removeButton.dataset.action = 'remove-hd'
  removeButton.hidden = true

  cardArtStatusBlock.append(cardArtStatus, cardArtProgress, retryButton, removeButton)

  // A focused button that disappears would drop focus to the document, so the
  // focus moves to the Card art select instead.
  function setButtonVisible(button, visible) {
    if (!visible && !button.hidden && document.activeElement === button) {
      cardArtField.select.focus()
    }
    button.hidden = !visible
  }

  function renderCardArt(snapshot) {
    const { requested, hd } = snapshot
    const key = cardArtStatusKey(snapshot)
    if (key !== lastStatusKey) {
      lastStatusKey = key
      cardArtStatus.textContent = cardArtStatusText(snapshot)
    }
    cardArtHint.textContent = cardArtHintText(hd)
    const downloading = requested === 'tarot-hd'
      && hd.status === 'downloading'
      && knownTotal(hd)
    cardArtProgress.hidden = !downloading
    if (downloading) {
      cardArtProgress.max = hd.totalBytes
      cardArtProgress.value = Math.min(hd.loadedBytes, hd.totalBytes)
    }
    setButtonVisible(
      retryButton,
      requested === 'tarot-hd' && RETRYABLE_HD_STATUSES.has(hd.status),
    )
    setButtonVisible(
      removeButton,
      requested === 'tarot-pixel' && hd.status === 'idle' && hd.loadedBytes > 0,
    )
  }

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
    cardArtField.field,
    cardArtStatusBlock,
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
  storageStatus.setAttribute('aria-atomic', 'true')
  storageStatus.textContent = 'Storage is unavailable. Changes apply to this session only.'

  const backButton = createButton('Back to Main Menu', onBack)
  backButton.dataset.action = 'back'

  presentationHost.append(controlsHeading, controls, storageStatus)
  panel.append(heading, gameplayHost, presentationHost, backButton)
  element.append(panel)

  const unsubscribe = settingsController.subscribe((settings) => {
    burnEnabled.select.value = settings.burnEnabled ? 'enabled' : 'disabled'
    cardArtField.select.value = settings.cardArt
    quality.select.value = settings.quality
    renderScale.select.value = String(settings.renderScaleCap)
    animationSpeed.select.value = String(settings.animationSpeed)
    reducedMotion.select.value = settings.reducedMotionOverride === null
      ? 'system'
      : settings.reducedMotionOverride ? 'reduce' : 'full'
    storageStatus.hidden = settingsController.persistent
  })
  let unsubscribeCardArt = () => {}
  if (cardArt !== undefined) {
    try {
      unsubscribeCardArt = cardArt.subscribe(renderCardArt)
    } catch (error) {
      unsubscribe()
      throw error
    }
    // Reads the pack size and any stored HD files; it never downloads art.
    void runReported(() => cardArt.refresh())
  }

  return {
    element,
    teardown() {
      tornDown = true
      unsubscribe()
      unsubscribeCardArt()
      burnEnabled.select.removeEventListener('change', handleBurnEnabled)
      cardArtField.select.removeEventListener('change', handleCardArt)
      retryButton.removeEventListener('click', handleRetry)
      removeButton.removeEventListener('click', handleRemove)
      quality.select.removeEventListener('change', handleQuality)
      renderScale.select.removeEventListener('change', handleRenderScale)
      animationSpeed.select.removeEventListener('change', handleAnimationSpeed)
      reducedMotion.select.removeEventListener('change', handleReducedMotion)
      backButton.removeEventListener('click', onBack)
    },
  }
}

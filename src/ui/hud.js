import { createEndOverlay, createPauseOverlay } from './overlays.js'
import { UPDATE_BLOCKED_EVENT } from './update-notice.js'
import { createAutoRevealCoordinator } from '../app/auto-reveal-coordinator.js'
import { createEventPlayer } from '../presentation/event-player.js'
import { createInputController } from '../presentation/input.js'

const ACTIVE_PRESENTATION_STATUSES = new Set(['queued', 'playing', 'paused'])
const NO_AUTO_REVEAL_COORDINATOR = Object.freeze({
  continueAfterPresentation: () => Promise.resolve(null),
  stop() {},
  destroy() {},
})

function createTextElement(tagName, className, text) {
  const element = document.createElement(tagName)
  element.className = className
  element.textContent = text
  return element
}

function assertCallback(callback, name) {
  if (typeof callback !== 'function') {
    throw new TypeError(`${name} must be a function`)
  }
}

function createMetric(label, key) {
  const wrapper = document.createElement('div')
  wrapper.className = 'hud-metric'

  const term = document.createElement('dt')
  term.textContent = label

  const value = document.createElement('dd')
  value.dataset.value = key
  value.textContent = '—'

  wrapper.append(term, value)
  return wrapper
}

function setMetricValue(element, key, value) {
  if (element.dataset?.value === key) {
    element.textContent = String(value)
    return true
  }
  for (const child of element.children ?? []) {
    if (setMetricValue(child, key, value)) return true
  }
  return false
}

function saveWarningText(reason) {
  return `Save failed${reason ? ` (${reason})` : ''}. Your game remains available in this session.`
}

// Run snapshots use idle/unsaved/saving/saved/failed; save completions use
// saved/storage-unavailable. Transient unsaved/saving states preserve warnings.
function isSaveFailureStatus(status) {
  return status === 'failed' || status === 'storage-unavailable'
}

function clearsSaveWarning(status) {
  return status === 'saved' || status === 'idle'
}

function createSidePanel(side, label) {
  const panel = document.createElement('section')
  panel.className = `zone-panel zone-panel--${side}`
  panel.setAttribute('aria-labelledby', `${side}-zones-title`)

  const heading = createTextElement('h2', 'zone-panel__title', label)
  heading.id = `${side}-zones-title`

  const metrics = document.createElement('dl')
  metrics.className = 'hud-metrics'
  metrics.append(
    createMetric('Draw pile', `${side}-draw-count`),
    createMetric('Won pile', `${side}-won-count`),
  )

  panel.append(heading, metrics)
  return panel
}

function assertRunController(runController) {
  const methods = [
    'getSnapshot',
    'subscribe',
    'revealOrContinue',
    'pause',
    'resume',
    'saveStable',
  ]
  if (
    runController !== null
    && runController !== undefined
    && (
      typeof runController !== 'object'
      || methods.some((method) => typeof runController[method] !== 'function')
    )
  ) {
    throw new TypeError('runController must implement the Game run controller interface')
  }
}

function assertInputControllerFactory(inputControllerFactory) {
  if (typeof inputControllerFactory !== 'function') {
    throw new TypeError('inputControllerFactory must be a function')
  }
}

function assertInputController(inputController) {
  const methods = ['setEnabled', 'setBusy', 'destroy']
  if (
    inputController === null
    || typeof inputController !== 'object'
    || methods.some((method) => typeof inputController[method] !== 'function')
  ) {
    throw new TypeError('inputControllerFactory must return a compatible input controller')
  }
}

function stageText(stage) {
  return stage === 'personal' ? 'Personal' : 'Source'
}

function sideText(side) {
  return side === 'player' ? 'Player' : 'Opponent'
}

function countText(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`
}

function tiedRoundCount(event) {
  const completeRounds = Math.floor(event.reveals.length / 2)
  if (event.type === 'clashDrawn' || event.reveals.length % 2 === 1) {
    return completeRounds
  }
  return Math.max(0, completeRounds - 1)
}

function comparisonText(match) {
  const event = match?.pendingEvent
  if (match === null || match === undefined) {
    return {
      result: 'No active match',
      details: 'Start or resume a game to reveal cards.',
    }
  }
  if (event === null) {
    return {
      result: 'Ready for the first reveal',
      details: 'No cards have been revealed yet.',
    }
  }

  const ties = tiedRoundCount(event)
  const burned = event.type === 'clashSettled' ? event.burned.length : 0
  const details = [
    `${countText(event.reveals.length, 'card')} revealed`,
    countText(ties, 'tie'),
    `${burned} burned`,
  ].join(' · ')

  if (match.outcome?.result === 'win') {
    return {
      result: `${sideText(match.outcome.winner)} won the match`,
      details: `Final clash: ${details}`,
    }
  }
  if (match.outcome?.result === 'draw') {
    return {
      result: 'The match ended in a draw',
      details: `Final clash: ${details}`,
    }
  }
  return {
    result: `${sideText(event.winner)} won clash ${event.turn}`,
    details,
  }
}

function presentationStatusText(state) {
  if (state.status === 'queued') return 'Committed clash ready to present.'
  if (state.status === 'paused') return 'Presentation paused.'
  if (state.status === 'skipped') return 'Presentation skipped for reduced motion.'
  if (state.status === 'completed') return 'Clash presentation complete.'
  if (state.status === 'failed') return 'Presentation skipped after a rendering error.'
  if (state.status !== 'playing') return null
  if (state.stepKind === 'reveal') return 'Revealing committed card.'
  if (state.stepKind === 'transfer') return 'Transferring committed cards.'
  if (state.stepKind === 'burn') return 'Burning committed cards.'
  if (state.stepKind === 'retain') return 'The unresolved contest is retained.'
  return 'Presenting committed clash.'
}

function presentationProgressText(state) {
  if (state.status === 'queued') return 'Presentation queued.'
  if (state.status === 'paused') return 'Presentation paused.'
  if (state.status === 'completed') return 'Presentation complete.'
  if (state.status === 'skipped') return 'Presentation skipped.'
  if (state.status === 'failed') return 'Presentation recovered after a rendering error.'
  if (state.status !== 'playing') return 'Ready.'

  const step = state.stepIndex === null ? 0 : state.stepIndex + 1
  const labels = {
    reveal: 'Revealing cards',
    transfer: 'Transferring won cards',
    burn: 'Burning cards',
    retain: 'Retaining the unresolved contest',
  }
  return `${labels[state.stepKind] ?? 'Presenting clash'} · ${step} of ${state.stepCount}`
}

function terminalStatusText(outcome) {
  if (outcome?.result === 'win') {
    return `${sideText(outcome.winner)} won the match.`
  }
  return 'The match ended in a draw.'
}

export function createGameScreen({
  mountBattlefield,
  settingsController,
  runController,
  autoRevealCoordinator = runController
    ? createAutoRevealCoordinator({ runController })
    : NO_AUTO_REVEAL_COORDINATOR,
  eventPlayerFactory = createEventPlayer,
  inputControllerFactory = createInputController,
  onMainMenu = () => {},
  onRestart = () => false,
} = {}) {
  if (typeof mountBattlefield !== 'function') {
    throw new TypeError('mountBattlefield must be a function')
  }
  assertRunController(runController)
  if (
    autoRevealCoordinator === null
    || typeof autoRevealCoordinator !== 'object'
    || typeof autoRevealCoordinator.continueAfterPresentation !== 'function'
    || typeof autoRevealCoordinator.stop !== 'function'
    || typeof autoRevealCoordinator.destroy !== 'function'
  ) {
    throw new TypeError('autoRevealCoordinator must implement the auto-reveal interface')
  }
  if (typeof eventPlayerFactory !== 'function') {
    throw new TypeError('eventPlayerFactory must be a function')
  }
  assertInputControllerFactory(inputControllerFactory)
  assertCallback(onMainMenu, 'onMainMenu')
  assertCallback(onRestart, 'onRestart')

  const element = document.createElement('main')
  element.className = 'screen screen--game'
  element.dataset.screen = 'game'
  element.setAttribute('aria-labelledby', 'game-screen-title')

  const battlefieldHost = document.createElement('div')
  battlefieldHost.className = 'battlefield'
  battlefieldHost.dataset.battlefield = ''
  battlefieldHost.setAttribute('aria-hidden', 'true')

  const hud = document.createElement('div')
  hud.className = 'game-hud'

  const header = document.createElement('header')
  header.className = 'game-hud__header'

  const heading = createTextElement('h1', 'screen-title screen-title--compact', 'Soulcard')
  heading.id = 'game-screen-title'

  const matchMetrics = document.createElement('dl')
  matchMetrics.className = 'hud-metrics hud-metrics--match'
  matchMetrics.append(
    createMetric('Stage', 'stage'),
    createMetric('Source deck', 'source-count'),
  )
  header.append(heading, matchMetrics)

  const opponentPanel = createSidePanel('opponent', 'Opponent')
  const playerPanel = createSidePanel('player', 'Player')

  const comparison = document.createElement('section')
  comparison.className = 'comparison-area'
  comparison.dataset.comparisonHost = ''
  comparison.setAttribute('aria-labelledby', 'comparison-title')
  const comparisonHeading = createTextElement('h2', 'visually-hidden', 'Reveal comparison')
  comparisonHeading.id = 'comparison-title'
  const comparisonResult = createTextElement(
    'p',
    'comparison-result',
    'No active match',
  )
  comparisonResult.dataset.comparisonResult = ''
  const comparisonDetails = createTextElement(
    'p',
    'comparison-details',
    'Start or resume a game to reveal cards.',
  )
  comparisonDetails.dataset.comparisonDetails = ''
  const comparisonProgress = createTextElement(
    'p',
    'comparison-progress',
    'Ready.',
  )
  comparisonProgress.dataset.comparisonProgress = ''
  comparison.append(
    comparisonHeading,
    comparisonResult,
    comparisonDetails,
    comparisonProgress,
  )

  const pileMetrics = document.createElement('dl')
  pileMetrics.className = 'hud-metrics hud-metrics--piles'
  pileMetrics.append(
    createMetric('Contested pile', 'contested-count'),
    createMetric('Burn pile', 'burn-count'),
  )

  const status = createTextElement(
    'p',
    'game-status',
    'Game setup is not connected yet.',
  )
  status.dataset.statusHost = ''
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')

  const saveWarning = createTextElement('p', 'game-save-warning', '')
  saveWarning.dataset.saveWarning = ''
  saveWarning.setAttribute('role', 'status')
  saveWarning.setAttribute('aria-live', 'polite')
  saveWarning.hidden = true

  const feedback = document.createElement('div')
  feedback.className = 'game-feedback'
  feedback.append(saveWarning, status)

  const controls = document.createElement('div')
  controls.className = 'game-controls'
  controls.dataset.primaryActionHost = ''

  const revealButton = createTextElement('button', 'game-button game-button--primary', 'Reveal / Continue')
  revealButton.type = 'button'
  revealButton.dataset.action = 'reveal'
  revealButton.disabled = true

  const autoRevealLabel = document.createElement('label')
  autoRevealLabel.className = 'auto-reveal-toggle'
  const autoRevealCheckbox = document.createElement('input')
  autoRevealCheckbox.className = 'auto-reveal-toggle__input'
  autoRevealCheckbox.type = 'checkbox'
  autoRevealCheckbox.dataset.action = 'auto-reveal'
  autoRevealCheckbox.checked = false
  const autoRevealText = createTextElement('span', 'auto-reveal-toggle__label', 'Auto-reveal')
  autoRevealLabel.append(autoRevealCheckbox, autoRevealText)

  const pauseButton = createTextElement('button', 'game-button', 'Pause')
  pauseButton.type = 'button'
  pauseButton.dataset.action = 'pause'
  pauseButton.disabled = true

  controls.append(revealButton, autoRevealLabel, pauseButton)
  hud.append(header, opponentPanel, comparison, playerPanel, pileMetrics, feedback, controls)

  const overlayHost = document.createElement('div')
  overlayHost.className = 'game-overlays'
  overlayHost.dataset.overlayHost = ''

  let destroyed = false
  let overlayAction = null
  let overlayError = null
  const handleResume = () => {
    if (overlayAction !== null) return
    overlayError = null
    try {
      runController?.resume()
    } catch {
      overlayError = 'Resume could not be completed. Try again.'
      renderHud()
    }
  }
  const handleSaveAndMain = () => {
    if (overlayAction !== null) return
    overlayAction = 'save-main'
    overlayError = null
    renderHud()

    let save
    try {
      save = runController?.saveStable()
    } catch {
      overlayAction = null
      overlayError = 'Save failed. Stay paused and try again.'
      renderHud()
      return
    }
    Promise.resolve(save)
      .then((result) => {
        if (destroyed) return
        if (result?.status !== 'saved') {
          overlayAction = null
          overlayError = `Save failed${result?.reason ? ` (${result.reason})` : ''}. Stay paused and try again.`
          renderHud()
          return
        }
        overlayAction = 'main'
        renderHud()
        try {
          onMainMenu()
        } catch {
          overlayAction = null
          overlayError = 'The main menu could not be opened. Try again.'
          renderHud()
        }
      })
      .catch(() => {
        if (destroyed) return
        overlayAction = null
        overlayError = 'Save failed. Stay paused and try again.'
        renderHud()
      })
  }
  const handleRestart = () => {
    if (overlayAction !== null) return
    overlayAction = 'restart'
    overlayError = null
    renderHud()

    let restarted
    try {
      restarted = onRestart()
    } catch {
      overlayAction = null
      overlayError = 'A new game could not be started. Try again.'
      renderHud()
      return
    }
    Promise.resolve(restarted)
      .then((accepted) => {
        if (destroyed || accepted === true) return
        overlayAction = null
        renderHud()
      })
      .catch(() => {
        if (destroyed) return
        overlayAction = null
        overlayError = 'A new game could not be started. Try again.'
        renderHud()
      })
  }
  const handleEndMain = () => {
    if (overlayAction !== null) return
    overlayAction = 'main'
    overlayError = null
    renderHud()
    try {
      onMainMenu()
    } catch {
      overlayAction = null
      overlayError = 'The main menu could not be opened. Try again.'
      renderHud()
    }
  }
  const pauseOverlay = createPauseOverlay({
    onResume: handleResume,
    onSaveAndMain: handleSaveAndMain,
    onRestart: handleRestart,
  })
  const endOverlay = createEndOverlay({
    onMainMenu: handleEndMain,
    onRestart: handleRestart,
  })
  overlayHost.append(pauseOverlay.element, endOverlay.element)

  element.append(battlefieldHost, hud, overlayHost)
  let requestReveal = () => {}

  const applyLayout = (layout) => {
    element.dataset.layoutMode = layout.mode
    element.dataset.letterboxed = String(layout.viewport.letterboxed)
    element.style?.setProperty?.('--battlefield-layout-scale', String(layout.viewport.scale))
    element.style?.setProperty?.(
      '--hud-control-min-size',
      `${44 / layout.viewport.scale}px`,
    )
    element.style?.setProperty?.(
      '--battlefield-logical-width',
      `${layout.viewport.logicalWidth}px`,
    )
    element.style?.setProperty?.(
      '--battlefield-logical-height',
      `${layout.viewport.logicalHeight}px`,
    )
    element.style?.setProperty?.('--hud-header-reserve', `${layout.hud.header.height}px`)
    element.style?.setProperty?.(
      '--hud-comparison-reserve',
      `${layout.hud.comparison.height}px`,
    )
    element.style?.setProperty?.('--hud-footer-reserve', `${layout.hud.footer.height}px`)
    element.style?.setProperty?.('--hud-side-reserve', `${layout.hud.leftPanel.width}px`)
    for (const [side, value] of Object.entries(layout.safeArea)) {
      element.style?.setProperty?.(`--safe-area-${side}`, `${value}px`)
    }
  }
  const battlefieldMount = mountBattlefield(battlefieldHost, {
    settingsController,
    onLayout: applyLayout,
    onDeckActivate: (event) => requestReveal(event),
    inputControllerFactory,
  })
  const battlefield = typeof battlefieldMount === 'function'
    ? { teardown: battlefieldMount }
    : battlefieldMount ?? {}
  if (
    (battlefield.teardown !== undefined && typeof battlefield.teardown !== 'function')
    || (battlefield.setPaused !== undefined && typeof battlefield.setPaused !== 'function')
    || (battlefield.syncSnapshot !== undefined
      && typeof battlefield.syncSnapshot !== 'function')
    || (battlefield.beginEvent !== undefined && typeof battlefield.beginEvent !== 'function')
    || (battlefield.applyStep !== undefined && typeof battlefield.applyStep !== 'function')
    || (battlefield.cancelEvent !== undefined && typeof battlefield.cancelEvent !== 'function')
    || (battlefield.setDeckInputState !== undefined
      && typeof battlefield.setDeckInputState !== 'function')
  ) {
    throw new TypeError(
      'mountBattlefield must return a presentation handle, teardown function, or undefined',
    )
  }

  const presentationAdapter = Object.freeze({
    syncSnapshot: (...args) => battlefield.syncSnapshot?.(...args),
    beginEvent: (...args) => battlefield.beginEvent?.(...args),
    applyStep: (...args) => battlefield.applyStep?.(...args),
    cancelEvent: (...args) => battlefield.cancelEvent?.(...args),
    setPaused: (...args) => battlefield.setPaused?.(...args),
  })
  let latestSnapshot = runController?.getSnapshot() ?? Object.freeze({
    match: null,
    saveStatus: 'idle',
    saveReason: null,
  })
  let presentationState = Object.freeze({
    status: 'idle',
    eventId: null,
    stepIndex: null,
    stepCount: 0,
    stepKind: null,
    reason: null,
  })
  let presentationFailure = false
  let interactionFailure = null
  let revealActionPending = false
  let revealActionEventId = null
  let autoRevealChainActive = false
  let pauseActionPending = false
  let revealInput = null
  let pauseInput = null
  const queuedEventIds = new Set()
  const settledEventIds = new Set()
  const presentationJobs = new Map()
  let saveWarningFailure = null
  const handleUpdateBlocked = () => {
    autoRevealChainActive = false
    autoRevealCoordinator.stop()
  }
  element.addEventListener(UPDATE_BLOCKED_EVENT, handleUpdateBlocked)

  const renderSaveWarning = () => {
    if (saveWarningFailure !== null) {
      saveWarning.textContent = saveWarningText(saveWarningFailure.reason)
      saveWarning.hidden = false
    } else {
      saveWarning.textContent = ''
      saveWarning.hidden = true
    }
  }
  const showSaveWarning = (saveReason) => {
    saveWarningFailure = { reason: saveReason ?? null }
    renderSaveWarning()
  }
  const clearSaveWarning = () => {
    saveWarningFailure = null
    renderSaveWarning()
  }

  function renderMetrics() {
    const match = latestSnapshot?.match
    const metrics = match === null || match === undefined
      ? {
          stage: '—',
          'source-count': '—',
          'player-draw-count': '—',
          'player-won-count': '—',
          'opponent-draw-count': '—',
          'opponent-won-count': '—',
          'contested-count': '—',
          'burn-count': '—',
        }
      : {
          stage: stageText(match.stage),
          'source-count': match.zones.sourceDeck.length,
          'player-draw-count': match.zones.player.drawPile.length,
          'player-won-count': match.zones.player.wonPile.length,
          'opponent-draw-count': match.zones.opponent.drawPile.length,
          'opponent-won-count': match.zones.opponent.wonPile.length,
          'contested-count': match.zones.contestedPile.length,
          'burn-count': match.zones.burnPile.length,
        }
    for (const [key, value] of Object.entries(metrics)) {
      setMetricValue(element, key, value)
    }
  }

  function renderComparison() {
    const copy = comparisonText(latestSnapshot?.match)
    comparisonResult.textContent = copy.result
    comparisonDetails.textContent = copy.details
    comparisonProgress.textContent = latestSnapshot?.match
      ? presentationProgressText(presentationState)
      : 'Waiting for a match.'
  }

  function renderStatus() {
    const snapshot = latestSnapshot ?? {}
    const match = snapshot.match
    let message
    if (match === null || match === undefined) {
      message = 'Game setup is not connected yet.'
    } else if (match.machineState === 'paused') {
      message = 'Game paused. Resume to continue.'
    } else if (snapshot.saveStatus === 'saving' && match.turn === 0) {
      message = 'Saving new game…'
    } else if (snapshot.saveStatus === 'saving' && match.pendingEvent !== null) {
      message = 'Saving committed clash…'
    } else if (
      queuedEventIds.size > 0
      && ACTIVE_PRESENTATION_STATUSES.has(presentationState.status)
      && queuedEventIds.has(presentationState.eventId)
    ) {
      message = presentationStatusText(presentationState)
    } else if (queuedEventIds.size > 0) {
      message = 'Committed clash ready to present.'
    } else if (ACTIVE_PRESENTATION_STATUSES.has(presentationState.status)) {
      message = presentationStatusText(presentationState)
    } else if (interactionFailure !== null) {
      message = interactionFailure
    } else if (presentationFailure || presentationState.status === 'failed') {
      message = 'Presentation skipped after a rendering error.'
    } else if (match.status === 'ended') {
      message = terminalStatusText(match.outcome)
    } else if (presentationState.status === 'skipped') {
      message = 'Presentation skipped for reduced motion.'
    } else if (presentationState.status === 'completed') {
      message = 'Clash presentation complete. Reveal / Continue for the next clash.'
    } else if (match.turn === 0) {
      message = 'Ready. Reveal the first clash.'
    } else {
      message = 'Ready. Reveal / Continue for the next clash.'
    }
    status.textContent = message
    status.dataset.presentationState = presentationState.status
  }

  function updateControls() {
    const match = latestSnapshot?.match
    const initialSavePending = (
      match?.turn === 0
      && latestSnapshot?.saveStatus === 'saving'
    )
    const matchReady = (
      match?.status === 'active'
      && match.machineState === 'ready'
      && !initialSavePending
    )
    const presentationActive = (
      queuedEventIds.size > 0
      || ACTIVE_PRESENTATION_STATUSES.has(presentationState.status)
    )
    const revealBusy = revealActionPending || presentationActive
    revealInput?.setEnabled(matchReady)
    revealInput?.setBusy(revealBusy)
    battlefield.setDeckInputState?.({
      enabled: matchReady,
      busy: revealBusy,
    })
    pauseInput?.setEnabled(matchReady)
    pauseInput?.setBusy(pauseActionPending)
    autoRevealCheckbox.disabled = (
      match?.status !== 'active'
      || match.machineState === 'paused'
    )
    if (revealInput === null) revealButton.disabled = !matchReady || revealBusy
    if (pauseInput === null) pauseButton.disabled = !matchReady || pauseActionPending
  }

  function terminalPresentationSettled() {
    const match = latestSnapshot?.match
    if (match?.status !== 'ended') return false
    if (!['saved', 'failed'].includes(latestSnapshot.saveStatus)) return false
    const eventId = match.pendingEvent?.id
    if (eventId === undefined) return true
    return (
      settledEventIds.has(eventId)
      || (
        presentationState.eventId === eventId
        && ['completed', 'skipped', 'failed'].includes(presentationState.status)
      )
    )
  }

  function renderOverlays() {
    const endVisible = terminalPresentationSettled()
    const paused = latestSnapshot?.match?.machineState === 'paused'
    pauseOverlay.element.hidden = !paused || endVisible
    endOverlay.element.hidden = !endVisible
    const actionState = {
      action: overlayAction,
      error: overlayError,
    }
    pauseOverlay.update(latestSnapshot, actionState)
    endOverlay.update(latestSnapshot, actionState)
  }

  function renderHud() {
    if (destroyed) return
    renderMetrics()
    renderComparison()
    renderStatus()
    updateControls()
    renderOverlays()
  }

  let eventPlayer
  try {
    eventPlayer = eventPlayerFactory({
      adapter: presentationAdapter,
      settingsController,
      onStateChange(nextState) {
        presentationState = nextState
        if (ACTIVE_PRESENTATION_STATUSES.has(nextState.status)) {
          presentationFailure = false
        }
        renderHud()
      },
      onError() {
        presentationFailure = true
        renderHud()
      },
    })
    if (
      eventPlayer === null
      || typeof eventPlayer !== 'object'
      || typeof eventPlayer.present !== 'function'
      || typeof eventPlayer.setPaused !== 'function'
      || typeof eventPlayer.destroy !== 'function'
    ) {
      throw new TypeError('eventPlayerFactory must return a compatible event player')
    }
  } catch (error) {
    pauseOverlay.teardown()
    endOverlay.teardown()
    battlefield.teardown?.()
    throw error
  }

  const present = (match, { saveSucceeded = false } = {}) => {
    const eventId = match.pendingEvent?.id
    if (eventId !== undefined && presentationJobs.has(eventId)) {
      return presentationJobs.get(eventId)
    }
    if (eventId !== undefined && settledEventIds.has(eventId)) {
      return Promise.resolve(Object.freeze({
        status: 'duplicate',
        eventId,
        reason: null,
      }))
    }
    if (eventId !== undefined) queuedEventIds.add(eventId)
    renderHud()

    let presentation
    try {
      presentation = eventPlayer.present(match)
    } catch {
      presentationFailure = true
      if (eventId !== undefined) autoRevealChainActive = false
      if (eventId !== undefined) {
        queuedEventIds.delete(eventId)
        settledEventIds.add(eventId)
      }
      if (eventId === revealActionEventId) {
        revealActionPending = false
        revealActionEventId = null
      }
      renderHud()
      return Promise.resolve(Object.freeze({
        status: 'failed',
        eventId: eventId ?? null,
        reason: 'presentation-error',
      }))
    }

    let settledResult = null
    const finalized = Promise.resolve(presentation)
      .then((result) => {
        settledResult = result
        if (result?.status === 'failed') presentationFailure = true
        if (
          eventId !== undefined
          && ['completed', 'skipped', 'failed', 'cancelled', 'duplicate'].includes(result?.status)
        ) {
          settledEventIds.add(eventId)
        }
        if (
          eventId !== undefined
          && presentationState.eventId === eventId
          && ['completed', 'skipped', 'failed'].includes(result?.status)
        ) {
          presentationState = Object.freeze({
            ...presentationState,
            status: result.status,
            stepIndex: null,
            stepKind: null,
            reason: result.reason ?? null,
          })
        }
        return result
      })
      .catch(() => {
        presentationFailure = true
        if (eventId !== undefined) settledEventIds.add(eventId)
        settledResult = Object.freeze({
          status: 'failed',
          eventId: eventId ?? null,
          reason: 'presentation-error',
        })
        return settledResult
      })
      .finally(() => {
        if (eventId !== undefined) {
          queuedEventIds.delete(eventId)
          presentationJobs.delete(eventId)
        }
        if (eventId === revealActionEventId) {
          revealActionPending = false
          revealActionEventId = null
        }
        if (eventId === undefined) {
          renderHud()
          return
        }

        const active = autoRevealChainActive && !destroyed
        const enabled = autoRevealCheckbox.checked
        const blocked = hud.inert === true
        const continuationExpected = (
          active
          && enabled
          && saveSucceeded
          && !blocked
          && ['completed', 'skipped'].includes(settledResult?.status)
        )
        if (continuationExpected) {
          revealActionPending = true
          interactionFailure = null
          renderHud()
        } else {
          autoRevealChainActive = false
          renderHud()
        }
        const continuation = autoRevealCoordinator.continueAfterPresentation({
          active,
          enabled,
          saveSucceeded,
          presentationStatus: settledResult?.status,
          runId: match.runId,
          eventId,
          blocked,
        })
        Promise.resolve(continuation)
          .then((result) => {
            if (destroyed) return
            if (result?.match?.pendingEvent !== null && result?.match?.pendingEvent !== undefined) {
              revealActionPending = true
              revealActionEventId = result.match.pendingEvent.id
              renderHud()
              return present(result.match, {
                saveSucceeded: result?.save?.status === 'saved',
              })
            }
            revealActionPending = false
            revealActionEventId = null
            autoRevealChainActive = false
            renderHud()
            return undefined
          })
          .catch(() => {
            if (destroyed) return
            revealActionPending = false
            revealActionEventId = null
            autoRevealChainActive = false
            interactionFailure = 'Reveal could not be completed. Try again.'
            renderHud()
          })
      })
    if (eventId !== undefined) presentationJobs.set(eventId, finalized)
    return finalized
  }

  function handleReveal() {
    if (hud.inert === true) {
      autoRevealChainActive = false
      autoRevealCoordinator.stop()
      return
    }
    if (revealActionPending) return
    autoRevealChainActive = autoRevealCheckbox.checked
    revealActionPending = true
    interactionFailure = null
    presentationFailure = false
    renderHud()

    let action
    try {
      action = runController?.revealOrContinue()
      revealActionEventId = latestSnapshot?.match?.pendingEvent?.id ?? null
      renderHud()
    } catch {
      revealActionPending = false
      revealActionEventId = null
      autoRevealChainActive = false
      interactionFailure = 'Reveal could not be completed. Try again.'
      renderHud()
      return
    }

    Promise.resolve(action)
      .then((result) => {
        const committedMatch = result?.match
        if (committedMatch?.pendingEvent !== null && committedMatch?.pendingEvent !== undefined) {
          revealActionEventId ??= committedMatch.pendingEvent.id
          return present(committedMatch, {
            saveSucceeded: result?.save?.status === 'saved',
          })
        }
        revealActionPending = false
        revealActionEventId = null
        autoRevealChainActive = false
        renderHud()
        return undefined
      })
      .catch(() => {
        revealActionPending = false
        revealActionEventId = null
        autoRevealChainActive = false
        interactionFailure = 'Reveal could not be completed. Try again.'
        renderHud()
      })
  }
  const handleAutoRevealChange = () => {
    if (!autoRevealCheckbox.checked) {
      autoRevealChainActive = false
      autoRevealCoordinator.stop()
    }
  }
  autoRevealCheckbox.addEventListener('change', handleAutoRevealChange)
  requestReveal = handleReveal

  const handlePause = () => {
    if (pauseActionPending) return
    autoRevealChainActive = false
    autoRevealCoordinator.stop()
    pauseActionPending = true
    interactionFailure = null
    overlayError = null
    renderHud()

    let action
    try {
      action = runController?.pause()
    } catch {
      pauseActionPending = false
      interactionFailure = 'Pause could not be completed. Try again.'
      renderHud()
      return
    }
    Promise.resolve(action)
      .catch(() => {
        interactionFailure = 'Pause could not be completed. Try again.'
      })
      .finally(() => {
        pauseActionPending = false
        renderHud()
      })
  }

  try {
    revealInput = inputControllerFactory({
      target: revealButton,
      onActivate: handleReveal,
      enabled: false,
    })
    assertInputController(revealInput)
    pauseInput = inputControllerFactory({
      target: pauseButton,
      onActivate: handlePause,
      enabled: false,
    })
    assertInputController(pauseInput)
  } catch (error) {
    revealInput?.destroy?.()
    pauseInput?.destroy?.()
    pauseOverlay.teardown()
    endOverlay.teardown()
    eventPlayer.destroy()
    battlefield.teardown?.()
    throw error
  }
  renderHud()

  const unsubscribeSaves = runController?.subscribeToSaves?.(({ match, result }) => {
    if (match.runId !== latestSnapshot?.match?.runId) return
    if (isSaveFailureStatus(result?.status)) {
      showSaveWarning(result.reason)
    }
    if (match.pendingEvent !== null) {
      present(match, { saveSucceeded: result?.status === 'saved' })
    }
  })
  const unsubscribeRun = runController?.subscribe((snapshot) => {
    latestSnapshot = snapshot
    const { match } = snapshot
    // Keep failures visible through transient unsaved/saving states until a save succeeds.
    if (isSaveFailureStatus(snapshot.saveStatus)) {
      showSaveWarning(snapshot.saveReason)
    } else if (clearsSaveWarning(snapshot.saveStatus)) {
      clearSaveWarning()
    }
    const nextPresentationPaused = match?.machineState === 'paused'
    eventPlayer.setPaused(nextPresentationPaused)

    renderHud()

    const saveSettled = snapshot.saveStatus === 'saved' || snapshot.saveStatus === 'failed'
    if (match !== null && match !== undefined && (match.pendingEvent === null || saveSettled)) {
      present(match, { saveSucceeded: snapshot.saveStatus === 'saved' })
    }
  })

  return {
    element,
    teardown() {
      destroyed = true
      autoRevealCoordinator.destroy()
      requestReveal = () => {}
      unsubscribeRun?.()
      unsubscribeSaves?.()
      element.removeEventListener(UPDATE_BLOCKED_EVENT, handleUpdateBlocked)
      autoRevealCheckbox.removeEventListener('change', handleAutoRevealChange)
      revealInput.destroy()
      pauseInput.destroy()
      pauseOverlay.teardown()
      endOverlay.teardown()
      eventPlayer.destroy()
      battlefield.teardown?.()
    },
  }
}

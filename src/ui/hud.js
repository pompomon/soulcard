import { createPauseOverlay } from './overlays.js'
import { createEventPlayer } from '../presentation/event-player.js'

function createTextElement(tagName, className, text) {
  const element = document.createElement(tagName)
  element.className = className
  element.textContent = text
  return element
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
  const methods = ['getSnapshot', 'subscribe', 'pause', 'resume']
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

function presentationStatusText(state) {
  if (state.status === 'queued') return 'Committed clash ready to present.'
  if (state.status === 'paused') return 'Presentation paused.'
  if (state.status === 'skipped') return 'Presentation skipped for reduced motion.'
  if (state.status === 'completed') return 'Clash presentation complete.'
  if (state.status === 'failed') return 'Presentation skipped after a rendering error.'
  if (state.status !== 'playing') return null
  if (state.stepKind === 'reveal') {
    return `Revealing card ${state.stepIndex + 1} of ${state.stepCount}.`
  }
  if (state.stepKind === 'transfer') return 'Transferring committed cards.'
  if (state.stepKind === 'burn') return 'Burning committed cards.'
  if (state.stepKind === 'retain') return 'The unresolved contest is retained.'
  return 'Presenting committed clash.'
}

export function createGameScreen({
  mountBattlefield,
  settingsController,
  runController,
  eventPlayerFactory = createEventPlayer,
} = {}) {
  if (typeof mountBattlefield !== 'function') {
    throw new TypeError('mountBattlefield must be a function')
  }
  assertRunController(runController)
  if (typeof eventPlayerFactory !== 'function') {
    throw new TypeError('eventPlayerFactory must be a function')
  }

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
  const comparisonPlaceholder = createTextElement(
    'p',
    'comparison-placeholder',
    'Reveal area',
  )
  comparison.append(comparisonHeading, comparisonPlaceholder)

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

  const controls = document.createElement('div')
  controls.className = 'game-controls'
  controls.dataset.primaryActionHost = ''

  const revealButton = createTextElement('button', 'game-button game-button--primary', 'Reveal / Continue')
  revealButton.type = 'button'
  revealButton.dataset.action = 'reveal'
  revealButton.disabled = true

  const pauseButton = createTextElement('button', 'game-button', 'Pause')
  pauseButton.type = 'button'
  pauseButton.dataset.action = 'pause'
  pauseButton.disabled = true

  controls.append(revealButton, pauseButton)
  hud.append(header, opponentPanel, comparison, playerPanel, pileMetrics, status, controls)

  const overlayHost = document.createElement('div')
  overlayHost.className = 'game-overlays'
  overlayHost.dataset.overlayHost = ''

  const handleResume = () => {
    try {
      runController?.resume()
    } catch {}
  }
  const pauseOverlay = createPauseOverlay({ onResume: handleResume })
  overlayHost.append(pauseOverlay.element)

  element.append(battlefieldHost, hud, overlayHost)

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
    element.style?.setProperty?.('--hud-footer-reserve', `${layout.hud.footer.height}px`)
    element.style?.setProperty?.('--hud-side-reserve', `${layout.hud.leftPanel.width}px`)
    for (const [side, value] of Object.entries(layout.safeArea)) {
      element.style?.setProperty?.(`--safe-area-${side}`, `${value}px`)
    }
  }
  const battlefieldMount = mountBattlefield(battlefieldHost, {
    settingsController,
    onLayout: applyLayout,
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
  const eventPlayer = eventPlayerFactory({
    adapter: presentationAdapter,
    settingsController,
    onStateChange(state) {
      const message = presentationStatusText(state)
      if (message !== null) status.textContent = message
      status.dataset.presentationState = state.status
    },
    onError() {
      status.textContent = 'Presentation skipped after a rendering error.'
    },
  })
  if (
    eventPlayer === null
    || typeof eventPlayer !== 'object'
    || typeof eventPlayer.present !== 'function'
    || typeof eventPlayer.setPaused !== 'function'
    || typeof eventPlayer.destroy !== 'function'
  ) {
    battlefield.teardown?.()
    throw new TypeError('eventPlayerFactory must return a compatible event player')
  }

  const handlePause = () => {
    try {
      Promise.resolve(runController?.pause()).catch(() => {})
    } catch {}
  }
  pauseButton.addEventListener('click', handlePause)

  const unsubscribeRun = runController?.subscribe((snapshot) => {
    const { match } = snapshot
    pauseButton.disabled = match?.machineState !== 'ready'
    pauseOverlay.element.hidden = match?.machineState !== 'paused'
    pauseOverlay.update(snapshot)
    const nextPresentationPaused = match?.machineState === 'paused'
    eventPlayer.setPaused(nextPresentationPaused)

    if (match === null || match === undefined) {
      status.textContent = 'Game setup is not connected yet.'
      return
    }
    const metrics = {
      stage: match.stage,
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

    const saveSettled = snapshot.saveStatus === 'saved' || snapshot.saveStatus === 'failed'
    if (match.pendingEvent === null || saveSettled) {
      Promise.resolve(eventPlayer.present(match)).catch(() => {
        status.textContent = 'Presentation skipped after a rendering error.'
      })
    } else if (snapshot.saveStatus === 'saving') {
      status.textContent = 'Saving committed clash…'
    }
  })

  return {
    element,
    teardown() {
      unsubscribeRun?.()
      pauseButton.removeEventListener('click', handlePause)
      pauseOverlay.teardown()
      eventPlayer.destroy()
      battlefield.teardown?.()
    },
  }
}

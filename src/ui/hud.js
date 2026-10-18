import {
  createCampaignOverlay,
  createEndOverlay,
  createPauseOverlay,
} from './overlays.js'
import { UPDATE_BLOCKED_EVENT } from './update-notice.js'
import { createAutoRevealCoordinator } from '../app/auto-reveal-coordinator.js'
import { createEventPlayer } from '../presentation/event-player.js'
import { createInputController } from '../presentation/input.js'
import { getCard } from '../domain/cards.js'
import { getCampaignNodeEvent } from '../domain/campaign-content.js'
import { deckEditRequiresTarget } from '../domain/campaign-deck.js'
import {
  CAMPAIGN_HOLD_DECISION_STATES,
  getEligibleHoldTargets,
  isCampaignState,
} from '../domain/campaign-machine.js'
import {
  activeNodeId,
  campaignInspectView,
  eventTargetView,
  eventView,
  informedChoiceLines,
  rewardDraftView,
  rewardTargetView,
  routeMapView,
  routeProgressText,
  routeSummaryText,
  shopTargetView,
  shopView,
} from './campaign-view.js'

const ACTIVE_PRESENTATION_STATUSES = new Set(['queued', 'playing', 'paused'])
const RENDER_CONTEXT_STATUSES = new Set(['ready', 'lost', 'restoring', 'failed'])
// Campaign boundaries between encounters, each with its own overlay.
const CAMPAIGN_NODE_STATES = Object.freeze(['awaitingRoute', 'awaitingShop', 'awaitingEvent'])
const CAMPAIGN_INSPECT_STATES = Object.freeze(['ready', 'paused', ...CAMPAIGN_NODE_STATES])
// The machine state at which each kind of deck-target picker is valid.
const TARGET_PICKER_STATES = Object.freeze({
  reward: 'awaitingReward',
  shop: 'awaitingShop',
  event: 'awaitingEvent',
})
const BOUNDARY_SAVE_FAILURES = Object.freeze({
  awaitingReward: 'The reward draft could not be saved. Try again.',
  awaitingRoute: 'The route map could not be saved. Try again.',
  awaitingShop: 'The shop could not be saved. Try again.',
  awaitingEvent: 'The event could not be saved. Try again.',
})
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

function contextStatusText(contextState) {
  if (contextState.status === 'lost') {
    return 'Graphics context lost. Presentation is paused while graphics recover.'
  }
  if (contextState.status === 'restoring') {
    return 'Restoring graphics from the current game state…'
  }
  if (contextState.status === 'failed') {
    return `Graphics recovery failed${contextState.reason ? ` (${contextState.reason})` : ''}. Pause and save remain available; reload to retry.`
  }
  return null
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
    createMetric('Source pile', `${side}-source-count`),
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
  if (isCampaignState(match) && match.encounter === null) {
    return {
      result: 'Between encounters',
      details: 'Choose your next step on the route.',
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

  if (isCampaignState(match) && match.encounter.outcome?.result === 'win') {
    return {
      result: `${sideText(match.encounter.outcome.winner)} won the encounter`,
      details: `Final clash: ${details}`,
    }
  }
  if (isCampaignState(match) && match.encounter.outcome?.result === 'draw') {
    return {
      result: 'The encounter ended in a draw',
      details: `Final clash: ${details}`,
    }
  }

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
    createMetric('Health', 'campaign-health'),
    createMetric('Route', 'campaign-route'),
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
  status.setAttribute('aria-atomic', 'true')

  const saveWarning = createTextElement('p', 'game-save-warning', '')
  saveWarning.dataset.saveWarning = ''
  saveWarning.setAttribute('role', 'status')
  saveWarning.setAttribute('aria-live', 'polite')
  saveWarning.setAttribute('aria-atomic', 'true')
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

  const holdButton = createTextElement('button', 'game-button', 'Hold')
  holdButton.type = 'button'
  holdButton.dataset.action = 'hold'
  holdButton.disabled = true
  holdButton.hidden = true

  const inspectButton = createTextElement('button', 'game-button', 'Run details')
  inspectButton.type = 'button'
  inspectButton.dataset.action = 'inspect'
  inspectButton.disabled = true
  inspectButton.hidden = true

  controls.append(revealButton, autoRevealLabel)
  if (isCampaignState(runController?.getSnapshot()?.match)) {
    controls.append(holdButton, inspectButton)
  }
  controls.append(pauseButton)
  hud.append(header, opponentPanel, comparison, playerPanel, pileMetrics, feedback, controls)

  const overlayHost = document.createElement('div')
  overlayHost.className = 'game-overlays'
  overlayHost.dataset.overlayHost = ''

  let destroyed = false
  let overlayAction = null
  let overlayError = null
  let holdManagerOpen = false
  let inspectOpen = false
  // The reward offer, shop item, or event option awaiting a deck target, tied to the
  // snapshot it was opened on. The boundary held on screen until a decision's save
  // succeeds, so the next state is never presented before it is saved.
  let pendingTarget = null
  let decisionSave = null
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
  const handleCampaignChoice = (choice) => {
    if (
      overlayAction !== null
      || latestSnapshot?.saveStatus !== 'saved'
      || !CAMPAIGN_HOLD_DECISION_STATES.includes(latestSnapshot?.match?.machineState)
    ) {
      return
    }
    overlayAction = `campaign-${choice}`
    overlayError = null
    revealActionPending = true
    renderHud()
    let action
    try {
      action = runController?.chooseHoldChoice(choice)
    } catch {
      overlayAction = null
      revealActionPending = false
      overlayError = 'The reveal choice could not be completed. Try again.'
      renderHud()
      return
    }
    Promise.resolve(action)
      .then((result) => {
        if (destroyed) return undefined
        overlayAction = null
        if (result?.event !== null && result?.event !== undefined) {
          revealActionEventId = result.event.id
          return present(result.match, {
            saveSucceeded: result?.save?.status === 'saved',
          })
        }
        revealActionPending = false
        renderHud()
        return undefined
      })
      .catch(() => {
        if (destroyed) return
        overlayAction = null
        revealActionPending = false
        overlayError = 'The reveal choice could not be completed. Try again.'
        renderHud()
      })
  }
  const handleCampaignSaveRetry = () => {
    const machineState = latestSnapshot?.match?.machineState
    if (
      overlayAction !== null
      || latestSnapshot?.saveStatus !== 'failed'
      || (
        decisionSave === null
        && BOUNDARY_SAVE_FAILURES[machineState] === undefined
        && !CAMPAIGN_HOLD_DECISION_STATES.includes(machineState)
      )
    ) {
      return
    }
    const failureText = decisionSave !== null
      ? `The ${decisionSave.noun} could not be saved. Try again.`
      : BOUNDARY_SAVE_FAILURES[machineState]
        ?? 'The Hold choice could not be saved. Try again.'
    overlayAction = 'campaign-save'
    overlayError = null
    renderHud()
    let save
    try {
      save = runController?.saveStable()
    } catch {
      overlayAction = null
      overlayError = failureText
      renderHud()
      return
    }
    Promise.resolve(save)
      .then((result) => {
        if (destroyed) return
        overlayAction = null
        overlayError = result?.status === 'saved' ? null : failureText
        renderHud()
      })
      .catch(() => {
        if (destroyed) return
        overlayAction = null
        overlayError = failureText
        renderHud()
      })
  }
  const handleCampaignCapture = (instanceId) => {
    if (overlayAction !== null) return
    overlayAction = 'campaign-capture'
    overlayError = null
    renderHud()
    let action
    try {
      action = runController?.captureHold(instanceId)
    } catch {
      overlayAction = null
      overlayError = 'The selected card could not be captured. Try again.'
      renderHud()
      return
    }
    Promise.resolve(action)
      .then(() => {
        if (destroyed) return
        overlayAction = null
        holdManagerOpen = false
        renderHud()
      })
      .catch(() => {
        if (destroyed) return
        overlayAction = null
        overlayError = 'The selected card could not be captured. Try again.'
        renderHud()
      })
  }
  const handleCampaignRetry = () => {
    if (overlayAction !== null) return
    overlayAction = 'campaign-retry'
    overlayError = null
    renderHud()
    let action
    try {
      action = runController?.retryEncounter()
    } catch {
      overlayAction = null
      overlayError = 'The campaign retry could not be completed. Try again.'
      renderHud()
      return
    }
    Promise.resolve(action)
      .then(() => {
        if (destroyed) return
        overlayAction = null
        renderHud()
      })
      .catch(() => {
        if (destroyed) return
        overlayAction = null
        overlayError = 'The campaign retry could not be completed. Try again.'
        renderHud()
      })
  }
  const decisionSelectable = (machineState) => (
    overlayAction === null
    && decisionSave === null
    && latestSnapshot?.saveStatus === 'saved'
    && isCampaignState(latestSnapshot?.match)
    && latestSnapshot.match.machineState === machineState
  )
  // Node decisions name the active node and the journal step they were offered at.
  const nodeDecision = (match) => ({ nodeId: activeNodeId(match), step: match.journal.length })
  const commitDecision = (noun, failureText, decide) => {
    const boundary = latestSnapshot.match
    overlayAction = 'campaign-decision'
    overlayError = null
    decisionSave = { boundary, noun }
    renderHud()
    let action
    try {
      action = decide(boundary)
    } catch {
      overlayAction = null
      decisionSave = null
      overlayError = failureText
      renderHud()
      return
    }
    Promise.resolve(action)
      .then(() => {
        if (destroyed) return
        overlayAction = null
        pendingTarget = null
        renderHud()
      })
      .catch(() => {
        if (destroyed) return
        overlayAction = null
        if (latestSnapshot?.match === boundary) {
          decisionSave = null
          overlayError = failureText
        } else {
          overlayError = `The ${noun} could not be saved. Try again.`
        }
        renderHud()
      })
  }
  const openTargetPicker = (kind, id) => {
    pendingTarget = { kind, id, match: latestSnapshot.match }
    overlayError = null
    renderHud()
  }
  const commitReward = (offerId, targetInstanceId) => commitDecision(
    'reward',
    'The reward could not be selected. Try again.',
    (boundary) => runController?.selectReward({
      ...nodeDecision(boundary),
      offerId,
      targetInstanceId,
    }),
  )
  const commitPurchase = (itemId, targetInstanceId) => commitDecision(
    'purchase',
    'The item could not be bought. Try again.',
    (boundary) => runController?.purchaseShopItem({
      ...nodeDecision(boundary),
      itemId,
      targetInstanceId,
    }),
  )
  const commitEventOption = (optionId, targetInstanceId) => commitDecision(
    'event choice',
    'The event option could not be chosen. Try again.',
    (boundary) => runController?.chooseEventOption({
      ...nodeDecision(boundary),
      optionId,
      targetInstanceId,
    }),
  )
  const handleRewardOffer = (offerId) => {
    if (!decisionSelectable('awaitingReward')) return
    const offer = latestSnapshot.match.pendingReward.offers
      .find((candidate) => candidate.offerId === offerId)
    if (offer === undefined) return
    if (deckEditRequiresTarget(offer.kind)) {
      openTargetPicker('reward', offerId)
      return
    }
    commitReward(offerId, null)
  }
  const handleChooseRoute = (nodeId) => {
    if (!decisionSelectable('awaitingRoute')) return
    commitDecision(
      'route choice',
      'The route could not be chosen. Try again.',
      (boundary) => runController?.chooseRoute({ nodeId, step: boundary.journal.length }),
    )
  }
  const handleShopItem = (itemId) => {
    if (!decisionSelectable('awaitingShop')) return
    const item = latestSnapshot.match.shop.items
      .find((candidate) => candidate.itemId === itemId)
    if (item === undefined || item.sold) return
    if (deckEditRequiresTarget(item.kind)) {
      openTargetPicker('shop', itemId)
      return
    }
    commitPurchase(itemId, null)
  }
  const handleLeaveShop = () => {
    if (!decisionSelectable('awaitingShop')) return
    commitDecision(
      'shop exit',
      'The shop could not be left. Try again.',
      (boundary) => runController?.leaveShop(nodeDecision(boundary)),
    )
  }
  const handleEventOption = (optionId) => {
    if (!decisionSelectable('awaitingEvent')) return
    const match = latestSnapshot.match
    const option = getCampaignNodeEvent(match.nodeEvent.eventId).options
      .find((candidate) => candidate.id === optionId)
    if (option === undefined) return
    if (option.deckEdit !== null && deckEditRequiresTarget(option.deckEdit.kind)) {
      openTargetPicker('event', optionId)
      return
    }
    // Surrendering Hold always names the held card; no picker is needed.
    commitEventOption(optionId, option.surrenderHold ? match.hold : null)
  }
  const handleDecisionTarget = (instanceId) => {
    if (pendingTarget === null || !decisionSelectable(TARGET_PICKER_STATES[pendingTarget.kind])) {
      return
    }
    const { kind, id } = pendingTarget
    if (kind === 'reward') commitReward(id, instanceId)
    else if (kind === 'shop') commitPurchase(id, instanceId)
    else commitEventOption(id, instanceId)
  }
  const handleTargetBack = () => {
    if (overlayAction !== null) return
    pendingTarget = null
    overlayError = null
    renderHud()
  }
  const handleOverlayInspect = () => {
    const match = latestSnapshot?.match
    if (
      overlayAction !== null
      || !isCampaignState(match)
      || !CAMPAIGN_NODE_STATES.includes(match.machineState)
    ) {
      return
    }
    inspectOpen = true
    overlayError = null
    renderHud()
  }
  const handleInspectClose = () => {
    if (overlayAction !== null) return
    inspectOpen = false
    overlayError = null
    renderHud()
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
  const campaignOverlay = createCampaignOverlay({
    onChooseNormal: () => handleCampaignChoice('normal'),
    onChooseHold: () => handleCampaignChoice('hold'),
    onRetrySave: handleCampaignSaveRetry,
    onCapture: handleCampaignCapture,
    onRetry: handleCampaignRetry,
    onChooseOffer: handleRewardOffer,
    onChooseTarget: handleDecisionTarget,
    onBack: handleTargetBack,
    onClose: handleInspectClose,
    onChooseRoute: handleChooseRoute,
    onBuyItem: handleShopItem,
    onLeaveShop: handleLeaveShop,
    onChooseEventOption: handleEventOption,
    onInspect: handleOverlayInspect,
    onMainMenu: handleEndMain,
    onRestart: handleRestart,
    onCancel: () => {
      if (overlayAction === null) {
        holdManagerOpen = false
        overlayError = null
        renderHud()
      }
    },
  })
  overlayHost.append(pauseOverlay.element, endOverlay.element, campaignOverlay.element)

  element.append(battlefieldHost, hud, overlayHost)
  let requestReveal = () => {}
  let eventPlayer = null
  let hudReady = false
  let rendererContextState = Object.freeze({
    status: 'ready',
    recoveryCount: 0,
    reason: null,
  })

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
    onContextStatus(nextState) {
      if (
        nextState === null
        || typeof nextState !== 'object'
        || !RENDER_CONTEXT_STATUSES.has(nextState.status)
      ) {
        return
      }
      rendererContextState = nextState
      if (eventPlayer !== null) {
        eventPlayer.setPaused(
          latestSnapshot?.match?.machineState === 'paused'
          || rendererContextState.status !== 'ready',
        )
        if (rendererContextState.status === 'failed') {
          eventPlayer.cancel?.('graphics-recovery-failed')
        }
      }
      if (hudReady) renderHud()
    },
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

  // While a node decision is saving, the HUD keeps showing the boundary it was made at
  // so the next state is never presented before its save succeeds.
  function displayedMatch() {
    return decisionSave?.boundary ?? latestSnapshot?.match
  }

  function renderMetrics() {
    const match = displayedMatch()
    const metrics = match === null || match === undefined
      ? {
          stage: '—',
          'source-count': '—',
          'campaign-health': '—',
          'campaign-route': '—',
          'player-source-count': '—',
          'player-draw-count': '—',
          'player-won-count': '—',
          'opponent-source-count': '—',
          'opponent-draw-count': '—',
          'opponent-won-count': '—',
          'contested-count': '—',
          'burn-count': '—',
        }
      : isCampaignState(match) && match.encounter === null
        ? {
            stage: '—',
            'source-count': '—',
            'campaign-health': `${match.health}/${match.maxHealth}`,
            'campaign-route': routeProgressText(match),
            'player-source-count': '—',
            'player-draw-count': '—',
            'player-won-count': '—',
            'opponent-source-count': '—',
            'opponent-draw-count': '—',
            'opponent-won-count': '—',
            'contested-count': '—',
            'burn-count': '—',
          }
      : isCampaignState(match)
        ? {
            stage: `P ${stageText(match.encounter.supplyMode.player)} · O ${stageText(match.encounter.supplyMode.opponent)}`,
            'source-count': (
              match.encounter.zones.playerSourcePile.length
              + match.encounter.zones.opponentSourcePile.length
            ),
            'campaign-health': `${match.health}/${match.maxHealth}`,
            'campaign-route': routeProgressText(match),
            'player-source-count': match.encounter.zones.playerSourcePile.length,
            'player-draw-count': match.encounter.zones.player.drawPile.length,
            'player-won-count': match.encounter.zones.player.wonPile.length,
            'opponent-source-count': match.encounter.zones.opponentSourcePile.length,
            'opponent-draw-count': match.encounter.zones.opponent.drawPile.length,
            'opponent-won-count': match.encounter.zones.opponent.wonPile.length,
            'contested-count': match.encounter.zones.contestedPile.length,
            'burn-count': match.encounter.zones.burnPile.length,
          }
        : {
          stage: stageText(match.stage),
          'source-count': match.zones.sourceDeck.length,
          'campaign-health': '—',
          'campaign-route': '—',
          'player-source-count': '—',
          'player-draw-count': match.zones.player.drawPile.length,
          'player-won-count': match.zones.player.wonPile.length,
          'opponent-source-count': '—',
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
    const copy = comparisonText(displayedMatch())
    comparisonResult.textContent = copy.result
    comparisonDetails.textContent = copy.details
    comparisonProgress.textContent = displayedMatch()
      ? presentationProgressText(presentationState)
      : 'Waiting for a match.'
  }

  function renderStatus() {
    const snapshot = latestSnapshot ?? {}
    const match = snapshot.match
    const contextMessage = contextStatusText(rendererContextState)
    let message
    if (match === null || match === undefined) {
      message = 'Game setup is not connected yet.'
    } else if (contextMessage !== null) {
      message = contextMessage
    } else if (decisionSave !== null) {
      message = snapshot.saveStatus === 'failed'
        ? `Saving your ${decisionSave.noun} failed. Retry the save to continue.`
        : `Saving your ${decisionSave.noun} before continuing…`
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
    } else if (match.machineState === 'awaitingHoldChoice') {
      message = 'Choose the prepared card or the card in Hold.'
    } else if (match.machineState === 'awaitingInformedHoldChoice') {
      message = 'Hold Insight shows both next cards. Choose the prepared card or the card in Hold.'
    } else if (match.machineState === 'awaitingRetry') {
      message = 'Encounter ended. Retry to continue the campaign.'
    } else if (match.machineState === 'awaitingReward') {
      message = 'Encounter won. Choose a reward to continue.'
    } else if (match.machineState === 'awaitingRoute') {
      message = 'Choose your next stop on the route map.'
    } else if (match.machineState === 'awaitingShop') {
      message = 'Buy from the shop, or leave to continue.'
    } else if (match.machineState === 'awaitingEvent') {
      message = 'Choose an event option to continue.'
    } else if (isCampaignState(match) && match.status === 'ended') {
      message = match.outcome.result === 'victory'
        ? 'Campaign complete. The final encounter is won.'
        : 'Campaign ended when health reached zero.'
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
    const match = displayedMatch()
    const initialSavePending = (
      match?.turn === 0
      && latestSnapshot?.saveStatus === 'saving'
    )
    const matchReady = (
      match?.status === 'active'
      && match.machineState === 'ready'
      && !initialSavePending
    )
    const renderingAvailable = rendererContextState.status === 'ready'
    const presentationActive = (
      queuedEventIds.size > 0
      || ACTIVE_PRESENTATION_STATUSES.has(presentationState.status)
    )
    const revealBusy = revealActionPending || presentationActive
    const campaign = isCampaignState(match)
    revealInput?.setEnabled(matchReady && renderingAvailable)
    revealInput?.setBusy(revealBusy)
    battlefield.setDeckInputState?.({
      enabled: matchReady && renderingAvailable,
      busy: revealBusy || !renderingAvailable,
    })
    pauseInput?.setEnabled(matchReady)
    pauseInput?.setBusy(pauseActionPending)
    autoRevealCheckbox.disabled = (
      match?.status !== 'active'
      || match.machineState !== 'ready'
    )
    holdButton.hidden = !campaign
    holdButton.disabled = (
      !campaign
      || !matchReady
      || revealBusy
      || overlayAction !== null
    )
    inspectButton.hidden = !campaign
    inspectButton.disabled = holdButton.disabled
    if (revealInput === null) {
      revealButton.disabled = !matchReady || !renderingAvailable || revealBusy
    }
    if (pauseInput === null) pauseButton.disabled = !matchReady || pauseActionPending
  }

  function terminalPresentationSettled() {
    const match = latestSnapshot?.match
    if (match?.status !== 'ended' || isCampaignState(match)) return false
    return eventPresentationSettled(match)
  }

  function eventPresentationSettled(match) {
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

  function targetPickerFor(kind, match) {
    return pendingTarget?.kind === kind && pendingTarget.match === match
      ? pendingTarget.id
      : null
  }

  function campaignOverlayState() {
    const match = latestSnapshot?.match
    if (decisionSave !== null) {
      return {
        mode: 'decision-saving',
        targets: [],
        view: {
          noun: decisionSave.noun,
          failed: match !== decisionSave.boundary && latestSnapshot.saveStatus === 'failed',
        },
      }
    }
    if (!isCampaignState(match) || match.machineState === 'paused') {
      return { mode: null, targets: [] }
    }
    if (holdManagerOpen && match.machineState === 'ready') {
      const targets = getEligibleHoldTargets(match).map((target) => {
        const card = getCard(target.cardId)
        const pile = target.zone.endsWith('drawPile') ? 'Draw' : 'Won'
        return {
          ...target,
          label: `${card.rank}${card.suit} · ${pile} pile ${target.index + 1}`,
        }
      })
      return { mode: 'hold-capture', targets }
    }
    if (inspectOpen && CAMPAIGN_INSPECT_STATES.includes(match.machineState)) {
      return { mode: 'inspect', targets: [], view: campaignInspectView(match) }
    }
    if (
      CAMPAIGN_HOLD_DECISION_STATES.includes(match.machineState)
      && ['saved', 'failed'].includes(latestSnapshot.saveStatus)
    ) {
      return match.machineState === 'awaitingInformedHoldChoice'
        ? {
            mode: 'informed-choice',
            targets: [],
            view: { lines: informedChoiceLines(match) },
          }
        : { mode: 'hold-choice', targets: [] }
    }
    if (match.machineState === 'awaitingRoute') {
      return { mode: 'route-map', targets: [], view: routeMapView(match) }
    }
    if (match.machineState === 'awaitingShop') {
      const itemId = targetPickerFor('shop', match)
      return itemId === null
        ? { mode: 'shop', targets: [], view: shopView(match) }
        : { mode: 'shop-target', targets: [], view: shopTargetView(match, itemId) }
    }
    if (match.machineState === 'awaitingEvent') {
      const optionId = targetPickerFor('event', match)
      return optionId === null
        ? { mode: 'event', targets: [], view: eventView(match) }
        : { mode: 'event-target', targets: [], view: eventTargetView(match, optionId) }
    }
    if (
      ['awaitingRetry', 'awaitingReward', 'ended'].includes(match.machineState)
      && eventPresentationSettled(match)
    ) {
      if (match.machineState === 'awaitingReward') {
        const offerId = targetPickerFor('reward', match)
        return offerId === null
          ? { mode: 'reward-draft', targets: [], view: rewardDraftView(match) }
          : {
              mode: 'reward-target',
              targets: [],
              view: rewardTargetView(match, offerId),
            }
      }
      return match.machineState === 'awaitingRetry'
        ? { mode: 'retry', targets: [] }
        : { mode: 'campaign-end', targets: [], view: { route: routeSummaryText(match) } }
    }
    return { mode: null, targets: [] }
  }

  function renderOverlays() {
    const endVisible = terminalPresentationSettled()
    const paused = latestSnapshot?.match?.machineState === 'paused'
    const campaignState = campaignOverlayState()
    const campaignVisible = campaignState.mode !== null
    pauseOverlay.element.hidden = !paused || endVisible || campaignVisible
    endOverlay.element.hidden = !endVisible
    campaignOverlay.element.hidden = !campaignVisible
    hud.inert = (
      paused
      || endVisible
      || campaignVisible
      || element.dataset.updateBlocked === 'true'
    )
    const actionState = {
      action: overlayAction,
      error: overlayError,
      announcement: paused || endVisible
        ? contextStatusText(rendererContextState)
        : null,
    }
    pauseOverlay.update(latestSnapshot, actionState)
    endOverlay.update(latestSnapshot, actionState)
    if (campaignVisible) {
      campaignOverlay.update(latestSnapshot, {
        mode: campaignState.mode,
        targets: campaignState.targets,
        view: campaignState.view ?? null,
        busy: overlayAction !== null || latestSnapshot.saveStatus === 'saving',
        error: overlayError,
      })
    }
  }

  function renderHud() {
    if (destroyed) return
    renderMetrics()
    renderComparison()
    renderStatus()
    updateControls()
    renderOverlays()
  }

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
      || (eventPlayer.cancel !== undefined && typeof eventPlayer.cancel !== 'function')
    ) {
      throw new TypeError('eventPlayerFactory must return a compatible event player')
    }
  } catch (error) {
    pauseOverlay.teardown()
    endOverlay.teardown()
    campaignOverlay.teardown()
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
    hudReady = true
    renderHud()

    let presentation
    if (rendererContextState.status === 'failed') {
      autoRevealChainActive = false
      presentation = Promise.resolve(Object.freeze({
        status: 'cancelled',
        eventId: eventId ?? null,
        reason: 'graphics-recovery-failed',
      }))
    } else {
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
        const blocked = (
          hud.inert === true
          || rendererContextState.status !== 'ready'
        )
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
      action = runController?.revealOrContinue({
        autoChooseNormal: autoRevealCheckbox.checked,
      })
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
  const handleHoldManagement = () => {
    const match = latestSnapshot?.match
    if (
      holdButton.disabled
      || !isCampaignState(match)
      || match.machineState !== 'ready'
    ) {
      return
    }
    autoRevealChainActive = false
    autoRevealCoordinator.stop()
    holdManagerOpen = true
    overlayError = null
    renderHud()
  }
  const handleInspect = () => {
    const match = latestSnapshot?.match
    if (
      inspectButton.disabled
      || !isCampaignState(match)
      || match.machineState !== 'ready'
    ) {
      return
    }
    autoRevealChainActive = false
    autoRevealCoordinator.stop()
    inspectOpen = true
    overlayError = null
    renderHud()
  }
  autoRevealCheckbox.addEventListener('change', handleAutoRevealChange)
  holdButton.addEventListener('click', handleHoldManagement)
  inspectButton.addEventListener('click', handleInspect)
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
    campaignOverlay.teardown()
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
    if (decisionSave !== null && match?.runId !== decisionSave.boundary.runId) {
      decisionSave = null
    } else if (
      decisionSave !== null
      && match !== decisionSave.boundary
      && snapshot.saveStatus === 'saved'
    ) {
      decisionSave = null
    }
    if (pendingTarget !== null && match !== pendingTarget.match) pendingTarget = null
    if (!CAMPAIGN_INSPECT_STATES.includes(match?.machineState)) inspectOpen = false
    // Keep failures visible through transient unsaved/saving states until a save succeeds.
    if (isSaveFailureStatus(snapshot.saveStatus)) {
      showSaveWarning(snapshot.saveReason)
    } else if (clearsSaveWarning(snapshot.saveStatus)) {
      clearSaveWarning()
    }
    const nextPresentationPaused = (
      match?.machineState === 'paused'
      || rendererContextState.status !== 'ready'
    )
    eventPlayer.setPaused(nextPresentationPaused)

    renderHud()

    const saveSettled = snapshot.saveStatus === 'saved' || snapshot.saveStatus === 'failed'
    if (
      decisionSave === null
      && match !== null
      && match !== undefined
      && (match.pendingEvent === null || saveSettled)
    ) {
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
      holdButton.removeEventListener('click', handleHoldManagement)
      inspectButton.removeEventListener('click', handleInspect)
      revealInput.destroy()
      pauseInput.destroy()
      pauseOverlay.teardown()
      endOverlay.teardown()
      campaignOverlay.teardown()
      eventPlayer.destroy()
      battlefield.teardown?.()
    },
  }
}

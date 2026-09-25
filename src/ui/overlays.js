function assertCallback(callback, name) {
  if (typeof callback !== 'function') {
    throw new TypeError(`${name} must be a function`)
  }
}

function saveStatusText({ saveStatus, saveReason }) {
  switch (saveStatus) {
    case 'saving':
      return 'Saving…'
    case 'saved':
      return 'Game saved.'
    case 'failed':
      return `Save failed${saveReason ? ` (${saveReason})` : ''}. Your game remains available in this session.`
    case 'unsaved':
      return 'Game has unsaved changes.'
    default:
      return 'No save has been written yet.'
  }
}

function overlayStatusText(snapshot, { action, error, announcement }) {
  if (error) return error
  if (action === 'save-main') return 'Saving before returning to the main menu…'
  if (action === 'restart') return 'Starting a new game…'
  if (action === 'main') return 'Returning to the main menu…'
  if (announcement) return announcement
  return saveStatusText(snapshot)
}

function createButton(label, action, className = 'game-button') {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = className
  button.textContent = label
  button.addEventListener('click', action)
  return button
}

function createOverlay({ className, labelId }) {
  const element = document.createElement('section')
  element.className = `${className} game-overlay`
  element.setAttribute('role', 'dialog')
  element.setAttribute('aria-modal', 'true')
  element.setAttribute('aria-labelledby', labelId)
  element.hidden = true

  const panel = document.createElement('div')
  panel.className = `${className}__panel game-overlay__panel`
  return { element, panel }
}

export function createPauseOverlay({
  onResume,
  onSaveAndMain,
  onRestart,
} = {}) {
  assertCallback(onResume, 'onResume')
  assertCallback(onSaveAndMain, 'onSaveAndMain')
  assertCallback(onRestart, 'onRestart')

  const { element, panel } = createOverlay({
    className: 'pause-overlay',
    labelId: 'pause-overlay-title',
  })
  element.dataset.pauseOverlay = ''

  const heading = document.createElement('h2')
  heading.id = 'pause-overlay-title'
  heading.textContent = 'Game paused'

  const saveStatus = document.createElement('p')
  saveStatus.className = 'pause-overlay__status game-overlay__status'
  saveStatus.dataset.saveStatus = ''
  saveStatus.setAttribute('role', 'status')
  saveStatus.setAttribute('aria-live', 'polite')
  saveStatus.setAttribute('aria-atomic', 'true')

  const actions = document.createElement('div')
  actions.className = 'game-overlay__actions'

  let busy = false
  const handleResume = () => {
    if (!busy) onResume()
  }
  const handleSaveAndMain = () => {
    if (!busy) onSaveAndMain()
  }
  const handleRestart = () => {
    if (!busy) onRestart()
  }

  const resumeButton = createButton(
    'Resume',
    handleResume,
    'game-button game-button--primary',
  )
  resumeButton.dataset.action = 'resume'
  const saveAndMainButton = createButton('Save & Main Menu', handleSaveAndMain)
  saveAndMainButton.dataset.action = 'save-main'
  const restartButton = createButton('Restart Game', handleRestart)
  restartButton.dataset.action = 'restart'

  actions.append(resumeButton, saveAndMainButton, restartButton)
  panel.append(heading, saveStatus, actions)
  element.append(panel)

  return {
    element,
    update(snapshot, actionState = {}) {
      busy = snapshot.saveStatus === 'saving' || actionState.action != null
      saveStatus.textContent = overlayStatusText(snapshot, actionState)
      resumeButton.disabled = busy
      saveAndMainButton.disabled = busy
      restartButton.disabled = busy
    },
    teardown() {
      resumeButton.removeEventListener('click', handleResume)
      saveAndMainButton.removeEventListener('click', handleSaveAndMain)
      restartButton.removeEventListener('click', handleRestart)
    },
  }
}

function outcomeHeading(outcome) {
  if (outcome?.result === 'draw') return 'Match drawn'
  return outcome?.winner === 'player' ? 'Victory' : 'Defeat'
}

function outcomeReason(outcome) {
  if (outcome?.reason === 'opponentUnableToReveal') {
    return 'The opponent could not reveal another card.'
  }
  if (outcome?.reason === 'playerUnableToReveal') {
    return 'The player could not reveal another card.'
  }
  return 'Neither side could reveal another card.'
}

export function createEndOverlay({
  onMainMenu,
  onRestart,
} = {}) {
  assertCallback(onMainMenu, 'onMainMenu')
  assertCallback(onRestart, 'onRestart')

  const { element, panel } = createOverlay({
    className: 'end-overlay',
    labelId: 'end-overlay-title',
  })
  element.dataset.endOverlay = ''

  const heading = document.createElement('h2')
  heading.id = 'end-overlay-title'

  const reason = document.createElement('p')
  reason.className = 'end-overlay__reason'
  reason.dataset.endReason = ''

  const summary = document.createElement('p')
  summary.className = 'end-overlay__summary'
  summary.dataset.endSummary = ''

  const saveStatus = document.createElement('p')
  saveStatus.className = 'end-overlay__status game-overlay__status'
  saveStatus.dataset.endSaveStatus = ''
  saveStatus.setAttribute('role', 'status')
  saveStatus.setAttribute('aria-live', 'polite')
  saveStatus.setAttribute('aria-atomic', 'true')

  const actions = document.createElement('div')
  actions.className = 'game-overlay__actions'

  let busy = false
  const handleMainMenu = () => {
    if (!busy) onMainMenu()
  }
  const handleRestart = () => {
    if (!busy) onRestart()
  }
  const mainButton = createButton(
    'Main Menu',
    handleMainMenu,
    'game-button game-button--primary',
  )
  mainButton.dataset.action = 'end-main'
  const restartButton = createButton('Restart Game', handleRestart)
  restartButton.dataset.action = 'end-restart'

  actions.append(mainButton, restartButton)
  panel.append(heading, reason, summary, saveStatus, actions)
  element.append(panel)

  return {
    element,
    update(snapshot, actionState = {}) {
      const match = snapshot.match
      const outcome = match?.outcome
      busy = actionState.action != null
      heading.textContent = outcomeHeading(outcome)
      reason.textContent = outcomeReason(outcome)
      summary.textContent = `${match?.turn ?? 0} clashes · ${match?.zones?.burnPile?.length ?? 0} cards burned`
      saveStatus.textContent = overlayStatusText(snapshot, actionState)
      mainButton.disabled = busy
      restartButton.disabled = busy
    },
    teardown() {
      mainButton.removeEventListener('click', handleMainMenu)
      restartButton.removeEventListener('click', handleRestart)
    },
  }
}

export function createCampaignOverlay({
  onChooseNormal,
  onChooseHold,
  onCapture,
  onRetry,
  onClaimReward,
  onMainMenu,
  onRestart,
  onCancel,
} = {}) {
  for (const [name, callback] of Object.entries({
    onChooseNormal,
    onChooseHold,
    onCapture,
    onRetry,
    onClaimReward,
    onMainMenu,
    onRestart,
    onCancel,
  })) {
    assertCallback(callback, name)
  }

  const { element, panel } = createOverlay({
    className: 'campaign-overlay',
    labelId: 'campaign-overlay-title',
  })
  element.dataset.campaignOverlay = ''

  const heading = document.createElement('h2')
  heading.id = 'campaign-overlay-title'
  const description = document.createElement('p')
  description.className = 'campaign-overlay__description'
  description.dataset.campaignDescription = ''
  const targetHost = document.createElement('div')
  targetHost.className = 'campaign-overlay__targets'
  targetHost.dataset.holdTargets = ''
  const status = document.createElement('p')
  status.className = 'campaign-overlay__status game-overlay__status'
  status.dataset.campaignStatus = ''
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')
  status.setAttribute('aria-atomic', 'true')

  const actions = document.createElement('div')
  actions.className = 'game-overlay__actions'
  const buttons = {
    normal: createButton('Reveal normal card', onChooseNormal, 'game-button game-button--primary'),
    hold: createButton('Reveal held card', onChooseHold),
    retry: createButton('Retry encounter', onRetry, 'game-button game-button--primary'),
    reward: createButton('Claim reward', onClaimReward, 'game-button game-button--primary'),
    main: createButton('Main Menu', onMainMenu, 'game-button game-button--primary'),
    restart: createButton('Restart Campaign', onRestart),
    cancel: createButton('Cancel', onCancel),
  }
  for (const [action, button] of Object.entries(buttons)) {
    button.dataset.action = `campaign-${action}`
    actions.append(button)
  }
  panel.append(heading, description, targetHost, status, actions)
  element.append(panel)

  function setMode(mode, snapshot, options) {
    for (const button of Object.values(buttons)) button.hidden = true
    if (typeof targetHost.replaceChildren === 'function') {
      targetHost.replaceChildren()
    } else if (Array.isArray(targetHost.children)) {
      targetHost.children.length = 0
    }
    const match = snapshot.match
    if (mode === 'hold-choice') {
      heading.textContent = 'Choose your reveal'
      description.textContent = match.holdChoice.candidate === null
        ? 'The prepared pile is empty. Reveal the held card to continue.'
        : match.hold === null
          ? 'Reveal the prepared normal card.'
          : 'Reveal the prepared normal card or use Hold.'
      buttons.normal.hidden = false
      buttons.normal.disabled = options.busy || match.holdChoice.candidate === null
      buttons.hold.hidden = match.hold === null
      buttons.hold.disabled = options.busy || match.hold === null
    } else if (mode === 'hold-capture') {
      heading.textContent = match.hold === null ? 'Capture into Hold' : 'Replace held card'
      description.textContent = options.targets.length === 0
        ? 'No player-owned card in your draw or won pile is eligible.'
        : 'Choose a player-owned card from your current draw or won pile.'
      for (const target of options.targets) {
        const button = createButton(
          target.label,
          () => onCapture(target.instanceId),
          'game-button campaign-overlay__target',
        )
        button.dataset.holdTarget = target.instanceId
        button.disabled = options.busy
        targetHost.append(button)
      }
      buttons.cancel.hidden = false
      buttons.cancel.disabled = options.busy
    } else if (mode === 'retry') {
      heading.textContent = 'Encounter lost'
      description.textContent = `${match.encounter.name} dealt ${match.encounter.damage} damage. ${match.health} health remains.`
      buttons.retry.hidden = false
      buttons.retry.disabled = options.busy
    } else if (mode === 'reward') {
      heading.textContent = 'Encounter won'
      if (match.pendingReward.type === 'add-aces') {
        description.textContent = 'Reward: add the Spade and Club Aces to your campaign deck.'
      } else {
        description.textContent = `Reward: restore ${match.pendingReward.amount} health, up to ${match.maxHealth}.`
      }
      buttons.reward.hidden = false
      buttons.reward.disabled = options.busy
    } else if (mode === 'campaign-end') {
      heading.textContent = match.outcome.result === 'victory' ? 'Campaign victory' : 'Campaign defeat'
      description.textContent = match.outcome.result === 'victory'
        ? 'You defeated all three campaign opponents.'
        : 'Your health was depleted. Start a new campaign to try again.'
      buttons.main.hidden = false
      buttons.restart.hidden = false
      buttons.main.disabled = options.busy
      buttons.restart.disabled = options.busy
    }
  }

  return {
    element,
    update(snapshot, {
      mode,
      targets = [],
      busy = false,
      error = null,
    } = {}) {
      setMode(mode, snapshot, { targets, busy })
      status.textContent = error
        ?? (snapshot.saveStatus === 'saving' ? 'Saving campaign…' : saveStatusText(snapshot))
    },
    teardown() {},
  }
}

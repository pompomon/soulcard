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

function clearChildren(element) {
  if (typeof element.replaceChildren === 'function') {
    element.replaceChildren()
  } else if (Array.isArray(element.children)) {
    element.children.length = 0
  }
}

function appendLineSection(host, title, lines, { ordered = false, emptyText = null } = {}) {
  const section = document.createElement('section')
  section.className = 'campaign-overlay__section'
  const heading = document.createElement('h3')
  heading.className = 'campaign-overlay__section-title'
  heading.textContent = title
  section.append(heading)
  if (lines.length === 0 && emptyText !== null) {
    const empty = document.createElement('p')
    empty.className = 'campaign-overlay__line'
    empty.textContent = emptyText
    section.append(empty)
  } else {
    const list = document.createElement(ordered ? 'ol' : 'ul')
    list.className = 'campaign-overlay__lines'
    for (const line of lines) {
      const item = document.createElement('li')
      item.textContent = line
      list.append(item)
    }
    section.append(list)
  }
  host.append(section)
}

// One labelled choice with its explanation. Unavailable entries stay visible as text so
// every option, and why it cannot be taken, is announced.
function appendChoice(host, { title, detail, idPrefix, id, dataKey, onChoose, enabled, asButton = true }) {
  const item = document.createElement('div')
  item.className = 'campaign-offer'
  const detailText = document.createElement('p')
  detailText.className = 'campaign-offer__detail'
  detailText.id = `${idPrefix}-${id}-detail`
  detailText.textContent = detail
  if (asButton) {
    const button = createButton(
      title,
      () => onChoose(id),
      'game-button campaign-overlay__target campaign-offer__button',
    )
    button.dataset[dataKey] = id
    button.disabled = !enabled
    button.setAttribute('aria-describedby', detailText.id)
    item.append(button, detailText)
  } else {
    const label = document.createElement('p')
    label.className = 'campaign-offer__title'
    label.dataset[dataKey] = id
    label.textContent = title
    item.append(label, detailText)
  }
  host.append(item)
}

function appendTargets(host, view, dataKey, onChooseTarget, enabled) {
  for (const target of view.targets) {
    const button = createButton(
      target.label,
      () => onChooseTarget(target.instanceId),
      'game-button campaign-overlay__target',
    )
    button.dataset[dataKey] = target.instanceId
    button.disabled = !enabled
    host.append(button)
  }
}

// Route, shop, and event boundaries offer Run details and, once saved, the main menu,
// because the rest of the HUD is unavailable while their overlay is open.
const NODE_MODES = new Set(['route-map', 'shop', 'event'])

const TARGET_DATA_KEYS = Object.freeze({
  'reward-target': 'rewardTarget',
  'shop-target': 'shopTarget',
  'event-target': 'eventTarget',
})

function capitalize(text) {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`
}

function choiceDescription(match) {
  if (match.holdChoice.candidate === null) {
    return 'The prepared pile is empty. Reveal the held card to continue.'
  }
  return match.hold === null
    ? 'Reveal the prepared normal card.'
    : 'Reveal the prepared normal card or use Hold.'
}

export function createCampaignOverlay({
  onChooseNormal,
  onChooseHold,
  onRetrySave,
  onCapture,
  onRetry,
  onChooseOffer,
  onChooseTarget,
  onBack,
  onClose,
  onChooseRoute,
  onBuyItem,
  onLeaveShop,
  onChooseEventOption,
  onInspect,
  onMainMenu,
  onRestart,
  onCancel,
} = {}) {
  for (const [name, callback] of Object.entries({
    onChooseNormal,
    onChooseHold,
    onRetrySave,
    onCapture,
    onRetry,
    onChooseOffer,
    onChooseTarget,
    onBack,
    onClose,
    onChooseRoute,
    onBuyItem,
    onLeaveShop,
    onChooseEventOption,
    onInspect,
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
  const choiceHost = document.createElement('div')
  choiceHost.className = 'campaign-overlay__targets'
  choiceHost.dataset.campaignChoices = ''
  const detailHost = document.createElement('div')
  detailHost.className = 'campaign-overlay__details'
  detailHost.dataset.campaignDetails = ''
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
    save: createButton('Retry save', onRetrySave, 'game-button game-button--primary'),
    retry: createButton('Retry encounter', onRetry, 'game-button game-button--primary'),
    leave: createButton('Leave shop', onLeaveShop, 'game-button game-button--primary'),
    back: createButton('Back', onBack),
    close: createButton('Close', onClose, 'game-button game-button--primary'),
    inspect: createButton('Run details', onInspect),
    main: createButton('Main Menu', onMainMenu, 'game-button game-button--primary'),
    restart: createButton('Restart Campaign', onRestart),
    cancel: createButton('Cancel', onCancel),
  }
  for (const [action, button] of Object.entries(buttons)) {
    button.dataset.action = `campaign-${action}`
    actions.append(button)
  }
  panel.append(heading, description, choiceHost, detailHost, status, actions)
  element.append(panel)

  function setMode(mode, snapshot, options) {
    for (const button of Object.values(buttons)) button.hidden = true
    clearChildren(choiceHost)
    clearChildren(detailHost)
    const match = snapshot.match
    const view = options.view
    const boundarySaved = snapshot.saveStatus === 'saved'
    if (mode === 'hold-choice' || mode === 'informed-choice') {
      heading.textContent = 'Choose your reveal'
      description.textContent = choiceDescription(match)
      if (mode === 'informed-choice') {
        appendLineSection(detailHost, 'Hold Insight', view.lines)
      }
      buttons.normal.hidden = false
      buttons.normal.disabled = (
        options.busy
        || !boundarySaved
        || match.holdChoice.candidate === null
      )
      buttons.hold.hidden = match.hold === null
      buttons.hold.disabled = options.busy || !boundarySaved || match.hold === null
      buttons.save.hidden = snapshot.saveStatus !== 'failed'
      buttons.save.disabled = options.busy
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
        choiceHost.append(button)
      }
      buttons.cancel.hidden = false
      buttons.cancel.disabled = options.busy
    } else if (mode === 'retry') {
      heading.textContent = 'Encounter lost'
      description.textContent = `${match.encounter.name} dealt ${match.encounter.damage} damage. ${match.health} health remains.`
      buttons.retry.hidden = false
      buttons.retry.disabled = options.busy
    } else if (mode === 'reward-draft') {
      heading.textContent = 'Encounter won'
      description.textContent = boundarySaved
        ? view.description
        : 'Rewards can be chosen once this draft is saved.'
      for (const offer of view.offers) {
        appendChoice(choiceHost, {
          title: offer.title,
          detail: offer.detail,
          idPrefix: 'campaign-offer',
          id: offer.offerId,
          dataKey: 'rewardOffer',
          onChoose: onChooseOffer,
          enabled: !options.busy && boundarySaved && offer.available,
        })
      }
      appendLineSection(detailHost, 'Active modifiers', view.modifiers)
      buttons.save.hidden = snapshot.saveStatus !== 'failed'
      buttons.save.disabled = options.busy
    } else if (TARGET_DATA_KEYS[mode] !== undefined) {
      heading.textContent = view.heading
      description.textContent = view.description
      appendTargets(
        choiceHost,
        view,
        TARGET_DATA_KEYS[mode],
        onChooseTarget,
        !options.busy && boundarySaved,
      )
      buttons.back.hidden = false
      buttons.back.disabled = options.busy
    } else if (mode === 'route-map') {
      heading.textContent = view.title
      description.textContent = boundarySaved
        ? view.description
        : 'Your route can be chosen once this map is saved.'
      for (const node of view.nodes) {
        appendChoice(choiceHost, {
          title: node.title,
          detail: node.detail,
          idPrefix: 'campaign-route',
          id: node.nodeId,
          dataKey: 'routeNode',
          onChoose: onChooseRoute,
          enabled: !options.busy && boundarySaved,
          asButton: node.available,
        })
      }
      appendLineSection(detailHost, 'Expedition', view.summary)
      appendLineSection(detailHost, 'Active modifiers', view.modifiers)
    } else if (mode === 'shop') {
      heading.textContent = view.title
      description.textContent = boundarySaved
        ? view.description
        : 'Items can be bought once this shop is saved.'
      if (view.soldOut) {
        const soldOut = document.createElement('p')
        soldOut.className = 'campaign-overlay__line'
        soldOut.dataset.shopSoldOut = ''
        soldOut.textContent = 'Out of stock. Everything here has been sold.'
        choiceHost.append(soldOut)
      }
      for (const item of view.items) {
        appendChoice(choiceHost, {
          title: item.title,
          detail: item.detail,
          idPrefix: 'campaign-shop',
          id: item.itemId,
          dataKey: 'shopItem',
          onChoose: onBuyItem,
          enabled: !options.busy && boundarySaved && item.available,
        })
      }
      appendLineSection(detailHost, 'Active modifiers', view.modifiers)
      buttons.leave.hidden = false
      buttons.leave.disabled = options.busy || !boundarySaved
    } else if (mode === 'event') {
      heading.textContent = view.title
      description.textContent = boundarySaved
        ? view.description
        : 'An option can be chosen once this event is saved.'
      for (const option of view.options) {
        appendChoice(choiceHost, {
          title: option.title,
          detail: option.detail,
          idPrefix: 'campaign-event',
          id: option.optionId,
          dataKey: 'eventOption',
          onChoose: onChooseEventOption,
          enabled: !options.busy && boundarySaved && option.available,
        })
      }
      appendLineSection(detailHost, 'Expedition', view.summary)
      appendLineSection(detailHost, 'Active modifiers', view.modifiers)
    } else if (mode === 'decision-saving') {
      heading.textContent = view.failed
        ? `${capitalize(view.noun)} not saved`
        : `Saving ${view.noun}`
      description.textContent = view.failed
        ? `Your ${view.noun} is made but not saved. Retry the save to continue, or return to the main menu.`
        : `Saving your ${view.noun} before continuing…`
      buttons.save.hidden = !view.failed
      buttons.save.disabled = options.busy
      buttons.main.hidden = !view.failed
      buttons.main.disabled = options.busy
    } else if (mode === 'inspect') {
      heading.textContent = 'Run details'
      description.textContent = view.summary.join(' · ')
      appendLineSection(detailHost, 'Route', view.route)
      appendLineSection(detailHost, 'Active modifiers', view.modifiers)
      appendLineSection(detailHost, 'Expedition log', view.log, {
        ordered: true,
        emptyText: 'No decisions recorded yet.',
      })
      buttons.close.hidden = false
      buttons.close.disabled = options.busy
    } else if (mode === 'campaign-end') {
      heading.textContent = match.outcome.result === 'victory' ? 'Campaign victory' : 'Campaign defeat'
      description.textContent = match.outcome.result === 'victory'
        ? 'You won the final encounter of the expedition.'
        : 'Your health was depleted. Start a new campaign to try again.'
      appendLineSection(detailHost, 'Expedition', [view.route])
      buttons.main.hidden = false
      buttons.restart.hidden = false
      buttons.main.disabled = options.busy
      buttons.restart.disabled = options.busy
    }
    if (NODE_MODES.has(mode)) {
      buttons.inspect.hidden = false
      buttons.inspect.disabled = options.busy
      buttons.main.hidden = false
      buttons.main.disabled = options.busy || !boundarySaved
      buttons.save.hidden = snapshot.saveStatus !== 'failed'
      buttons.save.disabled = options.busy
    }
  }

  return {
    element,
    update(snapshot, {
      mode,
      targets = [],
      view = null,
      busy = false,
      error = null,
    } = {}) {
      setMode(mode, snapshot, { targets, view, busy })
      status.textContent = error
        ?? (snapshot.saveStatus === 'saving' ? 'Saving campaign…' : saveStatusText(snapshot))
    },
    teardown() {},
  }
}

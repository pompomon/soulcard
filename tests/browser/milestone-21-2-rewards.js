import { bootstrap } from '../../src/app/bootstrap.js'
import { createRunController } from '../../src/app/run-controller.js'
import { restoreRunSave } from '../../src/persistence/run-schema.js'
import { createSettingsRepository } from '../../src/persistence/settings-repository.js'

const output = document.querySelector('#reward-browser-results')
const consoleErrors = []
const originalConsoleError = console.error.bind(console)

console.error = (...values) => {
  consoleErrors.push(values.map(String).join(' '))
  originalConsoleError(...values)
}
globalThis.addEventListener('error', (event) => {
  consoleErrors.push(event.error?.message ?? event.message)
})
globalThis.addEventListener('unhandledrejection', (event) => {
  consoleErrors.push(event.reason instanceof Error ? event.reason.message : String(event.reason))
})

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function query(selector, name) {
  const element = document.querySelector(selector)
  if (element === null) throw new Error(`${name} was not found`)
  return element
}

function queryAll(selector) {
  return [...document.querySelectorAll(selector)]
}

function assertButton(button, label = null) {
  assert(button.tagName === 'BUTTON', `${label ?? 'Choice'} must be a button`)
  assert(button.type === 'button', `${label ?? 'Choice'} must not submit a form`)
  if (label !== null) {
    assert(button.textContent.trim() === label, `${label} must retain its accessible text`)
  }
}

function isShown(element) {
  return element.closest('[hidden]') === null
}

function visibleOverlayButtons() {
  return queryAll('#app [data-campaign-overlay] button')
    .filter(isShown)
    .map((button) => button.textContent.trim())
}

function assertWithinViewport(element, name) {
  const rect = element.getBoundingClientRect()
  assert(
    rect.left >= 0 && rect.right <= globalThis.innerWidth + 0.5,
    `${name} must fit the viewport width`,
  )
  assert(rect.width >= 44 && rect.height >= 44, `${name} must keep a 44px target`)
}

async function waitFor(predicate, name, timeoutMs = 15_000) {
  const startedAt = performance.now()
  while (!predicate()) {
    if (performance.now() - startedAt >= timeoutMs) {
      throw new Error(`Timed out waiting for ${name}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 16))
  }
}

function deferred() {
  let resolve
  const promise = new Promise((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function createUpdateController() {
  const snapshot = Object.freeze({
    status: 'idle',
    updateAvailable: false,
    activationStatus: 'idle',
    reason: null,
  })
  return Object.freeze({
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listener(snapshot)
      return () => {}
    },
    requestActivation: async () => Object.freeze({ status: 'skipped' }),
    destroy: async () => {},
  })
}

async function loadRewardDraft() {
  const response = await fetch(new URL('../fixtures/campaign-save-reward-v5.json', import.meta.url))
  if (!response.ok) throw new Error('The saved reward draft fixture could not be loaded')
  return restoreRunSave(await response.json())
}

async function run() {
  const draft = await loadRewardDraft()
  const settingsRepository = createSettingsRepository({ storage: null })
  settingsRepository.setReducedMotionOverride(false)
  const saves = []
  let holdNextSave = false
  let heldSave = null
  const runController = createRunController({
    repository: {
      load: async () => Object.freeze({
        status: 'resumable',
        savedAt: '2026-10-17T09:00:00.000Z',
        match: draft,
      }),
      save: async (run) => {
        saves.push(Object.freeze({
          encounterIndex: run.encounterIndex,
          machineState: run.machineState,
        }))
        if (holdNextSave) {
          holdNextSave = false
          heldSave = deferred()
          await heldSave.promise
        }
        return Object.freeze({
          status: 'saved',
          savedAt: `2026-10-17T09:01:${String(saves.length).padStart(2, '0')}.000Z`,
        })
      },
      discard: async () => Object.freeze({ status: 'discarded' }),
    },
  })
  const app = bootstrap({
    root: document.querySelector('#app'),
    runController,
    settingsRepository,
    matchMedia: null,
    pageLifecycleFactory: () => ({ destroy() {} }),
    updateController: createUpdateController(),
    updateNoticeFactory: () => ({ teardown() {} }),
    confirmStartOver: () => true,
  })

  await app.ready
  const resume = query('#app [data-action="resume"]', 'Resume action')
  assertButton(resume, 'Resume Game')
  await waitFor(() => resume.disabled === false, 'enabled Resume')
  resume.click()
  await waitFor(() => app.activeScreen === 'game', 'Campaign Game screen')
  assert(document.querySelectorAll('#app canvas').length === 1, 'Game must retain one canvas')

  const overlay = query('#app [data-campaign-overlay]', 'Campaign overlay')
  const heading = query('#campaign-overlay-title', 'Campaign overlay heading')
  const encounterMetric = query('#app [data-value="campaign-encounter"]', 'encounter metric')
  const status = query('#app [data-status-host]', 'Game status')
  const screen = query('#app .screen--game', 'Game screen')
  const offerSelector = '#app [data-reward-offer]'
  await waitFor(
    () => (
      queryAll(offerSelector).length === 4
      && queryAll(offerSelector).every((button) => button.disabled === false)
    ),
    'saved reward draft',
  )
  assert(overlay.hidden === false, 'Reward draft overlay must be visible')
  assert(heading.textContent === 'Encounter won', 'Reward draft must announce the win')
  assert(encounterMetric.textContent === '1/3', 'Draft must keep the won encounter visible')
  const offers = queryAll(offerSelector)
  for (const offer of offers) {
    assertButton(offer)
    assertWithinViewport(offer, `${offer.textContent.trim()} offer`)
    const detailId = offer.getAttribute('aria-describedby')
    assert(
      detailId !== null && document.getElementById(detailId)?.textContent.trim().length > 0,
      `${offer.textContent.trim()} offer must describe its effect`,
    )
  }
  const draftButtons = visibleOverlayButtons()

  query('#app [data-reward-offer="deck-edit"]', 'deck edit offer').click()
  await waitFor(
    () => document.querySelector('#app [data-reward-target]') !== null,
    'reward target list',
  )
  const targets = queryAll('#app [data-reward-target]')
  targets.forEach((target) => assertButton(target))
  assert(
    targets.every((target) => target.dataset.rewardTarget !== app.runSnapshot.match.hold),
    'The held card must never be a reward target',
  )
  const targetList = query('#app [data-campaign-choices]', 'reward target list')
  const targetListScrollable = targetList.scrollHeight > targetList.clientHeight
  const targetHeading = heading.textContent
  const targetButtons = visibleOverlayButtons()
  const back = query('#app [data-action="campaign-back"]', 'Back action')
  assertButton(back, 'Back')
  back.click()
  await waitFor(() => queryAll(offerSelector).length === 4, 'reward draft after Back')
  assert(app.runSnapshot.match.machineState === 'awaitingReward', 'Back must not choose a reward')

  const metricChanges = []
  const metricObserver = new MutationObserver(() => {
    metricChanges.push(Object.freeze({
      text: encounterMetric.textContent,
      saveStatus: app.runSnapshot.saveStatus,
      savedEncounterIndexes: saves.map(({ encounterIndex }) => encounterIndex),
    }))
  })
  metricObserver.observe(encounterMetric, {
    childList: true,
    characterData: true,
    subtree: true,
  })
  holdNextSave = true
  const modifierOffer = query('#app [data-reward-offer="modifier"]', 'modifier offer')
  assertButton(modifierOffer, 'Modifier: Hold Insight')
  modifierOffer.click()
  await waitFor(() => heldSave !== null, 'reward save start')
  assert(app.runSnapshot.match.encounterIndex === 1, 'The reward must commit the next encounter')
  await new Promise((resolve) => setTimeout(resolve, 250))
  const whileSaving = Object.freeze({
    heading: heading.textContent,
    encounter: encounterMetric.textContent,
    saveStatus: app.runSnapshot.saveStatus,
    status: status.textContent,
    buttons: visibleOverlayButtons(),
  })
  assert(whileSaving.heading === 'Saving reward', 'Reward save must be announced')
  assert(whileSaving.encounter === '1/3', 'Next encounter must stay hidden while saving')
  assert(whileSaving.saveStatus === 'saving', 'Reward save must still be pending')
  heldSave.resolve()
  await waitFor(
    () => encounterMetric.textContent === '2/3' && overlay.hidden === true,
    'next encounter after the reward save',
  )
  metricObserver.disconnect()
  const nextEncounterShown = metricChanges.find(({ text }) => text === '2/3')
  assert(nextEncounterShown?.saveStatus === 'saved', 'Next encounter must follow a saved reward')
  assert(
    nextEncounterShown.savedEncounterIndexes.includes(1),
    'The saved reward state must precede the next encounter',
  )

  const reveal = query('#app [data-action="reveal"]', 'Reveal action')
  await waitFor(() => reveal.disabled === false, 'enabled reveal in the next encounter')
  reveal.click()
  await waitFor(
    () => app.runSnapshot.match?.machineState === 'awaitingInformedHoldChoice',
    'informed Hold choice',
  )
  const normalChoice = query('#app [data-action="campaign-normal"]', 'normal reveal choice')
  assertButton(normalChoice, 'Reveal normal card')
  await waitFor(
    () => isShown(normalChoice) && normalChoice.disabled === false,
    'saved informed choice',
  )
  const informedSaveStatus = app.runSnapshot.saveStatus
  assert(informedSaveStatus === 'saved', 'Informed choices must enable only after saving')
  const peek = app.runSnapshot.match.holdChoice
  const insightLines = queryAll('#app [data-campaign-details] li')
    .map((line) => line.textContent.trim())
  assert(insightLines.length === 3, 'Hold Insight must list both next cards and the Hold')
  assert(insightLines[0].startsWith("Opponent's next card:"), 'Opponent peek must be shown')
  const informedButtons = visibleOverlayButtons()
  assertWithinViewport(normalChoice, 'Informed normal choice')
  normalChoice.click()
  await waitFor(
    () => (
      app.runSnapshot.match?.machineState === 'ready'
      && app.runSnapshot.saveStatus === 'saved'
      && status.dataset.presentationState === 'completed'
      && reveal.disabled === false
    ),
    'informed choice presentation',
  )
  const reveals = app.runSnapshot.match.pendingEvent.reveals
  assert(reveals[0].instanceId === peek.candidate, 'Normal choice must reveal the peeked card')
  assert(
    reveals[1].instanceId === peek.opponentCandidate,
    'Opponent must reveal the peeked card',
  )

  const inspect = query('#app [data-action="inspect"]', 'Run details action')
  assertButton(inspect, 'Run details')
  await waitFor(() => inspect.disabled === false, 'enabled Run details')
  inspect.click()
  await waitFor(
    () => overlay.hidden === false && heading.textContent === 'Run details',
    'Run details panel',
  )
  const inspection = Object.freeze({
    summary: query('#app [data-campaign-description]', 'Run details summary').textContent,
    sections: queryAll('#app [data-campaign-details] h3')
      .map((title) => title.textContent.trim()),
    modifiers: queryAll('#app [data-campaign-details] ul li')
      .map((line) => line.textContent.trim()),
    history: queryAll('#app [data-campaign-details] ol li')
      .map((line) => line.textContent.trim()),
  })
  assert(
    inspection.history.length === 1 && inspection.history[0] === 'Encounter 1: Gained Hold Insight',
    'Run details must list the chosen reward',
  )
  const inspectButtons = visibleOverlayButtons()
  const close = query('#app [data-action="campaign-close"]', 'Close action')
  assertButton(close, 'Close')
  close.click()
  await waitFor(() => overlay.hidden === true, 'closed Run details')
  assert(app.runSnapshot.match.machineState === 'ready', 'Run details must be read-only')
  assert(document.querySelectorAll('#app canvas').length === 1, 'Campaign must retain one canvas')
  assert(consoleErrors.length === 0, 'Reward check reported a relevant console error')

  const report = Object.freeze({
    reportVersion: 1,
    viewport: {
      width: globalThis.innerWidth,
      height: globalThis.innerHeight,
      layoutMode: screen.dataset.layoutMode,
    },
    canvasCount: document.querySelectorAll('#app canvas').length,
    rewardDraft: {
      offers: offers.map((offer) => offer.textContent.trim()),
      buttons: draftButtons,
    },
    rewardTarget: {
      heading: targetHeading,
      targetCount: targets.length,
      scrollable: targetListScrollable,
      buttons: targetButtons,
    },
    rewardSave: {
      whileSaving,
      nextEncounterShownAfterSave: nextEncounterShown,
      saves: saves.map(({ encounterIndex, machineState }) => `${encounterIndex}:${machineState}`),
    },
    informedChoice: {
      saveStatusWhenEnabled: informedSaveStatus,
      lines: insightLines,
      buttons: informedButtons,
      reveals: reveals.slice(0, 2).map(({ instanceId, from }) => ({ instanceId, from })),
    },
    inspection: {
      ...inspection,
      buttons: inspectButtons,
    },
    consoleErrors,
  })
  globalThis.__SOULCARD_MILESTONE_21_2_REPORT__ = report
  output.dataset.status = 'complete'
  output.textContent = JSON.stringify(report, null, 2)
  console.info(`SOULCARD_MILESTONE_21_2 ${JSON.stringify(report)}`)
}

run().catch((error) => {
  output.dataset.status = 'failed'
  output.textContent = JSON.stringify({
    reportVersion: 1,
    error: error instanceof Error ? error.message : String(error),
    consoleErrors,
  }, null, 2)
  console.error(error)
})

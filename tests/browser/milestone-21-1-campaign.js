import { bootstrap } from '../../src/app/bootstrap.js'
import { createRunController } from '../../src/app/run-controller.js'
import { createCampaignRun } from '../../src/domain/campaign-machine.js'
import { createSettingsRepository } from '../../src/persistence/settings-repository.js'

const output = document.querySelector('#campaign-browser-results')
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

function assertButton(button, label = null) {
  assert(button.tagName === 'BUTTON', `${label ?? 'Choice'} must be a button`)
  assert(button.type === 'button', `${label ?? 'Choice'} must not submit a form`)
  if (label !== null) {
    assert(button.textContent.trim() === label, `${label} must retain its accessible text`)
  }
}

async function waitFor(predicate, name, timeoutMs = 10_000) {
  const startedAt = performance.now()
  while (!predicate()) {
    if (performance.now() - startedAt >= timeoutMs) {
      throw new Error(`Timed out waiting for ${name}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 16))
  }
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

async function run() {
  const settingsRepository = createSettingsRepository({ storage: null })
  settingsRepository.setReducedMotionOverride(false)
  let saveCount = 0
  const runController = createRunController({
    repository: {
      load: async () => Object.freeze({ status: 'empty' }),
      save: async () => {
        saveCount += 1
        return Object.freeze({
          status: 'saved',
          savedAt: `2026-09-25T06:00:${String(saveCount).padStart(2, '0')}.000Z`,
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
    newCampaignFactory: ({ ruleset }) => createCampaignRun({
      runId: 'milestone-21-1-browser',
      seed: 3,
      ruleset,
    }),
    confirmStartOver: () => true,
  })

  await app.ready
  const campaignAction = query('#app [data-action="campaign"]', 'Campaign action')
  assertButton(campaignAction, 'Campaign')
  campaignAction.click()
  await waitFor(
    () => app.activeScreen === 'game' && app.runSnapshot.match?.mode === 'campaign',
    'Campaign Game screen',
  )
  await waitFor(() => app.runSnapshot.saveStatus === 'saved', 'initial Campaign save')

  const initial = app.runSnapshot.match
  assert(initial.encounter.supplyMode.player === 'source', 'Campaign must start in source mode')
  assert(initial.encounter.zones.playerSourcePile.length > 0, 'Player source pile must render')
  assert(initial.encounter.zones.opponentSourcePile.length > 0, 'Opponent source pile must render')
  assert(document.querySelectorAll('#app canvas').length === 1, 'Game must retain one canvas')

  const reveal = query('#app [data-action="reveal"]', 'Reveal action')
  const presentationStatus = query('#app [data-status-host]', 'presentation status')
  assertButton(reveal, 'Reveal / Continue')
  await waitFor(() => reveal.disabled === false, 'enabled source reveal')
  reveal.click()
  await waitFor(
    () => (
      app.runSnapshot.match?.machineState === 'awaitingHoldChoice'
      && app.runSnapshot.saveStatus === 'saved'
    ),
    'saved source Hold decision',
  )

  const normalChoice = query(
    '#app [data-action="campaign-normal"]',
    'normal reveal choice',
  )
  assertButton(normalChoice, 'Reveal normal card')
  assert(normalChoice.hidden === false, 'Normal reveal choice must be visible')
  assert(normalChoice.disabled === false, 'Saved normal reveal choice must be enabled')
  const firstCandidate = app.runSnapshot.match.holdChoice.candidate
  normalChoice.click()
  await waitFor(
    () => (
      app.runSnapshot.match?.turn === 1
      && app.runSnapshot.saveStatus === 'saved'
      && presentationStatus.dataset.presentationState === 'completed'
      && reveal.disabled === false
    ),
    'first Campaign presentation',
  )
  const sourcePresentationState = presentationStatus.dataset.presentationState
  assert(
    app.runSnapshot.match.pendingEvent.reveals[0].instanceId === firstCandidate
      && app.runSnapshot.match.pendingEvent.reveals[0].from === 'player.sourcePile',
    'Normal source choice must reveal the persisted candidate',
  )

  const holdAction = query('#app [data-action="hold"]', 'Hold action')
  assertButton(holdAction, 'Hold')
  assert(holdAction.disabled === false, 'Hold management must be enabled after settlement')
  holdAction.click()
  await waitFor(
    () => document.querySelector('#app [data-hold-target]') !== null,
    'eligible Hold target',
  )
  const target = query('#app [data-hold-target]', 'Hold target')
  assertButton(target)
  const heldInstanceId = target.dataset.holdTarget
  target.click()
  await waitFor(
    () => (
      app.runSnapshot.match?.hold === heldInstanceId
      && app.runSnapshot.saveStatus === 'saved'
      && reveal.disabled === false
    ),
    'saved Hold capture',
  )
  assert(document.querySelectorAll('#app canvas').length === 1, 'Hold sync must retain one canvas')

  reveal.click()
  await waitFor(
    () => (
      app.runSnapshot.match?.machineState === 'awaitingHoldChoice'
      && app.runSnapshot.saveStatus === 'saved'
    ),
    'saved occupied-Hold decision',
  )
  const heldChoice = query('#app [data-action="campaign-hold"]', 'held reveal choice')
  assertButton(heldChoice, 'Reveal held card')
  assert(heldChoice.hidden === false, 'Held reveal choice must be visible')
  assert(heldChoice.disabled === false, 'Saved held reveal choice must be enabled')
  heldChoice.click()
  await waitFor(
    () => (
      app.runSnapshot.match?.turn === 2
      && app.runSnapshot.saveStatus === 'saved'
      && presentationStatus.dataset.presentationState === 'completed'
      && reveal.disabled === false
    ),
    'held-card Campaign presentation',
  )
  const holdPresentationState = presentationStatus.dataset.presentationState
  const heldReveal = app.runSnapshot.match.pendingEvent.reveals[0]
  assert(heldReveal.instanceId === heldInstanceId, 'Hold must reveal the captured instance')
  assert(heldReveal.from === 'player.hold', 'Hold reveal must retain its origin')
  assert(document.querySelectorAll('#app canvas').length === 1, 'Campaign must retain one canvas')
  assert(consoleErrors.length === 0, 'Campaign check reported a relevant console error')

  const report = Object.freeze({
    reportVersion: 1,
    canvasCount: document.querySelectorAll('#app canvas').length,
    sourceChoice: {
      instanceId: firstCandidate,
      from: 'player.sourcePile',
    },
    holdChoice: {
      instanceId: heldInstanceId,
      from: heldReveal.from,
    },
    semanticChoices: [
      normalChoice.textContent.trim(),
      heldChoice.textContent.trim(),
    ],
    presentationStates: [
      sourcePresentationState,
      holdPresentationState,
    ],
    consoleErrors,
  })
  globalThis.__SOULCARD_MILESTONE_21_1_REPORT__ = report
  output.dataset.status = 'complete'
  output.textContent = JSON.stringify(report, null, 2)
  console.info(`SOULCARD_MILESTONE_21_1 ${JSON.stringify(report)}`)
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

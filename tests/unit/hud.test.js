import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createRunController } from '../../src/app/run-controller.js'
import {
  createCampaignRun,
  getCampaignRestTargets,
  getCampaignRewardTargets,
  getCampaignShopTargets,
  getEligibleHoldTargets,
} from '../../src/domain/campaign-machine.js'
import { createMatch, revealOrContinue } from '../../src/domain/match-machine.js'
import { BASELINE_RULESET } from '../../src/domain/ruleset.js'
import { restoreRunSave } from '../../src/persistence/run-schema.js'
import { blockerText } from '../../src/ui/campaign-view.js'
import { createGameScreen } from '../../src/ui/hud.js'
import { createCampaignOverlay } from '../../src/ui/overlays.js'
import { createUpdateNotice } from '../../src/ui/update-notice.js'
import {
  advanceClash,
  arrangeInability,
  chooseRestOption,
  chooseRoute,
  claimReward,
  loseEncounter,
  passThrough,
  startCampaign,
  winEncounter,
} from '../fixtures/campaign-route.js'

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase()
    this.children = []
    this.dataset = {}
    this.attributes = {}
    this.listeners = new Map()
    this.className = ''
    this.textContent = ''
    this.type = ''
    this.checked = false
    this.hidden = false
    this.disabled = false
    this.style = {
      values: new Map(),
      setProperty: (name, value) => this.style.values.set(name, value),
    }
  }

  append(...children) {
    this.children.push(...children)
  }

  setAttribute(name, value) {
    this.attributes[name] = value
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener)
  }

  dispatch(type, values = {}) {
    const event = {
      type,
      target: this,
      currentTarget: this,
      button: undefined,
      detail: 0,
      isPrimary: true,
      pointerId: 1,
      pointerType: 'mouse',
      preventDefault() {},
      stopPropagation() {},
      ...values,
    }
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event)
    }
    return event
  }

  dispatchEvent(event) {
    this.dispatch(event.type, event)
    return true
  }
}

function descendants(element) {
  return [element, ...element.children.flatMap(descendants)]
}

function byAction(screen, action) {
  return descendants(screen.element).find((element) => element.dataset.action === action)
}

function byValue(screen, value) {
  return descendants(screen.element).find((element) => element.dataset.value === value)
}

function deferred() {
  let resolve
  const promise = new Promise((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

async function flushMicrotasks(rounds = 6) {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve()
  }
}

async function waitFor(predicate, rounds = 100) {
  for (let index = 0; index < rounds; index += 1) {
    if (predicate()) return
    await Promise.resolve()
  }
  assert.fail('Condition did not settle')
}

const CAMPAIGN_SAVED_AT = '2026-10-17T09:00:00.000Z'
const SAVE_FAILURE = Object.freeze({
  status: 'storage-unavailable',
  operation: 'save',
  reason: 'quota-exceeded',
})

function restoredFixture(name) {
  return restoreRunSave(JSON.parse(readFileSync(
    new URL(`../fixtures/${name}`, import.meta.url),
    'utf8',
  )))
}

function campaignOverlayParts(screen) {
  const all = descendants(screen.element)
  const overlay = all.find((element) => Object.hasOwn(element.dataset, 'campaignOverlay'))
  const within = descendants(overlay)
  return {
    overlay,
    heading: within.find((element) => element.id === 'campaign-overlay-title'),
    description: within.find((element) => Object.hasOwn(element.dataset, 'campaignDescription')),
    offers: () => descendants(overlay).filter(
      (element) => element.dataset.rewardOffer !== undefined,
    ),
    targets: () => descendants(overlay).filter(
      (element) => element.dataset.rewardTarget !== undefined,
    ),
    withData: (key) => descendants(overlay).filter(
      (element) => element.tagName === 'BUTTON' && element.dataset[key] !== undefined,
    ),
    routeButtons: () => descendants(overlay).filter(
      (element) => element.tagName === 'BUTTON' && element.dataset.routeNode !== undefined,
    ),
    routeEntries: () => descendants(overlay).filter(
      (element) => element.dataset.routeNode !== undefined,
    ),
    choiceDetails: () => descendants(overlay).filter(
      (element) => element.className === 'campaign-offer__detail',
    ).map((element) => element.textContent),
    details: () => descendants(
      within.find((element) => Object.hasOwn(element.dataset, 'campaignDetails')),
    )
      .filter((element) => ['H3', 'LI', 'P'].includes(element.tagName))
      .map((element) => element.textContent),
  }
}

function createSettledEventPlayerFactory(presented) {
  return () => ({
    present(match) {
      presented.push(match)
      return Promise.resolve({
        status: match.pendingEvent === null ? 'synchronized' : 'completed',
        eventId: match.pendingEvent?.id ?? null,
        reason: null,
      })
    },
    setPaused() {},
    destroy() {},
  })
}

function createControlledEventPlayerFactory(presentations) {
  return ({ onStateChange }) => ({
    present(match) {
      if (match.pendingEvent === null) {
        return Promise.resolve({ status: 'synchronized', eventId: null, reason: null })
      }
      const eventId = match.pendingEvent.id
      const completion = deferred()
      presentations.push({ match, completion })
      onStateChange({
        status: 'playing',
        eventId,
        stepIndex: 0,
        stepCount: 1,
        stepKind: 'reveal',
        reason: null,
      })
      return completion.promise.then(({ status = 'completed', reason = null } = {}) => {
        onStateChange({
          status,
          eventId,
          stepIndex: null,
          stepCount: 1,
          stepKind: null,
          reason,
        })
        return { status, eventId, reason }
      })
    },
    setPaused() {},
    destroy() {},
  })
}

test('Game owns a semantic pause overlay with live save status and Resume', async (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  const saves = []
  const controller = createRunController({
    repository: {
      load: async () => ({ status: 'empty' }),
      async save(match) {
        saves.push(match)
        return {
          status: 'saved',
          savedAt: '2026-09-21T11:00:00.000Z',
        }
      },
    },
    initialMatch: createMatch({
      runId: 'hud-pause',
      seed: 12345,
      ruleset: BASELINE_RULESET,
    }),
  })
  let battlefieldTeardowns = 0
  const battlefieldPauses = []
  const screen = createGameScreen({
    runController: controller,
    mountBattlefield: (host, { onLayout }) => {
      assert.ok(Object.hasOwn(host.dataset, 'battlefield'))
      onLayout({
        mode: 'phone-portrait',
        viewport: {
          letterboxed: false,
          scale: 1,
          logicalWidth: 320,
          logicalHeight: 480,
        },
        safeArea: { top: 1, right: 2, bottom: 3, left: 4 },
        hud: {
          header: { height: 72 },
          comparison: { height: 80 },
          footer: { height: 210 },
          leftPanel: { width: 0 },
        },
      })
      return {
        setPaused(value) {
          battlefieldPauses.push(value)
        },
        teardown() {
          battlefieldTeardowns += 1
        },
      }
    },
  })
  const elements = descendants(screen.element)
  const overlayHost = elements.find(
    (element) => Object.hasOwn(element.dataset, 'overlayHost'),
  )
  const overlay = elements.find(
    (element) => Object.hasOwn(element.dataset, 'pauseOverlay'),
  )
  const saveStatus = elements.find(
    (element) => Object.hasOwn(element.dataset, 'saveStatus'),
  )
  const pause = byAction(screen, 'pause')
  const resume = byAction(screen, 'resume')

  assert.ok(overlayHost.children.includes(overlay))
  assert.equal(overlay.attributes.role, 'dialog')
  assert.equal(overlay.attributes['aria-modal'], 'true')
  assert.equal(overlay.hidden, true)
  assert.equal(pause.disabled, false)
  assert.equal(screen.element.dataset.layoutMode, 'phone-portrait')
  assert.equal(screen.element.dataset.letterboxed, 'false')
  assert.equal(screen.element.style.values.get('--hud-header-reserve'), '72px')
  assert.equal(screen.element.style.values.get('--hud-comparison-reserve'), '80px')
  assert.equal(screen.element.style.values.get('--hud-control-min-size'), '44px')
  assert.equal(screen.element.style.values.get('--battlefield-logical-width'), '320px')
  assert.equal(screen.element.style.values.get('--safe-area-left'), '4px')
  assert.deepEqual(battlefieldPauses, [false])

  pause.dispatch('click')
  assert.equal(controller.currentMatch.machineState, 'paused')
  assert.equal(overlay.hidden, false)
  assert.match(saveStatus.textContent, /Saving/)
  assert.deepEqual(battlefieldPauses, [false, true])
  await controller.whenIdle()
  await Promise.resolve()
  assert.equal(saves.length, 1)
  assert.equal(saves[0].machineState, 'paused')
  assert.equal(saveStatus.textContent, 'Game saved.')

  resume.dispatch('click')
  await Promise.resolve()
  assert.equal(controller.currentMatch.machineState, 'ready')
  assert.equal(overlay.hidden, true)
  assert.equal(pause.disabled, false)
  assert.deepEqual(battlefieldPauses, [false, true, false])

  screen.teardown()
  pause.dispatch('click')
  assert.equal(controller.currentMatch.machineState, 'ready')
  assert.equal(battlefieldTeardowns, 1)
})

test('Game leaves pause disabled without a run controller and still tears down presentation', (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  let teardowns = 0
  const screen = createGameScreen({
    mountBattlefield: () => () => {
      teardowns += 1
    },
  })

  assert.equal(byAction(screen, 'pause').disabled, true)
  assert.equal(
    descendants(screen.element).find(
      (element) => Object.hasOwn(element.dataset, 'pauseOverlay'),
    ).hidden,
    true,
  )
  screen.teardown()
  assert.equal(teardowns, 1)
})

test('Game combines match pause with graphics recovery and keeps safe controls available', async (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  let saveCalls = 0
  const controller = createRunController({
    repository: {
      load: async () => ({ status: 'empty' }),
      async save() {
        saveCalls += 1
        if (saveCalls === 2) {
          return {
            status: 'storage-unavailable',
            operation: 'save',
            reason: 'quota-exceeded',
          }
        }
        return {
          status: 'saved',
          savedAt: '2026-09-23T12:00:00.000Z',
        }
      },
    },
    initialMatch: createMatch({
      runId: 'hud-context-recovery',
      seed: 0,
      ruleset: BASELINE_RULESET,
    }),
  })
  let publishContext
  const pauses = []
  const cancellations = []
  const deckStates = []
  const screen = createGameScreen({
    runController: controller,
    mountBattlefield: (host, options) => {
      publishContext = options.onContextStatus
      return {
        setDeckInputState(state) {
          deckStates.push(state)
        },
        teardown() {},
      }
    },
    eventPlayerFactory: () => ({
      present(match) {
        return Promise.resolve({
          status: match.pendingEvent === null ? 'synchronized' : 'completed',
          eventId: match.pendingEvent?.id ?? null,
          reason: null,
        })
      },
      setPaused(value) {
        pauses.push(value)
      },
      cancel(reason) {
        cancellations.push(reason)
      },
      destroy() {},
    }),
  })
  const reveal = byAction(screen, 'reveal')
  const pause = byAction(screen, 'pause')
  const resume = byAction(screen, 'resume')
  const saveAndMain = byAction(screen, 'save-main')
  const status = descendants(screen.element).find(
    (element) => Object.hasOwn(element.dataset, 'statusHost'),
  )
  const hud = descendants(screen.element).find(
    (element) => element.className === 'game-hud',
  )
  const pauseOverlayStatus = descendants(screen.element).find(
    (element) => Object.hasOwn(element.dataset, 'saveStatus'),
  )

  assert.equal(typeof publishContext, 'function')
  assert.equal(status.attributes.role, 'status')
  assert.equal(status.attributes['aria-live'], 'polite')
  assert.equal(status.attributes['aria-atomic'], 'true')
  assert.equal(reveal.disabled, false)
  assert.equal(pause.disabled, false)

  publishContext({ status: 'lost', recoveryCount: 0, reason: null })
  assert.equal(pauses.at(-1), true)
  assert.equal(reveal.disabled, true)
  assert.equal(pause.disabled, false)
  assert.deepEqual(deckStates.at(-1), { enabled: false, busy: true })
  assert.match(status.textContent, /Graphics context lost/)

  pause.dispatch('click')
  await controller.whenIdle()
  await flushMicrotasks()
  assert.equal(controller.currentMatch.machineState, 'paused')
  assert.equal(hud.inert, true)
  assert.match(pauseOverlayStatus.textContent, /Graphics context lost/)

  publishContext({ status: 'restoring', recoveryCount: 0, reason: null })
  assert.equal(
    pauseOverlayStatus.textContent,
    'Restoring graphics from the current game state…',
  )
  publishContext({
    status: 'failed',
    recoveryCount: 0,
    reason: 'replacement unavailable',
  })
  assert.match(pauseOverlayStatus.textContent, /replacement unavailable/)
  assert.equal(cancellations.at(-1), 'graphics-recovery-failed')

  saveAndMain.dispatch('click')
  assert.equal(
    pauseOverlayStatus.textContent,
    'Saving before returning to the main menu…',
  )
  await controller.whenIdle()
  await flushMicrotasks()
  assert.match(pauseOverlayStatus.textContent, /quota-exceeded/)
  assert.doesNotMatch(pauseOverlayStatus.textContent, /replacement unavailable/)

  publishContext({ status: 'ready', recoveryCount: 1, reason: null })
  assert.equal(pauses.at(-1), true)
  assert.match(status.textContent, /Game paused/)
  assert.match(pauseOverlayStatus.textContent, /quota-exceeded/)
  resume.dispatch('click')
  await flushMicrotasks()
  assert.equal(controller.currentMatch.machineState, 'ready')
  assert.equal(pauses.at(-1), false)
  assert.equal(hud.inert, false)
  assert.equal(reveal.disabled, false)

  publishContext({ status: 'lost', recoveryCount: 1, reason: null })
  publishContext({ status: 'restoring', recoveryCount: 1, reason: null })
  assert.match(status.textContent, /Restoring graphics/)
  publishContext({
    status: 'failed',
    recoveryCount: 1,
    reason: 'replacement unavailable',
  })
  assert.equal(pauses.at(-1), true)
  assert.equal(reveal.disabled, true)
  assert.equal(pause.disabled, false)
  assert.match(status.textContent, /replacement unavailable/)
  assert.equal(cancellations.length, 2)

  screen.teardown()
  await controller.destroy()
})

test('Save & Main Menu retries failed persistence without leaving pause', async (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  let saveCalls = 0
  const controller = createRunController({
    repository: {
      load: async () => ({ status: 'empty' }),
      async save() {
        saveCalls += 1
        if (saveCalls === 2) {
          return {
            status: 'storage-unavailable',
            operation: 'save',
            reason: 'quota-exceeded',
          }
        }
        return {
          status: 'saved',
          savedAt: `2026-09-23T01:00:0${saveCalls}.000Z`,
        }
      },
    },
    initialMatch: createMatch({
      runId: 'hud-save-main',
      seed: 12345,
      ruleset: BASELINE_RULESET,
    }),
  })
  let mainMenuCalls = 0
  const screen = createGameScreen({
    runController: controller,
    mountBattlefield: () => undefined,
    onMainMenu() {
      mainMenuCalls += 1
    },
  })
  const pause = byAction(screen, 'pause')
  const saveAndMain = byAction(screen, 'save-main')
  const overlay = descendants(screen.element).find(
    (element) => Object.hasOwn(element.dataset, 'pauseOverlay'),
  )
  const saveStatus = descendants(screen.element).find(
    (element) => Object.hasOwn(element.dataset, 'saveStatus'),
  )

  pause.dispatch('click')
  await controller.whenIdle()
  await flushMicrotasks()
  assert.equal(controller.currentMatch.machineState, 'paused')
  assert.equal(overlay.hidden, false)

  saveAndMain.dispatch('click')
  await controller.whenIdle()
  await flushMicrotasks()
  assert.equal(mainMenuCalls, 0)
  assert.equal(controller.currentMatch.machineState, 'paused')
  assert.equal(overlay.hidden, false)
  assert.match(saveStatus.textContent, /quota-exceeded/)
  assert.match(saveStatus.textContent, /Stay paused/)

  saveAndMain.dispatch('click')
  await controller.whenIdle()
  await flushMicrotasks()
  assert.equal(mainMenuCalls, 1)
  assert.equal(saveCalls, 3)

  screen.teardown()
  await controller.destroy()
})

test('Campaign Hold choices stay blocked until the decision boundary is saved', async (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  let saveCalls = 0
  const controller = createRunController({
    repository: {
      load: async () => ({ status: 'empty' }),
      async save() {
        saveCalls += 1
        if (saveCalls === 1) {
          return {
            status: 'storage-unavailable',
            operation: 'save',
            reason: 'quota-exceeded',
          }
        }
        return {
          status: 'saved',
          savedAt: '2026-09-25T06:00:00.000Z',
        }
      },
    },
    initialMatch: startCampaign({
      runId: 'hud-campaign-save-boundary',
      seed: 3,
      ruleset: BASELINE_RULESET,
    }),
  })
  const screen = createGameScreen({
    runController: controller,
    mountBattlefield: () => undefined,
  })
  const overlay = descendants(screen.element).find(
    (element) => Object.hasOwn(element.dataset, 'campaignOverlay'),
  )
  const normal = byAction(screen, 'campaign-normal')
  const retrySave = byAction(screen, 'campaign-save')

  byAction(screen, 'reveal').dispatch('click')
  await controller.whenIdle()
  await flushMicrotasks()

  assert.equal(controller.currentMatch.machineState, 'awaitingHoldChoice')
  assert.equal(controller.getSnapshot().saveStatus, 'failed')
  assert.equal(overlay.hidden, false)
  assert.equal(normal.disabled, true)
  assert.equal(retrySave.hidden, false)
  normal.dispatch('click')
  assert.equal(controller.currentMatch.machineState, 'awaitingHoldChoice')
  assert.equal(controller.currentMatch.turn, 0)
  assert.throws(
    () => controller.chooseHoldChoice('normal'),
    /must be saved before it can be resolved/,
  )

  retrySave.dispatch('click')
  await controller.whenIdle()
  await flushMicrotasks()

  assert.equal(saveCalls, 2)
  assert.equal(controller.getSnapshot().saveStatus, 'saved')
  assert.equal(overlay.hidden, false)
  assert.equal(normal.disabled, false)
  assert.equal(retrySave.hidden, true)

  screen.teardown()
  await controller.destroy()
})

test('Campaign reward drafts unlock after their save and hold the next encounter until the reward saves', async (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  const writes = []
  const controller = createRunController({
    repository: {
      load: async () => ({ status: 'empty' }),
      save() {
        const write = deferred()
        writes.push(write)
        return write.promise
      },
    },
    initialMatch: restoredFixture('campaign-save-reward-v7.json'),
  })
  const presented = []
  const screen = createGameScreen({
    runController: controller,
    mountBattlefield: () => undefined,
    eventPlayerFactory: createSettledEventPlayerFactory(presented),
  })
  const parts = campaignOverlayParts(screen)
  const status = descendants(screen.element).find(
    (element) => Object.hasOwn(element.dataset, 'statusHost'),
  )
  const encounter = byValue(screen, 'campaign-route')
  const retrySave = byAction(screen, 'campaign-save')
  const mainMenu = byAction(screen, 'campaign-main')
  const inspect = byAction(screen, 'inspect')

  assert.equal(parts.overlay.hidden, true)
  assert.equal(encounter.textContent, '1/7')
  assert.equal(inspect.hidden, false)
  assert.equal(inspect.disabled, true)

  const draftSave = controller.saveStable()
  await waitFor(() => writes.length === 1)
  writes[0].resolve(SAVE_FAILURE)
  await draftSave
  await flushMicrotasks()

  assert.equal(parts.overlay.hidden, false)
  assert.equal(parts.heading.textContent, 'Encounter won')
  assert.equal(parts.description.textContent, 'Rewards can be chosen once this draft is saved.')
  assert.deepEqual(
    parts.offers().map((button) => [button.dataset.rewardOffer, button.textContent]),
    [
      ['new-card', 'New card: QS'],
      ['deck-edit', 'Remove a card'],
      ['modifier', 'Modifier: Hold Insight'],
      ['mend', 'Mend'],
    ],
  )
  assert.ok(parts.offers().every((button) => button.disabled))
  assert.equal(parts.details()[0], 'Active modifiers')
  assert.match(parts.details()[1], /^Vitality Cap \(Permanent\)/)
  assert.equal(retrySave.hidden, false)
  parts.offers().at(-1).dispatch('click')
  assert.equal(controller.currentMatch.machineState, 'awaitingReward')

  retrySave.dispatch('click')
  await waitFor(() => writes.length === 2)
  writes[1].resolve({ status: 'saved', savedAt: CAMPAIGN_SAVED_AT })
  await controller.whenIdle()
  await flushMicrotasks()

  assert.equal(
    parts.description.textContent,
    'Choose one reward before returning to the map. The Suit Opposition bounty pays 3 coins when you choose.',
  )
  assert.ok(parts.offers().every((button) => !button.disabled))
  assert.equal(retrySave.hidden, true)
  assert.equal(status.textContent, 'Encounter won. Choose a reward to continue.')
  const presentedDraft = presented.length

  parts.offers().find((button) => button.dataset.rewardOffer === 'mend').dispatch('click')
  assert.equal(controller.currentMatch.encounterIndex, 1)
  assert.equal(controller.currentMatch.machineState, 'awaitingRoute')
  assert.equal(parts.overlay.hidden, false)
  assert.equal(parts.heading.textContent, 'Saving reward')
  assert.deepEqual(parts.offers(), [])
  assert.equal(encounter.textContent, '1/7')
  assert.equal(status.textContent, 'Saving your reward before continuing…')

  await waitFor(() => writes.length === 3)
  writes[2].resolve(SAVE_FAILURE)
  await controller.whenIdle()
  await flushMicrotasks()

  assert.equal(controller.getSnapshot().saveStatus, 'failed')
  assert.equal(parts.overlay.hidden, false)
  assert.equal(parts.heading.textContent, 'Reward not saved')
  assert.equal(retrySave.hidden, false)
  assert.equal(mainMenu.hidden, false)
  assert.equal(encounter.textContent, '1/7')
  assert.equal(status.textContent, 'Saving your reward failed. Retry the save to continue.')
  assert.equal(presented.length, presentedDraft)

  retrySave.dispatch('click')
  await waitFor(() => writes.length === 4)
  writes[3].resolve({ status: 'saved', savedAt: CAMPAIGN_SAVED_AT })
  await controller.whenIdle()
  await flushMicrotasks()

  assert.equal(parts.overlay.hidden, false)
  assert.equal(parts.heading.textContent, 'Route map · Stage 2/7')
  assert.deepEqual(
    parts.routeButtons().map((button) => [button.dataset.routeNode, button.disabled]),
    [['market', false], ['shrine', false]],
  )
  assert.equal(encounter.textContent, '2/7')
  assert.equal(controller.currentMatch.currency, 3)
  assert.equal(presented.at(-1), controller.currentMatch)
  assert.equal(inspect.disabled, true)
  assert.equal(writes.length, 4)

  screen.teardown()
  await controller.destroy()
})

test('Campaign retries unlock after the loss saves and hold the fight until the retry saves', async (t) => {
  installFakeDocument(t)
  const writes = []
  const controller = createRunController({
    repository: {
      load: async () => ({ status: 'empty' }),
      save() {
        const write = deferred()
        writes.push(write)
        return write.promise
      },
    },
    initialMatch: loseEncounter(startCampaign({
      runId: 'campaign-hud-retry',
      seed: 6,
      ruleset: BASELINE_RULESET,
    })),
  })
  const presented = []
  const screen = createGameScreen({
    runController: controller,
    mountBattlefield: () => undefined,
    eventPlayerFactory: createSettledEventPlayerFactory(presented),
  })
  const parts = campaignOverlayParts(screen)
  const status = descendants(screen.element).find(
    (element) => Object.hasOwn(element.dataset, 'statusHost'),
  )
  const encounter = byValue(screen, 'campaign-route')
  const retry = byAction(screen, 'campaign-retry')
  const retrySave = byAction(screen, 'campaign-save')
  const mainMenu = byAction(screen, 'campaign-main')
  const loss = 'Suit Opposition dealt 1 damage. 2 health remains.'

  const lossSave = controller.saveStable()
  await waitFor(() => writes.length === 1)
  writes[0].resolve(SAVE_FAILURE)
  await lossSave
  await flushMicrotasks()

  assert.equal(parts.overlay.hidden, false)
  assert.equal(parts.heading.textContent, 'Encounter lost')
  assert.equal(
    parts.description.textContent,
    `${loss} The encounter can be retried once this loss is saved.`,
  )
  assert.equal(retry.hidden, false)
  assert.equal(retry.disabled, true)
  assert.equal(retrySave.hidden, false)
  assert.equal(encounter.textContent, '1/7')
  retry.dispatch('click')
  assert.equal(controller.currentMatch.machineState, 'awaitingRetry')
  assert.equal(writes.length, 1)

  retrySave.dispatch('click')
  await settleWrite(controller, writes, 1)

  assert.equal(parts.heading.textContent, 'Encounter lost')
  assert.equal(parts.description.textContent, loss)
  assert.equal(retry.disabled, false)
  assert.equal(retrySave.hidden, true)
  assert.equal(status.textContent, 'Encounter ended. Retry to continue the campaign.')
  const boundary = controller.currentMatch
  const presentedLoss = presented.length

  retry.dispatch('click')
  assert.equal(controller.currentMatch.machineState, 'ready')
  assert.equal(controller.currentMatch.encounterAttempt, 2)
  assert.equal(parts.overlay.hidden, false)
  assert.equal(parts.heading.textContent, 'Saving encounter retry')
  assert.equal(retry.hidden, true)
  assert.equal(status.textContent, 'Saving your encounter retry before continuing…')
  retry.dispatch('click')
  assert.equal(controller.currentMatch.encounterAttempt, 2)

  await waitFor(() => writes.length === 3)
  writes[2].resolve(SAVE_FAILURE)
  await controller.whenIdle()
  await flushMicrotasks()

  assert.equal(controller.getSnapshot().saveStatus, 'failed')
  assert.equal(parts.overlay.hidden, false)
  assert.equal(parts.heading.textContent, 'Encounter retry not saved')
  assert.equal(
    parts.description.textContent,
    'Your encounter retry is made but not saved. Retry the save to continue, or return to the main menu.',
  )
  assert.equal(retry.hidden, true)
  assert.equal(retrySave.hidden, false)
  assert.equal(mainMenu.hidden, false)
  assert.equal(status.textContent, 'Saving your encounter retry failed. Retry the save to continue.')
  assert.equal(presented.length, presentedLoss)

  retrySave.dispatch('click')
  await settleWrite(controller, writes, 3)

  assert.equal(parts.overlay.hidden, true)
  assert.equal(controller.currentMatch.machineState, 'ready')
  assert.deepEqual(controller.currentMatch.journal, [
    ...boundary.journal,
    { type: 'retry', nodeId: 'gate' },
  ])
  assert.equal(presented.at(-1), controller.currentMatch)
  assert.equal(encounter.textContent, '1/7')
  assert.equal(writes.length, 4)

  screen.teardown()
  await controller.destroy()
})

test('Targeted campaign rewards list eligible deck cards and return with Back', async (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  const draft = restoredFixture('campaign-save-reward-v7.json')
  const controller = createRunController({
    repository: {
      load: async () => ({ status: 'resumable', savedAt: CAMPAIGN_SAVED_AT, match: draft }),
      save: async () => ({ status: 'saved', savedAt: CAMPAIGN_SAVED_AT }),
    },
  })
  await controller.restore()
  const screen = createGameScreen({
    runController: controller,
    mountBattlefield: () => undefined,
    eventPlayerFactory: createSettledEventPlayerFactory([]),
  })
  await flushMicrotasks()
  const parts = campaignOverlayParts(screen)
  const back = byAction(screen, 'campaign-back')
  const eligible = getCampaignRewardTargets(draft, 'deck-edit')

  parts.offers().find((button) => button.dataset.rewardOffer === 'deck-edit').dispatch('click')
  assert.equal(parts.heading.textContent, 'Choose a card to remove')
  assert.deepEqual(parts.offers(), [])
  assert.deepEqual(
    parts.targets().map((button) => button.dataset.rewardTarget),
    eligible.map(({ instanceId }) => instanceId),
  )
  assert.ok(parts.targets().length > 0)
  assert.ok(parts.targets().every((button) => !button.disabled))
  assert.equal(back.hidden, false)
  assert.equal(controller.currentMatch.machineState, 'awaitingReward')

  back.dispatch('click')
  assert.equal(parts.heading.textContent, 'Encounter won')
  assert.equal(parts.offers().length, 4)
  assert.equal(back.hidden, true)

  parts.offers().find((button) => button.dataset.rewardOffer === 'deck-edit').dispatch('click')
  const removed = parts.targets()[0].dataset.rewardTarget
  parts.targets()[0].dispatch('click')
  await controller.whenIdle()
  await flushMicrotasks()

  const next = controller.currentMatch
  assert.equal(next.encounterIndex, 1)
  assert.equal(next.machineState, 'awaitingRoute')
  assert.equal(next.journal.at(-1).targetInstanceId, removed)
  assert.ok(next.cards.every(({ instanceId }) => instanceId !== removed))
  assert.equal(parts.overlay.hidden, false)
  assert.equal(parts.heading.textContent, 'Route map · Stage 2/7')

  screen.teardown()
  await controller.destroy()
})

test('Informed Hold choices show both next cards and Run details stays read-only', async (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  const informed = restoredFixture('campaign-save-informed-v7.json')
  const cardText = (instanceId) => {
    const { cardId } = informed.cards.find((card) => card.instanceId === instanceId)
    return cardId.slice(2)
  }
  const controller = createRunController({
    repository: {
      load: async () => ({ status: 'resumable', savedAt: CAMPAIGN_SAVED_AT, match: informed }),
      save: async () => ({ status: 'saved', savedAt: CAMPAIGN_SAVED_AT }),
    },
  })
  await controller.restore()
  const presented = []
  const screen = createGameScreen({
    runController: controller,
    mountBattlefield: () => undefined,
    eventPlayerFactory: createSettledEventPlayerFactory(presented),
  })
  await flushMicrotasks()
  const parts = campaignOverlayParts(screen)
  const status = descendants(screen.element).find(
    (element) => Object.hasOwn(element.dataset, 'statusHost'),
  )
  const normal = byAction(screen, 'campaign-normal')
  const hold = byAction(screen, 'campaign-hold')
  const inspect = byAction(screen, 'inspect')
  const close = byAction(screen, 'campaign-close')

  assert.equal(parts.overlay.hidden, false)
  assert.equal(parts.heading.textContent, 'Choose your reveal')
  assert.deepEqual(parts.details(), [
    'Hold Insight',
    `Opponent's next card: ${cardText(informed.holdChoice.opponentCandidate)}`,
    `Your next card: ${cardText(informed.holdChoice.candidate)}`,
    'Hold is empty.',
  ])
  assert.equal(
    status.textContent,
    'Hold Insight shows both next cards. Choose the prepared card or the card in Hold.',
  )
  assert.equal(normal.hidden, false)
  assert.equal(normal.disabled, false)
  assert.equal(hold.hidden, true)
  assert.equal(inspect.disabled, true)

  normal.dispatch('click')
  await controller.whenIdle()
  await flushMicrotasks()

  const event = controller.currentMatch.pendingEvent
  assert.deepEqual(
    event.reveals.slice(0, 2).map(({ suppliedBy, instanceId }) => [suppliedBy, instanceId]),
    [
      ['player', informed.holdChoice.candidate],
      ['opponent', informed.holdChoice.opponentCandidate],
    ],
  )
  assert.equal(presented.at(-1).pendingEvent.id, event.id)
  assert.equal(controller.currentMatch.machineState, 'ready')
  assert.equal(parts.overlay.hidden, true)
  assert.equal(inspect.disabled, false)

  inspect.dispatch('click')
  const match = controller.currentMatch
  assert.equal(parts.overlay.hidden, false)
  assert.equal(parts.heading.textContent, 'Run details')
  assert.equal(
    parts.description.textContent,
    `Health ${match.health}/${match.maxHealth} · Stage 3/7 · Coins 3 · Deck 26 cards · Hold is empty`,
  )
  const details = parts.details()
  assert.deepEqual(details.slice(0, 13), [
    'Route',
    'Stage 1 · Suit Opposition (Fight): Completed',
    'Stage 2 · Wayside Market (Shop): Bypassed',
    'Stage 2 · Crossroads Shrine (Event): Completed',
    'Stage 3 · Royal Court (Fight): Current',
    'Stage 3 · High Court (Elite fight): Bypassed',
    'Stage 4 · Ember Bazaar (Shop): Locked',
    "Stage 4 · Oathkeeper's Vault (Event): Locked",
    'Stage 4 · Roadside Camp (Rest): Locked',
    'Stage 5 · Watch of Tens (Fight): Locked',
    'Stage 5 · Night Watch (Elite fight): Locked',
    'Stage 6 · Last Light Sanctum (Rest): Locked',
    'Stage 7 · Ace Sovereign (Boss fight): Locked',
  ])
  assert.equal(details[13], 'Active modifiers')
  assert.equal(details.includes('Opponent traits'), false)
  assert.equal(
    details.filter((line) => line.startsWith('Hold Insight (Permanent)')).length,
    1,
  )
  assert.deepEqual(details.slice(details.indexOf('Expedition log')), [
    'Expedition log',
    'Stage 1: entered Suit Opposition',
    'Suit Opposition: gained Hold Insight and collected 3 coins',
    'Stage 2: entered Crossroads Shrine',
    'Crossroads Shrine: Walk on',
    'Stage 3: entered Royal Court',
  ])
  assert.equal(close.hidden, false)
  assert.equal(controller.currentMatch, match)

  close.dispatch('click')
  assert.equal(parts.overlay.hidden, true)
  assert.equal(controller.currentMatch, match)

  screen.teardown()
  await controller.destroy()
})

function installFakeDocument(t) {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })
}

async function restoredCampaignScreen(match, { save, onMainMenu } = {}) {
  const writes = []
  const controller = createRunController({
    repository: {
      load: async () => ({ status: 'resumable', savedAt: CAMPAIGN_SAVED_AT, match }),
      save: save ?? (() => {
        const write = deferred()
        writes.push(write)
        return write.promise
      }),
    },
  })
  await controller.restore()
  const presented = []
  const screen = createGameScreen({
    runController: controller,
    mountBattlefield: () => undefined,
    eventPlayerFactory: createSettledEventPlayerFactory(presented),
    ...(onMainMenu === undefined ? {} : { onMainMenu }),
  })
  await flushMicrotasks()
  return { controller, screen, presented, writes, parts: campaignOverlayParts(screen) }
}

async function settleWrite(controller, writes, index) {
  await waitFor(() => writes.length === index + 1)
  writes[index].resolve({ status: 'saved', savedAt: CAMPAIGN_SAVED_AT })
  await controller.whenIdle()
  await flushMicrotasks()
}

test('Campaign route maps list every node and hold a route choice until it saves', async (t) => {
  installFakeDocument(t)
  let mainMenuCalls = 0
  const { controller, screen, presented, writes, parts } = await restoredCampaignScreen(
    restoredFixture('campaign-save-route-v7.json'),
    { onMainMenu: () => { mainMenuCalls += 1 } },
  )
  const status = descendants(screen.element).find(
    (element) => Object.hasOwn(element.dataset, 'statusHost'),
  )
  const comparison = descendants(screen.element).find(
    (element) => Object.hasOwn(element.dataset, 'comparisonResult'),
  )
  const route = byValue(screen, 'campaign-route')
  const inspect = byAction(screen, 'campaign-inspect')
  const close = byAction(screen, 'campaign-close')
  const mainMenu = byAction(screen, 'campaign-main')

  assert.equal(parts.overlay.hidden, false)
  assert.equal(parts.heading.textContent, 'Route map · Stage 2/7')
  assert.equal(
    parts.description.textContent,
    'Choose your next stop. Paths you leave behind close for this run.',
  )
  assert.deepEqual(
    parts.routeEntries().map((entry) => [entry.dataset.routeNode, entry.tagName, entry.textContent]),
    [
      ['gate', 'P', 'Stage 1 · Suit Opposition'],
      ['market', 'BUTTON', 'Stage 2 · Wayside Market'],
      ['shrine', 'BUTTON', 'Stage 2 · Crossroads Shrine'],
      ['court', 'P', 'Stage 3 · Royal Court'],
      ['high-court', 'P', 'Stage 3 · High Court'],
      ['bazaar', 'P', 'Stage 4 · Ember Bazaar'],
      ['vault', 'P', "Stage 4 · Oathkeeper's Vault"],
      ['camp', 'P', 'Stage 4 · Roadside Camp'],
      ['watch', 'P', 'Stage 5 · Watch of Tens'],
      ['night-watch', 'P', 'Stage 5 · Night Watch'],
      ['sanctum', 'P', 'Stage 6 · Last Light Sanctum'],
      ['finale', 'P', 'Stage 7 · Ace Sovereign'],
    ],
  )
  assert.deepEqual(parts.choiceDetails(), [
    'Fight · Suit Legion archetype · 1 damage on a loss · 3-coin bounty · Completed',
    'Shop · Available',
    'Event · Available',
    'Fight · Court archetype · 1 damage on a loss · 4-coin bounty · Locked',
    'Elite fight · Court archetype · 2 damage on a loss · 6-coin bounty · Locked. Elite reward: a high card or Greater Mend. Court Etiquette: Opponent trait. In this encounter, an empty Hold can capture only a 2–10, and an occupied Hold can be replaced only by a 2–10.',
    'Shop · Locked',
    'Event · Locked',
    'Rest · Locked',
    'Fight · Watch archetype · 1 damage on a loss · Locked',
    'Elite fight · Watch archetype · 2 damage on a loss · Locked. Elite reward: a high card or Greater Mend. Plunder: Opponent trait. Clashes this opponent wins send your cards to its won pile instead of burning them. They return to your deck after the encounter. Spoils of War has no effect against it.',
    'Rest · Locked',
    'Boss fight · Sovereign archetype · 2 damage on a loss · Locked. Defeat to complete the expedition.',
  ])
  assert.ok(parts.routeButtons().every((button) => !button.disabled))
  assert.deepEqual(parts.details().slice(0, 5), [
    'Expedition',
    'Health 3/5',
    'Coins 3',
    'Deck 26 cards',
    'Hold is empty',
  ])
  assert.equal(route.textContent, '2/7')
  assert.equal(byValue(screen, 'stage').textContent, '—')
  assert.equal(byValue(screen, 'player-draw-count').textContent, '—')
  assert.equal(comparison.textContent, 'Between encounters')
  assert.equal(status.textContent, 'Choose your next stop on the route map.')
  assert.equal(byAction(screen, 'reveal').disabled, true)
  assert.equal(inspect.hidden, false)
  assert.equal(mainMenu.hidden, false)
  assert.equal(mainMenu.disabled, false)
  assert.equal(presented.at(-1), controller.currentMatch)

  inspect.dispatch('click')
  assert.equal(parts.heading.textContent, 'Run details')
  assert.equal(
    parts.description.textContent,
    'Health 3/5 · Stage 2/7 · Coins 3 · Deck 26 cards · Hold is empty',
  )
  assert.deepEqual(parts.details().slice(parts.details().indexOf('Expedition log')), [
    'Expedition log',
    'Stage 1: entered Suit Opposition',
    'Suit Opposition: gained Hold Insight and collected 3 coins',
  ])
  close.dispatch('click')
  assert.equal(parts.heading.textContent, 'Route map · Stage 2/7')

  const map = controller.currentMatch
  parts.routeButtons().find((button) => button.dataset.routeNode === 'shrine').dispatch('click')
  assert.equal(controller.currentMatch.machineState, 'awaitingEvent')
  assert.equal(parts.heading.textContent, 'Saving route choice')
  assert.equal(status.textContent, 'Saving your route choice before continuing…')
  assert.deepEqual(parts.routeButtons(), [])
  assert.equal(route.textContent, '2/7')
  assert.equal(presented.at(-1), map)

  await settleWrite(controller, writes, 0)
  assert.equal(parts.heading.textContent, 'Crossroads Shrine')
  assert.deepEqual(controller.currentMatch.journal.at(-1), { type: 'route', nodeId: 'shrine' })
  assert.equal(presented.at(-1), controller.currentMatch)
  assert.equal(writes.length, 1)

  mainMenu.dispatch('click')
  assert.equal(mainMenuCalls, 1)

  screen.teardown()
  await controller.destroy()
})

test('Campaign shops price every item, explain blocked items, and buy with a deck target', async (t) => {
  installFakeDocument(t)
  const shop = restoredFixture('campaign-save-shop-v7.json')
  const { controller, screen, writes, parts } = await restoredCampaignScreen(shop)
  const status = descendants(screen.element).find(
    (element) => Object.hasOwn(element.dataset, 'statusHost'),
  )
  const leave = byAction(screen, 'campaign-leave')
  const back = byAction(screen, 'campaign-back')
  const items = () => parts.withData('shopItem')

  assert.equal(parts.heading.textContent, 'Wayside Market')
  assert.equal(
    parts.description.textContent,
    'A roadside stall trades cards and charms for coins. You have 3 coins.',
  )
  assert.deepEqual(
    items().map((button) => [button.dataset.shopItem, button.textContent, button.disabled]),
    [
      ['card-1', 'New card: 8S · 3 coins', false],
      ['service-1', 'Replace a card with 5C · 2 coins', false],
      ['modifier-1', 'Modifier: Vow of Constancy · 4 coins', true],
    ],
  )
  assert.match(parts.choiceDetails()[2], /^Restore 2 health\. .* Not enough coins\.$/)
  assert.equal(status.textContent, 'Buy from the shop, or leave to continue.')
  assert.equal(leave.hidden, false)
  assert.equal(leave.disabled, false)
  assert.equal(byAction(screen, 'campaign-inspect').hidden, false)
  assert.equal(byAction(screen, 'campaign-main').hidden, false)

  items()[1].dispatch('click')
  const eligible = getCampaignShopTargets(shop, 'service-1')
  assert.equal(parts.heading.textContent, 'Choose a card to replace with 5C')
  assert.equal(
    parts.description.textContent,
    'Choose one card from your campaign deck. It costs 2 coins.',
  )
  assert.deepEqual(
    parts.withData('shopTarget').map((button) => button.dataset.shopTarget),
    eligible.map(({ instanceId }) => instanceId),
  )
  assert.equal(leave.hidden, true)
  assert.equal(back.hidden, false)
  back.dispatch('click')
  assert.equal(parts.heading.textContent, 'Wayside Market')

  items()[1].dispatch('click')
  const replaced = parts.withData('shopTarget')[0].dataset.shopTarget
  parts.withData('shopTarget')[0].dispatch('click')
  assert.equal(parts.heading.textContent, 'Saving purchase')
  await settleWrite(controller, writes, 0)

  const bought = controller.currentMatch
  assert.equal(bought.machineState, 'awaitingShop')
  assert.equal(bought.currency, 1)
  assert.deepEqual(bought.journal.at(-1), {
    type: 'purchase',
    nodeId: 'market',
    itemId: 'service-1',
    kind: 'replace',
    cardId: 'c-5C',
    modifierId: null,
    price: 2,
    targetInstanceId: replaced,
    createdInstanceId: 'player-027',
  })
  assert.equal(parts.heading.textContent, 'Wayside Market')
  assert.deepEqual(items().map((button) => button.disabled), [true, true, true])
  assert.deepEqual(parts.choiceDetails().slice(0, 2), [
    'Add 8S to your deck. Not enough coins.',
    'Choose a card in your deck to swap for 5C. Sold.',
  ])

  items()[1].dispatch('click')
  assert.equal(parts.heading.textContent, 'Wayside Market')
  leave.dispatch('click')
  assert.equal(parts.heading.textContent, 'Saving shop exit')
  await settleWrite(controller, writes, 1)
  assert.equal(controller.currentMatch.machineState, 'awaitingRoute')
  assert.equal(parts.heading.textContent, 'Route map · Stage 3/7')
  assert.deepEqual(
    parts.routeButtons().map((button) => button.dataset.routeNode),
    ['court', 'high-court'],
  )

  screen.teardown()
  await controller.destroy()
})

test('Campaign events state each cost and gain, explain blocked options, and pick targets', async (t) => {
  installFakeDocument(t)
  const event = restoredFixture('campaign-save-event-v7.json')
  const { controller, screen, writes, parts } = await restoredCampaignScreen(event)
  const back = byAction(screen, 'campaign-back')
  const options = () => parts.withData('eventOption')

  assert.equal(parts.heading.textContent, 'Crossroads Shrine')
  assert.equal(
    parts.description.textContent,
    'A shrine at the fork trades blood for coins, or mends you for an offering.',
  )
  assert.deepEqual(
    options().map((button) => [button.dataset.eventOption, button.textContent, button.disabled]),
    [
      ['bleed-for-fortune', 'Bleed for fortune', false],
      ['burn-an-offering', 'Burn an offering', false],
      ['walk-on', 'Walk on', false],
    ],
  )
  assert.deepEqual(parts.choiceDetails(), [
    'Lose 1 health → gain 5 coins.',
    'Remove a chosen card → restore 2 health.',
    'Leave without changing anything.',
  ])
  assert.equal(byAction(screen, 'campaign-leave').hidden, true)

  options()[1].dispatch('click')
  assert.equal(parts.heading.textContent, 'Choose a card to remove')
  assert.equal(parts.withData('eventTarget').length, 26)
  back.dispatch('click')
  assert.equal(parts.heading.textContent, 'Crossroads Shrine')

  options()[0].dispatch('click')
  assert.equal(parts.heading.textContent, 'Saving event choice')
  await settleWrite(controller, writes, 0)
  assert.equal(controller.currentMatch.health, 2)
  assert.equal(controller.currentMatch.currency, 8)
  assert.equal(parts.heading.textContent, 'Route map · Stage 3/7')
  screen.teardown()
  await controller.destroy()

  const vault = chooseRoute(
    claimReward(winEncounter(passThrough(restoredFixture('campaign-save-route-v7.json'), 'shrine', 'court')), 'mend'),
    'vault',
  )
  const second = await restoredCampaignScreen(vault)
  assert.equal(second.parts.heading.textContent, "Oathkeeper's Vault")
  assert.deepEqual(
    second.parts.withData('eventOption').map((button) => [button.dataset.eventOption, button.disabled]),
    [['surrender-held-card', true], ['pay-for-a-copy', false], ['walk-on', false]],
  )
  assert.deepEqual(second.parts.choiceDetails(), [
    'Surrender the held card → gain Hold Insight. Your Hold is empty.',
    'Pay 3 coins → duplicate a chosen card.',
    'Leave without changing anything.',
  ])
  second.screen.teardown()
  await second.controller.destroy()
})

test('Campaign rest sites list cost-free options, pick training targets, and rest to the next stage', async (t) => {
  installFakeDocument(t)
  const rest = restoredFixture('campaign-save-rest-v7.json')
  const { controller, screen, writes, parts } = await restoredCampaignScreen(rest)
  const status = descendants(screen.element).find(
    (element) => Object.hasOwn(element.dataset, 'statusHost'),
  )
  const back = byAction(screen, 'campaign-back')
  const inspect = byAction(screen, 'campaign-inspect')
  const options = () => parts.withData('restOption')

  assert.equal(parts.heading.textContent, 'Roadside Camp')
  assert.equal(
    parts.description.textContent,
    'A sheltered fire offers rest, or a quiet hour to train a card.',
  )
  assert.deepEqual(
    options().map((button) => [button.dataset.restOption, button.textContent, button.disabled]),
    [
      ['rest', 'Rest by the fire', false],
      ['train', 'Train a card', false],
      ['walk-on', 'Walk on', false],
    ],
  )
  assert.deepEqual(parts.choiceDetails(), [
    'Restore 2 health (now 2/5).',
    'Choose a card in your deck to copy.',
    'Leave without changing anything.',
  ])
  assert.equal(options()[0].attributes['aria-describedby'], 'campaign-rest-rest-detail')
  assert.deepEqual(parts.details().slice(0, 5), [
    'Expedition',
    'Health 2/5',
    'Coins 14',
    'Deck 28 cards',
    'Held card: 8D',
  ])
  assert.equal(status.textContent, 'Choose a rest option to continue.')
  assert.equal(byAction(screen, 'campaign-leave').hidden, true)
  assert.equal(inspect.hidden, false)
  assert.equal(byAction(screen, 'campaign-main').hidden, false)

  options()[1].dispatch('click')
  assert.equal(parts.heading.textContent, 'Choose a card to duplicate')
  assert.equal(
    parts.description.textContent,
    'Choose one card from your campaign deck. The held card cannot be chosen.',
  )
  const eligible = getCampaignRestTargets(rest, 'train').map(({ instanceId }) => instanceId)
  assert.deepEqual(
    parts.withData('restTarget').map((button) => button.dataset.restTarget),
    eligible,
  )
  assert.equal(eligible.includes(rest.hold), false)
  assert.equal(back.hidden, false)
  back.dispatch('click')
  assert.equal(parts.heading.textContent, 'Roadside Camp')
  assert.equal(writes.length, 0)

  options()[0].dispatch('click')
  assert.equal(parts.heading.textContent, 'Saving rest choice')
  assert.equal(status.textContent, 'Saving your rest choice before continuing…')
  assert.deepEqual(options(), [])
  await settleWrite(controller, writes, 0)

  const rested = controller.currentMatch
  assert.equal(rested.machineState, 'awaitingRoute')
  assert.equal(rested.health, 4)
  assert.equal(rested.currency, 14)
  assert.deepEqual(rested.journal.at(-1), {
    type: 'rest',
    nodeId: 'camp',
    optionId: 'rest',
    targetInstanceId: null,
    createdInstanceId: null,
  })
  assert.equal(parts.heading.textContent, 'Route map · Stage 5/7')
  assert.deepEqual(
    parts.routeButtons().map((button) => button.dataset.routeNode),
    ['watch', 'night-watch'],
  )

  inspect.dispatch('click')
  assert.equal(parts.heading.textContent, 'Run details')
  assert.equal(parts.details().includes('Opponent traits'), false)
  assert.equal(parts.details().at(-1), 'Roadside Camp: rested and restored 2 health')
  byAction(screen, 'campaign-close').dispatch('click')
  assert.equal(parts.heading.textContent, 'Route map · Stage 5/7')

  screen.teardown()
  await controller.destroy()
})

test('Rest sites at full health say resting restores nothing, and cleansing removes a chosen card', async (t) => {
  installFakeDocument(t)
  let run = startCampaign({ runId: 'hud-full-rest', seed: 0, ruleset: BASELINE_RULESET })
  run = passThrough(claimReward(winEncounter(run), 'mend'), 'shrine', 'court')
  const camp = chooseRoute(claimReward(winEncounter(run), 'mend'), 'camp')
  assert.equal(camp.health, camp.maxHealth)

  const first = await restoredCampaignScreen(camp)
  assert.equal(first.parts.heading.textContent, 'Roadside Camp')
  assert.equal(
    first.parts.choiceDetails()[0],
    'Your health is full. Resting here restores nothing.',
  )
  assert.equal(first.parts.withData('restOption')[0].disabled, false)
  first.parts.withData('restOption')[0].dispatch('click')
  await settleWrite(first.controller, first.writes, 0)
  assert.equal(first.controller.currentMatch.health, camp.maxHealth)
  assert.equal(first.parts.heading.textContent, 'Route map · Stage 5/7')
  byAction(first.screen, 'campaign-inspect').dispatch('click')
  assert.equal(first.parts.details().at(-1), 'Roadside Camp: rested at full health')
  first.screen.teardown()
  await first.controller.destroy()

  const watch = chooseRoute(chooseRestOption(camp, 'walk-on'), 'watch')
  const sanctum = chooseRoute(claimReward(winEncounter(watch), 'mend'), 'sanctum')
  const { controller, screen, writes, parts } = await restoredCampaignScreen(sanctum)
  const options = () => parts.withData('restOption')
  assert.equal(parts.heading.textContent, 'Last Light Sanctum')
  assert.equal(
    parts.description.textContent,
    'The last shelter before the sovereign offers rest, or a rite to cleanse a card.',
  )
  assert.deepEqual(
    options().map((button) => [button.dataset.restOption, button.textContent, button.disabled]),
    [
      ['rest', 'Rest in the sanctum', false],
      ['cleanse', 'Cleanse a card', false],
      ['walk-on', 'Walk on', false],
    ],
  )
  assert.deepEqual(parts.choiceDetails(), [
    'Your health is full. Resting here restores nothing.',
    'Choose a card to remove from your deck.',
    'Leave without changing anything.',
  ])

  options()[1].dispatch('click')
  assert.equal(parts.heading.textContent, 'Choose a card to remove')
  assert.deepEqual(
    parts.withData('restTarget').map((button) => button.dataset.restTarget),
    getCampaignRestTargets(sanctum, 'cleanse').map(({ instanceId }) => instanceId),
  )
  const [cleansed] = parts.withData('restTarget')
  assert.equal(cleansed.textContent, '2H')
  cleansed.dispatch('click')
  assert.equal(parts.heading.textContent, 'Saving rest choice')
  await settleWrite(controller, writes, 0)

  assert.deepEqual(controller.currentMatch.journal.at(-1), {
    type: 'rest',
    nodeId: 'sanctum',
    optionId: 'cleanse',
    targetInstanceId: cleansed.dataset.restTarget,
    createdInstanceId: null,
  })
  assert.equal(parts.heading.textContent, 'Route map · Stage 7/7')
  assert.deepEqual(parts.routeButtons().map((button) => button.dataset.routeNode), ['finale'])
  byAction(screen, 'campaign-inspect').dispatch('click')
  const log = parts.details().slice(parts.details().indexOf('Expedition log'))
  assert.ok(log.includes('Roadside Camp: walked on'))
  assert.equal(log.at(-1), 'Last Light Sanctum: removed 2H')

  screen.teardown()
  await controller.destroy()
})

test('Rest site saves retry after a failure, and a refused rest option keeps the site open', async (t) => {
  installFakeDocument(t)
  const writes = []
  const controller = createRunController({
    repository: {
      load: async () => ({ status: 'empty' }),
      save() {
        const write = deferred()
        writes.push(write)
        return write.promise
      },
    },
    initialMatch: restoredFixture('campaign-save-rest-v7.json'),
  })
  const screen = createGameScreen({
    runController: controller,
    mountBattlefield: () => undefined,
    eventPlayerFactory: createSettledEventPlayerFactory([]),
  })
  const parts = campaignOverlayParts(screen)
  const overlayStatus = descendants(parts.overlay).find(
    (element) => Object.hasOwn(element.dataset, 'campaignStatus'),
  )
  const retrySave = byAction(screen, 'campaign-save')
  const mainMenu = byAction(screen, 'campaign-main')
  const options = () => parts.withData('restOption')

  const initialSave = controller.saveStable()
  await waitFor(() => writes.length === 1)
  writes[0].resolve(SAVE_FAILURE)
  await initialSave
  await flushMicrotasks()

  assert.equal(parts.heading.textContent, 'Roadside Camp')
  assert.equal(
    parts.description.textContent,
    'An option can be chosen once this rest site is saved.',
  )
  assert.deepEqual(options().map((button) => button.disabled), [true, true, true])
  assert.equal(retrySave.hidden, false)
  assert.equal(mainMenu.disabled, true)

  retrySave.dispatch('click')
  await waitFor(() => writes.length === 2)
  writes[1].resolve(SAVE_FAILURE)
  await controller.whenIdle()
  await flushMicrotasks()
  assert.equal(overlayStatus.textContent, 'The rest site could not be saved. Try again.')
  assert.deepEqual(options().map((button) => button.disabled), [true, true, true])

  retrySave.dispatch('click')
  await settleWrite(controller, writes, 2)
  assert.equal(
    parts.description.textContent,
    'A sheltered fire offers rest, or a quiet hour to train a card.',
  )
  assert.deepEqual(options().map((button) => button.disabled), [false, false, false])
  assert.equal(retrySave.hidden, true)
  assert.equal(mainMenu.disabled, false)

  options().at(-1).dispatch('click')
  assert.equal(parts.heading.textContent, 'Saving rest choice')
  await waitFor(() => writes.length === 4)
  writes[3].resolve(SAVE_FAILURE)
  await controller.whenIdle()
  await flushMicrotasks()
  assert.equal(controller.currentMatch.machineState, 'awaitingRoute')
  assert.equal(parts.heading.textContent, 'Rest choice not saved')
  assert.equal(
    parts.description.textContent,
    'Your rest choice is made but not saved. Retry the save to continue, or return to the main menu.',
  )
  assert.equal(retrySave.hidden, false)

  retrySave.dispatch('click')
  await settleWrite(controller, writes, 4)
  assert.equal(parts.heading.textContent, 'Route map · Stage 5/7')
  assert.deepEqual(controller.currentMatch.journal.at(-1), {
    type: 'rest',
    nodeId: 'camp',
    optionId: 'walk-on',
    targetInstanceId: null,
    createdInstanceId: null,
  })
  screen.teardown()
  await controller.destroy()

  const restored = createRunController({
    repository: {
      load: async () => ({
        status: 'resumable',
        savedAt: CAMPAIGN_SAVED_AT,
        match: restoredFixture('campaign-save-rest-v7.json'),
      }),
      save: async () => ({ status: 'saved', savedAt: CAMPAIGN_SAVED_AT }),
    },
  })
  await restored.restore()
  const refusing = Object.create(restored, {
    chooseRestOption: {
      value() {
        throw new Error('Rest decision refused')
      },
    },
  })
  const refusedScreen = createGameScreen({
    runController: refusing,
    mountBattlefield: () => undefined,
    eventPlayerFactory: createSettledEventPlayerFactory([]),
  })
  await flushMicrotasks()
  const refusedParts = campaignOverlayParts(refusedScreen)
  const before = restored.currentMatch
  refusedParts.withData('restOption')[0].dispatch('click')
  await flushMicrotasks()
  assert.equal(restored.currentMatch, before)
  assert.equal(refusedParts.heading.textContent, 'Roadside Camp')
  assert.equal(
    descendants(refusedParts.overlay).find(
      (element) => Object.hasOwn(element.dataset, 'campaignStatus'),
    ).textContent,
    'The rest option could not be chosen. Try again.',
  )
  assert.deepEqual(
    refusedParts.withData('restOption').map((button) => button.disabled),
    [false, false, false],
  )
  refusedScreen.teardown()
  await restored.destroy()
})

test('Campaign rest overlays explain blocked options and wait for the rest site save', (t) => {
  installFakeDocument(t)
  const chosen = []
  const overlay = createCampaignOverlay(Object.fromEntries([
    'onChooseNormal', 'onChooseHold', 'onRetrySave', 'onCapture', 'onRetry', 'onChooseOffer',
    'onChooseTarget', 'onBack', 'onClose', 'onChooseRoute', 'onBuyItem', 'onLeaveShop',
    'onChooseEventOption', 'onChooseRestOption', 'onInspect', 'onMainMenu', 'onRestart',
    'onCancel',
  ].map((name) => [
    name,
    name === 'onChooseRestOption' ? (optionId) => chosen.push(optionId) : () => {},
  ])))
  // Neither deck limit is reachable on the authored map, so the blocked view is built here.
  const view = {
    title: 'Last Light Sanctum',
    description: 'The last shelter before the sovereign offers rest, or a rite to cleanse a card.',
    summary: ['Health 4/5', 'Coins 0', 'Deck 20 cards', 'Hold is empty'],
    options: [
      {
        optionId: 'rest',
        title: 'Rest in the sanctum',
        detail: 'Restore 2 health (now 4/5).',
        available: true,
        reason: null,
      },
      {
        optionId: 'cleanse',
        title: 'Cleanse a card',
        detail: `Choose a card to remove from your deck. ${blockerText('deck-minimum')}`,
        available: false,
        reason: 'deck-minimum',
      },
      {
        optionId: 'walk-on',
        title: 'Walk on',
        detail: 'Leave without changing anything.',
        available: true,
        reason: null,
      },
    ],
    modifiers: [],
  }
  const options = () => descendants(overlay.element)
    .filter((element) => element.tagName === 'BUTTON' && element.dataset.restOption !== undefined)
  const details = () => descendants(overlay.element)
    .filter((element) => element.className === 'campaign-offer__detail')
    .map((element) => element.textContent)
  const description = () => descendants(overlay.element)
    .find((element) => Object.hasOwn(element.dataset, 'campaignDescription')).textContent

  overlay.update({ match: {}, saveStatus: 'saved', saveReason: null }, { mode: 'rest', view })
  assert.equal(description(), view.description)
  assert.deepEqual(
    options().map((button) => [button.dataset.restOption, button.disabled]),
    [['rest', false], ['cleanse', true], ['walk-on', false]],
  )
  assert.equal(
    details()[1],
    'Choose a card to remove from your deck. Your deck is at its 20-card minimum.',
  )
  options()[0].dispatch('click')
  assert.deepEqual(chosen, ['rest'])

  overlay.update(
    { match: {}, saveStatus: 'failed', saveReason: 'quota-exceeded' },
    { mode: 'rest', view },
  )
  assert.equal(description(), 'An option can be chosen once this rest site is saved.')
  assert.ok(options().every((button) => button.disabled))
  assert.equal(
    descendants(overlay.element).find((element) => element.dataset.action === 'campaign-save').hidden,
    false,
  )
})

test('Elite reward drafts offer Greater Mend and log it with the elite bounty', async (t) => {
  installFakeDocument(t)
  const { controller, screen, writes, parts } = await restoredCampaignScreen(
    restoredFixture('campaign-save-elite-reward-v7.json'),
  )
  assert.equal(parts.heading.textContent, 'Encounter won')
  assert.equal(
    parts.description.textContent,
    'Choose one reward before returning to the map. The High Court bounty pays 6 coins when you choose.',
  )
  assert.deepEqual(
    parts.offers().map((button) => [button.dataset.rewardOffer, button.textContent]),
    [
      ['new-card', 'New card: AS'],
      ['deck-edit', 'Duplicate a card'],
      ['modifier', 'Modifier: Vow of Constancy'],
      ['mend', 'Greater Mend'],
    ],
  )
  assert.equal(
    parts.choiceDetails().at(-1),
    'Restore 2 health (now 2/5) and keep your deck unchanged.',
  )

  parts.offers().at(-1).dispatch('click')
  assert.equal(parts.heading.textContent, 'Saving reward')
  await settleWrite(controller, writes, 0)
  assert.equal(controller.currentMatch.health, 4)
  assert.equal(controller.currentMatch.currency, 14)
  assert.equal(parts.heading.textContent, 'Route map · Stage 4/7')
  assert.deepEqual(
    parts.routeButtons().map((button) => button.dataset.routeNode),
    ['bazaar', 'vault', 'camp'],
  )
  byAction(screen, 'campaign-inspect').dispatch('click')
  assert.equal(parts.details().at(-1), 'High Court: chose Greater Mend and collected 6 coins')

  screen.teardown()
  await controller.destroy()
})

test('Elite fights explain their Hold restriction in Hold capture and list traits in Run details', async (t) => {
  installFakeDocument(t)
  const choice = restoredFixture('campaign-save-elite-choice-v7.json')
  const traitText = 'Court Etiquette: Opponent trait. In this encounter, an empty Hold can capture only a 2–10, and an occupied Hold can be replaced only by a 2–10.'
  for (const nodeId of ['high-court', 'court']) {
    const fight = advanceClash(advanceClash(chooseRoute(choice, nodeId)))
    const elite = nodeId === 'high-court'
    const eligible = getEligibleHoldTargets(fight).map(({ instanceId }) => instanceId)
    assert.equal(fight.machineState, 'ready', nodeId)
    // Both fights put the same player-owned Ace in the won pile; only Court Etiquette keeps
    // it out of Hold.
    assert.deepEqual(fight.encounter.zones.player.wonPile, ['player-026'], nodeId)
    assert.deepEqual(eligible, elite ? [] : ['player-026'], nodeId)
    const { controller, screen, parts } = await restoredCampaignScreen(fight)
    const hold = byAction(screen, 'hold')
    assert.equal(parts.overlay.hidden, true, nodeId)
    assert.equal(hold.disabled, false, nodeId)

    hold.dispatch('click')
    assert.equal(parts.heading.textContent, 'Capture into Hold', nodeId)
    assert.deepEqual(
      parts.withData('holdTarget').map((button) => button.dataset.holdTarget),
      eligible,
      nodeId,
    )
    if (elite) {
      assert.equal(
        parts.description.textContent,
        'No player-owned card in your draw or won pile is eligible.',
      )
      assert.deepEqual(parts.details(), [
        'Opponent traits',
        'Court Etiquette: Hold can capture only a 2–10',
      ])
    } else {
      assert.deepEqual(parts.details(), [], nodeId)
    }
    byAction(screen, 'campaign-cancel').dispatch('click')
    assert.equal(parts.overlay.hidden, true, nodeId)

    byAction(screen, 'inspect').dispatch('click')
    assert.equal(parts.heading.textContent, 'Run details', nodeId)
    const details = parts.details()
    if (elite) {
      assert.deepEqual(
        details.slice(details.indexOf('Opponent traits'), details.indexOf('Expedition log')),
        ['Opponent traits', traitText],
      )
      assert.ok(details.includes('Stage 3 · High Court (Elite fight): Current'))
    } else {
      assert.equal(details.includes('Opponent traits'), false, nodeId)
      assert.ok(details.includes('Stage 3 · Royal Court (Fight): Current'))
    }
    byAction(screen, 'campaign-close').dispatch('click')
    assert.equal(parts.overlay.hidden, true, nodeId)

    screen.teardown()
    await controller.destroy()
  }
})

test('Campaign victory names the defeated Ace Sovereign', async (t) => {
  installFakeDocument(t)
  const { controller, screen, parts } = await restoredCampaignScreen(
    restoredFixture('campaign-save-victory-v7.json'),
  )
  const status = descendants(screen.element).find(
    (element) => Object.hasOwn(element.dataset, 'statusHost'),
  )
  assert.equal(parts.overlay.hidden, false)
  assert.equal(parts.heading.textContent, 'Campaign victory')
  assert.equal(
    parts.description.textContent,
    'You defeated the Ace Sovereign and completed the expedition.',
  )
  assert.deepEqual(parts.details(), [
    'Expedition',
    'Route: Suit Opposition → Crossroads Shrine → High Court → Roadside Camp → Night Watch → Last Light Sanctum → Ace Sovereign. Coins 14 · Deck 27 cards.',
  ])
  assert.equal(status.textContent, 'Campaign complete. The final encounter is won.')
  assert.equal(byAction(screen, 'campaign-main').hidden, false)
  assert.equal(byAction(screen, 'campaign-restart').hidden, false)

  screen.teardown()
  await controller.destroy()
})

test('Campaign route maps stay locked until saved and the first reveal of a fight is manual', async (t) => {
  installFakeDocument(t)
  let saveCalls = 0
  const controller = createRunController({
    repository: {
      load: async () => ({ status: 'empty' }),
      async save() {
        saveCalls += 1
        return saveCalls === 1 ? SAVE_FAILURE : { status: 'saved', savedAt: CAMPAIGN_SAVED_AT }
      },
    },
    initialMatch: createCampaignRun({
      runId: 'hud-campaign-map-save',
      seed: 3,
      ruleset: BASELINE_RULESET,
    }),
  })
  const screen = createGameScreen({
    runController: controller,
    mountBattlefield: () => undefined,
    eventPlayerFactory: createSettledEventPlayerFactory([]),
  })
  const parts = campaignOverlayParts(screen)
  const retrySave = byAction(screen, 'campaign-save')
  const mainMenu = byAction(screen, 'campaign-main')
  const autoReveal = byAction(screen, 'auto-reveal')
  assert.equal(parts.heading.textContent, 'Route map · Stage 1/7')
  assert.equal(parts.description.textContent, 'Your route can be chosen once this map is saved.')
  await controller.saveStable()
  await flushMicrotasks()

  assert.equal(controller.getSnapshot().saveStatus, 'failed')
  assert.equal(parts.heading.textContent, 'Route map · Stage 1/7')
  assert.equal(parts.description.textContent, 'Your route can be chosen once this map is saved.')
  assert.deepEqual(
    parts.routeButtons().map((button) => [button.dataset.routeNode, button.disabled]),
    [['gate', true]],
  )
  assert.equal(mainMenu.disabled, true)
  assert.equal(retrySave.hidden, false)
  assert.equal(autoReveal.disabled, true)
  parts.routeButtons()[0].dispatch('click')
  assert.equal(controller.currentMatch.machineState, 'awaitingRoute')
  assert.throws(
    () => controller.chooseRoute({ nodeId: 'gate', step: 0 }),
    /route map must be saved before a route can be chosen/,
  )

  retrySave.dispatch('click')
  await controller.whenIdle()
  await flushMicrotasks()
  assert.equal(saveCalls, 2)
  assert.deepEqual(
    parts.routeButtons().map((button) => [button.dataset.routeNode, button.disabled]),
    [['gate', false]],
  )
  assert.equal(mainMenu.disabled, false)
  assert.equal(retrySave.hidden, true)

  autoReveal.checked = true
  parts.routeButtons()[0].dispatch('click')
  await controller.whenIdle()
  await flushMicrotasks()
  assert.equal(saveCalls, 3)
  assert.equal(controller.currentMatch.machineState, 'ready')
  assert.equal(controller.currentMatch.turn, 0)
  assert.equal(controller.currentMatch.pendingEvent, null)
  assert.equal(parts.overlay.hidden, true)
  assert.equal(byAction(screen, 'reveal').disabled, false)
  assert.equal(byValue(screen, 'campaign-route').textContent, '1/7')

  screen.teardown()
  await controller.destroy()
})

test('Campaign shop overlays announce an emptied shop and keep Leave shop available', (t) => {
  installFakeDocument(t)
  const noop = () => {}
  const overlay = createCampaignOverlay(Object.fromEntries([
    'onChooseNormal', 'onChooseHold', 'onRetrySave', 'onCapture', 'onRetry', 'onChooseOffer',
    'onChooseTarget', 'onBack', 'onClose', 'onChooseRoute', 'onBuyItem', 'onLeaveShop',
    'onChooseEventOption', 'onChooseRestOption', 'onInspect', 'onMainMenu', 'onRestart',
    'onCancel',
  ].map((name) => [name, noop])))
  overlay.update({ match: {}, saveStatus: 'saved', saveReason: null }, {
    mode: 'shop',
    view: {
      title: 'Ember Bazaar',
      description: 'The last market before the finale stocks two cards. You have 0 coins.',
      soldOut: true,
      items: [{
        itemId: 'card-1',
        title: 'New card: 8S · 3 coins',
        detail: 'Add 8S to your deck. Sold.',
        available: false,
        reason: 'sold',
      }],
      modifiers: [],
    },
  })
  const all = descendants(overlay.element)
  const soldOut = all.find((element) => Object.hasOwn(element.dataset, 'shopSoldOut'))
  assert.equal(soldOut.textContent, 'Out of stock. Everything here has been sold.')
  assert.ok(all.filter((element) => element.dataset.shopItem !== undefined)
    .every((element) => element.disabled))
  const leave = all.find((element) => element.dataset.action === 'campaign-leave')
  assert.equal(leave.hidden, false)
  assert.equal(leave.disabled, false)
})

test('A restored sold-out Campaign shop explains every sold item and leaves to the stage-5 fights', async (t) => {
  installFakeDocument(t)
  const exhausted = restoredFixture('campaign-save-shop-exhausted-v7.json')
  const { controller, screen, writes, parts } = await restoredCampaignScreen(exhausted)
  const leave = byAction(screen, 'campaign-leave')
  const items = () => parts.withData('shopItem')
  const soldOut = () => descendants(parts.overlay).find(
    (element) => Object.hasOwn(element.dataset, 'shopSoldOut'),
  )

  assert.equal(parts.heading.textContent, 'Ember Bazaar')
  assert.equal(
    parts.description.textContent,
    'The last market before the finale stocks two cards. You have 0 coins.',
  )
  assert.equal(soldOut().textContent, 'Out of stock. Everything here has been sold.')
  assert.deepEqual(
    items().map((button) => [button.dataset.shopItem, button.textContent, button.disabled]),
    [
      ['card-1', 'New card: AC · 3 coins', true],
      ['card-2', 'New card: 4C · 3 coins', true],
      ['service-1', 'Remove a card · 2 coins', true],
      ['modifier-1', 'Modifier: Vow of Patience · 4 coins', true],
    ],
  )
  assert.ok(parts.choiceDetails().every((detail) => detail.endsWith(' Sold.')))
  const before = controller.currentMatch
  items()[0].dispatch('click')
  assert.equal(parts.heading.textContent, 'Ember Bazaar')
  assert.equal(controller.currentMatch, before)
  assert.equal(writes.length, 0)

  assert.equal(leave.hidden, false)
  assert.equal(leave.disabled, false)
  leave.dispatch('click')
  assert.equal(parts.heading.textContent, 'Saving shop exit')
  await settleWrite(controller, writes, 0)
  assert.equal(controller.currentMatch.machineState, 'awaitingRoute')
  assert.equal(controller.currentMatch.currency, 0)
  assert.equal(parts.heading.textContent, 'Route map · Stage 5/7')
  assert.equal(soldOut(), undefined)
  assert.deepEqual(
    parts.routeButtons().map((button) => button.dataset.routeNode),
    ['watch', 'night-watch'],
  )

  screen.teardown()
  await controller.destroy()
})

test('Auto-reveal stops at a lost Campaign fight and leaves the retried fight to the player', async (t) => {
  installFakeDocument(t)
  const saves = []
  const controller = createRunController({
    repository: {
      load: async () => ({ status: 'empty' }),
      async save(match) {
        saves.push(match)
        return { status: 'saved', savedAt: CAMPAIGN_SAVED_AT }
      },
    },
    initialMatch: arrangeInability(startCampaign({
      runId: 'hud-auto-reveal-loss',
      seed: 6,
      ruleset: BASELINE_RULESET,
    }), 'player'),
  })
  const presented = []
  const screen = createGameScreen({
    runController: controller,
    mountBattlefield: () => undefined,
    eventPlayerFactory: createSettledEventPlayerFactory(presented),
  })
  const parts = campaignOverlayParts(screen)
  const autoReveal = byAction(screen, 'auto-reveal')
  const reveal = byAction(screen, 'reveal')
  const retry = byAction(screen, 'campaign-retry')
  await controller.saveStable()
  await flushMicrotasks()

  autoReveal.checked = true
  autoReveal.dispatch('change')
  reveal.dispatch('click')
  await waitFor(() => controller.currentMatch.machineState === 'awaitingRetry')
  await controller.whenIdle()
  await flushMicrotasks(20)

  const lost = controller.currentMatch
  const savesAtLoss = saves.length
  assert.equal(lost.machineState, 'awaitingRetry')
  assert.deepEqual(saves.at(-1), lost)
  assert.equal(presented.at(-1), lost)
  assert.equal(parts.heading.textContent, 'Encounter lost')
  assert.equal(retry.disabled, false)
  assert.equal(reveal.disabled, true)
  assert.equal(autoReveal.disabled, true)
  assert.equal(autoReveal.checked, true)

  retry.dispatch('click')
  await controller.whenIdle()
  await flushMicrotasks(20)

  const retried = controller.currentMatch
  assert.equal(retried.machineState, 'ready')
  assert.equal(retried.encounterAttempt, 2)
  assert.equal(retried.pendingEvent, null)
  assert.equal(retried.turn, lost.turn)
  assert.equal(saves.length, savesAtLoss + 1)
  assert.deepEqual(saves.at(-1), retried)
  assert.equal(parts.overlay.hidden, true)
  assert.equal(reveal.disabled, false)
  assert.equal(autoReveal.disabled, false)
  assert.equal(autoReveal.checked, true)

  screen.teardown()
  await controller.destroy()
})

const NODE_OPTION_KEYS = Object.freeze({ event: 'eventOption', rest: 'restOption' })

test('Restored Campaign boundaries lead to fights that wait for a manual first reveal', async (t) => {
  installFakeDocument(t)
  const lost = loseEncounter(startCampaign({
    runId: 'hud-restored-retry',
    seed: 6,
    ruleset: BASELINE_RULESET,
  }))
  const boundaries = [
    ['route', restoredFixture('campaign-save-route-v7.json'), [
      ['route', 'shrine'],
      ['event', 'walk-on'],
      ['route', 'court'],
    ]],
    ['shop', restoredFixture('campaign-save-shop-v7.json'), [['leave'], ['route', 'court']]],
    ['sold-out shop', restoredFixture('campaign-save-shop-exhausted-v7.json'), [
      ['leave'],
      ['route', 'watch'],
    ]],
    ['event', restoredFixture('campaign-save-event-v7.json'), [
      ['event', 'walk-on'],
      ['route', 'court'],
    ]],
    ['rest', restoredFixture('campaign-save-rest-v7.json'), [
      ['rest', 'rest'],
      ['route', 'night-watch'],
    ]],
    ['retry', lost, [['retry']]],
  ]
  for (const [name, boundary, decisions] of boundaries) {
    const saves = []
    const { controller, screen, presented, parts } = await restoredCampaignScreen(boundary, {
      async save(match) {
        saves.push(match)
        return { status: 'saved', savedAt: CAMPAIGN_SAVED_AT }
      },
    })
    const autoReveal = byAction(screen, 'auto-reveal')
    const reveal = byAction(screen, 'reveal')
    const presentedAtRestore = presented.length
    assert.equal(parts.overlay.hidden, false, name)
    assert.equal(reveal.disabled, true, name)
    assert.equal(autoReveal.disabled, true, name)

    for (const [kind, id] of decisions) {
      const optionKey = NODE_OPTION_KEYS[kind]
      const button = kind === 'route'
        ? parts.routeButtons().find(({ dataset }) => dataset.routeNode === id)
        : optionKey !== undefined
          ? parts.withData(optionKey).find(({ dataset }) => dataset[optionKey] === id)
          : byAction(screen, `campaign-${kind}`)
      assert.equal(button.disabled, false, `${name}: ${kind} ${id ?? ''}`)
      button.dispatch('click')
      await controller.whenIdle()
      await flushMicrotasks()
    }

    const fight = controller.currentMatch
    assert.equal(fight.machineState, 'ready', name)
    assert.equal(fight.pendingEvent, null, name)
    assert.equal(fight.turn, boundary.turn, name)
    assert.equal(saves.length, decisions.length, name)
    assert.equal(parts.overlay.hidden, true, name)
    assert.equal(reveal.disabled, false, name)
    assert.equal(autoReveal.disabled, false, name)

    autoReveal.checked = true
    autoReveal.dispatch('change')
    await flushMicrotasks(20)
    assert.equal(controller.currentMatch, fight, name)
    assert.equal(saves.length, decisions.length, name)
    assert.ok(
      presented.slice(presentedAtRestore).every(({ pendingEvent }) => pendingEvent === null),
      name,
    )

    screen.teardown()
    await controller.destroy()
  }
})

test('Pause restart remains open when replacement is declined', async (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  const controller = createRunController({
    repository: {
      load: async () => ({ status: 'empty' }),
      save: async () => ({
        status: 'saved',
        savedAt: '2026-09-23T01:01:00.000Z',
      }),
    },
    initialMatch: createMatch({
      runId: 'hud-restart-declined',
      seed: 7,
      ruleset: BASELINE_RULESET,
    }),
  })
  let restarts = 0
  const screen = createGameScreen({
    runController: controller,
    mountBattlefield: () => undefined,
    onRestart() {
      restarts += 1
      return false
    },
  })

  byAction(screen, 'pause').dispatch('click')
  await controller.whenIdle()
  await flushMicrotasks()
  const overlay = descendants(screen.element).find(
    (element) => Object.hasOwn(element.dataset, 'pauseOverlay'),
  )
  const restart = byAction(screen, 'restart')
  restart.dispatch('click')
  await flushMicrotasks()

  assert.equal(restarts, 1)
  assert.equal(controller.currentMatch.machineState, 'paused')
  assert.equal(overlay.hidden, false)
  assert.equal(restart.disabled, false)
  screen.teardown()
  await controller.destroy()
})

test('Game renders a mount-local Auto-reveal checkbox beside Reveal / Continue', async (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  const controller = createRunController({
    repository: {
      load: async () => ({ status: 'empty' }),
      save: async () => assert.fail('Auto-reveal setup should not save'),
    },
    initialMatch: createMatch({
      runId: 'hud-auto-control',
      seed: 12345,
      ruleset: BASELINE_RULESET,
    }),
  })
  const eventPlayerFactory = () => ({
    present: async () => ({ status: 'synchronized', eventId: null, reason: null }),
    setPaused() {},
    destroy() {},
  })
  const createScreen = () => createGameScreen({
    runController: controller,
    mountBattlefield: () => undefined,
    eventPlayerFactory,
  })
  const screen = createScreen()
  const controls = descendants(screen.element).find(
    (element) => Object.hasOwn(element.dataset, 'primaryActionHost'),
  )
  const reveal = byAction(screen, 'reveal')
  const autoReveal = byAction(screen, 'auto-reveal')
  const pause = byAction(screen, 'pause')
  const label = controls.children[1]

  assert.deepEqual(controls.children, [reveal, label, pause])
  assert.equal(label.tagName, 'LABEL')
  assert.equal(label.children[0], autoReveal)
  assert.equal(label.children[1].textContent, 'Auto-reveal')
  assert.equal(autoReveal.tagName, 'INPUT')
  assert.equal(autoReveal.type, 'checkbox')
  assert.equal(autoReveal.checked, false)
  assert.equal(autoReveal.disabled, false)
  assert.equal(autoReveal.listeners.get('change')?.size, 1)

  autoReveal.checked = true
  autoReveal.dispatch('change')
  assert.equal(autoReveal.checked, true)
  screen.teardown()
  assert.equal(autoReveal.listeners.get('change')?.size, 0)

  const remounted = createScreen()
  assert.equal(byAction(remounted, 'auto-reveal').checked, false)
  remounted.teardown()
  await controller.destroy()
})

test('Auto-reveal waits for presentation and disabling it stops the active chain', async (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  const saves = []
  const automaticSave = deferred()
  const controller = createRunController({
    repository: {
      load: async () => ({ status: 'empty' }),
      async save(match) {
        saves.push(match.turn)
        if (match.turn === 2) return automaticSave.promise
        return {
          status: 'saved',
          savedAt: `2026-09-23T12:00:${String(match.turn).padStart(2, '0')}.000Z`,
        }
      },
    },
    initialMatch: createMatch({
      runId: 'hud-auto-chain',
      seed: 12345,
      ruleset: BASELINE_RULESET,
    }),
  })
  const presentations = []
  const deckStates = []
  const screen = createGameScreen({
    runController: controller,
    mountBattlefield: () => ({
      setDeckInputState(state) {
        deckStates.push(state)
      },
      teardown() {},
    }),
    eventPlayerFactory: createControlledEventPlayerFactory(presentations),
  })
  const autoReveal = byAction(screen, 'auto-reveal')
  const reveal = byAction(screen, 'reveal')

  autoReveal.checked = true
  autoReveal.dispatch('change')
  reveal.dispatch('click')
  await waitFor(() => presentations.length === 1)
  assert.equal(controller.currentMatch.turn, 1)
  assert.equal(reveal.disabled, true)
  assert.deepEqual(deckStates.at(-1), { enabled: true, busy: true })
  await flushMicrotasks()
  assert.equal(presentations.length, 1)

  presentations[0].completion.resolve({ status: 'completed' })
  await waitFor(() => controller.currentMatch.turn === 2)
  assert.equal(reveal.disabled, true)
  reveal.dispatch('click')
  assert.equal(controller.currentMatch.turn, 2)
  automaticSave.resolve({
    status: 'saved',
    savedAt: '2026-09-23T12:00:02.000Z',
  })
  await waitFor(() => presentations.length === 2)
  assert.equal(controller.currentMatch.turn, 2)
  assert.deepEqual(saves, [1, 2])
  assert.equal(reveal.disabled, true)
  assert.deepEqual(deckStates.at(-1), { enabled: true, busy: true })

  autoReveal.checked = false
  autoReveal.dispatch('change')
  presentations[1].completion.resolve({ status: 'completed' })
  await waitFor(() => reveal.disabled === false)
  await flushMicrotasks()
  assert.equal(controller.currentMatch.turn, 2)
  assert.equal(presentations.length, 2)
  assert.deepEqual(deckStates.at(-1), { enabled: true, busy: false })

  screen.teardown()
  await controller.destroy()
})

test('Auto-reveal stops when the committed clash save fails', async (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  let saveCount = 0
  const controller = createRunController({
    repository: {
      load: async () => ({ status: 'empty' }),
      async save() {
        saveCount += 1
        return {
          status: 'storage-unavailable',
          operation: 'save',
          reason: 'quota-exceeded',
        }
      },
    },
    initialMatch: createMatch({
      runId: 'hud-auto-save-failure',
      seed: 12345,
      ruleset: BASELINE_RULESET,
    }),
  })
  const presentations = []
  const screen = createGameScreen({
    runController: controller,
    mountBattlefield: () => undefined,
    eventPlayerFactory: createControlledEventPlayerFactory(presentations),
  })
  const autoReveal = byAction(screen, 'auto-reveal')
  const reveal = byAction(screen, 'reveal')

  autoReveal.checked = true
  autoReveal.dispatch('change')
  reveal.dispatch('click')
  await waitFor(() => presentations.length === 1)
  presentations[0].completion.resolve({ status: 'completed' })
  await waitFor(() => reveal.disabled === false)
  await flushMicrotasks()

  assert.equal(controller.currentMatch.turn, 1)
  assert.equal(presentations.length, 1)
  assert.equal(saveCount, 1)

  reveal.dispatch('click')
  await waitFor(() => presentations.length === 2)
  assert.equal(controller.currentMatch.turn, 2)
  assert.equal(saveCount, 2)
  presentations[1].completion.resolve({ status: 'completed' })
  await waitFor(() => reveal.disabled === false)

  screen.teardown()
  await controller.destroy()
})

test('Auto-reveal continues after a reduced-motion presentation skip', async (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  const controller = createRunController({
    repository: {
      load: async () => ({ status: 'empty' }),
      save: async () => ({
        status: 'saved',
        savedAt: '2026-09-23T12:01:00.000Z',
      }),
    },
    initialMatch: createMatch({
      runId: 'hud-auto-reduced-motion',
      seed: 12345,
      ruleset: BASELINE_RULESET,
    }),
  })
  const presentations = []
  const screen = createGameScreen({
    runController: controller,
    mountBattlefield: () => undefined,
    eventPlayerFactory: createControlledEventPlayerFactory(presentations),
  })
  const autoReveal = byAction(screen, 'auto-reveal')

  autoReveal.checked = true
  autoReveal.dispatch('change')
  byAction(screen, 'reveal').dispatch('click')
  await waitFor(() => presentations.length === 1)
  presentations[0].completion.resolve({
    status: 'skipped',
    reason: 'reduced-motion',
  })
  await waitFor(() => presentations.length === 2)
  assert.equal(controller.currentMatch.turn, 2)

  autoReveal.checked = false
  autoReveal.dispatch('change')
  presentations[1].completion.resolve({ status: 'completed' })
  await waitFor(() => byAction(screen, 'reveal').disabled === false)
  assert.equal(presentations.length, 2)

  screen.teardown()
  await controller.destroy()
})

test('Auto-reveal stops when presentation settles during graphics recovery', async (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  const controller = createRunController({
    repository: {
      load: async () => ({ status: 'empty' }),
      save: async () => ({
        status: 'saved',
        savedAt: '2026-09-23T12:01:30.000Z',
      }),
    },
    initialMatch: createMatch({
      runId: 'hud-auto-context-recovery',
      seed: 12345,
      ruleset: BASELINE_RULESET,
    }),
  })
  const presentations = []
  let publishContext
  const screen = createGameScreen({
    runController: controller,
    mountBattlefield: (host, options) => {
      publishContext = options.onContextStatus
    },
    eventPlayerFactory: createControlledEventPlayerFactory(presentations),
  })
  const autoReveal = byAction(screen, 'auto-reveal')
  const reveal = byAction(screen, 'reveal')

  autoReveal.checked = true
  autoReveal.dispatch('change')
  reveal.dispatch('click')
  await waitFor(() => presentations.length === 1)
  assert.equal(controller.currentMatch.turn, 1)

  publishContext({ status: 'lost', recoveryCount: 0, reason: null })
  presentations[0].completion.resolve({
    status: 'skipped',
    reason: 'reduced-motion',
  })
  await flushMicrotasks()
  assert.equal(controller.currentMatch.turn, 1)
  assert.equal(presentations.length, 1)
  assert.equal(reveal.disabled, true)

  publishContext({ status: 'ready', recoveryCount: 1, reason: null })
  await waitFor(() => reveal.disabled === false)
  assert.equal(controller.currentMatch.turn, 1)
  assert.equal(presentations.length, 1)

  screen.teardown()
  await controller.destroy()
})

test('Auto-reveal stops after failed or cancelled presentation', async (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  for (const status of ['failed', 'cancelled']) {
    const controller = createRunController({
      repository: {
        load: async () => ({ status: 'empty' }),
        save: async () => ({
          status: 'saved',
          savedAt: '2026-09-23T12:02:00.000Z',
        }),
      },
      initialMatch: createMatch({
        runId: `hud-auto-${status}`,
        seed: 12345,
        ruleset: BASELINE_RULESET,
      }),
    })
    const presentations = []
    const screen = createGameScreen({
      runController: controller,
      mountBattlefield: () => undefined,
      eventPlayerFactory: createControlledEventPlayerFactory(presentations),
    })
    const autoReveal = byAction(screen, 'auto-reveal')

    autoReveal.checked = true
    autoReveal.dispatch('change')
    byAction(screen, 'reveal').dispatch('click')
    await waitFor(() => presentations.length === 1)
    presentations[0].completion.resolve({
      status,
      reason: status === 'failed' ? 'adapter-error' : 'navigation',
    })
    await waitFor(() => byAction(screen, 'reveal').disabled === false)
    await flushMicrotasks()
    assert.equal(controller.currentMatch.turn, 1)
    assert.equal(presentations.length, 1)

    screen.teardown()
    await controller.destroy()
  }
})

test('Pause disarms Auto-reveal, including after the run resumes', async (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  const controller = createRunController({
    repository: {
      load: async () => ({ status: 'empty' }),
      save: async () => ({
        status: 'saved',
        savedAt: '2026-09-23T12:03:00.000Z',
      }),
    },
    initialMatch: createMatch({
      runId: 'hud-auto-pause',
      seed: 12345,
      ruleset: BASELINE_RULESET,
    }),
  })
  const presentations = []
  const screen = createGameScreen({
    runController: controller,
    mountBattlefield: () => undefined,
    eventPlayerFactory: createControlledEventPlayerFactory(presentations),
  })
  const autoReveal = byAction(screen, 'auto-reveal')

  autoReveal.checked = true
  autoReveal.dispatch('change')
  byAction(screen, 'reveal').dispatch('click')
  await waitFor(() => presentations.length === 1)
  byAction(screen, 'pause').dispatch('click')
  await controller.whenIdle()
  assert.equal(controller.currentMatch.machineState, 'paused')
  assert.equal(autoReveal.disabled, true)

  presentations[0].completion.resolve({ status: 'completed' })
  await flushMicrotasks()
  assert.equal(controller.currentMatch.turn, 1)
  assert.equal(presentations.length, 1)

  byAction(screen, 'resume').dispatch('click')
  await flushMicrotasks()
  assert.equal(controller.currentMatch.machineState, 'ready')
  assert.equal(autoReveal.disabled, false)
  assert.equal(controller.currentMatch.turn, 1)
  assert.equal(presentations.length, 1)

  screen.teardown()
  await controller.destroy()
})

test('update preparation disarms Auto-reveal through the mounted notice event', async (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  const controller = createRunController({
    repository: {
      load: async () => ({ status: 'empty' }),
      save: async () => ({
        status: 'saved',
        savedAt: '2026-09-23T12:03:30.000Z',
      }),
    },
    initialMatch: createMatch({
      runId: 'hud-auto-update-barrier',
      seed: 12345,
      ruleset: BASELINE_RULESET,
    }),
  })
  const presentations = []
  let publishContext
  const screen = createGameScreen({
    runController: controller,
    mountBattlefield: (host, options) => {
      publishContext = options.onContextStatus
    },
    eventPlayerFactory: createControlledEventPlayerFactory(presentations),
  })
  const autoReveal = byAction(screen, 'auto-reveal')
  const reveal = byAction(screen, 'reveal')
  const hud = descendants(screen.element).find(
    (element) => element.className === 'game-hud',
  )
  let updateSubscriber
  const notice = createUpdateNotice({
    host: screen.element,
    updateController: {
      getSnapshot: () => ({ status: 'current', reason: null, canActivate: false }),
      subscribe(subscriber) {
        updateSubscriber = subscriber
        subscriber(this.getSnapshot())
        return () => {}
      },
      requestActivation: async () => {},
    },
  })

  autoReveal.checked = true
  autoReveal.dispatch('change')
  reveal.dispatch('click')
  await waitFor(() => presentations.length === 1)
  updateSubscriber({ status: 'preparing', reason: null, canActivate: false })
  assert.equal(hud.inert, true)
  publishContext({ status: 'lost', recoveryCount: 0, reason: null })
  assert.equal(hud.inert, true)
  publishContext({ status: 'ready', recoveryCount: 1, reason: null })
  assert.equal(hud.inert, true)
  presentations[0].completion.resolve({ status: 'completed' })
  await waitFor(() => reveal.disabled === false)
  await flushMicrotasks()

  assert.equal(controller.currentMatch.turn, 1)
  assert.equal(presentations.length, 1)
  assert.equal(hud.inert, true)
  reveal.dispatch('click')
  await flushMicrotasks()
  assert.equal(controller.currentMatch.turn, 1)

  notice.teardown()
  assert.equal(hud.inert, false)
  screen.teardown()
  await controller.destroy()
})

test('Auto-reveal stops at a terminal match', async (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  let penultimate = createMatch({
    runId: 'hud-auto-terminal',
    seed: 0,
    ruleset: BASELINE_RULESET,
  })
  while (true) {
    const transition = revealOrContinue(penultimate)
    if (transition.match.status === 'ended') break
    penultimate = transition.match
  }
  const controller = createRunController({
    repository: {
      load: async () => ({ status: 'empty' }),
      save: async () => ({
        status: 'saved',
        savedAt: '2026-09-23T12:04:00.000Z',
      }),
    },
    initialMatch: penultimate,
  })
  const presentations = []
  const screen = createGameScreen({
    runController: controller,
    mountBattlefield: () => undefined,
    eventPlayerFactory: createControlledEventPlayerFactory(presentations),
  })

  const autoReveal = byAction(screen, 'auto-reveal')
  autoReveal.checked = true
  autoReveal.dispatch('change')
  byAction(screen, 'reveal').dispatch('click')
  await waitFor(() => presentations.length === 1)
  assert.equal(controller.currentMatch.status, 'ended')
  presentations[0].completion.resolve({ status: 'completed' })
  await flushMicrotasks()

  assert.equal(presentations.length, 1)
  assert.equal(byAction(screen, 'reveal').disabled, true)
  assert.equal(autoReveal.disabled, true)

  screen.teardown()
  await controller.destroy()
})

test('Auto-reveal ignores stale and post-teardown presentation completions', async (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  const repository = {
    load: async () => ({ status: 'empty' }),
    save: async () => ({
      status: 'saved',
      savedAt: '2026-09-23T12:05:00.000Z',
    }),
  }
  const staleController = createRunController({
    repository,
    initialMatch: createMatch({
      runId: 'hud-auto-stale-old',
      seed: 12345,
      ruleset: BASELINE_RULESET,
    }),
  })
  const stalePresentations = []
  const staleScreen = createGameScreen({
    runController: staleController,
    mountBattlefield: () => undefined,
    eventPlayerFactory: createControlledEventPlayerFactory(stalePresentations),
  })
  const staleToggle = byAction(staleScreen, 'auto-reveal')
  staleToggle.checked = true
  staleToggle.dispatch('change')
  byAction(staleScreen, 'reveal').dispatch('click')
  await waitFor(() => stalePresentations.length === 1)

  const replacement = createMatch({
    runId: 'hud-auto-stale-new',
    seed: 1,
    ruleset: BASELINE_RULESET,
  })
  staleController.setMatch(replacement)
  stalePresentations[0].completion.resolve({ status: 'completed' })
  await flushMicrotasks()
  assert.equal(staleController.currentMatch.runId, replacement.runId)
  assert.equal(staleController.currentMatch.turn, 0)
  assert.equal(stalePresentations.length, 1)
  staleScreen.teardown()
  await staleController.destroy()

  const teardownController = createRunController({
    repository,
    initialMatch: createMatch({
      runId: 'hud-auto-teardown',
      seed: 12345,
      ruleset: BASELINE_RULESET,
    }),
  })
  const teardownPresentations = []
  const teardownScreen = createGameScreen({
    runController: teardownController,
    mountBattlefield: () => undefined,
    eventPlayerFactory: createControlledEventPlayerFactory(teardownPresentations),
  })
  const teardownToggle = byAction(teardownScreen, 'auto-reveal')
  teardownToggle.checked = true
  teardownToggle.dispatch('change')
  byAction(teardownScreen, 'reveal').dispatch('click')
  await waitFor(() => teardownPresentations.length === 1)
  teardownScreen.teardown()
  teardownPresentations[0].completion.resolve({ status: 'completed' })
  await flushMicrotasks()
  assert.equal(teardownController.currentMatch.turn, 1)
  assert.equal(teardownPresentations.length, 1)
  await teardownController.destroy()
})

test('Game resolves one pointer reveal, locks input through save and presentation, and updates HUD', async (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  const write = deferred()
  const animation = deferred()
  const saves = []
  const controller = createRunController({
    repository: {
      load: async () => ({ status: 'empty' }),
      save(match) {
        saves.push(match)
        return write.promise
      },
    },
    initialMatch: createMatch({
      runId: 'hud-pointer-reveal',
      seed: 0,
      ruleset: BASELINE_RULESET,
    }),
  })
  const presented = []
  const screen = createGameScreen({
    runController: controller,
    mountBattlefield: () => undefined,
    eventPlayerFactory: ({ onStateChange }) => ({
      present(match) {
        if (match.pendingEvent === null) {
          return Promise.resolve({ status: 'synchronized' })
        }
        const eventId = match.pendingEvent.id
        presented.push(eventId)
        onStateChange({
          status: 'playing',
          eventId,
          stepIndex: 0,
          stepCount: 3,
          stepKind: 'reveal',
          reason: null,
        })
        return animation.promise.then(() => {
          onStateChange({
            status: 'completed',
            eventId,
            stepIndex: null,
            stepCount: 3,
            stepKind: null,
            reason: null,
          })
          return { status: 'completed', eventId, reason: null }
        })
      },
      setPaused() {},
      destroy() {},
    }),
  })
  const reveal = byAction(screen, 'reveal')
  const comparisonResult = descendants(screen.element).find(
    (element) => Object.hasOwn(element.dataset, 'comparisonResult'),
  )
  const comparisonDetails = descendants(screen.element).find(
    (element) => Object.hasOwn(element.dataset, 'comparisonDetails'),
  )
  const comparisonProgress = descendants(screen.element).find(
    (element) => Object.hasOwn(element.dataset, 'comparisonProgress'),
  )

  assert.equal(reveal.disabled, false)
  assert.equal(comparisonResult.textContent, 'Ready for the first reveal')
  reveal.dispatch('pointerdown', { pointerType: 'touch', pointerId: 7, button: 0 })
  reveal.dispatch('pointerup', { pointerType: 'touch', pointerId: 7, button: 0 })
  reveal.dispatch('click', { detail: 1, button: 0 })

  assert.equal(controller.currentMatch.turn, 1)
  assert.equal(reveal.disabled, true)
  assert.match(comparisonResult.textContent, /won clash 1/)
  assert.match(comparisonDetails.textContent, /cards? revealed · \d+ ties? · \d+ burned/)

  await flushMicrotasks()
  assert.equal(saves.length, 1)
  write.resolve({
    status: 'saved',
    savedAt: '2026-09-22T17:00:00.000Z',
  })
  await controller.whenIdle()
  await flushMicrotasks()
  assert.deepEqual(presented, [controller.currentMatch.pendingEvent.id])
  assert.equal(reveal.disabled, true)
  assert.equal(comparisonProgress.textContent, 'Revealing cards · 1 of 3')

  reveal.dispatch('pointerdown', { pointerType: 'pen', pointerId: 8, button: 0 })
  reveal.dispatch('pointerup', { pointerType: 'pen', pointerId: 8, button: 0 })
  assert.equal(controller.currentMatch.turn, 1)

  animation.resolve()
  await flushMicrotasks()
  assert.equal(reveal.disabled, false)
  assert.equal(comparisonProgress.textContent, 'Presentation complete.')

  screen.teardown()
  await controller.destroy()
})

test('Game routes active-deck drops and button activation through one Reveal busy gate', async (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  const saves = []
  const controller = createRunController({
    repository: {
      load: async () => ({ status: 'empty' }),
      async save(match) {
        saves.push(match.turn)
        return {
          status: 'saved',
          savedAt: '2026-09-22T20:00:00.000Z',
        }
      },
    },
    initialMatch: createMatch({
      runId: 'hud-deck-reveal',
      seed: 1,
      ruleset: BASELINE_RULESET,
    }),
  })
  const deckStates = []
  const presented = []
  let activateDeck
  const screen = createGameScreen({
    runController: controller,
    mountBattlefield: (host, options) => {
      activateDeck = options.onDeckActivate
      return {
        setDeckInputState(state) {
          deckStates.push(state)
        },
        teardown() {},
      }
    },
    eventPlayerFactory: () => ({
      present(match) {
        if (match.pendingEvent !== null) presented.push(match.pendingEvent.id)
        return Promise.resolve({
          status: 'completed',
          eventId: match.pendingEvent?.id ?? null,
          reason: null,
        })
      },
      setPaused() {},
      destroy() {},
    }),
  })
  const reveal = byAction(screen, 'reveal')

  assert.equal(typeof activateDeck, 'function')
  assert.deepEqual(deckStates.at(-1), { enabled: true, busy: false })
  activateDeck({ type: 'pointerup', pointerType: 'touch', interaction: 'drop' })
  activateDeck({ type: 'pointerup', pointerType: 'touch', interaction: 'drop' })
  assert.equal(controller.currentMatch.turn, 1)
  assert.equal(reveal.disabled, true)
  assert.deepEqual(deckStates.at(-1), { enabled: true, busy: true })

  await controller.whenIdle()
  await flushMicrotasks()
  assert.equal(reveal.disabled, false)
  reveal.dispatch('click')
  assert.equal(controller.currentMatch.turn, 2)
  await controller.whenIdle()
  await flushMicrotasks()

  assert.deepEqual(saves, [1, 2])
  assert.equal(new Set(presented).size, 2)
  assert.deepEqual(deckStates.at(-1), { enabled: true, busy: false })

  screen.teardown()
  await controller.destroy()
})

test('Game gates committed presentation on save completion and publishes live progress', async (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  const write = deferred()
  const controller = createRunController({
    repository: {
      load: async () => ({ status: 'empty' }),
      save: async () => write.promise,
    },
    initialMatch: createMatch({
      runId: 'hud-presentation',
      seed: 0,
      ruleset: BASELINE_RULESET,
    }),
  })
  const presented = []
  const paused = []
  let presentationState
  let destroyed = 0
  const screen = createGameScreen({
    runController: controller,
    mountBattlefield: () => ({
      syncSnapshot() {},
      beginEvent() {},
      applyStep() {},
      setPaused() {},
      teardown() {},
    }),
    eventPlayerFactory({ onStateChange }) {
      presentationState = onStateChange
      return {
        present(match) {
          presented.push(match)
          return Promise.resolve({ status: 'completed' })
        },
        setPaused(value) {
          paused.push(value)
        },
        destroy() {
          destroyed += 1
        },
      }
    },
  })
  const status = descendants(screen.element).find(
    (element) => Object.hasOwn(element.dataset, 'statusHost'),
  )
  const reveal = byAction(screen, 'reveal')
  const comparisonProgress = descendants(screen.element).find(
    (element) => Object.hasOwn(element.dataset, 'comparisonProgress'),
  )

  assert.equal(presented.length, 1)
  assert.equal(presented[0].pendingEvent, null)
  const clash = controller.revealOrContinue()
  assert.equal(controller.currentMatch.turn, 1)
  assert.equal(presented.length, 1)
  assert.equal(status.textContent, 'Saving committed clash…')

  write.resolve({
    status: 'saved',
    savedAt: '2026-09-22T09:00:00.000Z',
  })
  await clash
  await Promise.resolve()
  assert.equal(presented.length, 2)
  assert.equal(presented[1].pendingEvent.id, controller.currentMatch.pendingEvent.id)
  assert.equal(byValue(screen, 'stage').textContent, 'Source')
  assert.equal(
    byValue(screen, 'source-count').textContent,
    String(controller.currentMatch.zones.sourceDeck.length),
  )
  assert.ok(paused.length > 0)
  assert.ok(paused.every((value) => value === false))

  presentationState({
    status: 'playing',
    eventId: controller.currentMatch.pendingEvent.id,
    stepIndex: 0,
    stepCount: 3,
    stepKind: 'reveal',
    reason: null,
  })
  assert.equal(status.textContent, 'Revealing committed card.')
  assert.equal(comparisonProgress.textContent, 'Revealing cards · 1 of 3')
  assert.equal(reveal.disabled, true)
  presentationState({
    status: 'skipped',
    eventId: controller.currentMatch.pendingEvent.id,
    stepIndex: null,
    stepCount: 3,
    stepKind: null,
    reason: 'reduced-motion',
  })
  assert.equal(status.textContent, 'Presentation skipped for reduced motion.')
  assert.equal(status.dataset.presentationState, 'skipped')
  assert.equal(comparisonProgress.textContent, 'Presentation skipped.')
  assert.equal(reveal.disabled, false)

  screen.teardown()
  assert.equal(destroyed, 1)
})

test('Game queues a restored paused event and tears down player before battlefield', (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  const ready = revealOrContinue(createMatch({
    runId: 'hud-restored-event',
    seed: 0,
    ruleset: BASELINE_RULESET,
  })).match
  const snapshot = {
    match: { ...ready, machineState: 'paused' },
    saveStatus: 'saved',
    saveReason: null,
  }
  const order = []
  const presented = []
  const pauses = []
  const runController = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listener(snapshot)
      return () => order.push('unsubscribe')
    },
    revealOrContinue() {},
    pause() {},
    resume() {},
    saveStable: async () => ({ status: 'saved' }),
  }
  const screen = createGameScreen({
    runController,
    mountBattlefield: () => ({
      teardown() {
        order.push('battlefield')
      },
    }),
    eventPlayerFactory() {
      return {
        present(match) {
          presented.push(match.pendingEvent.id)
          return Promise.resolve({ status: 'queued' })
        },
        setPaused(value) {
          pauses.push(value)
        },
        destroy() {
          order.push('player')
        },
      }
    },
  })

  assert.deepEqual(presented, [ready.pendingEvent.id])
  assert.deepEqual(pauses, [true])
  screen.teardown()
  assert.deepEqual(order, ['unsubscribe', 'player', 'battlefield'])
})

test('Game presents a committed event after a failed save without blocking play', async (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  const controller = createRunController({
    repository: {
      load: async () => ({ status: 'empty' }),
      save: async () => ({
        status: 'storage-unavailable',
        operation: 'save',
        reason: 'quota-exceeded',
      }),
    },
    initialMatch: createMatch({
      runId: 'hud-failed-save',
      seed: 0,
      ruleset: BASELINE_RULESET,
    }),
  })
  const presented = []
  const screen = createGameScreen({
    runController: controller,
    mountBattlefield: () => undefined,
    eventPlayerFactory: ({ onStateChange }) => ({
      present(match) {
        presented.push(match.pendingEvent?.id ?? null)
        if (match.pendingEvent !== null) {
          onStateChange({
            status: 'playing',
            eventId: match.pendingEvent.id,
            stepIndex: 0,
            stepCount: 1,
            stepKind: 'reveal',
            reason: null,
          })
        }
        return Promise.resolve({ status: 'failed', reason: 'adapter-error' })
      },
      setPaused() {},
      destroy() {},
    }),
  })
  const status = descendants(screen.element).find(
    (element) => Object.hasOwn(element.dataset, 'statusHost'),
  )
  const saveWarning = descendants(screen.element).find(
    (element) => Object.hasOwn(element.dataset, 'saveWarning'),
  )

  await controller.revealOrContinue()
  await Promise.resolve()
  assert.deepEqual(presented, [null, controller.currentMatch.pendingEvent.id])
  assert.equal(
    status.textContent,
    'Presentation skipped after a rendering error.',
  )
  assert.equal(byAction(screen, 'reveal').disabled, false)
  assert.equal(saveWarning.hidden, false)
  assert.equal(
    saveWarning.textContent,
    'Save failed (quota-exceeded). Your game remains available in this session.',
  )
  screen.teardown()
})

test('Game exposes terminal outcome details and disables primary actions', (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  let terminal = createMatch({
    runId: 'hud-terminal',
    seed: 0,
    ruleset: BASELINE_RULESET,
  })
  while (terminal.status === 'active') {
    terminal = revealOrContinue(terminal).match
  }
  const controller = createRunController({
    repository: {
      load: async () => ({ status: 'empty' }),
      save: async () => ({ status: 'saved', savedAt: '2026-09-22T17:10:00.000Z' }),
    },
    initialMatch: terminal,
  })
  const screen = createGameScreen({
    runController: controller,
    mountBattlefield: () => undefined,
  })
  const result = descendants(screen.element).find(
    (element) => Object.hasOwn(element.dataset, 'comparisonResult'),
  )
  const details = descendants(screen.element).find(
    (element) => Object.hasOwn(element.dataset, 'comparisonDetails'),
  )
  const status = descendants(screen.element).find(
    (element) => Object.hasOwn(element.dataset, 'statusHost'),
  )

  assert.match(result.textContent, /won the match|ended in a draw/)
  assert.match(details.textContent, /^Final clash:/)
  assert.match(status.textContent, /won the match|ended in a draw/)
  assert.equal(byAction(screen, 'reveal').disabled, true)
  assert.equal(byAction(screen, 'pause').disabled, true)
  screen.teardown()
})

test('End overlay settles terminal presentation after graphics recovery fails', async (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  let terminal = createMatch({
    runId: 'hud-terminal-overlay',
    seed: 0,
    ruleset: BASELINE_RULESET,
  })
  while (terminal.status === 'active') {
    terminal = revealOrContinue(terminal).match
  }
  const write = deferred()
  const animation = deferred()
  const controller = createRunController({
    repository: {
      load: async () => ({ status: 'empty' }),
      save: async () => write.promise,
    },
    initialMatch: terminal,
  })
  let mainMenuCalls = 0
  let publishContext
  let presentationCalls = 0
  let cancellationReason = null
  const screen = createGameScreen({
    runController: controller,
    mountBattlefield: (host, options) => {
      publishContext = options.onContextStatus
    },
    eventPlayerFactory: () => ({
      present() {
        presentationCalls += 1
        return animation.promise
      },
      setPaused() {},
      cancel(reason) {
        cancellationReason = reason
      },
      destroy() {},
    }),
    onMainMenu() {
      mainMenuCalls += 1
    },
  })
  const pauseOverlay = descendants(screen.element).find(
    (element) => Object.hasOwn(element.dataset, 'pauseOverlay'),
  )
  const endOverlay = descendants(screen.element).find(
    (element) => Object.hasOwn(element.dataset, 'endOverlay'),
  )
  const summary = descendants(screen.element).find(
    (element) => Object.hasOwn(element.dataset, 'endSummary'),
  )
  const saving = controller.saveStable()
  assert.equal(endOverlay.hidden, true)
  assert.equal(endOverlay.hidden, true)
  publishContext({
    status: 'failed',
    recoveryCount: 0,
    reason: 'replacement unavailable',
  })
  assert.equal(cancellationReason, 'graphics-recovery-failed')
  write.resolve({
    status: 'saved',
    savedAt: '2026-09-23T01:02:00.000Z',
  })
  await saving
  await flushMicrotasks()
  assert.equal(presentationCalls, 0)
  assert.equal(endOverlay.hidden, false)
  assert.equal(pauseOverlay.hidden, true)
  assert.equal(endOverlay.attributes.role, 'dialog')
  assert.equal(endOverlay.attributes['aria-modal'], 'true')
  assert.match(summary.textContent, new RegExp(`^${terminal.turn} clashes`))
  assert.match(summary.textContent, new RegExp(`${terminal.zones.burnPile.length} cards burned$`))

  byAction(screen, 'end-main').dispatch('click')
  assert.equal(mainMenuCalls, 1)
  screen.teardown()
  await controller.destroy()
})

test('restored terminal wins and draws reopen their completed summaries', async (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  for (const [seed, expectedHeading] of [[0, 'Victory'], [93, 'Match drawn']]) {
    let terminal = createMatch({
      runId: `hud-restored-terminal-${seed}`,
      seed,
      ruleset: BASELINE_RULESET,
    })
    while (terminal.status === 'active') {
      terminal = revealOrContinue(terminal).match
    }
    const controller = createRunController({
      repository: {
        load: async () => ({
          status: 'resumable',
          savedAt: '2026-09-23T01:03:00.000Z',
          migratedFrom: null,
          match: terminal,
        }),
        save: async () => assert.fail('Restored summary should not require another save'),
      },
    })
    await controller.restore()
    const before = JSON.parse(JSON.stringify(controller.currentMatch))
    const screen = createGameScreen({
      runController: controller,
      mountBattlefield: () => undefined,
      eventPlayerFactory: () => ({
        present(match) {
          return Promise.resolve({
            status: 'completed',
            eventId: match.pendingEvent.id,
            reason: null,
          })
        },
        setPaused() {},
        destroy() {},
      }),
    })
    await flushMicrotasks()
    const endOverlay = descendants(screen.element).find(
      (element) => Object.hasOwn(element.dataset, 'endOverlay'),
    )
    const heading = descendants(endOverlay).find(
      (element) => element.id === 'end-overlay-title',
    )
    const reason = descendants(endOverlay).find(
      (element) => Object.hasOwn(element.dataset, 'endReason'),
    )

    assert.equal(endOverlay.hidden, false)
    assert.equal(heading.textContent, expectedHeading)
    assert.ok(reason.textContent.length > 0)
    assert.deepEqual(controller.currentMatch, before)
    screen.teardown()
    await controller.destroy()
  }
})

test('Game queues every committed event after its save attempt settles', async (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  const writes = [deferred(), deferred()]
  let writeIndex = 0
  const controller = createRunController({
    repository: {
      load: async () => ({ status: 'empty' }),
      save: async () => writes[writeIndex++].promise,
    },
    initialMatch: createMatch({
      runId: 'hud-ordered-presentation',
      seed: 0,
      ruleset: BASELINE_RULESET,
    }),
  })
  const presented = []
  const screen = createGameScreen({
    runController: controller,
    mountBattlefield: () => undefined,
    eventPlayerFactory: () => ({
      present(match) {
        presented.push(match.pendingEvent?.id ?? null)
        return Promise.resolve({ status: 'queued' })
      },
      setPaused() {},
      destroy() {},
    }),
  })

  const first = controller.revealOrContinue()
  const firstEventId = controller.currentMatch.pendingEvent.id
  const second = controller.revealOrContinue()
  const secondEventId = controller.currentMatch.pendingEvent.id
  assert.deepEqual(presented, [null])

  writes[0].resolve({ status: 'saved', savedAt: '2026-09-22T10:00:00.000Z' })
  await first
  await Promise.resolve()
  assert.deepEqual(presented, [null, firstEventId])

  writes[1].resolve({ status: 'saved', savedAt: '2026-09-22T10:00:01.000Z' })
  await second
  await Promise.resolve()
  assert.deepEqual(presented, [null, firstEventId, secondEventId])

  screen.teardown()
})

test('Game ignores save completions from a replaced run', async (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  const writes = [deferred(), deferred()]
  let writeIndex = 0
  const controller = createRunController({
    repository: {
      load: async () => ({ status: 'empty' }),
      save: async () => writes[writeIndex++].promise,
    },
    initialMatch: createMatch({
      runId: 'replaced-old-run',
      seed: 0,
      ruleset: BASELINE_RULESET,
    }),
  })
  const oldSave = controller.revealOrContinue()
  await Promise.resolve()
  const newMatch = createMatch({
    runId: 'replacement-new-run',
    seed: 1,
    ruleset: BASELINE_RULESET,
  })
  controller.setMatch(newMatch)
  const newSave = controller.saveStable()
  const presentedRunIds = []
  const screen = createGameScreen({
    runController: controller,
    mountBattlefield: () => undefined,
    eventPlayerFactory: () => ({
      present(match) {
        presentedRunIds.push(match.runId)
        return Promise.resolve({ status: 'synchronized' })
      },
      setPaused() {},
      destroy() {},
    }),
  })

  assert.deepEqual(presentedRunIds, [newMatch.runId])
  writes[0].resolve({
    status: 'saved',
    savedAt: '2026-09-22T20:00:00.000Z',
  })
  await oldSave
  await flushMicrotasks()
  assert.deepEqual(presentedRunIds, [newMatch.runId])

  writes[1].resolve({
    status: 'saved',
    savedAt: '2026-09-22T20:00:01.000Z',
  })
  await newSave
  await flushMicrotasks()
  assert.ok(presentedRunIds.length >= 1)
  assert.ok(presentedRunIds.every((runId) => runId === newMatch.runId))

  screen.teardown()
  await controller.destroy()
})

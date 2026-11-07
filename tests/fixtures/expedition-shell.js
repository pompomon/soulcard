import assert from 'node:assert/strict'
import { bootstrap } from '../../src/app/bootstrap.js'
import { createRunController } from '../../src/app/run-controller.js'
import { createCampaignRun } from '../../src/domain/campaign-machine.js'
import { BASELINE_RULESET } from '../../src/domain/ruleset.js'
import { createRunSave, restoreRunSave } from '../../src/persistence/run-schema.js'
import { createSettingsRepository } from '../../src/persistence/settings-repository.js'
import { createExpeditionCounters, stepExpedition } from './campaign-route.js'

// Drives scripted Campaign expeditions through the real application shell. The domain
// expedition script decides every step; the harness performs that decision by clicking the
// HUD and Campaign overlay, then requires the saved UI run to equal the domain run. Each
// newly reached boundary is reloaded from storage before play continues.

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase()
    this.children = []
    this.dataset = {}
    this.attributes = {}
    this.listeners = new Map()
    this.className = ''
    this.textContent = ''
    this.hidden = false
    this.disabled = false
    this.checked = false
    this.style = { setProperty() {} }
  }

  append(...children) {
    this.children.push(...children)
  }

  replaceChildren(...children) {
    this.children = children
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
      button: type === 'click' ? 0 : undefined,
      detail: 0,
      preventDefault() {},
      stopPropagation() {},
      ...values,
    }
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event)
  }
}

export function descendants(element) {
  return [element, ...element.children.flatMap(descendants)]
}

function visibleDescendants(element) {
  if (element.hidden) return []
  return [element, ...element.children.flatMap(visibleDescendants)]
}

export function byAction(root, action) {
  return descendants(root).find((element) => element.dataset.action === action)
}

export function choiceButtons(root, key) {
  return descendants(root).filter((element) => (
    element.tagName === 'BUTTON' && Object.hasOwn(element.dataset, key)
  ))
}

export function choiceButton(root, key, id) {
  return choiceButtons(root, key).find((element) => element.dataset[key] === id)
}

export function usable(root, element) {
  return (
    element !== undefined
    && !element.disabled
    && visibleDescendants(root).includes(element)
  )
}

function campaignOverlay(root) {
  return descendants(root).find((element) => Object.hasOwn(element.dataset, 'campaignOverlay'))
}

export function overlayTitle(root) {
  return descendants(root).find((element) => element.id === 'campaign-overlay-title')
    ?.textContent
}

export function overlayDescription(root) {
  return descendants(root).find((element) => (
    Object.hasOwn(element.dataset, 'campaignDescription')
  ))?.textContent
}

export function overlayOpen(root) {
  return !campaignOverlay(root).hidden
}

// Section headings, lines, and list items in the Campaign overlay's details.
export function overlayDetails(root) {
  const host = descendants(root).find((element) => Object.hasOwn(element.dataset, 'campaignDetails'))
  return descendants(host)
    .filter((element) => ['H3', 'LI', 'P'].includes(element.tagName))
    .map((element) => element.textContent)
}

// The detail line that describes the choice `id` in a list rendered with `prefix`.
export function choiceDetail(root, prefix, id) {
  return descendants(root).find((element) => element.id === `${prefix}-${id}-detail`)
    ?.textContent
}

export function campaignStatus(root) {
  return descendants(root).find((element) => (
    Object.hasOwn(element.dataset, 'campaignStatus')
  ))?.textContent
}

export function click(element) {
  assert.ok(element, 'The control to activate is rendered')
  element.dispatch('click')
}

export async function waitFor(predicate, label) {
  for (let round = 0; round < 2000; round += 1) {
    if (predicate()) return
    await (round < 500
      ? Promise.resolve()
      : new Promise((resolve) => setImmediate(resolve)))
  }
  assert.fail(`${label} did not settle`)
}

const SEEDED_AT = '2026-11-01T00:00:00.000Z'

// A repository that keeps one saved record in memory. `initial` seeds it with a saved run.
function createMemoryRepository(initial = null) {
  let record = initial === null
    ? null
    : structuredClone(createRunSave(initial, { savedAt: SEEDED_AT }))
  let saves = 0
  let failNext = false
  return {
    async load() {
      if (record === null) return { status: 'empty' }
      return {
        status: 'resumable',
        savedAt: record.savedAt,
        migratedFrom: null,
        match: restoreRunSave(structuredClone(record)),
      }
    },
    async save(match) {
      if (failNext) {
        failNext = false
        return { status: 'storage-unavailable', operation: 'save', reason: 'quota-exceeded' }
      }
      saves += 1
      const savedAt = new Date(Date.UTC(2026, 10, 1, 0, 0, saves)).toISOString()
      record = structuredClone(createRunSave(match, { savedAt }))
      return { status: 'saved', savedAt }
    },
    async discard() {
      record = null
      return { status: 'discarded' }
    },
    close() {},
    failNextSave() {
      failNext = true
    },
    get saves() {
      return saves
    },
  }
}

function immediateEventPlayer({ onStateChange }) {
  return {
    present(match) {
      const eventId = match.pendingEvent?.id ?? null
      if (eventId !== null) {
        onStateChange({
          status: 'completed',
          eventId,
          stepIndex: null,
          stepCount: match.pendingEvent.reveals.length,
          stepKind: null,
          reason: null,
        })
      }
      return Promise.resolve({
        status: eventId === null ? 'synchronized' : 'completed',
        eventId,
        reason: null,
      })
    },
    setPaused() {},
    destroy() {},
  }
}

async function launch(harness) {
  const root = new FakeElement('div')
  const runController = createRunController({ repository: harness.repository })
  const app = bootstrap({
    root,
    runController,
    settingsRepository: createSettingsRepository({ storage: null }),
    matchMedia: null,
    pageLifecycleFactory: () => ({ destroy() {} }),
    mountBattlefield: () => undefined,
    eventPlayerFactory: immediateEventPlayer,
    newCampaignFactory: ({ ruleset }) => {
      assert.equal(ruleset, BASELINE_RULESET)
      return createCampaignRun({ runId: harness.runId, seed: harness.seed, ruleset })
    },
    confirmStartOver: () => (
      harness.confirmStartOver?.() ?? assert.fail('The expedition never replaces a saved run')
    ),
  })
  await app.ready
  Object.assign(harness, { app, root, runController })
}

// The control that continues the expedition from each saved state is usable.
function actionable({ app, root }) {
  const match = app.runSnapshot.match
  switch (match.machineState) {
    case 'ready':
      return campaignOverlay(root).hidden && usable(root, byAction(root, 'reveal'))
    case 'awaitingHoldChoice':
    case 'awaitingInformedHoldChoice':
      return usable(root, byAction(
        root,
        match.holdChoice.candidate === null ? 'campaign-hold' : 'campaign-normal',
      ))
    case 'awaitingRetry':
      return usable(root, byAction(root, 'campaign-retry'))
    case 'awaitingShop':
      return usable(root, byAction(root, 'campaign-leave'))
    case 'awaitingRoute':
      return choiceButtons(root, 'routeNode').some((button) => usable(root, button))
    case 'awaitingReward':
      return choiceButtons(root, 'rewardOffer').some((button) => usable(root, button))
    case 'awaitingEvent':
      return choiceButtons(root, 'eventOption').some((button) => usable(root, button))
    case 'awaitingRest':
      return choiceButtons(root, 'restOption').some((button) => usable(root, button))
    case 'ended':
      return usable(root, byAction(root, 'campaign-main'))
    default:
      return false
  }
}

async function settle(harness) {
  await waitFor(
    () => harness.app.runSnapshot.saveStatus === 'saved' && actionable(harness),
    'The saved Campaign state',
  )
}

// Destroys the app and restores the saved run in a fresh one, as a page reload does.
export async function reload(harness, expected = harness.app.runSnapshot.match) {
  const saves = harness.repository.saves
  await harness.app.destroy()
  await launch(harness)
  assert.equal(harness.app.resumeAvailable, true)
  assert.deepEqual(harness.app.runSnapshot.match, expected)
  click(byAction(harness.root, 'resume'))
  assert.equal(harness.app.activeScreen, 'game')
  await settle(harness)
  assert.equal(harness.repository.saves, saves, 'Resuming a boundary does not save')
}

// Saved boundaries: every node decision, the end, and the start of each fight attempt.
export function boundaryKey(match) {
  if (['awaitingHoldChoice', 'awaitingInformedHoldChoice'].includes(match.machineState)) {
    return null
  }
  return `${match.journal.length}:${match.machineState}`
}

// Every state of the scripted expedition, played in the domain alone.
function domainExpedition({ runId, seed, plan, start }) {
  let run = start ?? createCampaignRun({ runId, seed, ruleset: BASELINE_RULESET })
  const counters = createExpeditionCounters()
  const keys = []
  const states = [run]
  for (let step = 0; run.machineState !== 'ended'; step += 1) {
    assert.ok(step < 5000, 'The domain expedition ends')
    const key = boundaryKey(run)
    if (key !== null && !keys.includes(key)) keys.push(key)
    run = stepExpedition(run, plan, counters)
    states.push(run)
  }
  keys.push(boundaryKey(run))
  return { final: run, counters, keys, states }
}

// Activates a control that applies a decision; the controller marks the run synchronously.
export function commit(harness, element, { doubleActivate = false } = {}) {
  assert.ok(usable(harness.root, element), 'The deciding control is usable')
  const before = harness.app.runSnapshot.match
  click(element)
  const after = harness.app.runSnapshot.match
  assert.notEqual(after, before, 'The activation applied its decision')
  if (doubleActivate) {
    click(element)
    assert.equal(harness.app.runSnapshot.match, after, 'A repeated activation is ignored')
  }
}

// Chooses a listed option. Targeted deck edits open a picker; the first picker of each
// kind is backed out of once before the target is chosen.
function choose(harness, { key, id, targetKey, targetInstanceId }, options) {
  const { root } = harness
  const before = harness.app.runSnapshot.match
  const option = choiceButton(root, key, id)
  assert.ok(usable(root, option), `${key} ${id} is offered`)
  click(option)
  if (harness.app.runSnapshot.match !== before) {
    if (options.doubleActivate) {
      const after = harness.app.runSnapshot.match
      click(option)
      assert.equal(harness.app.runSnapshot.match, after, 'A repeated activation is ignored')
    }
    return
  }
  assert.ok(choiceButtons(root, targetKey).length > 0, `${key} ${id} opened its target picker`)
  if (!harness.used.has(targetKey)) {
    harness.used.add(targetKey)
    click(byAction(root, 'campaign-back'))
    assert.equal(harness.app.runSnapshot.match, before)
    assert.deepEqual(choiceButtons(root, targetKey), [])
    click(choiceButton(root, key, id))
    assert.equal(harness.app.runSnapshot.match, before)
  }
  commit(harness, choiceButton(root, targetKey, targetInstanceId), options)
}

// Performs, through the UI, the step the domain script took from `match` to `next`.
async function act(harness, match, next, options) {
  const { root } = harness
  const entry = next.journal.length > match.journal.length ? next.journal.at(-1) : null
  switch (match.machineState) {
    case 'awaitingRoute':
      return commit(harness, choiceButton(root, 'routeNode', entry.nodeId), options)
    case 'awaitingRetry':
      return commit(harness, byAction(root, 'campaign-retry'), options)
    case 'awaitingReward':
      return choose(harness, {
        key: 'rewardOffer',
        id: entry.offerId,
        targetKey: 'rewardTarget',
        targetInstanceId: entry.targetInstanceId,
      }, options)
    case 'awaitingShop':
      if (entry.type === 'leaveShop') {
        return commit(harness, byAction(root, 'campaign-leave'), options)
      }
      return choose(harness, {
        key: 'shopItem',
        id: entry.itemId,
        targetKey: 'shopTarget',
        targetInstanceId: entry.targetInstanceId,
      }, options)
    case 'awaitingEvent':
      return choose(harness, {
        key: 'eventOption',
        id: entry.optionId,
        targetKey: 'eventTarget',
        targetInstanceId: entry.targetInstanceId,
      }, options)
    case 'awaitingRest':
      return choose(harness, {
        key: 'restOption',
        id: entry.optionId,
        targetKey: 'restTarget',
        targetInstanceId: entry.targetInstanceId,
      }, options)
    case 'awaitingHoldChoice':
    case 'awaitingInformedHoldChoice': {
      const choice = match.hold !== null && next.hold === null ? 'hold' : 'normal'
      harness.used.add(`${choice} reveal`)
      return commit(harness, byAction(root, `campaign-${choice}`))
    }
    case 'ready':
      // A step that stays ready on the same turn captured a card into Hold.
      if (next.machineState === 'ready' && next.turn === match.turn) {
        await waitFor(() => usable(root, byAction(root, 'hold')), 'Hold management')
        click(byAction(root, 'hold'))
        assert.equal(overlayTitle(root), 'Capture into Hold')
        harness.used.add('capture')
        return commit(harness, choiceButton(root, 'holdTarget', next.hold))
      }
      return commit(harness, byAction(root, 'reveal'))
    default:
      return assert.fail(`No UI step continues from ${match.machineState}`)
  }
}

export function assertUnchanged(harness, match, saves) {
  assert.equal(harness.app.runSnapshot.match, match)
  assert.equal(harness.app.runSnapshot.saveStatus, 'saved')
  assert.equal(harness.repository.saves, saves)
}

// A decision replayed from an earlier boundary, or for a spent option, is refused without
// changing or saving the run.
export function assertRefused(harness, decide, pattern) {
  const match = harness.app.runSnapshot.match
  const saves = harness.repository.saves
  assert.throws(() => decide(harness.runController), pattern)
  assertUnchanged(harness, match, saves)
}

function installFakeDocument(t) {
  const previousDocument = globalThis.document
  globalThis.document = { createElement: (tagName) => new FakeElement(tagName) }
  t.after(() => {
    globalThis.document = previousDocument
  })
}

// Opens the application shell. With a `start` run it resumes that saved run; otherwise it
// starts a new Campaign.
async function open(t, { runId, seed, start = null }) {
  installFakeDocument(t)
  const harness = {
    runId,
    seed,
    repository: createMemoryRepository(start),
    used: new Set(),
    confirmStartOver: null,
  }
  await launch(harness)
  click(byAction(harness.root, start === null ? 'campaign' : 'resume'))
  assert.equal(harness.app.activeScreen, 'game')
  return harness
}

// Resumes a saved Campaign run in the shell and waits until its boundary is actionable.
export async function resumeSavedCampaign(t, { runId, seed, start }) {
  const harness = await open(t, { runId, seed, start })
  await settle(harness)
  return harness
}

// Plays the expedition script through the UI from a new Campaign, or from a saved `start`
// run, reloading at every newly reached boundary before its hook runs. `onEnd` runs on the
// ended Campaign before the app is destroyed.
export async function driveExpedition(t, {
  runId,
  seed,
  plan,
  start = null,
  hooks = {},
  doubleActivate = [],
  onEnd = null,
}) {
  const expected = domainExpedition({ runId, seed, plan, start })
  for (const key of [...Object.keys(hooks), ...doubleActivate]) {
    assert.ok(expected.keys.includes(key), `The expedition reaches ${key}`)
  }
  const harness = await open(t, { runId, seed, start })
  await settle(harness)
  assert.deepEqual(harness.app.runSnapshot.match, expected.states[0])

  const visited = []
  for (let step = 0; ; step += 1) {
    await settle(harness)
    const match = harness.app.runSnapshot.match
    const key = boundaryKey(match)
    const firstVisit = key !== null && !visited.includes(key)
    if (firstVisit) {
      visited.push(key)
      await reload(harness)
      await hooks[key]?.(harness)
      assert.deepEqual(harness.app.runSnapshot.match, match, `${key} hooks keep the boundary`)
    }
    if (match.machineState === 'ended') break

    const current = harness.app.runSnapshot.match
    const next = expected.states[step + 1]
    const saves = harness.repository.saves
    const repeat = firstVisit && doubleActivate.includes(key)
    await act(harness, current, next, { doubleActivate: repeat })
    await settle(harness)
    assert.deepEqual(harness.app.runSnapshot.match, next, `step ${step} from ${key}`)
    if (repeat) assert.equal(harness.repository.saves, saves + 1)
  }

  assert.deepEqual(visited, expected.keys)
  assert.deepEqual(harness.app.runSnapshot.match, expected.final)
  await onEnd?.(harness)
  await harness.app.destroy()
  return { counters: expected.counters, final: expected.final, used: [...harness.used].sort() }
}

import assert from 'node:assert/strict'
import test from 'node:test'
import { bootstrap } from '../../src/app/bootstrap.js'
import { createRunController } from '../../src/app/run-controller.js'
import { createCampaignRun } from '../../src/domain/campaign-machine.js'
import { BASELINE_RULESET } from '../../src/domain/ruleset.js'
import { createRunSave, restoreRunSave } from '../../src/persistence/run-schema.js'
import { createSettingsRepository } from '../../src/persistence/settings-repository.js'
import {
  EXPEDITION_PLANS,
  createExpeditionCounters,
  routeStates,
  stepExpedition,
} from '../fixtures/campaign-route.js'

// Drives complete scripted expeditions through the real application shell. The domain
// expedition script decides every step; the test performs that decision by clicking the
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

function descendants(element) {
  return [element, ...element.children.flatMap(descendants)]
}

function visibleDescendants(element) {
  if (element.hidden) return []
  return [element, ...element.children.flatMap(visibleDescendants)]
}

function byAction(root, action) {
  return descendants(root).find((element) => element.dataset.action === action)
}

function choiceButtons(root, key) {
  return descendants(root).filter((element) => (
    element.tagName === 'BUTTON' && Object.hasOwn(element.dataset, key)
  ))
}

function choiceButton(root, key, id) {
  return choiceButtons(root, key).find((element) => element.dataset[key] === id)
}

function usable(root, element) {
  return (
    element !== undefined
    && !element.disabled
    && visibleDescendants(root).includes(element)
  )
}

function campaignOverlay(root) {
  return descendants(root).find((element) => Object.hasOwn(element.dataset, 'campaignOverlay'))
}

function overlayTitle(root) {
  return descendants(root).find((element) => element.id === 'campaign-overlay-title')
    ?.textContent
}

function overlayDescription(root) {
  return descendants(root).find((element) => (
    Object.hasOwn(element.dataset, 'campaignDescription')
  ))?.textContent
}

function click(element) {
  assert.ok(element, 'The control to activate is rendered')
  element.dispatch('click')
}

async function waitFor(predicate, label) {
  for (let round = 0; round < 2000; round += 1) {
    if (predicate()) return
    await (round < 500
      ? Promise.resolve()
      : new Promise((resolve) => setImmediate(resolve)))
  }
  assert.fail(`${label} did not settle`)
}

function createMemoryRepository() {
  let record = null
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
    confirmStartOver: () => assert.fail('The expedition never replaces a saved run'),
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
async function reload(harness, expected = harness.app.runSnapshot.match) {
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
function boundaryKey(match) {
  if (['awaitingHoldChoice', 'awaitingInformedHoldChoice'].includes(match.machineState)) {
    return null
  }
  return `${match.journal.length}:${match.machineState}`
}

function domainExpedition({ runId, seed, plan }) {
  let run = createCampaignRun({ runId, seed, ruleset: BASELINE_RULESET })
  const counters = createExpeditionCounters()
  const keys = []
  for (let step = 0; run.machineState !== 'ended'; step += 1) {
    assert.ok(step < 5000, 'The domain expedition ends')
    const key = boundaryKey(run)
    if (key !== null && !keys.includes(key)) keys.push(key)
    run = stepExpedition(run, plan, counters)
  }
  keys.push(boundaryKey(run))
  return { final: run, counters, keys }
}

// Activates a control that applies a decision; the controller marks the run synchronously.
function commit(harness, element, { doubleActivate = false } = {}) {
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

function assertUnchanged(harness, match, saves) {
  assert.equal(harness.app.runSnapshot.match, match)
  assert.equal(harness.app.runSnapshot.saveStatus, 'saved')
  assert.equal(harness.repository.saves, saves)
}

// A decision replayed from an earlier boundary, or for a spent option, is refused without
// changing or saving the run.
function assertRefused(harness, decide, pattern) {
  const match = harness.app.runSnapshot.match
  const saves = harness.repository.saves
  assert.throws(() => decide(harness.runController), pattern)
  assertUnchanged(harness, match, saves)
}

async function driveExpedition(t, { runId, seed, plan, hooks = {}, doubleActivate = [] }) {
  const previousDocument = globalThis.document
  globalThis.document = { createElement: (tagName) => new FakeElement(tagName) }
  t.after(() => {
    globalThis.document = previousDocument
  })

  const expected = domainExpedition({ runId, seed, plan })
  for (const key of [...Object.keys(hooks), ...doubleActivate]) {
    assert.ok(expected.keys.includes(key), `The expedition reaches ${key}`)
  }
  const harness = {
    runId,
    seed,
    repository: createMemoryRepository(),
    used: new Set(),
  }
  await launch(harness)
  click(byAction(harness.root, 'campaign'))
  assert.equal(harness.app.activeScreen, 'game')

  const counters = createExpeditionCounters()
  const visited = []
  for (let step = 0; ; step += 1) {
    assert.ok(step < 5000, 'The expedition ends')
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
    const next = stepExpedition(current, plan, counters)
    const saves = harness.repository.saves
    const repeat = firstVisit && doubleActivate.includes(key)
    await act(harness, current, next, { doubleActivate: repeat })
    await settle(harness)
    assert.deepEqual(harness.app.runSnapshot.match, next, `step ${step} from ${key}`)
    if (repeat) assert.equal(harness.repository.saves, saves + 1)
  }

  assert.deepEqual(visited, expected.keys)
  assert.deepEqual(harness.app.runSnapshot.match, expected.final)
  assert.deepEqual(counters, expected.counters)
  await harness.app.destroy()
  return { counters, final: expected.final, used: [...harness.used].sort() }
}

test('a market expedition survives reloads, a lost purchase, and stale decisions', async (t) => {
  const { counters, final, used } = await driveExpedition(t, {
    runId: 'expedition-market',
    seed: 0,
    plan: EXPEDITION_PLANS.market,
    hooks: {
      '0:awaitingRoute'({ root }) {
        assert.equal(overlayTitle(root), 'Route map · Stage 1/5')
        assert.deepEqual(choiceButtons(root, 'routeNode').map(({ dataset }) => dataset.routeNode), ['gate'])
      },
      '1:awaitingRetry'({ app, root }) {
        assert.equal(overlayTitle(root), 'Encounter lost')
        assert.equal(
          overlayDescription(root),
          'Suit Opposition dealt 1 damage. 2 health remains.',
        )
        assert.equal(app.runSnapshot.match.health, 2)
      },
      '2:ready'(harness) {
        assert.deepEqual(harness.app.runSnapshot.match.journal.at(-1), { type: 'retry', nodeId: 'gate' })
        assertRefused(
          harness,
          (controller) => controller.retryEncounter({ nodeId: 'gate', step: 1 }),
          /Campaign is not awaiting an encounter retry/,
        )
      },
      '3:awaitingRoute'(harness) {
        const reward = harness.app.runSnapshot.match.journal.at(-1)
        assertRefused(
          harness,
          (controller) => controller.selectReward({
            nodeId: 'gate',
            step: 2,
            offerId: reward.offerId,
            targetInstanceId: reward.targetInstanceId,
          }),
          /Campaign has no reward draft to select from/,
        )
        assertRefused(
          harness,
          (controller) => controller.chooseRoute({ nodeId: 'market', step: 2 }),
          /Campaign decision step 2 is stale; the journal is at step 3/,
        )
        assertRefused(
          harness,
          (controller) => controller.chooseRoute({ nodeId: 'court', step: 3 }),
          /Route node court is \w+, not available/,
        )
      },
      async '4:awaitingShop'(harness) {
        const boundary = harness.app.runSnapshot.match
        assert.equal(overlayTitle(harness.root), 'Wayside Market')
        harness.repository.failNextSave()
        commit(harness, choiceButton(harness.root, 'shopItem', 'card-1'))
        await waitFor(
          () => (
            overlayTitle(harness.root) === 'Purchase not saved'
            && usable(harness.root, byAction(harness.root, 'campaign-save'))
          ),
          'The failed purchase save',
        )
        assert.equal(harness.app.runSnapshot.saveStatus, 'failed')
        assert.equal(harness.app.runSnapshot.match.journal.length, 5)
        assert.equal(usable(harness.root, byAction(harness.root, 'campaign-main')), true)
        assert.equal(choiceButtons(harness.root, 'shopItem').length, 0)
        // The unsaved purchase is lost on reload; the saved shop is offered again.
        await reload(harness, boundary)
        assert.equal(overlayTitle(harness.root), 'Wayside Market')
      },
      '5:awaitingShop'(harness) {
        const { root } = harness
        const sold = choiceButton(root, 'shopItem', 'card-1')
        assert.equal(sold.disabled, true)
        const match = harness.app.runSnapshot.match
        const saves = harness.repository.saves
        click(sold)
        assertUnchanged(harness, match, saves)
        assertRefused(
          harness,
          (controller) => controller.purchaseShopItem({
            nodeId: 'market',
            step: 4,
            itemId: 'card-1',
            targetInstanceId: null,
          }),
          /Campaign decision step 4 is stale; the journal is at step 5/,
        )
        assertRefused(
          harness,
          (controller) => controller.purchaseShopItem({
            nodeId: 'market',
            step: 5,
            itemId: 'card-1',
            targetInstanceId: null,
          }),
          /Shop item card-1 is unavailable: sold/,
        )
      },
      '10:awaitingRoute'({ app, root }) {
        click(byAction(root, 'campaign-inspect'))
        assert.equal(overlayTitle(root), 'Run details')
        const log = descendants(root).find((element) => element.tagName === 'OL')
        assert.equal(log.children.length, app.runSnapshot.match.journal.length)
        assert.equal(log.children[0].textContent, 'Stage 1: entered Suit Opposition')
        assert.equal(log.children[1].textContent, 'Suit Opposition: retried the encounter')
        click(byAction(root, 'campaign-close'))
        assert.match(overlayTitle(root), /^Route map/)
      },
      '11:ended'({ root }) {
        assert.equal(overlayTitle(root), 'Campaign victory')
        assert.equal(usable(root, byAction(root, 'campaign-restart')), true)
      },
    },
  })
  assert.equal(final.outcome.result, 'victory')
  assert.equal(counters.retries, 1)
  assert.deepEqual(counters.purchases, ['card-1'])
  assert.deepEqual(counters.events, ['surrender-held-card'])
  assert.deepEqual(used, ['capture', 'hold reveal', 'normal reveal', 'rewardTarget'])
})

test('a sold-out bazaar expedition ignores repeated activations and spent stock', async (t) => {
  const { counters, final, used } = await driveExpedition(t, {
    runId: 'expedition-sold-out',
    seed: 1,
    plan: EXPEDITION_PLANS.soldOut,
    doubleActivate: ['0:awaitingRoute', '3:awaitingEvent', '7:awaitingShop'],
    hooks: {
      '3:awaitingEvent'({ root }) {
        assert.equal(overlayTitle(root), 'Crossroads Shrine')
      },
      '11:awaitingShop'(harness) {
        const { root } = harness
        assert.equal(overlayTitle(root), 'Ember Bazaar')
        assert.ok(descendants(root).some((element) => (
          Object.hasOwn(element.dataset, 'shopSoldOut')
          && element.textContent === 'Out of stock. Everything here has been sold.'
        )))
        const items = choiceButtons(root, 'shopItem')
        assert.equal(items.length, 4)
        assert.ok(items.every(({ disabled }) => disabled))
        assert.equal(usable(root, byAction(root, 'campaign-leave')), true)
        assert.equal(harness.app.runSnapshot.match.currency, 0)
        const match = harness.app.runSnapshot.match
        const saves = harness.repository.saves
        click(items.at(-1))
        assertUnchanged(harness, match, saves)
        assertRefused(
          harness,
          (controller) => controller.purchaseShopItem({
            nodeId: 'bazaar',
            step: 10,
            itemId: 'modifier-1',
            targetInstanceId: null,
          }),
          /Campaign decision step 10 is stale; the journal is at step 11/,
        )
        assertRefused(
          harness,
          (controller) => controller.purchaseShopItem({
            nodeId: 'bazaar',
            step: 11,
            itemId: 'modifier-1',
            targetInstanceId: null,
          }),
          /Shop item modifier-1 is unavailable: sold/,
        )
      },
      '13:ended'({ root }) {
        assert.equal(overlayTitle(root), 'Campaign victory')
      },
    },
  })
  assert.equal(final.outcome.result, 'victory')
  assert.equal(counters.retries, 0)
  assert.deepEqual(counters.purchases, ['card-1', 'card-2', 'service-1', 'modifier-1'])
  assert.deepEqual(counters.events, ['bleed-for-fortune'])
  assert.deepEqual(used, ['capture', 'normal reveal', 'rewardTarget', 'shopTarget'])
})

test('a defeated expedition stays resumable as a completed Campaign', async (t) => {
  const { counters, final, used } = await driveExpedition(t, {
    runId: 'expedition-defeat',
    seed: 3,
    plan: ['gate', 'shrine', 'watch', 'vault', 'finale'],
    hooks: {
      async '9:ended'({ app, root }) {
        assert.equal(overlayTitle(root), 'Campaign defeat')
        assert.equal(
          overlayDescription(root),
          'Your health was depleted. Start a new campaign to try again.',
        )
        const match = app.runSnapshot.match
        assert.equal(match.health, 0)
        assert.deepEqual(routeStates(match), {
          gate: 'completed',
          market: 'bypassed',
          shrine: 'completed',
          court: 'bypassed',
          watch: 'completed',
          bazaar: 'bypassed',
          vault: 'completed',
          finale: 'active',
        })
        click(byAction(root, 'campaign-main'))
        await waitFor(() => app.activeScreen === 'main', 'The main menu')
        assert.equal(app.resumeAvailable, true)
      },
    },
  })
  assert.deepEqual(final.outcome, { result: 'defeat', reason: 'healthDepleted' })
  assert.equal(counters.retries, 0)
  assert.deepEqual(counters.purchases, [])
  assert.deepEqual(counters.events, ['bleed-for-fortune', 'surrender-held-card'])
  assert.deepEqual(used, ['capture', 'normal reveal', 'rewardTarget'])
})

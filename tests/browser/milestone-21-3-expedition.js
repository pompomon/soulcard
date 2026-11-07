import { bootstrap } from '../../src/app/bootstrap.js'
import { createRunController } from '../../src/app/run-controller.js'
import { createRunSave, restoreRunSave } from '../../src/persistence/run-schema.js'
import { createSettingsRepository } from '../../src/persistence/settings-repository.js'

const output = document.querySelector('#expedition-browser-results')
const consoleErrors = []
const originalConsoleError = console.error.bind(console)
const SOLD_OUT_TEXT = 'Out of stock. Everything here has been sold.'
const MARKET_ITEMS = Object.freeze([
  ['card-1', true, 'New card: 8S · 3 coins'],
  ['service-1', true, 'Replace a card with 5C · 2 coins'],
  ['modifier-1', false, 'Modifier: Vow of Constancy · 4 coins'],
])
const SHRINE_OPTIONS = Object.freeze([
  ['bleed-for-fortune', true, 'Bleed for fortune', 'Lose 1 health → gain 5 coins.'],
  ['burn-an-offering', true, 'Burn an offering', 'Remove a chosen card → restore 2 health.'],
  ['walk-on', true, 'Walk on', 'Leave without changing anything.'],
])
const MARKET_LOG = Object.freeze([
  'Stage 1: entered Suit Opposition',
  'Suit Opposition: gained Hold Insight and collected 3 coins',
  'Stage 2: entered Wayside Market',
  'Wayside Market: replaced 2H with 5C for 2 coins',
  'Wayside Market: left the shop',
])

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

function sameJson(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected)
}

function headingText() {
  return document.querySelector('#campaign-overlay-title')?.textContent ?? null
}

function descriptionText() {
  return query('#app [data-campaign-description]', 'Campaign overlay description').textContent
}

function metricText(key) {
  return query(`#app [data-value="${key}"]`, `${key} metric`).textContent
}

function visibleOverlayButtons() {
  return queryAll('#app [data-campaign-overlay] button').filter(isShown)
}

function visibleOverlayButtonLabels() {
  return visibleOverlayButtons().map((button) => button.textContent.trim())
}

let controlsChecked = 0

// Every visible overlay control must stay inside the viewport with a 44px target.
function checkVisibleControls(context) {
  for (const button of visibleOverlayButtons()) {
    const name = `${context}: ${button.textContent.trim()}`
    const rect = button.getBoundingClientRect()
    assert(
      rect.left >= 0 && rect.right <= globalThis.innerWidth + 0.5,
      `${name} must fit the viewport width`,
    )
    assert(rect.width >= 44 && rect.height >= 44, `${name} must keep a 44px target`)
    controlsChecked += 1
  }
}

function dialogSemantics() {
  const overlay = query('#app [data-campaign-overlay]', 'Campaign overlay')
  const labelId = overlay.getAttribute('aria-labelledby')
  return Object.freeze({
    role: overlay.getAttribute('role'),
    modal: overlay.getAttribute('aria-modal'),
    label: labelId === null ? null : document.getElementById(labelId)?.textContent ?? null,
  })
}

// Route nodes, shop items, and event options: available entries are buttons that
// reference their detail; unavailable entries stay readable as text.
function choiceRows(selector, dataKey) {
  return queryAll(selector).map((element) => {
    const detail = element.parentElement.querySelector('.campaign-offer__detail')
    assert(detail !== null, `${element.textContent.trim()} must explain itself`)
    const button = element.tagName === 'BUTTON'
    if (button) {
      assertButton(element)
      assert(
        element.getAttribute('aria-describedby') === detail.id,
        `${element.textContent.trim()} must reference its detail`,
      )
    }
    return Object.freeze({
      id: element.dataset[dataKey],
      button,
      enabled: button && element.disabled === false,
      title: element.textContent.trim(),
      detail: detail.textContent.trim(),
    })
  })
}

function availableNodeIds(rows) {
  return rows.filter(({ button }) => button).map(({ id }) => id)
}

function detailSectionLines(title) {
  const section = queryAll('#app [data-campaign-details] section')
    .find((candidate) => candidate.querySelector('h3')?.textContent.trim() === title)
  assert(section !== undefined, `${title} section must be shown`)
  return [...section.querySelectorAll('li')].map((line) => line.textContent.trim())
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

// A saved boundary: the overlay shows `heading` and no save is pending.
async function waitForBoundary(app, heading, name) {
  await waitFor(
    () => {
      const overlay = document.querySelector('#app [data-campaign-overlay]')
      return (
        overlay !== null
        && overlay.hidden === false
        && headingText() === heading
        && app.runSnapshot.saveStatus === 'saved'
      )
    },
    name,
  )
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

// Saves are serialized with the real save schema, so a remount restores exactly what
// was written, like a page reload.
const storage = {
  record: null,
  saves: [],
  holdNextSave: false,
  failNextSave: false,
  heldSave: null,
}

function createMemoryRepository() {
  return {
    load: async () => {
      const record = JSON.parse(storage.record)
      return Object.freeze({
        status: 'resumable',
        savedAt: record.savedAt,
        match: restoreRunSave(record),
      })
    },
    save: async (run) => {
      storage.saves.push(`${run.journal.length}:${run.machineState}`)
      if (storage.failNextSave) {
        storage.failNextSave = false
        return Object.freeze({
          status: 'storage-unavailable',
          operation: 'save',
          reason: 'storage-error',
        })
      }
      if (storage.holdNextSave) {
        storage.holdNextSave = false
        storage.heldSave = deferred()
        await storage.heldSave.promise
      }
      const savedAt = new Date(Date.UTC(2026, 10, 6, 9, 0, storage.saves.length)).toISOString()
      storage.record = JSON.stringify(createRunSave(run, { savedAt }))
      return Object.freeze({ status: 'saved', savedAt })
    },
    discard: async () => {
      storage.record = null
      return Object.freeze({ status: 'discarded' })
    },
  }
}

async function loadFixture(name) {
  const response = await fetch(new URL(`../fixtures/${name}`, import.meta.url))
  if (!response.ok) throw new Error(`${name} could not be loaded`)
  return response.text()
}

async function mountApp(record, name) {
  storage.record = record
  const settingsRepository = createSettingsRepository({ storage: null })
  settingsRepository.setReducedMotionOverride(false)
  const app = bootstrap({
    root: document.querySelector('#app'),
    runController: createRunController({ repository: createMemoryRepository() }),
    settingsRepository,
    matchMedia: null,
    pageLifecycleFactory: () => ({ destroy() {} }),
    updateController: createUpdateController(),
    updateNoticeFactory: () => ({ teardown() {} }),
    confirmStartOver: () => true,
  })
  await app.ready
  const resume = query('#app [data-action="resume"]', `${name} Resume action`)
  assertButton(resume, 'Resume Game')
  await waitFor(() => resume.disabled === false, `enabled Resume for ${name}`)
  resume.click()
  await waitFor(() => app.activeScreen === 'game', `${name} Game screen`)
  assert(document.querySelectorAll('#app canvas').length === 1, `${name} must keep one canvas`)
  return app
}

async function remount(app, record, name) {
  await app.destroy()
  assert(document.querySelectorAll('#app canvas').length === 0, 'Teardown must release the canvas')
  return mountApp(record, name)
}

async function openTargets(selector, targetSelector, name) {
  query(selector, name).click()
  await waitFor(() => queryAll(targetSelector).length > 0, `${name} target list`)
  const targets = queryAll(targetSelector)
  targets.forEach((target) => assertButton(target))
  return targets
}

async function run() {
  const fixtures = {
    route: await loadFixture('campaign-save-route-v7.json'),
    event: await loadFixture('campaign-save-event-v7.json'),
    exhausted: await loadFixture('campaign-save-shop-exhausted-v7.json'),
  }

  // Route map: only available nodes are buttons, and closed nodes say why.
  let app = await mountApp(fixtures.route, 'route map')
  await waitForBoundary(app, 'Route map · Stage 2/7', 'restored route map')
  const dialog = dialogSemantics()
  assert(dialog.role === 'dialog' && dialog.modal === 'true', 'Route map must be a modal dialog')
  assert(dialog.label === 'Route map · Stage 2/7', 'Route map must be labelled by its heading')
  const stage2Nodes = choiceRows('#app [data-route-node]', 'routeNode')
  const nodeStates = new Map(app.runSnapshot.match.route.nodes.map(({ id, state }) => [id, state]))
  assert(stage2Nodes.length === nodeStates.size, 'Route map must list every node')
  for (const node of stage2Nodes) {
    assert(
      node.button === (nodeStates.get(node.id) === 'available'),
      `${node.title} must be a button only while available`,
    )
  }
  assert(
    sameJson(availableNodeIds(stage2Nodes), ['market', 'shrine']),
    'The won start fight must open both stage-2 paths',
  )
  // Elite and boss details add a sentence after the node state.
  assert(
    stage2Nodes.filter(({ button }) => !button).every(({ detail }) => (
      / · (Completed|Locked)(\.|$)/.test(detail)
    )),
    'Closed nodes must state why they cannot be chosen',
  )
  assert(metricText('campaign-route') === '2/7', 'Route metric must show stage 2')
  checkVisibleControls('Route map')
  const routeButtons = visibleOverlayButtonLabels()
  const market = query('#app button[data-route-node="market"]', 'Wayside Market route')
  await waitFor(() => market.disabled === false, 'enabled market route')
  const saveStatusWhenRouteEnabled = app.runSnapshot.saveStatus
  assert(saveStatusWhenRouteEnabled === 'saved', 'Routes must be chosen only from a saved map')
  market.click()

  // Shop: prices, blockers, and a target list that Back leaves unbought.
  await waitForBoundary(app, 'Wayside Market', 'saved Wayside Market')
  const shopDescription = descriptionText()
  assert(shopDescription.endsWith('You have 3 coins.'), 'The shop must state the coins on hand')
  const shopItems = choiceRows('#app [data-shop-item]', 'shopItem')
  assert(
    sameJson(shopItems.map(({ id, enabled, title }) => [id, enabled, title]), MARKET_ITEMS),
    'Wayside Market must price every item',
  )
  assert(
    shopItems[2].detail.endsWith('Not enough coins.'),
    'An unaffordable item must state its blocker',
  )
  assert(document.querySelector('#app [data-shop-sold-out]') === null, 'Stock remains')
  checkVisibleControls('Wayside Market')
  const shopButtons = visibleOverlayButtonLabels()

  const serviceSelector = '#app button[data-shop-item="service-1"]'
  const firstTargets = await openTargets(serviceSelector, '#app [data-shop-target]', 'service')
  const shopTarget = Object.freeze({
    heading: headingText(),
    description: descriptionText(),
    targetCount: firstTargets.length,
  })
  assert(
    shopTarget.heading === 'Choose a card to replace with 5C',
    'The target list must name the replacement card',
  )
  assert(shopTarget.description.endsWith('It costs 2 coins.'), 'Targets must restate the price')
  checkVisibleControls('Shop target list')
  const back = query('#app [data-action="campaign-back"]', 'Back action')
  assertButton(back, 'Back')
  back.click()
  await waitFor(
    () => headingText() === 'Wayside Market' && queryAll('#app [data-shop-item]').length === 3,
    'shop after Back',
  )
  assert(
    app.runSnapshot.match.currency === 3 && app.runSnapshot.match.journal.length === 3,
    'Back must not buy the item',
  )

  const [target] = await openTargets(serviceSelector, '#app [data-shop-target]', 'service')
  const chosenShopTarget = target.textContent.trim()
  storage.holdNextSave = true
  target.click()
  await waitFor(() => storage.heldSave !== null, 'purchase save start')
  await new Promise((resolve) => setTimeout(resolve, 250))
  const purchaseWhileSaving = Object.freeze({
    heading: headingText(),
    buttons: visibleOverlayButtonLabels(),
    route: metricText('campaign-route'),
    saveStatus: app.runSnapshot.saveStatus,
  })
  assert(purchaseWhileSaving.heading === 'Saving purchase', 'The purchase save must be announced')
  assert(purchaseWhileSaving.buttons.length === 0, 'No decision may be offered while saving')
  assert(purchaseWhileSaving.saveStatus === 'saving', 'The purchase save must still be pending')
  storage.heldSave.resolve()
  storage.heldSave = null
  await waitFor(
    () => (
      headingText() === 'Wayside Market'
      && app.runSnapshot.saveStatus === 'saved'
      && descriptionText().endsWith('You have 1 coin.')
    ),
    'saved purchase',
  )
  const purchasedItems = choiceRows('#app [data-shop-item]', 'shopItem')
  assert(purchasedItems.every(({ enabled }) => !enabled), 'Every item must be blocked now')
  assert(purchasedItems[1].detail.endsWith('Sold.'), 'The bought item must be marked sold')
  assert(purchasedItems[0].detail.endsWith('Not enough coins.'), 'The add must be unaffordable')

  // Reload at the shop boundary: the purchase is restored, never applied twice.
  app = await remount(app, storage.record, 'saved shop')
  await waitForBoundary(app, 'Wayside Market', 'resumed Wayside Market')
  const resumedShop = Object.freeze({
    description: descriptionText(),
    items: choiceRows('#app [data-shop-item]', 'shopItem'),
    currency: app.runSnapshot.match.currency,
    journalLength: app.runSnapshot.match.journal.length,
  })
  assert(sameJson(resumedShop.items, purchasedItems), 'Resume must restore the shop exactly')
  assert(
    resumedShop.currency === 1 && resumedShop.journalLength === 4,
    'Resume must not apply the purchase twice',
  )

  // Leave: a failed save keeps the map hidden until Retry save succeeds.
  const leave = query('#app [data-action="campaign-leave"]', 'Leave shop action')
  assertButton(leave, 'Leave shop')
  assert(isShown(leave) && leave.disabled === false, 'Leave must be enabled in a saved shop')
  storage.failNextSave = true
  leave.click()
  await waitFor(() => headingText() === 'Shop exit not saved', 'failed shop exit save')
  const leaveFailure = Object.freeze({
    heading: headingText(),
    buttons: visibleOverlayButtonLabels(),
    route: metricText('campaign-route'),
    saveStatus: app.runSnapshot.saveStatus,
  })
  assert(
    sameJson(leaveFailure.buttons, ['Retry save', 'Main Menu']),
    'A failed exit save must offer only Retry save and Main Menu',
  )
  assert(leaveFailure.route === '2/7', 'The next stage must stay hidden until the exit saves')
  assert(document.querySelector('#app [data-route-node]') === null, 'The map must stay hidden')
  checkVisibleControls('Failed shop exit save')
  const retrySave = query('#app [data-action="campaign-save"]', 'Retry save action')
  assertButton(retrySave, 'Retry save')
  retrySave.click()
  await waitForBoundary(app, 'Route map · Stage 3/7', 'saved stage-3 route map')

  // Reload at the route boundary, then review the log in Run details.
  app = await remount(app, storage.record, 'saved route map')
  await waitForBoundary(app, 'Route map · Stage 3/7', 'resumed stage-3 route map')
  const stage3Nodes = choiceRows('#app [data-route-node]', 'routeNode')
  assert(
    sameJson(availableNodeIds(stage3Nodes), ['court', 'high-court']),
    'The market must open both stage-3 fights',
  )
  assert(metricText('campaign-route') === '3/7', 'Route metric must show stage 3')
  const inspect = query('#app [data-action="campaign-inspect"]', 'Run details action')
  assertButton(inspect, 'Run details')
  inspect.click()
  await waitFor(() => headingText() === 'Run details', 'Run details')
  const inspection = Object.freeze({
    summary: descriptionText(),
    route: detailSectionLines('Route'),
    log: detailSectionLines('Expedition log'),
  })
  assert(sameJson(inspection.log, MARKET_LOG), 'Run details must log every decision in order')
  checkVisibleControls('Run details')
  const close = query('#app [data-action="campaign-close"]', 'Close action')
  assertButton(close, 'Close')
  close.click()
  await waitForBoundary(app, 'Route map · Stage 3/7', 'route map after Run details')

  // Event: an option with a target, through the list and Back.
  app = await remount(app, fixtures.event, 'event')
  await waitForBoundary(app, 'Crossroads Shrine', 'resumed Crossroads Shrine')
  const eventOptions = choiceRows('#app [data-event-option]', 'eventOption')
  assert(
    sameJson(
      eventOptions.map(({ id, enabled, title, detail }) => [id, enabled, title, detail]),
      SHRINE_OPTIONS,
    ),
    'Crossroads Shrine must state every cost and gain',
  )
  checkVisibleControls('Crossroads Shrine')
  const offeringSelector = '#app button[data-event-option="burn-an-offering"]'
  const eventTargets = await openTargets(offeringSelector, '#app [data-event-target]', 'offering')
  const eventTargetHeading = headingText()
  assert(eventTargetHeading === 'Choose a card to remove', 'The offering must ask for a card')
  query('#app [data-action="campaign-back"]', 'Back action').click()
  await waitFor(
    () => (
      headingText() === 'Crossroads Shrine'
      && queryAll('#app [data-event-option]').length === SHRINE_OPTIONS.length
    ),
    'event after Back',
  )
  assert(app.runSnapshot.match.machineState === 'awaitingEvent', 'Back must not choose')
  const [offering] = await openTargets(offeringSelector, '#app [data-event-target]', 'offering')
  const offeredInstanceId = offering.dataset.eventTarget
  const chosenEventTarget = offering.textContent.trim()
  offering.click()
  await waitForBoundary(app, 'Route map · Stage 3/7', 'route map after the event')
  const eventEntry = app.runSnapshot.match.journal.at(-1)
  assert(
    eventEntry.type === 'event'
      && eventEntry.optionId === 'burn-an-offering'
      && eventEntry.targetInstanceId === offeredInstanceId,
    'The event must record the chosen option and card',
  )
  const healthAfterEvent = metricText('campaign-health')
  assert(healthAfterEvent === '5/5', 'Burn an offering must restore 2 health')

  // Exhausted shop: everything is sold, yet Leave still works.
  app = await remount(app, fixtures.exhausted, 'exhausted shop')
  await waitForBoundary(app, 'Ember Bazaar', 'resumed Ember Bazaar')
  const soldOut = query('#app [data-shop-sold-out]', 'sold-out line')
  assert(soldOut.textContent === SOLD_OUT_TEXT, 'A sold-out shop must say so')
  const exhaustedItems = choiceRows('#app [data-shop-item]', 'shopItem')
  assert(
    exhaustedItems.length === 4
      && exhaustedItems.every(({ button, enabled, detail }) => (
        button && !enabled && detail.endsWith('Sold.')
      )),
    'Every sold item must stay listed and disabled',
  )
  const exhaustedLeave = query('#app [data-action="campaign-leave"]', 'Leave shop action')
  assert(
    isShown(exhaustedLeave) && exhaustedLeave.disabled === false,
    'Leave must stay enabled in a sold-out shop',
  )
  checkVisibleControls('Ember Bazaar')
  const exhaustedButtons = visibleOverlayButtonLabels()
  exhaustedLeave.click()
  await waitForBoundary(app, 'Route map · Stage 5/7', 'route map after the sold-out shop')
  const finalNodes = availableNodeIds(choiceRows('#app [data-route-node]', 'routeNode'))
  assert(
    sameJson(finalNodes, ['watch', 'night-watch']),
    'Leaving the bazaar must open both stage-5 fights',
  )
  assert(document.querySelectorAll('#app canvas').length === 1, 'Campaign must retain one canvas')
  assert(consoleErrors.length === 0, 'Expedition check reported a relevant console error')

  const report = Object.freeze({
    reportVersion: 1,
    viewport: {
      width: globalThis.innerWidth,
      height: globalThis.innerHeight,
      layoutMode: query('#app .screen--game', 'Game screen').dataset.layoutMode,
    },
    canvasCount: document.querySelectorAll('#app canvas').length,
    dialog,
    controlsChecked,
    routeMap: {
      nodes: stage2Nodes.map(({ id, button, detail }) => (
        `${id}: ${button ? 'button' : 'text'} · ${detail}`
      )),
      buttons: routeButtons,
      saveStatusWhenEnabled: saveStatusWhenRouteEnabled,
    },
    shop: {
      description: shopDescription,
      items: shopItems.map(({ title, detail }) => `${title} — ${detail}`),
      buttons: shopButtons,
      target: { ...shopTarget, chosen: chosenShopTarget },
      whileSaving: purchaseWhileSaving,
      afterPurchase: purchasedItems.map(({ title, detail }) => `${title} — ${detail}`),
    },
    resumedShop: {
      description: resumedShop.description,
      currency: resumedShop.currency,
      journalLength: resumedShop.journalLength,
    },
    leaveSaveFailure: leaveFailure,
    resumedRoute: {
      available: availableNodeIds(stage3Nodes),
      inspection,
    },
    event: {
      options: eventOptions.map(({ title, detail }) => `${title} — ${detail}`),
      targetHeading: eventTargetHeading,
      targetCount: eventTargets.length,
      chosen: chosenEventTarget,
      healthAfter: healthAfterEvent,
    },
    exhaustedShop: {
      soldOut: soldOut.textContent,
      items: exhaustedItems.map(({ title, detail }) => `${title} — ${detail}`),
      buttons: exhaustedButtons,
      availableAfterLeave: finalNodes,
    },
    saves: storage.saves,
    consoleErrors,
  })
  globalThis.__SOULCARD_MILESTONE_21_3_REPORT__ = report
  output.dataset.status = 'complete'
  output.textContent = JSON.stringify(report, null, 2)
  console.info(`SOULCARD_MILESTONE_21_3 ${JSON.stringify(report)}`)
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

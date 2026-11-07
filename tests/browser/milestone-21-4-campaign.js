import { bootstrap } from '../../src/app/bootstrap.js'
import { createRunController } from '../../src/app/run-controller.js'
import { CAMPAIGN_HOLD_DECISION_STATES } from '../../src/domain/campaign-machine.js'
import { createRunSave, restoreRunSave } from '../../src/persistence/run-schema.js'
import { createSettingsRepository } from '../../src/persistence/settings-repository.js'

const output = document.querySelector('#campaign-ladder-browser-results')
const consoleErrors = []
const originalConsoleError = console.error.bind(console)
const COURT_ETIQUETTE = 'Court Etiquette: Opponent trait. In this encounter, an empty Hold can capture only a 2–10, and an occupied Hold can be replaced only by a 2–10.'
const PLUNDER = 'Plunder: Opponent trait. Clashes this opponent wins send your cards to its won pile instead of burning them. They return to your deck after the encounter. Spoils of War has no effect against it.'
const ELITE_REWARD = 'Elite reward: a high card or Greater Mend.'
const BOSS_FIGHT = 'Boss fight · Sovereign archetype · 2 damage on a loss'
// The stage-3 map of the elite-choice save labels every node kind on the expedition.
const STAGE_3_NODES = Object.freeze([
  ['gate', false, 'Stage 1 · Suit Opposition', 'Fight · Suit Legion archetype · 1 damage on a loss · 3-coin bounty · Completed'],
  ['market', false, 'Stage 2 · Wayside Market', 'Shop · Bypassed'],
  ['shrine', false, 'Stage 2 · Crossroads Shrine', 'Event · Completed'],
  ['court', true, 'Stage 3 · Royal Court', 'Fight · Court archetype · 1 damage on a loss · 4-coin bounty · Available'],
  [
    'high-court',
    true,
    'Stage 3 · High Court',
    `Elite fight · Court archetype · 2 damage on a loss · 6-coin bounty · Available. ${ELITE_REWARD} ${COURT_ETIQUETTE}`,
  ],
  ['bazaar', false, 'Stage 4 · Ember Bazaar', 'Shop · Locked'],
  ['vault', false, "Stage 4 · Oathkeeper's Vault", 'Event · Locked'],
  ['camp', false, 'Stage 4 · Roadside Camp', 'Rest · Locked'],
  ['watch', false, 'Stage 5 · Watch of Tens', 'Fight · Watch archetype · 1 damage on a loss · Locked'],
  [
    'night-watch',
    false,
    'Stage 5 · Night Watch',
    `Elite fight · Watch archetype · 2 damage on a loss · Locked. ${ELITE_REWARD} ${PLUNDER}`,
  ],
  ['sanctum', false, 'Stage 6 · Last Light Sanctum', 'Rest · Locked'],
  ['finale', false, 'Stage 7 · Ace Sovereign', `${BOSS_FIGHT} · Locked. Defeat to complete the expedition.`],
])
const ELITE_OFFERS = Object.freeze([
  ['new-card', true, 'New card: AS', 'Add AS to your deck.'],
  ['deck-edit', true, 'Duplicate a card', 'Choose a card in your deck to copy.'],
  [
    'modifier',
    true,
    'Modifier: Vow of Constancy',
    'Restore 2 health. An occupied Hold can be replaced only by a card that does not lose to the held card (2 still beats A).',
  ],
  ['mend', true, 'Greater Mend', 'Restore 2 health (now 2/5) and keep your deck unchanged.'],
])
// No authored route reaches the 20–40 card deck limits, so every rest option stays open;
// the HUD unit tests cover the blocked options.
const CAMP_OPTIONS = Object.freeze([
  ['rest', true, 'Rest by the fire', 'Restore 2 health (now 2/5).'],
  ['train', true, 'Train a card', 'Choose a card in your deck to copy.'],
  ['walk-on', true, 'Walk on', 'Leave without changing anything.'],
])
const SANCTUM_OPTIONS = Object.freeze([
  ['rest', true, 'Rest in the sanctum', 'Your health is full. Resting here restores nothing.'],
  ['cleanse', true, 'Cleanse a card', 'Choose a card to remove from your deck.'],
  ['walk-on', true, 'Walk on', 'Leave without changing anything.'],
])
const TARGET_DESCRIPTION = 'Choose one card from your campaign deck. The held card cannot be chosen.'
const LADDER_LOG = Object.freeze([
  'Stage 1: entered Suit Opposition',
  'Suit Opposition: duplicated 2H and collected 3 coins',
  'Stage 2: entered Crossroads Shrine',
  'Crossroads Shrine: Bleed for fortune',
  'Stage 3: entered High Court',
  'High Court: added AS and collected 6 coins',
  'Stage 4: entered Roadside Camp',
  'Roadside Camp: rested and restored 2 health',
  'Stage 5: entered Watch of Tens',
  'Watch of Tens: chose Mend',
  'Stage 6: entered Last Light Sanctum',
  'Last Light Sanctum: walked on',
])
const VICTORY_ROUTE = 'Route: Suit Opposition → Crossroads Shrine → High Court → Roadside Camp → Night Watch → Last Light Sanctum → Ace Sovereign. Coins 14 · Deck 27 cards.'

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

function overlayOpen() {
  const overlay = document.querySelector('#app [data-campaign-overlay]')
  return overlay !== null && overlay.hidden === false
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

// Route nodes, reward offers, and rest options: available entries are buttons that
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

function nodeTuples(rows) {
  return rows.map(({ id, button, title, detail }) => [id, button, title, detail])
}

function optionTuples(rows) {
  return rows.map(({ id, enabled, title, detail }) => [id, enabled, title, detail])
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
    () => overlayOpen() && headingText() === heading && app.runSnapshot.saveStatus === 'saved',
    name,
  )
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
  failNextSave: false,
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

async function mountApp(record, name, { reducedMotion = false } = {}) {
  storage.record = record
  const settingsRepository = createSettingsRepository({ storage: null })
  settingsRepository.setReducedMotionOverride(reducedMotion)
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

async function remount(app, record, name, options) {
  await app.destroy()
  assert(document.querySelectorAll('#app canvas').length === 0, 'Teardown must release the canvas')
  return mountApp(record, name, options)
}

async function openTargets(selector, targetSelector, name) {
  query(selector, name).click()
  await waitFor(() => queryAll(targetSelector).length > 0, `${name} target list`)
  const targets = queryAll(targetSelector)
  targets.forEach((target) => assertButton(target))
  return targets
}

async function goBack(heading, rowSelector, rowCount, name) {
  const back = query('#app [data-action="campaign-back"]', 'Back action')
  assertButton(back, 'Back')
  back.click()
  await waitFor(
    () => headingText() === heading && queryAll(rowSelector).length === rowCount,
    name,
  )
}

// Clicks `button` and waits until the decision it starts is saved.
async function commit(app, button, name) {
  const saves = storage.saves.length
  button.click()
  await waitFor(
    () => storage.saves.length > saves && app.runSnapshot.saveStatus === 'saved',
    name,
  )
}

async function chooseRoute(app, nodeId, name) {
  const node = query(`#app button[data-route-node="${nodeId}"]`, `${name} route`)
  await waitFor(() => node.disabled === false, `enabled ${name} route`)
  node.click()
}

// Plays reveals through the HUD, taking the normal card at every saved Hold choice, until
// `clashes` choices are made with the next reveal ready, or until `until()` holds.
async function playFight(app, name, { clashes = Infinity, until = () => false } = {}) {
  const reveal = query('#app [data-action="reveal"]', 'Reveal action')
  const normal = query('#app [data-action="campaign-normal"]', 'Normal reveal choice')
  const saved = () => app.runSnapshot.saveStatus === 'saved'
  const revealReady = () => (
    saved()
    && app.runSnapshot.match.machineState === 'ready'
    && !overlayOpen()
    && reveal.disabled === false
  )
  const choiceReady = () => (
    saved()
    && CAMPAIGN_HOLD_DECISION_STATES.includes(app.runSnapshot.match.machineState)
    && headingText() === 'Choose your reveal'
    && isShown(normal)
    && normal.disabled === false
  )
  let chosen = 0
  const done = () => until() || (chosen === clashes && revealReady())
  for (let step = 0; ; step += 1) {
    assert(step < 400, `${name} must reach its end`)
    await waitFor(() => done() || choiceReady() || revealReady(), `${name} step ${step}`)
    if (done()) return chosen
    if (choiceReady()) {
      await commit(app, normal, `${name} normal reveal ${chosen + 1}`)
      chosen += 1
    } else {
      await commit(app, reveal, `${name} reveal ${step}`)
    }
  }
}

async function run() {
  const fixtures = {
    eliteChoice: await loadFixture('campaign-save-elite-choice-v7.json'),
    eliteReward: await loadFixture('campaign-save-elite-reward-v7.json'),
    rest: await loadFixture('campaign-save-rest-v7.json'),
    victory: await loadFixture('campaign-save-victory-v7.json'),
  }

  // Route map: elite, rest, and boss nodes state their kind, archetype, traits, and reward.
  let app = await mountApp(fixtures.eliteChoice, 'elite choice')
  await waitForBoundary(app, 'Route map · Stage 3/7', 'restored stage-3 route map')
  const dialog = dialogSemantics()
  assert(dialog.role === 'dialog' && dialog.modal === 'true', 'Route map must be a modal dialog')
  assert(dialog.label === 'Route map · Stage 3/7', 'Route map must be labelled by its heading')
  const stage3Nodes = choiceRows('#app [data-route-node]', 'routeNode')
  assert(
    sameJson(nodeTuples(stage3Nodes), STAGE_3_NODES),
    'The stage-3 map must label every elite, rest, and boss node',
  )
  checkVisibleControls('Stage-3 route map')
  const routeButtons = visibleOverlayButtonLabels()
  await chooseRoute(app, 'high-court', 'High Court')

  // Court Etiquette: the HUD lists the trait in Run details and narrows Hold capture.
  const courtClashes = await playFight(app, 'High Court', { clashes: 2 })
  let match = app.runSnapshot.match
  const instances = new Map(match.cards.map((card) => [card.instanceId, card]))
  const wonCards = match.encounter.zones.player.wonPile.map((id) => instances.get(id))
  const excludedHighCards = wonCards
    .filter(({ campaignOwner, cardId }) => campaignOwner === 'player' && /^c-[JQKA]/.test(cardId))
    .map(({ cardId }) => cardId)
  assert(excludedHighCards.length > 0, 'The won pile must hold a player-owned high card')
  const inspect = query('#app [data-action="inspect"]', 'Run details action')
  assertButton(inspect, 'Run details')
  inspect.click()
  await waitFor(() => headingText() === 'Run details', 'High Court Run details')
  const courtInspection = Object.freeze({
    summary: descriptionText(),
    current: detailSectionLines('Route').filter((line) => line.endsWith(': Current')),
    traits: detailSectionLines('Opponent traits'),
  })
  assert(
    sameJson(courtInspection.current, ['Stage 3 · High Court (Elite fight): Current']),
    'Run details must name the current elite fight',
  )
  assert(sameJson(courtInspection.traits, [COURT_ETIQUETTE]), 'Run details must explain the trait')
  checkVisibleControls('High Court Run details')
  query('#app [data-action="campaign-close"]', 'Close action').click()
  await waitFor(() => !overlayOpen(), 'closed High Court Run details')

  const hold = query('#app [data-action="hold"]', 'Hold action')
  assertButton(hold, 'Hold')
  await waitFor(() => hold.disabled === false, 'enabled Hold action')
  hold.click()
  await waitFor(() => headingText() === 'Capture into Hold', 'Hold capture')
  const holdCapture = Object.freeze({
    heading: headingText(),
    description: descriptionText(),
    targets: queryAll('#app [data-hold-target]').map((target) => target.textContent.trim()),
    notes: detailSectionLines('Opponent traits'),
    excludedHighCards,
  })
  assert(
    holdCapture.description === 'No player-owned card in your draw or won pile is eligible.'
      && holdCapture.targets.length === 0,
    'Court Etiquette must keep the high card out of Hold',
  )
  assert(
    sameJson(holdCapture.notes, ['Court Etiquette: Hold can capture only a 2–10']),
    'Hold capture must explain the trait',
  )
  checkVisibleControls('Hold capture')
  const cancel = query('#app [data-action="campaign-cancel"]', 'Cancel action')
  assertButton(cancel, 'Cancel')
  cancel.click()
  await waitFor(() => !overlayOpen(), 'cancelled Hold capture')
  assert(app.runSnapshot.match.hold === null, 'Cancel must leave Hold empty')

  // Elite reward: Greater Mend restores 2 health instead of the normal 1.
  app = await remount(app, fixtures.eliteReward, 'elite reward')
  await waitForBoundary(app, 'Encounter won', 'resumed High Court reward')
  const eliteDescription = descriptionText()
  assert(
    eliteDescription === 'Choose one reward before returning to the map. The High Court bounty pays 6 coins when you choose.',
    'The elite draft must state its bounty',
  )
  const eliteOffers = choiceRows('#app [data-reward-offer]', 'rewardOffer')
  assert(
    sameJson(optionTuples(eliteOffers), ELITE_OFFERS),
    'The elite draft must offer Greater Mend',
  )
  checkVisibleControls('Elite reward')
  const greaterMend = query('#app button[data-reward-offer="mend"]', 'Greater Mend offer')
  await commit(app, greaterMend, 'Greater Mend')
  await waitForBoundary(app, 'Route map · Stage 4/7', 'stage-4 route map')
  const stage4Nodes = choiceRows('#app [data-route-node]', 'routeNode')
  const eliteRewardResult = Object.freeze({
    health: metricText('campaign-health'),
    currency: app.runSnapshot.match.currency,
    available: nodeTuples(stage4Nodes.filter(({ button }) => button)),
  })
  assert(eliteRewardResult.health === '4/5', 'Greater Mend must restore 2 health')
  assert(eliteRewardResult.currency === 14, 'The elite bounty must be paid with the reward')
  assert(
    sameJson(eliteRewardResult.available, [
      ['bazaar', true, 'Stage 4 · Ember Bazaar', 'Shop · Available'],
      ['vault', true, "Stage 4 · Oathkeeper's Vault", 'Event · Available'],
      ['camp', true, 'Stage 4 · Roadside Camp', 'Rest · Available'],
    ]),
    'The elite win must open the shop, event, and camp',
  )

  // Rest site: options, the training target list, and Back. The rest save continues the
  // same ladder after taking AS instead of Greater Mend.
  app = await remount(app, fixtures.rest, 'rest site')
  await waitForBoundary(app, 'Roadside Camp', 'resumed Roadside Camp')
  const campDescription = descriptionText()
  const campOptions = choiceRows('#app [data-rest-option]', 'restOption')
  assert(sameJson(optionTuples(campOptions), CAMP_OPTIONS), 'The camp must state every option')
  const campSummary = detailSectionLines('Expedition')
  assert(
    sameJson(campSummary, ['Health 2/5', 'Coins 14', 'Deck 28 cards', 'Held card: 8D']),
    'The camp must summarize the expedition',
  )
  checkVisibleControls('Roadside Camp')
  const campButtons = visibleOverlayButtonLabels()
  const heldInstanceId = app.runSnapshot.match.hold
  const trainSelector = '#app button[data-rest-option="train"]'
  const trainTargets = await openTargets(trainSelector, '#app [data-rest-target]', 'training')
  const training = Object.freeze({
    heading: headingText(),
    description: descriptionText(),
    targetCount: trainTargets.length,
    heldOffered: trainTargets.some((target) => target.dataset.restTarget === heldInstanceId),
  })
  assert(training.heading === 'Choose a card to duplicate', 'Training must ask for a card')
  assert(training.description === TARGET_DESCRIPTION, 'Training must exclude the held card')
  // 28 cards less the held 8D and both 2H copies, which are at the copy limit.
  assert(training.targetCount === 25 && !training.heldOffered, 'Training must list eligible cards')
  checkVisibleControls('Training target list')
  await goBack('Roadside Camp', '#app [data-rest-option]', 3, 'camp after Back')
  assert(
    app.runSnapshot.match.machineState === 'awaitingRest'
      && app.runSnapshot.match.journal.length === 7,
    'Back must not train a card',
  )

  // Reload at the rest boundary, then fail the rest save and retry it.
  app = await remount(app, storage.record, 'saved rest site')
  await waitForBoundary(app, 'Roadside Camp', 'reloaded Roadside Camp')
  assert(
    sameJson(choiceRows('#app [data-rest-option]', 'restOption'), campOptions),
    'Reload must restore the camp exactly',
  )
  storage.failNextSave = true
  query('#app button[data-rest-option="rest"]', 'Rest option').click()
  await waitFor(() => headingText() === 'Rest choice not saved', 'failed rest save')
  const restFailure = Object.freeze({
    heading: headingText(),
    description: descriptionText(),
    buttons: visibleOverlayButtonLabels(),
    health: metricText('campaign-health'),
    route: metricText('campaign-route'),
    saveStatus: app.runSnapshot.saveStatus,
  })
  assert(
    restFailure.description === 'Your rest choice is made but not saved. Retry the save to continue, or return to the main menu.',
    'A failed rest save must explain the recovery',
  )
  assert(
    sameJson(restFailure.buttons, ['Retry save', 'Main Menu']),
    'A failed rest save must offer only Retry save and Main Menu',
  )
  assert(
    restFailure.health === '2/5' && restFailure.route === '4/7',
    'The healed state must stay hidden until the rest saves',
  )
  assert(document.querySelector('#app [data-route-node]') === null, 'The map must stay hidden')
  checkVisibleControls('Failed rest save')
  const retrySave = query('#app [data-action="campaign-save"]', 'Retry save action')
  assertButton(retrySave, 'Retry save')
  retrySave.click()
  await waitForBoundary(app, 'Route map · Stage 5/7', 'saved stage-5 route map')
  const stage5Nodes = choiceRows('#app [data-route-node]', 'routeNode')
  assert(metricText('campaign-health') === '4/5', 'Resting must restore 2 health')
  assert(
    sameJson(nodeTuples(stage5Nodes.filter(({ button }) => button)), [
      ['watch', true, 'Stage 5 · Watch of Tens', 'Fight · Watch archetype · 1 damage on a loss · Available'],
      [
        'night-watch',
        true,
        'Stage 5 · Night Watch',
        `Elite fight · Watch archetype · 2 damage on a loss · Available. ${ELITE_REWARD} ${PLUNDER}`,
      ],
    ]),
    'The camp must open both stage-5 fights',
  )

  // Reload at the route boundary: the rest is restored, never applied twice. Reduced
  // motion keeps the long fight that follows quick.
  app = await remount(app, storage.record, 'rested route map', { reducedMotion: true })
  await waitForBoundary(app, 'Route map · Stage 5/7', 'reloaded stage-5 route map')
  match = app.runSnapshot.match
  const resumedRest = Object.freeze({
    health: metricText('campaign-health'),
    journalLength: match.journal.length,
    entry: match.journal.at(-1),
  })
  assert(
    resumedRest.health === '4/5' && resumedRest.journalLength === 8,
    'Reload must not apply the rest twice',
  )
  assert(
    sameJson(resumedRest.entry, {
      type: 'rest',
      nodeId: 'camp',
      optionId: 'rest',
      targetInstanceId: null,
      createdInstanceId: null,
    }),
    'The journal must record the rest',
  )

  // Win the Watch of Tens, mend to full health, and reach the sanctum.
  await chooseRoute(app, 'watch', 'Watch of Tens')
  const watchClashes = await playFight(app, 'Watch of Tens', {
    until: () => headingText() === 'Encounter won' && app.runSnapshot.saveStatus === 'saved',
  })
  const watchMend = choiceRows('#app [data-reward-offer]', 'rewardOffer')
    .find(({ id }) => id === 'mend')
  assert(
    sameJson(optionTuples([watchMend]), [
      ['mend', true, 'Mend', 'Restore 1 health (now 4/5) and keep your deck unchanged.'],
    ]),
    'A normal fight must offer the normal Mend',
  )
  await commit(app, query('#app button[data-reward-offer="mend"]', 'Mend offer'), 'Mend')
  await waitForBoundary(app, 'Route map · Stage 6/7', 'stage-6 route map')
  assert(metricText('campaign-health') === '5/5', 'Mend must restore full health')
  assert(
    sameJson(availableNodeIds(choiceRows('#app [data-route-node]', 'routeNode')), ['sanctum']),
    'Every route must cross the sanctum',
  )
  await chooseRoute(app, 'sanctum', 'Last Light Sanctum')
  await waitForBoundary(app, 'Last Light Sanctum', 'Last Light Sanctum')
  const sanctumOptions = choiceRows('#app [data-rest-option]', 'restOption')
  assert(
    sameJson(optionTuples(sanctumOptions), SANCTUM_OPTIONS),
    'Resting at full health must say it restores nothing',
  )
  checkVisibleControls('Last Light Sanctum')
  const cleanseSelector = '#app button[data-rest-option="cleanse"]'
  const cleanseTargets = await openTargets(cleanseSelector, '#app [data-rest-target]', 'cleanse')
  const cleansing = Object.freeze({
    heading: headingText(),
    targetCount: cleanseTargets.length,
    heldOffered: cleanseTargets.some((target) => target.dataset.restTarget === heldInstanceId),
  })
  assert(cleansing.heading === 'Choose a card to remove', 'Cleansing must ask for a card')
  assert(
    cleansing.targetCount === 27 && !cleansing.heldOffered,
    'Cleansing must skip the held card',
  )
  await goBack('Last Light Sanctum', '#app [data-rest-option]', 3, 'sanctum after Back')
  await commit(
    app,
    query('#app button[data-rest-option="walk-on"]', 'Walk on option'),
    'walking on from the sanctum',
  )
  await waitForBoundary(app, 'Route map · Stage 7/7', 'stage-7 route map')
  const finale = nodeTuples(choiceRows('#app [data-route-node]', 'routeNode'))
    .filter(([, button]) => button)
  assert(
    sameJson(finale, [[
      'finale',
      true,
      'Stage 7 · Ace Sovereign',
      `${BOSS_FIGHT} · Available. Defeat to complete the expedition.`,
    ]]),
    'The boss must be the only stage-7 node',
  )
  query('#app [data-action="campaign-inspect"]', 'Run details action').click()
  await waitFor(() => headingText() === 'Run details', 'stage-7 Run details')
  const ladderInspection = Object.freeze({
    summary: descriptionText(),
    route: detailSectionLines('Route'),
    log: detailSectionLines('Expedition log'),
  })
  assert(
    ladderInspection.summary === 'Health 5/5 · Stage 7/7 · Coins 14 · Deck 28 cards · Held card: 8D',
    'Run details must summarize the expedition',
  )
  assert(sameJson(ladderInspection.log, LADDER_LOG), 'Run details must log every decision in order')
  checkVisibleControls('Stage-7 Run details')
  query('#app [data-action="campaign-close"]', 'Close action').click()
  await waitForBoundary(app, 'Route map · Stage 7/7', 'stage-7 route map after Run details')

  // Victory: the defeated boss completes the expedition, and Restart starts a new one.
  app = await remount(app, fixtures.victory, 'victory')
  await waitForBoundary(app, 'Campaign victory', 'resumed Campaign victory')
  const victory = Object.freeze({
    description: descriptionText(),
    expedition: detailSectionLines('Expedition'),
    buttons: visibleOverlayButtonLabels(),
    health: metricText('campaign-health'),
    route: metricText('campaign-route'),
  })
  assert(
    victory.description === 'You defeated the Ace Sovereign and completed the expedition.',
    'Victory must name the defeated boss',
  )
  assert(sameJson(victory.expedition, [VICTORY_ROUTE]), 'Victory must summarize the route')
  assert(
    sameJson(victory.buttons, ['Main Menu', 'Restart Campaign']),
    'Victory must offer Main Menu and Restart Campaign',
  )
  checkVisibleControls('Campaign victory')
  const restart = query('#app [data-action="campaign-restart"]', 'Restart action')
  assert(restart.disabled === false, 'Restart must be usable after victory')
  await commit(app, restart, 'restarted Campaign')
  await waitForBoundary(app, 'Route map · Stage 1/7', 'restarted route map')
  match = app.runSnapshot.match
  const restarted = Object.freeze({
    health: metricText('campaign-health'),
    route: metricText('campaign-route'),
    journalLength: match.journal.length,
    status: match.status,
  })
  assert(
    restarted.journalLength === 0 && restarted.status === 'active' && restarted.health === '3/5',
    'Restart must begin a new expedition',
  )
  assert(document.querySelectorAll('#app canvas').length === 1, 'Campaign must retain one canvas')
  assert(consoleErrors.length === 0, 'Elite ladder check reported a relevant console error')

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
      nodes: stage3Nodes.map(({ id, button, detail }) => (
        `${id}: ${button ? 'button' : 'text'} · ${detail}`
      )),
      buttons: routeButtons,
    },
    eliteFight: {
      clashes: courtClashes,
      inspection: courtInspection,
      holdCapture,
    },
    eliteReward: {
      description: eliteDescription,
      offers: eliteOffers.map(({ title, detail }) => `${title} — ${detail}`),
      ...eliteRewardResult,
    },
    rest: {
      description: campDescription,
      options: campOptions.map(({ title, detail }) => `${title} — ${detail}`),
      blockedOptions: campOptions.filter(({ enabled }) => !enabled).map(({ id }) => id),
      summary: campSummary,
      buttons: campButtons,
      training,
      saveFailure: restFailure,
      resumed: resumedRest,
    },
    sanctum: {
      watchClashes,
      options: sanctumOptions.map(({ title, detail }) => `${title} — ${detail}`),
      cleansing,
      finale: finale.map(([, , title, detail]) => `${title} — ${detail}`),
      inspection: ladderInspection,
    },
    victory: { ...victory, restarted },
    saves: storage.saves.length,
    consoleErrors,
  })
  globalThis.__SOULCARD_MILESTONE_21_4_REPORT__ = report
  output.dataset.status = 'complete'
  output.textContent = JSON.stringify(report, null, 2)
  console.info(`SOULCARD_MILESTONE_21_4 ${JSON.stringify(report)}`)
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

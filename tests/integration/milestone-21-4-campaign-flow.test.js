import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createCampaignRun } from '../../src/domain/campaign-machine.js'
import { BASELINE_RULESET } from '../../src/domain/ruleset.js'
import { restoreRunSave } from '../../src/persistence/run-schema.js'
import {
  createExpeditionCounters,
  EXPEDITION_PLANS,
  routeStates,
  stepExpedition,
} from '../fixtures/campaign-route.js'
import {
  assertRefused,
  byAction,
  choiceButton,
  choiceButtons,
  choiceDetail,
  click,
  commit,
  driveExpedition,
  overlayDescription,
  overlayDetails,
  overlayOpen,
  overlayTitle,
  reload,
  resumeSavedCampaign,
  usable,
  waitFor,
} from '../fixtures/expedition-shell.js'

const COURT_ETIQUETTE = 'Court Etiquette: Opponent trait. In this encounter, an empty Hold can capture only a 2–10, and an occupied Hold can be replaced only by a 2–10.'
const PLUNDER = 'Plunder: Opponent trait. Clashes this opponent wins send your cards to its won pile instead of burning them. They return to your deck after the encounter. Spoils of War has no effect against it.'
const ELITE_REWARD = 'Elite reward: a high card or Greater Mend.'

function routeChoices(root) {
  return choiceButtons(root, 'routeNode').map(({ dataset }) => [
    dataset.routeNode,
    choiceDetail(root, 'campaign-route', dataset.routeNode),
  ])
}

function restChoices(root) {
  return choiceButtons(root, 'restOption').map((button) => [
    button.dataset.restOption,
    button.textContent,
    choiceDetail(root, 'campaign-rest', button.dataset.restOption),
    usable(root, button),
  ])
}

const CAMP_CHOICES = [
  ['rest', 'Rest by the fire', 'Restore 2 health (now 2/5).', true],
  ['train', 'Train a card', 'Choose a card in your deck to copy.', true],
  ['walk-on', 'Walk on', 'Leave without changing anything.', true],
]

// The elite ladder's saved Roadside Camp boundary: seed 11, journal step 7, 2/5 health.
function savedCamp() {
  return restoreRunSave(JSON.parse(readFileSync(
    new URL('../fixtures/campaign-save-rest-v7.json', import.meta.url),
    'utf8',
  )))
}

function restAtCamp(step, optionId = 'rest') {
  return (controller) => controller.chooseRestOption({
    nodeId: 'camp',
    step,
    optionId,
    targetInstanceId: null,
  })
}

test('an elite ladder expedition rests twice and defeats the Ace Sovereign across reloads', async (t) => {
  const { counters, final, used } = await driveExpedition(t, {
    runId: 'elite-ladder',
    seed: 11,
    plan: EXPEDITION_PLANS.shrine,
    hooks: {
      '4:awaitingRoute'({ root }) {
        assert.equal(overlayTitle(root), 'Route map · Stage 3/7')
        assert.deepEqual(routeChoices(root), [
          ['court', 'Fight · Court archetype · 1 damage on a loss · 4-coin bounty · Available'],
          [
            'high-court',
            `Elite fight · Court archetype · 2 damage on a loss · 6-coin bounty · Available. ${ELITE_REWARD} ${COURT_ETIQUETTE}`,
          ],
        ])
      },
      '5:ready'({ app, root }) {
        // Hold keeps the 8D from the first fight; only a 2–10 could replace it here.
        assert.equal(app.runSnapshot.match.hold, 'player-007')
        click(byAction(root, 'hold'))
        assert.equal(overlayTitle(root), 'Replace held card')
        assert.equal(
          overlayDescription(root),
          'No player-owned card in your draw or won pile is eligible.',
        )
        assert.deepEqual(overlayDetails(root), [
          'Opponent traits',
          'Court Etiquette: Hold can capture only a 2–10',
        ])
        click(byAction(root, 'campaign-cancel'))
        assert.equal(overlayOpen(root), false)
        assert.equal(usable(root, byAction(root, 'reveal')), true)
      },
      '5:awaitingReward'({ root }) {
        assert.equal(overlayTitle(root), 'Encounter won')
        assert.equal(
          overlayDescription(root),
          'Choose one reward before returning to the map. The High Court bounty pays 6 coins when you choose.',
        )
        assert.deepEqual(
          choiceButtons(root, 'rewardOffer').map(({ dataset, textContent }) => [
            dataset.rewardOffer,
            textContent,
          ]),
          [
            ['new-card', 'New card: AS'],
            ['deck-edit', 'Duplicate a card'],
            ['modifier', 'Modifier: Vow of Constancy'],
            ['mend', 'Greater Mend'],
          ],
        )
        assert.equal(
          choiceDetail(root, 'campaign-offer', 'mend'),
          'Restore 2 health (now 2/5) and keep your deck unchanged.',
        )
      },
      '6:awaitingRoute'({ root }) {
        assert.deepEqual(routeChoices(root), [
          ['bazaar', 'Shop · Available'],
          ['vault', 'Event · Available'],
          ['camp', 'Rest · Available'],
        ])
      },
      '7:awaitingRest'({ root }) {
        assert.equal(overlayTitle(root), 'Roadside Camp')
        assert.deepEqual(restChoices(root), CAMP_CHOICES)
      },
      '8:awaitingRoute'({ app, root }) {
        assert.equal(app.runSnapshot.match.health, 4)
        assert.equal(overlayTitle(root), 'Route map · Stage 5/7')
        assert.deepEqual(routeChoices(root), [
          ['watch', 'Fight · Watch archetype · 1 damage on a loss · Available'],
          [
            'night-watch',
            `Elite fight · Watch archetype · 2 damage on a loss · Available. ${ELITE_REWARD} ${PLUNDER}`,
          ],
        ])
      },
      '9:ready'({ root }) {
        click(byAction(root, 'inspect'))
        assert.equal(overlayTitle(root), 'Run details')
        const details = overlayDetails(root)
        assert.ok(details.includes('Stage 5 · Night Watch (Elite fight): Current'))
        assert.deepEqual(
          details.slice(details.indexOf('Opponent traits'), details.indexOf('Expedition log')),
          ['Opponent traits', PLUNDER],
        )
        click(byAction(root, 'campaign-close'))
        assert.equal(overlayOpen(root), false)
      },
      '11:awaitingRest'({ app, root }) {
        assert.equal(app.runSnapshot.match.health, 5)
        assert.equal(overlayTitle(root), 'Last Light Sanctum')
        assert.deepEqual(restChoices(root), [
          ['rest', 'Rest in the sanctum', 'Your health is full. Resting here restores nothing.', true],
          ['cleanse', 'Cleanse a card', 'Choose a card to remove from your deck.', true],
          ['walk-on', 'Walk on', 'Leave without changing anything.', true],
        ])
      },
      '12:awaitingRoute'({ root }) {
        assert.equal(overlayTitle(root), 'Route map · Stage 7/7')
        assert.deepEqual(routeChoices(root), [[
          'finale',
          'Boss fight · Sovereign archetype · 2 damage on a loss · Available. Defeat to complete the expedition.',
        ]])
        click(byAction(root, 'campaign-inspect'))
        assert.deepEqual(overlayDetails(root).slice(-7), [
          'High Court: added AS and collected 6 coins',
          'Stage 4: entered Roadside Camp',
          'Roadside Camp: rested and restored 2 health',
          'Stage 5: entered Night Watch',
          'Night Watch: gained Vow of Constancy',
          'Stage 6: entered Last Light Sanctum',
          'Last Light Sanctum: removed AS',
        ])
        click(byAction(root, 'campaign-close'))
        assert.match(overlayTitle(root), /^Route map/)
      },
      '13:ended'({ root }) {
        assert.equal(overlayTitle(root), 'Campaign victory')
        assert.equal(
          overlayDescription(root),
          'You defeated the Ace Sovereign and completed the expedition.',
        )
        assert.deepEqual(overlayDetails(root), [
          'Expedition',
          'Route: Suit Opposition → Crossroads Shrine → High Court → Roadside Camp → Night Watch → Last Light Sanctum → Ace Sovereign. Coins 14 · Deck 27 cards.',
        ])
        assert.equal(usable(root, byAction(root, 'campaign-restart')), true)
      },
    },
  })
  assert.deepEqual(final.outcome, { result: 'victory', reason: 'campaignCompleted' })
  assert.equal(counters.retries, 0)
  assert.deepEqual(counters.events, ['bleed-for-fortune'])
  assert.deepEqual(counters.rests, ['rest', 'cleanse'])
  assert.deepEqual(used, ['capture', 'normal reveal', 'restTarget', 'rewardTarget'])
})

// The elite ladder on seed 3 loses its first two Ace Sovereign attempts; the third starts
// with 1 health left.
function lastBossAttempt() {
  let run = createCampaignRun({ runId: 'boss-defeat', seed: 3, ruleset: BASELINE_RULESET })
  const counters = createExpeditionCounters()
  while (run.journal.length < 15 || run.machineState !== 'ready') {
    run = stepExpedition(run, EXPEDITION_PLANS.shrine, counters)
  }
  assert.equal(counters.retries, 2)
  return run
}

test('a Campaign that reaches the boss with 1 health ends in defeat and can restart', async (t) => {
  const start = lastBossAttempt()
  let confirmations = 0
  const { final } = await driveExpedition(t, {
    runId: 'boss-defeat',
    seed: 3,
    plan: EXPEDITION_PLANS.shrine,
    start,
    hooks: {
      '15:ready'({ root }) {
        click(byAction(root, 'inspect'))
        assert.match(overlayDescription(root), /^Health 1\/5 · Stage 7\/7 · /)
        assert.ok(overlayDetails(root).includes('Stage 7 · Ace Sovereign (Boss fight): Current'))
        click(byAction(root, 'campaign-close'))
        assert.equal(overlayOpen(root), false)
      },
      '15:ended'({ app, root }) {
        assert.equal(overlayTitle(root), 'Campaign defeat')
        assert.equal(
          overlayDescription(root),
          'Your health was depleted. Start a new campaign to try again.',
        )
        const match = app.runSnapshot.match
        assert.equal(match.health, 0)
        assert.equal(routeStates(match).finale, 'active')
        assert.equal(usable(root, byAction(root, 'campaign-restart')), true)
      },
    },
    async onEnd(harness) {
      harness.confirmStartOver = () => {
        confirmations += 1
        return true
      }
      const saves = harness.repository.saves
      click(byAction(harness.root, 'campaign-restart'))
      await waitFor(
        () => (
          harness.repository.saves === saves + 1
          && harness.app.runSnapshot.saveStatus === 'saved'
        ),
        'The restarted Campaign',
      )
      assert.equal(confirmations, 1)
      assert.deepEqual(
        harness.app.runSnapshot.match,
        createCampaignRun({ runId: 'boss-defeat', seed: 3, ruleset: BASELINE_RULESET }),
      )
      assert.equal(overlayTitle(harness.root), 'Route map · Stage 1/7')
    },
  })
  assert.deepEqual(final.outcome, { result: 'defeat', reason: 'healthDepleted' })
})

test('stale, repeated, and replayed rest decisions are refused', async (t) => {
  const camp = savedCamp()
  const harness = await resumeSavedCampaign(t, { runId: camp.runId, seed: 11, start: camp })
  assert.equal(overlayTitle(harness.root), 'Roadside Camp')
  assert.deepEqual(restChoices(harness.root), CAMP_CHOICES)

  assertRefused(harness, restAtCamp(6), /Campaign decision step 6 is stale; the journal is at step 7/)
  assertRefused(
    harness,
    (controller) => controller.chooseRestOption({
      nodeId: 'sanctum',
      step: 7,
      optionId: 'rest',
      targetInstanceId: null,
    }),
    /Route node sanctum is not the active node/,
  )
  assertRefused(harness, restAtCamp(7, 'cleanse'), /Rest option is not part of the open rest site/)

  // A second click, or a decision for the next step, waits for the pending save.
  const saves = harness.repository.saves
  commit(harness, choiceButton(harness.root, 'restOption', 'rest'), { doubleActivate: true })
  assert.equal(harness.app.runSnapshot.saveStatus, 'saving')
  assert.throws(
    () => harness.runController.chooseRoute({ nodeId: 'watch', step: 8 }),
    /must be saved/,
  )
  await waitFor(() => harness.app.runSnapshot.saveStatus === 'saved', 'The rest save')
  assert.equal(harness.repository.saves, saves + 1)
  const rested = harness.app.runSnapshot.match
  assert.equal(rested.machineState, 'awaitingRoute')
  assert.equal(rested.health, 4)
  assert.deepEqual(rested.journal.slice(7), [{
    type: 'rest',
    nodeId: 'camp',
    optionId: 'rest',
    targetInstanceId: null,
    createdInstanceId: null,
  }])

  // The rest decision cannot be replayed after a reload.
  await reload(harness)
  assert.equal(overlayTitle(harness.root), 'Route map · Stage 5/7')
  assertRefused(harness, restAtCamp(7), /Campaign is not at a rest site/)
  assertRefused(harness, restAtCamp(8), /Campaign is not at a rest site/)
  await harness.app.destroy()
})

test('a failed rest save is lost to a reload, which offers the saved rest site again', async (t) => {
  const camp = savedCamp()
  const harness = await resumeSavedCampaign(t, { runId: camp.runId, seed: 11, start: camp })
  const deckSize = camp.deckLayout.length

  harness.repository.failNextSave()
  click(choiceButton(harness.root, 'restOption', 'train'))
  assert.equal(overlayTitle(harness.root), 'Choose a card to duplicate')
  const target = choiceButtons(harness.root, 'restTarget')[0]
  commit(harness, target)
  await waitFor(
    () => (
      overlayTitle(harness.root) === 'Rest choice not saved'
      && usable(harness.root, byAction(harness.root, 'campaign-save'))
    ),
    'The failed rest save',
  )
  assert.equal(
    overlayDescription(harness.root),
    'Your rest choice is made but not saved. Retry the save to continue, or return to the main menu.',
  )
  const unsaved = harness.app.runSnapshot.match
  assert.equal(harness.app.runSnapshot.saveStatus, 'failed')
  assert.deepEqual(unsaved.journal.at(-1), {
    type: 'rest',
    nodeId: 'camp',
    optionId: 'train',
    targetInstanceId: target.dataset.restTarget,
    createdInstanceId: unsaved.journal.at(-1).createdInstanceId,
  })
  assert.equal(unsaved.deckLayout.length, deckSize + 1)
  assert.equal(usable(harness.root, byAction(harness.root, 'campaign-main')), true)
  assert.deepEqual(choiceButtons(harness.root, 'restOption'), [])

  // The unsaved training is lost on reload; the saved camp is offered again.
  await reload(harness, camp)
  assert.equal(overlayTitle(harness.root), 'Roadside Camp')
  assert.deepEqual(restChoices(harness.root), CAMP_CHOICES)

  const saves = harness.repository.saves
  commit(harness, choiceButton(harness.root, 'restOption', 'rest'))
  await waitFor(() => harness.app.runSnapshot.saveStatus === 'saved', 'The rest save')
  assert.equal(harness.repository.saves, saves + 1)
  assert.equal(harness.app.runSnapshot.match.health, 4)
  assert.equal(harness.app.runSnapshot.match.deckLayout.length, deckSize)
  await harness.app.destroy()
})

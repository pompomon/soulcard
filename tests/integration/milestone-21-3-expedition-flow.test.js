import assert from 'node:assert/strict'
import test from 'node:test'
import { EXPEDITION_PLANS, routeStates } from '../fixtures/campaign-route.js'
import {
  assertRefused,
  assertUnchanged,
  byAction,
  choiceButton,
  choiceButtons,
  click,
  commit,
  descendants,
  driveExpedition,
  overlayDescription,
  overlayTitle,
  reload,
  usable,
  waitFor,
} from '../fixtures/expedition-shell.js'

test('a market expedition survives reloads, a lost purchase, and stale decisions', async (t) => {
  const { counters, final, used } = await driveExpedition(t, {
    runId: 'expedition-market',
    seed: 0,
    plan: EXPEDITION_PLANS.market,
    hooks: {
      '0:awaitingRoute'({ root }) {
        assert.equal(overlayTitle(root), 'Route map · Stage 1/7')
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
      '17:ended'({ root }) {
        assert.equal(overlayTitle(root), 'Campaign defeat')
        assert.equal(usable(root, byAction(root, 'campaign-restart')), true)
      },
    },
  })
  assert.deepEqual(final.outcome, { result: 'defeat', reason: 'healthDepleted' })
  assert.equal(counters.retries, 3)
  assert.deepEqual(counters.purchases, ['card-1'])
  assert.deepEqual(counters.events, ['surrender-held-card'])
  assert.deepEqual(counters.rests, ['rest'])
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
      '18:ended'({ root }) {
        assert.equal(overlayTitle(root), 'Campaign victory')
      },
    },
  })
  assert.equal(final.outcome.result, 'victory')
  assert.equal(counters.retries, 1)
  assert.deepEqual(counters.purchases, ['card-1', 'card-2', 'service-1', 'modifier-1'])
  assert.deepEqual(counters.events, ['bleed-for-fortune'])
  assert.deepEqual(counters.rests, ['rest'])
  assert.deepEqual(used, ['capture', 'normal reveal', 'rewardTarget', 'shopTarget'])
})

test('a defeated expedition stays resumable as a completed Campaign', async (t) => {
  const { counters, final, used } = await driveExpedition(t, {
    runId: 'expedition-defeat',
    seed: 3,
    plan: ['gate', 'shrine', 'court', 'vault', 'watch', 'sanctum', 'finale'],
    hooks: {
      async '15:ended'({ app, root }) {
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
          court: 'completed',
          'high-court': 'bypassed',
          bazaar: 'bypassed',
          vault: 'completed',
          camp: 'bypassed',
          watch: 'completed',
          'night-watch': 'bypassed',
          sanctum: 'completed',
          finale: 'active',
        })
        click(byAction(root, 'campaign-main'))
        await waitFor(() => app.activeScreen === 'main', 'The main menu')
        assert.equal(app.resumeAvailable, true)
      },
    },
  })
  assert.deepEqual(final.outcome, { result: 'defeat', reason: 'healthDepleted' })
  assert.equal(counters.retries, 2)
  assert.deepEqual(counters.purchases, [])
  assert.deepEqual(counters.events, ['bleed-for-fortune', 'surrender-held-card'])
  assert.deepEqual(counters.rests, ['rest'])
  assert.deepEqual(used, ['capture', 'hold reveal', 'normal reveal', 'rewardTarget'])
})

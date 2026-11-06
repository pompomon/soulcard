# Milestone 21.3 Branching Expedition: completion plan

Source: [`ROGUELIKE_ADVENTURE_RUN_PLAN.md`](./ROGUELIKE_ADVENTURE_RUN_PLAN.md) §21.3 and
its checklist row. Baseline: `main` after PR #40 (merged, labelled "Partial").
Status: accepted and implemented in one completion PR. §§1–4 record the baseline
before that PR; §11 records where the delivered code differs from the plan. The 21.3
checklist entry stays open until reviewer sign-off.

## 1. Summary

PR #40 delivered most of 21.3:

- the authored `expedition-v1` map with shop and event nodes
- the decision journal and guarded `{nodeId, step}` node decisions
- save schema 6 with campaign rules 5
- route, shop, event and target overlays.

Six gaps keep the milestone unchecked:

1. **Exhausted shops are unreachable.** Ember Bazaar stock costs 12 coins, but at most
   11 can be carried there (gate 3 + shrine 4 + court 4). As a result, "Out of stock" is
   tested only with a synthetic view.
2. **Retry is the only decision with no guard.** It takes no `{nodeId, step}`, has no
   saved-boundary gate in the controller or HUD, and has no controller or HUD tests.
3. **The map, shop, node-event and journal modules have no dedicated tests.** Blockers
   such as `unaffordable`, `health-too-low` and `no-eligible-card` are never asserted
   by name.
4. **Resume and stale-decision refusal are tested only at the domain level.** No
   app-level (bootstrap/HUD/repository) flow walks a full route, and 6 of the 8 routes
   are never played.
5. **The 21.1 and 21.2 browser fixtures are broken, and there is no 21.3 fixture.**
6. **The README, roadmap and plan doc still describe schema 5, rules 4 and the
   three-encounter duel.**

Nine work packages (WPs) close these gaps. Only WP1 changes gameplay: it changes one
number in the content and bumps the campaign rules version.

## 2. Baseline evidence (Node 24.22.1)

- `npm test`: 415 pass, 0 fail. `npm run build`: passes.
- The 21.1 browser fixture fails with "Cannot read properties of null (reading
  'supplyMode')":
  - New campaigns now open on the route map (`awaitingRoute`, `encounter === null`).
  - `tests/browser/milestone-21-1-campaign.js:110` expects an encounter.
- The 21.2 browser fixture fails with "Unsupported save schema version: 5":
  - It loads `campaign-save-reward-v5.json` through `restoreRunSave`, which does not
    migrate (`milestone-21-2-rewards.js:99`).
  - It watches the removed `campaign-encounter` metric (lines 157 and 240, which
    expects "2/3").
- Seed search over 60 seeds under rules 5: the best purse on reaching the bazaar is 11
  coins, against 12 coins of stock.

## 3. What exists

| Area | Implementation | Evidence |
| --- | --- | --- |
| Versions | `CAMPAIGN_VERSION` 3, `CAMPAIGN_GAME_RULES_VERSION` 5, campaign events v5, Classic events v4 | campaign-machine.js:55-56; events.js:7; campaign-events.js:3 |
| Saves | `SAVE_SCHEMA_VERSION` 6. `CARRIED_SCHEMAS` [4,5] carry Classic saves over and quarantine Campaign saves. A rules check runs before structural validation. | run-schema.js:8-9, 264-276; migrations.js:8-11; run-repository.js:63 |
| Map | gate → market\|shrine → court\|watch → bazaar\|vault → finale (8 routes). Includes `validateCampaignMap` and enter/complete node transitions. | campaign-map.js:38-49, 192-253, 312-331 |
| Content | Bounties 3/4/2/0. Prices: card 3, service 2, modifier 4. Wayside slots card/service/modifier (9 coins); Ember slots card/card/service/modifier (12 coins). Shrine and vault options. | campaign-content.js:26-56, 66-82, 99-143 |
| Shop | Stream `campaign-shop-stock-v1`. Blocker precedence: sold, then modifier-conflict/unavailable, then deck-edit blockers, then unaffordable. | campaign-shop.js:12, 26-86 |
| Events | Explicit costs and gains with no RNG. Blocker precedence: health-too-low, then hold-empty/deck-minimum, then deck-edit, then modifier, then unaffordable. | campaign-node-events.js |
| Journal | Replay validates every entry; a fight bounty is paid when its reward is claimed | campaign-journal.js:337 |
| Decisions | `assertNodeDecision` requires `{nodeId, step === journal.length}` and is used by route, reward, purchase, leave and event decisions | campaign-machine.js:1572-1640, 1642-1891 |
| Retry | `retryCampaignEncounter(input)` takes no decision | campaign-machine.js:1891-1905 |
| Controller | `applyNodeDecision` requires a saved boundary; `retryEncounter` bypasses it | run-controller.js:472-503 |
| HUD | `handleCampaignRetry` is guarded only by `overlayAction`. The retry button is disabled only while busy. | hud.js:686-711; overlays.js:439-443 |
| Sold-out UI | "Out of stock. Everything here has been sold." is tested only with a synthetic view | overlays.js:499-504; hud.test.js:1341-1354 |
| Tests | Every boundary round-trips at domain level (seeds 0 and 2 on the market plan, seed 6 on the shrine plan). Tamper, save-gating and lost-decision tests. Bootstrap resumes route/shop/event fixtures. HUD tests cover the route, shop and event overlays. | campaign-persistence.test.js; bootstrap.test.js:326-433; hud.test.js:1003-1354 |

What the scripted expeditions in today's tests actually do (probe under rules 5):

| Seed | Plan | Route reached | Purchases | Event option | Retries | Outcome |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | market | gate→market→court→vault→finale | card-1 | surrender-held-card | 1 | victory |
| 2 | market | gate→market→court→vault | card-1 | surrender-held-card | 1 | defeat at finale |
| 6 | shrine | gate→shrine→watch→bazaar→finale | card-1, service-1 | burn-an-offering | 2 | victory |

These decisions are never applied at domain level:

- a modifier purchase
- the second card slot (`card-2`)
- `pay-for-a-copy`
- walk-on at the vault
- a sold-out shop.

`bleed-for-fortune` has only one targeted assertion.

## 4. Acceptance traceability

| # | Criterion | Existing evidence | Gap | WP |
| --- | --- | --- | --- | --- |
| S1 | Authored branching map, locked/unlocked node state, deterministic route choice | campaign-map.js; `chooseCampaignRoute`; route overlay | No direct map tests: validator negatives, state transitions, all 8 paths | WP3 |
| S2 | Shops spend currency on bounded cards and modifiers; events trade health, deck, Hold or modifiers | Content and overlays | Modifier purchase, `card-2` and `pay-for-a-copy` are never applied; blockers are not tested by name | WP3, WP5 |
| S3 | Stable transitions including retry; full node state persisted; no duplicate application after restore | Step-guarded decisions; persistence round-trips | Retry has no step or saved gate; no controller or HUD retry tests | WP2 |
| A1 | Finish at least one route with divergent choices and resume at every node boundary | Domain round-trip at every boundary (3 seeds) | No app-level flow through a full route; no 21.3 browser evidence | WP5, WP7 |
| A2 | Currency, purchases, route locks and event outcomes are conserved and deterministic | `validateCampaignState` plus journal replay | No explicit ledger test across all routes | WP5 |
| A3a | Tests: alternate paths | 2 plans | 6 of 8 routes never run | WP5 |
| A3b | Tests: all node decisions | Partial | See S2 | WP3, WP5 |
| A3c | Tests: retries | Domain only | Controller, HUD and stale-retry cases | WP2 |
| A3d | Tests: exhausted shops | Synthetic HUD view only | Unreachable under rules 5 | WP1, WP3, WP5, WP7 |
| A3e | Tests: save/resume | Domain tests and bootstrap fixtures | App-level resume at every boundary; browser | WP5, WP7 |
| A3f | Tests: refusal of stale or duplicate decisions | Route, reward, shop and event decisions | Retry; app-level double activation | WP2, WP5 |
| Delivery rules | Any new rules, event or save shape gets an explicit version and migration or recovery policy | n/a | The WP1 rules bump needs a quarantine policy, tests and docs | WP1, WP8 |
| Evidence | Completion evidence and checklist | n/a | 21.3 evidence missing; README and roadmap stale | WP8 |

## 5. Decisions (accepted; see §10)

### D1. Make the exhausted shop reachable through content (option A1)

**Change:** raise the shrine's "Bleed for fortune" `coinGain` from 4 to 5 and bump
`CAMPAIGN_GAME_RULES_VERSION` from 5 to 6. `SAVE_SCHEMA_VERSION` (6), `CAMPAIGN_VERSION`
(3) and the campaign event version (5) are unchanged.

**Why it works:** gate 3 + shrine 5 + court 4 = 12, exactly the Ember Bazaar total.

**Experiment results** (a throwaway copy with the patch applied):

- Seeds 0–5 sell out the bazaar: all four items are sold, the purse is 0, and
  `validateCampaignState` passes.
- Seeds 6–7 cannot bleed because they reach the shrine at 1 health.
- Seed 1 reaches the bazaar after 73 clashes and sells out about 140 ms into the run. The
  whole run takes about 190 ms (101 clashes).

**Cost:** in-progress Campaign saves at rules 5 are quarantined as
`incompatible-game-rules` (run-schema.js:273-274 → run-repository.js:63). No migration
code is needed. 21.3 handled rules-4 saves the same way.

**Measured test churn:** applying the patch fails 15 tests. After regenerating the six
v6 fixtures (only `gameRulesVersion` changes), 4 remain:

- `campaign-persistence.test.js:85` (version)
- `campaign-persistence.test.js:249` and `:559` (currency 7 → 8 after bleed)
- `hud.test.js:1212` ("gain 4 coins" → "gain 5 coins").

**Alternatives:**

- **A2:** raise the court bounty from 4 to 5. This also reaches 12, but affects every
  route through court.
- **A3:** lower the modifier price from 4 to 3. Ember drops to 11 and Wayside to 8, with
  wider price churn.
- **B:** change no content. Redefine "exhausted" as "every item sold or blocked" and test
  that empty pools skip their slots. Saves are kept, but this only weakly meets "tests
  cover exhausted shops".

### D2. Retry becomes a guarded node decision

`retryCampaignEncounter(input, { nodeId, step })` is gated on a saved boundary in the
controller and goes through `commitDecision` in the HUD. The journal entry
`{ type: 'retry', nodeId }` is unchanged, so no version bump is needed.

### D3. Tests-first completion

Add no gameplay beyond D1. Rest nodes, elites and the boss belong to 21.4.

### D4. Where this plan lives

This plan is committed as `docs/MILESTONE_21_3_COMPLETION_PLAN.md` in the completion
PR. Completion evidence goes into the plan doc's §21.3.

### D5. Fixtures

Keep the v5 fixtures, which the migration tests use. Before regenerating, keep a rules-5
copy of the route fixture for the quarantine test.

## 6. Work packages

### WP1: Reachable exhausted shop (content change and rules 6)

Source changes:

- `src/domain/campaign-content.js:108`: change `coinGain` from 4 to 5.
- `src/domain/campaign-machine.js:56`: set `CAMPAIGN_GAME_RULES_VERSION = 6`.
- `src/persistence/migrations.js:8-10`: update the comment. Schema 4/5 Campaign saves
  (rules 3/4) are quarantined here; schema 6 saves at rules 5 are quarantined by the
  rules check in run-schema.js.

Fixtures (`tests/fixtures/campaign-route.js`):

- Add `soldOut: ['gate', 'shrine', 'court', 'bazaar', 'finale']` to `EXPEDITION_PLANS`
  and update its comment.
- Add `exhaustedShopFixtureRun()`. It starts seed 1 with runId
  `fixture-campaign-shop-exhausted`, which does not affect RNG. It then calls
  `stepExpedition` until `machineState === 'awaitingShop'`, `shop.nodeId === 'bazaar'`,
  and every item is sold.
- Register `['campaign-save-shop-exhausted-v6.json', exhaustedShopFixtureRun]` in
  `CAMPAIGN_SAVE_FIXTURES`.
- First copy `campaign-save-route-v6.json` to `campaign-save-route-v6-rules5.json`. Then
  regenerate all v6 fixtures with `createRunSave(build(), { savedAt: SAVED_AT })`
  (2-space JSON and a trailing newline), matching the regeneration test.

Tests to update:

- `campaign-persistence.test.js:77-90`: retitle to "rules v6" and change the assertion
  at :85.
- `campaign-persistence.test.js:249` and `:559`: currency +5, total 8.
- `hud.test.js:1212`: expect "gain 5 coins".

New tests:

- **migrations / run-schema:** a schema-6 Campaign save at `gameRulesVersion` 5 throws
  `UnsupportedGameRulesVersionError`; Classic schema-6 saves are unaffected.
- **run-repository:** a rules-5 Campaign save is quarantined with reason
  `incompatible-game-rules`, and discarding it clears the quarantine.
- **bootstrap:** Main reports the incompatible save and keeps Resume disabled (mirror any
  existing rules-4 case).
- **campaign-persistence:**
  - Add seed 1 with the `soldOut` plan to the every-boundary round-trip test.
  - The exhausted fixture restores with every blocker `sold` and currency 0.
  - Buying any item is refused, and leaving works.
- **hud:** add a fixture-backed sold-out test. It shows the "Out of stock…" line, four
  disabled items marked sold, and an enabled Leave that works.

Done when `npm test` passes and the regeneration test covers all 7 v6 fixtures.

### WP2: Guarded retry decision

Domain (`campaign-machine.js:1891-1905`):

- Change the signature to `retryCampaignEncounter(input, decision)`.
- After the state check, call `assertNodeDecision(input, decision, ['nodeId', 'step'])`.
- Update the comment.

Controller (`run-controller.js:472-485`):

- Change `retryEncounter(selection)` to go through `applyNodeDecision`, with the message
  'The Campaign retry must be saved before the encounter can be retried'.

HUD (`hud.js:686-711`):

- Return early unless `decisionSelectable('awaitingRetry')`.
- Call `commitDecision('retry', 'The campaign retry could not be completed. Try again.',
  (boundary) => runController.retryEncounter(nodeDecision(boundary)))`.
- Remove the then-unused `'campaign-retry'` overlay action.

Overlay (`overlays.js:439-443`):

- Set `buttons.retry.disabled = options.busy || !boundarySaved`.
- Add an unsaved description, matching the wording of other modes (for example, "You can
  retry once this loss is saved.").

Call sites:

- Add a `retryEncounter(run)` helper in campaign-route.js (`{ nodeId, step:
  run.journal.length }`, like the other helpers) and use it at line 229.
- `campaign-machine.test.js`: lines 635, 1000, 1003, 1028.
- `campaign-rewards.test.js`: lines 670, 772, 794.

New tests:

- **Domain:** retry refuses:
  - a missing decision
  - an extra key
  - another node
  - a non-retry state
  - a stale step (after retry → lose again, the old decision is refused).

  Retry applies exactly once and adds one `{ type: 'retry', nodeId }` journal entry.
- **Controller:** retry throws while the loss save is pending or failed, succeeds after
  the save, and queues one save.
- **HUD:**
  - Retry stays disabled until the loss is saved.
  - Clicking shows "Saving your retry before continuing…".
  - A double click applies once.
  - A failed save offers Retry save.
- **Persistence:** after a reload at `awaitingRetry`, a stale pre-reload decision is
  refused.

No version bump: neither the persisted shape nor the journal entry changes.

### WP3: Module unit tests (new files in tests/unit)

`campaign-map.test.js`:

- The shipped map validates. Check node IDs, stages, kinds and content, and that there
  are exactly 8 start-to-final paths, each with 5 nodes and one node per stage.
- The validator rejects mutated clones with:
  - more than 16 nodes
  - a duplicate ID
  - an unknown kind or content ID
  - a link to the same or an earlier stage, or a duplicate link
  - a missing or extra start node, or a start node that is not first
  - a final node that is not last or is not a fight
  - an unreachable node, or a node that cannot reach the final
  - a coin-granting event with no later shop.
- Route state:
  - Initially, gate is available and every other node is locked.
  - Entering a node bypasses unvisited nodes that become unreachable.
  - Completing a node unlocks its successors.
  - Locked, bypassed and completed nodes are refused.

`campaign-shop.test.js`:

- Stock is deterministic per (seed, node index) on the `campaign-shop-stock-v1` stream:
  - One draw per non-empty slot, plus one for a replace card.
  - An empty pool skips its slot (drive this with a synthetic replay state if the pool
    builder is reachable; otherwise document it).
- Item IDs and prices; Ember's two card slots offer distinct cards.
- Each blocker by name, with precedence: sold, then modifier-conflict/unavailable, then
  deck-edit blockers (copy limit, deck minimum/maximum, `no-eligible-card`), then
  unaffordable.
- Purchases:
  - A purchase applies once.
  - A sold item is refused.
  - A deck edit requires an eligible target, and the held card is excluded.
  - Leaving works both with stock left and when sold out.

`campaign-node-events.test.js`:

- Every option of both events applies its costs and gains exactly: health, coins, deck
  edit, Hold surrender plus Hold Insight, and the walk-on no-op. Healing is capped at
  maximum health.
- Blocker names and precedence: health-too-low, then hold-empty/deck-minimum, then
  deck-edit, then modifier, then unaffordable. A health cost can never end the run.
- Burn and pay options list targets; surrender takes none.
- Refused decisions: an unknown option, a blocked option, the wrong node, a stale step.

`campaign-journal.test.js`:

- Replay reproduces state for every entry type: route, reward, purchase, leave, event,
  retry.
- Replay rejects:
  - a route to a locked node
  - a purchase of a sold item
  - an item or option mismatch
  - a retry outside a fight
  - a reward that does not match the regenerated draft
  - entries out of order.
- Currency is never negative.
- Document and test how replay treats options that depend on Hold (`replayContext` uses
  `holdOccupied: null`).

Optional: add a default parameter, `validateCampaignContent(content = defaults)`, only if
negative content tests turn out to be needed.

### WP4: Auto-reveal at node boundaries

Add these tests next to `campaign-persistence.test.js:623-662`. With auto-reveal on,
restoring the route, shop, exhausted-shop, event and retry boundaries causes no reveal,
no decision and no extra save. A freshly entered fight (`ready`, no pending event) waits
for the player.

### WP5: End-to-end expedition and conservation

`tests/integration/milestone-21-3-expedition-flow.test.js`:

- **Harness:**
  - The FakeElement bootstrap harness from the existing integration tests.
  - A memory run repository.
  - An injected `runController` where needed (bootstrap.js:115, 141).
  - Fights played by clicking Reveal and Hold.
- **Route A** (seed 0, market): gate → reward → market, buying with a target (open the
  picker, go Back, then choose) → Leave → court → vault (pay-for-a-copy or surrender) →
  retry after a loss → finale.
- **Route B** (seed 1, `soldOut`): gate → shrine bleed → court → bazaar, buying all four
  items → "Out of stock" → Leave → finale.
- **Resume at every node boundary.** The boundaries are:
  - `awaitingRoute`
  - `ready` on node entry
  - `awaitingReward`
  - `awaitingShop`, before and after each purchase
  - `awaitingEvent`
  - `awaitingRetry`
  - `ended`.

  At each one, destroy the app, bootstrap from the same repository, Resume, deep-equal
  the restored match, and continue.
- **Refusals:**
  - A double activation applies once.
  - A decision made while saving is ignored.
  - After a reload, a stale decision throws and leaves the state unchanged.
  - If a decision is lost before its save (repository write fails), the reload offers
    the same decision again, and it applies exactly once.

`tests/unit/campaign-expedition.test.js` (domain ledger) runs all 8 routes × 2 seeds and
checks:

- Currency equals the bounties claimed, plus event coin gains, minus prices and event
  coin costs, and is never negative.
- Each stage has exactly one completed node, and the others are bypassed.
- Locked nodes are never entered.
- Each shop item is sold at most once.
- Card instance IDs are unique, and each instance is in exactly one zone.
- Journal replay validates.
- Running the same seed and plan again gives a deep-equal state.

Budget: about 3 s of extra test time (about 200 ms per run).

### WP6: Repair the 21.1 and 21.2 browser fixtures

21.1 (`milestone-21-1-campaign.js:101-111`): after the initial save, assert the route map
dialog, click `[data-route-node="gate"]`, and wait for a saved `ready` state before the
existing encounter checks.

21.2 (`milestone-21-2-rewards.js`):

- Load `campaign-save-reward-v6.json` (line 99).
- Replace the `campaign-encounter` metric (line 157) with `campaign-route`. It should read
  "1/5" during the draft and "2/5" on the map after the reward saves (line 240).
- Reach the court through the shrine (Walk on) for the informed Hold check.
- Assert the "Expedition log" lines in Run details.
- In the plan doc's 21.2 evidence, note that the fixture now restores the schema-6
  draft.

### WP7: New 21.3 browser fixture

Add `tests/browser/milestone-21-3-expedition.{html,js}`, text-only.

From `campaign-save-route-v6.json`:

1. Check the route nodes and locks.
2. Choose the market only after the map is saved.
3. Check item prices and blocker text.
4. Buy an edit using the target list and Back.
5. Leave.
6. Reload and Resume at the next boundary.
7. Choose an event option with a target.

From `campaign-save-shop-exhausted-v6.json`, check the "Out of stock…" line, that every
item is disabled, and that Leave is enabled and works.

Report 44px controls, dialog semantics, exactly one `#app canvas`, and console errors.
Take no screenshots (per `.github/copilot-instructions.md`).

### WP8: Documentation

- **`docs/ROGUELIKE_ADVENTURE_RUN_PLAN.md`:** add 21.3 completion evidence (rules 6,
  schema 6, the fixtures, the tests and the browser fixture). Check the box on line 13
  only after sign-off.
- **`README.md`:**
  - Lines 18-25: add the 21.3 fixture.
  - Lines 106-113: replace the "three-encounter" text with the route-based expedition
    (map, four fights, shops, events, coins).
  - Lines 116-123: Resume is enabled for any valid restored run. Current saves are
    schema 6, with Classic rules 2 and Campaign rules 6. Campaign rules 3, 4 and 5 saves
    are quarantined.
- **`docs/IMPLEMENTATION_ROADMAP.md`:** update the schema paragraph at lines 633-640 to
  schema 6, and change the JSON example at line 658 to `"saveSchemaVersion": 6`.
- **`docs/MILESTONES.md`:** leave item 21 unchecked; it stays open until 21.6.
- **`docs/MILESTONE_21_3_COMPLETION_PLAN.md`:** commit this plan (D4).

### WP9: Validation and review

- On Node 24, run `npm test` and `npm run build`.
- Run the 21.1, 21.2 and 21.3 fixtures headless and report text only: the DOM, the canvas
  count, console output and the process status.
- Review the diff with the soulcard-code-review skill, then get human sign-off before
  checking 21.3.

## 7. Sequencing

1. WP1, then WP2. Both touch the fixture helpers; WP2 needs no fixture regeneration.
2. WP3 and WP4, in parallel.
3. WP5, which needs the WP1 exhausted fixture and the WP2 retry API.
4. WP6 and WP7, which need the WP1 fixtures.
5. WP8, then WP9.

Accepted: one completion PR containing every WP (§10).

## 8. Risks

| Risk | Mitigation |
| --- | --- |
| The rules bump quarantines in-progress Campaign saves | Accepted (§10); tested quarantine and discard path; README note |
| A seed cannot bleed at 1 health (seeds 6–7) | Fixtures and flows pin seed 1, with the exhaustion predicate asserted |
| Test runtime or flakiness | Fixed seeds; FakeElement harness; wait on `saveStatus`, not timers |
| The retry API change misses a call site | All 10 call sites are listed (8 in tests, plus the controller and HUD); the decision is mandatory, so a missed one fails loudly |
| Scope creep into 21.4 | No new node kinds, elites or rest nodes |

## 9. Definition of done

- Every row in §4 has passing evidence.
- On Node 24, `npm test` and `npm run build` pass.
- The 21.1, 21.2 and 21.3 browser fixtures pass, with text-only reports.
- The docs are updated.
- A reviewer has signed off, and only then is 21.3 checked.

## 10. Accepted decisions

1. **D1 accepted:** the shrine pays 5 coins, Campaign rules become version 6, and
   in-progress rules-5 Campaign saves are quarantined until discarded.
2. **D2 accepted:** `retryCampaignEncounter` and `retryEncounter` take a
   `{ nodeId, step }` decision and apply only to a saved loss.
3. **Delivery:** one completion PR containing WP1–WP9.
4. **D4:** this plan is committed in that PR.

## 11. Implementation notes

Where the delivered code refines the plan:

- **WP2:**
  - The controller refuses an unsaved loss with "The lost Campaign encounter must be
    saved before it can be retried".
  - The HUD names the decision "encounter retry" ("Saving encounter retry", "Encounter
    retry not saved").
  - An unsaved loss reads "… The encounter can be retried once this loss is saved." and
    offers Retry save while Retry stays disabled.
- **WP5:** the integration test plays three expeditions:
  - Seed 0 on the market plan: a retry at the gate, a Wayside purchase whose save fails
    and is lost on reload, and a vault surrender.
  - Seed 1 on the sold-out plan: double activations at the first route, the shrine, and
    a shop, then a sold-out Ember Bazaar.
  - A seed-3 defeat that remains resumable as a completed Campaign.

  The ledger test runs all eight routes under two policies (seeds 3 and 0), asserts
  coverage of every decision kind, and replays seeds 3 and 6 deterministically.
- **WP7:**
  - The fixture emulates a reload by destroying and re-bootstrapping the app against an
    in-memory repository of serialized saves, so it never touches the page origin's
    IndexedDB.
  - Its failed-save check uses the shop exit; the integration test covers a failed
    purchase save.
- **WP9:**
  - On an idle 2-CPU host, `npm test` reports 20.1 s for 449 tests, against 13.3 s for
    415 tests on `main`.
  - The domain ledger takes 2.3 s, which is within its 3 s budget. The three
    integration flows add another 2.3 s. The remaining new tests and the per-file
    process startup account for the rest of the increase.
  - The production bundle grows by 10 bytes. The existing warning about chunks over
    500 kB is unchanged.

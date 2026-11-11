# Campaign

Normative reference for Campaign mode; update it in the same PR as the code. General architecture:
[ARCHITECTURE.md](ARCHITECTURE.md). Status, 21.5/21.6 specs and backlog: [ROADMAP.md](ROADMAP.md).

## 1. Model and invariants

`src/domain/campaign-machine.js` owns state, validation and transitions.

- **Run.** `createCampaignRun` opens on `awaitingRoute` without drawing RNG; `createNewCampaign`
  (`src/app/new-campaign.js`) seeds it from Web Crypto. Its ruleset, `mvp-baseline-v2` or
  `mvp-no-burn-v2`, is fixed for the run.
- **States:** `ready`, Hold states, `awaitingRetry`, `awaitingReward`,
  `CAMPAIGN_NODE_DECISION_STATES`, `paused`, `ended`.
- **Cards** are `{instanceId, cardId, campaignOwner}`; the owner never changes. Player IDs are
  `player-NNN`, issued in sequence and never reused. Opponent IDs are
  `opponent-<encounterIndex+1>-<attempt>-NNN`.
- **Layout.** `deckLayout` orders every non-held player ID, plus one `holdPosition` token if and
  only if Hold is occupied. Deck edits change only ID entries.
- **Zones.** Each side has a source pile, `drawPile` and `wonPile`; `contestedPile`, `burnPile`
  and `inPlay` are shared. Each player instance is in exactly one zone or Hold.
- **Setup** (`setUpEncounter`) shuffles the layout minus its token, then the fight deck, with the
  run RNG: player first. Draw piles start empty. A retry reshuffles; nothing else in setup draws.
- **Supply** (`prepareSupply`), player first: a side reveals source index 0 until its source
  empties, then turns `personal`, and an empty draw pile refills by shuffling its won pile. Source
  and draw piles are never both non-empty. Inability draws nothing.
- **Settlement** (`settleContest`) moves the contest to the winner's won pile, but under burn
  rules the loser's cards burn (`contestCardBurns`) unless the winner claims them. A player card
  that no opponent card ties or beats is never lost.
- **Ties** continue inside the same clash step (`resolvePreparedClash`). A side that can't supply
  loses the fight; if neither can, it is drawn and keeps its contest. Stable boundaries have an
  empty `inPlay`.
- **Outcomes.** A win opens a reward, or at the final node ends in victory without a draft. A
  loss or draw costs the fight's `damage`: at 0 health the run ends in defeat, otherwise
  `awaitingRetry` refights it. Teardown (`commitNodeDecision`) recovers every player card,
  burned ones too, drops opponent cards and keeps Hold.
- **Decisions** (`route`, `retry`, `reward`, `purchase`, `leaveShop`, `event`, `rest`) are journal
  entries (`JOURNAL_ENTRY_KEYS`, `campaign-journal.js`). Each passes `{nodeId, step}` with
  `step === journal.length` (`assertNodeDecision`), so stale or repeated decisions are refused.
  `applyNodeDecision` (`src/app/run-controller.js`) applies one only when `saveStatus` is
  `'saved'`: a retry needs a saved loss or draw.
- **Replay.** `replayCampaignJournal` rebuilds route, coins, cards and modifiers from seed,
  ruleset and journal; `validateCampaignState` requires the run to match. Hold isn't journaled:
  replay passes `holdOccupied: null`. `createCampaignStateFingerprint` is the canonical JSON of
  the whole run; a pending event's `stateFingerprint` must equal it.

| RNG stream | Index | Draws |
| --- | --- | --- |
| run RNG | none | setup shuffles, won-pile recycles |
| `campaign-reward-draft-v1` | `encounterIndex` | one per non-empty slot |
| `campaign-shop-stock-v1` | map node index | one per non-empty slot, plus a replace card |

Hold, traits, events, rests and blockers draw nothing. A route choice draws only through the fight
setup or shop stock it opens.

## 2. Hold

One slot that persists across encounters; its token keeps the held card out of the source pile.

- `prepareCampaignReveal` (from `ready`) peeks the player's next card. With no candidate and an
  empty Hold it resolves inability; otherwise it opens a saved boundary even when only `normal`
  is legal: `awaitingInformedHoldChoice` (Hold Insight; also peeks the opponent) or
  `awaitingHoldChoice`. A null candidate allows only `hold`, so inability can't bypass Hold.
- Hold states are RNG-free saved boundaries: reload shows the same choice, and metadata that no
  longer matches the piles fails validation.
- `chooseCampaignReveal` (`normal` or `hold`) revalidates the peeked cards. Hold applies only to
  a clash's first reveal, never to tie continuations.
- `captureCampaignHold` (in `ready`) targets player-owned cards in `player.drawPile` or
  `player.wonPile` (`getEligibleHoldTargets`). Replacing is an exact swap of pile and layout
  positions.
- `revealOrContinue` (`src/app/run-controller.js`) saves the boundary. With Auto-reveal
  (`autoChooseNormal`) and a successful save it picks `hold` for a null candidate, else `normal`.
  `chooseHoldChoice` needs a saved status; `captureHold` doesn't. Campaign skips the AI controller.

## 3. Modifiers, traits and stacking

`CAMPAIGN_MODIFIER_CATALOGUE` (`campaign-modifiers.js`) is sorted by ID; pools keep that order and
draw nothing. Hooks: `maximumHealth`, `holdDecision`, `holdCaptureEligibility`,
`holdReplacementEligibility`, `burnSettlement`.

| ID | Owner, lifetime | Draft | Effect |
| --- | --- | --- | --- |
| `court-etiquette-v1` | opponent, encounter | no | capture and replace only 2–10 |
| `hold-insight-v1` | player, campaign | yes | informed Hold choice |
| `plunder-v1` | opponent, encounter | no | burn rules: opponent claims burns |
| `spoils-of-war-v1` | player, encounter | yes | burn rules: player claims burns |
| `vitality-cap-v1` | player, campaign | no | maximum health 5; starting |
| `vow-of-constancy-v1` | player, campaign | yes | heal 2; replacement can't lose to the held card |
| `vow-of-patience-v1` | player, campaign | yes | heal 2; capture only from the won pile |
| `vow-of-the-court-v1` | player, campaign | yes | heal 2; capture only J–A |

- Player records `{id, lifetime, grantedAtNodeId}` have distinct hooks
  (`assertDistinctModifierHooks`). Encounter modifiers survive retries and expire when the fight's
  reward is claimed.
- **Traits** live in `encounter.traitIds` and must equal `encounterTraitIds` for the fight, which
  drops inapplicable traits: the Night Watch has none under no-burn rules. They never become
  records, journal or pool entries.
- **Stacking rule (Campaign rules 7).** Each hook takes at most one player modifier and one trait
  (`hookEffects`). Hold filters intersect and may leave no target (`narrowHoldTargets`), but never
  evict a held card. A trait on `burnSettlement` suspends the player's effect for that encounter:
  Plunder disables Spoils of War.

## 4. Rewards

`generateRewardDraft` (`campaign-rewards.js`) drafts after a won non-final fight from RNG-free
pools. Slots: `new-card` (unowned; elites prefer unowned J–A), `deck-edit` (duplicate, remove or
replace; replace draws its card), `modifier` (`getDraftableModifierPool`), then unseeded `mend`:
+1 health, or +2 (Greater Mend) after an elite. Elite drafts keep the stream, slot order and draw
count. A claim expires encounter modifiers, applies the offer, pays the bounty and increments
`encounterIndex`. Targets exclude the held card; copy limits count it.

## 5. Map and nodes

`CAMPAIGN_MAP` (`campaign-map.js`) is `expedition-v2`: 12 nodes, 7 stages, 21 links and 24
routes, each alternating fights and stops. Stages: 1 gate; 2 market, shrine; 3 court,
high-court; 4 bazaar, vault, camp; 5 watch, night-watch; 6 sanctum; 7 finale.

- Node states: `locked`, `available`, `active`, `completed`, `bypassed`.
- Shops generate stock on entry (`generateShopStock`, `campaign-shop.js`). Cards are unowned and
  distinct; each item sells once.
- Events and rest sites end with an effect-free Walk on. Rest options are free and each heals or
  duplicates or removes a card. Resting at full health does nothing.
- Blocker order, first match wins: `eventOptionBlocker` (`campaign-node-events.js`, also rests)
  checks health, surrender (`hold-empty`, `deck-minimum`), deck edit, modifier, then coins;
  `shopItemBlocker` checks `sold`, then modifier or deck edit, then coins.
- The sold-out route (gate, shrine, court) earns 3 + 5 + 4 = 12 coins: the whole Ember Bazaar.
- Known limitation: the rest deck-limit blockers are unreachable on this map. Only constructed
  states test them (`campaign-rest.test.js`, `hud.test.js`).

## 6. HUD

- `src/ui/hud.js` adds Health and Route metrics and Hold and Run details buttons, enabled only in
  an idle `ready` state with no overlay.
- Every decision is an overlay inside Game (`createCampaignOverlay`, views in
  `src/ui/campaign-view.js`). Hold choices appear once their save is `saved` or `failed`; retry,
  reward and end overlays wait for event presentation. A failed save offers a retry.

## 7. Current content

`campaign-content.js`: health 3/5, 0 coins, 26 starter cards (Diamonds, then Hearts), deck size
20–40, copy limit 2. Prices: card 3, service 2, modifier 4.

| Fight | Archetype | Tier | Damage | Bounty | Trait |
| --- | --- | --- | --- | --- | --- |
| `suit-opposition` | Suit Legion: Spades, Clubs | normal | 1 | 3 | |
| `royal-court` | Court: J, Q, K | normal | 1 | 4 | |
| `high-court` | Court + `c-AS`, `c-AC` | elite | 2 | 6 | Court Etiquette |
| `watch-of-tens` | Watch: 8, 9, 10 | normal | 1 | 0 | |
| `night-watch` | Watch + `c-AS`, `c-AC` | elite | 2 | 0 | Plunder |
| `ace-sovereign` | Sovereign: K, A | boss | 2 | 0 | |

| Node | Content | Offers (plus Walk on) |
| --- | --- | --- |
| market | `wayside-market` | card, service, modifier |
| bazaar | `ember-bazaar` | card, card, service, modifier |
| shrine | `crossroads-shrine` | pay 1 health for 5 coins; remove a card to heal 2 |
| vault | `oathkeepers-vault` | surrender the held card for Hold Insight; pay 3 to duplicate |
| camp | `roadside-camp` | rest (2 health); train (duplicate) |
| sanctum | `last-light-sanctum` | rest (2 health); cleanse (remove) |

## 8. Versions and compatibility

Save schema 7 (`SAVE_SCHEMA_VERSION`, `src/persistence/run-schema.js`), Campaign rules 7
(`CAMPAIGN_GAME_RULES_VERSION`), campaign version 4 (`CAMPAIGN_VERSION`) and Campaign events v5
(`CAMPAIGN_EVENT_VERSION`, `campaign-events.js`). Classic uses rules 2 and events v4.

- The rules check in `validateRunSaveVersion` runs before structural validation.
- Campaign saves from schemas 4–6 (rules 3–6) are quarantined as `incompatible-game-rules`
  (`src/persistence/migrations.js`); Classic saves from them carry over.
- Version-5 events carry instance identities and must match the run fingerprint. Validation
  recomputes ties and winners with `compareCards`, so card-value effects need an event-version
  bump. New stored encounter fields need a schema bump or migration, not an event bump.

## 9. Constraints for generators (21.5)

`validateCampaignMap` and `validateCampaignFights` (`campaign-map.js`) enforce these. Generators
must satisfy them or revise them explicitly:

- 1–16 nodes (`CAMPAIGN_MAP_NODE_LIMIT`) in stage order, linking only to later stages. Every node
  is reachable and reaches the final node.
- The start, listed first, is a normal fight. The only boss is the final node, listed last.
- Elite twin rule: every elite has a normal fight in its stage that all its predecessors offer.
- A positive bounty or coin gain needs a shop reachable later on at least one route.
- Normal fights field exactly their archetype core. Elite and boss decks cover every rank
  (`uncoveredCampaignRanks`; 2 beats A), or they can't threaten. The boss pays no bounty. Traits
  are elite-only, sorted, distinct and on distinct hooks.
- Events and rests end with an effect-free option. No node heals more than 2
  (`CAMPAIGN_NODE_HEAL_LIMIT`): Mend, vows, events and rests.
- Node order is saved route order and keys `campaign-shop-stock-v1`: reordering changes stock.
- `validateCampaignContent()` takes no arguments and checks the static catalogues at import;
  `validateShops` is private. Generated bundles need a validator that accepts them.
- An opponent-reveal or veil effect would cancel Hold Insight.

## 10. Fixtures and tests

- Current saves are `tests/fixtures/campaign-save-*-v7.json`, built by `CAMPAIGN_SAVE_FIXTURES`
  (`tests/fixtures/campaign-route.js`). Regenerate each with
  `createRunSave(build(), { savedAt: SAVED_AT })` as 2-space JSON with a trailing newline. No
  script exists; `tests/unit/campaign-persistence.test.js` enforces equality.
- Superseded saves (`campaign-save-v4.json`, `campaign-save-*-v5.json`, `campaign-save-*-v6.json`,
  `campaign-save-route-v6-rules5.json`) stay as carry and quarantine samples.
- `tests/fixtures/expedition-shell.js` drives expeditions through the app shell, requires every
  saved UI state to equal the domain state, and reloads at each boundary.
- Seeds: elite ladder 11, sold-out 1, boss defeat 3, ledger 12 and 40. Keep the ledger test in
  `tests/unit/campaign-expedition.test.js` near 3 s.

## 11. Balance and tuning inputs

- Probe: first-attempt win rate with the starter deck under three Hold policies: never hold,
  informed (Hold Insight) and blind. The harness was never committed, and `scripts/simulate.js`
  has no Campaign support.
- Starter-deck target bands (measured results: [HISTORY.md](HISTORY.md)): High Court 60–75% under
  every policy; Night Watch 40–55% without Hold and at least 90% with Hold Insight; Ace Sovereign
  20–35% without Hold and 75–90% with it.
- The strongest end-of-route deck lifts the Sovereign to 54% without Hold. Spoils of War doesn't
  help against the High Court. Under no-burn rules elite and boss fights average 210–361
  clashes.

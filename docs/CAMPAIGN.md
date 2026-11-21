# Campaign

Normative reference for Campaign mode; update it in the same PR as the code. General architecture:
[ARCHITECTURE.md](ARCHITECTURE.md). Status, 21.5/21.6 specs and backlog: [ROADMAP.md](ROADMAP.md).

## 1. Model and invariants

`src/domain/campaign-machine.js` owns state, validation and transitions.

- **Run.** `createCampaignRun` opens on `awaitingRoute` without drawing the run RNG;
  `createNewCampaign` (`src/app/new-campaign.js`) seeds it from Web Crypto. Its ruleset,
  `mvp-baseline-v2` or `mvp-no-burn-v2`, is fixed for the run, and so is `encounterRules`: one
  `{nodeId, ruleId}` per fight node in map order (§3).
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
  run RNG: player first. Draw piles start empty, and `encounter.rule` starts as
  `{id, activeClashes: 0, wins: {player: 0, opponent: 0}}` with the fight's assigned rule. A retry
  reshuffles and resets the rule state; nothing else in setup draws.
- **Supply** (`prepareSupply`), player first: a side reveals source index 0 until its source
  empties, then its `encounter.supplyMode` turns `personal` for good, and an empty draw pile
  refills by shuffling its won pile. Source and draw piles are never both non-empty. Stakes and
  attrition burns come through supply too, so they may turn a side personal or recycle.
  Inability draws nothing.
- **Settlement** (`settleContest`) moves the contest, stakes included, to the winner's won pile,
  but under burn rules the loser's cards burn (`contestCardBurns`) unless the winner claims them.
  A revealed player card that no opponent card ties or beats is never lost; stakes and attrition
  can still burn it.
- **Ties** continue inside the same clash step (`resolvePreparedClash`), after any stakes. A side
  that can't supply loses the fight; if neither can, it is drawn and keeps its contest. Stable
  boundaries have an empty `inPlay`.
- **Outcomes.** A fight ends when a side can't supply, or when a race reaches its target (§3). A
  win opens a reward, or at the final node ends in victory without a draft. A loss or draw costs
  the fight's `damage`: at 0 health the run ends in defeat, otherwise `awaitingRetry` refights
  it. Teardown (`commitNodeDecision`) recovers every player card, burned ones too, drops opponent
  cards and keeps Hold.
- **Decisions** (`route`, `retry`, `reward`, `purchase`, `leaveShop`, `event`, `rest`) are journal
  entries (`JOURNAL_ENTRY_KEYS`, `campaign-journal.js`). Each passes `{nodeId, step}` with
  `step === journal.length` (`assertNodeDecision`), so stale or repeated decisions are refused.
  `applyNodeDecision` (`src/app/run-controller.js`) applies one only when `saveStatus` is
  `'saved'`: a retry needs a saved loss or draw.
- **Replay.** `replayCampaignJournal` rebuilds route, coins, cards and modifiers from seed,
  ruleset and journal; `validateCampaignState` requires the run to match and recomputes
  `encounterRules` from the seed. Hold isn't journaled: replay passes `holdOccupied: null`.
  `createCampaignStateFingerprint` is the canonical JSON of the whole run; a pending event's
  `stateFingerprint` must equal it.

| RNG stream | Index | Draws |
| --- | --- | --- |
| run RNG | none | setup shuffles; won-pile recycles in supply order: first reveal round, player stakes, opponent stakes, tie rounds, then attrition |
| `campaign-encounter-rules-v1` | map node index | at run creation, one per fight node: its rule's catalogue index. Other nodes draw nothing |
| `campaign-reward-draft-v1` | `encounterIndex` | one per non-empty slot, in order: new card, deck-edit operation (then its card, if `replace`), modifier. Mend draws nothing |
| `campaign-shop-stock-v1` | map node index | one per non-empty slot, in shop order; a `replace` service draws its card right after the operation |

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

## 3. Modifiers, traits, encounter rules and stacking

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

**Encounter rules** (`campaign-encounter-rules.js`; catalogue in §7) change how a fight plays once
supply turns personal. `assignCampaignEncounterRules` gives every fight one rule at run creation
(RNG table, §1), and a retry keeps it. `encounter.rule` holds `{id, activeClashes, wins}`.

- **Start.** `isEncounterRuleActive` takes the start for the fight's tier (§7): an `either` rule
  is active once either side's `supplyMode` is `personal`, a `both` rule once both are. Each
  clash decided while the rule is active adds 1 to `activeClashes`. That check runs at
  settlement, so a tie across a side's last source card counts; inability endings never advance
  a rule.
- **Race to 10.** Each active clash adds 1 to its winner's `wins`. At the target the fight ends
  with reason `raceTargetReached` and the usual transitions; the loser may still have supply.
- **Double or nothing.** After the first reveal round of an active clash, the player and then the
  opponent stake the same count of face-down cards (`getEncounterStake`): the schedule
  `parameter^activeClashes − 1` (0, 1, 3, 7 and so on), or fewer when the shorter side can't
  supply that many after its first-round reveal. Supply counts the source, draw and won piles.
  The clash that activates the rule stakes nothing, so the coming stake is known before the Hold
  choice, for each choice: a Hold reveal leaves the candidate in its pile, so it may stake one
  more card than a normal reveal. `describeEncounterRule` reports a normal reveal's stake. Stakes
  join the contest before any tie round and settle like reveals, burn effects included. A side
  that has staked its last card can't continue a tie and loses; if both have and they tie, the
  fight is drawn with the stakes on the table.
- **Attrition.** After an active clash, the loser burns its next `parameter` cards through
  supply, under either burn setting. These burns skip `burnSettlement`, so neither Plunder nor
  Spoils of War claims them, and never touch Hold. A side that runs out loses at its next supply.
- **Interactions.** Hold applies to a clash's first reveal, before any stake, so Hold previews and
  the Hold Insight peek stay exact; capture targets are unchanged. Under no-burn rules stakes
  transfer, and attrition is the only burn. Teardown recovers staked and attrition-burned player
  cards.

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
- Fight nodes get their encounter rules when the run is created (`encounterRules`, §3); routes,
  entries and retries never change them.
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

`CAMPAIGN_ENCOUNTER_RULES` lists the rules in draw order, so its order is part of the rules. An
entry may override its start or parameter per fight tier (`resolveEncounterRule`). Double or
nothing waits for both sides at elites and the boss, whose small decks turn personal while the
player still supplies its starting cards. Changing an entry needs a new ID or a Campaign rules
bump.

| Rule | Name | Start | Parameter |
| --- | --- | --- | --- |
| `race-to-ten-v1` | Race to 10 | `both` | target 10 |
| `double-or-nothing-v1` | Double or nothing | `either`; `both` at elites and the boss | stake base 2: 0, 1, 3, 7… cards |
| `attrition-v1` | Attrition | `both` | 2 cards |

## 8. Versions and compatibility

Save schema 9 (`SAVE_SCHEMA_VERSION`, `src/persistence/run-schema.js`), Campaign rules 8
(`CAMPAIGN_GAME_RULES_VERSION`), campaign version 5 (`CAMPAIGN_VERSION`) and Campaign events v7
(`CAMPAIGN_EVENT_VERSION`, `campaign-events.js`). Classic uses rules 2 and events v6; Classic
versions 2–4 stay readable. Both modes share one event-version space, so a new version of either
takes the next free number.

- The rules check in `validateRunSaveVersion` runs before structural validation.
- Campaign saves from schemas 4–8 (rules 3–7) are quarantined as `incompatible-game-rules`
  (`src/persistence/migrations.js`); Classic saves from schemas 4–8 carry over.
- The Classic deck setting does not apply: Campaign decks and comparisons use `standard-52`.
- Campaign events carry instance identities and must match the run fingerprint. Version 7 adds
  `stakes` to `clashSettled` and `clashDrawn` (reveal records, in contest order) and `attrition`
  (`{instanceId, cardId, from}`) to `clashSettled`. Both lists are always present, and an instance
  appears once across reveals, stakes and attrition. Version 5, without the lists, stays readable
  (`isCampaignEventVersion`), but a pending event must be version 7.
- `assertPendingEvent` checks the contest order (first reveal round, stakes, tie rounds), the
  stakes (equal counts, at most the schedule, and fewer only when a side runs out), settlement
  over that order, and a burn-pile suffix of `burned` then `attrition`. A race win ends on
  complete reveal rounds; any other win ends in inability.
- Validation recomputes ties and winners with `compareCards`, so card-value effects need an
  event-version bump. New stored encounter fields need a schema bump or migration, not an event
  bump.

## 9. Constraints for generators (21.5)

`validateCampaignMap` and `validateCampaignFights` (`campaign-map.js`) enforce these. Generators
must satisfy them or revise them explicitly:

- 1–16 nodes (`CAMPAIGN_MAP_NODE_LIMIT`) in stage order, linking only to later stages. Every node
  is reachable and reaches the final node.
- The start, listed first, is a normal fight. The only boss is the final node, listed last.
- Elite twin rule: every elite has a normal fight in its stage that all its predecessors offer.
- A positive bounty or coin gain needs a shop reachable later on at least one route.
- Normal fights field exactly their archetype core. Elite and boss decks cover every rank
  (`uncoveredCampaignRanks`; 2 beats A), or they can't threaten; coverage concerns reveals, since
  stakes and attrition can burn any card. The boss pays no bounty. Traits are elite-only, sorted,
  distinct and on distinct hooks.
- Every fight needs an encounter rule. A generator keeps `campaign-encounter-rules-v1` or
  replaces it under a new stream ID, and `validateCampaignState` must recompute what it stores.
- Events and rests end with an effect-free option. No node heals more than 2
  (`CAMPAIGN_NODE_HEAL_LIMIT`): Mend, vows, events and rests.
- Node order is saved route order and keys `campaign-shop-stock-v1` and
  `campaign-encounter-rules-v1`: reordering changes stock and rules.
- `validateCampaignContent()` takes no arguments and checks the static catalogues at import;
  `validateShops` is private. Generated bundles need a validator that accepts them.
- An opponent-reveal or veil effect would cancel Hold Insight.

## 10. Fixtures and tests

- Current saves are `tests/fixtures/campaign-save-*-v9.json`, built by `CAMPAIGN_SAVE_FIXTURES`
  (`tests/fixtures/campaign-route.js`). Regenerate each with
  `createRunSave(build(), { savedAt: SAVED_AT })` as 2-space JSON with a trailing newline. No
  script exists; `tests/unit/campaign-persistence.test.js` enforces equality.
- Rule saves are gate fights: `race` (seed 8) and `stakes` (seed 0) mid-fight, `stakes-draw`
  (seed 459) drawn with both sides' last cards staked and on the table, and `attrition` and
  `attrition-no-burn` (seed 5) just after their first attrition burns.
- Superseded saves (`campaign-save-v4.json`, `campaign-save-*-v5.json` to `campaign-save-*-v8.json`
  and `campaign-save-route-v6-rules5.json`) stay as quarantine samples.
- `tests/fixtures/expedition-shell.js` drives expeditions through the app shell, requires every
  saved UI state to equal the domain state, and reloads at each boundary.
- Seeds, re-picked for Campaign rules 8: market expedition 2, elite ladder 271, sold-out 144, boss
  defeat 3, ledger 37 and 20. Keep the ledger test in `tests/unit/campaign-expedition.test.js`
  near 3 s.

## 11. Balance and tuning inputs

- Probe: `npm run probe:campaign` (`scripts/campaign-probe.js`) plays first-attempt fights with
  the starter deck through the Campaign machine. It reaches a fight by winning the fights before
  it at once (their opponents' undealt cards move to the player's won pile), taking Mend and
  walking on, then deals the fight from the seed's initial RNG state, as if it were the run's
  first fight. Each encounter rule is seated with the first run seed, from the deal seed upward,
  that assigns it to the fight, so every rule plays the same deals. It reports win, loss and draw
  rates, the share of fights ended at the race target, clashes, and Auto-reveal time
  (`DEFAULT_TIMING_PROFILE`, with a clash's stakes priced as one reveal step and each Attrition
  card as one burn, plus 0.4 s per clash). Hold policies:
  - never: no captures
  - blind: capture the highest eligible card into an empty Hold; play it when the normal card
    is 7 or lower and the held card outranks it
  - informed (Hold Insight): the same capture; play the held card when it beats the opponent's
    next card and the normal card doesn't
- Starter-deck target bands (measured results: [HISTORY.md](HISTORY.md)): High Court 60–75% under
  every policy; Night Watch 40–55% without Hold and at least 90% with Hold Insight; Ace Sovereign
  20–35% without Hold and 75–90% with it.
- Encounter rules keep the Ace Sovereign within these bands under every rule (burn rules, seeds
  0–999). The elites have per-rule bands, set when the rules landed (#54 reports the measured
  rates):
  - High Court: 60–75% under Race to 10 and 30–50% under Double or nothing; under Attrition
    50–65% without Hold and 60–75% with it.
  - Night Watch: at least 90% with Hold Insight under every rule. Without Hold, the rules end
    fights before Plunder's captured cards add up: at least 95% under Race to 10, 60–75% under
    Double or nothing and 70–85% under Attrition.
- Under every rule, each fight ends in a draw at most 15% of the time, and no fight's median
  Auto-reveal time (seeds 0–199) is longer than in the #53 report.
- Tuning levers, in order: a rule's start or parameter, a per-tier override (§7), then which
  fights may draw the rule. Double or nothing stakes are matched (§3): with one-sided short
  stakes, Suit Opposition ended in a draw 18.5% of the time with Hold Insight.
- Before encounter rules, the strongest end-of-route deck lifted the Sovereign to 54% without
  Hold, Spoils of War didn't help against the High Court, and under no-burn rules, without Hold,
  elite and boss fights averaged 210–361 clashes (seeds 0–99). Under no-burn rules every
  encounter rule now ends those fights in a median of 59–78 s of Auto-reveal without Hold (seeds
  0–199).

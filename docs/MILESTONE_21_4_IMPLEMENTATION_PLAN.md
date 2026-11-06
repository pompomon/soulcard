# Milestone 21.4 Encounter Archetypes and Elite Ladder: implementation plan

Source: [`ROGUELIKE_ADVENTURE_RUN_PLAN.md`](./ROGUELIKE_ADVENTURE_RUN_PLAN.md) §21.4 and
its checklist row. Baseline: `main` at `f6ec7b3`, after PR #41 completed 21.3. The 21.3
row stays open until reviewer sign-off, and 21.4 depends on it. Status: **implemented**;
reviewer sign-off pending. This plan was prepared without interactive answers. Each
decision in §5 therefore states a recommended default with its alternatives, and §10
lists the questions that were settled before implementation started. The plan was
approved with every default. §11 records where the delivered code differs. Line anchors
refer to `f6ec7b3`.

## 1. Summary

21.3 delivered:

- the authored `expedition-v1` map: 8 nodes, 5 stages and 8 routes
- fights, shops and events
- a decision journal and guarded `{ nodeId, step }` node decisions
- save schema 6 with Campaign rules 6.

What 21.3 does not have:

- Fights have no identity beyond their cards, and the final fight is an ordinary fight.
- Health recovers only through Mend (+1), the shrine offering (+2) and the vows (+2).
- The modifier catalogue holds only player modifiers.

21.4 asks for "strategic route risk through authored enemy identity and a full campaign
finale". This plan delivers:

1. **An elite ladder on a new map.** `expedition-v2` has 7 stages, 12 nodes and 24
   routes. Stages 3 and 5 each offer a normal fight or its elite twin. Stage 4 adds an
   optional rest, and a fixed rest comes before the boss.
2. **Archetypes.** Four authored archetypes (Suit Legion, Court, Watch and Sovereign)
   give every fight a core deck. Elites add covering cards and one opponent trait.
3. **Opponent traits.** Two encounter-only, opponent-owned catalogue entries: Court
   Etiquette changes Hold eligibility and Plunder changes burn settlement. A versioned
   stacking rule specifies how they combine with player modifiers.
4. **Rest nodes.** A new `rest` node kind with two sites. Each trades healing against a
   deck edit.
5. **A boss and reward tiers.** The Ace Sovereign replaces the Ace Assembly. Elite
   drafts offer a high-rank card and Greater Mend (+2). A per-node limit of 2 bounds
   every heal.
6. **Versions.** Campaign rules 7, campaign version 4 and save schema 7. In-progress
   schema-6 Campaign saves are quarantined; Classic saves carry over unchanged.

A probe finding shapes the content (§2.2). Under burn rules, only the clash loser's
cards burn, so a player card that no opponent card ties or beats can never be lost.
The starter deck therefore always wins today's Royal Court, Watch of Tens and Ace
Assembly; its 2s beat the aces. Elite and boss decks must cover every rank.

Eleven work packages (WPs) deliver the milestone in one PR.

## 2. Baseline evidence (Node 24.22.2)

- `npm test`: 449 pass, 0 fail, in 21.0 s on a 2-CPU host.
- `npm run build`: passes. The existing warning about chunks over 500 kB (771 kB) is
  unchanged.
- The working tree is clean at `f6ec7b3`.

### 2.1 Balance probes

Method:

- A throwaway copy of `src` was used outside the repository.
- Each candidate deck replaced the gate opponent.
- The player used the starter deck (♦ + ♥, 26 cards).
- Values are first-attempt win rates in percent.
- Burn cells use seeds 0–199; no-burn cells use seeds 0–99.

Player policies:

- `none`: never uses Hold.
- `insight`: starts with Hold Insight and makes informed Hold choices.
- `blind`: captures its highest card, then plays Hold when the normal candidate is 7 or
  lower and the held card is higher.

Burn ruleset (the default):

| Opponent deck | none | insight | blind | With a trait |
| --- | --- | --- | --- | --- |
| S + C (today's Suit Opposition) | 41.5 | 78.5 | 34 | Plunder: none 34.5 |
| J, Q, K (today's Royal Court) | 100 | 100 | | |
| 8, 9, 10 (today's Watch of Tens) | 100 | 100 | | |
| A (today's Ace Assembly) | 100 | | | |
| J, Q, K + A♠ | 88.5 | 94 | | |
| **J, Q, K + A♠ A♣ (High Court)** | 65 | 84 | 25.5 | Etiquette: insight 70.5, blind 63.5. Plunder: none 22.5 |
| J, Q, K, A | 24 | 77.5 | | |
| 8, 9, 10 + A♠ | 98 | 100 | | |
| **8, 9, 10 + A♠ A♣ (Night Watch)** | 70.5 | 96 | 80 | Plunder: none 45.5, insight 93.5 |
| 7–10 + A♠ A♣ | 65 | 99 | | |
| **K, A (Ace Sovereign)** | 26 | 84.5 | 11.5 | Plunder: none 6.5, insight 72.5 |
| Q, K, A | 20 | 73 | 7 | |
| A, 2 | 97.5 | | | |
| 10, J, Q, K, A | 28.5 | | | |

Court Etiquette cannot change the `none` result, because that policy never holds.

No-burn ruleset:

| Opponent deck | none | insight | blind |
| --- | --- | --- | --- |
| S + C | 55.5 | 100 | |
| J, Q, K | 71 | | |
| 8, 9, 10 | 94.5 | | |
| A | 46 | | |
| J, Q, K + A♠ | 55 | | |
| J, Q, K + A♠ A♣ | 53 | 100 | |
| 8, 9, 10 + A♠ | 75 | | |
| 8, 9, 10 + A♠ A♣ | 69 | 100 | |
| 7–10 + A♠ A♣ | 67 | | |
| K, A | 36 | 99 | 23 |

Fights averaged 26–53 clashes with burn and 45–650 without it, and 0–9 % of fights
were draws.

The probe harness is not committed, because complete-campaign simulation tooling
belongs to 21.5. WP11 re-runs it against the final content and records the results in
§11.

### 2.2 Findings

1. **Burn invulnerability.**
   - Only cards supplied by the clash loser burn (campaign-modifiers.js:251-258,
     settled at campaign-machine.js:1221-1243). A player card that no opponent card
     ties or beats is never lost.
   - J, Q, K and 8, 9, 10 cannot beat the starter deck's aces. Its 2s beat a lone-ace
     deck (cards.js:40-49 `compareCards`). Those three fights cannot be lost.
   - A deck *covers* a rank when it holds a card that ties or beats that rank.
     Covering every rank is necessary but not sufficient: A, 2 covers every rank and
     still loses 97.5 % of fights.
   - The 21.3 ledger's only scripted defeat (at the finale) happens because scripted
     removals strip the 2s.
2. **Hold needs judgment.** Against strong decks, blind Hold play does worse than never
   holding: 25.5 against 65 at the High Court, and 11.5 against 26 at K, A. On the
   three bold decks without traits, informed play gains 19–58.5 points over never
   holding.
3. **Traits create identities.**
   - Court Etiquette flattens the High Court to 63.5–70.5 % for every policy, so Hold
     stops being the answer.
   - Plunder punishes passive play (Night Watch 70.5 → 45.5) but barely touches
     informed play (96 → 93.5), so Hold becomes the answer.
4. **A "veil" trait would erase Hold Insight.** Hiding the opponent's next card removes
   Insight's whole advantage, which leaves a drafted modifier dead for an encounter.
   It is deferred (D4).
5. **Boss attempts at damage 2.** A retry needs `health − damage > 0`
   (campaign-journal.js:288-299), so health on arrival sets the number of attempts.
   The victory chances below assume independent attempts:

   | Health on arrival | Attempts | Victory at p = 0.26 (`none`) | Victory at p = 0.845 (`insight`) |
   | --- | --- | --- | --- |
   | 5 | 3 | 59 % | 99.6 % |
   | 3–4 | 2 | 45 % | 97.6 % |
   | 1–2 | 1 | 26 % | 84.5 % |

   Rest before the boss is therefore a real strategic choice.

### 2.3 RNG accounting

- **Counting draws.**
  - RNG snapshots are `{ algorithm, seed, state }`. Each Mulberry32 draw adds
    `0x6D2B79F5` to `state` (rng.js:29-40).
  - The number of draws between two snapshots is
    `Math.imul((after.state - before.state) >>> 0, 0xDC58AA5D) >>> 0`.
    `0xDC58AA5D` is the inverse of `0x6D2B79F5` modulo 2³²; their product was verified
    to be 1.
  - Shuffling n items uses max(n − 1, 0) draws.
- **Where the main stream advances.** Only in two places:
  - `setUpEncounter` (campaign-machine.js:1074-1103) shuffles the non-held player
    layout, then the opponent deck. Retries call it again.
  - `prepareSupply` (:1156-1176) shuffles a side's won pile into its draw pile when
    that side must reveal from an empty draw pile. This includes the moment its source
    pile runs out. Each side shuffles at most once per step.
- **Other streams.**
  - Reward drafts use the derived stream `campaign-reward-draft-v1`, keyed by
    `encounterIndex`.
  - Shop stock uses `campaign-shop-stock-v1`, keyed by node index.
  - Events draw nothing.

A test can therefore audit every step's draws exactly from the saved snapshots,
without instrumenting the RNG (D9).

## 3. What exists

| Area | Implementation | Evidence |
| --- | --- | --- |
| Versions | `CAMPAIGN_VERSION` 3 and `CAMPAIGN_GAME_RULES_VERSION` 6. Campaign events are v5 and Classic events v4. `SAVE_SCHEMA_VERSION` is 6. | campaign-machine.js:55-56; campaign-events.js:3; events.js:7; run-schema.js:8 |
| Save carry | `CARRIED_SCHEMAS` is [4, 5]. Carried Classic saves migrate unchanged. Carried Campaign saves throw `UnsupportedGameRulesVersionError` and are quarantined as `incompatible-game-rules`. | migrations.js:8-13, 56-90 |
| Map | `expedition-v1`. Nodes are `{ id, stage, kind, contentId, next }` and kinds are fight, shop and event. Limit of 16 nodes. One start; one final fight, listed last. Events that grant coins need a later shop. | campaign-map.js:24-50, 192-253 |
| Fights | Shape `{ id, name, opponentCardIds, damage, bounty }`. Four fights with no archetype, tier or traits. | campaign-content.js:24-56 |
| Health | Starts at 3, maximum 5 (`vitality-cap-v1`). Mend +1, shrine offering +2, each vow +2 on gain. `heal` caps at the maximum. | campaign-content.js:19-20, 60, 115; campaign-modifiers.js:63-95; campaign-journal.js:212-214 |
| Modifiers | Six player entries sorted by ID, with five hooks and campaign or encounter lifetimes. Active records are hook-distinct. There is no owner field and no hook/effect consistency check. | campaign-modifiers.js:13-19, 29-96, 98-149, 176-188 |
| Hold and burn hooks | `narrowHoldTargets` and `contestCardBurns` read only the player's records | campaign-modifiers.js:251-276; campaign-machine.js:713, 1226, 1491 |
| Encounter | Keys [id, name, damage, supplyMode, zones, outcome]; the metadata must match the content. Zone checks ignore provenance except for source piles, the layout and Hold. | campaign-machine.js:124-131, 341-433, 443-452 |
| Rewards | Derived stream with one draw per non-empty slot, in order: new card, edit operation, replacement card, modifier. Mend is appended without a draw. | campaign-rewards.js:15, 34-90 |
| Node decisions | States `awaitingRoute`, `awaitingShop` and `awaitingEvent`. Decisions require `{ nodeId, step === journal.length }`. | campaign-machine.js:63-67, 1575, 1602-1640 |
| Journal | Entry types route, retry, reward, purchase, leaveShop and event. Any unknown type falls through to `applyEvent`. The final fight takes no reward. | campaign-journal.js:40-75, 313-315, 412-425 |
| Retry and completion | A retry needs `health − damage > 0`. Winning the final node sets `{ result: 'victory', reason: 'campaignCompleted' }`. | campaign-journal.js:288-299; campaign-machine.js:1257-1283 |
| Fingerprint | Hashes the whole run apart from the fingerprint itself | campaign-machine.js:632-642 |
| UI | 'Final fight' label; route, fight, reward, shop and event overlays. The end text reads "You won the final encounter of the expedition." | campaign-view.js:53, 62-63, 271, 311-316; overlays.js:291, 565-569 |
| Tests | Expedition ledger over 8 routes × 2 policies (2.3 s). Every-boundary save/resume with seeds 0, 2, 6 and 1. Seven v6 Campaign fixtures, with a regeneration test. | campaign-expedition.test.js:361-433; campaign-persistence.test.js:128, 356-359; campaign-route.js:338-346 |

## 4. Acceptance traceability

| # | Criterion | Existing evidence | Gap | WP |
| --- | --- | --- | --- | --- |
| S1 | Deterministic archetypes and elite definitions, built from opponent decks and encounter-only modifiers rather than presentation-side randomness | Four authored fights with fixed decks | No archetype, tier or trait model; three of the four fights cannot be lost (§2.2) | WP1, WP3 |
| S2 | Rest nodes, elite rewards and a fixed boss; reward tiers and health recovery limits | The final fight completes the campaign; Mend +1; `heal` caps at the maximum | No rest kind, reward tier, boss content or per-source limit | WP1, WP2, WP4 |
| S3 | The catalogue grows only where ownership, expiry, stacking and Hold interaction are specified | Hook-distinct player modifiers with two lifetimes | No owner field, no rule for opponent stacking, no hook/effect check | WP3 |
| A1 | A player can choose normal or elite risk, use rest strategically, defeat a boss, or lose through health depletion | Defeat by health depletion exists | Elite choice, rest and the boss | WP1, WP2, WP4, WP8, WP9 |
| A2 | Enemy and modifier effects cannot change RNG consumption accidentally or bypass card-instance conservation | Conservation ledger at every step | No RNG audit; traits move cards between sides | WP3, WP7 |
| A3a | Tests: each archetype | None | New | WP1, WP7 |
| A3b | Tests: elite and boss rewards | The final fight takes no reward | Elite draft tier; boss completion | WP4 |
| A3c | Tests: modifier stacks and expiry | Hook-distinct records; Spoils of War expiry | Player × trait matrices; trait expiry and retry | WP3 |
| A3d | Tests: health recovery | Mend, shrine offering and vows | Rest, Greater Mend, the limit and the cap | WP2, WP4 |
| A3e | Tests: retry behavior | Guarded retry (21.3) | Attempts at damage 2; traits recreated on retry; plundered cards restored | WP3, WP4, WP8 |
| A3f | Tests: deterministic full-campaign replay | Seeds 3 and 6 replayed on v1 | v2 routes with elites, rests and the boss | WP7 |
| A3g | Tests: save/resume | Every boundary on v1; 7 fixtures | Rest, elite and boss boundaries; v7 fixtures; schema-6 quarantine | WP5, WP7, WP8, WP9 |
| Delivery rules | Any new event or save shape has an explicit version and a migration or recovery policy | None | Rules 7, campaign version 4 and schema 7, with policy, tests and docs | WP5, WP10 |
| Evidence | Completion evidence and the checklist | None | §21.4 evidence, README and roadmap | WP10, WP11 |

## 5. Decisions (proposed; see §10)

### D1. Elite risk is a route choice

**Change:** each elite is its own map node, next to a normal fight in the same stage.
The player commits to it with the existing `chooseCampaignRoute` decision, so no new
decision or journal type is needed. Before the choice, the fight detail on the route
map shows:

- the tier and archetype
- the deck, damage and bounty
- any traits
- the reward tier.

**Why:** risk shown on the map is the "strategic route risk" that the goal names. The
route decision is already guarded, journaled, saved and replayed.

**Alternatives:** an "accept elite" toggle on a fight node. That needs a new guarded
decision, journal type and saved boundary before the fight, and it hides the risk from
route planning.

### D2. Authored map `expedition-v2`

**Change:** replace `expedition-v1` (campaign-map.js:36-50) with:

| Index | Node | Stage | Kind | Content | Next |
| --- | --- | --- | --- | --- | --- |
| 0 | gate | 1 | fight | suit-opposition | market, shrine |
| 1 | market | 2 | shop | wayside-market | court, high-court |
| 2 | shrine | 2 | event | crossroads-shrine | court, high-court |
| 3 | court | 3 | fight | royal-court | bazaar, vault, camp |
| 4 | high-court | 3 | fight (elite) | high-court | bazaar, vault, camp |
| 5 | bazaar | 4 | shop | ember-bazaar | watch, night-watch |
| 6 | vault | 4 | event | oathkeepers-vault | watch, night-watch |
| 7 | camp | 4 | rest | roadside-camp | watch, night-watch |
| 8 | watch | 5 | fight | watch-of-tens | sanctum |
| 9 | night-watch | 5 | fight (elite) | night-watch | sanctum |
| 10 | sanctum | 6 | rest | last-light-sanctum | finale |
| 11 | finale | 7 | fight (boss) | ace-sovereign | none |

Route shape:

- There are 24 routes (2 × 2 × 3 × 2) and 21 links.
- Every route has 7 nodes, 4 fights, 0–2 elites and 1–2 rests, and it alternates a
  fight with a shop, event or rest.
- `CAMPAIGN_STAGE_COUNT` becomes 7 automatically (campaign-map.js:276).
- `CAMPAIGN_FINAL_NODE_ID` stays `finale`.

Validator additions to `validateCampaignMap` (:192-253):

1. `rest` is a node kind (:24), and `contentFor` (:52-56) resolves rest sites.
2. The start node is a normal-tier fight.
3. The final node is the only boss-tier fight. This extends the rule at :231-234.
4. **Elite twin rule:** every elite has a normal fight in the same stage, and every
   predecessor of the elite also links to that normal fight. Declining an elite is then
   always possible.
5. **Bounty rule:** a fight with a positive bounty must reach a later shop. This mirrors
   the event-coin rule at :242-251. As a result, the Watch of Tens bounty changes from 2
   to 0, because no shop follows stage 5.
6. The 16-node limit (:32) is kept.

**Why:**

- Two elite choices give a 0-, 1- or 2-elite ladder.
- At stage 4 the player can trade a shop or an event for an extra rest. The fixed
  sanctum guarantees one recovery before the boss, so the D6 limits decide how many
  boss attempts the player gets (§2.2, item 5).
- Node order keeps gate, market, shrine, court, bazaar and vault at their v1 indices
  (0, 1, 2, 3, 5 and 6). Shop stock is keyed by node index, so stock for a given seed is
  unchanged. The fixture builders' paths (gate → market or shrine → court → bazaar)
  therefore replay identically up to the bazaar.

**Edge-covering routes:** together, these six routes use all 21 links. All of them end
sanctum → finale.

1. gate → market → court → bazaar → watch
2. gate → shrine → court → vault → night-watch
3. gate → market → court → camp → watch
4. gate → shrine → high-court → bazaar → night-watch
5. gate → market → high-court → vault → watch
6. gate → shrine → high-court → camp → night-watch

**Cost:**

- The map has three times as many routes as v1, so the ledger test is split (D9).
- Tests contain up to about 39 references to `ace-assembly`, `finale`, `watch` or
  `expedition-v1` (grep counts). The node IDs `finale` and `watch` keep their names, so
  many of those references survive.

**Alternatives:**

- **A five-stage map:** gate → market or shrine → court or high-court → bazaar, vault or
  camp → finale. It has 12 routes, one elite choice, 3 fights per route and no
  guaranteed rest. There is less churn, but the ladder is thin.
- **A stage-6 choice between the sanctum and a shop:** 48 routes. It adds strategy and
  gives stage-5 bounties a use, but doubles the test matrix.

### D3. Archetypes, elites and the boss

**Change:** add `CAMPAIGN_ARCHETYPES` to campaign-content.js. Each entry is
`{ id, name, description, coreCardIds }`, with the cores built from the existing
`bySuits` and `byRanks` helpers (:11-17):

| ID | Name | Core | Cards |
| --- | --- | --- | --- |
| legion | Suit Legion | `bySuits('S', 'C')` | 26 |
| court | Court | `byRanks('J', 'Q', 'K')` | 12 |
| watch | Watch | `byRanks('8', '9', '10')` | 12 |
| sovereign | Sovereign | `byRanks('K', 'A')` | 8 |

Each fight gains `archetypeId`, a `tier` (`normal`, `elite` or `boss`) and `traitIds`:

| Fight | Name | Archetype | Tier | Deck (canonical order) | Cards | Damage | Bounty | Traits |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| suit-opposition | Suit Opposition | legion | normal | core | 26 | 1 | 3 | none |
| royal-court | Royal Court | court | normal | core | 12 | 1 | 4 | none |
| high-court | High Court | court | elite | core + `c-AS`, `c-AC` | 14 | 2 | 6 | court-etiquette-v1 |
| watch-of-tens | Watch of Tens | watch | normal | core | 12 | 1 | **0** (was 2) | none |
| night-watch | Night Watch | watch | elite | core + `c-AS`, `c-AC` | 14 | 2 | 0 | plunder-v1 |
| ace-sovereign | Ace Sovereign | sovereign | boss | core | 8 | 2 | 0 | none |

`ace-assembly` is removed.

Additions to `validateFights` (campaign-map.js:64-85):

- The archetype exists and the tier is known.
- `opponentCardIds` are distinct and in canonical deck order.
- A normal deck equals its core, and an elite or boss deck contains its core.
- Elite and boss decks cover every rank (§2.2).
- The boss bounty is 0.
- `traitIds` are sorted and distinct, refer to opponent-owned catalogue entries, and
  share no hook. In 21.4, traits appear only on elite fights.

Opponents make no choices. Their behaviour comes entirely from deck construction and
traits, and nothing is decided on the presentation side or at random.

**Why** (from §2.1):

- **High Court with Etiquette:** 63.5–70.5 % for every policy. It is risky whatever the
  player does, so the bounty of 6 and the elite reward are the incentive.
- **Night Watch with Plunder:** 45.5 % for passive play and 93.5 % with Insight. It
  rewards a Hold build.
- **Ace Sovereign:** 26 % passive, 84.5 % informed and 11.5 % blind. With 1–3 attempts
  (§2.2), arriving healthy and with Insight matters.
- Normal fights stay unchanged, so declining an elite is the safe path. Suit Opposition
  remains a real fight (41.5 %).

**Balance bands** (first-attempt starter-deck win rate with the §2.1 harness; WP11
re-measures them and records the results in §11):

- High Court: 60–75 % for every policy.
- Night Watch: 40–55 % with `none`, and at least 90 % with `insight`.
- Ace Sovereign: 20–35 % with `none`, and 75–90 % with `insight`.

**Cost:**

- The Watch of Tens bounty becomes 0.
- Fixtures and tests that name `ace-assembly` change.

**Alternatives:**

- **Keep a covering ace boss:** A, 2 covers every rank, but the player wins 97.5 %.
- **A Q, K, A boss:** 20 / 73 / 7, which is harsher.
- **A J, Q, K, A boss:** 24 / 77.5, with 16 cards and longer fights.
- **Riskier normal fights:** see §10, question 4.

### D4. Opponent traits in the modifier catalogue

**Change:** every catalogue entry gains `owner: 'player' | 'opponent'`. The six
existing entries become `'player'`. Two opponent entries are added in sorted-ID
positions (campaign-modifiers.js:29-96). The resulting order is court-etiquette-v1,
hold-insight-v1, plunder-v1, spoils-of-war-v1, vitality-cap-v1, then the three vows.

| Field | `court-etiquette-v1` (Court Etiquette) | `plunder-v1` (Plunder) |
| --- | --- | --- |
| description | "Opponent trait. In this encounter, an empty Hold can capture only a 2–10, and an occupied Hold can be replaced only by a 2–10." | "Opponent trait. Clashes this opponent wins send your cards to its won pile instead of burning them. They return to your deck after the encounter." |
| lifetime | `encounter` | `encounter` |
| hooks | `holdCaptureEligibility`, `holdReplacementEligibility` | `burnSettlement` |
| effect | `{ type: 'capture-ranks', ranks: ['2', …, '10'] }` | `{ type: 'winner-claims-burns', winner: 'opponent' }` |
| draftable / applicability / healthOnGain | `false` / `null` / 0 | `false` / `{ burnEnabled: true }` / 0 |

`narrowHoldTargets` applies an effect by its type, whichever hook triggered it, so
`capture-ranks` also works on the replacement hook without new effect code.

Pools and draws are unaffected. `modifierGainBlocker` returns `'not-draftable'` first
(:214-224), so the draft, shop and event pools (:228-238) stay identical. Reward and
shop draws index those pools, so they are unchanged as well.

**Catalogue validation** (`validateModifierCatalogue`, :98-149):

- `owner` is `player` or `opponent`.
- Opponent entries have lifetime `encounter`, `draftable: false` and `healthOnGain` 0.
  Their hooks must come from `holdCaptureEligibility`, `holdReplacementEligibility` and
  `burnSettlement`.
- **Hook/effect consistency** (new for every entry):
  - `burnSettlement` requires `winner-claims-burns` with `winner === owner`.
  - The Hold eligibility hooks require `capture-from-zones`, `capture-ranks` or
    `replacement-not-weaker`. The last is valid only on the replacement hook.
  - `holdDecision` requires `informed-hold-choice`.
  - `maximumHealth` requires `maximum-health`.
- `healthOnGain` must not exceed `CAMPAIGN_NODE_HEAL_LIMIT` (D6).

**Storage and lifetime:**

- `ENCOUNTER_KEYS` (campaign-machine.js:124-131) gains `tier` and `traitIds`.
- `setUpEncounter` (:1074-1103) copies the fight's tier and its traits that apply under
  the run's ruleset (`isModifierApplicable`, :206-209). Plunder is therefore absent
  under the no-burn ruleset.
- `assertEncounterShape` (:443-452) requires both fields to match the content, as it
  already does for `name` and `damage`.
- Traits exist exactly while their encounter does. They are removed at teardown and
  recreated unchanged on retry.
- Traits never enter `activeModifiers`, the journal, reward pools, shop stock or event
  options. Opponent IDs are refused by:
  - `assertActiveModifiers` (:270-287)
  - `createModifierRecord` (campaign-modifiers.js:167-170)
  - the journal's `gainModifier` (campaign-journal.js:246-250)
  - event validation (campaign-map.js:135-139, which already requires draftable
    modifiers; this adds an explicit owner message).

**Stacking rule (Campaign rules 7):**

- Player records stay hook-distinct (`assertDistinctModifierHooks`, :176-188).
- A hook may carry at most one player modifier and at most one opponent trait. Traits
  on the same fight are hook-distinct.
- **Hold eligibility:** start from the unrestricted targets, apply the player filter,
  then the trait filter. Filters only remove targets, so the order does not matter and
  the result may be empty. The new signature is
  `narrowHoldTargets({ activeModifiers, traitIds }, targets, heldCardId)`.
- **Burn settlement:** the effect whose `winner` matches the clash winner applies. A
  player effect always names `player` and a trait always names `opponent`, so at most
  one applies per clash. The new signature is
  `contestCardBurns({ ruleset, activeModifiers, traitIds, winner, suppliedBy })`.
  As delivered, a trait on the hook also suspends the player's modifier for the
  encounter, so Plunder makes Spoils of War inapplicable (R7, §11).
- **Call sites:** `contestCardBurns` is called at campaign-machine.js:713
  (`assertPendingEvent`) and :1226 (`settleContest`). `narrowHoldTargets` is called at
  :1491 (`getEligibleHoldTargets`).

**Hold interactions with Court Etiquette:**

| Player modifier | Capture | Replacement |
| --- | --- | --- |
| None | 2–10 in the player's piles | 2–10 |
| Vow of the Court (captures only J–A) | Nothing. The overlay shows its empty-target text and a trait note. | 2–10 |
| Vow of Patience (captures only from the won pile) | 2–10 in the won pile | 2–10 |
| Vow of Constancy (replacement not weaker) | 2–10 | 2–10 cards that do not lose to the held card |
| Hold Insight | Unaffected (`holdDecision`) | Unaffected |

Court Etiquette never evicts a card already held. A held J–A stays in Hold and can still
be played.

**Burn interactions** (burn ruleset; cards supplied by the winner never burn):

| Clash winner | Neither | Spoils of War only | Plunder only | Both |
| --- | --- | --- | --- | --- |
| Player | Opponent-supplied cards burn | They go to the player's won pile | They burn | They burn: Plunder suspends Spoils of War (R7, §11) |
| Opponent | Player-supplied cards burn | They burn | They go to the opponent's won pile | They go to the opponent's won pile |

Under the no-burn ruleset, both effects are inapplicable and nothing burns.

**Conservation:**

- Plundered cards keep `campaignOwner: 'player'`.
- The opponent may reveal them later, and they burn if the opponent then loses with
  them.
- Hold capture ignores them, because it scans only the player's piles (:1468-1480).
- Zone checks allow any provenance outside the source piles, the layout and Hold
  (:341-433). The layout keeps every non-held player instance, so teardown returns
  every plundered card. This mirrors Spoils of War in the other direction.

**RNG:**

- Traits draw nothing.
- Their only effect on RNG is indirect: Plunder enlarges the opponent's won pile, and
  Etiquette changes which card is held. Both change later shuffle sizes in the way
  §2.3 documents. The D9 per-step RNG ledger asserts exactly that formula.

**Events:** Campaign events stay at v5. The state fingerprint hashes the whole run
(:632-642), so it binds `tier` and `traitIds` without an event-contract change.

**Deferred to 21.5** (recorded as non-goals in the §21.4 evidence). These are the
scope's remaining examples:

- **Opponent-reveal access**, such as a veil hiding the opponent's next card. It would
  cancel Hold Insight (§2.2, item 4).
- **Recycle order:** the order in which won piles are recycled.
- **Card-value effects.** Committed v5 events are validated by recomputing ties and
  winners with `compareCards` (campaign-events.js:148, 222, 306), so changing clash
  comparison needs an event-contract bump.
- Traits on normal or boss fights, and procedurally selected traits.

**Cost:**

- Two function signatures change, with three call sites.
- The stored encounter shape grows.
- One test matrix is added.

**Alternatives:**

- **A separate trait catalogue:** simpler validation, but it duplicates the hook
  machinery and the stacking rules. §21.4 asks to "expand the modifier catalogue".
- **Traits as `activeModifiers` records:** these would collide with Spoils of War on
  `burnSettlement`, enter the journal and replay, and blur ownership.

### D5. Rest nodes as a dedicated node kind (option R3)

**Change:**

- **Machine and journal:** a new node kind `rest`, journal phase `rest` and machine
  state `awaitingRest`. The run gains a `restSite: { nodeId, siteId }` key, and the
  journal gains a `rest` entry type with the same keys as event entries:
  `type, nodeId, optionId, targetInstanceId, createdInstanceId`.
- **Content:** `CAMPAIGN_REST_SITES` in campaign-content.js. Options use the same shape
  as event options, the `WALK_ON` keys at :83-93.

  | Site | Options |
  | --- | --- |
  | `roadside-camp` "Roadside Camp" | `rest`: restore 2 health. `train`: duplicate a chosen card (`deckEdit: { kind: 'duplicate', cardId: null }`). `walk-on`. |
  | `last-light-sanctum` "Last Light Sanctum" | `rest`: restore 2 health. `cleanse`: remove a chosen card (`deckEdit: { kind: 'remove', cardId: null }`). `walk-on`. |

- **Rest-site validation:** a new `validateRestSites` in campaign-map.js, mirroring
  `validateEvents` (:142-178). Every option has:
  - no health or coin cost
  - no surrender, modifier or coin gain
  - `healthGain` between 0 and `CAMPAIGN_NODE_HEAL_LIMIT`
  - `deckEdit` is `null`, or has kind `duplicate` or `remove` with `cardId: null`.

  Each option other than Walk on either heals or edits, never both. The last option is
  `WALK_ON`.
- **Blockers:** options reuse `eventOptionBlocker` (campaign-node-events.js:7). Because
  rest options have no costs, only the deck-edit blockers can fire: `deck-full`,
  `copy-limit`, `deck-minimum` and `no-eligible-card`.
- **Full health:** resting at full health is allowed and changes nothing, which is the
  same as Mend. The rest view shows a note in the style of Mend's text
  (campaign-view.js:146-147).
- **APIs:** `getCampaignRestOptions(input)`,
  `getCampaignRestTargets(input, optionId)` and
  `chooseCampaignRestOption(input, { nodeId, step, optionId, targetInstanceId })`. They
  share helpers with the event APIs (campaign-machine.js:1814-1889). The controller
  gains `chooseRestOption`, gated through `applyNodeDecision` (run-controller.js:474).

**Why:**

- At stage 4, the camp competes with the bazaar and the vault.
- At each rest node, healing competes with a deck edit: train before the stage-5 fight,
  or cleanse before the boss. That is "use rest strategically".
- A dedicated kind keeps "no costs, bounded heal" as a validated invariant, and gives
  the map and journal a distinct label.

**Cost:**

- One machine state, one run key and one journal type.
- An overlay mode and a HUD handler.
- All of it is covered by the schema bump (D8).

**Alternatives:**

- **R1: rest sites as event content.** No machine work, but the map labels them
  "Event", nothing guarantees they are cost-free, and the limits in D6 would rely on
  convention.
- **R2: a `rest` node kind that reuses `nodeEvent`, `awaitingEvent` and `event`
  entries.** Less code, but the state names and journal types no longer say what
  happened.

### D6. Recovery limits

**Change:** add `CAMPAIGN_NODE_HEAL_LIMIT = 2` to campaign-content.js. Maximum health
stays at 5, and `heal` keeps capping at the maximum (campaign-journal.js:212-214).

| Source | Heal | Validated at |
| --- | --- | --- |
| Mend (normal reward) | +1 | `CAMPAIGN_MEND_HEALTH_BY_TIER` |
| Greater Mend (elite reward) | +2 | `CAMPAIGN_MEND_HEALTH_BY_TIER` |
| Rest (both rest sites) | +2 | `validateRestSites` |
| Shrine offering | +2 | `validateEventOption` (campaign-map.js:111-140) |
| Vows of Constancy, Patience and the Court | +2 on gain | `validateModifierCatalogue` |
| Victory, retry, Hold or the boss | 0 | Not applicable |

**Why:** each node can restore at most 2 health. A route's best case can then be
counted directly from the map, and the D3 balance holds whatever the route.

**Alternatives:**

- Leave the limits as convention, unvalidated.
- Heal fully at the sanctum. That removes the trade-off and makes boss attempts
  constant.

### D7. Reward tiers

**Change:**

- **Normal fights:** the draft is unchanged. It offers a new card from every unowned
  card, a deck edit, a modifier and Mend (+1).
- **Elite fights:**
  - The new-card pool is limited to unowned J, Q, K and A cards. When none are
    unowned, it falls back to every unowned card.
  - Mend restores 2 health. The offer keeps `offerId` and `kind` `mend` and is shown as
    "Greater Mend".
  - The draft uses the same stream, key, slot order and draw count. Only the contents
    of the new-card pool differ.
- **The boss:** no draft. Victory completes the campaign through the existing
  final-node path: campaign-journal.js:313-315 and campaign-machine.js:1264. The
  validator guarantees the boss is the only final node (D2). The end text becomes "You
  defeated the Ace Sovereign and completed the expedition."

**Plumbing:**

- `CAMPAIGN_MEND_HEALTH` (campaign-content.js:60) becomes
  `CAMPAIGN_MEND_HEALTH_BY_TIER = { normal: 1, elite: 2 }`.
- `generateRewardDraft` (campaign-rewards.js:37-90) takes `tier`.
- `createRewardDraft` (campaign-machine.js:822-830) and `assertPendingReward`
  (:832-853) pass the active fight's tier.
- The journal's `regenerateRewardDraft` (:301-309) derives the tier from the active
  node.
- The Mend heal (:334) and its offer text (campaign-view.js:146-147) read the tier.
- `pendingReward` keeps its stored shape.

**Why:** the elite reward has to justify a 2-damage risk. It does so with a stronger
card and a bigger heal, and the draft stays byte-identical for normal fights.

**Alternatives:**

- An extra elite slot, such as a second card. That changes the slot count and draw
  order.
- A coins-only reward. That is useless after stage 4, because no shop follows.

### D8. Versions and save compatibility

**Change:**

| Item | Today | 21.4 | Reason |
| --- | --- | --- | --- |
| Map ID (campaign-map.js:39) | `expedition-v1` | `expedition-v2` | New node set (D2) |
| `CAMPAIGN_GAME_RULES_VERSION` (campaign-machine.js:56) | 6 | **7** | Rule semantics change: content, trait stacking, rests, reward tiers and the heal limit |
| `CAMPAIGN_VERSION` (:55) | 3 | **4** | Stored run shape changes: `restSite`, `encounter.tier`, `encounter.traitIds` and the `rest` journal type |
| `SAVE_SCHEMA_VERSION` (run-schema.js:8) | 6 | **7** | `CAMPAIGN_MATCH_KEYS` (:36-59) gains `restSite`; a new stored machine state is added |
| Campaign event version | 5 | 5 | Event payloads are unchanged; the fingerprint binds the new fields (D4) |
| Classic events and rules | 4 and 2 | Unchanged | Classic play is untouched |

Persistence policy (migrations.js):

- `CARRIED_SCHEMAS` (:13) becomes `[4, 5, 6]`, and the comment at :8-12 is updated.
- Carried Classic saves migrate unchanged; only `saveSchemaVersion` is rewritten.
- Carried Campaign saves throw `UnsupportedGameRulesVersionError` (:56-71). They are
  quarantined as `incompatible-game-rules`, as 21.3 did for schemas 4 and 5, and the
  player starts a new campaign through the existing recovery path.
- Schema 7 records with another Campaign rules version are quarantined the same way
  (run-schema.js:247-286).
- Schemas 8 and above stay `unsupported-save-version`.

**Why:**

- The roadmap versions stored-shape, rule-semantic and event-contract changes
  separately (IMPLEMENTATION_ROADMAP.md:11-15), and the run-plan's delivery rules
  require an explicit version and a migration or recovery policy for any new save
  shape. This change touches the first two.
- A schema-6 Campaign run cannot continue faithfully. Its route uses v1 nodes (`watch`
  is at stage 3), and replaying its journal under rules 7 meets different content (no
  Ace Assembly, and the Watch of Tens bounty is 0).

**Alternatives:**

- **Bump only the rules version.** Rejected: the stored shape changes, and the delivery
  rules require a save version.
- **Migrate schema-6 Campaign runs onto v2.** Rejected: it would mean mapping nodes
  and rewriting journals, and the result would still be a different game.

### D9. Test strategy

**Change:**

1. **Per-step RNG ledger.** A test helper computes the draws between consecutive saved
   snapshots (§2.3) and compares them with a count derived only from visible state:
   - **Entering or retrying a fight:** `(P − 1) + (O − 1)`. P is the number of non-held
     layout entries and O is the opponent deck size. This includes run creation, which
     enters the gate and is checked against the seed's initial state.
   - **Each reveal step:** `max(wonPile − 1, 0)` for each side that has to recycle in
     that step, using a predicate that mirrors `prepareSupply` (:1156-1176).
   - **Every other step:** 0. This covers Hold capture and choice, rewards, purchases,
     events, rests and routes.

   A trait or modifier that draws, or that changes consumption outside this formula,
   fails at the step where it happens.
2. **Per-step invariants.** These are added to the conservation ledger (`recordStep` and
   `assertLedger`, campaign-expedition.test.js:260-317):
   - `encounter.traitIds` equals the fight's applicable traits, and only elites have
     them.
   - No opponent ID appears in `activeModifiers` or the journal.
   - No single step raises health by more than `CAMPAIGN_NODE_HEAL_LIMIT`, and health
     never exceeds the maximum.
3. **Structural pass over all 24 routes.**
   - Uses `winEncounter` (tests/fixtures/campaign-route.js:163), takes Mend, leaves
     shops, and walks on at events and rests.
   - Asserts each route's kinds and tiers, elite and rest counts, the boss at the end,
     and `campaignCompleted`.
   - No clashes are played, so it is cheap.
4. **Full-play ledger** of the six edge-covering routes (D2) × the `scripted` and
   `contrasting` policies.
   - Outcome strings are asserted exactly, as at :372-389.
   - The coverage set gains `elite`, `greater mend`, `rest heal`, `rest train`,
     `rest cleanse`, `rest walk-on`, `etiquette`, `plunder`, `boss victory` and
     `boss defeat`.
   - Seeds may be re-selected to reach that coverage.
   - Budget: about 3 s. Today 16 five-node plays take 2.3 s; this is 12 seven-node
     plays.
5. **Replay.** Two seeds replay twice to equal runs, and `replayCampaignJournal`
   reproduces coins and cards (:355-357). The highlights become `elite` and
   `boss defeat`.
6. **Save and resume at every boundary** (campaign-persistence.test.js:356-359 and
   onwards) over the seven-node plans (WP5).
   - The re-selected seeds must still cover a retry, a defeat and a sold-out shop.
   - They must now also cover `awaitingRest`, an elite fight, and a boss victory and
     defeat.
7. **Runtime.** `npm test` grows by at most about 5 s over the 21.0 s baseline.

**Why:**

- Acceptance A2 asks that effects "cannot change RNG consumption accidentally or bypass
  card-instance conservation". The per-step ledger makes that an exact assertion rather
  than a golden snapshot.
- Edge coverage plus the structural pass exercises every link and every route without
  full play of all 24 × 2 combinations, which would take roughly 6–8 s.

**Alternatives:**

- Full play of all 24 routes.
- Golden RNG states per step, which break whenever content changes.
- A draw counter in rng.js, which adds test hooks to production code.

### D10. Delivery

**Change:**

- Deliver one PR containing WP1–WP11 and this plan, with §11 filled in.
- Completion evidence goes in the run plan's §21.4, under the existing heading.
- The 21.4 checklist row (ROGUELIKE_ADVENTURE_RUN_PLAN.md:14) stays unchecked until
  reviewer sign-off. The 21.3 row (:13) must be checked first.
- MILESTONES.md needs no change, because the numbering and dependencies are unchanged.

**Why:** the version bump spans every WP. Map v2 needs rest nodes; rests, traits and
reward tiers all need rules 7 and schema 7. Splitting the work would need an
intermediate rules version and a second round of fixture regeneration.

**Alternatives:** two PRs, one for the map, archetypes, rests and versions and one for
traits and reward tiers. That costs rules 8 and schema 8, or an unreleased
intermediate state on `main`.

## 6. Work packages

All paths are relative to the repository root. WP1, WP2 and the version bump in WP5 land
together, because every v2 route crosses the sanctum (§7).

### WP1: Archetypes, fights, rest-site content and map v2

Source changes:

- `src/domain/campaign-content.js`:
  - Add `CAMPAIGN_ARCHETYPES` (D3) and `CAMPAIGN_NODE_HEAL_LIMIT = 2` (D6).
  - Add `CAMPAIGN_REST_SITES` (D5) after `CAMPAIGN_NODE_EVENTS` (:97-142), reusing
    `WALK_ON` (:83-93).
  - Export `getCampaignArchetype(id)` and `getCampaignRestSite(id)` next to the lookups
    at :144-162.
  - `CAMPAIGN_FIGHTS` (:24-56):
    - Add `archetypeId`, `tier` and `traitIds` to every fight.
    - Add `high-court` and `night-watch` with `traitIds: []`; WP3 fills them in.
    - Replace `ace-assembly` with `ace-sovereign`, and set the Watch of Tens bounty
      to 0.
    - Update the comment at :24-25 to say that the boss ends the run.
- `src/domain/campaign-map.js`:
  - `CAMPAIGN_NODE_KINDS` (:24): add `rest`.
  - Replace the comment and map at :36-50 with `expedition-v2` (D2).
  - `contentFor` (:52-56): resolve `rest` through `getCampaignRestSite`.
  - `validateFights` (:64-85) checks:
    - the archetype and tier
    - canonical deck order and core containment
    - that elite and boss decks cover every rank
    - that the boss bounty is 0
    - that `traitIds` is sorted, distinct, and used only on elites.

    Coverage uses `compareCards` (cards.js:40-49) and checks each rank's
    representative against every deck card. This includes the rule that a 2 beats an
    ace (:46-47).
  - Add `validateArchetypes` (unique IDs, names, non-empty canonical cores) and
    `validateRestSites` (D5), modelled on `validateEvents` (:142-178).
  - `validateCampaignMap` (:192-253): add the start, boss, elite twin and bounty rules
    (D2).
  - `validateCampaignContent` (:255-263): call the two new validators.

New tests:

- `tests/unit/campaign-archetypes.test.js`:
  - Every fight's deck follows its archetype and tier.
  - Elite and boss decks cover every rank. The normal Royal Court and Watch of Tens do
    not; the test names this as the reason they are the safe path (§2.2).
  - Negative cases each fail with a specific message:
    - an unknown archetype or tier
    - a non-canonical deck, or an elite without its core
    - an elite or boss deck that leaves a rank uncovered
    - a boss with a bounty
    - traits on a normal fight, or unsorted traits
    - a malformed rest site: a cost, a heal over the limit, an option that both heals
      and edits, or a missing final `walk-on`.
- `tests/unit/campaign-map.test.js`, new negative cases:
  - an elite with no same-stage normal twin
  - a twin that some predecessor does not link to
  - a positive bounty with no later shop
  - two bosses, or a boss that is not final
  - an elite start node
  - an unknown rest site.

Tests to update:

- `tests/unit/campaign-map.test.js` (237 lines; 12 references to v1 IDs): the node
  list, 24 routes, stage count 7, and `finale` resolving to `ace-sovereign`.

Done when content validation passes at import and the archetype and map tests pass.

### WP2: Rest nodes

Source changes:

- `src/domain/campaign-machine.js`:
  - Add `awaitingRest` to `CAMPAIGN_NODE_DECISION_STATES` (:63-67), add
    `rest: 'awaitingRest'` to `STATE_BY_PHASE` (:81-85), and add `restSite` to
    `CAMPAIGN_KEYS` (:87-115).
  - Add `assertRestSite`, modelled on `assertNodeEvent` (:920-938). `restSite` is
    present exactly in `awaitingRest`, names the active rest node, and matches that
    node's content.
  - Call it from `inspectCampaignState` (:949-1043). `createCampaignRun` (:1106) sets
    `restSite: null`.
  - `commitNodeDecision` (:1602-1640): accept `rest` entries.
  - Add `getCampaignRestOptions`, `getCampaignRestTargets` and
    `chooseCampaignRestOption` after the event APIs (:1814-1889). They share the event
    APIs' blocker and target helpers, and their decisions are guarded by
    `assertNodeDecision` (:1575).
- `src/domain/campaign-journal.js`:
  - Add `rest` to `JOURNAL_ENTRY_TYPES` (:40-47), `JOURNAL_ENTRY_KEYS` (:48-74) and
    `JOURNAL_PHASES` (:75).
  - `applyRoute` (:265-286): entering a rest node sets the `rest` phase and `restSite`.
  - Extract `applyNodeOption` from `applyEvent` (:376-410), and add `applyRest`.
  - `applyJournalEntry` (:412-425): add explicit `event` and `rest` cases. Unknown types
    throw instead of falling through to `applyEvent`.
- `src/domain/campaign-node-events.js`: reuse `eventOptionBlocker` (:7) unchanged.
- `src/app/run-controller.js`: add `chooseRestOption`, gated by `applyNodeDecision`
  (:474) with the message "The Campaign rest site must be saved before an option can
  be chosen". Put it next to `chooseEventOption` (:519) and export it (:611-617).

Fixtures (`tests/fixtures/campaign-route.js`):

- Add a `chooseRestOption(run, optionId, targetInstanceId = null)` helper next to
  `chooseEventOption` (:72).
- `stepExpedition` (:212-267) gains an `awaitingRest` case:
  - rest when health is below the maximum
  - otherwise take the first unblocked deck option, with its first target
  - otherwise walk on.
- `contrastingStep` (campaign-expedition.test.js:55-85) prefers the deck option, and
  walks on when it is blocked. Together the two policies cover every rest option.

New tests (`tests/unit/campaign-rest.test.js`, modelled on
`campaign-node-events.test.js`):

- Entering each site opens `awaitingRest` with its options and draws no RNG.
- Resting heals 2 up to the maximum, and is allowed at full health.
- Train and cleanse:
  - eligible targets and created instance IDs
  - the `deck-full`, `copy-limit`, `deck-minimum` and `no-eligible-card` blockers.
- Walking on changes nothing except the journal and route.
- Refused decisions: wrong node, stale step, wrong state, blocked option, invalid
  target.
- Journal replay reproduces each rest entry, and an unknown entry type throws.
- A tampered `restSite` fails validation: wrong node, wrong site, or set outside
  `awaitingRest`.

Done when the rest tests pass and scripted expeditions cross both rest sites.

### WP3: Opponent traits and the stacking rule

Source changes:

- `src/domain/campaign-modifiers.js`:
  - Catalogue (:29-96): add `owner` to the six entries, and add `court-etiquette-v1`
    and `plunder-v1` (D4).
  - `validateModifierCatalogue` (:98-149): owner rules, opponent constraints,
    hook/effect consistency, and `healthOnGain` at most `CAMPAIGN_NODE_HEAL_LIMIT`.
  - Add `isOpponentTraitId(id)` and `encounterTraitIds(fight, ruleset)`. The latter is
    applicability-filtered and keeps catalogue order.
  - `createModifierRecord` (:167-170): refuse opponent IDs.
  - `contestCardBurns` (:251-258) and `narrowHoldTargets` (:261-276): take `traitIds`
    and apply the D4 stacking rule.
- `src/domain/campaign-machine.js`:
  - `ENCOUNTER_KEYS` (:124-131): add `tier` and `traitIds`.
  - `setUpEncounter` (:1074-1103): set both before shuffling, drawing nothing.
  - `assertEncounterShape` (:443-452): require both to match the content.
  - `assertActiveModifiers` (:270-287): refuse opponent IDs.
  - Pass `run.encounter.traitIds` at :713, :1226 and :1491.
- `src/domain/campaign-journal.js`: `gainModifier` (:246-250) refuses opponent IDs.
- `src/domain/campaign-map.js`:
  - `validateFights` requires trait IDs to be opponent-owned and hook-distinct.
  - `validateEventOption` (:135-139) names opponent IDs in its error.
- `src/domain/campaign-content.js`: set `high-court` traits to
  `['court-etiquette-v1']` and `night-watch` traits to `['plunder-v1']`.

New tests (`tests/unit/campaign-traits.test.js`):

- **Catalogue:** ID order, owners, opponent constraints and each hook/effect rule,
  using negative cases on cloned catalogues.
- **Pools:** the available and draftable pools equal the pre-trait catalogue's pools.
  This covers all 32 subsets of the five draftable modifiers under both rulesets.
- **Lifetime:**
  - Traits appear when an elite starts and are recreated by a retry.
  - They are gone after teardown, and absent on normal fights and the boss.
  - Plunder is absent under the no-burn ruleset.
- **Hold matrix (D4):** capture and replacement, including an empty capture list and a
  held J–A that stays playable.
- **Burn matrix (D4):** both winners with no effect, Spoils only, Plunder only, and
  both.
- **Conservation of plundered cards:**
  - They sit in the opponent's won pile.
  - The opponent can reveal them, and they burn when it loses with them.
  - They are never Hold targets.
  - They are back in the deck after teardown.
- **Tampering:** validation fails when an opponent ID appears in `activeModifiers`, a
  journal modifier gain or an event option, and when `encounter.traitIds` is wrong.
- **RNG:** entering an elite draws exactly `(P − 1) + (O − 1)`.

Done when the trait tests pass. A spot check of the D3 bands uses the §2.1 method;
WP11 records the final figures.

### WP4: Reward tiers, the boss and recovery limits

Source changes:

- `src/domain/campaign-content.js`:
  - Replace `CAMPAIGN_MEND_HEALTH` (:60) with `CAMPAIGN_MEND_HEALTH_BY_TIER`.
  - Add `CAMPAIGN_ELITE_CARD_RANKS`.
- `src/domain/campaign-rewards.js`: `generateRewardDraft` (:37-90) takes `tier` and
  uses the elite new-card pool (D7).
- `src/domain/campaign-machine.js`: `createRewardDraft` (:822-830) and
  `assertPendingReward` (:832-853) pass the fight's tier.
- `src/domain/campaign-journal.js`:
  - `regenerateRewardDraft` (:301-309) derives the tier from the active node.
  - `applyReward` heals by tier (:334).
  - The final-fight refusal (:313-315) names the boss.
- `src/domain/campaign-map.js`: validate both Mend tiers against
  `CAMPAIGN_NODE_HEAL_LIMIT`.
- `src/ui/campaign-view.js`: `offerText` (:140-149) shows "Greater Mend" with +2 for
  elite drafts.

New tests:

- `tests/unit/campaign-rewards.test.js`:
  - **Golden test:** normal-tier drafts for a fixed grid of seeds and encounter indices
    equal the values captured at `f6ec7b3` before any change (§7, step 1).
  - **Elite drafts:**
    - The new card is a J–A while one is unowned. When none is, the pool falls back to
      every unowned card.
    - Against the normal draft for the same seed and index, the deck-edit kind and the
      modifier are equal, and the replacement slot is present in exactly the same
      cases.
  - **Mend:** heals 1 after a normal fight and 2 after an elite, capped at the maximum;
    the offer stays `mend`.
  - Journal replay regenerates elite drafts identically.
- `tests/unit/campaign-machine.test.js`:
  - **Boss victory:** ends the run with `{ result: 'victory', reason:
    'campaignCompleted' }` and opens no draft.
  - **Boss defeat:** a retry is offered while `health − 2 > 0`; otherwise the run ends
    in defeat.
  - **Attempts by health on arrival:** 5 → 3, 4 → 2, 3 → 2, 2 → 1 and 1 → 1.

Done when the goldens pass unchanged and the elite and boss tests pass.

### WP5: Versions, persistence and fixtures

Source changes:

- `src/domain/campaign-machine.js:55-56`: set `CAMPAIGN_VERSION = 4` and
  `CAMPAIGN_GAME_RULES_VERSION = 7`.
- `src/persistence/run-schema.js`: set `SAVE_SCHEMA_VERSION = 7` (:8), and add
  `restSite` to `CAMPAIGN_MATCH_KEYS` (:36-59).
- `src/persistence/migrations.js`: set `CARRIED_SCHEMAS = [4, 5, 6]` (:13) and update
  the comment at :8-12 (D8).

Fixtures (`tests/fixtures/`):

- Keep every v6 file. The seven Campaign v6 files become quarantine samples and the
  three Classic v6 files become carry samples.
- Generate the v7 fixtures with `createRunSave(build(), { savedAt: SAVED_AT })`, using
  2-space JSON and a trailing newline, as the regeneration test expects
  (campaign-persistence.test.js:128):
  - Classic: `run-save-v7.json`, `run-save-paused-v7.json` and
    `run-save-terminal-v7.json`.
  - The seven existing Campaign builders under v7 names. Their paths (gate → market or
    shrine → court → bazaar) still exist in v2, and those nodes keep their indices and
    content (D2). Their link lists change, so the regenerated route states differ.
  - Five new Campaign fixtures:

    | Fixture | State |
    | --- | --- |
    | `campaign-save-elite-choice-v7.json` | Route map after the shrine, with `court` and `high-court` available |
    | `campaign-save-elite-reward-v7.json` | Draft after a High Court win, offering Greater Mend |
    | `campaign-save-rest-v7.json` | `awaitingRest` at the Roadside Camp |
    | `campaign-save-boss-v7.json` | `ready` at the finale, after the sanctum |
    | `campaign-save-victory-v7.json` | `ended` with `campaignCompleted`; the first terminal Campaign fixture |
- `campaign-route.js`:
  - `CAMPAIGN_SAVE_FIXTURES` (:338-346) lists all 12 v7 files.
  - Update the plan comment (:273-275), which still names the Ace Assembly.
  - `EXPEDITION_PLANS` (:276-280) becomes:

    | Plan | Route |
    | --- | --- |
    | `market` | gate, market, court, vault, watch, sanctum, finale |
    | `shrine` | gate, shrine, high-court, camp, night-watch, sanctum, finale |
    | `soldOut` | gate, shrine, court, bazaar, watch, sanctum, finale |

    The sold-out arithmetic is unchanged: gate bounty 3 + shrine coins 5 + court bounty
    4 = 12 coins, the bazaar's full stock.

Tests to update (counts are grep matches at `f6ec7b3`):

| File | Change |
| --- | --- |
| `migrations.test.js` | Current fixtures (:25-39) become v7. The carry test (:41-66) covers `[4, 5, 6]` and compares with `${name}-v7.json`. The quarantine list (:68-105) gains the seven Campaign v6 files at rules 6. Future versions (:123-125) become `[8, 20]` against `run-save-v7.json`. |
| `run-schema.test.js` | 10 v6 references, including the `run-save-v6.json` comparison at :55 |
| `run-repository.test.js` | 8 Campaign and 10 Classic v6 references |
| `bootstrap.test.js` | 6 v6 references |
| `campaign-persistence.test.js` | About 38 v6 references. The regeneration test (:128) covers 12 fixtures. The sold-out test's bazaar-to-finale step (:345-347, expecting `ace-assembly`) now crosses stage 5 and the sanctum. The every-boundary seeds (:356-359) are re-selected for D9 item 6. |
| `hud.test.js`, `battlefield.test.js` | 12 and 1 v6 references, plus 7 v1 IDs in `hud.test.js` |

New tests:

- **migrations and run-schema:**
  - Every Campaign v6 fixture throws `UnsupportedGameRulesVersionError`, reporting
    rules version 6.
  - Classic v6 saves carry to v7 unchanged apart from `saveSchemaVersion`.
  - A schema-7 Campaign save at rules 6 is rejected.
- **run-repository:** a v6 Campaign save is quarantined as `incompatible-game-rules`,
  and discarding it clears the quarantine.
- **bootstrap:** Main reports the incompatible save and keeps Resume disabled.
- **campaign-persistence:** each new fixture restores and continues:
  - the rest fixture to a rest choice
  - the elite-reward fixture to a Greater Mend claim
  - the boss fixture to a boss victory or defeat
  - the victory fixture stays ended.

Done when `npm test` passes and the regeneration test covers all 12 Campaign v7
fixtures.

### WP6: UI

Source changes:

- `src/ui/campaign-view.js`:
  - `NODE_KIND_TEXT` (:53) and `nodeKindText` (:62-63): Fight, Elite fight, Boss fight,
    Shop, Event or Rest. The label comes from the kind and tier instead of
    `next.length === 0`.
  - `fightDetail` (:311) shows:
    - the archetype, tier, damage and bounty
    - each trait's name and description
    - the reward tier: "Elite reward: a high card or Greater Mend", or for the boss,
      "Defeat to complete the expedition".
  - Add `restView`, sharing option rendering with `eventView` (:271). It shows a note
    in Mend's style when health is full.
  - `journalLine` (:356) and `expeditionLogLines` (:380): add rest entries, for example
    "Roadside Camp: rested and restored 2 health".
  - `campaignInspectView` (:399): list active traits during an elite encounter.
- `src/ui/overlays.js`:
  - `NODE_MODES` (:291): add `rest`, and render it next to the event branch (:525).
  - Hold capture (:422-436): when Court Etiquette narrows the targets, add "Court
    Etiquette: Hold can capture only a 2–10".
  - End text (:565-569): on victory, "You defeated the Ace Sovereign and completed the
    expedition." The defeat text is unchanged.
- `src/ui/hud.js`:
  - `CAMPAIGN_NODE_STATES` (:36): add `awaitingRest`, which also extends
    `CAMPAIGN_INSPECT_STATES` (:37).
  - `TARGET_PICKER_STATES` (:39-43): `rest: 'awaitingRest'`.
  - `BOUNDARY_SAVE_FAILURES` (:44-50): add "The rest site could not be saved. Try
    again."
  - Add a rest handler next to the event handler (:810) that calls `chooseRestOption`.
    Add `awaitingRest` to the status message (:1159) and the overlay routing (:1300),
    which opens the target picker through `targetPickerFor`.
  - Rest is an overlay owned by the Game screen, so `ScreenCoordinator` is unchanged.

Tests to update: `hud.test.js` route labels (now "Boss fight" rather than "Final
fight") and end text.

New tests (`hud.test.js`):

- The rest overlay's options, blockers, target picker and Back.
- The full-health note.
- The failed rest save text and its retry.
- The Greater Mend offer text.
- Fight detail for an elite, including traits and reward tier.
- The Hold capture trait note.
- The boss victory text.

Done when the HUD tests pass and every new string appears in a test.

### WP7: Domain test suite (D9)

Tests to update:

- `tests/unit/campaign-expedition.test.js`:
  - `routesFrom` and `ROUTES` (:44-50) now give 24 routes.
  - `contrastingStep` (:55-85) gains the rest case (WP2).
  - The ledger helpers (:99-333) gain `recordRest`, the trait and heal-limit invariants,
    and the RNG ledger.
  - The ledger test (:361-416) plays the six edge-covering routes × two policies, with
    exact outcomes and the extended coverage set.
  - The replay test (:418-433) uses v2 routes, with highlights `elite` and
    `boss defeat`.
- `tests/unit/campaign-journal.test.js`, `campaign-machine.test.js` and
  `campaign-rewards.test.js`: update their v1 references (4, 3 and 1).

New tests (`tests/unit/campaign-expedition.test.js`):

- The structural pass over all 24 routes (D9 item 3).
- The RNG ledger rejects a deliberately perturbed step. This is a negative self-test,
  so the ledger cannot pass vacuously.

Done when the expedition file runs in about 3 s or less on the baseline host and
`npm test` grows by at most 5 s.

### WP8: Integration flow

New test: `tests/integration/milestone-21-4-campaign-flow.test.js`, which drives the
application shell with an in-memory repository, like the 21.3 flow.

1. **Elite ladder to victory:** High Court, Roadside Camp rest, Night Watch, sanctum
   rest, then a boss victory. It reloads at every new boundary and continues
   identically.
2. **Defeat by health depletion:** the player reaches the boss with low health and
   loses the final attempt. The "Campaign defeat" overlay appears with its restart
   button.
3. **Stale or repeated rest decisions:** a wrong step, a second click while a save is
   pending, or a decision after a reload is refused.
4. **Failed rest save:** the decision is lost to a reload, which offers the saved rest
   site again, mirroring the 21.3 failed purchase save.

Tests to update: `tests/integration/milestone-21-3-expedition-flow.test.js`.

- Its expeditions run `stepExpedition` (:283, :437) with the market and sold-out plans
  (:457, :578). They now cross rests and the boss, so their expected outcomes and log
  lines change.
- The defeated expedition's explicit v1 route (:637) becomes a v2 route, with `watch`
  at stage 5.

Done when both integration files pass.

### WP9: Browser fixture

New files: `tests/browser/milestone-21-4-campaign.html` and `.js`, modelled on
`milestone-21-3-expedition.js`. The check is text-only, under `npm run dev`, at
1280×720 and 390×844 (`.github/copilot-instructions.md`). It covers:

- route-map labels for Elite fight, Boss fight and Rest, and the elite fight detail
  with its archetype, trait and reward tier
- the rest overlay: options, a blocked deck option, the target list and Back, and the
  full-health note
- reloading at the rest boundary through an in-memory repository, and the failed rest
  save text with its retry
- the Greater Mend offer text and the Court Etiquette note in Hold capture
- the boss victory text and the expedition log
- exactly one `canvas` in `#app`, with no relevant console errors.

Tests to update:

- The 21.1–21.3 fixtures reach their fights through the v2 map.
- They also need their v6 references updated: 1 in 21.2, and 3 plus 2 v1 IDs in 21.3.

Done when all four Campaign browser fixtures report success at both viewports.

### WP10: Documentation

- `README.md`:
  - Manual verification (:19-31): add a check for the elite route, rest and boss.
  - The Campaign description (:111-125): describe elites, traits, rests, Greater Mend
    and the boss.
  - The persistence paragraph (:131-142): schema 7, Campaign rules 7, carried Classic
    schemas 4–6, and quarantine for Campaign rules 3–6.
- `docs/IMPLEMENTATION_ROADMAP.md`: the current-format sentence (:633) and the JSON
  example (:661) become `saveSchemaVersion: 7`.
- `docs/ROGUELIKE_ADVENTURE_RUN_PLAN.md` §21.4: add a "Completion evidence" section in
  the style of 21.3's (:261-292), linking this plan. It names the new tests and
  fixtures, the deferred catalogue examples (D4) and the measured balance bands. It
  ends with "The checklist entry stays open until reviewer sign-off."
- `docs/MILESTONES.md`: no change expected.
- This plan: fill in §11.

### WP11: Validation and sign-off

1. Run `npm test` and `npm run build` under Node 24. Expect every test to pass, with
   only the existing chunk-size warning, and record the test count and duration.
2. Run the four Campaign browser fixtures at both viewports.
3. Re-run the §2.1 probes against the final content, outside the repository.
   - Record the first-attempt win rates against the D3 bands.
   - Repeat the elite and boss probes with a deck taken from the end of a scripted
     route, to measure drift (R1).
   - Record the clash counts with Spoils of War and Plunder both active. If fights
     average over 200 clashes, raise risk R7.
4. Review the PR with the `soulcard-code-review` skill.
5. Request reviewer sign-off. The 21.4 row stays unchecked until then.

## 7. Sequencing

1. **Goldens first.** Capture the normal-tier reward goldens (WP4) at `f6ec7b3`, before
   any source change.
2. **Map, rests and versions together.** WP1, WP2 and the WP5 version bump land as one
   step, because every v2 route crosses the sanctum. Regenerate the v7 fixtures and
   update the churned tests.
3. **WP3 (traits).** Then regenerate the fixtures again; elite encounters change.
4. **WP4** (reward tiers, boss and limits).
5. **WP6** (UI).
6. **WP7.** Complete the domain suite and the RNG ledger.
7. **WP8**, then **WP9.**
8. **WP10**, then **WP11.**

`npm test` passes at the end of every step.

## 8. Risks

| # | Risk | Mitigation |
| --- | --- | --- |
| R1 | Balance drifts as the deck grows. A 30–40 card deck with more high cards may trivialize elites. | Bands are measured on the starter deck. WP11 adds a probe with an end-of-route deck, and 21.5 simulation tooling owns tuning. |
| R2 | Fixture churn: 12 Campaign and 3 Classic v7 files, plus about 95 references to v6 fixtures and 39 to v1 IDs in tests and fixtures | Regenerate through the existing builders and regeneration test; keep the v6 files as samples |
| R3 | Test runtime | D9 budget: the structural pass for every route and full play only on edge routes |
| R4 | In-progress Campaign v6 saves are quarantined | Same policy as 21.2 and 21.3; Main explains the incompatible save |
| R5 | Stacking complexity: two filters per Hold hook and two burn owners | Exhaustive matrices in WP3; validator rules make bad combinations impossible |
| R6 | RNG drift from traits or rests | Per-step RNG ledger and a negative self-test (WP7) |
| R7 | Long fights when Spoils of War and Plunder are both active, because nothing burns on either side | Measured in WP11. If they are too long, make Spoils inapplicable against Plunder elites. **Triggered and mitigated** (§11): Plunder now suspends Spoils of War. |
| R8 | Scope creep into 21.5: procedural traits and more catalogue examples | D4 deferral list, recorded in the evidence |
| R9 | Under the no-burn ruleset, Plunder is inapplicable, so the Night Watch has no trait | Accepted: the elite still has covering aces, 2 damage and its reward. Listed in §10. |
| R10 | The elite twin rule constrains 21.5 generation | It is a validator rule, so 21.5 generators must satisfy it or revise it explicitly |
| R11 | The boss is hard for passive players: 26 % per attempt at 1–3 attempts | Rest choices and Hold Insight are the counters; bands are recorded; §10 asks for sign-off |

## 9. Definition of done

- [x] Every §4 criterion has passing evidence.
- [x] `npm test` and `npm run build` pass under Node 24, with growth of at most about
      5 s.
- [x] All four Campaign browser fixtures pass at 1280×720 and 390×844.
- [x] The balance bands are measured and recorded in §11 and the §21.4 evidence.
- [x] The README, roadmap and §21.4 evidence are updated, and §11 is filled in.
- [x] Code review is complete and reviewer sign-off is requested. The 21.4 row stays
      open until sign-off.

## 10. Questions for sign-off

Each question names the default this plan assumes. The plan was approved with every
default.

1. **Map shape.** Is the seven-stage `expedition-v2` (24 routes, two elite choices, an
   optional camp and a fixed sanctum) right? Default: yes. The alternative is the
   five-stage, 12-route map (D2).
2. **Bounty rule.** Should a positive bounty require a later shop, which sets the Watch
   of Tens bounty to 0? Default: yes.
3. **Elites and boss.** High Court with Court Etiquette, Night Watch with Plunder, and
   the Ace Sovereign boss (K, A), at 2 damage each? Default: yes. Alternatives: a
   Q, K, A boss, or a J, Q, K, A boss.
4. **Normal fights.** Royal Court and Watch of Tens cannot be lost under burn rules.
   Should they stay as the safe path, or gain a covering card (for example A♠, about
   88.5 %)? Default: keep them.
5. **Trait model.** Opponent-owned catalogue entries stored on the encounter, with the
   D4 stacking rule? Default: yes.
6. **Deferrals.** Defer opponent-reveal access, recycle order, card-value effects,
   normal and boss traits, and procedural traits to 21.5? Default: yes.
7. **Rest model.** A dedicated rest kind (R3) with heal versus train or cleanse
   options, no health-full blocker, and no costs? Default: yes.
8. **Recovery and reward tiers.** A per-node heal limit of 2, Greater Mend +2, elite
   cards J–A with fallback, and no boss draft? Default: yes.
9. **Versions.** Rules 7, campaign version 4 and schema 7, with in-progress Campaign v6
   saves quarantined? Default: yes.
10. **Evidence and delivery.** A per-step RNG ledger, edge-route full play, probes not
    committed, and one PR? Default: yes.

## 11. Implementation notes

The plan was approved with every §10 default and delivered in one PR. The code follows
§5 except where noted below.

**Acceptance evidence** (§4). Every criterion has passing tests:

- **S1.** `campaign-archetypes` checks the four archetype cores, each fight's deck at
  its tier, and that elite and boss decks cover every rank. `campaign-traits` checks
  that traits exist exactly while their elite encounter does and that entering or
  retrying an elite draws only its two shuffles.
- **S2.** `campaign-rest` covers healing, training, cleansing, Walk on and replay.
  `campaign-rewards` covers elite drafts and Greater Mend, `campaign-machine` the boss's
  damage, retries and missing draft, and `campaign-archetypes` the per-node heal limit.
- **S3.** `campaign-traits` covers trait ownership, lifetime and validation, the Hold
  stacking matrix, and the burn rules, including Plunder suspending Spoils of War.
- **A1.** The 21.4 integration flow climbs the High Court and Night Watch, rests twice
  and defeats the Ace Sovereign across reloads; a second flow reaches the boss with 1
  health and ends in defeat. The ledger plays every map link, including the normal
  twins, and the 21.4 browser fixture plays the elite ladder to victory at both
  viewports.
- **A2.** The `campaign-expedition` ledger balances coins, health, cards, modifiers and
  RNG draws on every link and rejects a step with one draw too many or too few.
  `campaign-traits` checks that plundered cards stay the player's and return after the
  fight, and `campaign-rewards` that normal drafts match the goldens captured before
  tiers.

**Departures and decisions**

- **R7 triggered: Plunder suspends Spoils of War.** With both active, the Night Watch
  without Hold averaged 340.6 clashes (maximum 1,819, seeds 0–199), above the 200-clash
  trigger. Nothing burned on either side, so the fight behaved like the no-burn ruleset.
  The §8 mitigation was applied. `contestCardBurns` uses an opponent trait's
  `burnSettlement` effect when the encounter carries one, and the player's modifier
  otherwise; the Hold hooks still combine both filters. Spoils of War keeps its
  encounter lifetime, so it is spent without effect at the Night Watch, and Plunder's
  description says so. The D4 burn table and the R7 row are updated. With both active,
  the Night Watch now plays clash for clash like Plunder alone (47 % and 53 clashes
  without Hold, 94 % with Hold Insight), which a seeded unit test asserts. Rules 7 was
  unreleased, so no version changed. A reviewer who prefers the original D4 matrix can
  veto this and choose another mitigation.
- **Shared shell harness.** The application-shell driver of the 21.3 integration test
  moved to `tests/fixtures/expedition-shell.js`, and the 21.3 and 21.4 flows share it.
  It precomputes the domain expedition for a seed and plan, drives the UI step by step,
  and requires every saved UI state to equal the domain state. Late boundaries start
  from saved states instead of replaying the expedition through the UI: the boss defeat
  starts at seed 3's last Ace Sovereign attempt (journal step 15, 1 health), and the
  rest refusals start from the elite ladder's saved Roadside Camp (seed 11, step 7).
- **Seeds.** The elite ladder plays seed 11 on the shrine plan, and the boss defeat
  plays seed 3. The content ledger plays seeds 12 (scripted) and 40 (contrasting) on the
  six edge-covering routes; together they traverse all 21 links and reach every
  coverage item. An exploratory sweep of 960 plays found no invariant violation.
- **21.3 tests on the new map.** The 21.3 market expedition (seed 0) now reaches the Ace
  Sovereign and is defeated after 3 retries, where it previously won the five-stage
  finale. The test keeps its reload, failed-purchase and stale-decision checks and
  asserts the defeat. Elite and boss route details append a sentence after the node
  state, so the 21.3 browser fixture matches completed and locked details with
  `/ · (Completed|Locked)(\.|$)/` instead of `endsWith`.
- **Rest blockers are unreachable in play.** Rest options are blocked only by the deck
  limits (20–40). Expeditions start with 26 cards, and no route reaches either limit
  before a rest site. The browser fixture therefore asserts that every option is
  enabled, and the HUD unit test covers blocked options with a constructed state. The
  refused-rest HUD test overrides `chooseRestOption` on a restored controller through
  `Object.create`, so the refusal runs against real restored state.
- **Browser validation.** The four Campaign fixtures ran in headless Chrome over the
  DevTools protocol against the Vite dev server, with text-only DOM, canvas and console
  checks at 1280×720 and 390×844. The 21.4 fixture turns on reduced motion when it
  reloads at the stage-5 route map, so the long Watch of Tens fight that follows stays
  quick.

**Measured balance** (WP11). The §2.1 harness ran outside the repository against the
final content with the starter deck. Cells give first-attempt win / loss / draw
percentages:

| Fight | Policy | Seeds | Win / loss / draw | Mean clashes | D3 band |
| --- | --- | --- | --- | --- | --- |
| Suit Opposition | none | 0–199 | 41.5 % wins | 43.9 | Unchanged from §2.1 |
| Suit Opposition | insight | 0–199 | 78.5 % wins | 40.1 | Unchanged from §2.1 |
| Suit Opposition | blind | 0–199 | 34 % wins | 43.4 | Unchanged from §2.1 |
| Royal Court | none | 0–199 | 100 / 0 / 0 | 32.1 | Safe path |
| Watch of Tens | none | 0–199 | 100 / 0 / 0 | 25.6 | Safe path |
| High Court | none | 0–999 | 61.7 / 29.9 / 8.4 | 32.8 | 60–75: in band |
| High Court | insight | 0–999 | 66.9 / 26.7 / 6.4 | 32.6 | 60–75: in band |
| High Court | blind | 0–999 | 63.1 / 27.9 / 9 | 32.5 | 60–75: in band |
| Night Watch | none | 0–999 | 45.8 / 52 / 2.2 | 52.9 | 40–55: in band |
| Night Watch | insight | 0–999 | 94.2 / 5.6 / 0.2 | 37.7 | At least 90: in band |
| Night Watch | blind | 0–199 | 17 / 83 / 0 | 48.2 | None |
| Ace Sovereign | none | 0–999 | 24.5 / 74 / 1.5 | 27.6 | 20–35: in band |
| Ace Sovereign | insight | 0–999 | 81.4 / 18.5 / 0.1 | 28.6 | 75–90: in band |
| Ace Sovereign | blind | 0–199 | 11.5 / 86.5 / 2 | 27 | None |

- Over seeds 0–199 the High Court `none` rate was 57.5 %, just under its band, so the
  banded cells were re-run over 1,000 seeds (standard error about 1.5 points). Every
  banded cell falls inside its band. §2.1 measured 65 % with a non-canonical deck
  order; the delivered elite decks are listed in canonical order, which changes every
  shuffle.
- Plunder punishes blind Hold play: 17 % at the Night Watch, against 80 % for the same
  deck without the trait in §2.1.
- Spoils of War does not help against the High Court: 57 % with it (seeds 0–199)
  against 57.5 % without. It lengthens the fight (39.3 against 32.6 clashes) and turns
  draws into losses. This is recorded for 21.5 tuning.

**Drift (R1).** Scripted expeditions on the six edge-covering routes with seeds 0–9
reached the boss in 44 of 60 plays. Their decks held 23–31 cards (median 27), with 7–11
J–A cards (median 8). The elite and boss probes were repeated (seeds 0–199) with two of
those decks, both from the market, Royal Court, Ember Bazaar and Watch of Tens route:

| Deck | High Court none / insight | Night Watch none / insight | Ace Sovereign none / insight |
| --- | --- | --- | --- |
| Strongest: 30 cards, 11 J–A (seed 1) | 86.5 / 88.5 | 59 / 99.5 | 54 / 97 |
| Median-ranked: 29 cards, 8 J–A (seed 9) | 69 / 75 | 43.5 / 95.5 | 32.5 / 89.5 |

Drift is real: a strong end-of-route deck makes the High Court and the Ace Sovereign
clearly easier. As R1 states, tuning belongs to 21.5's simulation tooling.

**R7 and R9.** Win rates without Hold unless noted:

| Fight | Rules and seeds | Win % | Mean clashes | Maximum |
| --- | --- | --- | --- | --- |
| Night Watch with Spoils of War, before the mitigation | Burn, 0–199 | 65 | 340.6 | 1,819 |
| Night Watch with Spoils of War, after the mitigation | Burn, 0–199 | 47 | 53 | 61 |
| Night Watch with Spoils of War and Hold Insight, before | Burn, 0–199 | 100 | 43.2 | 206 |
| Night Watch with Spoils of War and Hold Insight, after | Burn, 0–199 | 94 | 37.4 | 62 |
| High Court | No-burn, 0–99 | 38 | 320.5 | 1,290 |
| Night Watch, no trait (R9) | No-burn, 0–99 | 66 | 360.8 | 1,819 |
| Ace Sovereign | No-burn, 0–99 | 35 | 209.9 | 723 |

Long no-burn fights predate this milestone (§2.1 measured means of 45–650 clashes).

**Tests.** `npm test` runs 495 tests under Node 24.22.2, all passing, against 449 on
`main`. Over three alternating runs, the median duration was 26.3 s against 21.7 s on
`main`, a growth of 4.6 s within the D9 budget. The full-play ledger takes 3.05 s
against its budget of about 3 s. New files add 31 tests: `campaign-archetypes` (8),
`campaign-rest` (9), `campaign-traits` (10) and `milestone-21-4-campaign-flow` (4). The
fixtures add 12 Campaign and 3 Classic v7 saves; the v6 files stay as samples for the
migration and quarantine tests.

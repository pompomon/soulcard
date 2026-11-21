# Campaign encounter rules (plan)

**Status:** next; the [short-deck setting](../HISTORY.md#classic-short-deck-plan-52) is done.
Brings options C, E and G of [faster-matches.md](faster-matches.md) to Campaign as encounter rules:
a new run assigns one at random to each fight. Campaign decks keep their sizes. Measured evidence,
including the scratch probe behind the numbers below, goes in the pull request.

## Goal

- Shorter, more varied fights. No-burn fights end instead of running for hundreds of clashes.
- Keep fights winnable: elite and boss win rates stay in the [CAMPAIGN.md](../CAMPAIGN.md) §11
  bands, or review revises the bands.
- **Honest limit:** decks keep about 26 cards, and a rule starts only once supply turns personal.
  The gate fight (26 v 26 cards) still takes about 66 s at the median with Auto-reveal under
  Double or nothing or Attrition (95 s today). In the scratch probe every other fight ends within
  51 s under Double or nothing. Faster pacing is out of scope.

## Scope

- **In:** a rule catalogue, per-fight assignment at run start, the three rules, state, events,
  versions, UI text and animation steps, a committed fight probe, and tuning.
- **Out:** Classic (see the [short-deck setting](../HISTORY.md#classic-short-deck-plan-52)),
  deck and content changes, pacing, and generated content (21.5).

## Rule catalogue

New pure module `src/domain/campaign-encounter-rules.js`, validated at import like the other
catalogues:

| ID | Name | Start | Parameter |
|---|---|---|---|
| `race-to-ten-v1` | Race to 10 (C) | `both` | target 10 |
| `double-or-nothing-v1` | Double or nothing (E) | `either` | stake 2^(k−1) − 1 |
| `attrition-v1` | Attrition (G) | `both` | 3 extra cards |

- An entry may override its start or parameter per fight tier. None does at first.
- Changing an entry changes rule semantics, so it needs a new ID or a Campaign rules bump.

## Assignment

- `createCampaignRun` still draws nothing from the run RNG. For each fight node in map order it
  draws one index from a new derived stream, `campaign-encounter-rules-v1`, keyed by map node
  index: `drawIndex(3, createDerivedRng(seed, stream, nodeIndex))`. Other nodes draw nothing.
- The run stores `encounterRules`, a list of `{nodeId, ruleId}` for fight nodes in map order.
  `validateCampaignState` recomputes it from the seed and requires equality.
- The map shows each fight's rule from the start. A retry keeps the fight's rule.

## When a rule is active

- A side's `encounter.supplyMode` turns `personal` when it first supplies with an empty source
  (`prepareSupply`), and never turns back.
- **`either`:** active once either side is `personal`. **`both`:** once both are.
- Race and Attrition check when a clash settles, so a tie across a side's last source card can
  activate them. Double or nothing checks after the first-round reveals.
- **Why the starts differ:** opponent decks hold 8–26 cards against the player's 26, so the
  opponent turns personal first and then replays only cards it won. In the scratch probe (burn
  rules, starter deck, never Hold), `either` drops the boss to 0% under Race and 13.5% under
  Attrition (23.6% and 35.8% with `both`). Double or nothing keeps 22.9% with `either` and is the
  fastest rule; with `both`, boss draws reach 14%.

## Rules

Each encounter stores `rule`: `{id, activeClashes, wins: {player, opponent}}`, reset when a fight
is set up or retried. `activeClashes` counts clashes that settled while the rule was active.

**Race to 10 (C):**

- When an active clash settles, its winner's count rises by one.
- At the target, the fight ends with a new outcome reason, `raceTargetReached`, and the usual
  win, loss or reward transition. Inability still ends the fight first if a side can't supply.
- In the scratch probe the target ends 86% of gate and 99.5% of Night Watch fights under burn rules,
  but at most 5% elsewhere. Under no-burn it ends 92–100%, and every fight ends within 88 s.

**Double or nothing (E):**

- After the first-round reveals of an active clash, the player and then the opponent stake
  2^(k−1) − 1 cards each, face down, where k = `activeClashes` + 1: 0, 1, 3, 7, 15 cards and so
  on.
- Each card comes through `prepareSupply`, which may turn a side personal or recycle. A side that
  runs short stakes what it has.
- Stakes join the contest after the first-round reveals and before any tie rounds. They settle
  like revealed cards: they burn or transfer, and Plunder and Spoils of War apply.
- A side that staked its last card can't continue a tie and loses; if neither can, the fight is
  drawn. A side left with nothing after a lost clash loses at its next supply.
- Unlike the research version, reveals come before stakes, so the Hold preview and the Hold
  Insight peek stay exact, and a short side keeps no card back.

**Attrition (G):**

- After an active clash settles and the fight continues, the loser burns its next 3 cards through
  `prepareSupply`, under both burn settings.
- These burns skip `burnSettlement` effects, so neither Plunder nor Spoils of War claims them.
  They never touch Hold.
- A side that runs out loses at its next supply, as today.

## Interactions

- **Hold** applies only to a clash's first reveal, which comes before any stake. Captures still
  target player cards in `player.drawPile` and `player.wonPile`. Court Etiquette is unchanged.
- **RNG:** stake and attrition supply recycle with the run RNG, in contest order: player stakes,
  opponent stakes, tie rounds, then attrition.
- **No-burn:** stakes transfer to the winner, and attrition still burns. Attrition is the only rule
  that removes cards there.
- **Teardown** recovers every player card, burned ones too, so no rule costs cards beyond the
  fight.
- **Protected ranks:** a player card that no opponent card ties or beats still can't lose a reveal,
  but stakes and attrition can burn it, and the `uncoveredCampaignRanks` comment must say so.
  Elite and boss decks still cover every rank.

## State, events and validation

- **Keys:** `CAMPAIGN_KEYS` and the save's `CAMPAIGN_MATCH_KEYS` (`run-schema.js`) gain
  `encounterRules`, and `ENCOUNTER_KEYS` gains `rule`.
- `validateCampaignState`:
  - `rule` must match the fight's assigned rule.
  - Today a won outcome needs an inability reason and a loser with no regular supply. A
    `raceTargetReached` win instead needs Race to 10 and the winner's count at the target, and its
    loser may keep supply.
  - Today a no-burn run's burn pile must be empty. Under Attrition it may hold attrition burns,
    and no-burn settlements still burn nothing.
- Campaign events (`campaign-events.js`):
  - `clashSettled` and `clashDrawn` gain `stakes`, in contest order, with the reveal record shape
    `{instanceId, cardId, suppliedBy, from}`.
  - `clashSettled` also gains `attrition`, a list of `{instanceId, cardId, from}`.
  - Both lists are always present and may be empty. An instance appears once across reveals,
    stakes and attrition, and each card matches its instance.
  - Version 5 stays readable, without the lists. A Campaign version predicate replaces the
    `=== CAMPAIGN_EVENT_VERSION` routing in `events.js` and `eventVersion === 5` in
    `event-player.js`. Classic 6 stays Classic.
- `commitSettled` and `commitDraw` fingerprint a private envelope (`createEventEnvelope`) before
  building the public event. One payload builder feeds both, so the fingerprint covers `stakes`
  and `attrition`.
- `assertPendingEvent` (`campaign-machine.js`):
  - The contest order is the first two reveals, then the stakes, then the remaining reveals.
    Settlement follows `contestCardBurns` over that order, and a draw's retained contest equals it.
  - The burn-pile suffix is `burned`, then `attrition`.
  - Each side's stake equals the schedule unless that side ran out.
  - Today a won fight's last event must end in inability, which leaves an odd reveal count. A
    `raceTargetReached` win ends on complete reveal rounds instead.

## Versions and saves

- Campaign rules 7 → 8 (`CAMPAIGN_GAME_RULES_VERSION`), and campaign version 4 → 5 for the new
  keys.
- Save schema 8 → 9, after the short deck's 7 → 8. Schema 8 joins `CARRIED_SCHEMAS`
  (`migrations.js`): Classic saves carry over, and Campaign saves fail the rules check and are
  quarantined as `incompatible-game-rules`, as earlier rules bumps did.
- Campaign events 5 → 7; the short deck takes 6 in the shared number space. If this plan lands
  first, it takes schema 8 and events 6.
- **Fixtures:**
  - Build `campaign-save-*-v9.json` from `CAMPAIGN_SAVE_FIXTURES`, adding a mid-fight save under
    each rule, a Double-or-nothing draw that retains stakes, and a no-burn Attrition save.
  - Keep the v8 Campaign files as quarantine samples, and Classic schema-8 files as carry samples.
- **Rollback:** older builds can't read schema 9, so ship forward fixes.

## UI

- **Map** (`campaign-view.js` `fightDetail`): each fight lists its rule next to its traits, for
  example "Rule: Race to 10".
- **HUD:**
  - Once the rule is active, the Stage metric shows its state, for example "Race 3–5 of 10",
    "Stake 3 each" or "Attrition 3". Until then it shows each side's supply mode, as today.
  - No new rows: the phone footer reserve stays 210 px.
  - Run details shows the rule's text.
- **Hold overlays** show the coming stake under Double or nothing. It is known before the reveal,
  because a clash that activates the rule stakes nothing.
- **Retry, reward and end overlays** name race results, for example "Lost the race 7–10".
- **Event player:**
  - A stake step shows one face-down pile per side with a count. An attrition step burns a pile
    with a count. Stakes reached 31 cards in the scratch probe, and 63 under no-burn.
  - Both stay within `MAX_TRANSIENT_CARDS` (8) and `MAX_CONTEST_CARDS` (4) in `battlefield.js`,
    scale with `animationSpeed`, and jump to the result under reduced motion.

## Probe and balance gate

- `scripts/campaign-probe.js` (`npm run probe:campaign`) is committed for today's rules; the rules
  pull request adds the rule dimension and the race-target share. It drives the domain functions
  directly, not the test fixtures. For each fight, rule, burn setting and Hold policy (never,
  blind, informed) it reports:
  - first-attempt win and draw rates and the race-target share
  - clash count and estimated time: median, p95 and maximum
- Time uses `DEFAULT_TIMING_PROFILE` (`simulation.js`), with stake steps priced as reveals, plus
  0.4 s per clash for Auto-reveal.
- Gate for the rules pull request, under burn rules with the starter deck:
  - The boss stays within its §11 bands under every rule.
  - Elites stay within their bands, or review agrees per-rule bands and §11 records them. Elites
    can be avoided (the elite twin rule), and the map shows their rules.
  - Draws stay at or below 15% per fight.
  - Every fight's median time is at most today's.
  - No-burn results are reported, not gated.
- **Levers**, in order:
  1. A rule's start or parameter.
  2. Per-tier overrides.
  3. Last resort: the fights a rule may be assigned to. The draw then picks among the eligible
     rules.
- Without Hold the scratch probe misses three bands: the High Court under Double or nothing and
  Attrition, the Night Watch under every rule, and the boss under Attrition.

## Tests

- **Catalogue and assignment:**
  - Catalogue validation.
  - Assignment is deterministic per seed, draws once per fight node, and leaves run-RNG, reward and
    shop draws identical.
  - Tampered `encounterRules` fail validation.
- **Rules:**
  - Race: the target ending, ties across the last source card, and the `both` start.
  - Double or nothing: the schedule and short stakes; all-in ties that end in inability or a draw;
    contest and recycle order; Plunder and Spoils of War on stakes; exact Hold previews and peeks.
  - Attrition: both burn settings, running out mid-burn, recycling, Hold untouched, Plunder
    unable to claim attrition, and a no-burn burn pile that holds only attrition burns.
  - Retries reset rule state and keep the rule. Teardown returns burned stakes and attrition
    cards, protected ranks included.
- **Events:** the version-7 shape and checks; version 5 still readable; fingerprints covering
  stakes and attrition on an inactive clash (empty lists) and on active ones; the burn-pile
  suffix; race endings; rejected mismatches; event-player routing and bounds.
- **Persistence:** exact save round trips on the map, mid-fight and after a retry; the draw that
  retains stakes; quarantined schema-8 Campaign saves; carried Classic saves; v9 fixture equality.
- **Expedition shell:** runs under every rule. Re-pick the §10 seeds whose scenarios change, and
  keep the ledger test near 3 s.
- **Probe:** a small seed range gives identical output twice.
- **Browser (text-only):**
  - The map lists rules.
  - An Auto-reveal fight under each rule shows its HUD state and ends.
  - `#app` has a canvas, and the console is clean.

## Docs, in the rules pull request

- [CAMPAIGN.md](../CAMPAIGN.md):
  - §1: "without drawing RNG" becomes "without drawing the run RNG"; rule state; an RNG table row
    for the new stream; stake and attrition recycles; protected ranks cover revealed cards only.
  - §3 the rules and their interactions, §5 assignment and the map, §6 HUD, §7 the catalogue.
  - §8 versions, §9: generators must assign rules, §10 fixtures and seeds, and §11 the probe and
    per-rule bands.
- [ARCHITECTURE.md](../ARCHITECTURE.md): §3 Campaign events 5 and 7, and §5 the save table
  (Campaign schemas 4–8 quarantined, Classic 4–8 carried).
- [ROADMAP.md](../ROADMAP.md): the status row. The probe pull request also updates 21.5's note
  that no probe is committed.

## Delivery

1. **Probe pull request:** the probe for today's rules, with no rule change. It resolves §11's note
   that the harness was never committed.
2. **Rules pull request:** everything that changes rules, tuned to the gate, with text UI and
   simple stake and attrition steps. Every Campaign rules change bumps the version and quarantines
   saves, so it lands once.
3. **Presentation pull request** (optional): animation polish, with no rule or event change.

## Acceptance

- A new run assigns each fight a rule, deterministically from its seed. The map, HUD and overlays
  show it, and each rule plays as specified across save, resume and retry.
- The balance gate passes, and the pull request reports the probe tables.
- `npm test` and `npm run build` pass. The Classic simulation stays byte-identical, and the
  text-only browser check passes.

## Relation to 21.5

21.5's generator assigns rules, keeping or replacing `campaign-encounter-rules-v1` with a
documented order, and its campaign simulation extends this probe. Land this plan first, so that
generated content is tuned with the rules in place.

## Open questions

- Starts: these defaults favour balance. Attrition with `either` is faster (median 31–48 s instead
  of 55–65 s outside the gate) but drops the boss to 13.5%. Prefer speed, with per-tier overrides?
- Race to 10 rarely ends burn fights outside the gate and the Night Watch. Keep it as a no-burn
  bound, or lower the target per tier? At the High Court a target of 8 ends 33% of fights at 69%
  wins, in band.
- Elite bands: accept per-rule bands, or tune until today's hold?
- Variety: draw uniformly per fight, or avoid one rule on every fight of a run?
- Quarantine in-progress Campaign saves, or migrate saves that stopped at a node decision?
- Should Classic later offer these rules on the short deck?

# Classic short-deck setting (plan)

**Status:** next. Implements option A of [faster-matches.md](faster-matches.md) as an opt-in
setting for Classic games only. Campaign decks, rules and events don't change, and its saves carry
over to the new save schema. Measured evidence goes in the pull request, as the
[plan lifecycle](../ROADMAP.md#plan-lifecycle) requires.

## Goal

A player can choose a 36-card Classic deck (6 to Ace) in Settings. New and restarted Classic
games use it; resumed games keep the deck they were saved with.

Expected effect, from the research (seeds 0–9,999, Auto-reveal / manual budget):

| Rules | Longest game today | Longest on 36 cards | Comebacks today / on 36 cards |
|---|---|---|---|
| Burn | 103.6 / 124.0 s | 71.6 / 85.6 s | 31.5% / 24.9% |
| No-burn | 2.4 / 2.9 h | 58 / 70 min | 34.8% / 31.8% |

On 36 cards the median burn game takes 62.6 s with Auto-reveal, and 32.5% of games end within
60 s. The short deck alone doesn't bound no-burn games: their median is 188 clashes (6 min).

## Scope

- **In:** a "Classic deck" setting; two built-in rulesets for the 36-card deck, one per burn
  setting; deck-aware setup, comparison, invariants, events and simulation; docs and fixtures.
- **Out:**
  - Campaign. It ignores the setting and keeps its decks, rules version and events.
  - Faster pacing, and the C, E and G rules in Classic.
  - 32- or 28-card decks (research knobs). The deck catalogue makes one a later ruleset.

## Rules

- The short deck holds ranks 6 to Ace in all four suits: 36 cards with the standard IDs
  (`c-6S` … `c-AC`), in canonical order (suit-major S, H, D, C, then rank).
- The deck's lowest rank beats Ace, and only Ace: 6 beats A on 36 cards, as 2 does on 52.
- Everything else is unchanged: both stages, ties, burn and no-burn settlement, and inability
  endings. The shared deck must hold an even number of cards (`assertStageZones`); 36 does.

## Rulesets and decks

- `src/domain/ruleset.js` gains two built-ins, checked with `assertBuiltIn` like today's:
  - `SHORT_DECK_BASELINE_RULESET`, ID `short-deck-baseline-v1`, with the same `burn` object as
    `mvp-baseline-v2`.
  - `SHORT_DECK_NO_BURN_RULESET`, ID `short-deck-no-burn-v1`, with `burn: {enabled: false}`.
- The ruleset shape stays `{id, burn}`. `rulesetDeck(ruleset)` maps the ID to a deck: `short-36`
  for the two new IDs and `standard-52` for every other ID, including the test-only custom
  rulesets. Saves already store the full ruleset.
- `src/domain/cards.js`:
  - `DECKS` maps `standard-52` to `CARD_IDS` and `short-36` to `SHORT_DECK_CARD_IDS`, a frozen
    filter of `CARD_IDS` that keeps canonical order.
  - `compareCards(a, b, deck = 'standard-52')` applies the upset between the deck's lowest rank
    and Ace only. Campaign call sites keep the default.

## Domain

- `deck.js` `createSourceDeck(rng, cardIds)` and `zones.js` `createInitialZones(rng, cardIds)`
  take the deck's IDs. The shuffle draws once per card after the first: 35 values instead of 51.
  Nothing else changes the RNG order.
- `invariants.js` `assertZoneInvariants(zones, cardIds)`, `assertStableBoundary` and
  `getCardOwnership` conserve the deck's cards. The error names the deck size, not "all 52 cards".
- `match-machine.js`:
  - `createMatch({runId, seed, ruleset})` builds the zones from `rulesetDeck(ruleset)`.
  - `resolveSourceRound`, `resolvePersonalRound` and `validateMatchState` compare and validate with
    that deck.
- Standard games keep their RNG draws, settlements and outcomes, so the canonical simulation
  report stays byte-identical.

## Events

`validateCommittedEvent` (`src/domain/events.js`) checks an event on its own, and the battlefield
and event player call it without the match, so an event must name its deck.

- `EVENT_VERSION` 4 → 6 adds `deck` to `clashSettled` and `clashDrawn`. Every new Classic event is
  version 6, standard games included. Versions 2–4 stay readable.
- The **effective deck** is `event.deck` from version 6 and `standard-52` before it. Versions 4
  and 6 compare the decisive round with `compareCards(…, deck)`; 2 and 3 keep plain values.
  Version 4 set the precedent: it switched to `compareCards` and bumped the version.
- Version 5 is Campaign's: `validateCommittedEvent` routes by number, so Classic and Campaign share
  one number space. If the [Campaign encounter rules](campaign-encounter-rules.md) land first and
  take 6, use the next free number.
- `createClashSettledEvent` and `createClashDrawnEvent` take the deck. The state fingerprint
  already hashes the ruleset, so it binds the deck without a new field.
- `assertPendingEvent` (`match-machine.js`) requires the effective deck to equal
  `rulesetDeck(match.ruleset)`. Saved version-4 events still pass for standard games, and none can
  pass for a short-deck game.
- The event player detects only ties, which don't depend on the upset rank. Its Campaign check
  (`eventVersion === 5`, `event-player.js`) already treats 6 as Classic.

## Persistence

- **Save schema 7 → 8**, because the stored `pendingEvent` gains `deck`. Precedent: schema-3
  fixtures hold version-2 events, and reveal `from` (version 3) first appears in schema 4. Classic
  `GAME_RULES_VERSION` stays 2: the new ruleset IDs carry the rule change, as the versioning table
  in [ARCHITECTURE.md](../ARCHITECTURE.md) allows.
- `migrations.js`: schema 7 joins `CARRIED_SCHEMAS`, and schema-7 saves of both modes carry over
  unchanged as 8. Classic ones keep their version-4 events. Campaign ones skip the blanket
  quarantine of carried Campaign saves but still face the rules check. Schema 4–6 Campaign saves
  stay quarantined.
- If the Campaign encounter rules take schema 8 first, this takes 9 and carries 8 the same way.
- **Rollback:** older builds quarantine schema-8 saves as `unsupported-save-version`, so once this
  ships the release checklist calls for forward fixes.
- **Fixtures:**
  - Add `run-save-v8.json`, `run-save-paused-v8.json` and `run-save-terminal-v8.json` with
    version-6 events, plus short-deck ready, paused and terminal saves.
  - Regenerate the 12 `CAMPAIGN_SAVE_FIXTURES` as `campaign-save-*-v8.json`; only the schema
    changes. Tests and browser harnesses that load current saves move to the v8 files.
  - Keep the schema-7 files as carry samples.

## Settings and UI

- `src/app/settings.js`: add `classicDeck`, `standard-52` (default) or `short-36`, to
  `DEFAULT_SETTINGS`, `isSettingValue` and `createSettingsPreferences`.
- `src/persistence/settings-repository.js`: add `classicDeck` to `SETTINGS_STORAGE_KEYS`
  (`soulcard.settings.v1.classicDeck`) and a `setClassicDeck` saver. A missing or invalid value
  falls back to the default, as other fields do.
- `src/ui/settings-controller.js` and `src/ui/menus.js`: add `setClassicDeck` to their required
  methods and wire it.
- **Settings → Gameplay:**
  - Add a "Classic deck" select after "Turn burning", with the options "52 cards" and "36 cards (6
    to Ace)".
  - The note becomes: "Applies to newly started or restarted games. Resumed games keep their saved
    rules. The deck applies to Classic only."
- `src/app/bootstrap.js` `startNewRun` builds one ruleset from `burnEnabled` for both modes today.
  Pure helpers replace that: `classicRuleset({burnEnabled, classicDeck})` and
  `campaignRuleset({burnEnabled})`. `restartCurrentRun` keeps its mode dispatch, so a Classic
  restart picks up the current setting.
- The HUD and overlays need no new text: the source count starts at 36. No metric or overlay
  hard-codes 52; the only `52` in presentation is a drawing offset in `themes/classic.js`.

## Simulation

- `scripts/simulate.js` gains `--ruleset ID`, defaulting to `mvp-baseline-v2` and accepting only
  built-in Classic IDs. `createSimulationReport` already takes a ruleset, and the report records
  `rulesetId`.
- Add `tests/fixtures/simulation-report-short-deck.json` for `short-deck-baseline-v1` over the
  canonical seeds 0–999. Its test regenerates it byte for byte.
- `tests/fixtures/simulation-report.json` stays byte-identical. The release checklist gains a
  second `cmp` for the new fixture.

## Tests

- **Cards:** short-deck composition and order; the upset per deck (6 beats A only on 36 cards, and
  the default comparison is unchanged).
- **Rulesets:** both new built-ins validate, altered copies fail, and `rulesetDeck` maps custom
  rulesets to `standard-52`.
- **Invariants and match machine:**
  - 36-card conservation and setup draws.
  - A 6-vs-A upset in both stages.
  - Short-deck games to the end under both burn settings.
  - Under burn rules every clash but the last burns a card, so no short-deck game exceeds 36
    clashes.
- **Events:**
  - Version-6 validation with `deck`; versions 2–4 still readable as `standard-52`; every new
    Classic event is version 6.
  - The effective-deck check: the ready, paused and terminal fixtures pass. A version-4 event on a
    short-deck match and a `short-36` event on a standard match fail.
- **Simulation:** the CLI option and the new fixture.
- **Settings, menus and bootstrap:**
  - the default, stored and invalid values
  - per-mode ruleset choice, with Campaign ignoring the deck
  - restart picks up the setting, and resume keeps the saved ruleset
- **Persistence:**
  - Schema-7 Classic and Campaign saves carry over as 8, Classic ones with their version-4 events.
  - Schema 4–6 Campaign saves stay quarantined.
  - The v8 fixtures regenerate exactly, and short-deck saves load and resume.
- **Browser:** a text-only headless check. With "36 cards" and Auto-reveal, a Classic game shows a
  canvas in `#app`, starts with 36 source cards and ends with no console errors. A Campaign started
  next still has a 26-card starter deck.

## Docs, in the same pull request

- [ARCHITECTURE.md](../ARCHITECTURE.md):
  - §2 Classic rules: decks, setup, conservation, the upset rank and rulesets.
  - §3 Domain contracts: version-6 events, the effective deck and the simulation fixture.
  - §4 App shell: the settings table and note.
  - §5 Persistence: schema 8, the save table, fixtures and rollback.
- [CAMPAIGN.md](../CAMPAIGN.md) §8 and §10: the schema number, carried schema-7 saves, Classic
  events v6 and the v8 fixture names.
- [ROADMAP.md](../ROADMAP.md): the status row and the release checklist's second `cmp`.

## Delivery

One pull request, in this commit order: deck catalogue and comparison; rulesets and domain; events,
save schema and fixtures; simulation; settings and UI; docs. Every commit keeps `npm test` green.

## Acceptance

- With "36 cards", a new or restarted Classic game uses the 36-card deck under the chosen burn
  setting. Resumed games keep their deck, saves of both modes from before the change resume, and
  Campaign rules are unaffected.
- `npm test` and `npm run build` pass. The canonical simulation is byte-identical, and the
  short-deck report matches its fixture.
- The pull request reports seeds 0–9,999 next to the research numbers above. These are evidence,
  not pass thresholds.
- The text-only browser check passes.

## Open questions

- Default: keep 52 cards, so current players see no change, or make 36 the default for new
  installs?
- No-burn games stay long on 36 cards. Should the setting's note say so, or should a later
  milestone pair the short deck with C, E or G in Classic?

# Soulcard implementation roadmap

**Date:** September 19, 2026
**Status:** accepted MVP decision record and implementation plan; this document makes
no application changes.

Track milestone completion in [`MILESTONES.md`](./MILESTONES.md).

## Accepted product decision record and scope

Every decision in this section has status **Accepted for MVP**. An implementation must
not silently reinterpret one. A later roadmap revision may supersede a decision, but a
rules-semantic change also requires a new ruleset ID and `gameRulesVersion`; a persisted
shape change requires a new `saveSchemaVersion` plus a migration; and a committed-event
shape change requires a new `eventVersion`.

### Current implementation baseline

The repository currently contains a framework-light, plain-JavaScript Vite PWA that
renders one rotating glass pyramid in one Three.js scene. It is a visual prototype, not
an implementation of the match, screens, domain model, persistence, or settings
described below. The existing baseline uses relative Vite and asset paths, registers
`./sw.js` only in production, injects a build-derived app-shell revision, and deploys
`dist` to GitHub Pages. Those constraints are preserved and evolved incrementally.

The baseline review establishes:

- `src/main.js` owns the prototype scene, render loop, resize listener, and
  production-only relative service-worker registration.
- `public/sw.js` owns immediate activation, versioned app-shell/runtime caching, and old
  Soulcard-cache cleanup; `vite.config.js` injects emitted assets and a content-derived
  revision at build time.
- `.github/workflows/deploy.yml` builds with `npm ci`/`npm run build` and publishes
  `dist` to GitHub Pages from `main`.

The current service worker calls `skipWaiting()` and `clients.claim()`, so an installed
update activates immediately. That is documented current behavior, not the safe-update
behavior promised by the MVP. Milestone 17 replaces it with update availability and
stable-save-boundary deferral.

### ADR-001: Product and delivery shape

- **Context:** The prototype proves the Vite, Three.js, PWA, and Pages delivery path,
  but it does not establish game architecture.
- **Decision:** Build the MVP incrementally in the existing plain-JavaScript project.
  Do not add a UI framework or treat the pyramid scene as authoritative game logic.
  The MVP is one deterministic, single-player, player-versus-AI, fast-burning
  War-style match.
- **Consequences:** Existing deployment behavior remains usable while domain, UI, and
  presentation modules replace the prototype in reviewable milestones. A framework
  rewrite and expanded game systems remain outside MVP.
- **Revisit trigger:** A separately approved post-MVP architecture decision that
  demonstrates a requirement the current stack cannot satisfy.

### ADR-002: Deterministic authority and presentation

- **Context:** Exact save/resume and reproducible matches are incompatible with rules
  that depend on frame time, animation callbacks, or hidden randomness.
- **Decision:** A pure domain state machine and one serializable domain RNG are the
  only authorities for rules and match state. Presentation receives snapshots and
  already-committed events; it cannot settle rules or consume domain RNG.
- **Consequences:** Domain behavior can run without WebGL. Animation may replay,
  shorten, or skip a committed result without changing it.
- **Revisit trigger:** Any domain semantic change requires rules versioning; serialized
  or event contract changes additionally use their respective schema versions.

### ADR-003: Match and burn rules

- **Context:** “War” and “burning” have incompatible variants, especially around ties,
  exhaustion, and which cards survive settlement.
- **Decision:** Use the source-stage and personal-stage rules, ordering, terminal
  outcomes, and baseline burn settlement defined in this document. In particular, if
  neither side can supply a required tie reveal, the match ends in a terminal draw and
  the unresolved `contestedPile` remains intact.
- **Consequences:** No implementation-specific fallback, anti-stalemate rule, or random
  burn behavior may change a result. Enabled and disabled burning are both deterministic
  ruleset configurations.
- **Revisit trigger:** A new ruleset ID and `gameRulesVersion`, with deterministic
  migration/rejection behavior for saved runs.

### ADR-004: Screen and interaction model

- **Context:** Menus, pauses, and end summaries can otherwise drift into an unbounded
  set of navigation states.
- **Decision:** Main, Settings, and Game are the only top-level screens. Pause and end
  summary are overlays within Game. MVP primary actions support mouse, touch, and pen
  through semantic DOM controls; full keyboard gameplay is post-MVP.
- **Consequences:** Overlays never increase the screen count. Visible focus styles and
  semantic controls remain even though keyboard navigation and gameplay are not an MVP
  acceptance surface.
- **Revisit trigger:** A dedicated post-MVP interaction/accessibility milestone.

### ADR-005: Persistence ownership

- **Context:** Active runs are structured, versioned records, while graphics settings
  are small independent preferences and cached assets are replaceable.
- **Decision:** Store the single active run in IndexedDB, versioned settings in
  localStorage, and only application assets in Cache Storage. Save a run only at a
  stable boundary and retain the committed pending presentation event.
- **Consequences:** Storage failure degrades safely; corrupt or unknown saves cannot
  enter a resume crash loop. Clearing application caches does not delete a run.
- **Revisit trigger:** A stored-shape change increments `saveSchemaVersion` and adds a
  tested migration; a rules-semantic change also increments `gameRulesVersion`.

### ADR-006: PWA and deployment continuity

- **Context:** Relative paths are required for the current GitHub Pages repository
  subpath, and the build already revisions its service-worker app shell.
- **Decision:** Preserve relative URLs, production service-worker registration, the
  generated app-shell revision, and the GitHub Pages workflow. Harden them in place
  rather than replacing the delivery system.
- **Consequences:** Every routing, asset, manifest, cache, and update change must work
  from a repository subpath as well as a local development origin.
- **Revisit trigger:** A separately approved hosting or distribution change.

The MVP micro-loop is: read the HUD and next action, tap/click **Reveal/Continue**,
resolve the paired reveal and all resulting ties in the pure engine, commit
deterministic ownership and burn results, save at the resulting stable boundary, show
concise cause-and-effect feedback, and continue until a terminal result. There is no
forced choice on every reveal.

### MVP scope

- Exactly three top-level screens: **Main**, **Settings**, and **Game**.
- A deterministic 52-card match, AI encounter flow, ties, configurable burning, and
  a generated classic theme.
- Persistent, resumable active run; separate persisted graphics/animation settings.
- Responsive Three.js battlefield with DOM HUD, mouse/touch/pen click-or-tap controls,
  PWA offline behavior, and a pause/end overlay within Game.

### Explicitly not MVP

- Full keyboard navigation, keyboard gameplay, shortcuts, focus-flow test coverage, or
  keyboard-specific instructions (retain visible focus styles and semantic controls).
- Roguelike rewards, routes, bosses, relics, passive effects, interventions, unlocks,
  meta progression, complex burn-rule editors, audio/haptics, analytics, cloud saves,
  or multiple save slots.
- A framework rewrite, third-party card artwork, and a duration-enforcing override of
  disabled burning.

## Canonical rules and terminology

The terms below are normative:

| Term | Meaning |
|---|---|
| **Card** | Immutable identity `{ id, suit, rank, value }`; `id` is unique in the classic 52-card set, Ace has value 14, and suit never affects comparison. |
| **Match stage** | Card-source progression: exactly `source` or `personal`; it is distinct from machine state. |
| **Machine state** | Control state such as `new`, `ready`, `resolving`, `stageTransition`, `paused`, or `ended`. |
| **Clash** | One contest beginning with a paired reveal and ending in one settlement or a terminal draw. |
| **Reveal round** | The player reveal followed by the opponent reveal within a clash. |
| **Tie** | A reveal round whose two supplied cards have equal values; it retains the contest and requires another reveal round. |
| **Stable boundary** | The point after an action has fully committed, `inPlay` is empty, conservation passes, RNG state is captured, and the machine is `ready`, `paused`, or `ended`. No save or event emission occurs before it. |
| **Committed event** | Immutable description of a result emitted only after authoritative zones, machine state, match stage, and RNG state have committed. Presentation may consume it but cannot alter it. |
| **Ownership** | Settled control represented by a card being in a player's or opponent's `drawPile` or `wonPile`. Source and burned cards are unowned; contested cards are unsettled and retain `suppliedBy` provenance. |

Presentation does not own cards: it receives `frontThemeId` and `backThemeId`, not
image data.

### Ordered zones and provenance

Every pile is ordered. Index `0` is the next card to reveal; drawing removes index `0`;
settlement appends to a destination pile. A shuffle replaces the complete input pile
with a deterministic order whose index `0` is drawn next. Within every reveal round,
the player is processed before the opponent. Reveal rounds append to a contest in
chronological order.

| Zone | Contents and authority |
|---|---|
| `sourceDeck` | Unowned card IDs not yet assigned during the source stage. |
| `player.drawPile`, `opponent.drawPile` | Settled, side-owned card IDs available to reveal, with index `0` next. |
| `player.wonPile`, `opponent.wonPile` | Settled, side-owned card IDs awaiting the next personal-stage recycle. |
| `contestedPile` | Ordered reveal records `{ cardId, suppliedBy }`. Cards are unsettled, while `suppliedBy` (`player` or `opponent`) preserves the side that supplied each card for settlement. |
| `burnPile` | Unowned card IDs removed from further reveals but retained for conservation and display. |
| `inPlay` | Ephemeral ordered reveal records moved during one atomic transition. It must be empty at every stable boundary. |

For enabled burning, filter `contestedPile` in reveal order: append winner-supplied
cards to the winner's `wonPile` and append loser-supplied cards to `burnPile`. For
disabled burning, append every contested card to the winner's `wonPile` in reveal
order. The terminal-draw path performs no settlement and retains the ordered
`contestedPile`; no card is discarded or duplicated.

### Deterministic match flow

At new-game setup, the domain RNG shuffles one 52-card `sourceDeck`. During the
**source stage**, each reveal round removes the player card first and the opponent card
second from `sourceDeck`. Resolved cards establish ownership only through settlement.
When a settled clash exhausts the source, shuffle the player's complete `wonPile` into
`player.drawPile`, then the opponent's complete `wonPile` into
`opponent.drawPile`, consuming RNG in that order, and enter the **personal stage**.

During the personal stage, each side reveals from its own `drawPile`. Before a required
reveal, an empty draw pile recycles that side's complete nonempty `wonPile` through the
domain RNG. Prepare and reveal for the player before the opponent, so simultaneous
recycles consume RNG player first. A side that remains unable to reveal loses the
clash and match; if it is a tie continuation, the available side-supplied card joins
the contest before normal settlement.

If a tied reveal exhausts `sourceDeck`, retain `contestedPile`, perform the same
player-first source-to-personal-stage shuffles, remain in machine state `resolving`,
and continue the tie from the personal draw piles.

A clash keeps every reveal record in `contestedPile`. Equal values require another
reveal round. If one side cannot supply a required tie card after personal-stage
recycling, the other side wins the whole unresolved contest under the configured burn
settlement and the match ends. If neither side can supply it, the match ends in a
terminal draw, `contestedPile` remains intact, and no settlement or RNG call occurs.

### Baseline burning decision

The baseline data-driven ruleset has `burn.enabled: true`. On a resolved clash:

1. Identify the decisive pair: the final unequal reveal, or the available card(s)
   when inability resolves the contest.
2. Every winner-supplied card in the contested pile, including the decisive winning card,
   moves to the winner's `wonPile`.
3. Each eligible loser-supplied card in the complete contested pile moves to
   `burnPile`; this includes losing-side cards from earlier tie rounds and the
   decisive losing card.
4. Preserve the filtered reveal order when appending to `wonPile` and `burnPile`.
5. If `burn.enabled: false`, **all** contested cards (including eligible losing cards)
   transfer to the winner's `wonPile` in reveal order. No burn random decision is
   evaluated or consumed.

This preserves the premise that the winner retains its decisive card, while the
baseline removes loser-supplied cards and accelerates ordinary play. The evaluator must
be pure and return a committed list of transfers/burns before any animation begins.
Later rules may add ordered predicates (explicit card ID, rank, suit, percentage),
with schema validation and unambiguous precedence, but the MVP UI does not expose an
editor. A percentage predicate consumes the domain RNG only when enabled and reached.
Anti-stalemate rules are excluded from MVP. Any future anti-stalemate rules must be
separate, explicit, deterministic, configurable, and must not silently alter a
disabled-burn match.

### Conservation invariant and shuffle timing

Throughout every atomic transition, each of the 52 unique IDs exists in exactly one
authoritative zone: `sourceDeck`, `player.drawPile`, `player.wonPile`,
`opponent.drawPile`, `opponent.wonPile`, `contestedPile`, `burnPile`, or the ephemeral
`inPlay`. Counts total 52, zones have no duplicate IDs, settled ownership agrees with
the ordered zone array, and record zones are counted by `cardId`. At every stable
boundary, `inPlay` is empty and the invariant passes before an event is emitted or a
save is permitted. The one exception to an empty contest at a stable boundary is a
terminal draw, which retains unresolved cards in `contestedPile`. Do not reshuffle on
every reveal: shuffle source only at setup; shuffle each side's `wonPile` at the
source-to-personal-stage boundary and whenever its personal-stage `drawPile` is empty
before a required reveal.

### Example rulesets

```json
{
  "id": "mvp-baseline-v1",
  "burn": {
    "enabled": true,
    "eligibleScope": "all-losing-side-cards-in-resolved-contested-pile",
    "decisiveWinningCard": "winner.wonPile"
  }
}
```

```json
{
  "id": "debug-no-burn-v1",
  "burn": { "enabled": false }
}
```

The future-compatible evaluator schema should support explicit, ordered predicates
without adding an MVP editor:

```json
{
  "enabled": true,
  "eligibleScope": "all-losing-side-cards-in-resolved-contested-pile",
  "rules": [
    { "match": { "cardIds": ["c-AS"] }, "outcome": "transfer" },
    { "match": { "suits": ["H"], "ranks": ["K"] }, "outcome": "burn" },
    { "match": { "chance": 0.5 }, "outcome": "burn" }
  ],
  "defaultOutcome": "transfer"
}
```

Eligible cards are evaluated in `contestedPile` reveal order. Rules are evaluated
top-to-bottom for each card; the first match wins. The percentage rule uses the
serializable domain RNG only after preceding rules fail and only when burning is
enabled. This is a rules/test configuration surface, not a graphics settings feature.

## Architecture

Authoritative state lives outside Three.js. The pure domain state machine advances
only on actions and deterministic RNG, never on frame time; rendering consumes
snapshots and committed events. Three.js animation callbacks cannot settle rules,
draw RNG, or mutate game state.

```text
src/
  app/bootstrap.js                 app/screen-coordinator.js
  domain/cards.js                  domain/deck.js             domain/zones.js
  domain/invariants.js             domain/rng.js              domain/ruleset.js
  domain/burn-evaluator.js         domain/match-machine.js    domain/ai-controller.js
  domain/events.js                 domain/simulation.js
  persistence/run-repository.js    persistence/run-schema.js  persistence/migrations.js
  presentation/battlefield.js      presentation/layout.js     presentation/event-player.js
  presentation/themes/registry.js  presentation/themes/classic.js presentation/texture-cache.js
  presentation/input.js            ui/hud.js                  ui/menus.js
  ui/overlays.js                   ui/settings-controller.js  pwa/lifecycle.js
  main.js                          style.css
tests/
  unit/                            integration/               browser/
```

`bootstrap` owns lifecycle and wires the coordinator. The coordinator alone switches
Main, Settings, and Game. `match-machine` owns machine states, match stages, and
actions; cards/deck/zones own validation; `rng` exposes seed plus serializable internal
state; `burn-evaluator` validates rules and returns settlements; `ai-controller`
chooses deterministic encounter advancement. The event queue contains committed
domain events. Persistence serializes snapshots/events. Renderer, responsive layout,
theme cache, input, and DOM UI are replaceable consumers.

The renderer owns geometries, materials, and textures and disposes them on theme
replacement, screen teardown, and cache eviction. Handle `webglcontextlost` by
preventing default, pausing presentation without changing domain state, then
recreate renderer resources from the current snapshot on restoration.

### State-machine transitions

| Current machine state | Action/condition | Next machine state | Atomic commit |
|---|---|---|---|
| `new` | start with seed/rules | `ready` | source stage and shuffled 52-card `sourceDeck` |
| `ready` | reveal/continue | `resolving` | first reveal round enters `contestedPile` through `inPlay` |
| `resolving` | values tie and both can reveal in the current stage | `resolving` | contest retained; next player-then-opponent reveal round |
| `resolving` | values tie in the source stage and source is empty | `stageTransition` | contest retained |
| `resolving` | unequal values settle while source remains | `ready` | ordered settlement, burn result, and committed event |
| `resolving` | unequal values settle as source becomes empty | `stageTransition` | ordered settlement and burn result retained for final commit |
| `stageTransition` | source empty with unresolved contest; both can reveal after nonempty won piles are shuffled | `resolving` | nonempty won piles shuffled player then opponent, stage set to personal, next reveal round |
| `stageTransition` | source empty with unresolved contest; exactly one side can reveal after nonempty won piles are shuffled | `ended` | nonempty won pile shuffled, stage set to personal, available reveal, ordered settlement, and terminal winner |
| `stageTransition` | source empty with unresolved contest; neither side can reveal because both won piles are empty | `ended` | stage set to personal; terminal draw with unresolved contest retained |
| `stageTransition` | source empty after settlement | `ready` | player then opponent piles shuffled, stage set to personal, and settlement event committed |
| `resolving` | personal draw pile empty and won pile nonempty before a required reveal | `resolving` | complete won pile recycled into draw pile |
| `resolving` | exactly one side cannot supply a required card after recycling | `ended` | available reveal, ordered settlement, and terminal winner |
| `resolving` | neither side can supply a required tie card | `ended` | terminal draw with unresolved contest retained |
| `ready` | pause/save | `paused` overlay | atomic snapshot |
| `paused` | resume | prior `ready` | no recalculation |

`resolving` and `stageTransition` are internal to one dispatched domain action and are
never save points. The action may loop through ties, recycling, and a stage transition,
but it returns only at a stable `ready` or `ended` boundary with `inPlay` empty and all
RNG consumption captured. The `paused` machine state is represented by a Game overlay;
the end overlay likewise remains within Game rather than becoming a fourth screen.

### Committed event example

```json
{
  "eventVersion": 1,
  "id": "run-42:clash-17",
  "type": "clashSettled",
  "turn": 17,
  "stage": "personal",
  "winner": "player",
  "reveals": [
    { "cardId": "c-10H", "suppliedBy": "player" },
    { "cardId": "c-10C", "suppliedBy": "opponent" },
    { "cardId": "c-AS", "suppliedBy": "player" },
    { "cardId": "c-KD", "suppliedBy": "opponent" }
  ],
  "transfers": [{ "cardId": "c-10H", "to": "player.wonPile" },
                { "cardId": "c-AS", "to": "player.wonPile" }],
  "burned": ["c-10C", "c-KD"],
  "pendingPresentation": "settlement-v1"
}
```

The event is committed and saved before animation. On restore, presentation replays it
or marks it skipped; it never reruns settlement or RNG.

## Screens, settings, and input

**Main** offers Start New Game, Resume Game (enabled only for a valid resumable save),
and Settings. Starting over an active save requires confirmation. **Settings** offers
quality presets, DPR/render-scale cap, animation speed, and animation reduction. Set
the initial value from `prefers-reduced-motion`, then honor explicit user override.
Persist settings separately from active-run data. Burning is a rules/test
configuration concern, not a graphics/animation setting.

**Game** is a responsive Three.js battlefield under semantic DOM HUD/controls. Display
source deck and match stage, both sides' zones and counts, reveal/comparison area,
contested pile, burn pile/count, status, and pause. Pause is an overlay with Resume,
Save & Main Menu, restart confirmation, and save status. Graphics settings remain on
the Settings screen. End summary is another Game overlay.

Define battlefield positions in logical coordinates, layout modes for phone portrait,
phone landscape, tablet, and desktop, reserved HUD rectangles, safe-area insets, and
camera fitting rather than device-specific scattered coordinates. The minimum supported
viewport is 320×480 CSS px; below it, retain primary controls and compact counts while
scrolling or letterboxing gracefully. Use `ResizeObserver` plus resize and orientation
events to recompute layout, camera projection, renderer size, and capped pixel ratio.

Pointer Events unify mouse, touch, and pen. Primary actions are semantic DOM buttons
with targets at least 44×44 CSS px, work by click/tap, never require gestures or hover,
keep visible focus styles, define `touch-action` deliberately, handle `pointercancel`,
and suppress synthetic duplicate click/tap activation. Battlefield gestures and their
pointer-capture behavior are post-MVP.

## Persistence

Use IndexedDB for structured active-run snapshots: it supports atomic record writes,
larger ordered data, and evolution better than localStorage. Settings use localStorage
because they are small, independent primitives and are safe to read before UI boot;
namespace and version them. Either store must fail gracefully. Cache Storage holds
application assets only and never save or settings data.

Snapshots are versioned with `saveSchemaVersion`, `gameRulesVersion`, ISO timestamp,
and complete structural validation. A checksum is not required for MVP. Migration
functions are version-to-version, tested from fixtures, and reject unknown future
versions. Invalid, incomplete, or corrupt runs are quarantined/discardable and leave
Main with Resume disabled and a clear discard/start-new recovery path—never a resume
crash loop.

Save only at stable domain boundaries: after every committed clash, explicit pause,
and best effort on `visibilitychange`, `pagehide`, and lifecycle freeze events when the
domain is already stable; do not depend on `unload` and never force a mid-resolution
snapshot. Serialize ordered zones, match stage, machine state, contested/in-play state,
burn pile, turn counters, ruleset including burn flag, seed and RNG state, run status,
future modifier extension point, and committed pending presentation event. Restore
validates and migrates, reconstructs visuals from the snapshot, and replays or marks
the saved presentation skipped without recalculating a domain result or consuming RNG.

The following is an abridged shape example: most of the 52 zone card IDs are omitted,
so it is not a valid restorable fixture. `pendingEvent` shows the canonical complete
event shape that persistence stores; valid fixtures must contain all 52 unique card IDs
and pass the stated zone validation.

```json
{
  "saveSchemaVersion": 1,
  "gameRulesVersion": 1,
  "savedAt": "2026-09-19T07:00:00.000Z",
  "runId": "run-42",
  "rng": { "algorithm": "mulberry32", "seed": 12345, "state": 3771268942 },
  "ruleset": { "id": "mvp-baseline-v1", "burn": { "enabled": true } },
  "match": {
    "stage": "personal",
    "machineState": "ready",
    "turn": 17,
    "status": "active",
    "sourceDeck": [],
    "player": { "drawPile": ["c-2S"], "wonPile": ["c-10H", "c-AS"] },
    "opponent": { "drawPile": ["c-QD"], "wonPile": [] },
    "contestedPile": [],
    "inPlay": [],
    "burnPile": ["c-10C", "c-KD"],
    "futureModifiers": []
  },
  "pendingEvent": {
    "eventVersion": 1,
    "id": "run-42:clash-17",
    "type": "clashSettled",
    "turn": 17,
    "stage": "personal",
    "winner": "player",
    "reveals": [
      { "cardId": "c-10H", "suppliedBy": "player" },
      { "cardId": "c-10C", "suppliedBy": "opponent" },
      { "cardId": "c-AS", "suppliedBy": "player" },
      { "cardId": "c-KD", "suppliedBy": "opponent" }
    ],
    "transfers": [
      { "cardId": "c-10H", "to": "player.wonPile" },
      { "cardId": "c-AS", "to": "player.wonPile" }
    ],
    "burned": ["c-10C", "c-KD"],
    "pendingPresentation": "settlement-v1"
  }
}
```

## Themes, visuals, and performance hypotheses

Create a validated theme registry keyed by `frontThemeId` and `backThemeId`, with
known-ID fallback to the generated classic theme and invalid-ID diagnostics. Save IDs,
not textures. Generate the MVP's 52 fronts at runtime with CanvasTexture or generated
SVG: legible rank/suit corner indices, mirrored layout, red/black suits, and simple
non-copyrighted geometric face-card treatment. Begin with one generated classic back.
Prove extensibility with a test/demo fixture that registers a second front and back
without modifying card or match state.

Use an atlas/cache or equivalent keyed cache with lazy generation, bounded memory/LRU
eviction, high-DPI texture dimensions, documented color space, filtering, anisotropy,
and regeneration after disposal/context restoration. Validate, rather than promise,
targets such as: responsive input at the minimum viewport, no unbounded texture count
during a full match, bounded render scale by preset, and smooth enough animation on a
representative low/mid/high device matrix. Profile memory, draw calls, frame pacing,
texture generation, and context-loss recovery before setting release thresholds.

## PWA and updates

The baseline already retains relative paths, injects build assets and a content-derived
revision into `sw.js`, removes obsolete Soulcard caches on activation, registers the
worker in production, and deploys through GitHub Pages. Its immediate
`skipWaiting()`/`clients.claim()` activation is intentionally not the final update
policy.

Milestone 17 extends that baseline to precache all required local app-shell assets and
keep runtime caching bounded. Generated card textures are recreated locally; IndexedDB
saves remain independent of Cache Storage. The application must report an available
update and defer activation/reload while a resolution is uncommitted, first reaching
and saving a stable boundary. Verify installability, standalone/fullscreen safe areas,
manifest icons, offline launch/resume, cache upgrade, and update deferral on the
relative GitHub Pages path.

## Dependency map and critical path

```text
1 -> 2 -> 3 -> 4 -> 5 -> 6
1 -> 7 -> 8
2–5 -> 9
7 + 9 -> 10
5 + 7–8 -> 11
3 + 11 -> 12
5 + 8 + 11–12 -> 13
7 + 11 + 13 -> 14
5 + 13–14 -> 15
8–10 + 15 -> 16
9–10 + 16 -> 17
11–17 -> 18
1–18 -> 19
```

The critical path is decisions, deterministic domain, persistence, screen integration,
and browser/PWA validation. Each numbered item below should normally be one focused,
reviewable PR.

## Milestones

### 1. Documentation baseline, terminology, and decisions
- **Goal/files:** Establish this document and ADR-style decisions in
  `docs/IMPLEMENTATION_ROADMAP.md`; dependency: none.
- **Acceptance:** MVP/non-MVP, exact burn baseline, zones, three screens, and
  persistence/rendering boundaries are unambiguous.
- **Checks/risks:** Markdown review against current `src/main.js`, `public/sw.js`,
  `vite.config.js`, and deploy workflow. Revisit decisions only through versioned
  rules/schema changes.
- **Acceptance evidence:** Product boundaries and the current prototype are recorded in
  ADR-001 and the scope lists; exact match/burn behavior and zones are in ADR-003 and
  Canonical rules and terminology; the three-screen constraint is in ADR-004 and
  Screens, settings, and input; authority/rendering and storage boundaries are in
  ADR-002, ADR-005, Architecture, and Persistence; relative PWA/Pages constraints and
  current immediate service-worker activation are in ADR-006 and PWA and updates.

### 2. Test tooling and deterministic seeded RNG
- **Goal/files:** Add existing-project-compatible test runner/config and
  `src/domain/rng.js`, `tests/unit/rng.*`; depends on 1.
- **Acceptance:** Same seed/state produces identical shuffle and sequence; state
  serializes/restores exactly; no hidden `Math.random`.
- **Checks/risks:** Unit sequence/state tests and manual seed replay. Choose a small,
  documented algorithm before saves ship.

### 3. Card model, decks, zones, setup, and invariants
- **Goal/files:** Add `cards.js`, `deck.js`, `zones.js`, `invariants.js`, setup tests;
  depends on 2.
- **Acceptance:** Exactly 52 unique immutable identities, source shuffle deterministic,
  ordered zones validate conservation and ownership.
- **Checks/risks:** Unit duplicate/missing-card and setup tests; reject malformed zones.

### 4. Configurable burn-enabled/disabled rules
- **Goal/files:** Add `ruleset.js`, `burn-evaluator.js`, fixtures/tests; depends on 3.
- **Acceptance:** Baseline scope is exact; disabled transfers eligible cards and makes
  zero burn RNG calls; validator rejects ambiguous future predicates.
- **Checks/risks:** Unit enabled/disabled and card/rank/suit/percentage precedence
  fixtures; defer editor and duration policy.

### 5. Pure clash/tie state machine and conservation
- **Goal/files:** Add `match-machine.js`, `events.js`, transition tests; depends on 4.
- **Acceptance:** Paired source-stage/personal-stage reveals, multi-ties, exhaustion,
  inability, terminal states, events, and stable conservation all work without
  Three.js.
- **Checks/risks:** Exhaustive targeted tie/inability tests plus property/fuzz tests
  over seeds; inspect event settlement before presentation.

### 6. Seeded simulation harness
- **Goal/files:** Add `simulation.js`, CLI/test harness, statistical report fixture;
  depends on 5.
- **Acceptance:** Reproducible seeded runs measure clash count, burn count, terminal
  reason, and duration estimate for default rules.
- **Checks/risks:** CI deterministic simulation test; it informs baseline tuning but
  never constrains burn-disabled/custom modes or alters rules.

### 7. Three-screen coordinator and DOM shell
- **Goal/files:** Split `main.js` into bootstrap/coordinator/menus/HUD skeleton and
  update `style.css`; depends on 1.
- **Acceptance:** Main, Settings, Game are the only top-level screens; overlays do not
  alter screen count; Resume availability is injectable.
- **Checks/risks:** Browser navigation/manual DOM semantics check; avoid framework
  dependency and preserve existing PWA registration.

### 8. Settings persistence and graphics/reduced-motion controller
- **Goal/files:** Add `ui/settings-controller.js`, settings repository, tests; depends
  on 7.
- **Acceptance:** Quality/render cap, speed, reduction persist separately; media
  preference initializes only absent explicit override.
- **Checks/risks:** Unit storage fallback and browser media-query/manual reload tests;
  burning absent from this UI.

### 9. Versioned active-run persistence, validation, migrations, recovery
- **Goal/files:** Add persistence repository/schema/migrations and fixtures; depends
  on 2–5.
- **Acceptance:** Atomic valid stable snapshots restore equivalently; version migration
  and corrupted/unknown saves recover by discard/start-new.
- **Checks/risks:** Unit migration/validation/corruption and deterministic
  save-resume-equivalence tests; IndexedDB quota/error handling.

### 10. Pause/resume/autosave/page lifecycle
- **Goal/files:** Add pause overlay/lifecycle wiring and integration tests; depends on
  7 and 9.
- **Acceptance:** Autosaves post-clash/on pause and best-effort background events;
  never snapshots mid-resolution; restore has no RNG replay.
- **Checks/risks:** Browser refresh, visibility/background interruption and paused-save
  manual checks; lifecycle APIs vary by browser.

### 11. Three.js battlefield and responsive layout
- **Goal/files:** Add battlefield/layout modules and refactor current scene; depends
  on 5 and 7–8.
- **Acceptance:** Logical layout/camera/HUD reserves work across declared modes and
  capped DPR; domain works when rendering is paused.
- **Checks/risks:** Resize/orientation browser tests and phone/tablet/desktop manual
  matrix; dispose replaced renderer resources.

### 12. Generated classic fronts/back, registry, cache, disposal
- **Goal/files:** Add theme registry, classic generator, texture cache, fixture; depends
  on 3 and 11.
- **Acceptance:** All classic faces/back readable; saved theme IDs validate/fallback;
  alternate fixture theme works without domain edits.
- **Checks/risks:** Registry/cache unit tests and visual high-DPI/manual memory checks.

### 13. Committed-event-to-animation pipeline
- **Goal/files:** Add event player and renderer adapters; depends on 5, 8, 11–12.
- **Acceptance:** Animation consumes already-committed events; speed/reduced-motion can
  shorten/skip presentation without changing results; pending event restores safely.
- **Checks/risks:** Unit adapter ordering and browser skip/refresh tests; no engine
  calls from callbacks.

### 14. Pointer interactions and responsive HUD
- **Goal/files:** Add input controller and complete HUD; depends on 7, 11, 13.
- **Acceptance:** Click/tap reveal/continue/pause work for mouse/touch/pen with target
  sizes, cancellation, focus styles, and no duplicate activation.
- **Checks/risks:** Playwright/device-emulation plus real touch manual checks; keyboard
  remains explicitly post-MVP.

### 15. AI and complete source-to-personal-stage match flow
- **Goal/files:** Add AI controller/encounter wiring and integration tests; depends on 5,
  13–14.
- **Acceptance:** AI advances the automatic opponent; source ownership then one-time
  personal shuffles and terminal conditions are visible and deterministic.
- **Checks/risks:** Seeded full-match tests and manual complete match; reserve modifier
  extension points without implementing them.

### 16. Main, pause, resume, overwrite, and end-state integration
- **Goal/files:** Integrate menus, save availability, confirmation, and run summary;
  depends on 8–10 and 15.
- **Acceptance:** Valid-only resume, overwrite/restart confirmation, Save & Main Menu,
  status, and end overlay satisfy the three-screen model.
- **Checks/risks:** Browser end-to-end start/pause/refresh/resume/overwrite tests.

### 17. PWA offline/update hardening
- **Goal/files:** Evolve `public/sw.js`, manifest, and lifecycle integration; depends
  on 9–10 and 16.
- **Acceptance:** Offline shell and resume work, old caches clean up, update waits for
  stable save, and Pages relative deployment remains valid.
- **Checks/risks:** Service-worker/offline/update browser tests and install/standalone
  manual checks; never cache IndexedDB state.

### 18. Performance, context loss, accessibility baseline, cross-device QA
- **Goal/files:** Add profiling/QA fixtures and context handlers; depends on 11–17.
- **Acceptance:** Disposal/context restore from state, accessible status region/semantic
  controls, targets/focus baseline, and measured hypotheses are documented.
- **Checks/risks:** Device/browser matrix below; do not claim full keyboard support.

### 19. MVP release gate and definition of done
- **Goal/files:** Add release checklist/reproducibility report; depends on 1–18.
- **Acceptance:** All automated suites pass; default and disabled burn tests, save
  equivalence, offline/update, context loss, and required manual matrix are signed off.
- **Checks/risks:** Release candidate build on Pages path; rollback is cache/schema-aware.

### 20. Post-MVP expansion
- **Goal/files:** First-class full keyboard support (navigation, gameplay, shortcuts,
  focus-flow tests/instructions), then encounter/reward/relic/route systems, multiple
  themes, audio/haptics, privacy-conscious optional metrics, and only later optional
  slots/cloud sync.
- **Acceptance:** Each remains separately versioned and does not undermine deterministic
  saves or zone invariants.
- **Checks/risks:** Accessibility and privacy reviews precede release.

## Test pyramid and device matrix

Favor many fast unit tests for RNG, cards/zones, rules, invariants, migrations, and
theme registry; fewer integration tests for match-to-event-to-save equivalence and
screen coordination; and focused browser tests for IndexedDB, lifecycle, service
worker, pointer events, resize, and updates. Run seed/property tests over a bounded
representative seed set in CI and retain failing seeds as fixtures.

Manual release checks cover current Chromium, Firefox, and Safari where available;
phone portrait/landscape (including iOS Safari and Android Chrome), tablet, desktop
mouse, touch, and pen; normal/reduced motion; online/offline/install/standalone;
fresh run, tie, source-stage transition, pause/background/refresh/resume, corrupt save,
update waiting at a stable boundary, and WebGL context restoration.

## MVP definition of done

A clean install can launch offline after first load, start a seeded 52-card game,
visibly and deterministically settle pairs/ties with the documented burn on/off
behavior, preserve all cards, complete source and personal stages, and end correctly.
It can save at stable boundaries, safely recover or discard bad saves, resume exactly
without replaying randomness, render responsively with generated classic cards, and
operate primary controls via mouse/touch/pen. Settings persist independently,
updates do not interrupt unsafe resolution, and all listed automated and manual
release checks are complete. The exclusions above remain exclusions until dedicated
post-MVP milestones approve them.

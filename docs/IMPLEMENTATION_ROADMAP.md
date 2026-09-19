# Soulcard implementation roadmap

**Date:** September 19, 2026
**Status:** implementation plan; this document makes no application changes.

Track milestone completion in [`MILESTONES.md`](./MILESTONES.md).

## Product decision record and scope

Soulcard remains a framework-light, plain-JavaScript Vite PWA. The current single
Three.js scene/render loop is an appropriate visual starting point, not a reason to
move authoritative rules into Three.js or to rewrite the application around a UI
framework. Evolve the existing relative Vite base, manifest, service worker/app-shell
cache, and GitHub Pages workflow incrementally.

The MVP is a single-player, player-versus-AI, fast-burning War-style match. The
micro-loop is: read the HUD and next action, tap/click **Reveal/Continue**, resolve
the paired reveal (and any ties) in a pure engine, commit deterministic ownership and
burn results, show concise cause-and-effect feedback, autosave at a stable boundary,
and continue until a side cannot reveal. There is no forced choice on every reveal.

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

## Rules and terminology

`Card` is immutable game identity: `{ id, suit, rank, value }`, where `id` is unique
across the classic 52-card set, `value` makes Ace (14) high, and suits never affect
comparison. Presentation does not own cards: it receives `frontThemeId` and
`backThemeId`, not image data.

At new-game setup, seedable RNG shuffles one `sourceDeck`. For each clash, reveal one
card for player and one for opponent from the source while it remains; during this
**source phase**, resolved cards establish ownership in each side's `wonPile`. After
the source is exhausted, shuffle each owned/won pile into that side's `drawPile`
using the saved RNG, player first and then opponent, then enter **personal phase**.
Thereafter each side reveals from its own draw pile. Before any required reveal, an
empty draw pile recycles that side's complete nonempty `wonPile` by shuffling it into
`drawPile`; when both recycle at the same boundary, process player then opponent. A
side unable to reveal after this recycling loses.

If a tied reveal exhausts the source, retain `contestedPile`, perform the same
player-first source-to-personal shuffles, remain in `resolving`, and continue the tie
with the next required reveal from the personal draw piles.

A clash keeps every revealed card, in reveal order, in `contestedPile`. Equal ranks
add another pair to that same pile. If a side cannot supply a required tie card, the
other side wins the whole unresolved contest according to the same settlement rule;
if neither can supply it, resolve deterministically as a draw/end condition documented
by the engine (the recommended MVP choice is both fail -> terminal draw), never by
discarding cards implicitly.

### Baseline burning decision

The baseline data-driven ruleset has `burn.enabled: true`. On a resolved clash:

1. Identify the decisive pair: the final unequal reveal, or the available card(s)
   when inability resolves the contest.
2. Every winner-side card in the contested pile, including the decisive winning card,
   moves to the winner's `wonPile`.
3. Each eligible card owned by the losing side in the complete contested pile moves to
   `burnPile`; this includes losing-side cards from earlier tie rounds and the
   decisive losing card.
4. If `burn.enabled: false`, **all** contested cards (including eligible losing cards)
   transfer to the winner's `wonPile`. No burn random decision is evaluated or
   consumed.

This preserves the premise that the winner retains its decisive card, while the
baseline removes losing ownership and accelerates ordinary play. The evaluator must
be pure and return a committed list of transfers/burns before any animation begins.
Later rules may add ordered predicates (explicit card ID, rank, suit, percentage),
with schema validation and unambiguous precedence, but the MVP UI does not expose an
editor. A percentage predicate consumes the domain RNG only when enabled and reached.
Optional anti-stalemate rules, if ever wanted, must be separate, explicit,
deterministic, configurable, and must not silently alter a disabled-burn match.

### Conservation invariant and shuffle timing

At every stable transition, every one of the 52 unique IDs exists in exactly one
authoritative zone: `sourceDeck`, `player.drawPile`, `player.wonPile`,
`opponent.drawPile`, `opponent.wonPile`, `contestedPile`, `burnPile`, or an explicitly
named ephemeral `inPlay` zone during an atomic engine transition. Counts total 52,
zones have no duplicate IDs, and a card's owner/zone agrees with the ordered zone
array. A transition may use `inPlay`, but its committed result must restore the
stable invariant before it emits an event or permits a save. Do not reshuffle on every
reveal: shuffle source only at setup; shuffle each side's `wonPile` at the
source-to-personal boundary and whenever its personal-phase `drawPile` is empty before
a required reveal.

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
Main, Settings, and Game. `match-machine` owns phases/actions; cards/deck/zones own
validation; `rng` exposes seed plus serializable internal state; `burn-evaluator`
validates rules and returns settlements; `ai-controller` chooses deterministic
encounter advancement. The event queue contains committed domain events. Persistence
serializes snapshots/events. Renderer, responsive layout, theme cache, input, and DOM
UI are replaceable consumers.

The renderer owns geometries, materials, and textures and disposes them on theme
replacement, screen teardown, and cache eviction. Handle `webglcontextlost` by
preventing default, pausing presentation without changing domain state, then
recreate renderer resources from the current snapshot on restoration.

### State-machine transitions

| Phase | Action/condition | Next phase | Commit |
|---|---|---|---|
| `new` | start with seed/rules | `ready` | shuffled source |
| `ready` | reveal/continue | `resolving` | pair in contested/in-play |
| `resolving` | ranks tie and both can reveal | `resolving` | contested retained; next pair revealed atomically |
| `resolving` | ranks tie and source is empty | `phaseTransition` | contested retained |
| `resolving` | winner or inability resolves | `ready` / `phaseTransition` | settlement event, zones, burn |
| `phaseTransition` | source empty with unresolved contest | `resolving` | owned piles shuffled to personal draw piles; next pair revealed atomically |
| `phaseTransition` | source empty after settlement | `ready` | each owned pile shuffled to draw pile |
| `resolving` | personal draw empty and won pile nonempty before a required reveal | `resolving` | won pile recycled into draw pile |
| any nonterminal stable phase | required card absent | `ended` | terminal result |
| `ready` | pause/save | `paused` overlay | atomic snapshot |
| `paused` | resume | prior `ready` | no recalculation |

Internally, tie reveal can loop through an atomic `resolving` substate; it must not be
persistent halfway through a random settlement. The end overlay is Game state, not a
fourth screen.

### Committed event example

```json
{
  "eventVersion": 1,
  "id": "run-42:clash-17",
  "type": "clashSettled",
  "turn": 17,
  "phase": "personal",
  "winner": "player",
  "reveals": ["c-10H", "c-10C", "c-AS", "c-KD"],
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
source deck/phase, both zones and counts, reveal/comparison area, tie pile, burn
pile/count, status, and pause. Pause is an overlay with Resume, Save & Main Menu,
restart confirmation, save status, and optionally a safe settings subset/link. End
summary is another Game overlay.

Define battlefield positions in logical coordinates, layout modes for phone portrait,
phone landscape, tablet, and desktop, reserved HUD rectangles, safe-area insets, and
camera fitting rather than device-specific scattered coordinates. Specify a minimum
supported viewport (for example 320×480 CSS px); below it, retain primary controls,
compact counts, and scroll/letterbox gracefully. Use `ResizeObserver` plus resize and
orientation events to recompute layout, camera projection, renderer size, and capped
pixel ratio.

Pointer Events unify mouse, touch, and pen. Primary actions are semantic DOM buttons
at roughly 44 CSS px minimum, work by click/tap, never require gestures or hover, keep
visible focus styles, use pointer capture only where a battlefield gesture needs it,
define `touch-action` deliberately, handle `pointercancel`, and suppress synthetic
duplicate click/tap activation. Gestures can later enhance, not replace, actions.

## Persistence

Use IndexedDB for structured active-run snapshots: it supports atomic record writes,
larger ordered data, and evolution better than localStorage. Settings can use
localStorage initially because they are small, independent primitives and are safe to
read before UI boot; namespace and version them. Either store must fail gracefully.
Cache Storage holds no save data.

Snapshots are versioned with `saveSchemaVersion`, `gameRulesVersion`, ISO timestamp,
and checksums/structural validation as appropriate. Migration functions are
version-to-version, tested from fixtures, and reject unknown future versions. Invalid,
incomplete, or corrupt runs are quarantined/discardable and leave Main with Resume
disabled and a clear discard/start-new recovery path—never a resume crash loop.

Save only at stable domain boundaries: after every committed clash, explicit pause,
and best effort on `visibilitychange`, `pagehide`, and lifecycle freeze events; do not
depend on `unload`. Serialize ordered zones, phase, contested/in-play state, burn
pile, turn counters, ruleset including burn flag, seed and RNG state, run status,
future modifier extension point, and committed pending visual event. Restore validates
and migrates, reconstructs visuals from snapshot, and replays/skips the saved
presentation without recalculating a domain result.

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
    "phase": "personal",
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
    "phase": "personal",
    "winner": "player",
    "reveals": ["c-10H", "c-10C", "c-AS", "c-KD"],
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

Retain relative paths and GitHub Pages deployment. Extend the existing service worker
to precache the versioned app shell and generated/local assets where applicable,
remove obsolete versioned caches on activate, and keep runtime caching bounded.
Generated card textures are recreated locally; IndexedDB saves remain independent of
Cache Storage. Offer update availability, but defer reload while a resolution is
uncommitted: first reach and save a stable boundary. Verify installability,
standalone/fullscreen safe areas, manifest icons, offline launch/resume, cache upgrade,
and update deferral.

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
- **Acceptance:** Paired source/personal reveals, multi-ties, exhaustion, inability,
  terminal states, events, and stable conservation all work without Three.js.
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

### 15. AI and complete source-to-personal match flow
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
fresh run, tie, source transition, pause/background/refresh/resume, corrupt save,
update waiting at a stable boundary, and WebGL context restoration.

## MVP definition of done

A clean install can launch offline after first load, start a seeded 52-card game,
visibly and deterministically settle pairs/ties with the documented burn on/off
behavior, preserve all cards, complete source and personal phases, and end correctly.
It can save at stable boundaries, safely recover or discard bad saves, resume exactly
without replaying randomness, render responsively with generated classic cards, and
operate primary controls via mouse/touch/pen. Settings persist independently,
updates do not interrupt unsafe resolution, and all listed automated and manual
release checks are complete. The exclusions above remain exclusions until dedicated
post-MVP milestones approve them.

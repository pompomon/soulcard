# Soulcard architecture

Normative implementation contracts: what must stay true and where it lives in code. Update this
file in the same PR as the code. Related: [CAMPAIGN.md](CAMPAIGN.md) (Campaign rules),
[ROADMAP.md](ROADMAP.md) (status, backlog, release checklist), [HISTORY.md](HISTORY.md) (retired
plans) and [../art/README.md](../art/README.md) (art pipeline).

## 1. Principles

- **Domain authority.** `src/domain` is pure and deterministic; its machines and one
  serializable RNG alone decide outcomes. No Three.js, DOM, clocks or `Math.random`.
- **Presentation consumes.** `src/presentation` and `src/ui` read immutable snapshots and
  committed events. Animation, motion settings, skips, pauses and context restores never settle
  rules, draw RNG, mutate state or change an outcome.
- **Three screens:** Main, Settings and Game. Pause, summaries and panels are overlays in Game.
- **Storage.** The one active run lives in IndexedDB, settings in localStorage; Cache Storage
  holds assets only.
- **PWA continuity.** Relative URLs, a production-only service worker, a revisioned shell and
  GitHub Pages subpath deploys.
- **Playable increments.** Every milestone ships playable value. Plain JS, Three.js and Vite; no
  UI framework.
- **Versioning.** Bump in the same PR and keep fixtures of the superseded shape:

  | Change | Bump |
  |---|---|
  | Stored shape | `SAVE_SCHEMA_VERSION`, plus a migration or quarantine |
  | Rule semantics, RNG algorithm or draw order | New ruleset ID or `GAME_RULES_VERSION` |
  | Event contract | `EVENT_VERSION`; older versions stay readable |

## 2. Classic rules

- **Stage:** `source` or `personal`, separate from the machine state.
- **Clash:** paired reveals, player first, through one settlement or a terminal draw. A tie adds
  another reveal round to the same contest.
- **Stable boundary:** the action has committed, `inPlay` is empty, conservation holds, RNG is
  captured and the machine is `ready`, `paused` or `ended`. Saves and events happen only here.
- **Ownership:** a card in a side's `drawPile` or `wonPile`; contested cards keep `suppliedBy`.
- **Zones** (`src/domain/zones.js` `createInitialZones`): `sourceDeck`, `player`/`opponent`
  `drawPile` and `wonPile`, `contestedPile` (`{ cardId, suppliedBy }`), `burnPile` (out of play)
  and `inPlay`. All are ordered: draws take index 0 and settlement appends in reveal order.

Flow (`src/domain/match-machine.js`):

- Setup shuffles one 52-card `sourceDeck`; both sides reveal from it in the source stage.
- When the source empties, each `wonPile` is shuffled into its `drawPile`, player first, and the
  personal stage begins; a tie in progress carries over.
- Then an empty `drawPile` recycles its side's `wonPile` just before a required reveal. Shuffles
  happen only at setup, this boundary and recycles.
- If one side can't supply a required card, the other wins the contest and match. If neither
  can supply a tie card, it's a draw: `contestedPile` stays unsettled and no RNG is used.

Settlement (`src/domain/burn-evaluator.js` `evaluateBurn`): winner-supplied cards, decisive card
included, go to the winner's `wonPile`. Loser-supplied cards from all tie rounds burn when
burning is on, else go to the winner with no RNG use. Any anti-stalemate rule must be separate,
deterministic, configurable and leave no-burn play unchanged.

Conservation (`src/domain/invariants.js` `assertZoneInvariants`, `assertStableBoundary`): each of
the 52 IDs is in exactly one zone after every atomic transition.

Cards (`src/domain/cards.js`): `SUITS` S, H, D, C; `RANKS` 2–10, J, Q, K, A (values 2–14); IDs
`c-<rank><suit>` (`c-10H`); `CARD_IDS` is suit-major. ID format and order define seeded
permutations. `compareCards` orders by value, except that 2 beats Ace (and only Ace).

Rulesets (`src/domain/ruleset.js` `validateRuleset`):

- `BASELINE_RULESET` `mvp-baseline-v2` burns all loser cards; `NO_BURN_RULESET`
  `mvp-no-burn-v2` is `{ burn: { enabled: false } }`. Built-in IDs must match their exact
  definitions. Saves store the full ruleset; the Turn burning setting picks one.
- Custom rulesets (tests only) add ordered `rules` (`{ match, outcome }`) and `defaultOutcome`
  (`burn` or `transfer`). Selectors are conjunctive `cardIds`, `ranks`, `suits`, or a lone
  `chance` in [0, 1] taking one `next() < chance` draw when reached. First match wins.

Campaign extends these rules: see [CAMPAIGN.md](CAMPAIGN.md).

## 3. Domain contracts

### RNG (`src/domain/rng.js`)

- `createRng(seed)`: Mulberry32 over a uint32 seed, with no coercion. Add `0x6D2B79F5`, mix with
  `Math.imul`, divide by 2^32; `next()` is in [0, 1). Not cryptographic.
- `snapshot()` is exactly `{ algorithm: 'mulberry32', seed, state }`; `restoreRng` validates it
  and resumes. Reading or restoring consumes nothing.
- `shuffle(items, rng)` returns a Fisher–Yates copy, walking `length - 1` down to 1 with one
  draw each: 51 draws per deck.
- `deriveRngSeed`, `createDerivedRng` and `drawIndex` derive named streams for Campaign content.
- The algorithm, shuffle walk and draw counts are compatibility contracts; never change them
  under the `mulberry32` ID.

Replay check (prints state `1767636961`):

```sh
node --input-type=module -e "
import assert from 'node:assert/strict'
import { createRng, restoreRng, shuffle } from './src/domain/rng.js'
const step = (rng) => ({ value: rng.next(), order: shuffle(['a', 'b', 'c', 'd'], rng) })
const a = createRng(12345)
step(a)
const b = restoreRng(JSON.parse(JSON.stringify(a.snapshot())))
assert.deepEqual(step(b), step(a))
console.log(a.snapshot())"
```

### Match machine (`src/domain/match-machine.js`)

- `createMatch({ runId, seed, ruleset })` returns a deeply immutable `ready` snapshot;
  `revealOrContinue(match)` resolves one whole clash into `{ match, event }`; `pauseMatch` and
  `resumeMatch` only toggle `ready`/`paused`; `validateMatchState` checks any snapshot.
- Snapshot keys: `runId`, `ruleset`, `rng`, `stage`, `machineState`, `turn` (completed clashes),
  `status` (`active` or `ended`), `outcome`, `zones` and `pendingEvent`.
- `outcome` is `{ result: 'win', winner, reason }`, with `opponentUnableToReveal` or
  `playerUnableToReveal`, or `{ result: 'draw', reason: 'mutualInability' }`.

| From | Condition | To |
|---|---|---|
| `new` | Seed, ruleset | `ready` |
| `ready` | Reveal | `resolving` |
| `resolving` | Tie, or recycle before a required reveal | `resolving` |
| `resolving` | Decisive, source remains | `ready` + `clashSettled` |
| `resolving` | Source empties | `stageTransition` |
| `stageTransition` | Won piles shuffled, player first | `ready`, `resolving`, `ended` |
| `resolving` | One side / neither can supply a card | `ended` (win / draw) |
| `ready` / `paused` | Pause / resume | `paused` / `ready` |

`resolving` and `stageTransition` exist only inside one action and are never published or saved.
AI (`src/domain/ai-controller.js` `createAiController`): `chooseEncounterAction(match)` returns
`REVEAL_OR_CONTINUE_ACTION` for a ready match, else throws; no timers or randomness.

### Committed events (`src/domain/events.js`)

- `EVENT_VERSION = 4`; versions 2 and 3 stay readable. Version 3 added reveal `from`
  (`sourceDeck`, `player.drawPile`, `opponent.drawPile`); version 4 uses `compareCards`.
  `CAMPAIGN_EVENT_VERSION` (5) events go to Campaign validation.
- `clashSettled` keys: `eventVersion`, `id`, `type`, `turn`, `stage`, `winner`, `reveals`
  (`{ cardId, suppliedBy, from }`), `transfers` (`{ cardId, to }`), `burned`, `stateFingerprint`
  and `pendingPresentation` (`settlement-v1`).
- `clashDrawn` drops `winner`, `transfers` and `burned` and adds `reason: 'mutualInability'`;
  its `pendingPresentation` is `draw-v1`.
- `id` is `<runId>:clash-<turn>`; `stateFingerprint` binds the event to the committed state.
  Events are deeply immutable and equal the snapshot's `pendingEvent`.

### Simulation (`src/domain/simulation.js`)

- `simulateMatch` and `createSimulationReport` drive only `createMatch` and `revealOrContinue`.
- Guard: `DEFAULT_MAX_CLASHES` (10,000) per run, at most `MAX_SIMULATION_CLASHES` (1,000,000);
  a guarded run reports `truncated`. Corpus: unique uint32 seeds, at most `MAX_SIMULATION_SEEDS`
  (10,000); `CANONICAL_SIMULATION_SEEDS` is 0–999. Report version: `SIMULATION_REPORT_VERSION` 1.
- `DEFAULT_TIMING_PROFILE` `mvp-presentation-estimate-v1` estimates 400 ms per reveal, 600 per
  settlement, 200 per burn and 1,200 per end; changing it needs a new ID and fixture.
- `tests/fixtures/simulation-report.json` stays byte-identical unless rules change on purpose.
  Results are never pass thresholds.

## 4. App shell

### Screens and runs

- `src/app/screen-coordinator.js` mounts one of `SCREEN_IDS` at a time.
- Main (`src/ui/menus.js`) enables **Resume Game** only after a valid restore (completed runs
  included) and offers **Discard Saved Game** for quarantined records.
- **Start New Game** confirms before replacing a current, restoring or quarantined run.
  `src/app/new-match.js` `createNewMatch` draws five Web Crypto words: the seed and a
  `run-<32 hex>` ID. The turn-zero save is queued before Game opens; restarts share this path.
- Pause (`src/ui/overlays.js`): **Save & Main Menu** leaves only after a successful save. The end
  summary (never shown with Pause) waits for the terminal save and presentation.
- `src/app/run-controller.js` `createRunController` owns the snapshot, applies validated actions
  through the machine, then publishes and saves. `queueSave` serializes writes so a stale save
  never lands last; a failed save warns and play continues. Replaced runs' results are ignored.

### Settings (`src/app/settings.js`, `src/persistence/settings-repository.js`)

| Key `soulcard.settings.v1.<field>` | Values | Default |
|---|---|---|
| `burnEnabled` | `true`, `false` | `true` |
| `quality` | `low`, `balanced`, `high` | `balanced` |
| `renderScaleCap` | 1, 1.5, 2 | 2 |
| `animationSpeed` | 0.5, 1, 1.5, 2 | 1 |
| `reducedMotionOverride` | `null` (follow system), `true`, `false` | `null` |
| `cardArt` | `tarot-pixel`, `tarot-hd` | `tarot-pixel` |

- One JSON value per key; malformed values fall back to defaults. If storage fails, settings
  stay in memory (`persistent: false`).
- `createSettingsSnapshot` resolves reduced motion as the override, or else the system
  preference (`src/ui/settings-controller.js` `REDUCED_MOTION_QUERY`).
- `burnEnabled` applies to new and restarted games only; Resume keeps the saved ruleset.
- `quality` sets texture scale 1, 2 or 3 (`low` also drops antialiasing) and rebuilds the
  renderer. Pixel ratio is `min(devicePixelRatio, renderScaleCap)`.

### Input (`src/presentation/input.js`, `src/ui/hud.js`)

- Pointer Events, primary pointer only; `pointercancel` cancels. Native `click` still works for
  assistive activation.
- **Reveal / Continue** is canonical. The active deck is a shortcut with a 44×44 CSS px minimum
  target: click it, or drag past `DEFAULT_DRAG_THRESHOLD` (8 px) to the reveal area. Bad drops
  snap back.
- Every path calls one guarded action and stays disabled through save and presentation. Nothing
  needs a gesture or hover; the canvas uses `touch-action: none`.

### Auto-reveal (`src/app/auto-reveal-coordinator.js`)

- An opt-in checkbox, off on every Game mount and never persisted. A manual reveal starts it.
- It continues only after a `completed` or `skipped` presentation, a successful save, a `ready`
  renderer and a non-inert HUD. A microtask then rechecks the run ID, pending event ID, `active`
  status and `ready` state before `revealOrContinue({ autoChooseNormal: true })`.
- Unchecking, pause, failures, `soulcard:update-blocked`, run replacement, teardown and terminal
  outcomes stop it. Hold: see [CAMPAIGN.md](CAMPAIGN.md).

## 5. Persistence and versioning

- `src/persistence/run-schema.js`: `SAVE_SCHEMA_VERSION = 7`, Classic `GAME_RULES_VERSION = 2`.
  Keys are exactly `saveSchemaVersion`, `gameRulesVersion`, `runType` (`classic` or `campaign`),
  `savedAt`, `runId`, `rng`, `ruleset`, `match` and `pendingEvent`. Classic `match` reserves an
  empty `futureModifiers`.
- `src/persistence/migrations.js` `migrateRunSave`:

  | Stored record | Result |
  |---|---|
  | Schema 7 with its `runType`'s current rules | Loaded |
  | Schema 4–6 Classic | Carried unchanged, rewritten as 7 |
  | Schema 4–6 Campaign, or a wrong rules version | Quarantined: `incompatible-game-rules` |
  | Schema 1–3, unknown or future | Quarantined: `unsupported-save-version` |
  | Malformed | Quarantined: `invalid-save` |

- `src/persistence/run-repository.js`: IndexedDB `soulcard-runs` v1, store `active-runs`, keys
  `active` and `quarantine`. `load()` returns `empty`, `resumable`, `recovery-required` or
  `storage-unavailable`. Quarantined records need an explicit discard; without storage, play is
  session-only.
- Save points: each committed clash, pause, the turn-zero run, and best effort on hidden
  `visibilitychange`, `pagehide` and `freeze` (`src/pwa/lifecycle.js`). Never mid-resolution.
- Restore replays or skips the saved `pendingEvent`; it never recalculates or draws RNG.
- Campaign saves and rules versions: see [CAMPAIGN.md](CAMPAIGN.md).

## 6. Presentation

### Battlefield and layout

- `src/presentation/battlefield.js` `mountBattlefield` owns and disposes the renderer, materials
  and texture cache. Its canvas exists only in Game.
- `src/presentation/layout.js` `classifyBattlefieldLayout`: a shorter side ≤520 px is
  `phone-portrait` or `phone-landscape`; else width <1180 or height <700 is `tablet`; else
  `desktop`. Anchors and HUD reserves live in `MODE_SPECS`. Below `MINIMUM_VIEWPORT` (320×480)
  the view letterboxes.
- `CARD_SIZE` is 1.05×1.45 and card canvases are 300×420 logical px (`themes/canvas.js`). The
  shape is fixed: Tarot proportions break the clearances.
- Per mode (portrait, landscape, tablet, desktop), all piles use `pileScale` 1.25, 1.1, 1.3, 1.3
  and reveals `revealScale` 1.55, 1.4, 1.75, 1.75. Only the decisive card shrinks, to `pileScale`.
- `tests/unit/layout.test.js` (signed `boxClearance()`, one viewport per mode, Classic and
  Campaign) requires ≥0.08 between zones, ≥0.05 to the world edge and a halo gap >0. The max
  overlap-free `pileScale` is about 1.32, 1.11, 1.35, 1.32 (contested vs burn pile), so
  landscape has <0.02 headroom: changing `CARD_SIZE`, scales or anchors needs a new clearance
  pass. `zoneBox()` mirrors battlefield `transientOffset()` and `addPileRepresentative()`.
- Hold sits in the player row in every mode; landscape reveals sit at y ±1.12.
- The active deck keeps its tint and a static halo (`ACTIVE_DECK_HALO_RING` 0.08, `0x75eef5` at
  0.5 opacity, scaled by `pileScale`), not hit-tested and visible even with input disabled.
- Gotcha: `hitTestActiveDeck` and `hitTestPlayerReveal` hard-code half-sizes 0.525 and 0.725
  instead of reading `CARD_SIZE`.

### Textures (`src/presentation/texture-cache.js` `createTextureCache`)

- Keyed by kind, theme, card and scale; an LRU of `TEXTURE_CACHE_ENTRIES` (24) in the
  battlefield. Leased entries are never evicted; if all are leased it throws
  `TextureCacheCapacityError`.
- Hold a lease while a material uses its texture: set `material.map = lease.texture`, and clear
  the map before `lease.release()`.
- A theme's `refine({ scale, canvas, signal })` runs after the `create` preview and must redraw
  the same canvas at the same size (three.js allocates immutable GPU storage on first upload).
  Eviction or invalidation aborts it; failure keeps the preview and reports
  `texture-refine-failed`.

### Themes and card art

- `src/presentation/themes/registry.js`: descriptors are only `{ id, create, refine? }`, with
  kebab-case IDs of ≤64 characters. Duplicates throw; no unregister. Unknown selections fall
  back to classic with a `theme-fallback` diagnostic.
- `src/app/card-art.js` maps the stored option (`tarot-pixel`, the bundled default, or opt-in
  `tarot-hd`) to `tarot-{pixel,hd}-{front,back}-v1`; settings never store theme IDs.
- `src/ui/card-art-controller.js` registers the HD descriptors once; `activate()` and
  `release()` point them at the downloaded pack or back at pixel art.
- Live switch (`battlefield.js` `applyThemeSelection`): visuals lease the new theme before the
  old one is invalidated; nothing remounts. `themeSource` and `themeSelection` are exclusive.
- Card art is presentation only: card IDs, rules, saves, events and RNG never change.
- Tarot suits: H Cups, D Pentacles, C Wands, S Swords. Index plates are `#f2e6c9` or lighter,
  with ≥4.5:1 contrast and ≥28 logical px glyphs, and never sit over art.
- HD is 54 WebP files (~1 MB); pixel art shows until it's ready and whenever it's unavailable.

### Event player (`src/presentation/event-player.js` `createEventPlayer`)

- Plays only a stable snapshot's `pendingEvent`, after its save settles; a failed save warns but
  doesn't block. Duplicates are dropped per Game mount; a new mount replays a restored event.
- `EVENT_PRESENTATION_TIMING`: reveal 400, settlement 600, burn 200 ms, divided by
  `animationSpeed`. Reduced motion jumps straight to the committed state.

### WebGL context recovery (`battlefield.js` `handleContextLost`, `handleContextRestored`)

- Loss: `preventDefault()`, status `lost`, stop the loop, cancel deck input.
- Restore: `restoring`; dispose visuals and the texture cache; new renderer; rebuild from the
  retained snapshot and event; then `ready`, or `failed` (cancels with `graphics-recovery-failed`).
- Only Reveal and the deck are disabled meanwhile. Recovery never runs domain actions, saves or
  draws RNG.

### Phone HUD (`src/style.css`, `src/ui/hud.js`)

- `hud.js` sets `data-layout-mode` and `--hud-{header,comparison,footer,side}-reserve`.
- Portrait footer rows are 42, 42, 28 and 36 px (148); the controls row,
  `calc(var(--hud-footer-reserve, 210px) - 148px)`, fills the rest of the 210 px reserve.
- Labels are 0.75rem without wrapping, values 1rem `tabular-nums`, status 0.75rem.
- A save warning takes the piles row via `:has(.game-save-warning:not([hidden]))`, so `hud.js`
  must toggle `hidden`.
- `accessibility-baseline.test.js` `rule()` matches selector whitespace; reformatting
  `style.css` can break it.

## 7. PWA, offline and updates

- `vite.config.js`: `base: './'`. `createServiceWorkerPlugin` injects the shell list and a
  12-hex SHA-256 revision into `public/sw.js`. `isOptInAsset` keeps `assets/tarot-hd-art-*.webp`
  out of the shell; keep it in step with `HD_FILE_PREFIX` (`tools/card-art/hd-compose.mjs`).
  `cardArtInlineLimit` never inlines card art.
- `src/pwa/update-controller.js` registers `./sw.js` in production only; the manifest's
  `start_url` and `scope` are `./`.
- `public/sw.js`: `soulcard-shell-<rev>` precaches the shell and serves navigations;
  `soulcard-runtime-<rev>` keeps in-scope, ok, non-opaque image, font and audio GETs, at most
  `MAX_RUNTIME_ENTRIES` (32). Install never calls `skipWaiting()`; only the exact message
  `{ type: 'SOULCARD_ACTIVATE_UPDATE' }` does. The new worker then claims clients.
- Install and activate delete unpreserved `soulcard-` caches. `isRevisionCache` exempts
  `soulcard-art-*`; a new persistent cache needs the same exemption. `ART_CACHE_PREFIX` is copied
  in `src/persistence/art-pack-store.js` (workers can't import);
  `tests/unit/art-pack-store.test.js` keeps them equal.
- HD store (`createArtPackStore`, cache `soulcard-art-tarot-hd`): page `fetch()` downloads skip
  the runtime cache (empty destination). Status, `image/webp`, size and SHA-256 are checked
  before storing; pruning waits for a complete download; `inspect()` uses `caches.has`.
- Updates (`src/ui/update-notice.js`): a waiting worker shows **Update now** (never on first
  install). It fires `soulcard:update-blocked`, stopping auto-reveal, and makes the screen inert.
  `src/app/bootstrap.js` `prepareForUpdate` awaits restore and queued writes, then saves the
  stable snapshot; only then is the worker activated, and the page reloads once on `activated`.
  A failed save keeps the old worker and offers a retry.
- Offline checks: `vite preview` sends `Vary: Origin` and `sw.js` matches without `ignoreVary`,
  so serve `dist` with a plain static server.

## 8. Hard bounds and accessibility

| Bound | Limit | Where |
|---|---|---|
| Texture cache | 24 entries | `battlefield.js` `TEXTURE_CACHE_ENTRIES` |
| Tarot texture scale | 2 (600×840) | `tarot-composition.js` `TAROT_MAX_TEXTURE_SCALE` |
| Any card texture scale | 4 | `canvas.js` `MAX_CARD_TEXTURE_SCALE` |
| Transient / contest cards | 8 / 4 | `MAX_TRANSIENT_CARDS`, `MAX_CONTEST_CARDS` |
| Concurrent HD decodes | 2 | `tarot-hd.js` `TAROT_HD_DECODE_CONCURRENCY` |
| Runtime cache | 32 entries | `sw.js` `MAX_RUNTIME_ENTRIES` |
| HD pack | 8,000,000 bytes, tested | `hd-compose.mjs` `HD_PACK_BUDGET_BYTES` |
| Pixel sprite module | 25 kB gzip target, not enforced | `milestone-19-profile` harness |

Measured timings and heap readings are observations, not budgets.

Accessibility (`tests/unit/accessibility-baseline.test.js`):

- Named native controls with targets ≥44×44 CSS px, letterboxed layouts included.
- A 3px visible focus outline; polite, atomic status regions.
- The canvas is presentational; Reveal / Continue is the accessible action.
- `lang="en"`, `viewport-fit=cover` and safe-area insets; minimum viewport 320×480.
- Full keyboard play isn't a contract yet.

## 9. Testing

- **Unit** (`tests/unit`): modules plus build, CSS and service-worker guards; no DOM or WebGL.
- **Integration** (`tests/integration`): cross-module flows, including save/restore equivalence.
- **Browser harnesses** (`tests/browser/*.html` under `npm run dev`): IndexedDB, service worker,
  pointers, WebGL, card art and profiling.
- Seeded tests use fixed, bounded seeds and exact expectations; failing seeds become fixtures.
- Browser check (rendering, HUD, PWA): text-only headless Chrome. Inspect the DOM, confirm `#app`
  contains a `canvas`, read the harness `data-status`, check console output and process status.
  No screenshots; Google-endpoint firewall warnings are non-fatal.
- QA scope: Chrome emulation at 320×480 and 844×390, DPR 3; no physical-device, cross-browser,
  tablet, desktop or hardware-tier sign-off.

Done means:

- `npm test` and `npm run build` pass; the simulation fixture changes only with intended rules.
- Rendering, HUD and PWA changes pass the browser check; releases follow
  [ROADMAP.md](ROADMAP.md).
- This file, and CAMPAIGN.md where relevant, change in the same PR.

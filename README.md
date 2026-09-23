# Soulcard

A framework-light, fullscreen card-game PWA with a deterministic domain engine and
Main, Settings, and Game screen shell. The Game screen contains a responsive Three.js
battlefield that reconciles authoritative match snapshots and presents already-committed
events with generated classic card fronts/backs from a bounded texture cache.

## Development

Use Node 24 (the CI baseline). From the repository root:

```sh
npm ci
npm run dev
```

Build the production site with `npm run build`; serve it with `npm run preview`.

## Texture cache ownership

Keep an acquired texture lease while a material references its texture. Release it only
after the map is replaced or the material is no longer used:

```js
const lease = cache.acquireFront({ cardId: 'c-AS' })
material.map = lease.texture

material.map = null
lease.release()
material.dispose()
```

## Committed-event presentation

`src/presentation/event-player.js` reads only a stable match snapshot's
`pendingEvent`. Game waits for the corresponding save attempt to settle before
presentation, but a storage failure does not block in-memory play. Duplicate
controller notifications are suppressed within one Game mount; restoring the same
pending event in a fresh mount replays it.

Animation speed scales presentation time, while effective reduced motion skips
transitions and immediately reconciles the battlefield to the committed snapshot.
Presentation never advances the match machine, evaluates burn rules, or consumes RNG.
Current events record each reveal's source/personal pile origin; version 2 saved events
remain readable.

## Pointer input and HUD ownership

`src/presentation/input.js` owns mouse, touch, and pen pointer sequences for the
Game screen's semantic Reveal/Continue and Pause buttons and the supplemental
hit-tested active-deck shortcut. It accepts only primary pointer sequences, handles
cancellation, suppresses the following compatibility click, and retains native click
fallback for assistive or programmatic button activation. The deck keeps a 44×44
CSS-pixel screen-space hit target even when its rendered card is smaller. A short
press/release clicks the deck; movement beyond the drag threshold captures the pointer
and lets the top card be dropped on the player reveal area. Invalid or interrupted
drops snap the visual back without advancing the match.

The Game HUD routes the button, active-deck click, and accepted top-card drop through
the same `run-controller` Reveal action, disables them through the corresponding save
and committed-event presentation, and derives counts, comparison results, progress,
and outcomes from stable snapshots and committed events. The semantic button remains
the accessible canonical control. Input and presentation never settle rules or consume
domain RNG.

Start New Game creates a 52-card match from Web Crypto entropy, records the seed in the
domain RNG snapshot, and immediately queues the stable turn-zero run for IndexedDB
persistence before play continues. The canonical comparison order is unchanged except
that 2 beats Ace; 2 still loses to 3 through King.

The Settings screen persists a Turn burning preference independently from active runs.
It selects the burn-enabled or burn-disabled ruleset only when starting or restarting a
game. Resuming keeps the complete ruleset stored with that run. Replacing a current or
still-restoring saved run requires confirmation.

## Run menus and summaries

Main enables Resume only after a valid ready, paused, or completed run restores. Invalid
or incompatible saves remain quarantined until explicitly discarded; unavailable storage
is reported without blocking session-only play. Current saves use save schema version 3
and game rules version 2; rules-version-1 saves are incompatible because their clash
comparison semantics differ.

Pause remains an overlay inside Game. Resume continues the exact snapshot, Save & Main
Menu navigates only after a successful stable save, and Restart Game requires confirmation
before creating a fresh entropy-seeded run. A failed Save & Main Menu attempt stays paused
and can be retried. Completed runs show a Game-owned summary after the terminal save and
committed-event presentation settle; returning to Main retains the completed run so Resume
can reopen its summary.

## AI encounter flow

`src/domain/ai-controller.js` is the automatic-opponent policy boundary. One player
Reveal/Continue activation selects one encounter action. The AI controller does not
produce match snapshots or use timers, browser state, presentation callbacks,
`Math.random`, or domain RNG.

`run-controller` validates the injected AI action, applies it to the current snapshot
through the match machine, and queues the resulting stable save before the HUD presents
that event. Ties, the one-time source-to-personal transition, personal-pile recycling,
and terminal inability therefore remain authoritative domain transitions. The empty
persisted `futureModifiers` field remains reserved; no modifier behavior is implemented.

## Offline cache and updates

The production service worker precaches one content-revisioned app shell using relative
URLs, so the GitHub Pages repository path can relaunch offline after one successful
install. Shell files are immutable within a revision. A separate runtime cache accepts
only successful same-origin image, font, and audio requests and evicts its oldest entries
above 32; generated card textures are recreated locally and never enter Cache Storage.
The worker preserves the active, installing, and latest waiting shells while removing
superseded deferred revisions, including during upgrades from pre-marker workers, then
removes every obsolete Soulcard cache on activation.
Active runs remain exclusively in IndexedDB, so clearing application caches does not delete
a saved game.

An installed update waits until the player selects **Update now**. Soulcard immediately
blocks the current screen, waits for initial restoration and any queued write—including a
recovery discard—and saves the latest stable ready, paused, or ended snapshot before asking
the latest waiting worker to activate. The page reloads only after that worker reaches
`activated`. A save failure leaves the current worker in control and exposes a retry;
restore storage availability and select **Update now** again. A committed event is saved
with its snapshot, so an update can reload before presentation finishes without
recalculating rules or consuming RNG.

## Tests

```sh
npm test
npm run test:watch
```

`npm test` uses Node's built-in test runner and strict assertions to discover
`tests/unit/**/*.test.js` and `tests/integration/**/*.test.js`; `npm run test:watch`
watches only `tests/unit/**/*.test.js`. No browser, DOM, WebGL, or test dependencies
are needed.
Branch pushes (except the generated `gh-pages` branch) and pull requests run tests
and a production build, independently of the Copilot agent session. CI also supports
manual runs via Actions → CI → Run workflow once the workflow is on the default
branch. Deployment runs tests before building. There is no configured lint command.

## Seeded simulations

Run the deterministic baseline report for the canonical seed corpus 0 through 999:

```sh
npm run simulate
```

Select one seed or a contiguous corpus, and optionally lower the per-run clash guard:

```sh
npm run simulate -- --seed 12345
npm run simulate -- --start 1000 --count 100
npm run simulate -- --seed 7 --max-clashes 100
```

The JSON report contains no wall-clock or environment-derived data. Its versioned
duration estimate is a content-planning metric, not measured runtime or a gameplay
rule. Regenerate the canonical test fixture with:

```sh
npm run simulate --silent > tests/fixtures/simulation-report.json
```

## Deterministic RNG

`src/domain/rng.js` exports `createRng(seed)`, `restoreRng(snapshot)`, and
`shuffle(items, rng)`. An RNG exposes `next()` and `snapshot()`:

- Seeds and states are integers from 0 through 4294967295; zero is valid. Negative
  zero is canonicalized to zero. Invalid values throw `TypeError`, without coercion
  or automatic seeding.
- `next()` uses Mulberry32 and returns a number in `[0, 1)`. This is gameplay
  randomness, **not cryptographic randomness**.
- Snapshots contain exactly `algorithm`, `seed`, and `state`, with algorithm
  `mulberry32`. State is the accumulator before the next draw, not a draw count.
  JSON round-trips and restoration preserve the continuation exactly; exporting
  or restoring a snapshot consumes no draws. Snapshots are independent copies.
- `shuffle` returns a shallow copy of a dense array, using the supplied RNG's
  `next()` method. It preserves element identity and multiplicity. It visits
  indices from last to first (excluding index zero), drawing once per index and
  swapping with an index from zero through the current index, inclusive.
  Empty and singleton arrays consume no draws. Invalid arrays (including sparse
  arrays) or missing/non-callable RNG methods throw before any draw.

The algorithm and shuffle order are compatibility contracts; see the
[roadmap's RNG contract](docs/IMPLEMENTATION_ROADMAP.md#rng-contract-milestone-2).
Presentation consumes committed snapshots and events without advancing the RNG.

### Manual seed replay

Run this from the repository root to compare repeated execution with execution
interrupted by a JSON snapshot. It asserts both subsequent results and final state;
the final snapshot should have seed `12345` and state `1767636961`.

```sh
node --input-type=module <<'JS'
import assert from 'node:assert/strict'
import { createRng, restoreRng, shuffle } from './src/domain/rng.js'

function continuation(rng) {
  return {
    value: rng.next(),
    order: shuffle(['a', 'b', 'c', 'd'], rng),
    snapshot: rng.snapshot(),
  }
}

const uninterrupted = createRng(12345)
const repeated = createRng(12345)
assert.deepEqual(continuation(repeated), continuation(uninterrupted))
const saved = JSON.parse(JSON.stringify(repeated.snapshot()))
const resumed = restoreRng(saved)
const expected = continuation(uninterrupted)
assert.deepEqual(continuation(repeated), expected)
assert.deepEqual(continuation(resumed), expected)
console.log('Seed replay passed:', expected.snapshot)
JS
```
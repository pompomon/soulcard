# Milestone 20 MVP release gate

## Decision and scope

**Status:** Pass. The MVP release gate is complete for the declared Chrome
mobile-resolution scope.

This report applies the MVP definition of done in
[`IMPLEMENTATION_ROADMAP.md`](./IMPLEMENTATION_ROADMAP.md) to the release
candidate. Milestone 20 changes release documentation only; it does not change
application, rules, persistence, rendering, PWA, or build behavior.

| Item | Value |
|---|---|
| Validated application revision | `4f04ae66355e6245c1124e6e2a5fe9dfce33c375` |
| Validation date | September 24, 2026 |
| Host | Ubuntu 24.04.5 LTS, Linux 6.17.0-1022-azure, x86_64 |
| Node.js / npm | 24.20.0 / 11.19.0 |
| Chrome | 152.0.7977.82 |
| Published Pages route | `https://pompomon.github.io/soulcard/` |
| Local Pages-relative route | `http://127.0.0.1:4174/soulcard/` |
| Service-worker build revision | `d52760ba9c8f` |
| Screenshots | None produced |

Milestones 1–19 were checked complete before this gate. The application revision
passed CI run
[`36028613839`](https://github.com/pompomon/soulcard/actions/runs/36028613839)
(CI run 282) and Pages run
[`36028613918`](https://github.com/pompomon/soulcard/actions/runs/36028613918)
(Deploy run 35). Both runs executed from the exact revision above and completed
successfully.

## Release checklist

- [x] Milestones 1–19 remain complete.
- [x] A clean locked dependency install succeeds on Node 24.
- [x] The complete automated suite passes without failures, skips, or todos.
- [x] The production build succeeds and preserves the Pages-relative shell.
- [x] The canonical baseline simulation is byte-for-byte reproducible.
- [x] Burn-enabled and burn-disabled rules pass deterministic release checks.
- [x] Save/restore and continued-play equivalence pass.
- [x] Offline shell, deferred update, and cache-policy checks pass.
- [x] WebGL context recovery preserves authoritative state and continuation.
- [x] Both required Chrome mobile-resolution rows pass on the candidate.
- [x] Production offline, update, installability, and standalone checks pass.
- [x] The cache/schema-aware rollback path is signed off.

## Reproducibility gate

The following commands were run from a clean working tree:

```sh
npm ci
npm test
npm run build
npm run simulate --silent > /tmp/soulcard-m20-simulation.json
cmp /tmp/soulcard-m20-simulation.json tests/fixtures/simulation-report.json
```

| Check | Result | Evidence |
|---|---|---|
| Locked install | Pass | 16 packages installed, 17 audited, and 0 vulnerabilities reported |
| Node suite | Pass | 332 passed; 0 failed, cancelled, skipped, or todo |
| Production build | Pass | Vite 8.3.0 transformed 41 modules and emitted the complete shell in 619 ms |
| Service-worker revision | Pass | The emitted `dist/sw.js` contains revision `d52760ba9c8f` and the complete relative shell |
| Baseline simulation fixture | Pass | Generated and fixture files share SHA-256 `f96b45c5fbc44a77bd06b0c527bb8d69f8a31b0222f97de1a1f34ea6faab3cd8` |

The existing Vite advisory for the 669.88 kB minified JavaScript chunk remains
non-blocking. Milestone 19 established no release threshold from its single-host
profiling data, and this release gate does not invent one.

### Canonical deterministic reports

The baseline report used seeds 0–999, the 10,000-clash guard, and timing profile
`mvp-presentation-estimate-v1`. All 1,000 runs completed: 432 player wins, 519
opponent wins, and 49 retained terminal draws. Clash count ranged from 29 to 50
(mean 43.943, median 44), and burn count ranged from 33 to 51 (mean 46.985,
median 48).

A separate double execution of `createSimulationReport` with
`mvp-no-burn-v2` produced identical JSON each time. All 1,000 runs completed
within the same guard, with 495 player wins, 505 opponent wins, no draws, and
exactly zero burns in every run. Its formatted report SHA-256 was
`518f85ea0fa90e5db2d11bcdb938d5c36aa2456db32d4410ed07a461d94ec427`.

## Automated acceptance evidence

| Surface | Result | Release evidence |
|---|---|---|
| Burn enabled | Pass | Ruleset, evaluator, match-machine, event, simulation, settings, bootstrap, and full-match tests preserve ordered loser-card burns and deterministic RNG |
| Burn disabled | Pass | The same layers preserve the complete contest, consume no burn RNG, persist the setting independently, select it only for new/restarted runs, and retain a saved run's ruleset |
| Conservation and completion | Pass | Bounded seeded state-machine checks cover both built-in rulesets at every stable boundary; baseline and no-burn 0–999 reports all complete |
| Save equivalence | Pass | Schema fixtures and integration tests preserve exact snapshots, RNG, ordered zones, outcomes, pending-event fingerprints, and deterministic continuation after JSON restore |
| Lifecycle and recovery | Pass | Pause, background, pagehide, refresh, valid resume, corrupt-save quarantine/discard, terminal reopen, and storage failure/retry paths pass |
| Offline shell | Pass | Manifest/build tests preserve relative metadata and a deterministic complete shell; service-worker tests prove coherent offline navigation and bounded same-origin runtime caching |
| Safe update | Pass | Controller and integration tests cover waiting/replacement workers, initial restoration, pending writes/discards, stable saves, paused/ended runs, retryable failures, one activation message, and one reload |
| Context recovery | Pass | Battlefield and integration tests cover idle and in-flight loss, replacement and cleanup, input gating, retained presentation, unchanged state/save data, and exact continuation |
| Input/accessibility baseline | Pass | Semantic controls, status regions, 44 px targets, focus treatment, responsive layouts, and mouse/touch/pen contracts pass |

The decisive coverage is in:

- `tests/unit/ruleset.test.js`, `burn-evaluator.test.js`,
  `match-machine.test.js`, `simulation.test.js`, and `bootstrap.test.js`;
- `tests/unit/run-schema.test.js`, `migrations.test.js`,
  `run-repository.test.js`, and `run-controller.test.js`;
- `tests/integration/pause-resume-lifecycle.test.js`,
  `event-presentation-restore.test.js`, and `milestone-16-flow.test.js`;
- `tests/unit/pwa-build.test.js`, `service-worker.test.js`,
  `update-controller.test.js`, and
  `tests/integration/pwa-update-lifecycle.test.js`; and
- `tests/unit/battlefield.test.js` and
  `tests/integration/context-recovery.test.js`.

## Chrome release-candidate validation

Chrome was driven through the DevTools Protocol with device emulation. The
production `dist` directory was mounted at `/soulcard/`; the profiling fixture
was served separately through Vite. All observations were collected from the
DOM, computed styles, browser protocols, Cache Storage, IndexedDB, console, and
process status. No screenshots were produced.

### Required mobile rows

| Layout | Metrics | Reveal target | Pause target | Focus evidence | Result |
|---|---:|---:|---:|---|---|
| Phone portrait | 320×480, DPR 3 | 94.25×44 | 94.27×44 | 3 px solid `rgb(117, 238, 245)` | Pass |
| Phone landscape | 844×390, DPR 3 | 240.94×44 | 240.94×44 | 3 px solid `rgb(117, 238, 245)` | Pass |

Each row retained exactly one full-viewport
`<canvas role="presentation" aria-hidden="true">`, enabled Reveal and Pause, and
reported the expected `phone-portrait` or `phone-landscape` layout. Chrome's
safe-area emulation with 44 px top, 34 px bottom, and 20 px side insets changed
the Game HUD's computed padding from zero to `44px 20px 34px`. The media query
for reduced motion changed from false to true under emulation; the profiling
fixture exercised both reduced and normal presentation modes.

### Production gameplay and lifecycle

| Scenario | Result | Evidence |
|---|---|---|
| Fresh run | Pass | Start created the IndexedDB active record and opened a ready Game with one canvas |
| Pause and lifecycle save | Pass | Pause reported `Game saved.`; hidden visibility and `pagehide` updated the record |
| Refresh and exact resume | Pass | Resume was available; the resumed source count and presentation state matched, and the IndexedDB record was byte-identical |
| Corrupt-save recovery | Pass | An unsupported future schema produced recovery guidance, disabled Resume, exposed Discard, and cleared only the bad run |
| WebGL interruption | Pass | Real `WEBGL_lose_context` disabled Reveal but not Pause; restore replaced the old canvas, retained one canvas, re-enabled input, and preserved stage/count state |

The production app registered and gained a controlling service worker. With
Chrome network emulation offline, a hard reload served the complete shell with
no failed requests, offered Resume, and restored the exact run and Game canvas.
`Page.getAppManifest` reported the expected name, fullscreen display, and icons
with no manifest errors; `Page.getInstallabilityErrors` returned an empty list
in a normal browser context. A separate headless `--app` launch reported
`display-mode: standalone` and no competing browser, minimal-ui, or fullscreen
mode.

Console and network sampling for the production gameplay and offline flows found
no application errors or failed requests. Chrome reported only its expected
software-WebGL fallback warning under SwiftShader. The update flow's separate
DOM, service-worker, IndexedDB, cache, and reload assertions completed without a
runtime failure; a separate console dump was not retained for that flow. All
Chrome and server processes were stopped after the checks and the temporary
validation harness was removed; process disappearance, rather than individual
exit codes, was recorded.

### Two-revision update

A temporary second build changed only an HTML comment outside the repository.
Its generated revision was `5c95ed612033`. Serving it at the same origin exposed
the update while revision `d52760ba9c8f` remained in control.

Selecting **Update now** reported `Game saved. Activating the update…`. The
post-save IndexedDB record matched the prior stable record except for `savedAt`;
activation then produced exactly one page load. The reloaded document contained
the second-build marker, retained the pre-update source count of 50 after Resume,
and held only the new `soulcard-shell-5c95ed612033` and
`soulcard-active-5c95ed612033` revision caches. Automated service-worker tests
separately prove that this cleanup preserves unrelated caches.

### Deterministic browser profile

`tests/browser/milestone-19-profile.html` completed at DPR 3 without console
errors:

- Seed 0 completed in 44 clashes with one tie and one source-to-personal
  transition, ending in a player win.
- Seed 93 completed in 48 clashes with three ties and one transition, ending in
  the retained `mutualInability` draw.
- Both runs held cache entries to 24, static cards to 5, transient cards to 4,
  geometries to 2, and textures to 24; draw calls peaked at 15 and 17.
- Two real `WEBGL_lose_context` recoveries preserved the retained state.
- Three remounts each returned to one static card, zero transient cards, three
  geometries, one texture, and one cache entry.

Thirty sampled frame intervals had a 268.32 ms mean, 83.30 ms median, 199.90 ms
p95, and 5,716.40 ms maximum while the shared virtual host was concurrently
running multiple Chrome/build processes. As in milestone 19, these observations
are not release thresholds and do not support a hardware-performance claim.

## Cache/schema-aware rollback

### Compatibility inventory

| Contract | Release-candidate value |
|---|---|
| Active-run save schema | 3 |
| Game rules version | 2 |
| Current committed-event version | 4 |
| Readable committed-event versions | 2, 3, and 4 |
| IndexedDB database/version | `soulcard-runs` / 1 |
| IndexedDB stores | `active-runs` with `active` and `quarantine` keys |
| Settings namespace | `soulcard.settings.v1` |
| Asset-cache revision | Content-derived `d52760ba9c8f` for this build |

The verified rollback target is
`6c9f98ab68c15a484b78d74fd82451eaacef4f4c`, the immediately preceding
deployed main revision. Its application source and all compatibility identifiers
above are identical to the candidate; the intervening diff changes only milestone
documentation. It passed CI run
[`35978393137`](https://github.com/pompomon/soulcard/actions/runs/35978393137)
and Pages run
[`35978393111`](https://github.com/pompomon/soulcard/actions/runs/35978393111).

### Rollback procedure

1. Stop release promotion and verify that the target still accepts save schema 3,
   game rules 2, and event versions present in active runs.
2. Before requesting an update, let the current client reach a stable
   `ready`, `paused`, or `ended` boundary and complete its IndexedDB save.
3. Revert or restore the compatible target on `main`; do not update `gh-pages`
   directly. Let the existing Pages workflow run `npm ci`, `npm test`, and
   `npm run build`, then deploy the newly built `dist` artifact.
4. Verify the injected content revision and app-shell list. A rebuild of identical
   bytes may reproduce the same content hash; it must still come from the workflow
   artifact rather than a stale source branch.
5. Activate the waiting worker only through Soulcard's **Update now** flow. Confirm
   one reload after the stable save and preserve unrelated caches.
6. Verify the exact active run online and after an offline relaunch, including RNG,
   ordered zones, outcome, and pending committed event. IndexedDB and localStorage
   must remain intact; asset-cache cleanup is never save cleanup.

If a proposed target cannot read the current save/rules/event contracts, it is not
a valid rollback. Ship a compatible forward fix or an explicitly tested migration
instead of exposing active runs to an older reader.

## Blockers and exclusions

Release blockers are any failed automated check, non-reproducible canonical
fixture, required browser-matrix failure, unsafe update/rollback behavior, or
unexplained relevant console/runtime error.

No release blocker remains. The existing build-size advisory and expected
SwiftShader warning are recorded above and do not represent a functional,
security, or compatibility failure.

Physical-device, remote-lab, cross-browser, tablet/desktop, representative
hardware-tier, and longitudinal heap sign-off remain outside MVP acceptance.
Full keyboard navigation, gameplay shortcuts, focus-flow instructions, and claims
of complete keyboard support also remain post-MVP. Mouse, touch, and pen contracts
are covered by the automated suite.

## Final sign-off

All automated, reproducibility, release-candidate browser, and rollback rows
pass. Soulcard satisfies the MVP definition of done for the explicitly declared
scope, so milestone 20 is complete.

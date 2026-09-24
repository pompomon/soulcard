# Milestone 19 performance, accessibility, and device QA

## Status and method

**Status:** Complete for the MVP's Chrome mobile-resolution scope. The required
320×480 portrait and 844×390 landscape rows pass in current headless Chrome at DPR 3.
Physical devices, remote labs, other browsers, tablet/desktop sign-off, and
representative hardware tiers are not acceptance requirements, and no claims are made
for them.

| Item | Value |
|---|---|
| Measured implementation revision | `d5133d3ca4ad75444da4255234e27cd0c920f02b` |
| Date | September 24, 2026 |
| Host | Ubuntu 24.04.5 LTS, Linux x86_64, Azure VM, 4 logical CPUs, 16 GiB reported device memory |
| Chrome | 152.0.7977.82, headless, ANGLE/SwiftShader WebGL |
| Required viewports | 320×480 portrait and 844×390 landscape, DPR 3 |
| Node.js | 24.21.0 |
| Production path | `http://127.0.0.1:4174/soulcard/` |
| Screenshots | None produced |

The dependency-free fixture at
`tests/browser/milestone-19-profile.html` ran from the Vite development server. It
used deterministic seeds 0 and 93, four logical layout sizes, low/high quality,
normal/reduced motion, texture scales 1 and 3, two real `WEBGL_lose_context` cycles,
and three battlefield remounts. The required acceptance rows are the two mobile
layouts. Separate text-only Chrome DevTools Protocol checks exercised the production
build at its Pages-relative path and DPR 3, including computed target/focus styles,
service-worker offline resume, installability, standalone display mode, and real WebGL
restoration. The complete Node 24 unit/integration suite and production build were also
run.

These are observations from one virtualized software-WebGL host, not release
thresholds, physical-device results, cross-browser evidence, or hardware-tier results.

## Automated validation

| Check | Result | Evidence |
|---|---|---|
| `npm test` on Node 24 | Pass | 332 tests passed; 0 failed, skipped, cancelled, or todo |
| `npm run build` on Node 24 | Pass | Vite transformed 41 modules and emitted the production shell; the existing large-chunk advisory remained |
| Production Pages-relative launch | Pass | `/soulcard/` loaded with no failed requests or relevant application console errors |
| Chrome mobile portrait/landscape | Pass | DPR 3 produced the declared phone layouts, one full-viewport canvas, enabled primary controls, 44 px minimum target heights, and visible keyboard focus |
| Production WebGL loss/restore | Pass | One canvas before/lost/restored; loss disabled Reveal but not Pause; restoration replaced and detached the old canvas and re-enabled Reveal |
| Offline resume | Pass | Controlled service worker loaded the shell offline, exposed the saved run, and resumed Game with one canvas |
| Installability | Pass | Manifest loaded from `/soulcard/manifest.webmanifest`; Chrome reported no manifest or installability errors |
| Standalone launch | Pass | Headless `--app` launch reported `display-mode: standalone`, not browser/fullscreen/minimal-ui |

Production recovery status changed from
`Ready. Reveal the first clash.` to
`Graphics context lost. Presentation is paused while graphics recover.` and back to
the ready state. During loss Reveal was disabled, Pause remained enabled, and
`#app` retained one canvas. After restoration the old canvas was disconnected, its
replacement was the only canvas, and Three.js logged only its expected context
lost/restored messages. A final combined-state check paused during the interruption:
the background HUD became inert, the active Pause dialog's atomic live status mirrored
the graphics-loss message, and restoration returned that dialog status to
`Game saved.` while keeping Resume available.

The integration test interrupts both idle rendering and an active committed
presentation. It asserts exact RNG state, ordered zones, outcome, pending-event
fingerprint, serialized save, deterministic continuation equivalence, and reconstruction
of the active presentation card. Unit tests cover repeated reveal, settlement, and
terminal-draw restoration, renderer/cache regeneration, failure state, event/listener
cleanup, combined match/context pause reasons, terminal failure escape controls, and
safe-control gating.

## Raw profiling summary

```text
environment.userAgent=HeadlessChrome/152.0.0.0
environment.hardwareConcurrency=4
environment.deviceMemoryGiB=16
environment.devicePixelRatio=3

frameIntervals.samples=30
frameIntervals.meanMs=44.44
frameIntervals.p50Ms=33.30
frameIntervals.p95Ms=66.70
frameIntervals.maxMs=416.60

texture.scale1.generated=53
texture.scale1.elapsedMs=12.50
texture.scale1.residentEntries=24
texture.scale3.generated=53
texture.scale3.elapsedMs=54.10
texture.scale3.residentEntries=24
texture.cacheBound=24

seed0.clashes=44
seed0.ties=1
seed0.sourceToPersonalTransitions=1
seed0.elapsedMs=875.80
seed0.outcome=player-win/opponentUnableToReveal
seed0.maxCacheEntries=24
seed0.maxStaticCards=5
seed0.maxTransientCards=4
seed0.maxGeometries=2
seed0.maxTextures=24
seed0.maxDrawCalls=15

seed93.clashes=48
seed93.ties=3
seed93.sourceToPersonalTransitions=1
seed93.elapsedMs=852.20
seed93.outcome=draw/mutualInability
seed93.maxCacheEntries=24
seed93.maxStaticCards=5
seed93.maxTransientCards=4
seed93.maxGeometries=2
seed93.maxTextures=24
seed93.maxDrawCalls=17

contextRecovery.attempt1.mode=WEBGL_lose_context
contextRecovery.attempt1.elapsedMs=22539.90
contextRecovery.attempt2.mode=WEBGL_lose_context
contextRecovery.attempt2.elapsedMs=270.00
contextRecovery.count=2
contextRecovery.stableMatchPreserved=true

remount.count=3
remount.each.staticCards=1
remount.each.transientCards=0
remount.each.geometries=3
remount.each.textures=1
remount.each.cacheEntries=1

heap.supported=true
heap.usedJSHeapSize=21306128
heap.totalJSHeapSize=23960532
heap.jsHeapSizeLimit=4395630592
```

The single heap observation confirms API support but cannot establish a heap trend.
Listener cleanup is established by focused lifecycle tests rather than a browser
listener counter.

## Viewport, target, and focus evidence

Logical resize/snapshot times in the profiling fixture were 14.0 ms at 320×480,
12.1 ms at 844×390, 8.1 ms at 768×1024, and 10.5 ms at 1280×800. The acceptance check
then exercised the two required mobile layouts at emulated DPR 3.

The production build was then measured with device metrics emulating the required DPR 3.
Every row retained one Game canvas and the declared layout mode.

| Layout | Metrics | Reveal target | Pause target | Focus evidence | Result |
|---|---:|---:|---:|---|---|
| Phone portrait | 320×480, DPR 3 | 94.25×44 | 94.27×44 | 3 px solid `rgb(117, 238, 245)` | Pass |
| Phone landscape | 844×390, DPR 3 | 240.94×44 | 240.94×44 | 3 px solid `rgb(117, 238, 245)` | Pass |

Focused accessibility tests audit Main, Settings, Game, Pause/End overlays, and the
update notice for named native controls, labelled screens/dialogs, polite atomic
status regions, and inert background ownership. The production canvas reported
`role="presentation"` and `aria-hidden="true"`; Reveal/Continue remained the named
canonical action. Full keyboard gameplay, shortcuts, focus trapping, focus-flow
instructions, and claims of complete keyboard support remain explicitly excluded.

## Measured hypotheses

### Continuous normal-motion rendering

Normal motion reported `animationActive=true`; reduced motion reported
`animationActive=false`. With the normal-motion battlefield still mounted, the sampled
frame interval p50 was 33.3 ms, p95 was 66.7 ms, and the maximum was 416.6 ms. This
confirms that normal motion retains continuous rendering while reduced motion does not,
but this fixture does not isolate CPU/GPU time well enough to establish that loop as
the dominant device cost. No optimization was made.

### Texture generation versus context regeneration

The 53-texture pass at scale 1 took 12.5 ms, while the following scale-3 pass took
54.1 ms. This single ordered sample is insufficient to establish a repeatable
scale-cost ratio. Context recovery took 22,539.9 ms and 270.0 ms in the two attempts;
that variance likewise indicates a headless driver/timing effect rather than a
repeatable application bottleneck. No optimization or release limit was inferred.

### Resource and heap bounds

Both complete matches held cache entries and renderer textures to the configured
bound of 24, geometries to 2, and transient cards to 4 or fewer. Three remounts
returned identical one-snapshot resource counts. Focused tests additionally verify
texture, mesh, renderer, input, and context-listener cleanup. The one supported heap
sample is insufficient to claim a bounded heap across time; milestone 19 makes no such
claim and uses the bounded cache/resource and cleanup evidence above.

### Minimum-viewport responsiveness

The two required mobile layouts synchronously resized and reconciled in 12.1–14.0 ms
on the single 4-vCPU virtual host, retained one canvas, and met computed target/focus
requirements. This is Chrome viewport-emulation evidence, not physical-device or
hardware-tier evidence. No responsiveness threshold or optimization was invented.

## Chrome mobile, input, and lifecycle matrix

`Pass (automated)` records only current Chrome viewport emulation and the stated
automated contracts. Physical devices, remote labs, other browsers, tablet/desktop
sign-off, and hardware-tier comparisons are outside this milestone's scope.

| Surface or scenario | Result | Evidence or limitation |
|---|---|---|
| Current Chrome, phone portrait emulation | Pass (automated) | 320×480/DPR 3 layout, one canvas, targets, focus, seed flow, and resource evidence |
| Current Chrome, phone landscape emulation | Pass (automated) | 844×390/DPR 3 layout, one canvas, targets, focus, seed flow, and resource evidence |
| Mouse/touch/pen event contracts | Pass (automated) | Existing pointer unit/integration coverage passed within all 332 tests |
| Normal and reduced motion | Pass (automated) | Fixture exercised both; deterministic restore/reduced-motion regressions passed |
| Online and offline resume | Pass (automated) | Controlled production service worker made the saved run resumable and reopened Game offline |
| Installability and standalone | Pass (automated) | Zero Chrome installability errors; `--app` reported standalone display mode |
| Fresh run | Pass (automated) | Production launch created and saved a run before recovery |
| Tie and source-to-personal transition | Pass (automated) | Seed 0 recorded one tie and one transition |
| Terminal draw | Pass (automated) | Seed 93 recorded three ties, one transition, and `mutualInability` draw |
| Pause/background/refresh/resume | Pass (automated) | Full regression suite plus production offline refresh/resume |
| Corrupt save recovery | Pass (automated) | Existing persistence/recovery regressions passed in the full suite |
| Deferred update at a stable boundary | Pass (automated) | Existing PWA update/save-boundary regressions passed in the full suite |
| WebGL interruption and restoration | Pass (automated Chrome) | Idle/active integration equivalence, two fixture cycles, and production canvas replacement |

## Milestone 19 sign-off

Every required Chrome mobile-resolution row is recorded above, so milestone 19 is
complete. This sign-off does not establish physical-device, cross-browser,
tablet/desktop, hardware-tier, or longitudinal heap performance.

Milestone 20 should repeat the two Chrome mobile-resolution rows against the
release-candidate revision.

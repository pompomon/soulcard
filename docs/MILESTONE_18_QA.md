# Milestone 18 performance, accessibility, and device QA

## Status and method

**Status:** Incomplete. Automated Chromium evidence passes, but the required physical
iOS Safari, Android Chrome, tablet/touch, pen, Safari, supported-Firefox-WebGL, and
representative low/mid/high-device rows were unavailable. Milestone 18 therefore
remains unchecked.

| Item | Value |
|---|---|
| Measured implementation revision | `cc967cea69df6e8b60b1aa4c65ae7b23bbc715ac` |
| Date | September 23, 2026 |
| Host | Ubuntu 24.04.5 LTS, Linux x86_64, Azure VM, 4 logical CPUs, 16 GiB reported device memory |
| Chromium | 152.0.7977.0, headless, ANGLE/SwiftShader WebGL |
| Firefox | 155.0, headless |
| Safari | Unavailable on the Linux runner |
| Node.js | 24.21.0 |
| Production path | `http://127.0.0.1:4174/soulcard/` |
| Screenshots | None produced |

The dependency-free fixture at
`tests/browser/milestone-18-profile.html` ran from the Vite development server. It
used deterministic seeds 0 and 32, four logical viewport sizes, low/high quality,
normal/reduced motion, texture scales 1 and 3, two real
`WEBGL_lose_context` cycles, and three battlefield remounts. Separate text-only
Chrome DevTools Protocol checks exercised the production build at its Pages-relative
path, including computed target/focus styles, service-worker offline resume,
installability, standalone display mode, and WebGL restoration. The complete Node 24
unit/integration suite and production build were also run.

These are observations from one virtualized software-WebGL host, not release
thresholds or physical-device results.

## Automated validation

| Check | Result | Evidence |
|---|---|---|
| `npm test` on Node 24 | Pass | 313 tests passed; 0 failed, skipped, cancelled, or todo |
| `npm run build` on Node 24 | Pass | Vite transformed 40 modules and emitted the production shell; the existing large-chunk advisory remained |
| Production Pages-relative launch | Pass | `/soulcard/` loaded with no failed requests or relevant application console errors |
| Production WebGL loss/restore | Pass | One canvas before/lost/restored; loss disabled Reveal but not Pause; restoration replaced and detached the old canvas and re-enabled Reveal |
| Offline resume | Pass | Controlled service worker loaded the shell offline, exposed the saved run, and resumed Game with one canvas |
| Installability | Pass | Manifest loaded from `/soulcard/manifest.webmanifest`; Chromium reported no manifest or installability errors |
| Standalone launch | Pass | Headless `--app` launch reported `display-mode: standalone`, not browser/fullscreen/minimal-ui |
| Firefox WebGL fixture | Unsupported | Firefox reported `FEATURE_FAILURE_WEBGL_EXHAUSTED_DRIVERS`; no gameplay or recovery result is inferred |

Production recovery status changed from
`Ready. Reveal the first clash.` to
`Graphics context lost. Presentation is paused while graphics recover.` and back to
the ready state. During loss Reveal was disabled, Pause remained enabled, and
`#app` retained one canvas. After restoration the old canvas was disconnected, its
replacement was the only canvas, and Three.js logged only its expected context
lost/restored messages.

The integration test interrupts both idle rendering and an active committed
presentation. It asserts exact RNG state, ordered zones, outcome, pending-event
fingerprint, serialized save, and deterministic continuation equivalence. Unit tests
cover repeated restoration, renderer/cache regeneration, failure state, event/listener
cleanup, combined match/context pause reasons, and safe-control gating.

## Raw profiling summary

```text
environment.userAgent=HeadlessChrome/152.0.0.0
environment.hardwareConcurrency=4
environment.deviceMemoryGiB=16
environment.devicePixelRatio=1

frameIntervals.samples=30
frameIntervals.meanMs=33.33
frameIntervals.p50Ms=16.70
frameIntervals.p95Ms=16.70
frameIntervals.maxMs=516.60

texture.scale1.generated=53
texture.scale1.elapsedMs=21.90
texture.scale1.residentEntries=24
texture.scale3.generated=53
texture.scale3.elapsedMs=80.90
texture.scale3.residentEntries=24
texture.cacheBound=24

seed0.clashes=44
seed0.ties=1
seed0.sourceToPersonalTransitions=1
seed0.elapsedMs=1942.20
seed0.outcome=player-win/opponentUnableToReveal
seed0.maxCacheEntries=24
seed0.maxStaticCards=5
seed0.maxTransientCards=4
seed0.maxGeometries=2
seed0.maxTextures=24
seed0.maxDrawCalls=15

seed32.clashes=44
seed32.ties=5
seed32.sourceToPersonalTransitions=1
seed32.elapsedMs=1810.20
seed32.outcome=draw/mutualInability
seed32.maxCacheEntries=24
seed32.maxStaticCards=5
seed32.maxTransientCards=6
seed32.maxGeometries=2
seed32.maxTextures=24
seed32.maxDrawCalls=21

contextRecovery.attempt1.mode=WEBGL_lose_context
contextRecovery.attempt1.elapsedMs=24661.80
contextRecovery.attempt2.mode=WEBGL_lose_context
contextRecovery.attempt2.elapsedMs=540.70
contextRecovery.count=2
contextRecovery.stableMatchPreserved=true

remount.count=3
remount.each.staticCards=1
remount.each.transientCards=0
remount.each.geometries=3
remount.each.textures=1
remount.each.cacheEntries=1

heap.supported=true
heap.usedJSHeapSize=18070235
heap.totalJSHeapSize=27667667
heap.jsHeapSizeLimit=4395630592
```

The single heap observation confirms API support but cannot establish a heap trend.
Listener cleanup is established by focused lifecycle tests rather than a browser
listener counter.

## Viewport, target, and focus evidence

Logical resize/snapshot times in the profiling fixture were 29.0 ms at 320×480,
18.0 ms at 844×390, 19.6 ms at 768×1024, and 29.7 ms at 1280×800. The host DPR was
1, so this run did not exercise a hardware DPR above the configured caps.

The production build was then measured with device metrics emulating the established
DPR values. Every row retained one Game canvas and the declared layout mode.

| Layout | Metrics | Reveal target | Pause target | Focus evidence | Result |
|---|---:|---:|---:|---|---|
| Phone portrait | 320×480, DPR 3 | 147×44 | 147×44 | 3 px solid `rgb(117, 238, 245)` | Pass |
| Phone landscape | 844×390, DPR 3 | 365×44 | 365×44 | 3 px solid `rgb(117, 238, 245)` | Pass |
| Tablet | 768×1024, DPR 2 | 110×44 | 110×44 | 3 px solid `rgb(117, 238, 245)` | Pass |
| Desktop | 1280×800, DPR 1 | 91×79.78125 | 91×79.78125 | 3 px solid `rgb(117, 238, 245)` | Pass |

Focused accessibility tests audit Main, Settings, Game, Pause/End overlays, and the
update notice for named native controls, labelled screens/dialogs, polite atomic
status regions, and inert background ownership. The production canvas reported
`role="presentation"` and `aria-hidden="true"`; Reveal/Continue remained the named
canonical action. Full keyboard gameplay, shortcuts, focus trapping, focus-flow
instructions, and claims of complete keyboard support remain explicitly excluded.

## Measured hypotheses

### Continuous normal-motion rendering

Normal motion reported `animationActive=true`; reduced motion reported
`animationActive=false`. The sampled frame interval p50 and p95 were both 16.7 ms,
with one 516.6 ms outlier while profiling. This confirms that normal motion retains
continuous idle rendering while reduced motion does not, but this fixture does not
isolate CPU/GPU time well enough to establish that loop as the dominant device cost.
No optimization was made.

### Texture generation versus context regeneration

Generating 53 textures at scale 3 took 80.9 ms versus 21.9 ms at scale 1 on this
host. Context recovery took 24,661.8 ms and 540.7 ms in the two attempts. Recovery
was the larger transient observation, but the roughly 46× variance indicates a
headless driver/timing effect rather than a repeatable application bottleneck. No
optimization or release limit was inferred.

### Resource and heap bounds

Both complete matches held cache entries and renderer textures to the configured
bound of 24, geometries to 2, and transient cards to 6 or fewer. Three remounts
returned identical one-snapshot resource counts. Focused tests additionally verify
texture, mesh, renderer, input, and context-listener cleanup. The one supported heap
sample is insufficient to claim a bounded heap across time, so that claim remains
open for physical-browser profiling.

### Minimum-viewport responsiveness

All four emulated layouts synchronously resized and reconciled in 18.0–29.7 ms on
the single 4-vCPU virtual host, retained one canvas, and met computed target/focus
requirements. This is useful repeatable evidence but is not representative
low/mid/high-device interaction evidence. No responsiveness threshold or optimization
was invented.

## Browser, device, input, and lifecycle matrix

`Pass (automated)` records only the stated automation. It does not substitute for a
physical-device row.

| Surface or scenario | Result | Evidence or limitation |
|---|---|---|
| Current Chromium, Linux desktop | Pass (automated) | Profiling, production recovery, accessibility, offline, installability, and standalone checks above |
| Current Firefox, Linux desktop | Unsupported | Browser available, but this runner exhausted every WebGL driver option |
| Current Safari, macOS | Unavailable | No macOS/Safari host |
| iOS Safari phone portrait/landscape, touch | Unavailable | No identified physical iOS device or Safari remote session |
| Android Chrome phone portrait/landscape, touch | Unavailable | No identified physical Android device/browser details; earlier unspecified evidence is not counted |
| Physical tablet, touch | Unavailable | No identified tablet |
| Physical pen-capable device | Unavailable | No identified pen-capable device |
| Representative low/mid/high physical devices | Unavailable | Only one virtualized 4-vCPU/16-GiB software-WebGL host was available |
| Phone portrait/landscape emulation | Pass (automated) | Layout, one-canvas, targets, focus, seed flow, and resource evidence |
| Tablet and desktop emulation | Pass (automated) | Layout, one-canvas, targets, focus, and resource evidence |
| Mouse/touch/pen event contracts | Pass (automated) | Existing pointer unit/integration coverage passed within all 313 tests |
| Normal and reduced motion | Pass (automated) | Fixture exercised both; deterministic restore/reduced-motion regressions passed |
| Online and offline resume | Pass (automated) | Controlled production service worker made the saved run resumable and reopened Game offline |
| Installability and standalone | Pass (automated) | Zero Chromium installability errors; `--app` reported standalone display mode |
| Fresh run | Pass (automated) | Production launch created and saved a run before recovery |
| Tie and source-to-personal transition | Pass (automated) | Seed 0 recorded one tie and one transition |
| Terminal draw | Pass (automated) | Seed 32 recorded five ties, one transition, and `mutualInability` draw |
| Pause/background/refresh/resume | Pass (automated) | Full regression suite plus production offline refresh/resume |
| Corrupt save recovery | Pass (automated) | Existing persistence/recovery regressions passed in the full suite |
| Deferred update at a stable boundary | Pass (automated) | Existing PWA update/save-boundary regressions passed in the full suite |
| WebGL interruption and restoration | Pass (automated Chromium) | Idle/active integration equivalence, two fixture cycles, and production canvas replacement |

## Remaining milestone 18 sign-off

Milestone 18 must stay open until evidence is recorded for:

- physical iOS Safari phone portrait and landscape with touch;
- physical Android Chrome phone portrait and landscape with touch;
- a physical tablet/touch target and a pen-capable target;
- current Safari and a Firefox environment with working WebGL;
- representative low-, mid-, and high-capability device responsiveness; and
- browser heap/resource trends over repeated complete runs on supported hardware.

Milestone 19 should repeat the final matrix against the release-candidate revision.

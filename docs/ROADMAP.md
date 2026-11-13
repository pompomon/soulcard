# Soulcard roadmap

Status, open work and delivery rules. Contracts live in [ARCHITECTURE.md](ARCHITECTURE.md) and
[CAMPAIGN.md](CAMPAIGN.md). Retired plans and their outcomes are summarized in
[HISTORY.md](HISTORY.md). Update this file in the pull request that changes a milestone's status.

## Status

| Milestone | Status |
|---|---|
| 1–20 MVP: Classic mode, PWA, release gate | Done |
| 21.1 Campaign Duel | Done |
| 21.2 Reward Drafts and Hold Upgrades | Done |
| 21.3 Branching Expedition | Done (#40, #41; signed off in #49) |
| 21.4 Encounter Archetypes and Elite Ladder | Done (#42; signed off in #49, keeping Plunder suspends Spoils of War) |
| 21.5 Seeded Procedural Campaign | Next |
| 21.6 First-class Keyboard Support | After 21.5 |

Milestone 21 (post-MVP expansion) closes when 21.6 is signed off. Presentation work outside the
21.x line (uniform piles and phone footer, Tarot card art) is complete.

## Delivery rules

- Every milestone extends the playable game. Don't create "foundation only" milestones.
- Keep the Main, Settings and Game screen contract. Map, reward, shop, event and summary surfaces
  are Game-owned overlays or panels.
- Keep the deterministic/presentation boundary and save only after stable domain actions.
- Version every contract change, and keep fixtures for the superseded shape:
  - stored shape: save schema plus migration or quarantine
  - rule semantics: ruleset or `gameRulesVersion`
  - event contract: `eventVersion`
- A change that touches rendering, the HUD or the PWA also needs the text-only browser check
  described in [ARCHITECTURE.md](ARCHITECTURE.md).

## Plan lifecycle

1. Before implementing a milestone, write a short plan in `docs/plans/<milestone>.md` with scope,
   acceptance criteria and version changes. Keep it under about 15 KB.
2. Record measured evidence in the pull request, not in docs.
3. On completion, move binding contracts into ARCHITECTURE.md or CAMPAIGN.md, add a summary of three
   to six lines and a permalink to HISTORY.md, update the status table above, and delete the plan.

## 21.5 Seeded Procedural Campaign

**Goal:** a repeatable roguelike mode built from deterministic generated content.

- Generate branching maps, node contents, encounter configurations, reward drafts, shops and events
  from documented campaign RNG streams with a documented consumption order.
- Bound content pools and card-instance limits so generation can't grow decks, modifiers, rewards or
  save records without limit.
- Add procedural boss selection and a broader, fully specified modifier catalogue.
- Generators must satisfy, or explicitly revise, the map constraints in
  [CAMPAIGN.md](CAMPAIGN.md): elite twin rule, shop after coin gains, single final boss, node limit,
  node order keys shop stock.
- Deferred from 21.4:
  - opponent-reveal access, which cancels Hold Insight
  - recycle order
  - card-value effects, which need a Campaign event-version bump
  - traits on normal and boss fights, and procedural traits
- Build simulation and report tooling for complete campaigns, including route choices and
  deterministic partial outcomes, separate from the single-match simulator. No campaign probe
  harness is committed yet.
- Tune balance with that tooling. The inputs are in [CAMPAIGN.md](CAMPAIGN.md).

**Acceptance:**
- Equivalent seed-plus-choice replays produce equivalent maps, rewards, encounters, run state,
  events and outcomes across save/resume boundaries.
- Generation always yields a reachable boss path within the configured bounds.
- Tests cover seed-corpus replay, reachability, bounded pools, generated node validity, campaign
  simulation guards, migrations, lifecycle saves, and browser navigation through generated choices.

## 21.6 First-class Keyboard Support

**Goal:** make Classic and Campaign fully operable by keyboard, with no rule changes.

- Complete navigation, gameplay actions, shortcuts, overlay focus management and in-game
  instructions.
- Keep native semantic controls canonical. Route keyboard activation through the same guarded
  controller actions used by pointer input.
- **Acceptance:**
  - Classic matches and complete generated campaigns are playable without a pointer.
  - Focus order, restoration, trapping, shortcuts and instructions have automated focus-flow tests
    and a browser check.

## Backlog (unscheduled)

- **Release readiness:**
  - accessibility and privacy review
  - physical Android Chrome and iOS Safari checks
  - a real Galaxy Fold4 cover-screen check of halo contrast and Hold placement
- **Phone HUD:**
  - Large text: at 115 % the footer overflows by 1–4 px; at 130 % values clip.
  - Header wrapping ("P Source · O Source") and the 0.65rem comparison text.
  - 480×320 landscape and the landscape save-warning overflow. The phone-HUD harness reports these
    but doesn't assert them.
- **Card art:**
  - Prefetch HD art. Refinement p95 reached about 1.1 s against the 400 ms reveal dwell.
  - Enforce the pixel-module budget of 25 kB gzip. Today it's printed only.
  - Final or commissioned art lands in art-only pull requests.
- **PWA:**
  - Check whether GitHub Pages sends `Vary: Origin`. `sw.js` matches without `ignoreVary`.
  - Commit an automated offline-reload and app-update browser check.
- **Build:** the main chunk exceeds Vite's 500 kB advisory. It isn't a release blocker; code-split
  it if load time matters.

## Release checklist

- Run a clean `npm ci` on the `.nvmrc` Node version, then `npm test` (no failures, skips or todos)
  and `npm run build`.
- The baseline simulation must be byte-identical: `npm run simulate --silent > /tmp/sim.json && cmp
  /tmp/sim.json tests/fixtures/simulation-report.json`.
- Run the text-only browser harnesses in Chrome emulation at 320×480 and 844×390, DPR 3: offline
  shell, deferred update, WebGL context recovery, and save/resume equivalence.
- Blockers: any failed check, a non-reproducible fixture, unsafe update or rollback behaviour, or an
  unexplained console or runtime error. The chunk-size advisory and the headless GPU/SwiftShader
  warnings aren't blockers.
- Rollback:
  - The target must read the current save schema, rules and event versions. If it can't, ship a
    forward fix instead.
  - Revert on `main` and let the Pages workflow rebuild. Never push to `gh-pages`.
  - Clients update only through **Update now**, after saving at a stable boundary.
  - Asset-cache cleanup is never save cleanup.
- Out of scope for sign-off: physical devices, other browsers, tablet and desktop, hardware tiers,
  and long-session heap growth.

## Maintenance

- `.nvmrc` sets the Node version for CI, deploy and the Copilot setup steps. Move it when a new LTS
  line becomes Active.
- Dependabot opens pull requests weekly:
  - root npm minor and patch updates, grouped
  - major updates and `three`, each on its own
  - GitHub Actions, grouped
- For a three bump, read the three.js migration guide for that release and run the browser
  harnesses.
- `tools/card-art` gets security updates only: its lockfile is hashed into the committed Tarot (HD)
  pack, so a bump is an art revision. Its pull request fails `tarot-hd-assets.test.js` until the
  pack is rebuilt on that branch:
  1. Run `npm --prefix tools/card-art ci`.
  2. Run `npm --prefix tools/card-art run build:hd`.
  3. Run `npm test` and commit the pack.
- `npm --prefix tools/card-art run check:hd` rebuilds the pack in memory and fails if the committed
  files differ. It is byte-exact on linux-x64 and takes about 2 minutes.

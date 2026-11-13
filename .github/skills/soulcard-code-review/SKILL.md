---
name: soulcard-code-review
description: Review Soulcard pull requests for evidence-based performance issues, contract violations, and alignment with the roadmap and milestones. Use for code review, especially when changes claim performance improvements, deliver milestones, or alter domain, rendering, persistence, UI, PWA, or build behavior.
license: MIT
---

# Soulcard code review

Review only the pull request's changes. Report actionable regressions and contract violations
without turning the roadmap into requests for unrelated future work. This skill is
self-contained and must not depend on MCP server context.

## Review basis

1. Read the pull request description, the changed files and the complete diff.
2. Read the sections of `docs/ARCHITECTURE.md` that the change touches. For Campaign changes,
   also read `docs/CAMPAIGN.md`.
3. Read `docs/ROADMAP.md` for status, milestone specs, delivery rules and the plan lifecycle.
   - If the pull request declares a milestone, its spec or `docs/plans/` plan is the
     acceptance criteria.
   - Otherwise, infer the narrowest applicable milestone.
4. Prefer code and test evidence over status labels. Missing future infrastructure is a defect
   only when the applicable milestone requires it.

## Milestone alignment

- Flag a milestone marked done without evidence for every acceptance criterion.
- Allow honest partial implementations that don't claim completion.
- Flag a skipped prerequisite only when its absence makes the change incorrect, unsafe or
  unverifiable.
- Flag scope outside the roadmap, or a contradiction of ARCHITECTURE.md or CAMPAIGN.md, unless
  the pull request updates that doc and handles the consequences. A pull request description may
  narrow the plan but never silently overrides the docs.
- A pull request that completes a milestone follows the plan lifecycle:
  - update the ROADMAP status
  - move binding contracts into ARCHITECTURE.md or CAMPAIGN.md
  - add a HISTORY.md summary
  - delete the plan
- Don't report later milestones merely because they remain unimplemented.

## Invariants

- Rules, RNG, card ownership, settlement and persistence stay outside Three.js and animation
  callbacks. Rendering consumes snapshots and already-committed events.
- Domain transitions depend on actions and serializable RNG, not frame time. Preserve:
  - RNG consumption order
  - ordered zones and card conservation
  - committed event order
  - stable save boundaries
- Presentation speed, reduced motion, skipped animations, pauses and context restoration never
  change results or replay randomness.
- Contract changes carry explicit versions:
  - stored shape: save schema plus migration or quarantine, and fixtures
  - rule semantics: ruleset or `gameRulesVersion`
  - event contract: `eventVersion`
- Main, Settings and Game remain the only top-level screens. Overlays stay inside Game.
- The app stays framework-light. Relative Vite/PWA paths, offline behaviour, bounded caches and
  the GitHub Pages deployment stay intact.

## Performance by subsystem

A theoretical optimization opportunity isn't actionable. Report one only when the diff
introduces a demonstrable regression or makes an unsupported performance claim.

Claimed optimizations need two things:
- Representative before/after evidence: profiles, frame traces, renderer resource counts, heap
  observations, texture timings or bundle sizes.
- Proof that results, saves, events and reduced-motion behaviour are unchanged.

Don't invent FPS, memory, bundle or timing budgets. The hard bounds in ARCHITECTURE.md are the
only limits, and measured timings are observations.

- **Rendering:**
  - per-frame CPU/GPU work and allocations, draw calls, invalidation
  - work while hidden or paused
  - DPR caps and resize/orientation handling
- **Resources:** reuse and disposal of geometries, materials, textures, listeners and observers.
  Caches stay bounded and regenerate after eviction, teardown or WebGL context restoration.
- **Domain:** hot-path algorithms and allocations. Never change deterministic outputs, RNG calls
  or order, zone order, settlement or event order.
- **Persistence:**
  - serialization volume and frequency, IndexedDB transactions, migration cost and lifecycle
    writes
  - atomic saves at stable boundaries
  - no recalculation or RNG replay during restore
- **UI and input:**
  - interaction latency, forced layout, resize storms, listener cleanup, duplicate activation
  - keep semantic controls, reduced motion, 44×44 targets and the 320×480 minimum viewport
- **PWA:**
  - cache growth and cleanup, offline fallbacks, update deferral at unsafe boundaries
  - no saves, and no textures that could be regenerated, in Cache Storage
- **Dependencies and build:**
  - bundle and runtime weight against the framework-light design
  - relative asset paths, service-worker asset injection and the Pages build

## Findings

- Report only high-confidence, actionable issues introduced by the pull request.
- Use one category per finding: **Performance**, **Plan alignment**, **Milestone status** or
  **Invariant violation**.
- State:
  - the scenario
  - the impact
  - the violated contract or criterion
  - the expected fix or the missing evidence
- Anchor each finding to the smallest useful changed range. Use a review-level comment only for
  cross-file or milestone-wide issues.
- Skip style nits, speculative micro-optimizations, duplicates, praise and pre-existing issues.
- If intent or evidence is ambiguous, ask a short question instead of asserting
  noncompliance. Return no finding when the change is aligned.

## Calibration

| Change | Expected review |
| --- | --- |
| A render loop creates geometry, materials or textures every frame without bounded reuse | **Performance**: resource churn or growth |
| Settlement or RNG moves into an animation callback | **Invariant violation**: domain/presentation boundary |
| A save, rules or event contract changes without a version and migration or quarantine | **Invariant violation** |
| A milestone is marked done without evidence for all acceptance criteria | **Milestone status** |
| A completed milestone leaves its plan in `docs/plans/` or a stale ROADMAP status | **Plan alignment** |
| A measured optimization preserves deterministic outputs and behaviour | No comment |
| An honest partial implementation that doesn't claim completion | Review only its scope |

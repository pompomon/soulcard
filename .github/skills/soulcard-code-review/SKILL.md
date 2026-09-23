---
name: soulcard-code-review
description: Review Soulcard pull requests for evidence-based performance issues and alignment with the implementation roadmap and milestones. Use for code review, especially when changes claim performance improvements, deliver roadmap milestones, or alter domain, rendering, persistence, UI, PWA, or build behavior.
license: MIT
---

# Soulcard code review

Review only the pull request's changes. Find actionable regressions and plan
violations without turning the roadmap into a request to implement unrelated future
work. This skill is self-contained and must not depend on MCP server context.

## Establish the review basis

1. Read the pull request description, changed files, and complete diff.
2. Read the current `docs/IMPLEMENTATION_ROADMAP.md`, especially the architecture,
   dependency map, applicable milestone, test pyramid, and definition of done.
3. Read the current `docs/MILESTONES.md` for declared completion state. Use the
   roadmap's milestone goal, dependencies, acceptance criteria, and checks as the
   source of truth; a checkbox alone is not proof of completion.
4. Identify explicitly declared milestone numbers. If none are declared, infer the
   narrowest applicable milestone from the behavior and files changed.
5. Inspect relevant tests, profiling results, and other evidence included in the
   change. Do not assume that missing future test infrastructure is a defect unless it
   is required by the applicable milestone.

When a checklist entry appears stale, prefer code and test evidence over the checkbox.
Do not reject a change solely because a prerequisite is unchecked when the repository
demonstrates that the prerequisite is implemented.

## Check plan and milestone alignment

For each applicable milestone:

- Compare the change with its goal/files, dependencies, acceptance criteria, and
  checks/risks.
- Flag a skipped prerequisite only when its absence makes the changed behavior
  incorrect, unsafe, or unverifiable.
- Flag a milestone newly marked complete when the pull request does not demonstrate
  all of its acceptance criteria.
- Allow focused partial implementations when the pull request represents them
  honestly and does not mark the milestone complete.
- Flag behavior outside the approved MVP scope or a material contradiction of the
  roadmap unless the pull request intentionally updates the roadmap and its
  consequences.
- Do not report unrelated later milestones merely because they remain unimplemented.
- If either planning document changes, ensure milestone numbering, names, dependency
  edges, and completion status remain synchronized between
  `docs/IMPLEMENTATION_ROADMAP.md` and `docs/MILESTONES.md`.

The pull request description may narrow the implementation plan, but it does not
silently override the repository roadmap. Treat inconsistencies between the stated
plan, the diff, and the live roadmap as reviewable when they affect correctness,
scope, dependencies, or completion claims.

## Protect roadmap invariants

Report changes that violate an applicable invariant:

- Authoritative rules, RNG, card ownership, settlement, and persistence stay outside
  Three.js and animation callbacks. Rendering consumes snapshots and already-committed
  events.
- Domain transitions depend on actions and serializable deterministic RNG, not frame
  time. Preserve RNG consumption order, ordered zones, card conservation, committed
  event ordering, and stable save boundaries.
- Presentation speed, reduced motion, skipped animations, pauses, and context
  restoration must not change game results or replay randomness.
- Save and migration changes preserve compatible state or provide the versioned
  migration/recovery required by the applicable milestone.
- Main, Settings, and Game remain the only top-level screens; Game overlays do not
  become additional screens.
- The application remains framework-light unless the roadmap is intentionally
  amended.
- Relative Vite/PWA paths, offline behavior, bounded caches, and GitHub Pages
  deployment remain intact.

For performance changes, verify equivalence of gameplay results, saves, events, and
reduced-motion behavior before accepting throughput or memory improvements.

## Review performance by subsystem

Treat a theoretical optimization opportunity as non-actionable unless the diff
introduces a demonstrable regression or the pull request makes an unsupported
performance claim. For claimed optimizations, look for representative before/after
evidence appropriate to the affected subsystem. Examples include repeatable profiles,
frame traces, renderer resource counts, heap observations, texture-generation timing,
or bundle-size comparisons.

Do not invent FPS, memory, bundle-size, or timing budgets. Until milestone 19 documents
measured performance hypotheses, assess boundedness, regressions, and evidence rather than
arbitrary numbers.

### Rendering

- Check per-frame CPU/GPU work, temporary allocations, draw calls, shader cost,
  invalidation, and work performed while hidden or paused.
- Check DPR/render-scale caps and resize/orientation behavior across the roadmap's
  supported layouts.
- Distinguish measured hot paths from speculative micro-optimizations.

### Resources

- Check reuse and disposal of geometries, materials, textures, render targets,
  listeners, observers, and renderer state.
- Ensure texture generation and caches remain bounded and can regenerate resources
  after eviction, teardown, or WebGL context restoration.
- Flag resources created repeatedly in a render loop or retained after their owning
  screen/theme is gone.

### Domain

- Check algorithmic and allocation changes on simulation and match hot paths.
- Reject optimizations that change deterministic outputs, RNG calls or order, zone
  order, conservation, settlement, or event order.

### Persistence

- Check serialization volume and frequency, IndexedDB transaction behavior, migration
  cost, and lifecycle writes.
- Preserve atomic saves at stable domain boundaries and avoid recalculating domain
  results or replaying RNG during restore.

### UI and input

- Check interaction latency, repeated DOM queries, forced synchronous layout, resize
  storms, listener cleanup, duplicate activation, and unnecessary work on pointer
  movement.
- Preserve responsive behavior, semantic primary controls, reduced motion, and the
  minimum-viewport requirements in the roadmap.

### PWA

- Check app-shell and runtime cache growth, obsolete-cache cleanup, offline fallbacks,
  and update deferral at unsafe domain boundaries.
- Keep save data out of Cache Storage and avoid caching generated textures when they
  can be regenerated locally.

### Dependencies and build

- Check bundle and runtime impact of dependencies against the framework-light design.
- Preserve relative asset paths, service-worker asset injection, and the GitHub Pages
  build/deployment contract.

## Finding quality gate

Report only high-confidence, actionable issues introduced by the pull request.

- Categorize each finding as **Performance**, **Plan alignment**,
  **Milestone status**, or **Invariant violation**.
- State the concrete affected scenario, resulting impact, relevant roadmap or
  milestone criterion, and expected correction or missing evidence.
- Anchor findings to the smallest useful changed line range. Use a review-level
  comment only for a genuinely cross-file or milestone-wide issue.
- Avoid style-only feedback, speculative micro-optimizations, duplicate comments,
  praise, and pre-existing issues outside the diff.
- If intent or evidence is genuinely ambiguous, ask a concise question instead of
  asserting noncompliance.
- Return no finding when the change is aligned and no actionable regression is
  supported by the available evidence.

## Calibration cases

Use these cases to keep review behavior consistent:

| Change | Expected review behavior |
| --- | --- |
| A render-loop edit creates geometry, material, or textures every frame without bounded reuse/disposal. | Report a **Performance** finding describing resource churn or growth. |
| Settlement or RNG moves into an animation callback. | Report an **Invariant violation** tied to the domain/presentation boundary and determinism. |
| A milestone is checked off without evidence for all acceptance criteria. | Report a **Milestone status** finding on the completion change. |
| Roadmap milestone numbering or dependencies change without the checklist changing. | Report a **Plan alignment** finding on the synchronization error. |
| A measured optimization preserves deterministic outputs and applicable behavior. | Do not manufacture a comment. |
| A focused partial milestone implementation is accurately described and does not claim completion. | Review only defects in its scope; do not demand unrelated later work. |

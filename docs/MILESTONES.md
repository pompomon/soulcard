# Milestones checklist

Tracks implementation progress for the plan in
[`IMPLEMENTATION_ROADMAP.md`](./IMPLEMENTATION_ROADMAP.md). Check off a milestone
only once its acceptance criteria in that document are met; keep this file's
numbering and dependencies in sync with the roadmap's "Milestones" and
dependency-map sections.

- [x] 1. Documentation baseline, terminology, and decisions (depends on: none)
- [x] 2. Test tooling and deterministic seeded RNG (depends on: 1)
- [x] 3. Card model, decks, zones, setup, and invariants (depends on: 2)
- [x] 4. Configurable burn-enabled/disabled rules (depends on: 3)
- [x] 5. Pure clash/tie state machine and conservation (depends on: 4)
- [x] 6. Seeded simulation harness (depends on: 5)
- [x] 7. Three-screen coordinator and DOM shell (depends on: 1)
- [x] 8. Settings persistence and graphics/reduced-motion controller (depends on: 7)
- [x] 9. Versioned active-run persistence, validation, migrations, recovery
      (depends on: 2–5)
- [x] 10. Pause/resume/autosave/page lifecycle (depends on: 7, 9)
- [x] 11. Three.js battlefield and responsive layout (depends on: 5, 7–8)
- [x] 12. Generated classic fronts/back, registry, cache, disposal (depends on: 3, 11)
- [x] 13. Committed-event-to-animation pipeline (depends on: 5, 8, 11–12)
- [ ] 14. Pointer interactions and responsive HUD (depends on: 7, 11, 13)
- [ ] 15. AI and complete source-to-personal-stage match flow (depends on: 5, 13–14)
- [ ] 16. Main, pause, resume, overwrite, and end-state integration
      (depends on: 8–10, 15)
- [ ] 17. PWA offline/update hardening (depends on: 9–10, 16)
- [ ] 18. Performance, context loss, accessibility baseline, cross-device QA
      (depends on: 11–17)
- [ ] 19. MVP release gate and definition of done (depends on: 1–18)
- [ ] 20. Post-MVP expansion (post-MVP, after 19)

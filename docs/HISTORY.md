# History

Retired plans, condensed. The full texts stay in git, and each section links the plan's last
version: commit `46a3577` up to Tarot card art, and `84dde50` for the short-deck setting and the
Campaign encounter rules. Binding contracts were moved into [ARCHITECTURE.md](ARCHITECTURE.md) and
[CAMPAIGN.md](CAMPAIGN.md), and open items into [ROADMAP.md](ROADMAP.md). Read an archived plan
only when you need its rationale or measured evidence.

## MVP roadmap, milestones 1–20 ([roadmap][roadmap-1-20], [checklist][milestones])

The roadmap built Classic mode bottom-up on six ADRs. Its normative sections (rules, contracts,
persistence, PWA, test pyramid) now live in ARCHITECTURE.md. Milestones and their pull requests:

| # | Milestone | PRs |
|---|---|---|
| 1 | Documentation baseline, terminology and decisions | #2, #4 |
| 2–3 | Seeded RNG and CI; card model, decks, zones and invariants | #5, #7 |
| 4–6 | Burn rules; clash/tie state machine; seeded simulation harness | #8, #9, #11 |
| 7–10 | Three-screen shell; settings; versioned saves and recovery; pause and lifecycle | #12–#15 |
| 11–13 | Three.js battlefield; generated themes and texture cache; event-to-animation pipeline | #16–#20 |
| 14–16 | Pointer input and HUD; AI encounter flow; menus and end states | #21–#28 |
| 17 | Gameplay settings, 2-over-Ace rules (rules version 2), guarded Auto-reveal | #31, #34 |
| 18 | PWA offline and update hardening | #29 |
| 19 | Performance, WebGL context loss, accessibility baseline, Chrome mobile QA | #33, #35 |
| 20 | MVP release gate | #36 |

## Milestone 19 QA ([plan][m19-qa]), #33 and #35

- QA was Chrome emulation only, at 320×480 and 844×390 with DPR 3. There was no physical-device,
  cross-browser, tablet/desktop, hardware-tier or long-session heap sign-off.
- It set the hard bounds: 24 texture-cache entries and 32 runtime-cache entries. Measured timings
  and heap readings are observations, not budgets.
- It set the accessibility baseline: 44 px targets, a 3 px focus indicator, semantic controls with
  polite status regions, and a presentational canvas.

## Milestone 20 release gate ([plan][m20-release]), #36

- The checklist and the cache- and schema-aware rollback procedure are condensed in ROADMAP.md
  under "Release checklist".
- The canonical baseline report used seeds 0–999, a 10,000-clash guard and timing profile
  `mvp-presentation-estimate-v1`:
  - `mvp-baseline-v2`: 432 player wins, 519 opponent wins, 49 draws
  - `mvp-no-burn-v2`: 495 player wins, 505 opponent wins, no draws, zero burns

## Roguelike adventure run, 21.1–21.4 ([plan][roguelike-plan]), #32, #37–#42 and #49

- **21.1 Campaign Duel** (#37, #38): three retryable encounters with health, a persistent deck
  and Hold.
- **21.2 Reward Drafts and Hold Upgrades** (#39): seeded reward drafts, campaign modifiers, and
  the informed Hold choice (Hold Insight).
- **21.3 Branching Expedition** (#40, then #41 from the
  [completion plan][m21-3-plan]):
  - route map, shops, events, coins and a replayed decision journal
  - retry as a guarded `{nodeId, step}` decision
  - an 8-route conservation ledger
  - a reachable sold-out Ember Bazaar, and repaired 21.1/21.2 browser harnesses
  - signed off in #49 on 2026-11-13
- **21.4 Encounter Archetypes and Elite Ladder** (#42,
  [implementation plan][m21-4-plan]):
  - the `expedition-v2` map: 12 nodes, 7 stages, 24 routes
  - four archetypes; High Court and Night Watch elites with their traits; rest nodes; the
    Ace Sovereign boss; an elite reward tier
  - save schema 7, Campaign rules 7, campaign version 4, Campaign events v5
  - Probe results with the starter deck over 1,000 seeds:
    - High Court: 61.7–66.9 % under every Hold policy
    - Night Watch: 45.8 % without Hold, 94.2 % with Hold Insight
    - Ace Sovereign: 24.5 % and 81.4 %
  - The plan holds the rejected alternatives, risks R1–R11 and the probe tables.
  - Signed off in #49 on 2026-11-13. A re-run of the probe reproduced every recorded cell, and
    Plunder still suspends Spoils of War.

## Uniform piles and phone footer ([plan][phone-plan]), #43 and #44

- All piles share one `pileScale` per layout mode, and the active deck gets a static halo.
- Only the decisive card shrinks.
- Hold moved into the player's row.
- The phone-portrait footer is a fixed row grid inside the 210 px reserve.
- The geometry rules and phone-HUD rules are in ARCHITECTURE.md. The Fold4 device check and the
  large-text items are in the ROADMAP backlog.
- The plan has the per-viewport measurements and the max-scale search (1.32 / 1.11 / 1.35 / 1.32).

## Tarot card art ([plan][tarot-plan]), #45 and #46

- Tarot (pixel) is the bundled default. Tarot (HD) is an opt-in pack of 54 WebP files (~1 MB) cached
  in `soulcard-art-*`.
- There's a live Card art setting. Classic remains the registry fallback.
- The change is presentation only: no ID, rules, save, event or RNG change.
- The settings, registry, cache, budget and service-worker rules are in ARCHITECTURE.md. The art
  pipeline is in [art/README.md](../art/README.md).
- "Plan §10, question 7" in `tools/card-art/hd-compose.mjs` refers to the 8 MB HD pack budget.
- The plan has the art direction, the alternatives, and the refine-latency and heap measurements.

## Classic short deck ([plan][short-deck-plan]), #52

- A Classic deck setting: 52 cards (the default) or 36 cards, 6 to Ace. It applies to new and
  restarted Classic games only; Campaign ignores it.
- Rulesets `short-deck-baseline-v1` and `short-deck-no-burn-v1`. On 36 cards 6 beats Ace, and only
  Ace. Classic `GAME_RULES_VERSION` stays 2.
- Classic events v6 name their deck, and saves moved to schema 8. Schema-7 saves of both modes
  carry over.
- The deck, event, setting and save contracts are in ARCHITECTURE.md; the Campaign notes are in
  CAMPAIGN.md.
- The plan has the research figures for seeds 0–9,999: with Auto-reveal, the longest burn game
  drops from 103.6 to 71.6 s, while no-burn games keep a median of 188 clashes.

## Campaign encounter rules ([plan][encounter-rules-plan], [research][faster-matches]), #53 and #54

- Each fight plays one of three encounter rules, drawn per fight node from the seed when the run
  starts (stream `campaign-encounter-rules-v1`, no run-RNG draw). The map names it, and a retry
  keeps it.
- Race to 10 and Attrition start once both sides replay their own cards. Double or nothing starts
  once either side does at normal fights, and once both do at elites and the boss.
- Tuning departed from the plan in three ways. Double or nothing stakes match what the shorter side
  can supply: one-sided short stakes drew 18.5% of Suit Opposition fights with Hold Insight and
  slowed the Watch of Tens. Its elite and boss starts wait for both sides: with `either`, Hold
  Insight won at most 53% of boss fights (band 75–90%) and the High Court fell to 13–19.5%.
  Attrition burns 2 cards: with 3, the player won 37.2% of boss fights without Hold (band 20–35%).
- Campaign rules 8, campaign version 5, Campaign events v7 (`stakes`, `attrition`, reason
  `raceTargetReached`), and save schema 9, which quarantines Campaign saves of schemas 4–8.
- The fight probe (`npm run probe:campaign`) landed in #53, and #54 tuned the rules with it: the
  boss keeps its bands, the elites got per-rule bands, no fight draws more than 15%, and no median
  Auto-reveal time grew. Under no-burn rules without Hold, medians fell from 97–905 s to 35–90 s.
- The contracts are in CAMPAIGN.md (rules §3, catalogue §7, versions §8, bands §11) and
  ARCHITECTURE.md (events, saves, stake and Attrition steps). The research compares Classic
  options A, C, E and G on seeds 0–9,999 and says why B, D and F were dropped; the plan has the
  scratch-probe figures behind the starts.

[roadmap-1-20]: https://github.com/pompomon/soulcard/blob/46a3577f72b5799845ff188af5cdbfa35e69c94c/docs/IMPLEMENTATION_ROADMAP.md
[milestones]: https://github.com/pompomon/soulcard/blob/46a3577f72b5799845ff188af5cdbfa35e69c94c/docs/MILESTONES.md
[m19-qa]: https://github.com/pompomon/soulcard/blob/46a3577f72b5799845ff188af5cdbfa35e69c94c/docs/MILESTONE_19_QA.md
[m20-release]: https://github.com/pompomon/soulcard/blob/46a3577f72b5799845ff188af5cdbfa35e69c94c/docs/MILESTONE_20_RELEASE.md
[roguelike-plan]: https://github.com/pompomon/soulcard/blob/46a3577f72b5799845ff188af5cdbfa35e69c94c/docs/ROGUELIKE_ADVENTURE_RUN_PLAN.md
[m21-3-plan]: https://github.com/pompomon/soulcard/blob/46a3577f72b5799845ff188af5cdbfa35e69c94c/docs/MILESTONE_21_3_COMPLETION_PLAN.md
[m21-4-plan]: https://github.com/pompomon/soulcard/blob/46a3577f72b5799845ff188af5cdbfa35e69c94c/docs/MILESTONE_21_4_IMPLEMENTATION_PLAN.md
[phone-plan]: https://github.com/pompomon/soulcard/blob/46a3577f72b5799845ff188af5cdbfa35e69c94c/docs/PHONE_VISUALS_IMPLEMENTATION_PLAN.md
[tarot-plan]: https://github.com/pompomon/soulcard/blob/46a3577f72b5799845ff188af5cdbfa35e69c94c/docs/TAROT_CARD_ART_PLAN.md
[short-deck-plan]: https://github.com/pompomon/soulcard/blob/84dde5006f13792824deeeab7a9c7fe476a62e90/docs/plans/short-deck-setting.md
[encounter-rules-plan]: https://github.com/pompomon/soulcard/blob/84dde5006f13792824deeeab7a9c7fe476a62e90/docs/plans/campaign-encounter-rules.md
[faster-matches]: https://github.com/pompomon/soulcard/blob/84dde5006f13792824deeeab7a9c7fe476a62e90/docs/plans/faster-matches.md

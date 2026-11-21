# Faster matches (proposal)

**Status:** research, kept for reference. Decided: A becomes a Classic-only setting
([done](../HISTORY.md#classic-short-deck-plan-52)), and C, E and G become Campaign encounter
rules, one assigned at random to each fight ([plan](campaign-encounter-rules.md)). Where they
differ, the plans win, including over "Contract and version impact" and "Campaign" below. Retire
this file with the second plan. Every option here uses A's 36-card deck; method and full tables are
in the pull request.

## Goal

A Classic game ends in under one minute, without changing the screen contract or the
deterministic boundary.

How "under one minute" is measured:

- **Game time:** the simulator's presentation estimate plus an allowance per clash. The estimate
  is `mvp-presentation-estimate-v1`: 400 ms per reveal, 600 ms per settlement, 200 ms per burned
  card and 1,200 ms at the end.
- **Auto-reveal budget:** 0.4 s per clash. A headless Chrome game measured 0.43 s per clash.
- **Manual budget:** 0.8 s per clash, which is that overhead plus a quick tap. This is an
  assumption.
- **Pass:** the longest game of seeds 0–9,999 ends within 60 s under the Auto-reveal budget, for
  both burn settings.
- **Stretch:** the same under the manual budget.
- **Comebacks:** a comeback is a game won by the side that owned fewer cards when the shared deck
  ran out, counted as a share of all games. New options keep comebacks at 22% or more under both
  burn settings.

## Why a game is slow today

- **Burn rules** (`mvp-baseline-v2`): about 44 clashes per game, each with about 1.7 s of
  animation. With Auto-reveal the median game takes 95 s and the longest 104 s. No seed ends
  within 60 s, which fits about 28 clashes.
- **No-burn rules** (`mvp-no-burn-v2`): the winner keeps every card, so cards only change hands.
  The median game is 426 clashes (13 min) and the longest 4,718 (2.4 h).
- **No decisions.** Classic's only game input is Reveal / Continue, so the only levers are fewer
  clashes or faster clashes.

## Design principles

Every option keeps both stages and adds no clash limit, unlike B and D. The rules draw on Mark
Rosewater's design columns:

- **Inertia:** "your game in a neutral state should be pushing the players towards completion"
  ([Ten Things Every Game Needs, part 1][ten-1]). No-burn games only move cards between hands, so
  nothing pushes them to end. E and G add inertia.
- **A catch-up feature** (same column): a side that falls behind needs a way back. A alone cuts
  comebacks from 31.5% to 24.9%. C's race starts at 0–0 in the personal stage, so under no-burn a
  card lead barely matters.
- **Surprise** ([part 2][ten-2]): hidden information keeps a game tense. E's stakes go down
  face down.
- **A goal** (part 1): C gives each game a visible finish line.
- **"You don't have to change much to change everything"** (lesson 17 of
  [Twenty Years, Twenty Lessons][twenty-3]): A changes only the deck, and G only how many cards a
  lost clash costs.

## Options

The projections use seeds 0–9,999 and a scratch engine that reproduces `simulateMatch` exactly for
both current rulesets. Every option uses A's 36-card deck. Times are the longest game, as
Auto-reveal / manual budget.

| Option | Deck | Personal clashes, burn / no-burn | Longest burn game | Longest no-burn game | Draws, burn / no-burn | Comebacks, burn / no-burn |
|---|---|---|---|---|---|---|
| Today | 52 | 19.5 / 532 | 103.6 / 124.0 s | 2.4 / 2.9 h | 4.8% / 0% | 31.5% / 34.8% |
| A. Short deck | 36 | 12.1 / 230 | 71.6 / 85.6 s | 58 / 70 min | 5.3% / 0% | 24.9% / 31.8% |
| C. Personal race to 10 | 36 | 12.0 / 16.4 | 71.6 / 85.6 s | 75.8 / 90.6 s | 4.5% / 0% | 27.0% / 41.6% |
| E. Double or nothing | 36 | 4.7 / 6.3 | 53.0 / 62.6 s | 53.6 / 64.0 s | 10.9% / 3.7% | 26.6% / 32.5% |
| G. Attrition | 36 | 4.0 / 8.5 | 51.4 / 60.6 s | 68.6 / 80.6 s | 1.7% / 0% | 26.6% / 25.6% |

"Personal clashes" is the mean number of clashes after the shared deck runs out. Under burn, a
game has at most 51 clashes today, 35 with A or C, and 24 with E or G. Only E keeps every game
within the Auto-reveal budget under both burn settings. With faster pacing, C and G do too.

### A. Short deck

- **Rules:** play with the 36 cards from 6 to Ace, in all four suits. The upset moves to the
  lowest rank, so 6 beats Ace. Nothing else changes.
- **Effect:** burn games are a third shorter. With Auto-reveal the median game takes 62.6 s and
  the longest 71.6 s, and 32.5% of games end within 60 s. Under the manual budget the median is
  74.2 s, and 5.5% of games end within 60 s.
- **No-burn isn't fixed:** the median game is still 188 clashes (6 min) and the longest 58 min.
- **Knob:** with 32 cards (7 to Ace) the longest burn game is 64.6 / 77.4 s. With 28 cards (8 to
  Ace, as first proposed) it is 56.6 / 67.8 s, but comebacks fall to 21.9%.
- **Trade-offs:** every rule and both stages stay. Burn comebacks fall to 24.9%. A shared-stage
  round ties about 9% of the time instead of 6%, so burns swing harder.
- The 52-card shared stage alone takes about 50 s, so C, E and G all use A's deck.

### C. Personal-stage race (revised)

- **Rules:** A's 36-card deck. The shared stage plays as today, and its clash wins don't count.
  From the first personal clash, each side counts the clashes it wins, and the first to 10 wins
  the game. A clash that starts as a tie on the last shared pair counts when it settles. A side
  that can't reveal still loses at once.
- **Under no-burn** the race ends 99.4% of games, within 37 clashes, and the longest game is
  75.8 / 90.6 s.
- **Under burn** the race rarely finishes. When the personal stage begins, the leading side owns
  about 11 cards and the trailing side 7, and every lost clash burns at least one. The target ends
  only 8.8% of games, and the rest end as A's do, in up to 71.6 / 85.6 s.
- **With pacing** C meets the Auto-reveal budget (50.6 / 57.0 s) but not the manual one
  (64.6 / 71.8 s).
- **Knob:** a lower target ends more burn games, but favours the trailing side. First to 8 ends
  41% of burn games and still runs up to 68.6 s with Auto-reveal. First to 5 misses that budget by
  0.2 s, and the trailing side then wins 50.0% of burn games against the leader's 33.7%.
- **Trade-offs:**
  - Under no-burn a card lead barely helps: the leader wins 42.0% and the trailing side 41.6%.
    Under burn, running out decides most games, and the leader wins 53.3% against 27.0%.
  - C adds a target ending and a HUD score, for example "7–5".
- **Principle:** a goal. Players can see how far each side is from winning.

### E. Double or nothing

- **Rules:**
  - A's 36-card deck. The shared stage plays as today.
  - The first personal clash is normal. Before the reveal of personal clash k, each side places
    2^(k−1) − 1 cards face down, so 2, 4, 8 and more cards per side are at risk.
  - A side that is short stakes all but its last card. Stakes settle like revealed cards.
- **Effect:** at most 24 clashes under burn and 26 under no-burn. E is the only option that meets
  the Auto-reveal budget for both settings without pacing. Under the manual budget 6.5% of burn
  games and 1.6% of no-burn games run over 60 s; with pacing, none do. Inability stays the only
  ending.
- **Knob:** on 32 cards (7 to Ace, as first proposed) E meets both budgets for both settings, at
  49.4 / 57.8 s under burn and 48.6 / 57.8 s under no-burn. Matching stakes to the shorter side
  cuts burn draws to 1.6%, but the longest burn game rises to 66.2 / 79.0 s.
- **Trade-offs:**
  - Burn draws rise from 4.8% to 10.9%, when both sides go all in, tie, and can't continue.
  - Stakes are new contest contents. The times assume 400 ms per stake placement.
- **Principle:** inertia, because each clash risks more, and surprise, because stakes are hidden.

### G. Attrition

- **Rules:** A's 36-card deck. The loser of a personal clash also burns its next 3 cards, under
  both burn settings.
- **Effect:** under burn, G meets the Auto-reveal budget, and 1.0% of games run over 60 s under
  the manual one. Under no-burn, 8.5% of games run over 60 s with Auto-reveal, up to 68.6 s. With
  pacing, G meets both budgets for both settings: 34.8 / 44.4 s and 46.8 / 58.8 s.
- **Knob:** with 4 cards, burn games meet both budgets, only 5 no-burn games in 10,000 run over
  60 s with Auto-reveal (61.6 s), and burn comebacks rise to 32.9%. With 2 cards the longest
  no-burn game is 76.0 s.
- **Trade-offs:**
  - The personal stage is short: 4.0 clashes under burn and 8.5 under no-burn.
  - Under no-burn, attrition is the only rule that removes cards. If the extra cards went to the
    winner instead, the longest no-burn game would be 346 s.
- **Principle:** inertia, and lesson 17: one number reshapes the personal stage.

### Rejected and dropped

- **B. One Deal** ended the game when the shared deck ran out, so it dropped the personal stage.
- **D. Short deck and shot clock** ended games at an artificial clash limit with a count-off.
- **F. Underdog rally** made the loser burn 2 more cards when the side with fewer cards won a
  personal clash. It was dropped in review, with its pairing with G.
- Resonance (lessons 3 and 4 of [Twenty Years, Twenty Lessons][twenty-1]) suggested familiar
  card-game rules. On 36 cards their burn comebacks are 23.9–24.8%, but no-burn games still run 7
  to 27 minutes, so they stay dropped. Burn comebacks and the longest no-burn game:
  - War: three face-down cards per side on each tie. 23.9%, 22 min.
  - Ante: one face-down card per side in every clash. 23.9%, 27 min.
  - Last stand: a side that owns at most half its rival's cards goes all in. 24.8%, 7 min.

### Complementary: faster pacing

Pacing changes presentation only. Rules, RNG, events and outcomes stay the same.

- Reveal both cards of a round in one 400 ms step, and fold burns into the 600 ms settlement. This
  saves about 0.65 s per clash.
- On its own, pacing isn't enough. Today's burn game drops to a 65 s median and a 73 s longest
  game with Auto-reveal, so only 15% of games end within 60 s. No-burn stays unbounded.
- Optionally, remember the Auto-reveal toggle, which is off whenever the Game screen opens
  (`src/ui/hud.js`). That adds a stored setting.

The longest game with pacing, as Auto-reveal / manual budget:

| Option | Burn | No-burn |
|---|---|---|
| A. Short deck | 50.6 / 64.6 s | 44 / 57 min |
| C. Personal race to 10 | 50.6 / 64.6 s | 57.0 / 71.8 s |
| E. Double or nothing | 36.8 / 46.4 s | 42.0 / 52.4 s |
| G. Attrition | 34.8 / 44.4 s | 46.8 / 58.8 s |

## Recommendation

**Choose E, with faster pacing.** On A's 36-card deck, E is the only option that meets the
Auto-reveal budget for both burn settings on its own (53.0 / 53.6 s), and pacing adds the manual
budget with room to spare (46.4 / 52.4 s). Comebacks are 26.6% / 32.5%, and inability stays the
only ending, so there's no new terminal reason. Its cost is burn draws: 10.9%, against 4.8% today.

If fewer draws and the smallest rule change matter more, **choose G with pacing**. It meets both
budgets for both settings with 1.7% burn draws, but has only 1.2 s to spare under no-burn with
manual reveals; 4 extra cards give 6.4 s. C with pacing meets only the Auto-reveal budget, and its
race rarely finishes under burn. A alone doesn't bound no-burn games.

## Contract and version impact

The plan sets the exact version numbers.

- **Rulesets:** add new ruleset IDs and keep `mvp-baseline-v2` and `mvp-no-burn-v2` valid, so
  saved games finish under their own rules. Bumping `GAME_RULES_VERSION` instead would quarantine
  Classic games in progress.
- **Stored shape:** `validateRuleset` accepts exactly `id` and `burn`. Deck and rule fields
  therefore need save schema 8, with a migration and fixtures for schema 7. C also stores
  personal-stage wins per side, and E the personal clash count. G needs no extra state.
- **Deck:** generalize setup and the "all 52 cards" zone invariant (`invariants.js`) to the
  ruleset's deck. The shared deck must have an even card count, which 52 and 36 both are.
- **Events:** Classic event validation uses `compareCards` (2 beats Ace) to check the winner, so
  a new upset rank needs a new Classic event version. E's stakes and G's extra burned cards add
  contest contents, which need it too. Campaign events already use version 5.
- **Outcomes:** `assertOutcome` (`match-machine.js`) accepts only the inability reasons. C needs a
  target reason; E and G end only by inability.
- **Simulation:**
  - Add the new rulesets to the report.
  - The report lists every known terminal reason, so C's target reason changes
    `tests/fixtures/simulation-report.json` even for today's rules. Regenerate that fixture
    deliberately, keeping the existing counts identical.
  - E's stake steps and pacing need a new timing profile, `mvp-presentation-estimate-v2`.
- **UI:**
  - The HUD needs C's score or E's current stake. Card counts follow the deck size.
  - The end overlay and status text need copy for C's target ending.
  - Under G, the extra cards burn even with burning off, so the "Turn burning" description must
    say so. Under every option the setting still changes the winner in 39–52% of seeds.

## Campaign

Campaign has its own machine and rules (rules 7, events 5), so the options above leave it
unchanged. Its fights are long too. Median fights over 300 seeds, with burn rules, the starter
deck and normal reveals:

| Fight | Clashes | Animation alone |
|---|---|---|
| Suit Opposition (gate) | 44 | 77 s |
| High Court (elite) | 34 | 59 s |
| Ace Sovereign (boss) | 27 | 47 s |

- Unless Auto-reveal is on, each Campaign clash needs two inputs: Reveal, then the Hold choice.
- Pacing carries over without changing balance.
- Bringing any of these rules to Campaign needs its own Campaign rules bump, and belongs with the
  21.5 balance work.

## Acceptance

- For seeds 0–9,999, every game of the chosen rulesets ends within 60 s under the Auto-reveal
  budget, for both burn settings. Report the manual budget alongside.
- Comebacks stay at 22% or more under both burn settings.
- A text-only headless browser check shows an Auto-reveal game on the new rules ending within 60 s.
- Games saved on the current rules either finish under those rules or are quarantined with a clear
  message, with fixtures.
- Tests cover:
  - deck composition and the upset rank
  - the chosen rule: C's personal count and target, E's stakes and all-in cap, or G's extra
    burns, including a side that runs out while burning
  - a simulation bound on clashes
  - migrations and events

## Open questions

- Should no-burn stay? C, E and G bound it; A alone doesn't.
- Under C, first to 10 ends only 8.8% of burn games by target. Is that acceptable, or should the
  target be lower?
- Under E, are 10.9% burn draws acceptable, or should stakes match the shorter side?
- Should Campaign adopt pacing now, and one of these rules along with 21.5?
- Is 0.8 s per clash the right manual budget? A check on a real phone would settle it.

[ten-1]: https://magic.wizards.com/en/news/making-magic/ten-things-every-game-needs-part-1-2011-10-24
[ten-2]: https://magic.wizards.com/en/news/making-magic/ten-things-every-game-needs-part-1-part-2-2011-12-19
[twenty-1]: https://magic.wizards.com/en/news/making-magic/twenty-years-twenty-lessons-part-1-2016-05-30
[twenty-3]: https://magic.wizards.com/en/news/making-magic/twenty-years-twenty-lessons-part-3-2016-06-13

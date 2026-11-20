# Faster matches (proposal)

**Status:** proposal, not scheduled. Revised after review: B and D are rejected, C now counts only
personal-stage wins, and E, F and G are new. Choose an option, and decide on pacing, before
scheduling. This file then becomes the plan and follows the
[plan lifecycle](../ROADMAP.md#plan-lifecycle). Method and full tables are in the pull request.

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
  comebacks from 31.5% to 21.9%. F is a catch-up rule, and it needs G's inertia under no-burn.
- **Surprise** ([part 2][ten-2]): hidden information keeps a game tense. E's stakes go down
  face down.
- **A goal** (part 1): C gives each game a visible finish line.
- **"You don't have to change much to change everything"** (lesson 17 of
  [Twenty Years, Twenty Lessons][twenty-3]): A changes only the deck, and G only how many cards a
  lost clash costs.

## Options

The projections use seeds 0–9,999 and a scratch engine that reproduces `simulateMatch` exactly for
both current rulesets. Times are the longest game, as Auto-reveal / manual budget.

| Option | Deck | Personal clashes, burn / no-burn | Longest burn game | Longest no-burn game | Draws, burn / no-burn | Comebacks, burn / no-burn |
|---|---|---|---|---|---|---|
| Today | 52 | 19.5 / 532 | 103.6 / 124.0 s | 2.4 / 2.9 h | 4.8% / 0% | 31.5% / 34.8% |
| A. Short deck | 28 | 8.7 / 122 | 56.6 / 67.8 s | 35 / 43 min | 5.1% / 0% | 21.9% / 29.4% |
| C. Personal race to 5 | 28 | 6.8 / 7.4 | 50.6 / 59.8 s | 46.6 / 55.8 s | 0.4% / 0% | 41.3% / 41.1% |
| E. Double or nothing | 32 | 4.5 / 6.1 | 49.4 / 57.8 s | 48.6 / 57.8 s | 11.5% / 3.6% | 25.2% / 30.8% |
| F. Underdog rally | 28 | 6.0 / 23.2 | 49.4 / 59.0 s | 101.0 / 121.4 s | 2.6% / 0.2% | 36.0% / 37.9% |
| G. Attrition | 28 | 3.2 / 6.4 | 40.8 / 48.0 s | 52.2 / 61.8 s | 2.1% / 0% | 29.6% / 24.3% |
| F and G together | 28 | 2.9 / 5.5 | 40.2 / 47.4 s | 47.8 / 56.6 s | 0.4% / 0% | 29.1% / 29.0% |

"Personal clashes" is the mean number of clashes after the shared deck runs out. Under burn, a
game has at most 51 clashes today, 28 with A, and 18–24 with the others.

### A. Short deck

- **Rules:** play with the 28 cards from 8 to Ace, in all four suits. The upset moves to the
  lowest rank, so 8 beats Ace. Nothing else changes.
- **Effect:** burn games are half as long. With Auto-reveal the median game takes 48 s and the
  longest 57 s. Under the manual budget the median is 56 s, and 82% of games end within 60 s.
- **Knob:** with 24 cards (9 to Ace, 9 beats Ace) the longest game is 49 / 58 s, so A also meets
  the manual budget, but comebacks fall to 18%.
- **Trade-offs:** every rule and both stages stay. Comebacks fall to 21.9%, just under 22%. A
  round ties 11% of the time instead of 6%, so burns swing harder.
- **No-burn isn't fixed:** the median game is still 101 clashes (3 min) and the longest 35 min.
- The 52-card shared stage alone takes about 50 s, so C, E, F and G all use a short deck.

### C. Personal-stage race (revised)

- **Rules:** A's 28-card deck. The shared stage plays as today, and its clash wins don't count.
  From the first personal clash, each side counts the clashes it wins, and the first to 5 wins the
  game. A clash that starts as a tie on the last shared pair counts when it settles. A side that
  can't reveal still loses at once.
- **Effect:** at most 23 clashes, and C meets both budgets for both settings. Under burn, the
  target ends 68% of games and inability the rest.
- **Knob:** first to 4 gives 47.6 / 56.0 s, but under burn the trailing side then wins 45.7%
  against the leader's 37.4%. First to 6 takes up to 63.6 s under the manual budget.
- **Trade-offs:**
  - Leading when the shared deck runs out barely helps, because the race counts clash wins, not
    cards: under burn the leader wins 41.5% and the trailing side 41.3%. The trailing side wins
    53% of personal clashes under burn, probably because its smaller pile recycles sooner, after
    burns have removed its losing cards.
  - C adds a target ending and a HUD score, for example "3–2".
- **Principle:** a goal. Players can see how far each side is from winning.

### E. Double or nothing

- **Rules:**
  - A 32-card deck, 7 to Ace, where 7 beats Ace. The shared stage plays as today.
  - The first personal clash is normal. Before the reveal of personal clash k, each side places
    2^(k−1) − 1 cards face down, so 2, 4, 8 and more cards per side are at risk.
  - A side that is short stakes all but its last card. Stakes settle like revealed cards.
- **Effect:** at most 21 clashes under burn and 23 under no-burn, and E meets both budgets for
  both settings. Inability stays the only ending.
- **Knob:** with 28 cards the longest game is 44.8 / 52.4 s, but burn comebacks fall to 22.4%.
  Matching stakes to the shorter side cuts burn draws to 1.8%, but comebacks fall to 23.8% and the
  longest burn game rises to 58.2 / 69.4 s.
- **Trade-offs:**
  - Burn draws rise from 4.8% to 11.5%, when both sides go all in, tie, and can't continue.
  - Stakes are new contest contents. The times assume 400 ms per stake placement.
- **Principle:** inertia, because each clash risks more, and surprise, because stakes are hidden.

### F. Underdog rally

- **Rules:** A's 28-card deck. When the side that owned fewer cards at the start of a personal
  clash wins it, the loser also burns its next 2 cards, under both burn settings.
- **Effect under burn:** the longest game is 49.4 / 59.0 s. Comebacks rise to 36.0%, above
  today's 31.5%, and draws fall to 2.6%.
- **No-burn isn't fixed:** the longest game is 101 / 121 s, and only 9% of games end within 60 s.
  A catch-up rule alone stretches games, so pair F with G.
- **Knob:** 1 card gives 31.4% comebacks and a 51.2 / 61.2 s longest burn game.
- **Principle:** a catch-up feature.

### G. Attrition

- **Rules:** A's 28-card deck. The loser of a personal clash also burns its next 3 cards, under
  both burn settings.
- **Effect:** G meets the Auto-reveal budget for both settings, and the manual budget under burn.
- **Knob:** with 2 cards the personal stage lasts a little longer (3.9 clashes under burn), but
  the longest no-burn game is 60.4 s, just over the budget.
- **Trade-offs:**
  - The personal stage is short: 3.2 clashes under burn and 6.4 under no-burn.
  - Under no-burn, attrition is the only rule that removes cards. If the extra cards went to the
    winner instead, the longest no-burn game would be 204 s.
- **Principle:** inertia, and lesson 17: one number reshapes the personal stage.

### F and G together

- **Rules:** the loser of a personal clash burns its next 3 cards, or 5 if it started the clash
  with more cards than the winner.
- **Effect:** it meets both budgets for both settings without pacing. Comebacks are 29.1% and
  29.0%, near today's, and draws almost vanish.
- **Knob:** with 2 attrition cards, comebacks rise to 33.1% / 30.4%, and the longest no-burn game
  is 52.2 / 61.8 s.
- **Trade-off:** the personal stage is the shortest of any option: 2.9 clashes under burn and 5.5
  under no-burn.

### Rejected and dropped

- **B. One Deal** ended the game when the shared deck ran out, so it dropped the personal stage.
- **D. Short deck and shot clock** ended games at an artificial clash limit with a count-off.
- Resonance (lessons 3 and 4 of [Twenty Years, Twenty Lessons][twenty-1]) suggested familiar
  card-game rules. They kept burn comebacks at 20–22% and no-burn games still ran long, so they
  were dropped. Burn comebacks and the longest no-burn game, on 28 cards:
  - War: three face-down cards per side on each tie. 20.0%, 14 min.
  - Ante: one face-down card per side in every clash. 20.3%, 20 min.
  - Last stand: a side that owns at most half its rival's cards goes all in. 22.1%, 8 min.

### Complementary: faster pacing

Pacing changes presentation only. Rules, RNG, events and outcomes stay the same.

- Reveal both cards of a round in one 400 ms step, and fold burns into the 600 ms settlement. This
  saves about 0.65 s per clash.
- On its own, pacing isn't enough. Today's burn game drops to a 65 s median and a 73 s longest
  game with Auto-reveal, so only 15% of games end within 60 s. No-burn stays unbounded.
- With an option, pacing gives about 15 s of headroom. The longest game becomes 27–40 s with
  Auto-reveal and 34–52 s under the manual budget. A and F still fail under no-burn.
- Optionally, remember the Auto-reveal toggle, which is off whenever the Game screen opens
  (`src/ui/hud.js`). That adds a stored setting.

## Recommendation

**Choose F and G together.** It meets both budgets for both burn settings without pacing, with
the most headroom. Burn comebacks stay near today's (29.1% against 31.5%), draws almost vanish,
and inability stays the only ending, so there's no new terminal reason. It gives Classic both a
catch-up feature and inertia. Its cost is a short personal stage.

If a longer personal stage and a visible score matter more, **choose C**. If keeping more cards
and suspense matter more, and 11.5% burn draws are acceptable, **choose E**. Add pacing to any of
them if the manual budget proves tight on real phones.

## Contract and version impact

The plan sets the exact version numbers.

- **Rulesets:** add new ruleset IDs and keep `mvp-baseline-v2` and `mvp-no-burn-v2` valid, so
  saved games finish under their own rules. Bumping `GAME_RULES_VERSION` instead would quarantine
  Classic games in progress.
- **Stored shape:** `validateRuleset` accepts exactly `id` and `burn`. Deck and rule fields
  therefore need save schema 8, with a migration and fixtures for schema 7. C also stores
  personal-stage wins per side, and E the personal clash count. F and G need no extra state.
- **Deck:** generalize setup and the "all 52 cards" zone invariant (`invariants.js`) to the
  ruleset's deck. The shared deck must have an even card count, which 52, 32 and 28 all are.
- **Events:** Classic event validation uses `compareCards` (2 beats Ace) to check the winner, so
  a new upset rank needs a new Classic event version. E's stakes and the extra burned cards of F
  and G add contest contents, which need it too. Campaign events already use version 5.
- **Outcomes:** `assertOutcome` (`match-machine.js`) accepts only the inability reasons. C needs a
  target reason; E, F and G end only by inability.
- **Simulation:**
  - Add the new rulesets to the report.
  - The report lists every known terminal reason, so C's target reason changes
    `tests/fixtures/simulation-report.json` even for today's rules. Regenerate that fixture
    deliberately, keeping the existing counts identical.
  - E's stake steps and pacing need a new timing profile, `mvp-presentation-estimate-v2`.
- **UI:**
  - The HUD needs C's score or E's current stake. Card counts follow the deck size.
  - The end overlay and status text need copy for C's target ending.
  - Under F and G, the extra cards burn even with burning off, so the "Turn burning" description
    must say so. Under every option the setting still changes the winner in 38–52% of seeds.

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
  - the chosen rule: C's personal count and target, E's stakes and all-in cap, or the extra burns
    of F and G, including a side that runs out while burning
  - a simulation bound on clashes
  - migrations and events

## Open questions

- Should no-burn stay? C, E, G, and F with G bound it; A and F alone don't.
- Under C, is it acceptable that leading after the shared stage barely helps?
- Under E, are 11.5% burn draws acceptable, or should stakes match the shorter side?
- Should Campaign adopt pacing now, and one of these rules along with 21.5?
- Is 0.8 s per clash the right manual budget? A check on a real phone would settle it.

[ten-1]: https://magic.wizards.com/en/news/making-magic/ten-things-every-game-needs-part-1-2011-10-24
[ten-2]: https://magic.wizards.com/en/news/making-magic/ten-things-every-game-needs-part-1-part-2-2011-12-19
[twenty-1]: https://magic.wizards.com/en/news/making-magic/twenty-years-twenty-lessons-part-1-2016-05-30
[twenty-3]: https://magic.wizards.com/en/news/making-magic/twenty-years-twenty-lessons-part-3-2016-06-13

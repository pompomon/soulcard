# Faster matches (proposal)

**Status:** proposal, not scheduled. Choose an option, and decide on pacing, before scheduling.
This file then becomes the plan and follows the [plan lifecycle](../ROADMAP.md#plan-lifecycle). The
method, calibration and full tables are in the pull request that added this file.

## Goal

A Classic game ends in under one minute, without changing the screen contract or the
deterministic boundary.

How "under one minute" is measured:

- **Game time:** the simulator's presentation estimate plus an allowance per clash. The estimate
  is `mvp-presentation-estimate-v1`: 400 ms per reveal, 600 ms per settlement, 200 ms per burned
  card and 1,200 ms at the end.
- **Auto-reveal budget:** 0.4 s per clash. One headless Chrome game with Auto-reveal took 99.0 s
  against a 78.8 s estimate: 47 clashes, so 0.43 s per clash, at about 20 frames per second.
- **Manual budget:** 0.8 s per clash, which is that overhead plus a quick tap. This is an
  assumption.
- **Pass:** the longest game of seeds 0–9,999 ends within 60 s under the Auto-reveal budget, for
  both burn settings.
- **Stretch:** the same under the manual budget.

## Why a game is slow today

- **Burn rules** (`mvp-baseline-v2`): about 44 clashes per game, each with about 1.7 s of
  animation. With Auto-reveal the median game takes 95 s and the longest 104 s. No seed ends
  within 60 s, which fits about 28 clashes.
- **No-burn rules** (`mvp-no-burn-v2`): the winner keeps every card, so cards only change hands.
  The median game is 426 clashes (13 min) and the longest 4,718 (2.4 h).
- **Both stages matter.** Under burn, the shared deck lasts 24.5 clashes and the personal stage
  19.5. In 31% of games, the side that was behind on cards when the shared deck ran out wins.
- **No decisions.** Classic's only game input is Reveal / Continue. All of its length is
  presentation, so the only levers are fewer clashes or faster clashes.

## Options

The projections use seeds 0–9,999 and a scratch engine that reproduces `simulateMatch` exactly for
both current rulesets. Times are the longest game, as Auto-reveal / manual budget.

| Option | Clashes, burn (mean / max) | Longest burn game | Longest no-burn game | Draws, burn | Comebacks, burn |
|---|---|---|---|---|---|
| Today | 44 / 51 | 104 / 124 s | 2.4 / 2.9 h | 4.8% | 31% |
| A. Short deck | 21 / 28 | 57 / 68 s | 35 / 43 min | 5.1% | 22% |
| B. One Deal | 24.5 / 26 | 53 / 64 s | 48 / 58 s | 0.3% | none |
| C. First to 10 | 16.5 / 19 | 45 / 53 s | 40 / 48 s | 0% | none |
| D. Short deck and clock | 21 / 24 | 53 / 62 s | 55 / 64 s | 4.7% | 22% |

"Comebacks" are games won by the side that was behind on cards when the shared deck ran out.

### A. Short deck

- **Rules:** play with the 28 cards from 8 to Ace, in all four suits. The upset moves to the
  lowest rank, so 8 beats Ace. Nothing else changes.
- **Effect:** burn games are half as long. With Auto-reveal the median game takes 48 s and the
  longest 57 s. Under the manual budget the median is 56 s, and 82% of games end within 60 s.
- **Knob:** with 24 cards (9 to Ace, 9 beats Ace) the longest game is 49 / 58 s, so A also meets
  the manual budget.
- **Trade-offs:** every rule and both stages stay. Comebacks fall from 31% to 22%. A round ties
  11% of the time instead of 6%, so burns swing harder. Draws stay near 5%.
- **No-burn isn't fixed:** the median game is still 101 clashes (3 min) and the longest 35 min.
  Pair A with B, C or D, or retire no-burn.

### B. One Deal

- **Rules:**
  - The game ends when the shared deck is dealt, so there's no personal stage.
  - The side that owns more cards wins. If counts are equal, the higher total card value wins (2 to
    14, Ace high). If values are also equal, it's a draw.
  - A tie on the last pair can't be broken, so those cards are discarded.
- **Effect:** a game never has more than 26 clashes. With Auto-reveal the longest game is 53 s
  under burn and 48 s under no-burn. Under the manual budget the median burn game is 62 s, and only
  18% end within 60 s, so B needs pacing to meet the stretch target.
- **Trade-offs:**
  - B drops the personal stage, and with it recycling, inability and comebacks.
  - Counts are equal in 14% of games, so the value tiebreak matters. Without it, those games would
    be draws.
  - Burn and no-burn pick the same winner in 97% of seeds, so the burn setting barely changes
    results.

### C. First to 10

- **Rules:** the first side to win 10 clashes wins at once. Ties still extend a clash, and burn
  still applies. If the shared deck runs out first, play continues into the personal stage as it
  does today; no seed got that far.
- **Effect:** a game has at most 19 decisive clashes and never ends in a draw. The longest game is
  45 / 53 s under burn and 40 / 48 s under no-burn. C passes both budgets for both settings
  without pacing work.
- **Knob:** the target. With Auto-reveal, first to 8 gives a longest game of 37 s, and first to 12
  gives 56 s.
- **Trade-offs:** C is the simplest rule to explain, and the HUD gains a score such as "7–5".
  However, no game reached the personal stage in 10,000 seeds, and burn never changed the winner.
  Classic becomes a race on the shared deck, and the burn setting only changes what's animated.

### D. Short deck and shot clock

- **Rules:** A's 28-card deck plus a 24-clash limit. If nobody has won when clash 24 settles,
  count off: the side that owns more cards (draw pile plus won pile) wins, then the higher total
  card value, otherwise it's a draw.
- **Effect:**
  - Burn games play out as in A, and the clock ends only the longest 8%. The longest game is
    53 / 62 s, and 88% of games end within 60 s under the manual budget.
  - The clock ends 97% of no-burn games. The longest is 55 / 64 s, and 98% of games end within
    60 s under the manual budget.
- **Knob:** with a 22-clash limit, every game ends within 51 / 59 s, so D also meets the manual
  budget. However, the clock then ends 35% of burn games.
- **Trade-offs:**
  - D keeps both stages, comebacks (22%) and a burn setting that changes results. Burn and no-burn
    pick different winners in 33% of seeds, against 43% today.
  - It adds two rules, and under no-burn the count-off decides almost every game.

### Complementary: faster pacing

Pacing changes presentation only. Rules, RNG, events and outcomes stay the same.

- Reveal both cards of a round in one 400 ms step, and fold burns into the 600 ms settlement. This
  saves about 0.65 s per clash.
- On its own, pacing isn't enough. Today's burn game drops to a 65 s median and a 73 s longest
  game with Auto-reveal, so only 14% of games end within 60 s. No-burn stays unbounded.
- With an option, pacing gives about 15 s of headroom. The longest game, as Auto-reveal / manual
  budget, becomes:
  - A: 40 / 52 s (burn only)
  - B: 38 / 48 s
  - C: 30 / 38 s
  - D: 36 / 46 s under burn and 40 / 50 s under no-burn
- Optionally, remember the Auto-reveal toggle. Today it's off every time the Game screen opens
  (`src/ui/hud.js`). Remembering it adds a stored setting.

## Recommendation

**Choose D with faster pacing.** It keeps what makes Classic distinct: two stages, comebacks and a
burn setting that changes results. It also bounds no-burn. Under the manual budget, its longest
game is 46 s under burn and 50 s under no-burn.

If the priority is the shortest, simplest game with one rule change, **choose C**. It meets both
budgets without pacing work, but it's a different, race-style game.

A alone fits only if no-burn is retired. B sits between C and D, but it still needs pacing for
manual play.

## Contract and version impact

This applies to whichever option is chosen; the plan sets the exact version numbers.

- **Rulesets:** add new ruleset IDs and keep `mvp-baseline-v2` and `mvp-no-burn-v2` valid, so
  saved games finish under their own rules, as Settings already promises. Bumping
  `GAME_RULES_VERSION` instead would quarantine Classic games in progress as
  `incompatible-game-rules`.
- **Stored shape:** `validateRuleset` accepts exactly `id` and `burn`. Deck, clock or target fields
  therefore need save schema 8, with a migration and fixtures for schema 7. C also stores clash
  wins per side.
- **Deck:** generalize setup and the "all 52 cards" zone invariant (`invariants.js`) to the
  ruleset's deck. The shared deck must have an even card count, which 52, 28 and 24 all are.
- **Events:** Classic event validation uses `compareCards` (2 beats Ace) to check the winner, so
  changing the upset rank (A and D) needs a new Classic event version. So does B's discarded last
  tie, which is neither a settled nor a drawn clash. Campaign events already use version 5.
- **Outcomes:** `assertOutcome` (`match-machine.js`) accepts only the inability reasons. Endings by
  count-off (B, D) or target (C) need new outcome reasons.
- **Simulation:**
  - Add the new rulesets to the report.
  - The report lists every known terminal reason, so a count-off or target reason changes
    `tests/fixtures/simulation-report.json` even for today's rules. Regenerate that fixture
    deliberately, keeping the existing counts identical.
  - Pacing needs a new timing profile, `mvp-presentation-estimate-v2`.
- **UI:**
  - The end overlay and status text need copy for the new terminal reasons.
  - The HUD needs the clock (for example "Clash 18 of 24") or the score.
  - Card counts follow the deck size.
  - Under B or C, the "Turn burning" setting no longer changes results, so reword or drop it.

## Campaign

Campaign has its own machine and rules (rules 7, events 5), so the options above leave it
unchanged. Its fights are long too. This table shows median fights over 300 seeds each, with burn
rules, the starter deck and normal reveals:

| Fight | Clashes | Animation alone |
|---|---|---|
| Gate fight | 44 | 77 s |
| High Court | 34 | 59 s |
| Ace Sovereign | 27 | 47 s |

- Unless Auto-reveal is on, each Campaign clash needs two inputs: Reveal, then the Hold choice.
- Pacing carries over without changing balance.
- A Campaign clock or race needs its own Campaign rules bump, and belongs with the 21.5 balance
  work.

## Acceptance

- For seeds 0–9,999, every game of the chosen rulesets ends within 60 s under the Auto-reveal
  budget, for both burn settings. Report the manual budget alongside.
- A text-only headless browser check shows an Auto-reveal game on the new rules ending within 60 s.
- Games saved on the current rules either finish under those rules or are quarantined with a clear
  message, with fixtures.
- Tests cover:
  - deck composition and the upset rank
  - the clock or target, the count-off and tiebreaks
  - a simulation bound on clashes
  - migrations and events

## Open questions

- Should no-burn stay? Only B, C and D bound it.
- At a count-off, should equal card counts be broken on card value or called a draw?
- Should Campaign adopt pacing now, and a clock along with 21.5?
- Is 0.8 s per clash the right manual budget? A check on a real phone would settle it.

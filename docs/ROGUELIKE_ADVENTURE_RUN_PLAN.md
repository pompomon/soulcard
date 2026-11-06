# Roguelike adventure-run plan

This is a post-MVP implementation plan. It refines the adventure-run portion of roadmap
milestone 21 into five cumulative, playable sub-milestones. First-class full keyboard
support follows the adventure work as milestone 21.6 rather than blocking Campaign Duel.

## Progress checklist

| Status | Milestone | Depends on | Playable outcome |
| --- | --- | --- | --- |
| [x] | 21.1 Campaign Duel | 20 | Three retryable encounters with health, a persistent deck, and Hold |
| [x] | 21.2 Reward Drafts and Hold Upgrades | 21.1 | Build-changing rewards and the opponent-reveal Hold boon |
| [ ] | 21.3 Branching Expedition | 21.2 | A route with combat, shops, and events |
| [ ] | 21.4 Encounter Archetypes and Elite Ladder | 21.3 | Elites, rest nodes, and a boss campaign |
| [ ] | 21.5 Seeded Procedural Campaign | 21.4 | A replayable generated roguelike campaign |
| [ ] | 21.6 First-class Keyboard Support | 21.5 | Complete keyboard navigation, gameplay, shortcuts, focus flow, tests, and instructions |

## Shared decisions and invariants

- The player's campaign deck persists across every encounter. Encounter opponents use
  separately defined encounter decks; player rewards never transfer opponent cards
  directly unless a reward explicitly creates a bounded player card instance.
- Replace the fixed canonical-52-card model with uniquely identified, bounded campaign
  card instances. A reward may add a new instance, duplicate an existing card as a new
  instance, replace an instance, or remove one. Every instance must belong to exactly
  one campaign/run zone.
- Every instance carries immutable `campaignOwner` provenance (`player` or `opponent`)
  independent of its current encounter zone. During an encounter, an ordered player
  campaign layout is retained as metadata, not a second card zone. It contains every
  non-held player ID and, while Hold is occupied, exactly one `holdPosition` token for
  the held instance. Capturing into an empty Hold slot replaces the selected ID with the
  token at that exact index. Replacing Hold puts the displaced held ID at the selected
  ID's layout index while the existing token is rebound to the newly held instance.
  Playing from Hold replaces the token with the held ID before supplying the card.
  Deck rewards mutate only ID entries; they cannot target the token, which shifts
  naturally with ordered insertions and removals. Validation requires exactly one token
  if and only if Hold is occupied.
- Encounter teardown first validates that every player-provenance instance occurs
  exactly once across both sides' source, draw, and won piles, `burnPile`,
  `contestedPile`, and Hold. The held instance remains in Hold; every other player
  instance is recovered to the campaign-deck zone in the retained campaign-deck order,
  regardless of which side controlled or burned it at termination. Every
  opponent-provenance instance is removed with the encounter from whichever terminal
  zone contains it. Teardown runs only after the terminal state commits at a stable
  boundary, so `inPlay` is empty and an unsettled terminal contest remains represented
  by `contestedPile`. This same teardown runs before a retry or encounter advance.
  Hold persists into that next encounter, and its instance is excluded from the player
  source pile because the campaign layout contains its token instead of its ID.
- An encounter uses player and opponent source piles rather than the current shared
  alternating `sourceDeck`. This is necessary for source-stage Hold use while retaining
  player campaign ownership. At each encounter attempt, copy the non-held player IDs
  from the campaign layout in layout order and the opponent IDs from the encounter
  definition in definition order. Using the current campaign RNG, shuffle the complete
  player input first and the complete opponent input second; index `0` of each result is
  next to reveal. A retry performs both setup shuffles again from its current RNG
  snapshot. No other setup step consumes RNG.
- Source piles do not recycle. Each side has a persisted `source` or `personal` supply
  mode and advances independently: when its source pile first empties, that side enters
  personal mode and shuffles its complete won pile into its draw pile. In personal mode,
  an empty draw pile recycles the complete won pile under the existing rules. Prepare
  the player's supply first and the opponent's second, performing either side's required
  transition or recycle in that order; each shuffle consumes RNG. This permits a
  source-mode card to face a personal-mode card, so unequal deck sizes do not decide the
  encounter merely by exhausting one source pile first. A side unable to produce a card
  after its required transition or recycle is unable for that reveal, except that the
  player may use occupied Hold before an untied reveal under the rules below. During a
  tie, Hold is unavailable; prepare both sides normally, then the sole supplied card
  joins the contest before its side wins if the other side is unable, or retain the
  contest and end in a draw if neither side can supply. Inability outcomes consume no
  additional RNG.
- Hold is an authoritative one-slot player zone, not a hand or presentation effect.
  Before each untied reveal, perform any source-to-personal transition and the player's
  required personal-stage recycle, then peek at the normal player candidate without
  removing it. Enter stable `awaitingHoldChoice` when that candidate exists or Hold is
  occupied. Its persisted metadata records the expected source zone and either the
  candidate instance at index `0` or an explicit null when that zone remains empty after
  recycle. With a null candidate, using Hold is the only legal choice; without either
  candidate or Hold, normal inability resolution runs without opening a choice. If the
  player uses Hold, a non-null candidate remains at index `0` unchanged and the held
  instance replaces its campaign-layout token before it supplies the player reveal.
  This works in source and personal stages.
- Base Hold access ends before the opponent reveals. Starting in 21.2, the
  Hold-information boon reverses that reveal order for the decision only: peek at the
  opponent's index-`0` candidate without removing it after any required recycle and
  enter `awaitingInformedHoldChoice`, persisting both candidate references, including an
  explicit null for either exhausted pile, then let the player choose held or candidate.
  Player and opponent preparation remains player-first. The choice action revalidates
  the referenced top cards or exhausted piles, removes only the cards actually supplied
  in player-first order, clears the decision metadata, and resolves comparison or
  inability. A tie never opens a Hold decision; its continuation resolves automatically
  without treating the held instance as available.
- Hold decision states keep `inPlay` empty and consume no RNG. Their save fingerprint
  binds the decision state and candidate metadata to the exact ordered zones, rules,
  and RNG snapshot. Any required pre-choice recycle and its RNG snapshot commit before
  entering the state. Reload presents the same candidates without drawing RNG or
  emitting an event. A null player candidate is valid only when Hold is occupied and
  the referenced pile remains empty after required recycling; any other mismatched
  metadata quarantines the invalid save rather than recomputing the choice. A committed
  clash event is emitted only after the choice action completes resolution.
- Capturing or replacing Hold is a stable, explicit action. Replacing a held instance
  atomically swaps it with the selected instance: the displaced held instance occupies
  the selected instance's exact former index in the same ordered encounter zone, and
  the selected instance enters Hold. Capture and replacement targets must have
  `campaignOwner: player` and currently occur in `player.drawPile` or
  `player.wonPile`; source piles, opponent-controlled piles, `contestedPile`, and
  `burnPile` are ineligible. Eligibility modifiers may only narrow that target set and
  cannot change the swap destination or order. The transition validates conservation
  and the campaign-layout token. A Hold choice must be saved before presentation can
  advance.
- Encounter losses reduce run health and retry the same encounter with the persistent
  deck. A terminal encounter draw has the same campaign transition: it reduces health
  once, grants no reward, does not advance the encounter, and retries that encounter
  after teardown. At zero health either transition ends the campaign in defeat instead
  of retrying. Wins advance the run. Buffs declare whether they expire with the
  encounter or persist for the campaign.
- Rules, run state, RNG, save migrations, event fingerprints, and ownership remain
  authoritative domain concerns. Three.js and HUD presentation consume committed
  snapshots/events only. Every new stable choice must be serializable and deterministic.

## 21.1 Campaign Duel

**Goal:** establish the campaign/run model while delivering a compact playable
three-encounter expedition.

**Scope**

- Add a separate Main-menu **Campaign** action; **Start New Game** continues to create
  the classic match. Both run types resume through the existing Game screen.
- Start at 3 health with a maximum of 5. The persistent starter deck is all thirteen
  Diamonds followed by all thirteen Hearts.
- Author three fixed opponents in order: all thirteen Spades followed by all thirteen
  Clubs for 1 damage; all Jacks, Queens, and Kings without Aces for 1 damage; and all
  four Aces for 2 damage.
- After the first win, create new player-provenance Spade- and Club-Ace instances. After
  the second win, restore 1 health up to 5. The final win ends the campaign without a
  reward.
- Introduce campaign-run state: health, encounter index, persistent player deck,
  encounter definition, held-card zone, active modifiers, campaign RNG, and terminal
  campaign outcome.
- Introduce bounded card-instance identity and conservation across campaign zones,
  encounter zones, burn/removal zones, and Hold.
- Split encounter setup into player and opponent source piles with independent persisted
  source/personal supply modes while preserving tie handling, burning, recycling, and
  terminal-draw rules as far as the new ownership model permits.
- Replace atomic player/opponent initial reveal resolution with the persisted
  `awaitingHoldChoice` metadata state; the resolving action then supplies the selected
  player card, supplies the opponent card, calculates, and settles. Tied continuation
  remains automatic and never accepts Hold.
- Deliver one Hold slot, capture only from an explicitly eligible settled card with
  `campaignOwner: player` under current player control, and deterministic replacement
  that cannot duplicate or lose a card.
- Implement health loss, same-encounter retry, victory advancement, and the fixed
  encounter/reward sequence. Keep the single maximum-health modifier active for the
  complete campaign run.
- Auto-reveal still commits the `awaitingHoldChoice` boundary, then chooses the normal
  candidate automatically; if only Hold can supply a card, it chooses that sole legal
  option rather than stopping.
- Version campaign rules and events and advance saves to schema v4. Deliberately
  quarantine schema-v1 through schema-v3 saves. Surface all run decisions in Game-owned
  overlays without adding top-level screens.

**Acceptance and validation**

- A player can complete, lose, save, reload, and retry a three-encounter campaign.
- Hold functions in source and personal stages, never after a tie, and preserves card
  order/conservation when played or replaced.
- Tests cover setup and retry shuffle order, unequal-source exhaustion with mixed supply
  modes, candidate-present and Hold-only decision boundaries, current-control target
  rejection, health depletion, migration, interrupted save, source/personal recycle,
  burn settlement, terminal draw, and deterministic replay. Browser checks confirm the
  canvas, semantic choices, and no relevant console errors.

Completion remains gated by roadmap milestone 20 even when the 21.1 implementation and
its acceptance checks are present.

**Completion evidence:** roadmap milestone 20 is complete. The Main-menu **Campaign**
button enters Campaign Duel through the existing Game screen, and focused domain,
persistence, controller, HUD, and bootstrap tests cover the acceptance matrix above.
The text-only browser fixture at
`/tests/browser/milestone-21-1-campaign.html` exercises that UI entry, a saved normal
choice, Hold capture, and a saved held-card choice while reporting one canvas, semantic
controls, completed presentations, and relevant console errors. Since 21.3 a new
Campaign opens on the route map, so the fixture first chooses the stage-1 Suit
Opposition node and waits for that choice to save before the first reveal.

## 21.2 Reward Drafts and Hold Upgrades

**Goal:** make wins create meaningful deterministic deckbuilding choices.

**Scope**

- Replace scripted rewards with seeded, bounded reward drafts offering new instances,
  duplicates, removals, and replacements from the campaign deck.
- Add an explicit modifier catalogue with permanent campaign and encounter-only
  lifetimes. Initial effects may alter comparison values, burning, recycling, Hold
  capture eligibility, or replacement eligibility; Hold remains exactly one slot and
  replacement remains the exact swap defined above.
- Through 21.3, each modifier declares its affected rule hooks and no two active
  modifiers may share a hook. Build seeded reward candidate pools in stable modifier-ID
  order after filtering conflicts and before selection draws; filtering consumes no
  RNG. Encounter setup and restored-state validation reject overlapping hooks rather
  than choosing an implicit precedence. Milestone 21.4 may introduce overlap only with
  versioned per-hook stacking order and RNG-consumption rules.
- Add the opponent-reveal Hold boon and persisted `awaitingInformedHoldChoice` state:
  the opponent candidate or exhausted-zone marker is committed as persisted peek
  metadata before the Hold choice, after which the player chooses the held card or
  their revealed candidate.
- Add reward and modifier inspection to the HUD/overlays and save every selected reward
  before presentation.

**Acceptance and validation**

- Every reward remains bounded to the run deck and can be reproduced from the same run
  seed and choices.
- Expiring encounter modifiers are removed exactly once; permanent modifiers survive
  encounter transition, reload, and retry.
- Tests cover information-boon reveal order and nullable candidates, all reward
  categories, Hold capture/replacement eligibility, modifier lifetime and hook-conflict
  rejection, replay, save/resume, and event fingerprints.

**Completion evidence:** Campaign rules version 4 and save schema 5 replace the scripted
rewards with seeded drafts drawn from the `campaign-reward-draft-v1` stream. Focused
domain tests cover every reward category, deck limits, the modifier catalogue and hook
conflicts, modifier lifetimes, the informed Hold choice, reward-history replay, and
event fingerprints. Persistence tests cover save/resume and the schema-4 policy
(Classic saves migrate unchanged; Campaign rules-3 saves are quarantined). HUD tests
cover the reward, target, saving, and Run details overlays. The text-only browser
fixture at `/tests/browser/milestone-21-2-rewards.html` restores a saved draft, checks
described 44px offers, the target list without the held card, Back, a reward that is
saved before the next encounter appears, the informed Hold choice, and Run details,
while reporting one canvas and relevant console errors. Which modifier a draft offers
depends on the run seed, so Hold Insight is not guaranteed in the first draft; the
fixture restores a seeded draft that offers it. Since 21.3 the fixture restores the
schema-6 draft, waits for the saved route map after the reward, and reaches the informed
Hold choice at the Royal Court through the Crossroads Shrine; Run details list the
route, active modifiers, and expedition log.

## 21.3 Branching Expedition

**Goal:** turn the compact expedition into a route-based roguelike while retaining the
same encounter and Hold rules.

**Scope**

- Add a short authored branching map with locked/unlocked node state and deterministic
  route choice actions.
- Add combat, shop, and event nodes. Shops spend run currency on bounded card and
  modifier choices; events offer explicit health, deck, Hold, or modifier trade-offs.
- Define stable transitions among map selection, encounter start, reward selection,
  shop purchase, event outcome, and retry. Persist the full node state and prevent
  duplicate purchase/reward application after restore.

**Acceptance and validation**

- A player can finish at least one authored route with divergent combat/shop/event
  choices and resume at every node boundary.
- Currency, purchases, route locks, and event outcomes are conserved and deterministic.
- Tests cover alternate paths, all node decisions, retries, exhausted shops, save/resume,
  and refusal of stale or duplicate decisions.

**Completion evidence:** Campaign rules version 6 and save schema 6 implement the
authored `expedition-v1` map. Its eight five-stage routes run from the Suit Opposition
fight through the Wayside Market or Crossroads Shrine, the Royal Court or Watch of Tens,
and the Ember Bazaar or Oathkeeper's Vault to the Ace Assembly finale. Route, reward,
purchase, event, shop-exit, and retry decisions are recorded in a decision journal that
restore replays against the saved run. Each decision names its node and journal step
and applies only to a saved boundary, so stale steps, other nodes, reloads, and repeated
activations cannot apply it twice. Rules 6 raises the shrine's Bleed for fortune payout
from 4 to 5 coins so that the gate, shrine, and Royal Court bounties (3 + 5 + 4) can buy
out the 12-coin Ember Bazaar; rules-5 Campaign saves replay the old payout and are
quarantined until discarded, as are the rules-3 and rules-4 Campaign saves carried by
schemas 4 and 5. The completion plan and its accepted decisions are recorded in
[`MILESTONE_21_3_COMPLETION_PLAN.md`](./MILESTONE_21_3_COMPLETION_PLAN.md).

Focused domain tests cover the map, route locks and bypasses, shop stock draws, purchase
blockers, sold and sold-out stock, event costs and gains, the vault's Hold trades,
journal replay and its rejection of illegal entries, guarded retries, and a content
ledger that balances coins, health, cards, and modifiers on every route with
deterministic seed-plus-choice replay. Persistence, controller, HUD, and bootstrap tests
cover save/resume at every node boundary, the sold-out fixture, the rules-5 quarantine,
retries that wait for the saved loss, and Auto-reveal stopping at restored boundaries.
`tests/integration/milestone-21-3-expedition-flow.test.js` drives market, sold-out
bazaar, and defeated expeditions through the application shell, reloading at each new
boundary, losing a failed purchase save to a reload that offers the saved shop again,
and refusing stale or repeated decisions. The text-only browser fixture at
`/tests/browser/milestone-21-3-expedition.html` restores a saved route map and checks
route locks, described 44px shop items and price blockers, the target list and Back, a
purchase saved before the shop updates, reloads at the shop and the next route map, a
failed shop-exit save and its retry, the expedition log, a shrine offering with a
target, and a sold-out bazaar, while reporting one canvas and relevant console errors;
it passes at 1280×720 and 390×844 viewports. The 21.1 and 21.2 fixtures now reach their
fights through the route map. The checklist entry stays open until reviewer sign-off.

## 21.4 Encounter Archetypes and Elite Ladder

**Goal:** provide strategic route risk through authored enemy identity and a full
campaign finale.

**Scope**

- Add deterministic enemy archetypes and elite encounter definitions using opponent
  deck construction and encounter-only modifiers, not presentation-side AI randomness.
- Add rest nodes, elite rewards, and a fixed boss. Define reward tiering and health
  recovery limits.
- Expand the modifier catalogue only where its ownership, expiry, stacking, and
  interaction with Hold are specified. Examples include opponent-reveal access, Hold
  capture eligibility, burn behavior, recycle order, and card-value effects.

**Acceptance and validation**

- A player can choose normal or elite risk, use rest strategically, defeat a boss, or
  lose the campaign through health depletion.
- Enemy and modifier effects cannot change RNG consumption accidentally or bypass
  card-instance conservation.
- Tests cover each archetype, elite/boss rewards, modifier stacks and expiry, health
  recovery, retry behavior, deterministic full-campaign replay, and save/resume.

**Completion evidence:** Campaign rules version 7, campaign version 4, and save schema 7
implement the authored `expedition-v2` map. Its 24 seven-stage routes run from the Suit
Opposition fight through the Wayside Market or Crossroads Shrine, the Royal Court or the
elite High Court, the Ember Bazaar, Oathkeeper's Vault, or Roadside Camp, and the Watch
of Tens or the elite Night Watch, to the Last Light Sanctum and the Ace Sovereign boss.
Four archetypes (Suit Legion, Court, Watch, and Sovereign) define opponent families by
their core decks, and each fight fields its archetype's core at a normal, elite, or boss
tier. Opponents make no choices; deck construction and traits decide their behaviour.
Both elites add A♠ and A♣ so that every rank can lose a clash, deal 2 damage, and carry
an opponent trait. Court Etiquette limits Hold capture and replacement to 2–10 cards,
and Plunder sends the player's losing cards to the opponent's won pile until the
encounter ends. Traits are opponent-owned catalogue entries stored on the encounter and
validated against its fight. They draw no randomness, and their stacking with player
modifiers is specified per hook. Plunder suspends Spoils of War, because fights with
both averaged 341 clashes in the balance probes. Elite drafts offer a J–A card while one
is unowned, and their Greater Mend restores 2 health instead of 1. Defeating the boss
completes the expedition without a draft; each loss costs the fight's damage, and a
fight can be retried while health remains. Rest sites offer 2 health, a free deck edit
(training or cleansing a card), or Walk on, and no node restores more than 2 health.
Rest decisions enter the decision journal with the same node-and-step guard as other
decisions. Campaign rules 3–6 saves are quarantined until discarded, and Classic schemas
4–6 carry over unchanged. The implementation plan, its decisions, and the measured
balance are recorded in
[`MILESTONE_21_4_IMPLEMENTATION_PLAN.md`](./MILESTONE_21_4_IMPLEMENTATION_PLAN.md).

Focused domain tests cover each archetype and tier; fight, archetype, and rest-site
validation; the trait lifetime; Hold and burn stacking matrices, including Plunder
suspending Spoils of War; plunder conservation; normal drafts that match goldens
captured before reward tiers; elite drafts and Greater Mend; the heal limit; rests and
their refusals; boss retries, victory, and defeat; and a per-step ledger that balances
coins, health, cards, modifiers, and RNG draws on all 21 map links, with a negative
self-test. Persistence, migration, repository, and HUD tests cover the v7 fixtures, the
rules 3–6 quarantine, rest boundaries that wait for their save and resume, and the
elite, rest, and boss presentation.
`tests/integration/milestone-21-4-campaign-flow.test.js` drives an elite ladder that
rests twice and defeats the Ace Sovereign across reloads, a boss defeat at 1 health
followed by a restart, stale, repeated, and replayed rest decisions, and a failed rest
save lost to a reload. The text-only browser fixture at
`/tests/browser/milestone-21-4-campaign.html` checks labelled elite, rest, and boss
nodes, Court Etiquette in Run details and Hold capture, Greater Mend, training targets
and Back at the Roadside Camp, a failed rest save and its retry, reloads at the rest and
route boundaries, cleansing targets at the sanctum, the stage-7 expedition log, and a
saved victory that restarts at 3/5 health, while reporting one canvas and relevant
console errors. It passes at 1280×720 and 390×844 viewports, as do the 21.1–21.3
fixtures on the seven-stage map.

First-attempt win rates with the starter deck over 1,000 seeds fall within the planned
bands: the High Court 61.7–66.9 % for every Hold policy, the Night Watch 45.8 % without
Hold and 94.2 % with Hold Insight, and the Ace Sovereign 24.5 % and 81.4 %. Decks from
the end of scripted routes raise these rates, the Sovereign's to 54 % without Hold, so
tuning stays with 21.5's simulation tooling. Opponent-reveal access, recycle order,
card-value effects, traits on normal and boss fights, and procedural traits are
deferred to 21.5. The checklist entry stays open until reviewer sign-off.

## 21.5 Seeded Procedural Campaign

**Goal:** create the full repeatable roguelike mode from deterministic generated content.

**Scope**

- Generate branching maps, node contents, encounter configurations, reward drafts,
  shops, and events from documented campaign RNG streams and consumption order.
- Preserve bounded content pools and card-instance limits so procedural generation
  cannot create unbounded decks, modifiers, rewards, or save records.
- Add procedural boss selection and a broader, fully specified modifier catalogue.
- Build simulation/report tooling for complete campaigns, including route selections and
  deterministic partial outcomes, separate from the current single-match simulator.

**Acceptance and validation**

- Equivalent seed-plus-choice replays produce equivalent maps, rewards, encounters,
  run state, events, and outcomes across save/resume boundaries.
- Generation always yields a reachable boss path and respects configured bounds.
- Tests cover seed corpus replay, path reachability, bounded pools, generated node
  validity, campaign simulation guards, migrations, lifecycle saves, and browser
  navigation through generated choices.

## 21.6 First-class Keyboard Support

**Goal:** make the completed classic and adventure modes fully operable and documented
for keyboard users without changing authoritative game rules.

**Scope**

- Add complete navigation, gameplay, shortcut, overlay focus-management, and instruction
  support for classic and campaign actions.
- Keep native semantic controls canonical and route keyboard activation through the same
  guarded controller actions used by pointer input.

**Acceptance and validation**

- Classic matches and complete generated campaigns can be played without pointer input.
- Focus order, restoration, trapping, shortcuts, and instructions have automated
  focus-flow coverage and browser validation.

## Delivery rules

- Do not create intermediate “foundation only” milestones: each sub-milestone above
  extends the previous playable game.
- Keep the current Main, Settings, and Game top-level screen contract. Map, reward,
  shop, event, and run-summary surfaces remain Game-owned overlays or panels.
- Preserve the existing deterministic/presentation boundary and save only after stable
  domain actions. Any new event or save shape includes an explicit version and migration
  or recovery policy.

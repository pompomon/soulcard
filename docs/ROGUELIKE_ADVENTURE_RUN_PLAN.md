# Roguelike adventure-run plan

This is a post-MVP implementation plan. It does not implement or mark complete any
gameplay milestone. It refines the adventure-run portion of roadmap milestone 21 into
five cumulative, playable sub-milestones; the milestone's other expansion work remains
outside this plan. Roadmap milestone 21's first-class full keyboard support must be
complete before sub-milestone 21.1 begins.

## Progress checklist

| Status | Milestone | Depends on | Playable outcome |
| --- | --- | --- | --- |
| [ ] | 21.1 Campaign Duel | 20 + milestone 21 keyboard support | Three retryable encounters with health, a persistent deck, and Hold |
| [ ] | 21.2 Reward Drafts and Hold Upgrades | 21.1 | Build-changing rewards and the opponent-reveal Hold boon |
| [ ] | 21.3 Branching Expedition | 21.2 | A route with combat, shops, and events |
| [ ] | 21.4 Encounter Archetypes and Elite Ladder | 21.3 | Elites, rest nodes, and a boss campaign |
| [ ] | 21.5 Seeded Procedural Campaign | 21.4 | A replayable generated roguelike campaign |

## Shared decisions and invariants

- The player's campaign deck persists across every encounter. Encounter opponents use
  separately defined encounter decks; player rewards never transfer opponent cards
  directly unless a reward explicitly creates a bounded player card instance.
- Replace the fixed canonical-52-card model with uniquely identified, bounded campaign
  card instances. A reward may add a new instance, duplicate an existing card as a new
  instance, replace an instance, or remove one. Every instance must belong to exactly
  one campaign/run zone.
- Every instance carries immutable `campaignOwner` provenance (`player` or `opponent`)
  independent of its current encounter zone. During an encounter, the ordered player
  campaign-deck IDs are retained as metadata, not a second card zone. Hold also records
  the exact campaign-deck index from which its player-provenance instance was removed.
  Capturing into an empty Hold slot removes that ID and records its index. Replacing
  Hold substitutes the displaced held ID at the selected ID's campaign-deck index and
  records that index with the newly held instance. Playing from Hold first reinserts
  its ID at the recorded index, then clears Hold before supplying the card.
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
  source pile because it is absent from the retained campaign-deck order.
- An encounter uses player and opponent source piles rather than the current shared
  alternating `sourceDeck`. This is necessary for source-stage Hold use while retaining
  player campaign ownership. The player source pile is constructed from the persistent
  campaign deck at encounter start. Source piles do not recycle. After a settled clash,
  both empty source piles transition to personal play by shuffling the player's complete
  won pile and then the opponent's. Before any other required reveal, exactly one empty
  source pile loses the encounter. During a tie, the available side's card joins the
  contest before it wins when exactly one source pile is empty. If both source piles are
  empty, retain the contest, perform the same player-first transition to personal play,
  and continue the tie there; normal personal-stage inability rules then produce a
  winner or a draw. Only the ordered transition shuffles consume RNG; inability outcomes
  do not.
- Hold is an authoritative one-slot player zone, not a hand or presentation effect.
  Before calculating a reveal round, peek at the player's top candidate without
  removing it and enter a stable `awaitingHoldChoice` state whose persisted metadata
  identifies that instance, its source zone, and index `0`. If the player uses Hold,
  the candidate remains at index `0` unchanged and the held instance is reinserted into
  the campaign order before it supplies the player reveal. This works in source and
  personal stages.
- Base Hold access ends before the opponent reveals. Starting in 21.2, the
  Hold-information boon reverses that reveal order for the decision only: peek at the
  opponent's index-`0` candidate without removing it and enter
  `awaitingInformedHoldChoice`, persisting both candidate references, then let the
  player choose held or candidate. The choice action revalidates the referenced top
  cards, removes only the cards actually supplied in player-first order, clears the
  decision metadata, and resolves the reveal. A tie never opens a Hold decision; its
  continuation resolves automatically.
- Hold decision states keep `inPlay` empty and consume no RNG. Their save fingerprint
  binds the decision state and candidate metadata to the exact ordered zones, rules,
  and RNG snapshot. Reload presents the same candidates without drawing RNG or
  emitting an event; mismatched metadata quarantines the invalid save rather than
  recomputing the choice. A committed clash event is emitted only after the choice
  action completes resolution.
- Capturing or replacing Hold is a stable, explicit action. Replacing a held instance
  atomically swaps it with the selected instance: the displaced held instance occupies
  the selected instance's exact former index in its player-controlled ordered encounter
  zone, and the selected instance enters Hold. Capture and replacement targets must
  have `campaignOwner: player`; eligibility modifiers may narrow but never remove that
  requirement. The transition validates conservation and the recorded campaign index.
  A Hold choice must be saved before presentation can advance.
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

- Introduce campaign-run state: health, encounter index, persistent player deck,
  encounter definition, held-card zone, active modifiers, campaign RNG, and terminal
  campaign outcome.
- Introduce bounded card-instance identity and conservation across campaign zones,
  encounter zones, burn/removal zones, and Hold.
- Split encounter setup into player and opponent source piles while preserving the
  existing source/personal-stage semantics, tie handling, burning, recycling, and
  terminal-draw rules as far as the new ownership model permits.
- Replace atomic player/opponent initial reveal resolution with the persisted
  `awaitingHoldChoice` metadata state; the resolving action then supplies the selected
  player card, supplies the opponent card, calculates, and settles. Tied continuation
  remains automatic and never accepts Hold.
- Deliver one Hold slot, capture only from an explicitly eligible settled card with
  `campaignOwner: player`, and deterministic replacement that cannot duplicate or lose
  a card.
- Implement health loss, same-encounter retry, victory advancement, and a fixed three
  encounter sequence. Add one scripted reward after each win that adds, removes, or
  replaces a player card instance and one simple modifier.
- Version rules, events, and save schema; migrate or deliberately quarantine legacy
  saves. Surface all run decisions in Game-owned overlays without adding top-level
  screens.

**Acceptance and validation**

- A player can complete, lose, save, reload, and retry a three-encounter campaign.
- Hold functions in source and personal stages, never after a tie, and preserves card
  order/conservation when played or replaced.
- Tests cover every decision boundary, retry, health depletion, migration, interrupted
  save, source/personal recycle, burn settlement, terminal draw, and deterministic
  replay. Browser checks confirm the canvas, semantic choices, and no relevant console
  errors.

## 21.2 Reward Drafts and Hold Upgrades

**Goal:** make wins create meaningful deterministic deckbuilding choices.

**Scope**

- Replace scripted rewards with seeded, bounded reward drafts offering new instances,
  duplicates, removals, and replacements from the campaign deck.
- Add an explicit modifier catalogue with permanent campaign and encounter-only
  lifetimes. Initial effects may alter comparison values, burning, recycling, Hold
  capture eligibility, or replacement behavior; Hold remains exactly one slot.
- Through 21.3, each modifier declares its affected rule hooks and no two active
  modifiers may share a hook. Build seeded reward candidate pools in stable modifier-ID
  order after filtering conflicts and before selection draws; filtering consumes no
  RNG. Encounter setup and restored-state validation reject overlapping hooks rather
  than choosing an implicit precedence. Milestone 21.4 may introduce overlap only with
  versioned per-hook stacking order and RNG-consumption rules.
- Add the opponent-reveal Hold boon and persisted `awaitingInformedHoldChoice` state:
  the opponent candidate is committed as persisted peek metadata before the Hold
  choice, after which the player chooses the held card or their revealed candidate.
- Add reward and modifier inspection to the HUD/overlays and save every selected reward
  before presentation.

**Acceptance and validation**

- Every reward remains bounded to the run deck and can be reproduced from the same run
  seed and choices.
- Expiring encounter modifiers are removed exactly once; permanent modifiers survive
  encounter transition, reload, and retry.
- Tests cover information-boon reveal order, all reward categories, Hold eligibility
  and replacement effects, modifier lifetime and hook-conflict rejection, replay,
  save/resume, and event fingerprints.

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

## Delivery rules

- Do not create intermediate “foundation only” milestones: each sub-milestone above
  extends the previous playable game.
- Keep the current Main, Settings, and Game top-level screen contract. Map, reward,
  shop, event, and run-summary surfaces remain Game-owned overlays or panels.
- Preserve the existing deterministic/presentation boundary and save only after stable
  domain actions. Any new event or save shape includes an explicit version and migration
  or recovery policy.

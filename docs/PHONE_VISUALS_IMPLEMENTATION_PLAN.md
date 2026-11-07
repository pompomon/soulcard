# Uniform deck sizes and a readable phone footer: implementation plan

Source: a user report with a screenshot of Soulcard installed as an Edge PWA on the
Galaxy Z Fold4 cover screen, taken during a Campaign fight. The request is to draw every
deck at the same size and to make the bottom status panel readable on that small screen.
Baseline: `main` at `c6ea2d0`, after PR #42. Status: **implemented** (see §11). This plan was
prepared without interactive answers. Each decision in §5 therefore states a recommended
default with its alternatives, and §10 lists the questions to settle before
implementation starts. The change is presentation-only and is not a roadmap milestone.
Line anchors refer to `c6ea2d0`.

## 1. Summary

The screenshot shows two problems:

- **Decks differ in size.** The active deck, the pile the player reveals from, is drawn
  at `activeDeckScale`. Every other pile uses the smaller `secondaryPileScale`. On the
  cover screen the active Source pile is 67×93 CSS px and every other pile is 48×67.
- **The footer is unreadable.** Phone-portrait mode puts the Opponent and Player panels
  side by side in a 64 px row. At 344 px wide, six of the eight metric labels wrap, so
  each panel needs 83 px. Its values fall below the panel into the piles row, where the
  piles panel paints over them. The status line is 10.4 px.

This plan delivers:

1. **One pile scale per mode.** Every pile (source, draw, won, Hold, contested and
   burn) uses a new `pileScale`. Revealed cards keep `revealScale` and stay larger (D1).
2. **An active-deck halo.** Size no longer marks the active deck, so a ring in the app's
   focus colour joins the existing tint (D2).
3. **Consistent settlement.** The decisive card still shrinks into its pile, now to
   `pileScale`, so it lands at the size of the pile it joins (D3).
4. **Anchor fixes.** Hold moves and a few piles shift, so the uniform scale fits with
   clearance in all four layout modes. This also removes overlaps that exist today (D4).
5. **A one-row-per-side footer.** Opponent and Player each get a full-width row. Labels
   are 12 px on one line, values 16 px, and the status 12 px in at most two lines (D5).
6. **A save-warning state.** While a save warning shows, the feedback area takes over
   the piles row, so the warning and the status both fit (D6).
7. **Optional landscape polish.** The phone-landscape status grows to 12 px and stops
   overlapping the controls on the cover screen (D7).

The new footer rows add up to the same 210 px reserve, so the battlefield keeps its
size. No domain, rule, event, save or RNG behaviour changes, so no version bump is
needed (roadmap :11-15). Seven work packages (WPs) deliver the change in one PR.

## 2. Baseline evidence (Node 24.22.2)

- `npm test`: 495 pass, 0 fail, in about 27 s.
- `npm run build`: passes. The existing warning about chunks over 500 kB (785.49 kB) is
  unchanged.
- The working tree is clean at `c6ea2d0`.

Method:

- **Geometry.** Scripts outside the repository imported `createBattlefieldLayout`. They
  computed card boxes, gaps and the largest overlap-free uniform scale for each mode.
  They model:
  - the card plane, 1.05×1.45 world units (battlefield.js:276, 296)
  - the reveal jitter: x ±0.195 and y up to +0.105 (`transientOffset`, :888-894)
  - the contested spread: +0.105 x and +0.075 y (`addPileRepresentative`, :732-751).

  Targets: at least 0.08 world units between card boxes and 0.05 to the world edge.
  Piles that are never occupied together are skipped (§6, WP4).
- **DOM.** A text-only headless Chromium ran the app under `npm run dev`, in a Campaign
  fight started from Main. The five Campaign controls, including Hold, were visible.
  - `#app` was resized through a viewport matrix.
  - A 34 px top safe area was injected to match the installed PWA.
  - Measurements: `clientHeight` against `scrollHeight`, bounding boxes, computed font
    sizes and line counts.
  - The "proposed" figures come from injecting the D5–D7 stylesheet.

  No screenshots were generated.

### 2.1 Screenshot analysis

| Observation | Measured cause | Evidence |
| --- | --- | --- |
| The CSS viewport is 344×882 with a top inset of about 34 px. The screenshot has about 2.27 px per CSS px. | Installed PWA with `viewport-fit=cover`; the inset feeds the safe-area variables | index.html:5; style.css:189-195; battlefield.js:164-176 |
| Phone-portrait mode; the battlefield is 344×486 at 41.2 px per world unit | The header (72), comparison (80) and footer (210) reserves | layout.js:29-51 |
| The active Source pile is visibly larger than the other piles | 67×93 CSS px at `activeDeckScale` 1.55, against 48×67 at `secondaryPileScale` 1.12 | layout.js:32-36; battlefield.js:400-410 |
| Footer values are hidden or smeared | Each metric is 50 px wide, so six of eight labels wrap. Each side panel needs 83 px in a 62 px box. Its values (735–756 px from the top) lie below the panel's bottom edge (736 px). The piles panel comes later in the DOM and paints over them with a 64 % background and an 8 px blur. | style.css:234-246, 629-639; hud.js:133-150 |
| The status line is hard to read | 10.4 px (0.65rem) in a 48 px row; the controls overlap the feedback by 5 px | style.css:629-639, 700-705 |
| The header's Stage value ("P Source · O Source") and the "Source deck" label wrap | Header layout | Out of scope (D9) |

### 2.2 Pile sizes

CSS px (width × height). The proposed column uses the D1 `pileScale` per mode: 1.25 in
phone portrait, 1.1 in phone landscape, and 1.3 on tablet and desktop.

| Viewport | Mode | px per unit | Other piles now | Active deck now | Every pile (proposed) | Revealed card |
| --- | --- | --- | --- | --- | --- | --- |
| Fold4 cover, installed PWA, 344×882 | phone-portrait | 41.2 | 48×67 | 67×93 | 54×75 | 67×93 |
| Fold4 cover, Edge tab, 344×720 | phone-portrait | 30.3 | 36×49 | 49×68 | 40×55 | 49×68 |
| Fold4 cover, landscape, 882×344 | phone-landscape | 21.3 | 23×31 | 31×43 | 25×34 | 31×43 |
| Minimum, 320×480 | phone-portrait | 10.0 | 12×16 | 16×22 | 13×18 | 16×22 |
| 390×844 | phone-portrait | 33.9 | 40×55 | 55×76 | 45×62 | 55×76 |
| 412×915 | phone-portrait | 46.9 | 55×76 | 76×105 | 62×85 | 76×105 |
| 844×390 | phone-landscape | 27.9 | 30×41 | 41×57 | 32×45 | 41×57 |
| Fold4 inner screen, 690×829 | tablet | 42.0 | 53×73 | 77×106 | 57×79 | 77×106 |
| 768×1024 | tablet | 49.2 | 62×86 | 90×125 | 67×93 | 90×125 |
| 1440×900 | desktop | 75.4 | 95×131 | 139×191 | 103×142 | 139×191 |

The active deck shrinks by 19–26 % and every other pile grows by 8–12 %. The active
deck's hit target keeps its 44×44 CSS px minimum (`MINIMUM_DECK_TARGET_SIZE`,
battlefield.js:27). That minimum already applies wherever the card is narrower than
44 px.

### 2.3 Pile geometry

Today's layout already breaks the clearance targets. Gaps are in world units, and a
negative gap is an overlap. The active deck is at `activeDeckScale` and every other pile
at `secondaryPileScale`.

| Mode | Pairs below the 0.08 target today |
| --- | --- |
| phone-portrait | Hold and player won pile −0.486 (won pile active, card in Hold); Hold and burn −0.136 (Hold active); contested and burn 0.076 |
| phone-landscape | Hold and burn −0.504 |
| tablet | Hold and burn −0.689; player won pile and player reveal −0.432; opponent won pile and opponent reveal −0.144 |
| desktop | Hold and burn −0.689; player won pile and player reveal −0.233; contested and burn 0.060; opponent won pile and opponent reveal 0.056 |

With today's anchors no uniform scale is overlap-free at all in phone landscape or on
tablet; the search started at 0.9. In phone portrait and desktop the limit is 0.94,
below today's secondary scale. A uniform scale therefore needs new anchors (D4).

With the D4 anchors:

| Mode | Largest overlap-free uniform scale | Proposed `pileScale` | Smallest halo clearance (0.08 ring) | Smallest halo clearance (0.12 ring) |
| --- | --- | --- | --- | --- |
| phone-portrait | 1.32 | 1.25 | 0.344 (Classic source deck to the world edge) | 0.294 |
| phone-landscape | 1.11 | 1.1 | 0.264 (player draw pile to the world edge) | 0.220 |
| tablet | 1.35 | 1.3 | 0.100 (Hold to the player reveal) | 0.048 |
| desktop | 1.32 | 1.3 | 0.150 (player won pile to the player reveal) | 0.098 |

In every mode the contested and burn piles set the scale limit. The halo columns check
the D2 ring around every pile that can be active: source deck, player source pile,
player draw pile, player won pile and Hold.

### 2.4 Footer measurements

Today, at 210 px of footer rows `64 36 48 62`:

| Viewport | Side panels (box / content) | Piles panel overflow | Controls overlap feedback | Overflow with save warning |
| --- | --- | --- | --- | --- |
| 344×882, 34 px inset | 62 / 83 px | 2 px | 5 px | 17 px |
| 344×720 | 62 / 83 px | 2 px | 5 px | 17 px |
| 320×480 | 62 / 83 px | 2 px | 5 px | 17 px |
| 300×450, letterboxed | 62 / 83 px | 2 px | 1.9 px | 17 px |
| 390×844 | 62 / 68 px | 2 px | 5 px | 4 px |
| 412×915 | 62 / 68 px | 2 px | 0 | 4 px |

At 344 px each metric is 50 px wide. Labels are 11.2 px, and six of the eight wrap
("Source pile", "Draw pile" and "Won pile" on both panels). The status is 10.4 px.

Proposed (D5 and D6), with rows `42 42 28 36 62`, which also add up to 210 px:

| Viewport | Overflow | Wrapped labels | Overlaps | Overflow with save warning | Smallest control | Battlefield row (unchanged) |
| --- | --- | --- | --- | --- | --- | --- |
| 344×882, 34 px inset | 0 | 0 | 0 | 0 | 49 px | 486 px |
| 344×720 | 0 | 0 | 0 | 0 | 49 px | 324 px |
| 320×480 | 0 | 0 | 0 | 0 | 49 px | 84 px |
| 300×450, letterboxed | 0 | 0 | 0 | 0 | 46 px | 78.8 px |
| 390×844 | 0 | 0 | 0 | 0 | 44 px | 448 px |
| 412×915 | 0 | 0 | 0 | 0 | 44 px | 519 px |

- Labels are 12 px, values 16 px and the status 12 px. Each metric is 78 px wide at
  344 px and 93 px at 390 px.
- Every value lies inside its panel; at 344×882 the values end 4 px above each panel's
  bottom edge.
- The header is unchanged: 72 px, no overflow, and labels still 11.2 px.
- Phone landscape (882×344, 844×390), tablet (690×829, 768×1024) and desktop
  (1280×800) are unchanged, because every D5 rule is scoped to phone portrait.

### 2.5 Status and warning fit

At 344 px with D5, every status message fits in at most two lines with no overflow,
including the two longest:

- "Hold Insight shows both next cards. Choose the prepared card or the card in Hold."
- "Graphics recovery failed (webgl-context-lost). Pause and save remain available;
  reload to retry."

With the save warning visible as well, D5 alone overflows the 36 px status row by up to
33 px. With D6 the overflow is 0 at every portrait size.

### 2.6 Phone landscape

The phone-landscape status uses the same 0.65rem rule (style.css:700-705). These
problems exist today:

| Viewport | Today | With D7 |
| --- | --- | --- |
| 882×344 (Fold4 cover), 844×390, 640×360 | The feedback overflows 1 px. The controls block is 54 px tall in a 52 px row and overlaps the feedback by 2 px. The status is 10.4 px. | No overflow or overlap; the status is 12 px on one line |
| 480×320 | Long messages wrap: 7 px overflow, 7.2 px overlap | 6 px overflow, 5.2 px overlap (remaining) |
| Save warning shown, at 882×344, 844×390 and 640×360 | Up to 9 px overflow | Up to 8 px overflow (remaining) |

### 2.7 Text scaling

At 344×882, with the root font size raised as a large-text setting would:

| Root font size | Today | Proposed |
| --- | --- | --- |
| 16 px (100 %) | Side panels overflow 21 px | No overflow |
| 18.4 px (115 %) | Side panels overflow 34 px | Side panels overflow 1 px and the feedback 4 px; the controls overlap the feedback by 4 px |
| 20.8 px (130 %) | Not measured | Side panels overflow 7 px and the feedback 9 px; values are clipped |

It is unverified how Edge on Android applies its text-size setting to an installed PWA
(root font size or text autosizing). See D8.

### 2.8 Findings

1. **The size difference is intentional today.** PR #24 kept secondary piles visually
   subordinate so that the active deck stands out. A uniform size needs a new cue for
   the active deck (D2).
2. **The anchors limit the scale.** Without new anchors no uniform scale works in two
   modes (§2.3). The D4 anchors also remove every overlap that exists today.
3. **The footer problem is the two-column row.** Halving 344 px leaves 50 px per metric.
   A full-width row per side gives 78 px, which fits "Source pile" at 12 px.
4. **The row heights can be redistributed without losing battlefield height.** The rows
   `42 42 28 36` add up to the same 148 px as today's `64 36 48`.
5. **The header wraps too,** and the comparison details are 0.65rem (style.css:818-823).
   Both are separate problems (D9).
6. **Large text remains a risk** for both today's footer and the proposal (D8).

## 3. What exists

| Area | Implementation | Evidence |
| --- | --- | --- |
| Layout modes | Phone portrait, phone landscape, tablet and desktop. Each mode has a fixed world size, HUD reserves, `visuals` scales and zone anchors. `createBattlefieldLayout` classifies the viewport and copies the mode's spec. | layout.js:28-120, 170-179, 317-319 |
| Pile scales | `activeDeckScale` 1.55 / 1.4 / 1.75 / 1.75; `secondaryPileScale` 1.12 / 1.02 / 1.2 / 1.2; `revealScale` 1.55 / 1.4 / 1.75 / 1.75 (portrait / landscape / tablet / desktop). PR #24 introduced the subordinate secondary scale. | layout.js:32-36, 55-59, 78-82, 101-105 |
| Active deck | `actionableDeckZone` returns the source deck during Classic's source stage. Otherwise it returns the first non-empty of the player source pile (Campaign), draw pile and won pile, then Hold (Campaign). `visualScale` enlarges that deck and `applyVisualAppearance` tints it 0xd9fbff, even while input is disabled. | battlefield.js:30, 115-133, 400-432 |
| Hit target | A raycast against the active deck's top card, with a 44×44 CSS px minimum | battlefield.js:27, 434-485 |
| Drag | `beginDeckDrag` re-parents the top card to the scene. Releasing it over the player reveal area dispatches the guarded action; otherwise the card snaps back. | battlefield.js:569-615 |
| Settlement | Only the decisive winning card shrinks to the pile scale in flight (PR #30). A resize retargets that tween. | battlefield.js:813-845, 1201-1203, 1351-1367 |
| Placeholders | One translucent plane per zone at local z 0, with a pulsing opacity. They are hidden once a snapshot renders. | battlefield.js:276-295, 754, 960-965 |
| Pile cards | One representative card per pile at local z ≥ 0.02. The contested pile shows its last few cards with a spread. | battlefield.js:732-751, 753-797 |
| Context restore | Keeps the scene, recreates the renderer and textures, and re-renders the retained snapshot | battlefield.js:1104-1145 |
| Teardown | Disposes the floor, placeholder and card geometries and materials, then clears the scene | battlefield.js:1452-1461 |
| Footer grid (portrait) | Two columns: the Opponent and Player panels share a 64 px row; piles 36 px, status 48 px, controls `reserve − 148px` (62 px). The rows add up to the 210 px reserve. | style.css:629-639; layout.js:31; hud.js:955 |
| Footer text | Labels 0.7rem at 62 % white; values 1rem bold; the phone status and warning 0.65rem | style.css:330-343, 700-705 |
| Footer panels | A shared border, a 64 % background and an 8 px backdrop blur. Panels do not clip overflow; `.game-feedback` scrolls (`overflow: auto`). | style.css:234-246, 345-355 |
| Footer markup | Each side panel has three metrics: "Source pile", "Draw pile" and "Won pile". Classic shows "—" for a side's source pile. The piles panel has "Contested pile" and "Burn pile". The status and warning are polite live regions. | hud.js:80-93, 133-150, 405-431, 1120-1126 |
| `:has()` | Already used for Campaign controls | style.css:426, 674-678 |
| Tests | Layout tests assert the `visuals` object and that the active deck is larger than the other piles. Battlefield tests assert active 1.75 / 1.4 and secondary 1.2 / 1.02, the 44 px target, and the decisive shrink to `secondaryPileScale`. No test checks the footer CSS. | layout.test.js:45-80; battlefield.test.js:725-1053 |

## 4. Acceptance traceability

| # | Criterion | Existing evidence | Gap | WP |
| --- | --- | --- | --- | --- |
| U1 | In each mode every pile is drawn at one scale; revealed cards stay larger | Separate active and secondary scales | `pileScale` | WP1, WP2, WP4 |
| U2 | The active deck stays identifiable and keeps a target of at least 44×44 CSS px | Size and tint; the 44 px minimum | A halo replaces the size cue | WP2, WP4 |
| U3 | In every mode, piles and reveals keep 0.08 world units apart and 0.05 from the world edge, and the halo never touches another card | None; today's anchors overlap (§2.3) | D4 anchors and an invariant test | WP1, WP4 |
| U4 | A settled card lands at the size of the pile it joins | The decisive card shrinks to the secondary scale, then pops when that pile is active | Retarget to `pileScale` | WP2, WP4 |
| F1 | At 344×882 with a 34 px inset, 344×720 and 320×480, every footer value lies inside its panel, no label wraps, and no footer block overflows or overlaps another | Values overflow by 21 px; six labels wrap; a 5 px overlap (§2.4) | D5 | WP3, WP5 |
| F2 | Footer labels and the status are at least 12 px in phone portrait | Labels 11.2 px; status 10.4 px | D5 | WP3, WP4 |
| F3 | Every status message fits, and the save warning and status fit together without scrolling | 17 px overflow with the warning | D5, D6 | WP3, WP5 |
| F4 | Footer controls keep 44 px targets | The 44 px CSS minimum (accessibility-baseline.test.js:12-21) | Re-check with less padding | WP3, WP5 |
| R1 | No regression in the header or in the landscape, tablet, desktop or letterboxed layouts | None | A browser matrix | WP5 |
| R2 | No domain, rule, event, save or RNG change | None | Review | WP7 |
| Docs | The roadmap evidence and the README fixture list describe the change | Milestone 14 evidence says layout "enlarge[s] active decks" | Amend | WP6 |

## 5. Decisions (proposed; see §10)

### D1. One pile scale per mode

**Change:** in every mode's `visuals`, replace `activeDeckScale` and
`secondaryPileScale` with one `pileScale`:

| Mode | `pileScale` | `revealScale` (unchanged) |
| --- | --- | --- |
| phone-portrait | 1.25 | 1.55 |
| phone-landscape | 1.1 | 1.4 |
| tablet | 1.3 | 1.75 |
| desktop | 1.3 | 1.75 |

`visualScale` (battlefield.js:400-410) returns `revealScale` for an in-flight reveal
and `pileScale` for everything else, including the decisive card once it uses the pile
scale mode. The scale covers every pile zone: the Classic source deck, the Campaign
source piles, the draw and won piles, Hold, and the contested and burn piles.

Assumption: "decks" means piles. Revealed cards are the clash itself, so they stay
larger (§10, question 1).

**Why:**

- It is what the report asks for. On the cover screen every pile becomes 54×75 CSS px,
  between today's 48×67 and 67×93 (§2.2).
- Each value is a round number at or just below the overlap-free limit for its mode
  with the D4 anchors (§2.3).
- Revealed cards keep their size, so the clash still reads first. That keeps the part of
  PR #24's hierarchy that separates the clash from the piles.

**Alternatives:**

- Today's secondary scale everywhere (1.12, 1.02, 1.2, 1.2). This needs fewer anchor
  changes, but the active deck shrinks by 27–31 % and every pile stays small.
- Today's active scale everywhere (1.55, 1.4, 1.75, 1.75). This needs a new layout; with
  the D4 anchors the limits are 1.32, 1.11, 1.35 and 1.32.
- Revealed cards at `pileScale` too. Every card would be one size, but the clash cards
  would shrink (67×93 to 54×75 on the cover screen), and so would the drop area for
  dragging (battlefield.js:512).

### D2. Active-deck halo

**Change:**

- Add one mesh, `battlefield-active-deck-halo`:
  - `PlaneGeometry(1.21, 1.61)`, the card plane plus a 0.08 ring
  - `MeshBasicMaterial({ color: 0x75eef5, transparent: true, opacity: 0.5,
    depthWrite: false })`. 0x75eef5 is the app's focus-outline colour (style.css:105,
    110, 422).
- `syncActiveDeckVisual` (:424-432) moves it into the active zone's group at local
  z 0.01. That is above the placeholder (z 0) and below the pile card (z ≥ 0.02, :747).
  The halo takes the `pileScale` and is visible only when the active zone has a card.
- `clearCardVisuals` (:666-676) hides it. `resize` (:1159) updates its scale where it
  moves the zone groups and reapplies appearance (:1188-1194).
- It is not part of the hit test. It stays in its zone while the top card is dragged
  (`scene.attach`, :577), marking where a rejected drop returns.
- Optionally, `renderCurrentFrame` (:960-965) pulses its opacity from `animationTime`,
  as it does for the placeholders. The animation loop stops when the game is paused or
  reduced motion is on, so the halo is then static.
- Keep the 0xd9fbff tint (:30, 412-422). Like the tint, the halo shows even while deck
  input is disabled or busy.
- Teardown disposes its geometry and material with the placeholders' (:1452-1461).
  Context restore keeps the scene (:1104-1145), so the halo survives and is re-placed by
  `renderSnapshotCards`.

**Why:** today the active deck stands out by size (about 1.4 times) and by a faint tint.
A uniform size removes the stronger cue. A ring in the focus colour is the app's
existing "this is actionable" signal. It adds only 0.08 × `pileScale` around the card,
which the D4 anchors leave room for (§2.3). The ring is about 4 CSS px on the cover
screen and 3 px in an Edge tab there.

**Alternatives:**

- The tint alone. This is the smallest change, but the active deck becomes hard to find.
- A wider 0.12 ring: about 6 px on the cover screen, and still clear of every card
  (smallest clearance 0.048, on tablet).
- Dim the halo while deck input is disabled, so it signals "tappable now" rather than
  "next to reveal".

### D3. Settlement scaling

**Change:** keep PR #30's rule that only the decisive card shrinks into its pile, and
retarget it from `secondaryPileScale` to `pileScale` (battlefield.js:828, 1202).

**Why:** PR #30 limited the shrink to the decisive card on purpose. Today the shrunken
card pops back to the active scale when it lands on the active pile; for example, the
player's won pile is active when it must be recycled. With one pile scale the card lands
at its final size.

**Alternatives:** every settling card shrinks to `pileScale`. This would remove the
size jump when non-decisive cards are re-rendered as pile cards, but it reverses
PR #30's choice.

### D4. Anchor changes

**Change:** all z values stay 0.2.

| Mode | Zone | Today | Proposed |
| --- | --- | --- | --- |
| phone-portrait | Hold | (2.75, −2.65) | (0.35, −4.1), between the player's draw and won piles |
| phone-portrait | contested / burn y | 0.85 / −0.85 | 1.0 / −1.0 |
| phone-landscape | Hold | (4.8, −2.1) | (2.2, −2.1), in the player's row, right of the reveal |
| tablet | Hold | (3.8, −2.45) | (2.5, −3.2), in the player's row |
| tablet | both won piles x | −1.1 | −1.5 |
| tablet | contested y | 0.95 | 1.05 |
| desktop | Hold | (4.7, −2.35) | (3.0, −2.65), in the player's row |
| desktop | both won piles x | −1.35 | −1.6 |
| desktop | contested / burn y | 0.9 / −0.9 | 1.0 / −1.0 |

Lines: layout.js:41, 48-49 (portrait); 64 (landscape); 87, 89, 93-94 (tablet); 110,
112, 116-118 (desktop).

**Why:**

- Hold is the main conflict in every mode (§2.3). Moving it into the player's row puts
  it next to the cards it exchanges with.
- The won piles move away from the reveal jitter, and the contested and burn piles move
  apart to open the gap that limits the scale.
- Every overlap in §2.3 is removed, and the invariant test (WP4) holds.

**Alternatives:** keep Hold in the right column and lower it. With the other D4 changes
this fits on tablet (y −3.0 to −3.5) and on desktop (y −3.0 only). It fits in neither
phone mode: the player's won pile blocks it in portrait and the world edge in landscape.
Hold would then sit in different places on phones and on larger screens.

### D5. Phone-portrait footer

**Change:** one full-width row per side. Every rule is scoped to phone portrait:

```css
.screen--game[data-layout-mode="phone-portrait"] .game-hud {
  grid-template:
    "header" var(--hud-header-reserve, 4.5rem)
    "comparison" var(--hud-comparison-reserve, 5rem)
    "." minmax(0, 1fr)
    "opponent" 42px
    "player" 42px
    "piles" 28px
    "status" 36px
    "controls" calc(var(--hud-footer-reserve, 210px) - 148px)
    / minmax(0, 1fr);
}

.screen--game[data-layout-mode="phone-portrait"] .zone-panel {
  display: grid;
  grid-template-columns: 4.5rem minmax(0, 1fr);
  align-items: center;
  column-gap: 0.4rem;
  padding: 0.15rem 0.55rem;
}

.screen--game[data-layout-mode="phone-portrait"] .zone-panel__title {
  margin: 0;
  font-size: 0.85rem;
}

.screen--game[data-layout-mode="phone-portrait"] .zone-panel .hud-metrics {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.4rem;
}

.screen--game[data-layout-mode="phone-portrait"]
  :is(.zone-panel, .hud-metrics--piles) .hud-metric {
  gap: 0;
}

.screen--game[data-layout-mode="phone-portrait"]
  :is(.zone-panel, .hud-metrics--piles) .hud-metric dt {
  font-size: 0.75rem;
  line-height: 1.2;
  white-space: nowrap;
}

.screen--game[data-layout-mode="phone-portrait"]
  :is(.zone-panel, .hud-metrics--piles) .hud-metric dd {
  font-size: 1rem;
  line-height: 1.2;
  font-variant-numeric: tabular-nums;
}

.screen--game[data-layout-mode="phone-portrait"] .hud-metrics--piles {
  align-items: center;
  padding-block: 0;
}

.screen--game[data-layout-mode="phone-portrait"] .hud-metrics--piles .hud-metric {
  display: flex;
  align-items: baseline;
  gap: 0.4rem;
}

.screen--game[data-layout-mode="phone-portrait"] .game-feedback {
  padding-block: 2px;
}

.screen--game[data-layout-mode="phone-portrait"] .game-status,
.screen--game[data-layout-mode="phone-portrait"] .game-save-warning {
  font-size: 0.75rem;
  line-height: 1.25;
}

.screen--game[data-layout-mode="phone-portrait"] .game-controls {
  gap: 4px;
  padding: 4px;
}
```

In style.css these become edits to the existing portrait rules (:629-639, 667-670,
681-698, 700-705) plus the new metric rules. The shared padding rule (:652-661) stays.

**Why:**

- A full-width row gives each metric 78 px at 344 px wide, against 50 px today, so every
  label fits on one line at 12 px (§2.4).
- The rows add up to the same 148 px before the controls, so the controls row (62 px)
  and the battlefield keep their size.
- Labels grow from 11.2 to 12 px and the status from 10.4 to 12 px. Values stay 16 px,
  with tabular numerals so counts do not shift as they change.
- The `:is(.zone-panel, .hud-metrics--piles)` scope leaves the header's
  `.hud-metrics--match` untouched (measured unchanged).
- Controls keep 44 px targets; with less padding, two-line labels still fit in 62 px.

**Alternatives:**

- A compact scoreboard: one Source / Draw / Won header row with Opponent and Player
  rows. It would save an estimated 20 px of height, but it changes the markup in hud.js
  and its tests.
- Short labels ("Src", "Draw", "Won") in today's two columns. These are harder to read
  and need full accessible names.
- A larger footer reserve. It costs battlefield height, which is already only 324 px in
  an Edge tab on the cover screen.

### D6. Save-warning state

**Change:**

```css
.screen--game[data-layout-mode="phone-portrait"]
  .game-hud:has(.game-save-warning:not([hidden])) .game-feedback {
  grid-row: piles-start / status-end;
  gap: 0;
  padding-block: 0;
}

.screen--game[data-layout-mode="phone-portrait"]
  .game-hud:has(.game-save-warning:not([hidden])) .hud-metrics--piles {
  visibility: hidden;
}
```

**Why:**

- The warning and a two-line status need up to about 60 px. With D5 alone they overflow
  the 36 px status row by up to 33 px; today they overflow by 17 px and scroll.
- A failed save is rare and important. Spanning the piles row (64 px together) fits
  both messages with no overflow at every portrait size (§2.5).
- The contested and burn piles stay visible on the battlefield, and their counts return
  when the warning clears. `visibility: hidden` keeps the grid stable.
- `visibility: hidden` also removes the two counts from the accessibility tree while the
  warning shows. Both live regions stay.

**Alternatives:**

- Keep today's behaviour: the feedback scrolls.
- Raise the footer reserve while the warning shows. That needs a layout change in
  layout.js and hud.js, and the battlefield would jump.
- Show the warning as a toast over the battlefield.

### D7. Phone-landscape status (optional)

**Change:** split the shared phone rule (style.css:700-705). In phone landscape:

- the status and warning become 0.75rem with line-height 1.25
- `.game-feedback` gets `padding-block: 0.25rem`
- `.game-controls` (:843-847) gets `padding-block: 3px`, so the controls block is 52 px
  tall, the height of its row.

**Why:** the cover screen in landscape (882×344) shares the 10.4 px status. Today its
feedback overflows 1 px and the controls overlap it by 2 px. With D7 both are 0 at
882×344, 844×390 and 640×360, and the status is 12 px on one line (§2.6).

**Alternatives:** leave landscape for a follow-up. Either way, 480×320 and the landscape
warning state still overflow (6–8 px; today 7–9 px).

### D8. Text scaling (deferred)

**Change:** none in this plan. The browser fixture reports the footer at a 115 % root
font size as information, without asserting it.

**Why:**

- The footer rows are fixed px, tied to the px reserves in layout.js. At 115 % the
  proposed footer overflows by 1–4 px (today 34 px), and at 130 % values are clipped
  (§2.7).
- It is unverified how Edge on Android applies its text-size setting to an installed
  PWA.
- A real fix derives the reserves from the root font size in layout.js and hud.js. That
  is a larger change.

**Alternatives:** do it now, with rem rows and reserves computed from the root font size
(`getComputedStyle(document.documentElement).fontSize`).

### D9. Scope and versions

**Change:**

- Presentation only: layout.js, battlefield.js, style.css, tests and docs.
- No domain, rule, event, save or RNG change, and no version bump (roadmap :11-15).
- Out of scope:
  - the header wraps ("P Source · O Source" and "Source deck")
  - the 0.65rem comparison details (style.css:818-823)
  - any hud.js markup change.

**Why:** the request is about deck sizes and the footer. The header needs its own design
work on the stage wording.

**Alternatives:** include the header, with a shorter stage value and labels in phone
portrait.

### D10. Delivery

**Change:** one PR for WP1–WP7.

**Why:** D1–D4 change the same battlefield tests. D5–D7 share the browser fixture. Both
halves are small.

**Alternatives:** two PRs, one for the battlefield (D1–D4) and one for the footer
(D5–D7). They are independent, so either order works.

## 6. Work packages

### WP1: Layout (D1, D4)

- layout.js `MODE_SPECS`:
  - `visuals` (:32-36, 55-59, 78-82, 101-105) become `{ pileScale, revealScale }` with
    the D1 values.
  - Zone anchors change as listed in D4.
- Export two constants from layout.js:
  - `CARD_SIZE = Object.freeze({ width: 1.05, height: 1.45 })`
  - `ACTIVE_DECK_HALO_RING = 0.08`

  battlefield.js (WP2) and the invariant test (WP4) then share one source of truth.
- The `visuals` copy (:317-319) uses a spread and needs no change.

Done when the layout tests (WP4) pass.

### WP2: Battlefield (D1–D3)

- `visualScale` (:400-410) reduces to two results after its null-layout guard:
  `revealScale` for a transient visual that is not in `PILE_SCALE_MODE`, and
  `pileScale` for everything else.
- `startTween` (:828) and the resize retarget (:1202) use `pileScale`.
- Build the placeholder and card geometries (:276, 296) from `CARD_SIZE`.
- Add the halo (D2):
  - create it next to the placeholders (:276-295)
  - add a `syncActiveDeckHalo()` helper, called from `syncActiveDeckVisual` (:424-432)
    and from `resize` (:1159) after the zone groups move (:1188-1194)
  - hide it in `clearCardVisuals` (:666-676)
  - optionally pulse it in `renderCurrentFrame` (:960-965)
  - dispose it at teardown (:1452-1461).
- Unchanged: `ACTIVE_DECK_COLOR`, the hit tests, the 44 px minimum and dragging.

Done when the battlefield tests (WP4) pass.

### WP3: Footer CSS (D5–D7)

Edit style.css as described in D5, D6 and D7:

- the portrait grid (:629-639)
- portrait controls (:667-670)
- the portrait panel, title, piles and feedback rules (:681-698)
- the status rule (:700-705), split by mode
- landscape controls (:843-847), for D7.

Done when the CSS guard test (WP4) and the browser fixture (WP5) pass.

### WP4: Unit tests

`tests/unit/layout.test.js`:

- :45-49: `visuals` deep-equals `{ pileScale: 1.3, revealScale: 1.75 }`.
- :53-80: drop the `activeDeckScale > secondaryPileScale` assertion and keep
  `revealScale > pileScale`. The world-fit check uses `pileScale`, and its active zones
  become every candidate: `sourceDeck`, `playerSourcePile`, `playerDrawPile`,
  `playerWonPile` and `hold`.
- New test: piles, reveals and the active-deck halo keep their clearance in every mode.
  - Use one viewport per mode; the world size is fixed per mode.
  - Check the Classic and Campaign zone sets separately.
  - Skip pairs that are never occupied together:
    - the Classic source deck and the Campaign zones
    - a Campaign side's source and draw piles. An encounter's draw piles start empty
      (campaign-machine.js:1106-1107). Supply starts from the source pile (:1130), and
      the draw pile fills only by recycling once the source is empty (:1200-1219).
      Nothing refills a source pile during an encounter; reveals only take from it.
  - Model the reveal jitter and the contested spread, with comments that point to
    battlefield.js:888-894 and 732-751.
  - Require 0.08 between boxes and 0.05 to the world edge. For each active candidate,
    require a non-negative clearance from its halo to every other card.

`tests/unit/battlefield.test.js`:

- :758, 827, 842 and 876-877: `secondaryPileScale` becomes `pileScale`. The midpoint
  assertion at :763 still holds.
- :884-1006: rename the test to say that piles share one scale. The source card
  (:911-912) and every other card (:945-946) are 1.3. After the resize to landscape
  (:960-961), and at :980 and :999, they are 1.1. Keep the tint assertions (:913, 947,
  981, 1000). Add halo assertions:
  - its parent is `battlefield-zone:sourceDeck`, then the player's draw pile, then the
    player's won pile
  - it is visible
  - its scale equals `pileScale`, including after the resize.
- :1008-1053, the 44 px target test: expected to pass unchanged.
- :1055-1144, dragging: the halo keeps its parent and position and stays visible during
  the drag and after the snap-back.
- :1369-1418, Campaign boundaries: the halo is hidden when there is no active zone.
- :395-464, quality rebuild: the halo joins the scene, hidden, at mount, so the
  scene-resource count (:419) goes from 4 to 6. Each resource is still disposed exactly
  once, at teardown.
- :465-609, context loss: after the restore, the halo is visible in the active zone.

`tests/unit/accessibility-baseline.test.js`: a new test reads `src/style.css` with the
`rule()` helper (:7-10) and simple regular expressions. It asserts:

- the portrait `.game-hud` rows are 42, 42, 28 and 36 px plus
  `calc(var(--hud-footer-reserve, 210px) - 148px)`, and 42 + 42 + 28 + 36 = 148
- the scoped `.hud-metric dt` rule has `white-space: nowrap` and at least 0.75rem
- the portrait status is at least 0.75rem
- the `:has(.game-save-warning:not([hidden]))` rule spans `piles-start / status-end`.

Done when `npm test` passes.

### WP5: Browser fixture

New files: `tests/browser/phone-hud-layout.html` and `.js`. The check is text-only,
under `npm run dev` (`.github/copilot-instructions.md`).

- Boot as `milestone-21-4-campaign.js` does: the in-memory repository (:258),
  `loadFixture` (:289) and `mountApp` (:295). Use
  `tests/fixtures/campaign-save-modifiers-v7.json`, then the Classic
  `tests/fixtures/run-save-v7.json`.
- Resize `#app` through this matrix:
  - 344×882 with a 34 px inset (`#app[data-pwa-inset] .battlefield { --safe-area-top:
    34px }`)
  - 344×720, 320×480, 300×450 (letterboxed), 390×844 and 412×915
  - 882×344, 844×390 and 640×360
  - 480×320 (reported only)
  - 690×829, 768×1024 and 1280×800.
- In phone portrait, assert:
  - no footer block or the header overflows (`scrollHeight ≤ clientHeight`)
  - every metric value lies inside its panel
  - no label wraps
  - no footer blocks overlap
  - labels and the status are at least 12 px
  - every control is at least 44×44 px.
- Measure the longest status messages (§2.5) by setting the status text temporarily,
  then restore it.
- Warning state: set `storage.failNextSave` and reveal once. Assert that the warning is
  visible and that, in portrait, the feedback does not overflow.
- In phone landscape, assert no overflow or overlap at 882×344, 844×390 and 640×360
  (D7). Report 480×320 and the landscape warning state without asserting them.
- On tablet and desktop, assert no footer overflow.
- At every size, assert exactly one `canvas` in `#app` and no relevant console errors,
  captured as `milestone-21-4-campaign.js` does (:79-88).
- Report the 115 % root-font-size results without asserting them (D8).
- Write the report to a `<pre>` outside the measured `#app`.

Done when the fixture reports success.

### WP6: Documentation

- `docs/IMPLEMENTATION_ROADMAP.md`: in the Milestone 14 acceptance evidence
  (:1108-1110), replace "enlarge active decks and revealed cards per responsive mode,
  keep secondary piles bounded" with "draw every pile at one bounded scale per
  responsive mode, enlarge revealed cards, mark the active deck with a tint and a
  focus-colour halo".
- `README.md`: after the Campaign manual verification section (:19-39), add a short
  paragraph on the phone HUD fixture and what it reports. The fixture covers Classic
  as well as Campaign.
- `docs/MILESTONES.md`: no change; this is not a milestone.
- This plan: fill in §11.

### WP7: Validation

1. Run `npm test` and `npm run build` under Node 24. Every test should pass, with only
   the existing chunk-size warning. Record the test count.
2. Run the phone HUD fixture and the existing fixtures that render the battlefield:
   `milestone-19-profile` at its four viewports and the 21.1–21.4 Campaign fixtures.
   All checks are text-only.
3. Ask the reporter to re-check on the Fold4 cover screen: the footer values, the
   halo, and Hold placement during a capture.
4. Review the PR with the `soulcard-code-review` skill.

## 7. Sequencing

1. **WP1 and WP2 together**, with their WP4 tests. The renamed keys break the
   battlefield until both land.
2. **WP3**, with the CSS guard test.
3. **WP5.**
4. **WP6**, then **WP7.**

`npm test` passes at the end of every step.

## 8. Risks

| # | Risk | Mitigation |
| --- | --- | --- |
| R1 | The active deck is less prominent, so players may lose track of where to tap | The halo in the focus colour, the tint and an optional pulse; the 44 px target is unchanged; §10, question 3 |
| R2 | The active card is smaller on phones (67×93 to 54×75 on the cover screen) | It stays above 44 px there, and the hit target keeps its 44 px minimum everywhere |
| R3 | Moving Hold changes the capture and release flight paths | The paths derive from anchors; battlefield tests read positions from `handle.layout.zones`; WP7 checks a capture on the device |
| R4 | Pile regressions in landscape, tablet or desktop | The invariant test covers every mode; the browser matrix covers each mode's HUD |
| R5 | The CSS rows drift from the 210 px reserve | The CSS guard test asserts the rows and the `calc()` |
| R6 | Large text: at 115 % the side panels overflow 1 px and the feedback 4 px | Deferred (D8); the fixture reports it |
| R7 | `:has()` support | Supported by current Chromium, Safari and Firefox, and already used (style.css:426, 674-678). Without it the warning state scrolls as it does today. |
| R8 | Letterboxed portrait (300×450) | Measured: no overflow; the smallest control is 46 px |
| R9 | Churn in the battlefield tests | Limited to the scale assertions listed in WP4; positions come from the layout |
| R10 | During a drag the halo marks an empty slot | It shows where a rejected drop returns; hiding it during drags is an alternative |
| R11 | Reverses PR #24's subordinate piles | Revealed cards still outrank piles; only the active deck's cue changes; §10, question 3 |
| R12 | Landscape problems remain at 480×320 and with the save warning | They exist today; D7 reduces them; the fixture reports them; follow-up |
| R13 | The halo is thin on small renders: about 2–2.5 px in phone landscape and 1 px at 320×480 | The tint remains; optional pulse; a 0.12 ring is the alternative (D2) |
| R14 | The invariant test's jitter and spread constants drift from battlefield.js | Comments point to the source lines; review checks them |

## 9. Definition of done

- [x] Every §4 criterion has passing evidence.
- [x] `npm test` and `npm run build` pass under Node 24, with only the existing
      chunk-size warning.
- [x] The phone HUD fixture passes across the matrix with one canvas and no relevant
      console errors, reported as text.
- [x] The existing battlefield and Campaign browser fixtures still pass.
- [x] The roadmap evidence and README are updated, and §11 is filled in.
- [x] Code review is complete with the `soulcard-code-review` skill.

## 10. Questions for sign-off

Each question names the default this plan assumes.

1. **What "decks" covers.** Every pile (source, draw, won, Hold, contested and burn),
   with revealed cards staying larger? Default: yes. The alternative also shrinks
   revealed cards to `pileScale` (D1).
2. **Scale.** 1.25, 1.1, 1.3 and 1.3? Default: yes. Alternatives: today's secondary
   scale, or the overlap-free maximum (1.32, 1.11, 1.35, 1.32).
3. **Active-deck cue.** The tint plus a 0.08 halo in focus cyan at about 50 % opacity,
   pulsing only when motion is allowed? Default: yes. Alternatives: the tint alone, a
   0.12 ring, or a halo dimmed while input is disabled.
4. **Settlement.** Only the decisive card shrinks, now to `pileScale` (D3)? Default:
   yes. The alternative shrinks every settling card.
5. **Hold position.** The D4 positions, with Hold in the player's row? Default: yes.
6. **Footer layout.** One full-width row per side (D5)? Default: yes. Alternatives: a
   compact scoreboard, or short labels in two columns.
7. **Warning state.** The feedback takes over the piles row while a save warning shows
   (D6)? Default: yes. Alternatives: keep scrolling, or a toast.
8. **Landscape.** Include D7? Default: yes.
9. **Text scaling.** Defer, and report 115 % in the fixture (D8)? Default: yes.
10. **Header and comparison text.** Out of scope, as a follow-up issue (D9)? Default:
    yes.
11. **Delivery.** One PR (D10)? Default: yes.

## 11. Implementation notes

Implemented with the recommended defaults, including D7. Domain, rules, saves, events,
and RNG are unchanged; no milestone completion state or version changed.

Differences from the proposal:

- The halo is static rather than pulsing (the pulse was optional). This keeps the cue
  visible without additional motion or frame work.
- Phone-landscape reveal anchors move from y ±1.1 to ±1.12. Including reveal jitter,
  ±1.1 leaves only 0.065 world units between the reveals; ±1.12 meets the required
  0.08 clearance. Reveal scale is unchanged.
- The browser fixture reports header overflow and asserts that it equals the previous
  two-column grid's overflow. The restored Campaign modifier fixture has longer header
  content than the measured route-1 fight: up to 25 px of existing header overflow.
  The header remains out of scope; its 72 px portrait reserve is unchanged.
- Physical control bounds allow 0.02 px of layout rounding in letterboxed mode;
  the CSS target remains 44 px. Classic's measured 43.989 px rounds to 44 px.

Automated evidence under Node 24:

- `npm test`: 498 passed, including signed-clearance helper coverage added after review.
- `npm run build`: passed; the existing large-chunk warning remains (785.81 kB).
- `phone-hud-layout.html`: 158 measurement cases across Classic and Campaign, including
  failed saves and long messages; no asserted footer overflow and no console errors.
- Existing milestone 19 and Campaign 21.1–21.4 browser checks completed, with preserved
  context-recovery state and no relevant console errors.
- Automated code/roadmap review found no significant issues. GitHub Copilot found that
  the original halo-clearance test accepted overlaps because its distance helper clamped
  axis gaps to zero. The helper now returns signed clearance and has overlapping,
  touching, and separated-box regression cases; halos require strictly positive gaps.

Large-text scaling, the header, the 480×320 landscape layout, and landscape save-warning
overflow remain explicitly deferred as described above. A real Fold4 device check is
still needed to confirm the perceived halo contrast and Hold placement; no screenshots
were generated for automated validation.

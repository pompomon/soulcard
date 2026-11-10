# Tarot card art in pixel and HD styles: implementation plan

Source: a user request to replace the card images with Tarot-inspired art in two styles,
a pixel-art deck and a prerendered HD deck, selectable in Settings.
Baseline: `main` at `62a939d`, after PR #44. Status: **approved** with every §10
default, and implementation is in progress (§11). This plan was prepared without
interactive answers. Each decision in §5 therefore states a recommended default with
its alternatives, and §10 lists the questions that were settled before implementation
started. The change is presentation-only and is not a roadmap milestone.
It belongs to the "multiple themes" expansion work that Milestone 21 keeps separate
(roadmap :1354-1356). Line anchors refer to `62a939d`.

## 1. Summary

Today the classic generator draws every card face and the back at runtime
(classic.js). The result is a cream card with red and black corner indices, numeric
pips, and geometric J, Q, and K faces. The theme registry and texture cache were built
to accept more themes (roadmap :712-720). Nothing else is registered, and no setting
chooses a theme.

This plan delivers:

1. **One Tarot design for both styles.** Cards get arched frames, decorative Roman
   numerals, the Tarot suit objects (Cups, Pentacles, Wands and Swords), and original
   Page, Queen, King and Ace art. Corner indices keep the familiar rank and ♠♥♦♣ glyphs
   in red and black. The art therefore agrees with the HUD's "10H" text and the rules
   (D3).
2. **Tarot (pixel), the new default.** Hand-pixeled art on a 75×105 grid ships as a
   small palette-indexed sprite module in the JS bundle. It is drawn synchronously, as
   classic is. It works offline from the first launch and has no loading state (D5,
   D7).
3. **Tarot (HD), an opt-in.** 53 prerendered 600×840 WebP images (an estimated 3–8 MB)
   download once into their own Cache Storage cache, which survives app updates. Cards
   appear at once from a low-resolution preview and sharpen when the full image
   decodes (D8).
4. **A "Card art" setting** in Settings → Graphics and animation, stored as
   `soulcard.settings.v1.cardArt`, with download progress, status and retry (D6, D11).
5. **Engine support.** An optional `refine` step for asynchronous themes in the
   registry and texture cache, live theme switching in the battlefield, and a 600×840
   texture cap for Tarot themes (D8, D9, D11).
6. **Build and service-worker changes.** The HD pack stays out of the app-shell
   precache, and cache cleanup no longer deletes it (D8).
7. **An art pipeline.** A shared composition spec, isolated tooling and recorded
   provenance keep the art original (D10).

Classic stays as the registry's internal fallback. Card IDs, rules, saves, events, RNG
and HUD text don't change, so `saveSchemaVersion`, `gameRulesVersion` and `eventVersion`
stay as they are (roadmap :11-15). Delivery takes three PRs, followed by art-only PRs
(D12).

## 2. Baseline evidence (Node 24.22.2)

- `npm test`: 498 pass, 0 fail, in about 28 s.
- `npm run build`: passes with 54 modules. JS is 785.81 kB (200.86 kB gzip) and CSS is
  16.21 kB. The existing warning about chunks over 500 kB is unchanged.
- The app-shell precache lists 9 files plus `./`, 902,590 bytes on disk.
- The working tree is clean at `62a939d`.

Method:

- **Card sizes.** A script outside the repository imported `createBattlefieldLayout`
  and `CARD_SIZE` (layout.js:28). A card's size is `CARD_SIZE` × `revealScale` or
  `pileScale`, multiplied by the CSS px per world unit at the card's depth. That value
  is `viewportHeight / (2 · (camera distance − z) · tan(fov / 2))`, with a 38° field of
  view (battlefield.js:266). Device px apply the largest render-scale cap, 2
  (settings.js:2; battlefield.js:1240).
- **Contrast.** WCAG 2 relative-luminance ratios.
- **Memory.** Arithmetic, not measurement. RGBA is 4 bytes per pixel, and mipmaps add
  a third.

### 2.1 Card sizes on screen

| Viewport (CSS px @ DPR) | Mode | Revealed card, CSS px | Revealed card, device px | Pile card, device px |
| --- | --- | --- | --- | --- |
| 320×480 @3 | phone portrait | 16×22 | 32×45 | 26×36 |
| 390×844 @3 | phone portrait | 67×92 | 133×184 | 107×148 |
| 412×915 @2.625 | phone portrait | 77×106 | 153×211 | 123×170 |
| 844×390 @3 | phone landscape | 41×57 | 82×114 | 64×89 |
| 768×1024 @2 | tablet | 91×125 | 181×251 | 134×186 |
| 1280×800 @1 | desktop | 118×162 | 118×162 | 87×120 |
| 1440×900 @2 | desktop | 139×192 | 279×385 | 206×284 |
| 1920×1080 @1 | desktop | 178×246 | 178×246 | 132×182 |
| 1920×1080 @2 | desktop | 178×246 | 357×493 | 264×364 |
| 1728×1117 @2 | desktop | 187×258 | 373×515 | 275×380 |
| 2560×1440 @2 | desktop | 257×355 | **514×709** | 379×523 |
| 3840×2160 @1 | desktop | 414×571 | 414×571 | 305×421 |

- The largest measured card is 514×709 device px, on a 5K display at 200 %. A 600×840
  texture covers every row without magnification, which is the basis for D9. Of the
  measured CSS viewports, only 3840×2160 at DPR 2 (an 8K display at 200 %) would
  exceed it, at 828×1142, where the texture is magnified about 1.4×.
- At the 320×480 minimum, a revealed card is 16×22 CSS px, and no art is legible at
  that size, classic included. The DOM HUD carries every card as text, and the canvas
  is `aria-hidden` (battlefield.js:1073-1074; hud.js:350). Legibility is therefore
  judged at 390×844 and larger.
- The pixel deck is 75 art pixels wide (D7), so one art pixel spans 1.8 device px at
  390×844, 3.7 at 1440×900, and 6.9 at 2560×1440.

### 2.2 Index contrast

| Foreground | Background | Ratio |
| --- | --- | --- |
| Red `#b42336` (classic) | Classic card `#fffdf7` | 6.38:1 |
| Dark `#18141f` (classic) | Classic card `#fffdf7` | 17.82:1 |
| Red `#b42336` | Parchment `#f2e6c9` | 5.24:1 |
| Dark `#18141f` | Parchment `#f2e6c9` | 14.62:1 |
| Red `#b42336` | Darker parchment `#ead9b0` | 4.65:1 (marginal) |
| Dark `#18141f` | Darker parchment `#ead9b0` | 12.99:1 |
| Gold `#d7bb72` | Night `#28204f` (classic back) | 7.97:1 |

Index plates must therefore be `#f2e6c9` or lighter.

### 2.3 Texture and bitmap memory (arithmetic)

| Item | Pixels | Memory |
| --- | --- | --- |
| One texture at scale 2 (classic or Tarot) | 600×840 | 2.02 MB canvas; about 2.69 MB on the GPU with mipmaps |
| One classic texture at scale 3 (`high`) | 900×1260 | 4.54 MB canvas; about 6.05 MB on the GPU |
| 24 cache entries at 600×840 | | 48.4 MB canvas; about 64.5 MB on the GPU |
| 24 cache entries at 900×1260 | | 108.9 MB canvas; about 145.2 MB on the GPU |
| HD preview atlas (D8) | 1200×1470 | 7.06 MB bitmap |
| HD back (D8) | 600×840 | 2.02 MB bitmap |
| One HD decode in flight | 600×840 | 2.02 MB, at most two at a time |
| All 53 HD images decoded at once (rejected) | | 106.8 MB |
| Pixel scratch canvas (D7) | 75×105 | 31.5 kB |

### 2.4 Texture generation

In one ordered headless sample, the 53 classic textures took 12.5 ms at scale 1 and
54.1 ms at scale 3. Cache entries and renderer textures stayed at the 24-entry bound
(MILESTONE_19_QA.md:82-88, 170-176). The QA notes say one sample can't establish a
ratio. These figures are context for WP11's profile, not targets.

## 3. What exists

| Area | Implementation | Evidence |
| --- | --- | --- |
| Theme registry | Separate front and back maps, with classic registered at construction. A descriptor must hold exactly `id` and `create` as enumerable data properties. `registerFront` and `registerBack` work after construction and throw on a duplicate ID. Missing, invalid or unknown IDs fall back to classic with an immutable `theme-fallback` diagnostic. There is no unregister. | registry.js:32-55, 102-133, 135-153, 159-181 |
| Classic theme | A 300×420 logical canvas at scale 1–4 (default 2). Transparent rounded corners (inset 4, radius 18). Mirrored corner indices with a 34 px rank and a 32 px suit in `#b42336` or `#18141f`. Numeric pips, geometric courts, and a symmetric night-and-gold back with an "S". | classic.js:3-13, 21-50, 79-104, 124-164, 250-348 |
| Texture cache | Calls `create()` synchronously once per (kind, theme, card, scale) key and checks only that the canvas has positive integer dimensions. Textures are sRGB with trilinear mipmaps and anisotropy. The LRU bound never evicts leased entries. `invalidateTheme` disposes one theme's entries, even leased ones. `getStats` reports six fields. | texture-cache.js:69-71, 116-130, 144-150, 152-210, 235-276, 310-325 |
| Battlefield themes | Options `themeRegistry`, `themeSelection` and `textureCacheFactory`. The selection is resolved once at mount into a `const`. 24 cache entries; texture scale 1, 2 or 3 by quality. `refreshVisualTextures` re-leases every visual, which quality changes use. Card materials are transparent and double-sided. | battlefield.js:27, 34-38, 226-263, 644-683, 706-725 |
| Rendering | The loop runs only when motion is allowed and the battlefield isn't paused; otherwise single frames render on demand. | battlefield.js:988-1020 |
| Context recovery | Destroys and recreates the texture cache, then re-renders the retained snapshot | battlefield.js:1132-1172 |
| Settings reaction | A quality change refreshes textures and rebuilds the renderer. While the context isn't ready, the new settings are only recorded. | battlefield.js:1280-1294 |
| Reveal timing | Revealed cards appear face-up in place and dwell for `revealMs` 400 ms at 1× speed. Cards are always upright. | event-player.js:5-9; battlefield.js:934-950 |
| Card identity and text | IDs are `c-<rank><suit>` in suit-major order. HUD labels and Campaign text use rank and suit letters, such as "10H". | cards.js:1-28; hud.js:1305; campaign-view.js:32-35 |
| Settings | Five fields with defaults and validation. One localStorage key per field under `soulcard.settings.v1`, with a per-field fallback for malformed values. The controller and the Settings screen each assert an explicit setter list. Select fields sit under "Graphics and animation". | settings.js:1-82; settings-repository.js:8-16, 47-98; settings-controller.js:19-35; menus.js:13-21, 52-73, 222-393 |
| Screens | Main, Settings and Game, with one mounted at a time. Bootstrap owns the settings controller and passes `mountBattlefield` to the Game screen. | screen-coordinator.js:1, 49; bootstrap.js:109-137, 259-276; hud.js:310, 961 |
| Service worker | Shell, runtime and active-marker caches per revision. Shell URLs are served from the shell cache for any destination. The runtime cache takes only image, font and audio destinations and keeps 32 entries. Install and activation cleanup delete every unpreserved `soulcard-` cache. Without an active marker, any unknown `soulcard-` cache is taken as a legacy shell. | sw.js:1-27, 54-94, 96-113, 115-149, 166-200 |
| Build plugin | Precaches every emitted file except index.html and sw.js, and hashes their content into the revision | vite.config.js:8-15, 21-65 |
| Tests that pin shapes | `getStats` deep-equal (texture-cache.test.js:80); storage keys deep-equal (settings-repository.test.js:31); "five semantic controls" (settings-screen.test.js:63); extra descriptor keys rejected (theme-registry.test.js:162-190); shell assets (pwa-build.test.js:72); cache cleanup (service-worker.test.js:237-372); texture profile (milestone-19-profile.js:132-150) | as listed |

## 4. Acceptance traceability

| # | Criterion | Existing evidence | Gap | WP |
| --- | --- | --- | --- | --- |
| A1 | Settings offers exactly two card-art options, Tarot (pixel) and Tarot (HD). The choice persists per device, and a malformed value falls back to pixel. | Five persisted settings with per-field fallback | `cardArt` field and select | WP8, WP10 |
| A2 | New and existing players see Tarot (pixel) by default, offline from the first launch, with no loading state | The synchronous classic generator | Pixel sprites and renderer | WP2 |
| A3 | Both decks draw all 52 canonical cards and a back. Card IDs, rules, saves, events and RNG are unchanged. | An alternate fixture theme works without domain edits (roadmap :1020-1021, 1031-1032) | Tarot themes | WP1, WP2, WP7 |
| A4 | Corner indices show the rank and ♠♥♦♣ in red or black, mirrored, with glyphs at least 28 logical px tall (WP11 compares this with classic's measured ink heights) and at least 4.5:1 contrast | Classic's 34 px rank and 32 px suit baseline (roadmap :1025-1027) | Composition and contract tests | WP1, WP2, WP4 |
| A5 | HD downloads only after the player selects it. It reports progress, can be retried, and leaves pixel in use until it is verified and ready. | None | Store, controller and UI | WP6, WP8, WP10 |
| A6 | Once downloaded, HD works offline and survives app updates. An art revision downloads only the changed files. | Cleanup deletes every unknown `soulcard-` cache | Art cache, service-worker exclusions, pruning | WP5, WP6 |
| A7 | The app shell doesn't grow by the HD pack, and the lazily loaded HD code is precached | Every emitted file is precached | Build exclusion | WP5 |
| A8 | Texture memory stays bounded: at most 24 cache entries and 600×840 per Tarot texture. HD never decodes the whole deck at once. | The 24-entry LRU (MILESTONE_19_QA.md:82-88) | Cap and decode limiter | WP2, WP3, WP7, WP11 |
| A9 | A card is never blank. HD shows a preview at once and sharpens without changing size. A failure keeps the preview or falls back to pixel. | None | Refinement and fallback | WP3, WP7, WP8 |
| A10 | Changing the art, or HD becoming ready mid-game, updates visible cards without a remount, including after context loss and under reduced motion | The quality-change refresh path | `themeSource` | WP9 |
| A11 | Download status and progress are announced politely, and new controls keep 44×44 px targets | The Settings status pattern (menus.js:355-361); the 44 px baseline (accessibility-baseline.test.js:12) | UI | WP10 |
| A12 | All art is original, with recorded provenance, and no third-party deck images | Roadmap :139 | Provenance record and test | WP1, WP4 |
| A13 | Validation is text-only, with no screenshots | `.github/copilot-instructions.md` | Fixture | WP11, WP13 |
| Docs | README and roadmap describe the themes and the art cache | README says generated textures never enter Cache Storage and every obsolete Soulcard cache is removed (README.md:199-206) | Amend | WP12 |

## 5. Decisions (proposed; see §10)

### D1. A visual skin over unchanged card identities

**Change:** Tarot art changes how the 52 canonical cards and the back look, and nothing
else. Card IDs (`c-<rank><suit>`), deck order, comparisons, rules, saves, committed
events, RNG, HUD text and Campaign text stay as they are.

**Why:**

- The roadmap asks for themes that save IDs, not textures, and that work "without
  modifying card or match state" (:714-720).
- Expansion work must not undermine deterministic saves or zone invariants
  (:1358-1359), and Three.js callbacks must not mutate game state or draw RNG
  (:295-298).
- The rules have no trumps, so the Major Arcana have no role.

**Alternatives:** a 78-card Tarot ruleset with trumps. That needs a new ruleset, a
`gameRulesVersion`, a save migration and new AI, so it is out of scope.

### D2. Keep the playing-card shape

**Change:** keep `CARD_SIZE` at 1.05×1.45 and the 300×420 logical canvas, with classic's
transparent rounded silhouette (inset 4, radius 18). The Tarot look comes from the
inside: a narrow border, an arched art window and a numeral cartouche.

**Why:**

- Tarot cards are about 1:1.71; these are 1:1.38. A taller card would change every
  layout clearance that PR #44 verified, and phone landscape is already tight: piles
  fit without overlap only up to scale 1.11 (PHONE_VISUALS_IMPLEMENTATION_PLAN.md:129
  and D1).
- Hit targets, the active-deck halo and the layout tests stay valid.

**Alternatives:** true Tarot proportions, which need a new layout pass in every mode.

### D3. Tarot art with familiar indices

**Change:**

| Playing-card suit | Tarot suit in the art | Index glyph and colour |
| --- | --- | --- |
| Hearts (H) | Cups | ♥ in red `#b42336` |
| Diamonds (D) | Pentacles | ♦ in red `#b42336` |
| Clubs (C) | Wands | ♣ in dark `#18141f` |
| Spades (S) | Swords | ♠ in dark `#18141f` |

- **2–10:** countable suit objects with a decorative Roman numeral (II–X).
- **J, Q and K** become the Page, the Queen and the King, each an original figure. The
  Tarot Knight is dropped, since the deck has three court ranks.
- **A** is the Ace: one large emblem.
- **Corner indices** keep the Arabic rank or J, Q, K or A and the standard suit glyph,
  mirrored top-left and bottom-right, as on classic.
- **The back** is rotationally symmetric: a night sky with gold and the existing "S"
  monogram.

**Why:**

- These are the conventional pairings of the Latin Tarot suits with the French
  playing-card suits, so the deck reads as Tarot without a new mapping to learn.
- Players read values from the indices, and the HUD and Campaign screens say "10H"
  (hud.js:1305; campaign-view.js:32-35). With ♥♦♣♠ in the indices, art and text agree
  without copy changes.
- The roadmap requires legible mirrored indices and red and black suits (:716-718).
- Sun, moon and star motifs from the Major Arcana may decorate the back and the Aces.
- The art may follow long-public-domain traditions, such as the Marseille pattern's
  suit objects. It must not trace or copy any specific deck, because the roadmap
  excludes third-party card artwork (:139).

**Alternatives:**

- Tarot glyphs in the indices and Tarot names in the HUD, such as "10 of Cups". This
  is more immersive, but every player must learn the mapping, the HUD and Campaign copy
  and tests change, and small cup, coin, wand and sword glyphs are harder to tell apart
  than ♠♥♦♣.
- French suits in the art as well, in a Tarot Nouveau style. This has less Tarot
  character.

### D4. Exactly two options for the player

**Change:** Settings offers "Tarot (pixel)" and "Tarot (HD)". Classic stays registered
as the fallback for unknown or invalid IDs (registry.js:122-153) and in tests, but isn't
offered.

**Why:** the request is to replace the card images and offer two Tarot styles.

**Alternatives:** keep Classic as a third option. It costs one more option value, since
classic already exists (§10, question 2).

### D5. Tarot (pixel) by default

**Change:** `cardArt` defaults to `tarot-pixel`. Existing players see the pixel deck
after the update; HD needs an explicit choice.

**Why:** the pixel deck ships in the JS bundle. It works offline from the first launch,
needs no download, and uses no more texture memory than classic (D9).

**Alternatives:** HD by default. Every install would then download 3–8 MB and still show
pixel cards until the download finishes.

### D6. The `cardArt` setting

**Change:**

- settings.js: `CARD_ART_OPTIONS = ['tarot-pixel', 'tarot-hd']`,
  `DEFAULT_SETTINGS.cardArt = 'tarot-pixel'`, a `cardArt` case in `isSettingValue`, and
  the field in `createSettingsPreferences`.
- settings-repository.js: the key `soulcard.settings.v1.cardArt` and `setCardArt`.
- settings-controller.js and menus.js: `setCardArt` in the asserted method lists, and a
  setter.
- The setting stores an option ID. `src/app/card-art.js` maps it to the theme IDs
  `tarot-pixel-front-v1` and `tarot-pixel-back-v1`, or `tarot-hd-front-v1` and
  `tarot-hd-back-v1`.

**Why:**

- Each setting is its own localStorage key, and a missing or malformed value falls back
  per field (settings-repository.js:47-62). A new key changes no existing key, and older
  builds ignore it, so the `v1` namespace stays.
- Milestone 12 requires a future selection feature to store IDs, not image data
  (roadmap :1033-1035). An option ID does that. It also stays valid when a later art
  revision ships `-v2` themes. Storing two theme IDs would allow mismatched pairs and
  need a settings migration for every art revision.
- Saves don't record a theme, so resuming a run is unaffected.
- Theme IDs carry a version suffix, so each art revision is separately versioned, as
  Milestone 21 asks (roadmap :1358).

**Alternatives:**

- Store `cardFrontThemeId` and `cardBackThemeId`, a more literal reading of :1033-1035.
- Store the choice per run in the save. That needs a schema bump, so it is rejected.

### D7. The pixel deck: synchronous sprites in the bundle

**Change:**

- **Grid.** Each card is 75×105 art pixels, exactly a quarter of the 300×420 logical
  canvas. One shared palette has at most 32 colours plus transparency. There is no
  anti-aliasing, outlines are hard 1 px lines, and dithering appears only in
  backgrounds, never in indices.
- **Components.** Indexed PNGs in `art/tarot-pixel/`:
  - the card frame, with stepped rounded corners and an arched window
  - 5×7 rank glyphs (2–9, 10, J, Q, K and A) and 7×7 suit glyphs
  - four pip sprites (about 9×9) and four Ace emblems
  - twelve court figures (about 41×70)
  - the back (75×105, 180° symmetric).
- **Packer.** `tools/card-art/pack-pixel.mjs` uses Node built-ins only (`node:zlib` for
  PNG decoding). It checks palettes and sizes, then writes
  `src/presentation/themes/tarot-pixel-sprites.js`: the palette plus run-length-encoded
  sprites, marked as generated.
- **Runtime.** `src/presentation/themes/tarot-pixel.js`:
  - `renderTarotPixelFront(cardId)` and `renderTarotPixelBack()` are pure. They compose
    the frame, numeral, pips or figure, and mirrored indices into a 75×105 RGBA buffer.
  - `create()` copies the buffer into one reused 75×105 scratch canvas with
    `putImageData`. It then draws it onto the final canvas with
    `imageSmoothingEnabled = false`, scaled by 4 × the capped scale (D9).
  - The cache's linear-mipmap sampler then smooths minification, so the sampler
    contract doesn't change.
- **Index size.** Rank and suit glyphs are 7 art pixels tall, or 28 logical px. Classic
  draws its rank with a 34 px font (an estimated cap height of 24 px) and its suit
  with a 32 px font.
- **Pip size.** Pips are smaller than classic's 57 px pip glyphs so that ten fit in the
  window. Players read values from the indices and numerals.

**Why:**

- `create()` is synchronous, as classic's is. There is no loading or failure state, no
  flash of classic at startup, and offline play works from the first launch, because
  the JS is precached.
- The pure renderer can be tested pixel by pixel in Node without a canvas.
- The deck stays small: an estimated 20–60 kB, or 8–20 kB gzip, because the module
  stores components, not 53 bitmaps.
- The art is authored for the grid. Automatically pixelating painted art turns muddy at
  75×105. A quantize pass may seed sprites for hand clean-up, but it can't replace it.

**Alternatives:**

- A precached indexed-PNG atlas: 8×7 cells of 77×107 with 1 px gutters, 616×749 in all,
  an estimated 20–90 kB, decoded at start with `createImageBitmap`. Artists could hand
  over whole cards, but the deck would need async loading, a startup race and a decode
  failure state.
- Pixel art drawn from code alone, with no sprites. The figures would be weak.
- A per-theme `NearestFilter` sampler for magnification. Upscaled edges would be
  crisper, but cards would shimmer while moving, and the registry and cache contracts
  would change.

### D8. The HD deck: a prerendered pack, an opt-in download, progressive refinement

**Change:**

*Assets.* 53 images at 600×840 in WebP at quality about 82, in
`src/assets/card-art/tarot-hd/`:

- the fronts, `tarot-hd-art-c-2S.webp` and so on
- the back, `tarot-hd-art-back.webp`
- `tarot-hd-art-preview.webp`, a 1200×1470 atlas of 150×210 cells: 8 columns in
  `CARD_IDS` order, with the back last.

A generated module, `src/presentation/themes/tarot-hd-assets.js`, lists each file as
`{ id, url, bytes, sha256 }`, where `url` comes from a static
`new URL('…', import.meta.url)` literal. Vite emits the files with content hashes. The
estimated total of 3–8 MB is measured and gated in WP4.

*Delivery.* The pack isn't part of the app shell (WP5).
`src/persistence/art-pack-store.js` downloads it on request into one Cache Storage
cache, `soulcard-art-tarot-hd`, which persists across app revisions:

- It downloads with the page's `fetch()`, whose empty destination bypasses the service
  worker's runtime cache (sw.js:123-129). At most four requests are in flight, progress
  is counted in bytes, and an `AbortController` cancels.
- Before `cache.put`, it checks `response.ok`, an `image/webp` content type, the byte
  length and the SHA-256 digest (SubtleCrypto).
- `inspect()` compares `cache.keys()` with the manifest. After a complete download,
  `prune()` deletes entries that the manifest no longer lists, such as files from an
  older art revision.
- A `QuotaExceededError` becomes a `quota` failure. `navigator.storage.estimate()` is
  an optional pre-check.
- Where Cache Storage is missing or throws, as in some private modes, an in-memory,
  session-only store takes its place.

*Runtime.* `src/presentation/themes/tarot-hd.js` is loaded with a dynamic `import()`.
Its front and back descriptors are registered once and delegate to the current
activation, because the registry has no unregister and throws on a duplicate ID
(registry.js:102-115).

- Activation decodes the preview atlas and the back with `createImageBitmap`, about
  9.1 MB of bitmaps in total.
- `create()` synchronously draws the card's preview cell, smoothed, into the final
  canvas (at most 600×840; D9). A card is never blank, and its index is legible from
  the first frame.
- `refine(cardId, { scale, canvas, signal })` reads the full image from the store and
  decodes it, with at most two decodes at a time. If `signal.aborted` isn't set, it
  draws the image into the same canvas with high-quality smoothing, then closes the
  bitmap. The texture cache then flags the texture for upload (WP3).
- The back is drawn from its full-size bitmap and needs no refinement.
- If the HD resources were released, `create()` draws the pixel card instead of
  throwing.

**Why:**

- Cards need at most 514×709 device px (§2.1). Current browsers decode WebP with
  `createImageBitmap`.
- Precaching 3–8 MB in the shell would download the pack on every install and again on
  every app update, because the shell cache is per revision (sw.js:3, 43-52). A
  dedicated cache downloads it once, by choice, and survives updates. Content-hashed
  URLs and pruning handle art revisions.
- ADR-005 keeps only application assets in Cache Storage (roadmap :93-103, 620-624).
  The pack is a build output served from the app's own origin, so the download adds
  no third-party request.
- Decoding all 53 images at full size would hold about 107 MB. Refining card by card
  holds at most two 2 MB decodes at once, and texture memory stays within the 24-entry
  cache.
- three.js r186 allocates immutable texture storage on the first upload
  (`WebGLTextures.js:947-1014`). Refinement therefore redraws into the same canvas at
  the same size instead of replacing it.
- A reveal dwells for 400 ms at 1× speed (event-player.js:5-9). WP11 profiles refine
  latency against that rather than assuming it.

**Alternatives:**

- A placeholder drawn in code (parchment, frame and index) instead of the preview atlas.
  It saves 7 MB of bitmap memory and an estimated 0.2–0.4 MB of download, but the art
  pops in instead of sharpening.
- The pixel card as the HD placeholder. Every new card would flash in the other style.
- Synchronous `HTMLImageElement` draws, which need every image decoded in advance.
- KTX2 or Basis compressed textures, which add a transcoder dependency. three is the
  only runtime dependency today.
- AVIF, which is smaller but slower to decode and less widely supported.
- Prefetching full images for the cards about to be revealed, since the renderer sees
  deck order in snapshots. This is a follow-up only if profiling shows visible pop-in.

### D9. A 600×840 texture cap for Tarot themes

**Change:** Tarot `create()` uses `min(scale, 2)`. That gives 300×420 at `low` and
600×840 at `balanced` and `high`. Classic doesn't change.

**Why:**

- 600×840 exceeds the largest measured card (514×709), and HD sources are 600×840, so
  scale 3 adds nothing visible.
- At 24 entries, the cap saves about 60 MB of canvas memory and 80 MB of GPU memory
  compared with classic at `high` (§2.3).

**Alternatives:** honour scale 3. Only the pixel deck's upscaled edges would get
sharper.

### D10. Art production: one composition, two renditions, original art

**Change:**

- `src/presentation/themes/tarot-composition.js` is pure data. For every card ID it
  gives the Tarot suit, the numeral, a pip layout in normalized window coordinates,
  the figure or emblem ID, and the index colour. The pixel runtime and the HD tooling
  both read it, so both decks share pip counts, numerals and index positions.
- **Pixel sources** are indexed PNG components, packed by the D7 packer.
- **HD sources** are SVG components: the frame, numerals, suit objects, figures and back.
  - `tools/card-art/` composes them per card and has its own `package.json`, with
    `@resvg/resvg-js` to rasterize at 1200×1680 and `sharp` to downsample to 600×840
    and encode WebP and the preview.
  - Painted figures may replace SVG figures as raster layers.
  - The root `package.json`, CI and the runtime don't change. Outputs and the manifest
    are committed.
- **Provenance.** `art/provenance.json` lists every source file with its author, date,
  licence and tool.
  - Text is converted to outlines, or uses an OFL font with its licence vendored.
  - No existing Tarot deck is traced or bundled.
  - Tool-assisted or generated imagery needs the same record and licence review as
    commissioned art.
- **Placeholder art first.** Early PRs may ship simple geometric art that meets the
  contract tests. Finished art follows in art-only PRs.

Art direction (recorded in `art/README.md`):

| Element | Direction |
| --- | --- |
| Ground | Parchment `#f2e6c9` (indices: 5.24:1 red, 14.62:1 dark) |
| Frame | A night `#28204f` outer line, a gold `#d7bb72` inner rule, an arched window and a numeral cartouche at the top |
| Cups | Chalices; accent `#2f6f8f` |
| Pentacles | Coins bearing a five-pointed star or a rosette; accent `#c08a2e` |
| Wands | Budding staves; accent `#4f7a3a` |
| Swords | Straight blades; accent `#8a93a6` |
| Pips 2–10 | Countable, non-overlapping suit objects in the window, with II–X in the cartouche |
| Courts | Full-length original figures: the Page standing, the Queen seated, the King enthroned, each holding the suit object, in a palette shared per suit |
| Aces | One large emblem in a radiant mandorla. The cartouche shows a small sun, not "I", because an Ace outranks a King. |
| Back | Night `#28204f` with a gold `#d7bb72` sun, moon and stars and the "S" monogram, 180° symmetric |
| Indices | `#b42336` or `#18141f` on parchment, at least 4.5:1, never over art |

Accent colours are illustration only and never carry rank or suit.

**Alternatives:** render the HD pack in a headless browser page instead of with resvg and
sharp. That needs no native dependencies, but it is slower and harder to make
deterministic.

### D11. Live switching and the Settings UI

**Change:**

- **Card-art controller.** `createCardArtController` lives in
  `src/ui/card-art-controller.js`; option mapping and labels live in
  `src/app/card-art.js`. Bootstrap creates it after the settings controller and destroys
  it with it.
  - It owns a theme registry: the classic fallback, the pixel themes registered at
    creation, and the HD themes, registered on first activation before the effective
    selection changes to them.
  - It subscribes to settings. Its snapshot is
    `{ requested, effective: { frontThemeId, backThemeId }, hd: { status, loadedBytes, totalBytes, reason, sessionOnly } }`.
  - HD states run `idle` → `checking` → `downloading` → `preparing` → `ready`. The
    others are `offline` (retried on the `online` event), `paused` (Save-Data at
    startup) and `failed`, with the reason `network`, `integrity`, `quota`, `decode` or
    `unsupported`.
  - The effective selection stays pixel until HD is `ready`. A later read miss falls
    back to pixel and checks the pack again.
  - Switching back to pixel aborts any download (completed files stay). Once
    subscribers have switched, it closes the HD bitmaps.
  - At startup, a complete pack activates HD with no network.
- **Battlefield.** A new `themeSource` option, `{ getSelection(), subscribe(listener) }`,
  can't be combined with `themeSelection`.
  - `selectedThemes` becomes mutable. On a change, if the context is ready, the
    battlefield calls `refreshVisualTextures()`, calls `invalidateTheme()` for the
    previous IDs, and renders. Otherwise the restore path picks up the new selection.
  - The cache factory receives `onTextureUpdate`. When the loop isn't running, it
    renders one frame, at most once per animation frame.
- **Bootstrap** binds `themeRegistry` and `themeSource` into the `mountBattlefield` it
  passes to the Game screen (bootstrap.js:267-276). The integration tests already wrap
  it this way (tests/integration/context-recovery.test.js:280-290). hud.js doesn't change.
- **Settings.** The "Graphics and animation" section (menus.js:283) gains a first
  field and a status block:
  - a "Card art" select with Tarot (pixel) and Tarot (HD)
  - a hint: "HD downloads about 5.1 MB once and then works offline. Suits: Cups ♥,
    Pentacles ♦, Wands ♣, Swords ♠." The size comes from the manifest; 5.1 MB here
    and in the status copy is an example.
  - a status line (`role="status"`, polite, atomic)
  - a native `<progress>` named "HD card art download"
  - Retry and "Remove HD download" buttons, with 44×44 px targets. Remove appears only
    while pixel is selected and HD files are stored.

  The status updates on each state change and at most every 25 % of progress.

Status copy:

| State | Status text |
| --- | --- |
| Pixel selected | Pixel card art is in use. |
| Checking | Checking HD card art… |
| Downloading | Downloading HD card art: 2.3 of 5.1 MB. Pixel card art is in use until it finishes. |
| Preparing | Preparing HD card art… |
| Ready | HD card art is ready and works offline. |
| Ready, session only | HD card art is in use for this session only. It downloads again next time. |
| Offline | Connect to the internet to download HD card art. Pixel card art is in use. |
| Paused (Save-Data) | Data saver is on. Select Retry to download HD card art. |
| Quota | There isn't enough storage for HD card art. Pixel card art is in use. |
| Network or integrity failure | HD card art couldn't be downloaded. Pixel card art is in use. |
| Decode failure | HD card art couldn't be loaded. Pixel card art is in use. |
| Unsupported | This browser can't show HD card art. Pixel card art is in use. |

**Why:**

- Settings and Game are never mounted together (screen-coordinator.js), so most changes
  apply on the next Game mount. Live switching covers an HD download that finishes
  while the player is in Game, and HD activating at startup. It reuses the refresh path
  that quality changes take (battlefield.js:1288-1290).
- Binding in bootstrap leaves the Game screen and its tests unchanged.

**Alternatives:**

- Apply a finished download only on the next Game entry. The battlefield would need no
  change beyond the mount-time selection, but a game in progress would stay on pixel.
- A separate card-art screen. The roadmap fixes three top-level screens (:124).

### D12. Three PRs

1. **PR1, the pixel deck.** WP1, WP2, and bootstrap binding with a fixed pixel
   selection. It replaces classic for everyone; there is no setting yet.
2. **PR2, HD infrastructure without UI.** WP3–WP7.
3. **PR3, the setting and UI.** WP8–WP12.

Art-only PRs follow, gated by the WP2 and WP4 contract tests.

**Why:** art binaries, the service worker and settings each need separate review.

**Alternatives:** one PR, which is too large; or two PRs, with all HD work in one.

## 6. Work packages

### WP1: Composition spec and art direction (D3, D10)

- `src/presentation/themes/tarot-composition.js`: the suit mapping, a frozen composition
  per card ID, pip layouts and numerals.
- `art/README.md` holds the art direction (D10), grid specs, palette and export rules.
  `art/provenance.json` holds the provenance record.
- `tests/unit/tarot-composition.test.js`:
  - every `CARD_IDS` entry has a composition
  - the suit mapping is as D3 states
  - ranks 2–10 have numerals II–X and exactly as many pips as their rank
  - pip boxes lie inside the window and don't overlap
  - courts and Aces have figure IDs
  - index colours follow red (H, D) and dark (S, C)
  - index colours reach at least 4.5:1 on the ground colour
  - index boxes are at least 28 logical px tall.

Done when the tests pass.

### WP2: The pixel deck (D7, D9)

- Components in `art/tarot-pixel/`; placeholders first.
- `tools/card-art/pack-pixel.mjs`, using Node built-ins only:
  - decodes 8-bit indexed or RGBA, non-interlaced PNGs
  - checks for at most 32 colours plus transparency, and the component sizes
  - run-length encodes the sprites
  - writes `tarot-pixel-sprites.js` with a "generated; do not edit" header.
- `src/presentation/themes/tarot-pixel.js`:
  - the theme IDs
  - `renderTarotPixelFront` and `renderTarotPixelBack`
  - descriptors whose `create` follows classic's argument checks and canvas factory
    (classic.js:79-104). Move that factory into a shared `themes/canvas.js`.
  - the D9 cap.
- PR1 wiring:
  - `src/app/card-art.js` creates a registry with the pixel themes.
  - Bootstrap binds that registry and a fixed pixel `themeSelection` into
    `mountBattlefield`.
- `tests/unit/tarot-pixel-theme.test.js`:
  - every card and the back render a deterministic 75×105 buffer with transparent
    corners and palette colours only
  - rank and suit glyph pixels sit top-left, and their exact 180° rotation sits
    bottom-right, in the suit's index colour
  - index glyphs are 7 art pixels (28 logical px) tall
  - pip placements match the composition
  - the back is 180° symmetric
  - with a recording canvas (classic-theme.test.js:15-99), `create()` makes 300×420
    at scale 1 and 600×840 at scales 2–4, disables smoothing before `drawImage`, and
    rejects invalid IDs, scales and factories as classic does
  - drift check: packing `art/tarot-pixel/` with the packer's functions reproduces the
    committed module byte for byte.
- `tests/unit/bootstrap.test.js`: the battlefield receives the pixel registry and
  selection.
- `tests/browser/milestone-19-profile.js` (:132-150): time the 53 pixel textures at
  scales 1–3, alongside classic.

Done when the tests and the profile pass, and the pixel module's gzip size is
recorded.

### WP3: Refinement support in the registry and texture cache (D8)

- registry.js:
  - `assertDescriptor` (:32-55) also accepts an optional `refine` function. Keys must
    be exactly `id` and `create`, or `id`, `create` and `refine`.
  - `register` (:102-115) copies `refine` into the frozen record when it is present.
- texture-cache.js:
  - New optional `onTextureUpdate` and `onDiagnostic` functions.
  - `createEntry` (:161-210): after `entries.set`, start refinement if the descriptor
    has `refine`.
    - Store an `AbortController` on the entry, then call `refine` asynchronously with
      `{ scale, canvas, signal }`. A front also passes the card ID first.
    - On success, if the entry is still current and not aborted, set
      `texture.needsUpdate = true` and call
      `onTextureUpdate({ kind, themeId, cardId, scale })`.
    - On a failure that isn't an abort, emit
      `{ type: 'texture-refine-failed', kind, themeId, cardId, reason }` and keep the
      drawn image.
  - `disposeEntry` (:116-130) aborts before clearing.
  - `getStats` (:310-325) adds `refining`.
- `tests/unit/theme-registry.test.js` (:162-190): `refine` is accepted, while a
  non-function `refine` and other extra keys are rejected.
- `tests/unit/texture-cache.test.js`:
  - :80 deep-equal gains `refining: 0`.
  - Success marks one upload and notifies once, with the same canvas object and
    dimensions.
  - Eviction, `invalidateTheme`, `clear` and `destroy` abort refinement and suppress
    notification.
  - A rejection emits one diagnostic, and the entry stays usable.
  - A throwing `onTextureUpdate` or `onDiagnostic` doesn't break the cache.
  - Without `refine`, behaviour is unchanged.

Done when the tests pass.

### WP4: The HD art pack (D8, D10)

- `tools/card-art/package.json` and its lockfile; `build-hd.mjs`:
  - reads the composition and the SVG components in `art/tarot-hd/`
  - rasterizes each card at 1200×1680, downsamples to 600×840 (Lanczos) and encodes
    WebP at quality about 82
  - encodes the preview atlas at quality about 75
  - decodes each output and fails if sampled index-plate colours drift from the
    composition's index and ground colours
  - writes `tarot-hd-assets.js` in `CARD_IDS` order, then the back and the preview,
    with static `new URL()` literals, byte counts and hex SHA-256 digests.
- Commit the outputs under `src/assets/card-art/tarot-hd/`.
- `tests/unit/tarot-hd-assets.test.js`, with no dependencies:
  - the manifest lists 52 fronts, the back and the preview
  - every file exists, and its size and SHA-256 match
  - the RIFF `WEBP` header and its `VP8 `, `VP8L` or `VP8X` chunk give 600×840 for
    cards and the back, and 1200×1470 for the preview
  - the total is within the budget (8 MB; §10, question 7)
  - file names match `tarot-hd-art-*.webp`
  - every source file appears in `art/provenance.json`.
- `art/README.md` documents regeneration with `npm --prefix tools/card-art ci` and
  `npm --prefix tools/card-art run build:hd`.

Done when the contract test passes and the pack size is recorded.

### WP5: Build and service worker (D8)

- vite.config.js:
  - Drop `/^assets\/tarot-hd-art-[^/]+\.webp$/` from `emittedFiles` (:32-34). Those
    files are then neither precached nor hashed into the revision. The manifest module
    carries their content hashes, and it is hashed.
  - Set `build.assetsInlineLimit` to a function that never inlines files under
    `src/assets/card-art/`.
  - The lazily loaded HD chunk stays precached, so HD keeps working offline.
- public/sw.js:
  - Add `const ART_CACHE_PREFIX = \`${CACHE_PREFIX}art-\``.
  - Exclude it from the legacy predicate (:59-66), install deletion (:89-93) and
    activation deletion (:107-111).
  - sw.js is a static file and can't import, so art-pack-store.js repeats the prefix.
    A test asserts the two values match.
- `tests/unit/pwa-build.test.js` (:72): the fake bundle gains an HD WebP under
  `assets/` and a `tarot-hd-*.js` chunk. The WebP is absent from `BUILD_ASSETS` and
  doesn't change the revision; the chunk is present.
- `tests/unit/service-worker.test.js`:
  - activation keeps `soulcard-art-tarot-hd` (next to :237)
  - install keeps it when a marker exists (:292)
  - in a markerless upgrade, the art cache is neither deleted nor taken as the legacy
    cache (:321, :348)
  - a page `fetch` of an HD URL with an empty destination isn't intercepted (:393).

Done when the tests and `npm run build` pass, and the built `sw.js` lists no HD art.

### WP6: The art-pack store (D8)

- `src/persistence/art-pack-store.js`:
  - `createArtPackStore({ manifest, cacheName, caches, fetch, digest, concurrency })`
    returns `{ inspect(), download({ signal, onProgress }), read(id), prune(), clear(),
    persistent }`, with the D8 behaviour.
- `tests/unit/art-pack-store.test.js`, with fake `caches`, `fetch` and `digest`:
  - inspection of complete and incomplete packs
  - a download writes only verified files, reports monotonic progress, stays within the
    concurrency bound, and skips files already present
  - an abort leaves no partial entry
  - an HTTP error maps to `network`; a wrong type, size or digest maps to `integrity`;
    `QuotaExceededError` maps to `quota`
  - `prune()` removes only keys the manifest doesn't list, and only after completion
  - `clear()` deletes the cache
  - without `caches`, the store is session-only.

Done when the tests pass.

### WP7: The HD theme (D8, D9)

- `src/presentation/themes/tarot-hd.js` exports
  `createTarotHdThemes({ decode, fallbackFront, fallbackBack })`. It returns stable
  `frontTheme` and `backTheme` descriptors plus `activate({ store, manifest, signal })`
  and `release()`. It implements the decode limiter of two, preview drawing,
  refinement, the back, the D9 cap and the post-release fallback.
- `tests/unit/tarot-hd-theme.test.js`, with a fake decoder and a recording canvas:
  - preview cells follow `CARD_IDS` order in 8 columns
  - canvas sizes follow the scale
  - refinement draws into the same canvas and closes every bitmap
  - an aborted refinement draws nothing
  - no more than two decodes run at once
  - a read miss rejects with a typed error
  - after `release()`, `create()` draws the pixel card and refinement resolves
    without drawing
  - the same descriptors work again after a second `activate()`.

Done when the tests pass.

### WP8: The setting and the card-art controller (D6, D11)

- The settings files listed in D6.
- `src/app/card-art.js` and `src/ui/card-art-controller.js`, as D11 describes.
- bootstrap.js:
  - create the controller after the settings controller (:135)
  - destroy it on every path that destroys the settings controller (:146, 167, 290,
    323)
  - bind it into `mountBattlefield` and pass it to `createSettingsScreen`
  - accept a `cardArtControllerFactory` option for tests.
- Tests:
  - settings-repository.test.js: the :31 key deep-equal, plus loading, saving and
    malformed values for `cardArt`
  - settings-controller.test.js: `setCardArt` validation, persistence and
    notification
  - `tests/unit/card-art-controller.test.js`, with a fake store, theme loader,
    `online` event and Save-Data:
    - every state transition
    - HD descriptors are registered once, before the first HD selection is published
    - pixel stays effective until HD is ready
    - switching back aborts the download
    - bitmaps are released only after notification
    - a read miss falls back to pixel
    - `destroy()`
  - bootstrap.test.js: the controller's lifecycle on the success and failure paths.

Done when the tests pass.

### WP9: Live switching in the battlefield (D11)

- battlefield.js:
  - validate `themeSource` in the style of `assertThemeRegistry` (:70-82) and reject it
    alongside `themeSelection`
  - `selectedThemes` (:260-263) becomes `let`
  - subscribe as D11 describes. `invalidateTheme` disposes entries even while they
    are leased (texture-cache.js:263-276). It therefore runs only after
    `refreshVisualTextures` (:675-683) has moved the lease of every static and
    transient visual, and only if a cache exists. Neither path touches game state or
    RNG.
  - `ensureTextureCache` (:644-654) passes `onTextureUpdate`
  - unsubscribe at teardown, next to :1472.
- `tests/unit/battlefield.test.js`:
  - the initial selection comes from the source
  - a change while ready re-leases every visual with the new IDs before invalidating
    the previous theme, and renders once
  - an unchanged selection does nothing
  - a change during context loss applies after the restore
  - under reduced motion, `onTextureUpdate` renders exactly one frame; while the loop
    runs, it adds none
  - a switch with the largest visible set stays within 24 entries, as quality changes
    do today
  - teardown unsubscribes.

Done when the tests pass.

### WP10: The Settings UI (D11)

- menus.js:
  - `createSettingsScreen({ onBack, settingsController, cardArt })` renders the D11
    fields
  - it subscribes to `cardArt` and unsubscribes on teardown
  - without `cardArt`, the select still works and the status block stays hidden.
- style.css: progress and status styles in the settings block, reusing the existing
  button classes for 44 px targets.
- `tests/unit/settings-screen.test.js`:
  - six controls (:63)
  - the select reflects and sets `cardArt`
  - status text for each state, and progress values
  - Retry and Remove call the controller
  - labels, `role="status"` and the progress name
  - teardown unsubscribes.

Done when the tests pass.

### WP11: Browser fixture and profile (text-only)

- New `tests/browser/card-art.html` and `.js`, run under `npm run dev`. Boot as the
  21.x fixtures do, and wrap `textureCacheFactory` to record the theme ID of each
  acquisition.
  1. Default: Game acquires only `tarot-pixel-*` textures.
  2. Choose HD in Settings: progress reaches 100 %, the status says ready, and the art
     cache holds 54 verified entries.
  3. Return to Game: acquisitions switch to `tarot-hd-*`. Report refine latency (p50,
     p95, maximum) against `revealMs`, and keep cache entries at 24 or fewer.
  4. Reload with network emulation offline: HD activates from the cache.
  5. Switch back to pixel: refinement count returns to 0.

  At every step, assert one `canvas` in `#app` and no relevant console errors. Write a
  text report.
- Report classic's rank and suit ink heights from `measureText` bounding boxes in
  classic's fonts, to confirm that the 28 px Tarot index glyphs are no smaller (A4).
- `milestone-19-profile.js`: add HD preview and refine timings, heap observations, the
  pixel module's gzip size, the HD pack size and the precache size.

Done when the fixture reports success.

### WP12: Documentation

- README.md, "Texture cache ownership" (:50-62): refinement and `onTextureUpdate`.
- README.md, "Offline cache and updates" (:197-216): the HD art cache, its survival
  across revisions, and the fact that generated textures still never enter Cache
  Storage.
- IMPLEMENTATION_ROADMAP.md, Milestone 21 (:1351-1360): a short note that the Tarot
  themes exist, linking this plan. No milestone state changes.
- MILESTONES.md: no change; this isn't a milestone.
- This plan: fill in §11.

Done when README and the roadmap describe the Tarot themes and the art cache, and §11
records the outcome.

### WP13: Validation

1. Run `npm test` and `npm run build` under Node 24. Record the test count, the JS and
   precache size changes, and the HD pack size.
2. Run the card-art fixture, then `milestone-19-profile` at its four viewports,
   `phone-hud-layout`, and the 21.x Campaign fixtures. All checks are text-only.
3. If possible, check HD download, offline relaunch and pop-in on a physical Android
   Chrome device, and on iOS Safari, reporting in text.
4. Review each PR with the `soulcard-code-review` skill.

Done when every §9 item is checked.

## 7. Sequencing

1. **PR1:** WP1, then WP2.
2. **PR2:** WP3, then WP4 and WP5 (independent), then WP6, then WP7.
3. **PR3:** WP8, then WP9 and WP10 (independent), then WP11 and WP12.
4. **WP13** for each PR, and art-only PRs after PR1 (pixel) or PR2 (HD).

`npm test` passes at the end of every step.

## 8. Risks

| # | Risk | Mitigation |
| --- | --- | --- |
| R1 | HD memory on low-end phones | Bitmaps are bounded: preview 7.1 MB, back 2.0 MB, and at most two 2 MB decodes. Textures stay within 24 entries of at most 600×840. WP11 records the heap. The code-drawn placeholder (D8) saves 7 MB. |
| R2 | Pop-in while refinement finishes during a reveal | The preview keeps the style. Latency is profiled against the 400 ms dwell. Prefetching is a follow-up. |
| R3 | Eviction, cleared site data, or a rollback to a build whose worker lacks the exclusion removes the pack | Inspect at start, fall back to pixel, and download again when online. Saves are in IndexedDB, not in the pack. |
| R4 | Quota or private mode | A `quota` failure state; a session-only store |
| R5 | Offline when HD is selected | Pixel stays, the status explains, and the download retries on `online` |
| R6 | Cache cleanup deletes the pack, or takes it as the legacy shell in a markerless upgrade | WP5 exclusions and tests |
| R7 | HD files get precached (3–8 MB on every update), or the HD chunk gets excluded | The exclusion matches `.webp` names only, and pwa-build tests check both |
| R8 | Immutable GPU texture storage | Same-size redraws; a test asserts unchanged canvas dimensions |
| R9 | Legibility on small screens | 28 px index glyphs checked against classic's measured ink heights (WP11), a parchment ground at 4.5:1 or better, and canonical HUD text; the canvas is `aria-hidden` |
| R10 | Pixel art softens when minified (1.8 device px per art pixel at 390×844) | Accepted. Nearest-neighbour upscaling then mipmaps; the quality setting; the Nearest-sampler alternative (D7) |
| R11 | Art effort: 12 courts, 4 Aces, a back, suit objects, frames and glyphs, in two styles | Placeholders first, contract tests, art-only PRs |
| R12 | Licensing | Original art only, the provenance record, and a test that every source is listed |
| R13 | Repository growth of 3–8 MB per HD art revision | Batch art revisions. Git LFS is an alternative, but the Pages workflow would need `lfs: true`. |
| R14 | Browser support for WebP decoding, `createImageBitmap` and Cache Storage | Feature detection leads to `unsupported` or session-only, with pixel in use |
| R15 | Bundle growth | The pixel module is about 8–20 kB gzip, and HD code is lazy. WP13 measures both. |
| R16 | Test churn | The shape-pinning tests are listed in §3. New parameters are optional, and the Game screen doesn't change. |
| R17 | An art update leaves the pack incomplete, so pixel shows until the changed files download | Usually seconds. Serving stale per-card art in the meantime is an alternative. |
| R18 | Players are confused by Tarot suits | Familiar indices and the suit legend in Settings |

## 9. Definition of done

- [ ] Every §4 criterion has passing evidence.
- [ ] `npm test` and `npm run build` pass under Node 24 with only the existing
      chunk-size warning. Bundle, precache and HD pack sizes are recorded.
- [ ] The pixel and HD contract tests pass, and the provenance record is complete.
- [ ] The card-art fixture passes as a text report: pixel default, HD download,
      offline relaunch, switching, bounded textures, one canvas and no relevant console
      errors.
- [ ] The existing browser fixtures still pass.
- [ ] README and the roadmap note are updated, and §11 is filled in.
- [ ] Each PR is reviewed with the `soulcard-code-review` skill.
- [ ] Accessibility and privacy reviews are done before release (roadmap :1360).

## 10. Questions for sign-off

Each question names the default this plan assumes. The plan was approved with every
default.

1. **Default style.** Tarot (pixel) (D5)? Default: yes. The alternative is HD.
2. **Classic.** Keep it only as the internal fallback (D4)? Default: yes. The
   alternative offers it as a third option.
3. **Who makes the final art?** Default: placeholder art in PR1–PR3, then commissioned
   or in-house art under the provenance rules (D10).
4. **Indices and HUD text.** Keep ♠♥♦♣ and "10H" (D3)? Default: yes. The alternative
   uses Tarot glyphs and names.
5. **Suit mapping.** Hearts to Cups, Diamonds to Pentacles, Clubs to Wands and Spades
   to Swords (D3)? Default: yes.
6. **Texture cap.** 600×840 at `high` (D9)? Default: yes.
7. **Size budgets.** At most 8 MB for the HD pack and 25 kB gzip for the pixel module?
   Default: yes.
8. **Storage.** Keep HD files when the player switches back to pixel, with a "Remove HD
   download" button (D11)? Default: yes.
9. **Live switching.** Apply HD as soon as it is ready, even mid-game (D11)? Default:
   yes. The alternative waits for the next Game entry.
10. **Persistent storage.** Don't call `navigator.storage.persist()`? Default: yes.
11. **Delivery.** Three PRs (D12)? Default: yes.

## 11. Implementation notes

### PR1: the pixel deck (WP1, WP2)

- **Composition.** `tarot-composition.js` holds the shared composition and
  `TAROT_MAX_TEXTURE_SCALE`. Classic's canvas helpers moved to `themes/canvas.js`
  without behaviour changes.
- **Art.** Instead of geometric placeholders, PR1 ships first-pass original art for
  every component: 46 PNGs and a 31-colour palette in `art/tarot-pixel/`.
  - Pentacles bear a five-pointed star.
  - `rank-10` is 7×7, so its two digits fit the index box.
  - `art/README.md` records the art direction and export rules.
  - `art/provenance.json` lists every file, and `art-provenance.test.js` enforces
    the list.
  - Art-only PRs may still refine the art.
- **Size.** The generated module is 29,406 bytes, or 5,977 bytes gzip, against the
  25 kB budget.
  - The JS bundle grew from 785.81 kB (200.86 kB gzip) to 821.13 kB (210.25 kB gzip).
  - The precache grew from 902,590 to 937,909 bytes.
  - `npm test` grew from 498 to 529 tests.
- **Profile.** `milestone-19-profile` in headless Chrome 156 timed 53 textures:
  - pixel: 42 ms at scale 1, 75 ms at scale 2 and 103 ms at scale 3
  - classic: 148 ms at scale 1 and 225 ms at scale 3
  - Context recovery preserved state, and the console warnings matched `main`.
- **Legibility (A4).** In Chrome, Tarot rank and suit ink is 28 logical px tall.
  - Classic's rank ink measured 23–29 px; its 29 px Q includes the tail.
  - Classic's suit ink measured 16.5–26 px.
  - WP11 adds this comparison to the card-art fixture.
- **Wiring.** Bootstrap binds the card-art registry and a fixed pixel selection into
  every Game battlefield, and classic stays the registry fallback.

### PR2: HD infrastructure (WP3–WP7)

- **Scope.** PR2 adds the HD pack, its store and its theme, but no setting or UI.
  Nothing imports `tarot-hd.js` yet. The shipped app changes only through the
  refinement support, the service worker's art-cache exclusion and the build's inline
  limit. PR3 wires the rest in.
- **Art.** 46 original SVG components in `art/tarot-hd/`. `art/provenance.json` lists
  them (93 records in total), and `art/README.md` documents them.
  - `hd-compose.mjs` checks every component against an element and attribute
    allow-list before composing.
  - Any `url()` value must reference a local ID, which blocks external references
    such as `clip-path="url(http://…)"`.
- **Pack (WP4).** 54 files: 52 fronts and the back at 600×840, plus the 1200×1470
  preview.
  - They total 1,025,826 bytes, against the 3–8 MB estimate and the 8 MB budget.
    Fronts are 10.9–25.0 kB each (871.4 kB in total), the back is 26.4 kB and the
    preview 128.0 kB.
  - resvg rasterizes at 1200×1680. sharp downsamples with Lanczos3 and encodes WebP
    at quality 82 (75 for the preview), with lossless alpha and effort 6.
  - The index-plate check is clip-aware. The worst measured values are 3.8 off-line,
    0.15 overshoot, 6.9 ink drift, 1.8 ground drift and 5.20:1 contrast.
  - The back must match itself rotated 180°: a mean difference of at most 0.05, and at
    most 16 pixels that differ by more than 32. With sharp the measured values are
    0.0064 and 2 pixels; Chrome's decoder gives 4 pixels.
  - `TAROT_HD_SOURCE_SHA256` digests the components, the composition and layout
    modules, the tool scripts and the lockfile. `tarot-hd-assets.test.js` recomputes
    it, so a source edit without `build:hd` fails `npm test`.
  - libwebp output can vary by platform, so `check:hd`'s byte comparison holds only
    on one platform. The source digest is the portable check.
  - `HD_PACK_BUDGET_BYTES` lives in `hd-compose.mjs`, because tests can't import
    `build-hd.mjs`: it loads sharp and resvg.
- **Build (WP5).** A probe build that dynamically imported the HD modules did the
  following:
  - It emitted all 54 `tarot-hd-art-*.webp` files with content hashes and inlined
    none.
  - Its `sw.js` listed the `tarot-hd-*.js` chunk (4.53 kB, 2.04 kB gzip) and the
    `tarot-hd-assets-*.js` chunk (9.94 kB, 3.34 kB gzip), and no HD art.
- **Store (WP6).** The store adds two things to the WP6 signature:
  - an injectable `storage` for the `estimate()` pre-check
  - a `totalBytes` getter for progress.

  Cache keys append `soulcard-sha256=<digest>` to the URL, so a revised file never
  matches a stale entry. The failure codes are `network`, `integrity`, `quota`,
  `unsupported` and `missing`.
- **Theme (WP7).**
  - `activate()` uses the manifest only to check IDs and their order. The images
    come from the store.
  - A later `activate()` or `release()` supersedes an activation in flight, which
    then rejects with an `AbortError`. A failed re-activation keeps the previous one.
  - Only the front descriptor has `refine`. The back draws from its full bitmap.
  - Read and decode failures become a `TarotHdArtError` with code `missing` or
    `decode`. The texture cache reports the code as the diagnostic's `reason`.
- **Size.**
  - Vite reports that the JS bundle grew from 821.13 kB (210.25 kB gzip) to
    822.55 kB (210.66 kB gzip).
  - Summing the `BUILD_ASSETS` files in `dist`, the precache grew from 938,832 to
    940,253 bytes. PR1's head was re-measured with this method.
  - `npm test` grew from 529 to 570 tests.
- **Browser (text-only).** On the Vite dev server in headless Chrome:
  - All 54 files are served as `image/webp`, and their sizes and SHA-256 digests match
    the manifest.
  - Activation took 48 ms. The first refinement of `c-QH` took 20 ms, with one
    `onTextureUpdate` and no diagnostics.
  - In a 56×56 index sample, pixels matching the ink colour rose from 58 in the
    preview to 596 after refinement.
  - A Classic game still renders the pixel deck: `#app` contains a canvas, and the
    console shows no errors.

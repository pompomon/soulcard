# Card art sources

This directory holds the editable sources for Soulcard's Tarot-inspired card
decks. The design is in [`docs/TAROT_CARD_ART_PLAN.md`](../docs/TAROT_CARD_ART_PLAN.md).
Both decks render the same shared composition from
`src/presentation/themes/tarot-composition.js`: suits, numerals, pip layouts,
figures and index positions.

Every file here must appear in [`provenance.json`](provenance.json) with its
author, date, licence and tool. `tests/unit/art-provenance.test.js` enforces this.

## Art direction

| Element | Direction |
| --- | --- |
| Ground | Parchment `#f2e6c9` (indices: 5.24:1 red, 14.62:1 dark) |
| Frame | A night `#28204f` outer line, a gold `#d7bb72` inner rule, an arched window and a numeral cartouche at the top |
| Cups (♥) | Chalices; accent `#2f6f8f` |
| Pentacles (♦) | Coins bearing a five-pointed star; accent `#c08a2e` |
| Wands (♣) | Budding staves; accent `#4f7a3a` |
| Swords (♠) | Straight blades; accent `#8a93a6` |
| Pips 2–10 | Countable, non-overlapping suit objects in the window, with II–X in the cartouche |
| Courts | Full-length original figures: the Page standing, the Queen seated, the King enthroned, each holding the suit object, in a palette shared per suit |
| Aces | One large emblem in a radiant mandorla. The cartouche shows a small sun, not "I", because an Ace outranks a King. |
| Back | Night `#28204f` with a gold `#d7bb72` sun, moon and stars and the "S" monogram, 180° symmetric |
| Indices | `#b42336` or `#18141f` on parchment, at least 4.5:1, never over art |

Accent colours are illustration only. Rank and suit are always carried by the
indices.

The art is original. Don't trace, copy or bundle any existing Tarot deck.
Tool-assisted or generated imagery needs the same provenance record and licence
review as commissioned art.

## Pixel deck: `tarot-pixel/`

Each card is a 75×105 grid of art pixels. One art pixel is 4×4 logical px on the
300×420 card canvas, and the runtime upscales it without smoothing.

### Palette

[`tarot-pixel/palette.json`](tarot-pixel/palette.json) lists at most 32 colours.
Each colour has a single-letter key that the generated module uses, and `.` is
transparent. The packer rejects any pixel that isn't fully transparent or one of
these colours exactly.

### Components

| Component | Size | Notes |
| --- | --- | --- |
| `frame` | 75×105 | Stepped corners, gold rule, arched window, empty cartouche |
| `back` | 75×105 | Must be identical after a 180° turn |
| `rank-2` … `rank-9`, `rank-J`, `rank-Q`, `rank-K`, `rank-A` | 5×7 | Drawn in any ink; the runtime recolours them to the index colour |
| `rank-10` | 7×7 | Two digits need the full index box |
| `suit-S`, `suit-H`, `suit-D`, `suit-C` | 7×7 | Recoloured like the ranks |
| `numeral-I`, `numeral-V`, `numeral-X` | 3×5, 5×5, 5×5 | Gold; composed with 1 px gaps |
| `cartouche-sun` | 5×5 | The Ace's cartouche mark |
| `title-page`, `title-queen`, `title-king` | 15×5, 20×5, 16×5 | Court titles |
| `pip-cups`, `pip-pentacles`, `pip-wands`, `pip-swords` | 9×9 | Drawn on the window's vellum |
| `ace-<suit>` | up to 41×79 | Centred in the window |
| `page-<suit>`, `queen-<suit>`, `king-<suit>` | up to 41×79 | Standing on the window sill |

The window starts at art pixel (17, 16). Figure pixels must stay inside the arch:
pixel (x, y) is inside when `isInsideTarotWindow((x + 0.5) * 4, (y + 0.5) * 4)`
holds. The rank and suit indices sit in the 7×7 boxes at (6, 6) and (6, 14), and
the runtime draws their 180° copy at the bottom right.

Courts share a palette per suit:

| Suit | Robe | Robe light | Robe deep | Cloak | Cloak light |
| --- | --- | --- | --- | --- | --- |
| Cups | `B` | `b` | `U` | `C` | `c` |
| Pentacles | `T` | `t` | `H` | `W` | `w` |
| Wands | `O` | `o` | `C` | `Z` | `W` |
| Swords | `V` | `v` | `D` | `S` | `s` |

### Export rules

- PNG, 8-bit indexed or RGBA, non-interlaced.
- Alpha is 0 or 255 only; no anti-aliasing. Hard 1 px outlines.
- Dithering only in backgrounds, never in indices.
- File names are exactly the component names above, with `.png`.

### Regenerating the runtime module

The runtime reads `src/presentation/themes/tarot-pixel-sprites.js`, a generated
module of run-length-encoded sprites. After changing any file in `tarot-pixel/`,
run:

```sh
node tools/card-art/pack-pixel.mjs
```

`node tools/card-art/pack-pixel.mjs --check` reports whether the module is up to
date. `tests/unit/tarot-pixel-packer.test.js` fails when it isn't, and
`tests/unit/tarot-pixel-theme.test.js` checks the composed cards.

## HD deck: `tarot-hd/`

Each HD card is composed from SVG components on the 300×420 logical card,
rendered at 1200×1680, downsampled to 600×840 and encoded as WebP. The game
downloads the pack only when the player chooses the HD deck.

### Components

| Component | viewBox | Notes |
| --- | --- | --- |
| `frame` | 300×420 | Border, gold rule, window vellum and cartouche plate; transparent outside the rounded corners |
| `back` | 300×420 | Must look the same after a 180° turn |
| `rank-2` … `rank-10`, `rank-J`, `rank-Q`, `rank-K`, `rank-A` | 28×28 | Index ink (see below) |
| `suit-S`, `suit-H`, `suit-D`, `suit-C` | 28×28 | Index ink |
| `numeral-I`, `numeral-V`, `numeral-X` | 7×18, 14×18, 14×18 | Gold; composed with 1.5 px gaps |
| `cartouche-sun` | 28×28 | The Ace's cartouche mark |
| `title-page`, `title-queen`, `title-king` | 44×16, 56×16, 42×16 | Court titles drawn as shapes |
| `pip-cups`, `pip-pentacles`, `pip-wands`, `pip-swords` | 36×36 | Placed in the composition's pip boxes |
| `ace-<suit>`, `page-<suit>`, `queen-<suit>`, `king-<suit>` | 164×316 | Fill the window box, (68, 64) on the card |

The composer centres cartouche content inside the cartouche's 4 px border, the
84×28 box at (108, 24). It clips window art to the arch, which springs 48 px
below the top of the window. It draws the indices last, with their 180° copy.

### Authoring rules

`tools/card-art/hd-compose.mjs` checks every component before composing it:

- One `<svg>` root with `xmlns` and exactly the `viewBox` above. `width` and
  `height` are optional and must match it.
- Only `g`, `defs`, `path`, `rect`, `circle`, `ellipse`, `line`, `polyline`,
  `polygon`, `linearGradient`, `radialGradient`, `stop` and `clipPath`. No text,
  images, `use`, styles, scripts, entities or external references.
- Colours are `#rrggbb`, `none`, or `url(#id)` for a gradient or clip path in the
  same file. IDs are unique within a file; the composer prefixes them per
  placement.
- Index ink paints only with `currentColor`, with no opacity, gradients or
  clipping, so the composer can apply the index colour.

### Regenerating the pack

The pack tools need native packages that the game doesn't, so they have their
own lockfile in `tools/card-art/`. After changing any file in `tarot-hd/`, the
composer or the shared composition, run:

```sh
npm --prefix tools/card-art ci
npm --prefix tools/card-art run build:hd
```

`build:hd` renders every card and the back with resvg, downsamples them with
sharp (Lanczos 3) and encodes WebP at quality 82, and the 1200×1470 preview
atlas at quality 75. Before writing anything, it checks:

- the index plates: every pixel of the lossless render lies between the
  parchment and the index colour, and the decoded WebP keeps both colours within
  tolerance and at least 4.5:1 contrast
- the back: its mean difference from its 180° rotation is at most 0.05, and at
  most 16 anti-aliased pixels differ by more than 32
- the format and size of every decoded image, and the 8 MB budget.

It writes `src/assets/card-art/tarot-hd/` and
`src/presentation/themes/tarot-hd-assets.js`. That module records each file's
size and SHA-256, and a SHA-256 of the sources and tools. The current pack is 54
images and 1,025,826 bytes: fronts of 10.9–25.0 kB, a 26.4 kB back and a
128.0 kB preview.

`tests/unit/tarot-hd-assets.test.js` fails when the sources or tools change
without a rebuild, and `tests/unit/tarot-hd-compose.test.js` checks the
components and their placement. `npm --prefix tools/card-art run check:hd`
rebuilds in memory and reports whether the committed files match. libwebp may
encode differently on another platform or CPU, so a byte mismatch there doesn't
by itself mean the sources changed; the source digest is the portable check.

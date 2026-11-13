# Soulcard

A framework-light, fullscreen card-game PWA, playable at
<https://pompomon.github.io/soulcard/>.
- A deterministic domain engine runs Classic duels and a roguelike Campaign expedition.
- A responsive Three.js battlefield presents committed events.
- The app has three screens: Main, Settings and Game.
- Settings → **Card art** chooses the bundled Tarot pixel deck (the default) or an HD deck of
  about 1 MB, downloaded on demand and kept for offline play.
- The classic theme stays registered as the fallback.

## Development

Use the Node version in [`.nvmrc`](.nvmrc), which CI also uses. From the repository root:

```sh
npm ci
npm run dev          # development server
npm test             # unit and integration tests (node:test; no browser needed)
npm run test:watch   # watch unit tests
npm run build        # production build in dist/
npm run preview      # serve dist/ (offline checks need a plain static server instead)
```

There is no lint command.
- CI runs `npm ci`, `npm test` and `npm run build` on every branch push except `gh-pages`, on every
  pull request, and on manual dispatch.
- Pushes to `main` deploy to GitHub Pages after the same checks.
- Dependabot opens weekly update pull requests.

## Seeded simulations

`npm run simulate` prints the deterministic baseline report for seeds 0–999. Select a seed or a
corpus, and optionally lower the per-run clash guard:

```sh
npm run simulate -- --seed 12345
npm run simulate -- --start 1000 --count 100
npm run simulate -- --seed 7 --max-clashes 100
npm run simulate --silent > tests/fixtures/simulation-report.json   # regenerate the fixture
```

The report contains no wall-clock or environment data. Its duration estimate is a versioned
content-planning metric.

## Browser checks

With `npm run dev` running, open a harness page. Each one plays or restores the real app and reports
text only:
- `data-status` ends as `complete` (`passed` for the phone HUD) or `failed`.
- A JSON report fills the page.
- All but the phone HUD page also log a `SOULCARD_*` console line.

These pages aren't production entry points or service-worker assets.

| Page under `/tests/browser/` | Reports |
|---|---|
| `milestone-19-profile.html` | Frame intervals, renderer and resource bounds, texture generation, art-pack sizes and timings, seeded matches, remounts, heap, and repeated WebGL context recovery |
| `milestone-21-1-campaign.html` | Campaign entry, first route choice, semantic Hold choices, presentation states |
| `milestone-21-2-rewards.html` | A saved reward draft, offers, the route map, informed Hold, Run details |
| `milestone-21-3-expedition.html` | Route locks, shop prices and purchases, node reloads, a failed save and its retry, an event with a target, a sold-out shop |
| `milestone-21-4-campaign.html` | Elite choice and traits, Greater Mend, rest options, a failed rest save, the boss route, the victory summary |
| `phone-hud-layout.html` | Footer bounds, wrapping, text sizes, targets and save warnings for phone (including the Fold4 cover screen), tablet, desktop and letterboxed layouts |
| `card-art.html` | Downloading HD art with SHA-256 checks, offline relaunch, live switching, retry, the texture-cache bound |

To check the Campaign by hand:
1. Choose **Campaign** on Main.
2. Take the High Court or Night Watch elite.
3. Rest at the Roadside Camp or Last Light Sanctum.
4. Fight the Ace Sovereign at stage 7.

## Documentation

| Doc | Use it for |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Rules and contracts for the domain, persistence, presentation, PWA and tests |
| [docs/CAMPAIGN.md](docs/CAMPAIGN.md) | Campaign rules, content, versions and generator constraints |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Milestone status, next specs, backlog, release checklist, maintenance |
| [docs/HISTORY.md](docs/HISTORY.md) | Summaries of retired plans, with permalinks |
| [art/README.md](art/README.md) | Card-art sources, provenance and regeneration |

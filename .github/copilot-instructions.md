# Copilot instructions

Soulcard is a framework-light Three.js card-game PWA (vanilla JS, Vite, `node:test`) deployed
to GitHub Pages. Keep changes focused; update the docs in the same pull request as the code.

## Read only what the task needs

- `docs/ARCHITECTURE.md`: rules and contracts for domain, persistence, presentation, PWA, tests.
- `docs/CAMPAIGN.md`: Campaign rules, content, versions and generator constraints.
- `docs/ROADMAP.md`: milestone status, next specs, backlog, delivery rules, plan lifecycle.
- `docs/HISTORY.md`: retired plans; open only when rationale or old evidence is needed.
- `art/README.md`: card-art sources, provenance and regeneration.

## Core principles

- Authoritative state (rules, RNG, card ownership, settlement, saves) stays out of Three.js
  and animation callbacks. Presentation consumes snapshots and committed events.
- Domain logic is deterministic: no frame time, wall clock or `Math.random`. Preserve RNG
  consumption order, ordered zones, card conservation and event order. Motion settings,
  skipped animation, pauses and WebGL context restoration never change outcomes.
- Version every contract change in the same pull request:
  - stored shape: save schema plus migration or quarantine, and fixtures
  - rule semantics: ruleset or `gameRulesVersion`
  - event contract: `eventVersion`
- Save only at stable domain boundaries. Cache Storage holds assets only, never saves.
- Main, Settings and Game are the only screens; other surfaces are Game overlays.
- Keep caches and textures bounded and disposable, and keep relative Vite/PWA paths.
- Every milestone ships playable value. Follow the plan lifecycle in `docs/ROADMAP.md`.

## Code map

- `src/domain`: pure rules, RNG, match and Campaign machines, events, simulation.
- `src/app`: bootstrap, run controller, screen coordinator, settings, card-art choice.
- `src/persistence`: IndexedDB runs, schema and migrations, settings, HD art store.
- `src/presentation`: Three.js battlefield, layout, input, event player, textures, themes.
- `src/ui`: DOM HUD, menus, overlays, settings and update notice.
- `public/sw.js`: service worker. `tools/card-art`: art pack builder with its own lockfile.
- Tests: `tests/unit` and `tests/integration` (node:test), `tests/fixtures`, and `tests/browser`
  (text-only harness pages, listed in the README).

## Commands

- Use the Node version in `.nvmrc` (CI uses the same file).
- Run `npm ci`, `npm test`, `npm run build` and `npm run dev`. There is no lint command.
- `npm run simulate --silent` must keep `tests/fixtures/simulation-report.json`
  byte-identical unless a rules change is intended.

## Validation

- Run `npm test` and `npm run build` for code changes. If they pass and the change does not
  affect browser, rendering, or PWA behavior, do not add visual validation.
- When browser validation is relevant, use a text-only headless browser check:
  - inspect the DOM and verify that `#app` contains a `canvas`
  - check console output and process status
  - harness pages report a `data-status`
- Do not create screenshots unless the user explicitly requests them. Never pass a
  generated screenshot or other image artifact to `view` or attach one to the
  conversation; report text-only browser evidence instead.
- Validate raster icons and art with file metadata or programmatic header/dimension checks.
  Never pass PNG, JPEG, WebP, or other raster assets to `view`.
- Chrome may try to contact Google telemetry, account, or update endpoints during a local
  headless check. Those firewall warnings are non-fatal when the local page loads, the
  DOM/canvas checks pass, and there is no relevant console error. Do not change the
  firewall allowlist solely to suppress them.
- For offline PWA checks, serve `dist` with a plain static server. `vite preview` sends
  `Vary: Origin`, which defeats the service worker's cache matches.

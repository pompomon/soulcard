# Copilot instructions

## Validation

- Use Node.js 24, matching CI. Run `npm test` and `npm run build` for code changes.
- If those checks pass and the change does not affect browser, rendering, or PWA
  behavior, do not add visual validation.
- When browser validation is relevant, use a text-only headless browser check. Inspect
  the DOM, verify that `#app` contains a `canvas`, and check console output and process
  status.
- Do not create screenshots unless the user explicitly requests them. Never pass a
  generated screenshot or other image artifact to `view` or attach one to the
  conversation; report text-only browser evidence instead.
- Validate raster icons with file metadata or programmatic header/dimension checks.
  Never pass PNG, JPEG, WebP, or other raster assets to `view`.
- Chrome may try to contact Google telemetry, account, or update endpoints during a
  local headless check. Firewall warnings for those endpoints are non-fatal when the
  local page loads, the DOM/canvas checks pass, and the browser reports no relevant
  console error. Do not change the firewall allowlist solely to suppress those warnings.

This follows the text-only browser validation requirement in
`docs/IMPLEMENTATION_ROADMAP.md`.

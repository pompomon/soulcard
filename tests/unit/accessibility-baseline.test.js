import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../../', import.meta.url)

function rule(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return css.match(new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]+)`, 'm'))?.[1] ?? ''
}

test('MVP controls retain target sizes and visible focus treatment', async () => {
  const css = await readFile(new URL('src/style.css', root), 'utf8')

  assert.match(rule(css, 'button'), /min-height:\s*44px/)
  assert.match(rule(css, '.settings-field select'), /min-height:\s*44px/)
  assert.match(rule(css, '.game-button'), /min-width:\s*44px/)
  assert.match(rule(css, '.game-button'), /min-height:\s*44px/)
  assert.match(rule(css, 'button:focus-visible'), /outline:\s*3px\s+solid/)
  assert.match(rule(css, 'select:focus-visible'), /outline:\s*3px\s+solid/)
})

test('card-art status block stays hidden when the Settings screen hides it', async () => {
  const css = await readFile(new URL('src/style.css', root), 'utf8')

  assert.match(rule(css, '.card-art-status'), /display:\s*grid/)
  assert.match(rule(css, '.card-art-status[hidden]'), /display:\s*none/)
  for (const selector of ['.card-art-status__progress', '.menu-button']) {
    assert.doesNotMatch(rule(css, selector), /display:/)
  }
})

test('document language and viewport support the declared accessible layout baseline', async () => {
  const html = await readFile(new URL('index.html', root), 'utf8')

  assert.match(html, /<html\s+lang="en">/)
  assert.match(html, /name="viewport"[^>]+viewport-fit=cover/)
})

test('phone footer keeps readable rows within its battlefield reserve', async () => {
  const css = await readFile(new URL('src/style.css', root), 'utf8')
  const portrait = '.screen--game[data-layout-mode="phone-portrait"]'
  const grid = rule(css, `${portrait} .game-hud`)
  const heights = [...grid.matchAll(/"(?:opponent|player|piles|status)"\s+(\d+)px/g)]
    .map((match) => Number(match[1]))
  assert.deepEqual(heights, [42, 42, 28, 36])
  assert.equal(heights.reduce((sum, height) => sum + height, 0), 148)
  assert.match(grid, /calc\(var\(--hud-footer-reserve,\s*210px\)\s*-\s*148px\)/)
  const labels = rule(css, `${portrait}\n  :is(.zone-panel, .hud-metrics--piles) .hud-metric dt`)
  assert.match(labels, /font-size:\s*0\.75rem/)
  assert.match(labels, /white-space:\s*nowrap/)
  assert.match(css, /phone-portrait"\]\s+\.game-status,[^{]+\{\s*font-size:\s*0\.75rem/)
  const warning = rule(css,
    `${portrait}\n  .game-hud:has(.game-save-warning:not([hidden])) .game-feedback`)
  assert.match(warning, /grid-row:\s*piles-start\s*\/\s*status-end/)
})

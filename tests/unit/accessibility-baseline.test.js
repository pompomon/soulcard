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

test('document language and viewport support the declared accessible layout baseline', async () => {
  const html = await readFile(new URL('index.html', root), 'utf8')

  assert.match(html, /<html\s+lang="en">/)
  assert.match(html, /name="viewport"[^>]+viewport-fit=cover/)
})

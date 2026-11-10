import assert from 'node:assert/strict'
import test from 'node:test'
import {
  TAROT_PIXEL_THEME_SELECTION,
  bindCardArt,
  createCardArtRegistry,
} from '../../src/app/card-art.js'
import {
  TAROT_PIXEL_BACK_THEME,
  TAROT_PIXEL_FRONT_THEME,
} from '../../src/presentation/themes/tarot-pixel.js'

test('the card-art registry selects the Tarot pixel deck over the classic fallback', () => {
  assert.deepEqual(TAROT_PIXEL_THEME_SELECTION, {
    frontThemeId: 'tarot-pixel-front-v1',
    backThemeId: 'tarot-pixel-back-v1',
  })
  assert.ok(Object.isFrozen(TAROT_PIXEL_THEME_SELECTION))

  const registry = createCardArtRegistry()
  assert.deepEqual(registry.resolveSelection(TAROT_PIXEL_THEME_SELECTION), TAROT_PIXEL_THEME_SELECTION)
  assert.equal(registry.resolveFront('tarot-pixel-front-v1').create, TAROT_PIXEL_FRONT_THEME.create)
  assert.equal(registry.resolveBack('tarot-pixel-back-v1').create, TAROT_PIXEL_BACK_THEME.create)
  assert.deepEqual(
    registry.listFrontThemes().map(({ id }) => id),
    ['classic-front-v1', 'tarot-pixel-front-v1'],
  )
  assert.deepEqual(
    registry.listBackThemes().map(({ id }) => id),
    ['classic-back-v1', 'tarot-pixel-back-v1'],
  )
  assert.equal(registry.resolveFront('tarot-hd-front-v1').id, 'classic-front-v1')
  assert.notEqual(createCardArtRegistry(), registry)
})

test('bindCardArt adds the registry and selection to every battlefield mount', () => {
  const calls = []
  const handle = { destroy() {} }
  const mount = bindCardArt((host, options) => {
    calls.push({ host, options })
    return handle
  })
  const host = {}
  const onLayout = () => {}
  assert.equal(mount(host, { onLayout, themeSelection: { frontThemeId: 'x' } }), handle)
  mount(host)

  assert.equal(calls.length, 2)
  assert.equal(calls[0].host, host)
  assert.equal(calls[0].options.onLayout, onLayout)
  assert.equal(calls[0].options.themeSelection, TAROT_PIXEL_THEME_SELECTION)
  assert.equal(calls[1].options.themeSelection, TAROT_PIXEL_THEME_SELECTION)
  assert.equal(calls[0].options.themeRegistry, calls[1].options.themeRegistry)
  assert.equal(
    calls[0].options.themeRegistry.resolveFront('tarot-pixel-front-v1').id,
    'tarot-pixel-front-v1',
  )

  const themeRegistry = createCardArtRegistry()
  const themeSelection = { frontThemeId: 'classic-front-v1', backThemeId: 'classic-back-v1' }
  bindCardArt((_host, options) => calls.push({ options }), { themeRegistry, themeSelection })(host)
  assert.equal(calls[2].options.themeRegistry, themeRegistry)
  assert.equal(calls[2].options.themeSelection, themeSelection)

  for (const invalid of [undefined, null, {}, 'mount']) {
    assert.throws(() => bindCardArt(invalid), /mountBattlefield must be a function/)
  }
})

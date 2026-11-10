import assert from 'node:assert/strict'
import test from 'node:test'
import { CARD_ART_OPTIONS } from '../../src/app/settings.js'
import {
  CARD_ART_LABELS,
  CARD_ART_THEME_SELECTIONS,
  TAROT_HD_THEME_SELECTION,
  TAROT_PIXEL_THEME_SELECTION,
  bindCardArt,
  cardArtThemeSelection,
  createCardArtRegistry,
  createFixedThemeSource,
} from '../../src/app/card-art.js'
import {
  TAROT_HD_BACK_THEME_ID,
  TAROT_HD_FRONT_THEME_ID,
} from '../../src/presentation/themes/tarot-hd.js'
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

test('card art options map to versioned theme selections and labels', () => {
  assert.deepEqual(Object.keys(CARD_ART_THEME_SELECTIONS), [...CARD_ART_OPTIONS])
  assert.deepEqual(Object.keys(CARD_ART_LABELS), [...CARD_ART_OPTIONS])
  assert.equal(CARD_ART_THEME_SELECTIONS['tarot-pixel'], TAROT_PIXEL_THEME_SELECTION)
  assert.equal(CARD_ART_THEME_SELECTIONS['tarot-hd'], TAROT_HD_THEME_SELECTION)
  assert.deepEqual(TAROT_HD_THEME_SELECTION, {
    frontThemeId: TAROT_HD_FRONT_THEME_ID,
    backThemeId: TAROT_HD_BACK_THEME_ID,
  })
  assert.deepEqual(CARD_ART_LABELS, {
    'tarot-pixel': 'Tarot (pixel)',
    'tarot-hd': 'Tarot (HD)',
  })
  for (const value of [CARD_ART_THEME_SELECTIONS, CARD_ART_LABELS, TAROT_HD_THEME_SELECTION]) {
    assert.ok(Object.isFrozen(value))
  }
  assert.equal(cardArtThemeSelection('tarot-hd'), TAROT_HD_THEME_SELECTION)
  for (const invalid of ['classic', 'tarot-hd-front-v1', undefined, 'toString']) {
    assert.throws(() => cardArtThemeSelection(invalid), RangeError)
  }
})

test('a fixed theme source reports one frozen selection and never notifies', () => {
  const source = createFixedThemeSource()
  assert.deepEqual(source.getSelection(), TAROT_PIXEL_THEME_SELECTION)
  assert.ok(Object.isFrozen(source.getSelection()))
  assert.equal(source.getSelection(), source.getSelection())
  let calls = 0
  const unsubscribe = source.subscribe(() => {
    calls += 1
  })
  unsubscribe()
  unsubscribe()
  assert.equal(calls, 0)
  assert.throws(() => source.subscribe(null), TypeError)

  const classic = createFixedThemeSource({ frontThemeId: 'classic-front-v1', backThemeId: 'classic-back-v1' })
  assert.deepEqual(classic.getSelection(), {
    frontThemeId: 'classic-front-v1',
    backThemeId: 'classic-back-v1',
  })
})

test('bindCardArt adds the registry and theme source to every battlefield mount', () => {
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
  assert.equal(Object.hasOwn(calls[0].options, 'themeSelection'), false)
  assert.deepEqual(calls[0].options.themeSource.getSelection(), TAROT_PIXEL_THEME_SELECTION)
  assert.equal(calls[0].options.themeSource, calls[1].options.themeSource)
  assert.equal(calls[0].options.themeRegistry, calls[1].options.themeRegistry)
  assert.equal(
    calls[0].options.themeRegistry.resolveFront('tarot-pixel-front-v1').id,
    'tarot-pixel-front-v1',
  )

  // A card-art controller carries both, so it can be passed directly.
  const themeRegistry = createCardArtRegistry()
  const themeSource = createFixedThemeSource({ frontThemeId: 'classic-front-v1', backThemeId: 'classic-back-v1' })
  const controller = { themeRegistry, themeSource, getSnapshot() {} }
  bindCardArt((_host, options) => calls.push({ options }), controller)(host, null)
  assert.equal(calls[2].options.themeRegistry, themeRegistry)
  assert.equal(calls[2].options.themeSource, themeSource)
  assert.equal(Object.hasOwn(calls[2].options, 'getSnapshot'), false)

  for (const invalid of [undefined, null, {}, 'mount']) {
    assert.throws(() => bindCardArt(invalid), /mountBattlefield must be a function/)
  }
})

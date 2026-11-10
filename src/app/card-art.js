import { CARD_ART_OPTIONS } from './settings.js'
import { createThemeRegistry } from '../presentation/themes/registry.js'
import {
  TAROT_PIXEL_BACK_THEME,
  TAROT_PIXEL_FRONT_THEME,
} from '../presentation/themes/tarot-pixel.js'

// The Tarot pixel deck is the default card art. Classic stays registered as the
// registry's fallback for unknown theme IDs.
export const TAROT_PIXEL_THEME_SELECTION = Object.freeze({
  frontThemeId: TAROT_PIXEL_FRONT_THEME.id,
  backThemeId: TAROT_PIXEL_BACK_THEME.id,
})

// The HD theme module loads lazily, so its IDs are repeated here rather than
// imported; card-art.test.js checks that they match.
export const TAROT_HD_THEME_SELECTION = Object.freeze({
  frontThemeId: 'tarot-hd-front-v1',
  backThemeId: 'tarot-hd-back-v1',
})

export const CARD_ART_THEME_SELECTIONS = Object.freeze({
  'tarot-pixel': TAROT_PIXEL_THEME_SELECTION,
  'tarot-hd': TAROT_HD_THEME_SELECTION,
})

export const CARD_ART_LABELS = Object.freeze({
  'tarot-pixel': 'Tarot (pixel)',
  'tarot-hd': 'Tarot (HD)',
})

export function cardArtThemeSelection(option) {
  if (!CARD_ART_OPTIONS.includes(option)) {
    throw new RangeError(`Unknown card art option: ${String(option)}`)
  }
  return CARD_ART_THEME_SELECTIONS[option]
}

export function createCardArtRegistry() {
  return createThemeRegistry({
    frontThemes: [TAROT_PIXEL_FRONT_THEME],
    backThemes: [TAROT_PIXEL_BACK_THEME],
  })
}

// A theme source whose selection never changes.
export function createFixedThemeSource(selection = TAROT_PIXEL_THEME_SELECTION) {
  const frozen = Object.freeze({
    frontThemeId: selection?.frontThemeId,
    backThemeId: selection?.backThemeId,
  })
  return Object.freeze({
    getSelection: () => frozen,
    subscribe(listener) {
      if (typeof listener !== 'function') {
        throw new TypeError('Theme source listener must be a function')
      }
      return () => {}
    },
  })
}

// Gives every battlefield the card-art registry and theme source, so the Game
// screen needs no knowledge of themes.
export function bindCardArt(mountBattlefield, {
  themeRegistry = createCardArtRegistry(),
  themeSource = createFixedThemeSource(),
} = {}) {
  if (typeof mountBattlefield !== 'function') {
    throw new TypeError('mountBattlefield must be a function')
  }
  return (host, options = {}) => {
    const { themeSelection: _ignored, ...rest } = options ?? {}
    return mountBattlefield(host, {
      ...rest,
      themeRegistry,
      themeSource,
    })
  }
}

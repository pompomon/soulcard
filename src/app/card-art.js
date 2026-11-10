import { createThemeRegistry } from '../presentation/themes/registry.js'
import {
  TAROT_PIXEL_BACK_THEME,
  TAROT_PIXEL_FRONT_THEME,
} from '../presentation/themes/tarot-pixel.js'

// The Tarot pixel deck is the card art. Classic stays registered as the
// registry's fallback for unknown theme IDs.
export const TAROT_PIXEL_THEME_SELECTION = Object.freeze({
  frontThemeId: TAROT_PIXEL_FRONT_THEME.id,
  backThemeId: TAROT_PIXEL_BACK_THEME.id,
})

export function createCardArtRegistry() {
  return createThemeRegistry({
    frontThemes: [TAROT_PIXEL_FRONT_THEME],
    backThemes: [TAROT_PIXEL_BACK_THEME],
  })
}

// Gives every battlefield the card-art registry and selection, so the Game
// screen needs no knowledge of themes.
export function bindCardArt(mountBattlefield, {
  themeRegistry = createCardArtRegistry(),
  themeSelection = TAROT_PIXEL_THEME_SELECTION,
} = {}) {
  if (typeof mountBattlefield !== 'function') {
    throw new TypeError('mountBattlefield must be a function')
  }
  return (host, options = {}) => mountBattlefield(host, {
    ...options,
    themeRegistry,
    themeSelection,
  })
}

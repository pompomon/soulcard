import { CARD_IDS, getCard } from '../../domain/cards.js'
import { CARD_TEXTURE_LOGICAL_SIZE } from './canvas.js'

// Shared composition for both Tarot decks. Coordinates are logical px on the
// 300×420 card; every edge is a multiple of TAROT_ART_UNIT, so the pixel deck's
// 75×105 grid and the HD deck place the same elements in the same places.
export const TAROT_LOGICAL_SIZE = CARD_TEXTURE_LOGICAL_SIZE
export const TAROT_ART_UNIT = 4
// Tarot textures stop at 600×840: larger cards render no larger than 514×709
// device px, so higher texture scales would only cost memory.
export const TAROT_MAX_TEXTURE_SCALE = 2

export const TAROT_SUIT_BY_CARD_SUIT = Object.freeze({
  S: 'swords',
  H: 'cups',
  D: 'pentacles',
  C: 'wands',
})

export const TAROT_SUIT_GLYPHS = Object.freeze({
  S: '♠',
  H: '♥',
  D: '♦',
  C: '♣',
})

export const TAROT_COLORS = Object.freeze({
  ground: '#f2e6c9',
  window: '#fbf5e6',
  night: '#28204f',
  gold: '#d7bb72',
  redIndex: '#b42336',
  darkIndex: '#18141f',
})

// Illustration accents only; rank and suit are always carried by the indices.
export const TAROT_SUIT_ACCENTS = Object.freeze({
  cups: '#2f6f8f',
  pentacles: '#c08a2e',
  wands: '#4f7a3a',
  swords: '#8a93a6',
})

export const TAROT_ROMAN_NUMERALS = Object.freeze({
  2: 'II',
  3: 'III',
  4: 'IV',
  5: 'V',
  6: 'VI',
  7: 'VII',
  8: 'VIII',
  9: 'IX',
  10: 'X',
})

export const TAROT_COURTS = Object.freeze({
  J: Object.freeze({ figure: 'page', title: 'PAGE' }),
  Q: Object.freeze({ figure: 'queen', title: 'QUEEN' }),
  K: Object.freeze({ figure: 'king', title: 'KING' }),
})

const box = (x, y, width, height) => Object.freeze({ x, y, width, height })

export const TAROT_LAYOUT = Object.freeze({
  window: Object.freeze({ ...box(68, 64, 164, 316), archHeight: 48 }),
  cartouche: box(104, 20, 92, 36),
  index: Object.freeze({
    rank: box(24, 24, 28, 28),
    suit: box(24, 56, 28, 28),
  }),
  pip: Object.freeze({ width: 36, height: 36 }),
})

function freezePoints(points) {
  return Object.freeze(points.map((point) => Object.freeze([...point])))
}

// Normalized pip centres within the art window. Rows start below the arch.
const PIP_LAYOUT_POINTS = {
  2: [[0.5, 0.36], [0.5, 0.78]],
  3: [[0.5, 0.3], [0.5, 0.57], [0.5, 0.84]],
  4: [[0.27, 0.36], [0.73, 0.36], [0.27, 0.78], [0.73, 0.78]],
  5: [[0.27, 0.36], [0.73, 0.36], [0.5, 0.57], [0.27, 0.78], [0.73, 0.78]],
  6: [
    [0.27, 0.3], [0.73, 0.3], [0.27, 0.57],
    [0.73, 0.57], [0.27, 0.84], [0.73, 0.84],
  ],
  7: [
    [0.27, 0.3], [0.73, 0.3], [0.5, 0.435], [0.27, 0.57],
    [0.73, 0.57], [0.27, 0.84], [0.73, 0.84],
  ],
  8: [
    [0.27, 0.3], [0.73, 0.3], [0.5, 0.435], [0.27, 0.57],
    [0.73, 0.57], [0.5, 0.705], [0.27, 0.84], [0.73, 0.84],
  ],
  9: [
    [0.27, 0.28], [0.73, 0.28], [0.27, 0.47], [0.73, 0.47], [0.5, 0.565],
    [0.27, 0.66], [0.73, 0.66], [0.27, 0.85], [0.73, 0.85],
  ],
  10: [
    [0.27, 0.28], [0.73, 0.28], [0.5, 0.375], [0.27, 0.47], [0.73, 0.47],
    [0.27, 0.66], [0.73, 0.66], [0.5, 0.755], [0.27, 0.85], [0.73, 0.85],
  ],
}

export const TAROT_PIP_LAYOUTS = Object.freeze(Object.fromEntries(
  Object.entries(PIP_LAYOUT_POINTS).map(([rank, points]) => [rank, freezePoints(points)]),
))

function snapToArtUnit(value) {
  return Math.round(value / TAROT_ART_UNIT) * TAROT_ART_UNIT
}

// Pip boxes snap to the art grid so both decks draw them at identical positions.
export function getTarotPipBox([normalizedX, normalizedY]) {
  const { window, pip } = TAROT_LAYOUT
  const centerX = window.x + normalizedX * window.width
  const centerY = window.y + normalizedY * window.height
  return box(
    snapToArtUnit(centerX - pip.width / 2),
    snapToArtUnit(centerY - pip.height / 2),
    pip.width,
    pip.height,
  )
}

export function isInsideTarotWindow(x, y) {
  const { window } = TAROT_LAYOUT
  if (
    x < window.x
    || x > window.x + window.width
    || y < window.y
    || y > window.y + window.height
  ) {
    return false
  }
  const springLine = window.y + window.archHeight
  if (y >= springLine) return true
  const radiusX = window.width / 2
  const dx = (x - (window.x + radiusX)) / radiusX
  const dy = (y - springLine) / window.archHeight
  return dx * dx + dy * dy <= 1
}

// The bottom-right index is the top-left index turned 180° about the card centre.
export function mirrorTarotBox({ x, y, width, height }) {
  return box(
    TAROT_LOGICAL_SIZE.width - x - width,
    TAROT_LOGICAL_SIZE.height - y - height,
    width,
    height,
  )
}

function composeCard(cardId) {
  const card = getCard(cardId)
  const tarotSuit = TAROT_SUIT_BY_CARD_SUIT[card.suit]
  const index = Object.freeze({
    rank: card.rank,
    glyph: TAROT_SUIT_GLYPHS[card.suit],
    color: card.suit === 'H' || card.suit === 'D'
      ? TAROT_COLORS.redIndex
      : TAROT_COLORS.darkIndex,
  })
  const base = {
    cardId,
    suit: card.suit,
    rank: card.rank,
    tarotSuit,
    index,
  }
  if (card.rank === 'A') {
    return Object.freeze({
      ...base,
      kind: 'ace',
      numeral: null,
      cartouche: Object.freeze({ kind: 'sun', text: null }),
      pips: Object.freeze([]),
      figureId: `ace-${tarotSuit}`,
    })
  }
  if (Object.hasOwn(TAROT_COURTS, card.rank)) {
    const court = TAROT_COURTS[card.rank]
    return Object.freeze({
      ...base,
      kind: 'court',
      numeral: null,
      cartouche: Object.freeze({ kind: 'title', text: court.title }),
      pips: Object.freeze([]),
      figureId: `${court.figure}-${tarotSuit}`,
    })
  }
  const numeral = TAROT_ROMAN_NUMERALS[card.rank]
  return Object.freeze({
    ...base,
    kind: 'pips',
    numeral,
    cartouche: Object.freeze({ kind: 'numeral', text: numeral }),
    pips: TAROT_PIP_LAYOUTS[card.rank],
    figureId: null,
  })
}

export const TAROT_COMPOSITIONS = Object.freeze(
  Object.fromEntries(CARD_IDS.map((cardId) => [cardId, composeCard(cardId)])),
)

export function getTarotComposition(cardId) {
  if (typeof cardId !== 'string' || !Object.hasOwn(TAROT_COMPOSITIONS, cardId)) {
    throw new RangeError(`Unknown Tarot card ID: ${String(cardId)}`)
  }
  return TAROT_COMPOSITIONS[cardId]
}

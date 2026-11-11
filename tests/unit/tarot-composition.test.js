import assert from 'node:assert/strict'
import test from 'node:test'
import { CARD_IDS, CARDS } from '../../src/domain/cards.js'
import {
  TAROT_ART_UNIT,
  TAROT_COLORS,
  TAROT_COMPOSITIONS,
  TAROT_LAYOUT,
  TAROT_LOGICAL_SIZE,
  TAROT_PIP_LAYOUTS,
  TAROT_SUIT_BY_CARD_SUIT,
  getTarotComposition,
  getTarotPipBox,
  isInsideTarotWindow,
  mirrorTarotBox,
} from '../../src/presentation/themes/tarot-composition.js'

const NUMERALS = ['II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X']

function luminance(hex) {
  const channels = [1, 3, 5].map((offset) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

function contrast(foreground, background) {
  const [light, dark] = [luminance(foreground), luminance(background)]
    .sort((left, right) => right - left)
  return (light + 0.05) / (dark + 0.05)
}

function boxesOverlap(first, second) {
  return (
    first.x < second.x + second.width
    && second.x < first.x + first.width
    && first.y < second.y + second.height
    && second.y < first.y + first.height
  )
}

function boxInsideWindow({ x, y, width, height }) {
  return [
    [x, y],
    [x + width, y],
    [x, y + height],
    [x + width, y + height],
  ].every(([px, py]) => isInsideTarotWindow(px, py))
}

test('every canonical card has one frozen composition in deck order', () => {
  assert.deepEqual(Object.keys(TAROT_COMPOSITIONS), [...CARD_IDS])
  assert.ok(Object.isFrozen(TAROT_COMPOSITIONS))
  for (const card of CARDS) {
    const composition = getTarotComposition(card.id)
    assert.equal(composition, TAROT_COMPOSITIONS[card.id])
    assert.equal(composition.cardId, card.id)
    assert.equal(composition.suit, card.suit)
    assert.equal(composition.rank, card.rank)
    assert.ok(Object.isFrozen(composition))
    assert.ok(Object.isFrozen(composition.index))
    assert.ok(Object.isFrozen(composition.cartouche))
    assert.ok(Object.isFrozen(composition.pips))
    assert.ok(composition.pips.every(Object.isFrozen))
  }
  for (const invalid of ['c-1S', 'C-2S', '', null, undefined, 2, 'toString']) {
    assert.throws(() => getTarotComposition(invalid), /Unknown Tarot card ID/)
  }
})

test('suits map to the conventional Tarot suits with familiar index glyphs', () => {
  assert.deepEqual(TAROT_SUIT_BY_CARD_SUIT, {
    H: 'cups',
    D: 'pentacles',
    C: 'wands',
    S: 'swords',
  })
  const glyphs = { S: '♠', H: '♥', D: '♦', C: '♣' }
  for (const card of CARDS) {
    const composition = getTarotComposition(card.id)
    assert.equal(composition.tarotSuit, TAROT_SUIT_BY_CARD_SUIT[card.suit])
    assert.equal(composition.index.rank, card.rank)
    assert.equal(composition.index.glyph, glyphs[card.suit])
  }
})

test('ranks 2–10 carry numerals II–X and exactly as many pips as their rank', () => {
  for (const card of CARDS) {
    const composition = getTarotComposition(card.id)
    if (card.value > 10) continue
    assert.equal(composition.kind, 'pips')
    assert.equal(composition.numeral, NUMERALS[card.value - 2])
    assert.deepEqual(composition.cartouche, {
      kind: 'numeral',
      text: NUMERALS[card.value - 2],
    })
    assert.equal(composition.pips.length, card.value)
    assert.equal(composition.pips, TAROT_PIP_LAYOUTS[card.rank])
    assert.equal(composition.figureId, null)
  }
})

test('pip boxes lie inside the arched window without overlapping', () => {
  for (const [rank, layout] of Object.entries(TAROT_PIP_LAYOUTS)) {
    const boxes = layout.map(getTarotPipBox)
    for (const pipBox of boxes) {
      assert.ok(boxInsideWindow(pipBox), `rank ${rank} pip ${JSON.stringify(pipBox)}`)
      assert.equal(pipBox.width, TAROT_LAYOUT.pip.width)
      assert.equal(pipBox.height, TAROT_LAYOUT.pip.height)
      assert.equal(pipBox.x % TAROT_ART_UNIT, 0)
      assert.equal(pipBox.y % TAROT_ART_UNIT, 0)
    }
    for (let first = 0; first < boxes.length; first += 1) {
      for (let second = first + 1; second < boxes.length; second += 1) {
        assert.equal(
          boxesOverlap(boxes[first], boxes[second]),
          false,
          `rank ${rank} pips ${first} and ${second} overlap`,
        )
      }
    }
  }
})

test('courts and Aces have figures and a non-numeral cartouche', () => {
  const courts = { J: ['page', 'PAGE'], Q: ['queen', 'QUEEN'], K: ['king', 'KING'] }
  for (const card of CARDS) {
    const composition = getTarotComposition(card.id)
    if (card.rank === 'A') {
      assert.equal(composition.kind, 'ace')
      assert.equal(composition.figureId, `ace-${composition.tarotSuit}`)
      assert.deepEqual(composition.cartouche, { kind: 'sun', text: null })
    } else if (Object.hasOwn(courts, card.rank)) {
      const [figure, title] = courts[card.rank]
      assert.equal(composition.kind, 'court')
      assert.equal(composition.figureId, `${figure}-${composition.tarotSuit}`)
      assert.deepEqual(composition.cartouche, { kind: 'title', text: title })
    } else {
      continue
    }
    assert.equal(composition.numeral, null)
    assert.equal(composition.pips.length, 0)
  }
})

test('index colours follow red and dark suits with at least 4.5:1 contrast', () => {
  for (const card of CARDS) {
    const { index } = getTarotComposition(card.id)
    assert.equal(
      index.color,
      ['H', 'D'].includes(card.suit) ? TAROT_COLORS.redIndex : TAROT_COLORS.darkIndex,
    )
    assert.ok(contrast(index.color, TAROT_COLORS.ground) >= 4.5)
  }
  assert.equal(TAROT_COLORS.redIndex, '#b42336')
  assert.equal(TAROT_COLORS.darkIndex, '#18141f')
  assert.ok(contrast(TAROT_COLORS.gold, TAROT_COLORS.night) >= 4.5)
})

test('layout boxes sit on the art grid, keep indices legible, and stay apart', () => {
  const { window, cartouche, index } = TAROT_LAYOUT
  assert.deepEqual(TAROT_LOGICAL_SIZE, { width: 300, height: 420 })
  for (const layoutBox of [window, cartouche, index.rank, index.suit]) {
    for (const key of ['x', 'y', 'width', 'height']) {
      assert.equal(layoutBox[key] % TAROT_ART_UNIT, 0, key)
    }
  }
  assert.equal(window.archHeight % TAROT_ART_UNIT, 0)
  assert.ok(index.rank.height >= 28)
  assert.ok(index.suit.height >= 28)

  const indexBoxes = [
    index.rank,
    index.suit,
    mirrorTarotBox(index.rank),
    mirrorTarotBox(index.suit),
  ]
  for (const indexBox of indexBoxes) {
    assert.equal(boxesOverlap(indexBox, window), false)
    assert.equal(boxesOverlap(indexBox, cartouche), false)
    assert.ok(indexBox.x >= 16 && indexBox.y >= 16)
    assert.ok(indexBox.x + indexBox.width <= TAROT_LOGICAL_SIZE.width - 16)
    assert.ok(indexBox.y + indexBox.height <= TAROT_LOGICAL_SIZE.height - 16)
  }
  assert.equal(boxesOverlap(cartouche, window), false)
  assert.deepEqual(mirrorTarotBox(index.rank), { x: 248, y: 368, width: 28, height: 28 })
  assert.deepEqual(mirrorTarotBox(mirrorTarotBox(index.suit)), index.suit)
})

test('the window arch excludes its top corners', () => {
  const { window } = TAROT_LAYOUT
  assert.equal(isInsideTarotWindow(window.x + window.width / 2, window.y), true)
  assert.equal(isInsideTarotWindow(window.x + 1, window.y + 1), false)
  assert.equal(isInsideTarotWindow(window.x + window.width - 1, window.y + 1), false)
  assert.equal(isInsideTarotWindow(window.x, window.y + window.archHeight), true)
  assert.equal(isInsideTarotWindow(window.x - 1, window.y + window.height / 2), false)
  assert.equal(isInsideTarotWindow(window.x, window.y + window.height + 1), false)
})

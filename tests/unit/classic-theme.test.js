import assert from 'node:assert/strict'
import test from 'node:test'
import { CARDS } from '../../src/domain/cards.js'
import {
  CLASSIC_BACK_THEME,
  CLASSIC_BACK_THEME_ID,
  CLASSIC_CARD_LOGICAL_SIZE,
  CLASSIC_FRONT_THEME,
  CLASSIC_FRONT_THEME_ID,
  DEFAULT_CLASSIC_TEXTURE_SCALE,
  generateClassicBack,
  generateClassicFront,
} from '../../src/presentation/themes/classic.js'

class RecordingContext {
  constructor() {
    this.operations = []
    this.stack = []
    this.fillStyle = '#000000'
    this.strokeStyle = '#000000'
    this.font = ''
    this.textAlign = 'start'
    this.textBaseline = 'alphabetic'
    this.lineWidth = 1
    this.globalAlpha = 1
  }

  record(name, args) {
    this.operations.push({
      name,
      args: [...args],
      fillStyle: this.fillStyle,
      strokeStyle: this.strokeStyle,
      font: this.font,
      globalAlpha: this.globalAlpha,
    })
  }

  save() {
    this.stack.push({
      fillStyle: this.fillStyle,
      strokeStyle: this.strokeStyle,
      font: this.font,
      textAlign: this.textAlign,
      textBaseline: this.textBaseline,
      lineWidth: this.lineWidth,
      globalAlpha: this.globalAlpha,
    })
    this.record('save', arguments)
  }

  restore() {
    const saved = this.stack.pop()
    if (saved) Object.assign(this, saved)
    this.record('restore', arguments)
  }

  scale() { this.record('scale', arguments) }
  clearRect() { this.record('clearRect', arguments) }
  beginPath() { this.record('beginPath', arguments) }
  moveTo() { this.record('moveTo', arguments) }
  lineTo() { this.record('lineTo', arguments) }
  quadraticCurveTo() { this.record('quadraticCurveTo', arguments) }
  closePath() { this.record('closePath', arguments) }
  fill() { this.record('fill', arguments) }
  stroke() { this.record('stroke', arguments) }
  translate() { this.record('translate', arguments) }
  rotate() { this.record('rotate', arguments) }
  fillText() { this.record('fillText', arguments) }
  arc() { this.record('arc', arguments) }
  fillRect() { this.record('fillRect', arguments) }
}

function createCanvasHarness() {
  const canvases = []
  return {
    canvases,
    createCanvas(width, height) {
      const context = new RecordingContext()
      const canvas = {
        width,
        height,
        context,
        getContext(type) {
          assert.equal(type, '2d')
          return context
        },
      }
      canvases.push(canvas)
      return canvas
    },
  }
}

function textOperations(canvas, text) {
  return canvas.context.operations.filter(
    ({ name, args }) => name === 'fillText' && args[0] === text,
  )
}

test('classic theme exports stable immutable descriptors', () => {
  assert.equal(CLASSIC_FRONT_THEME_ID, 'classic-front-v1')
  assert.equal(CLASSIC_BACK_THEME_ID, 'classic-back-v1')
  assert.equal(DEFAULT_CLASSIC_TEXTURE_SCALE, 2)
  assert.deepEqual(CLASSIC_CARD_LOGICAL_SIZE, { width: 300, height: 420 })
  assert.ok(Object.isFrozen(CLASSIC_CARD_LOGICAL_SIZE))
  assert.deepEqual(CLASSIC_FRONT_THEME, {
    id: CLASSIC_FRONT_THEME_ID,
    create: generateClassicFront,
  })
  assert.deepEqual(CLASSIC_BACK_THEME, {
    id: CLASSIC_BACK_THEME_ID,
    create: generateClassicBack,
  })
  assert.ok(Object.isFrozen(CLASSIC_FRONT_THEME))
  assert.ok(Object.isFrozen(CLASSIC_BACK_THEME))
})

test('classic generator covers every immutable card with mirrored readable indices', () => {
  const before = JSON.stringify(CARDS)
  for (const card of CARDS) {
    const harness = createCanvasHarness()
    const canvas = generateClassicFront(card.id, {
      scale: 1,
      createCanvas: harness.createCanvas,
    })
    assert.equal(canvas, harness.canvases[0])
    assert.equal(canvas.width, 300)
    assert.equal(canvas.height, 420)
    assert.ok(canvas.context.operations.length > 30)
    assert.ok(textOperations(canvas, card.rank).length >= 2)
    assert.ok(
      canvas.context.operations.some(
        ({ name, args }) => name === 'rotate' && args[0] === Math.PI,
      ),
    )
  }
  assert.equal(JSON.stringify(CARDS), before)
  assert.ok(CARDS.every(Object.isFrozen))
})

test('numeric, ace, and face layouts use suit colors and original geometry', () => {
  const heartHarness = createCanvasHarness()
  const ten = generateClassicFront('c-10H', {
    scale: 1,
    createCanvas: heartHarness.createCanvas,
  })
  const heartPips = textOperations(ten, '♥')
  assert.equal(heartPips.length, 12)
  assert.ok(heartPips.every(({ fillStyle }) => fillStyle === '#b42336'))

  const spadeHarness = createCanvasHarness()
  const ace = generateClassicFront('c-AS', {
    scale: 1,
    createCanvas: spadeHarness.createCanvas,
  })
  const spadePips = textOperations(ace, '♠')
  assert.equal(spadePips.length, 3)
  assert.ok(spadePips.every(({ fillStyle }) => fillStyle === '#18141f'))
  assert.match(spadePips.at(-1).font, /112px/)

  for (const cardId of ['c-JD', 'c-QC', 'c-KS']) {
    const harness = createCanvasHarness()
    const canvas = generateClassicFront(cardId, {
      scale: 1,
      createCanvas: harness.createCanvas,
    })
    assert.ok(canvas.context.operations.some(({ name }) => name === 'arc'))
    assert.ok(canvas.context.operations.some(({ name }) => name === 'fillRect'))
    assert.ok(textOperations(canvas, cardId.slice(2, -1)).length >= 3)
  }
})

test('classic back and high-DPI fronts use deterministic scaled backing dimensions', () => {
  const frontHarness = createCanvasHarness()
  const front = generateClassicFront('c-2D', {
    scale: 3,
    createCanvas: frontHarness.createCanvas,
  })
  assert.deepEqual([front.width, front.height], [900, 1260])
  assert.deepEqual(
    front.context.operations.find(({ name }) => name === 'scale').args,
    [3, 3],
  )

  const backHarness = createCanvasHarness()
  const back = generateClassicBack({
    createCanvas: backHarness.createCanvas,
  })
  assert.deepEqual([back.width, back.height], [600, 840])
  assert.ok(back.context.operations.length > 100)
  assert.equal(textOperations(back, 'S').length, 1)
  assert.ok(
    back.context.operations.some(
      ({ name, args }) => name === 'rotate' && args[0] === Math.PI,
    ),
  )

  const repeatedHarness = createCanvasHarness()
  const repeated = generateClassicBack({
    createCanvas: repeatedHarness.createCanvas,
  })
  assert.deepEqual(repeated.context.operations, back.context.operations)
})

test('classic generators reject invalid cards, scales, factories, and contexts', () => {
  const harness = createCanvasHarness()
  assert.throws(
    () => generateClassicFront('c-1S', { createCanvas: harness.createCanvas }),
    /Unknown classic card ID/,
  )
  for (const scale of [0, 1.5, 5, Number.NaN]) {
    assert.throws(
      () => generateClassicBack({ scale, createCanvas: harness.createCanvas }),
      /scale/,
    )
  }
  assert.throws(() => generateClassicBack(null), /options/)
  assert.throws(
    () => generateClassicBack({ createCanvas: null }),
    /createCanvas/,
  )
  assert.throws(
    () => generateClassicBack({ createCanvas: () => ({}) }),
    /canvas-like/,
  )
  assert.throws(
    () => generateClassicBack({
      createCanvas: () => ({ getContext: () => null }),
    }),
    /2D context/,
  )
})

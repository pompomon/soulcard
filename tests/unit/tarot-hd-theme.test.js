import assert from 'node:assert/strict'
import test from 'node:test'
import { CARD_IDS } from '../../src/domain/cards.js'
import { createTextureCache } from '../../src/presentation/texture-cache.js'
import { createThemeRegistry } from '../../src/presentation/themes/registry.js'
import { TAROT_HD_ASSETS } from '../../src/presentation/themes/tarot-hd-assets.js'
import {
  TAROT_HD_PREVIEW_LAYOUT,
  getTarotHdPreviewCell,
} from '../../src/presentation/themes/tarot-hd-layout.js'
import {
  TAROT_HD_BACK_THEME_ID,
  TAROT_HD_DECODE_CONCURRENCY,
  TAROT_HD_FRONT_THEME_ID,
  TarotHdArtError,
  createTarotHdThemes,
} from '../../src/presentation/themes/tarot-hd.js'

const flush = () => new Promise((resolve) => setImmediate(resolve))
const sizeOf = (id) => (id === 'preview' ? { width: 1200, height: 1470 } : { width: 600, height: 840 })

function createRecordingCanvas(width, height) {
  const operations = []
  const context = {
    imageSmoothingEnabled: false,
    imageSmoothingQuality: 'low',
    scale: (...args) => operations.push(['scale', ...args]),
    clearRect: (...args) => operations.push(['clearRect', ...args]),
    save: () => operations.push(['save']),
    restore: () => operations.push(['restore']),
    setTransform: (...args) => operations.push(['setTransform', ...args]),
    drawImage(image, ...args) {
      operations.push(['drawImage', image.id, ...args, this.imageSmoothingEnabled, this.imageSmoothingQuality])
    },
  }
  return { width, height, operations, getContext: (type) => (type === '2d' ? context : null) }
}

function createBitmap(id, { width, height }) {
  return {
    id,
    width,
    height,
    closed: 0,
    close() {
      this.closed += 1
    },
  }
}

function createDeferred() {
  let resolve
  let reject
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

// A pack store whose blobs name their asset and revision, and a decoder that
// turns them into recorded fake bitmaps. `gate(id)` may return a promise that
// holds that decode until the test resolves it.
function createHarness({ gate = () => undefined, read = undefined } = {}) {
  const reads = []
  const bitmaps = []
  const fallbackCalls = []
  const decodes = { active: 0, peak: 0 }
  const createStore = (revision) => ({
    async read(id) {
      reads.push(id)
      if (read) return read(id, revision)
      return { id, revision }
    },
  })
  async function decode(blob) {
    decodes.active += 1
    decodes.peak = Math.max(decodes.peak, decodes.active)
    try {
      await gate(blob.id)
      const bitmap = createBitmap(`${blob.id}#${blob.revision}`, blob.size ?? sizeOf(blob.id))
      bitmaps.push(bitmap)
      return bitmap
    } finally {
      decodes.active -= 1
    }
  }
  const fallbackFront = Object.freeze({
    id: 'fallback-front',
    create(cardId, options) {
      fallbackCalls.push(['front', cardId, options])
      return createRecordingCanvas(300, 420)
    },
  })
  const fallbackBack = Object.freeze({
    id: 'fallback-back',
    create(options) {
      fallbackCalls.push(['back', options])
      return createRecordingCanvas(300, 420)
    },
  })
  const themes = createTarotHdThemes({ decode, fallbackFront, fallbackBack })
  const bitmap = (id) => bitmaps.find((candidate) => candidate.id === id)
  return {
    themes,
    reads,
    bitmaps,
    bitmap,
    decodes,
    fallbackCalls,
    activate: ({ revision = 1, ...options } = {}) => themes.activate({
      store: createStore(revision),
      manifest: TAROT_HD_ASSETS,
      ...options,
    }),
    createFront: (cardId, scale = 2) => themes.frontTheme.create(cardId, { scale, createCanvas: createRecordingCanvas }),
    refine: (cardId, canvas, signal = new AbortController().signal) => (
      themes.frontTheme.refine(cardId, { scale: 2, canvas, signal })
    ),
  }
}

const drawCalls = (canvas) => canvas.operations.filter(([operation]) => operation === 'drawImage')

test('Tarot HD descriptors are stable, frozen and registrable', () => {
  const { themes } = createHarness()
  assert.equal(themes.frontTheme.id, TAROT_HD_FRONT_THEME_ID)
  assert.equal(themes.backTheme.id, TAROT_HD_BACK_THEME_ID)
  assert.deepEqual(Object.keys(themes.frontTheme), ['id', 'create', 'refine'])
  assert.deepEqual(Object.keys(themes.backTheme), ['id', 'create'])
  assert.ok(Object.isFrozen(themes) && Object.isFrozen(themes.frontTheme) && Object.isFrozen(themes.backTheme))
  assert.equal(themes.active, false)
  assert.equal(TAROT_HD_DECODE_CONCURRENCY, 2)

  const registry = createThemeRegistry({ frontThemes: [themes.frontTheme], backThemes: [themes.backTheme] })
  assert.equal(registry.resolveFront(TAROT_HD_FRONT_THEME_ID).refine, themes.frontTheme.refine)
  assert.equal(registry.resolveBack(TAROT_HD_BACK_THEME_ID).create, themes.backTheme.create)
})

test('createTarotHdThemes validates the decoder and fallbacks', () => {
  assert.throws(() => createTarotHdThemes({ decode: null }), /decode must be a function/)
  assert.throws(() => createTarotHdThemes({ fallbackFront: {} }), /fallbackFront must be a theme descriptor/)
  assert.throws(() => createTarotHdThemes({ fallbackBack: null }), /fallbackBack must be a theme descriptor/)
})

test('preview cells follow CARD_IDS order in 8 columns, with the back last', () => {
  assert.deepEqual(
    { ...TAROT_HD_PREVIEW_LAYOUT },
    { columns: 8, rows: 7, cellWidth: 150, cellHeight: 210, width: 1200, height: 1470 },
  )
  ;[...CARD_IDS, 'back'].forEach((id, index) => {
    assert.deepEqual(getTarotHdPreviewCell(id), {
      x: (index % 8) * 150,
      y: Math.floor(index / 8) * 210,
      width: 150,
      height: 210,
    }, id)
  })
  assert.throws(() => getTarotHdPreviewCell('preview'), RangeError)
})

test('create() draws the preview cell, smoothed, at the capped texture scale', async () => {
  const harness = createHarness()
  await harness.activate()
  assert.equal(harness.themes.active, true)
  const cell = getTarotHdPreviewCell('c-QH')
  for (const [scale, width, height] of [[1, 300, 420], [2, 600, 840], [3, 600, 840], [4, 600, 840]]) {
    const canvas = harness.createFront('c-QH', scale)
    assert.deepEqual([canvas.width, canvas.height], [width, height], `scale ${scale}`)
    assert.deepEqual(canvas.operations, [
      ['scale', width / 300, width / 300],
      ['clearRect', 0, 0, 300, 420],
      ['drawImage', 'preview#1', cell.x, cell.y, 150, 210, 0, 0, 300, 420, true, 'high'],
    ], `scale ${scale}`)
  }
  const defaultCanvas = harness.themes.frontTheme.create('c-2S', { createCanvas: createRecordingCanvas })
  assert.deepEqual([defaultCanvas.width, defaultCanvas.height], [600, 840])
  assert.throws(() => harness.createFront('back'), RangeError)
  assert.throws(() => harness.createFront('c-2S', 5), TypeError)
  assert.throws(() => harness.themes.frontTheme.create('c-2S', null), TypeError)
})

test('the back draws its full-size bitmap and needs no refinement', async () => {
  const harness = createHarness()
  await harness.activate()
  for (const [scale, width, height] of [[1, 300, 420], [3, 600, 840]]) {
    const canvas = harness.themes.backTheme.create({ scale, createCanvas: createRecordingCanvas })
    assert.deepEqual([canvas.width, canvas.height], [width, height])
    assert.deepEqual(drawCalls(canvas), [['drawImage', 'back#1', 0, 0, 600, 840, 0, 0, 300, 420, true, 'high']])
  }
  assert.equal(harness.themes.backTheme.refine, undefined)
})

test('refine() redraws the same canvas from the full image and closes the bitmap', async () => {
  const harness = createHarness()
  await harness.activate()
  for (const [scale, width, height] of [[1, 300, 420], [2, 600, 840]]) {
    const canvas = harness.createFront('c-7D', scale)
    canvas.operations.length = 0
    assert.equal(await harness.refine('c-7D', canvas), undefined)
    assert.deepEqual(canvas.operations, [
      ['save'],
      ['setTransform', 1, 0, 0, 1, 0, 0],
      ['clearRect', 0, 0, width, height],
      ['drawImage', 'c-7D#1', 0, 0, 600, 840, 0, 0, width, height, true, 'high'],
      ['restore'],
    ])
  }
  assert.deepEqual(harness.reads, ['preview', 'back', 'c-7D', 'c-7D'])
  const full = harness.bitmaps.filter(({ id }) => id === 'c-7D#1')
  assert.equal(full.length, 2)
  assert.ok(full.every(({ closed }) => closed === 1))
  assert.equal(harness.bitmap('preview#1').closed, 0)
  await assert.rejects(harness.themes.frontTheme.refine('c-7D', { scale: 2, canvas: null }), TypeError)
})

test('an aborted refinement draws nothing and closes its bitmap', async () => {
  const held = createDeferred()
  const harness = createHarness({ gate: (id) => (id === 'c-9C' ? held.promise : undefined) })
  await harness.activate()

  const early = harness.createFront('c-8C')
  const earlyController = new AbortController()
  earlyController.abort()
  await harness.refine('c-8C', early, earlyController.signal)
  assert.equal(drawCalls(early).length, 1)
  assert.ok(!harness.reads.includes('c-8C'), 'an aborted refinement never reads')

  const late = harness.createFront('c-9C')
  const lateController = new AbortController()
  const refinement = harness.refine('c-9C', late, lateController.signal)
  await flush()
  lateController.abort()
  held.resolve()
  await refinement
  assert.equal(drawCalls(late).length, 1)
  assert.equal(harness.bitmap('c-9C#1').closed, 1)
})

test('no more than two decodes run at once', async () => {
  const pending = []
  const harness = createHarness({
    gate(id) {
      const deferred = createDeferred()
      pending.push({ id, resolve: deferred.resolve })
      return deferred.promise
    },
  })
  const activation = harness.activate()
  await flush()
  assert.deepEqual(pending.map(({ id }) => id), ['preview', 'back'])
  pending.splice(0).forEach(({ resolve }) => resolve())
  await activation

  const cards = CARD_IDS.slice(0, 7)
  const canvases = cards.map((cardId) => harness.createFront(cardId))
  const refinements = cards.map((cardId, index) => harness.refine(cardId, canvases[index]))
  await flush()
  assert.equal(pending.length, 2)
  assert.equal(harness.reads.length, 4, 'queued refinements have not read yet')
  while (pending.length > 0) {
    assert.ok(pending.length <= TAROT_HD_DECODE_CONCURRENCY)
    assert.equal(harness.decodes.active, pending.length)
    pending.shift().resolve()
    await flush()
  }
  await Promise.all(refinements)
  assert.equal(harness.decodes.peak, 2)
  cards.forEach((cardId, index) => {
    assert.equal(drawCalls(canvases[index]).at(-1)[1], `${cardId}#1`)
  })
  assert.ok(harness.bitmaps.every(({ id, closed }) => (id.startsWith('c-') ? closed === 1 : closed === 0)))
})

test('refinement failures reject with typed missing and decode errors', async () => {
  const harness = createHarness({
    gate(id) {
      if (id === 'c-3S') throw new Error('corrupt')
    },
    read(id, revision) {
      if (id === 'c-2S') throw Object.assign(new Error('not stored'), { code: 'missing' })
      if (id === 'c-4S') return { id, revision, size: { width: 300, height: 420 } }
      return { id, revision }
    },
  })
  await harness.activate()
  const failures = [
    ['c-2S', 'missing'],
    ['c-3S', 'decode'],
    ['c-4S', 'decode'],
  ]
  for (const [cardId, code] of failures) {
    const canvas = harness.createFront(cardId)
    await assert.rejects(harness.refine(cardId, canvas), (error) => {
      assert.ok(error instanceof TarotHdArtError)
      assert.equal(error.code, code)
      assert.equal(error.assetId, cardId)
      return true
    })
    assert.equal(drawCalls(canvas).length, 1, `${cardId}: the preview stays`)
  }
  assert.equal(harness.bitmap('c-4S#1').closed, 1, 'a wrong-size decode is closed')

  const failing = createTarotHdThemes({
    decode: async () => {
      throw new Error('corrupt')
    },
  })
  await assert.rejects(
    failing.activate({ store: { read: async (id) => ({ id }) }, manifest: TAROT_HD_ASSETS }),
    (error) => error instanceof TarotHdArtError && error.code === 'decode' && error.cause?.message === 'corrupt',
  )
})

test('after release(), create() draws the pixel card and refinement resolves without drawing', async () => {
  const held = createDeferred()
  const harness = createHarness({ gate: (id) => (id === 'c-5C' ? held.promise : undefined) })
  await harness.activate()
  const canvas = harness.createFront('c-5C')
  const refinement = harness.refine('c-5C', canvas)
  await flush()

  harness.themes.release()
  assert.equal(harness.themes.active, false)
  assert.equal(harness.bitmap('preview#1').closed, 1)
  assert.equal(harness.bitmap('back#1').closed, 1)
  held.resolve()
  await refinement
  assert.equal(drawCalls(canvas).length, 1)
  assert.equal(harness.bitmap('c-5C#1').closed, 1)

  const options = { scale: 2, createCanvas: createRecordingCanvas }
  const fallbackFront = harness.themes.frontTheme.create('c-5C', options)
  const fallbackBack = harness.themes.backTheme.create(options)
  assert.deepEqual(harness.fallbackCalls, [['front', 'c-5C', options], ['back', options]])
  assert.equal(drawCalls(fallbackFront).length, 0)
  assert.equal(drawCalls(fallbackBack).length, 0)

  const readsBefore = harness.reads.length
  await harness.refine('c-5C', fallbackFront)
  assert.equal(harness.reads.length, readsBefore)
  assert.equal(fallbackFront.operations.length, 0)
  harness.themes.release()
})

test('the same descriptors work again after a second activate()', async () => {
  const harness = createHarness()
  const { frontTheme, backTheme } = harness.themes
  await harness.activate({ revision: 1 })
  harness.themes.release()
  await harness.activate({ revision: 2 })
  assert.equal(harness.themes.frontTheme, frontTheme)
  assert.equal(harness.themes.backTheme, backTheme)

  const canvas = harness.createFront('c-AH')
  assert.equal(drawCalls(canvas)[0][1], 'preview#2')
  await harness.refine('c-AH', canvas)
  assert.equal(drawCalls(canvas).at(-1)[1], 'c-AH#2')
  const back = backTheme.create({ scale: 2, createCanvas: createRecordingCanvas })
  assert.equal(drawCalls(back)[0][1], 'back#2')

  await harness.activate({ revision: 3 })
  assert.equal(harness.bitmap('preview#2').closed, 1, 'a new activation closes the previous bitmaps')
  assert.equal(harness.bitmap('back#2').closed, 1)
  assert.equal(drawCalls(harness.createFront('c-AH'))[0][1], 'preview#3')
})

test('activate() validates its inputs and closes partial decodes when it fails', async () => {
  const harness = createHarness()
  const store = { read: async (id) => ({ id, revision: 1 }) }
  await assert.rejects(harness.themes.activate({ manifest: TAROT_HD_ASSETS }), /store must provide read/)
  await assert.rejects(
    harness.themes.activate({ store, manifest: TAROT_HD_ASSETS.slice(1) }),
    /manifest must list the Tarot HD assets/,
  )
  await assert.rejects(
    harness.themes.activate({ store, manifest: TAROT_HD_ASSETS, signal: {} }),
    /signal must be an AbortSignal/,
  )
  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(harness.activate({ signal: aborted.signal }), { name: 'AbortError' })
  assert.deepEqual(harness.reads, [])

  const missingBack = createHarness({
    read(id, revision) {
      if (id === 'back') throw new Error('gone')
      return { id, revision }
    },
  })
  await assert.rejects(missingBack.activate(), { name: 'TarotHdArtError', code: 'missing', assetId: 'back' })
  assert.equal(missingBack.bitmap('preview#1').closed, 1)
  assert.equal(missingBack.themes.active, false)

  const held = createDeferred()
  const superseded = createHarness({ gate: () => held.promise })
  const activation = superseded.activate()
  await flush()
  superseded.themes.release()
  held.resolve()
  await assert.rejects(activation, { name: 'AbortError' })
  assert.equal(superseded.themes.active, false)
  assert.ok(superseded.bitmaps.length === 2 && superseded.bitmaps.every(({ closed }) => closed === 1))

  const late = createDeferred()
  const cancelled = createHarness({ gate: () => late.promise })
  const controller = new AbortController()
  const cancelledActivation = cancelled.activate({ signal: controller.signal })
  await flush()
  controller.abort()
  late.resolve()
  await assert.rejects(cancelledActivation, { name: 'AbortError' })
  assert.ok(cancelled.bitmaps.every(({ closed }) => closed === 1))
  assert.equal(cancelled.themes.active, false)
})

test('the texture cache shows the preview first and re-uploads once after refinement', async () => {
  const harness = createHarness()
  await harness.activate()
  const updates = []
  const registry = createThemeRegistry({
    frontThemes: [harness.themes.frontTheme],
    backThemes: [harness.themes.backTheme],
  })
  const cache = createTextureCache({
    registry,
    createCanvas: createRecordingCanvas,
    textureFactory: (canvas) => ({ image: canvas, dispose() {} }),
    onTextureUpdate: (update) => updates.push(update),
  })
  const lease = cache.acquireFront({ themeId: TAROT_HD_FRONT_THEME_ID, cardId: 'c-KS', scale: 3 })
  const canvas = lease.texture.image
  assert.deepEqual([canvas.width, canvas.height], [600, 840])
  assert.deepEqual(drawCalls(canvas).map(([, image]) => image), ['preview#1'])
  assert.equal(cache.getStats().refining, 1)
  lease.texture.needsUpdate = false

  await flush()
  assert.deepEqual(drawCalls(canvas).map(([, image]) => image), ['preview#1', 'c-KS#1'])
  assert.equal(lease.texture.needsUpdate, true)
  assert.deepEqual(updates, [{ kind: 'front', themeId: TAROT_HD_FRONT_THEME_ID, cardId: 'c-KS', scale: 3 }])
  assert.equal(cache.getStats().refining, 0)

  const back = cache.acquireBack({ themeId: TAROT_HD_BACK_THEME_ID, scale: 2 })
  assert.deepEqual(drawCalls(back.texture.image).map(([, image]) => image), ['back#1'])
  assert.equal(cache.getStats().refining, 0)
  lease.release()
  back.release()
  cache.destroy()
  harness.themes.release()
})

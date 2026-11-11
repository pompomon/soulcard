import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { CARD_IDS } from '../../src/domain/cards.js'
import {
  TAROT_LAYOUT,
  getTarotComposition,
  getTarotPipBox,
} from '../../src/presentation/themes/tarot-composition.js'
import {
  HD_CARTOUCHE_INTERIOR,
  HD_COMPONENTS,
  HD_NUMERAL_GAP,
  HD_SOURCE_DIR,
  composeBackSvg,
  composeCardSvg,
  getWindowPath,
  loadComponents,
  readComponent,
} from '../../tools/card-art/hd-compose.mjs'

const XMLNS = 'xmlns="http://www.w3.org/2000/svg"'
const svg = (width, height, body, attributes = '') => (
  `<svg ${XMLNS} viewBox="0 0 ${width} ${height}"${attributes}>${body}</svg>`
)

// Every component as a single named marker, so each placement in a composed
// card can be traced back to its component.
function markerComponents() {
  return new Map(Object.entries(HD_COMPONENTS).map(([name, { width, height }]) => [
    name,
    readComponent(name, svg(width, height, `<rect id="${name}" width="1" height="1" fill="none"/>`)),
  ]))
}

const PLACEMENT = /<svg x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)" viewBox="0 0 [^"]+"><rect id="c\d+-([\w-]+)"/g

function readPlacements(document) {
  const rotated = document.indexOf('<g transform="rotate(180 150 210)">')
  const clip = document.indexOf('<g clip-path="url(#tarot-window)">')
  const clipEnd = document.indexOf('</g>', clip)
  return [...document.matchAll(PLACEMENT)].map((match) => ({
    name: match[5],
    box: { x: Number(match[1]), y: Number(match[2]), width: Number(match[3]), height: Number(match[4]) },
    rotated: rotated >= 0 && match.index > rotated,
    inWindow: match.index > clip && match.index < clipEnd,
  }))
}

function assertBox(actual, expected, message) {
  for (const key of ['x', 'y', 'width', 'height']) {
    assert.ok(Math.abs(actual[key] - expected[key]) < 1e-3, `${message}: ${key} ${actual[key]} ≠ ${expected[key]}`)
  }
}

function assertWithin(box, bounds, message) {
  assert.ok(
    box.x >= bounds.x - 1e-3 && box.y >= bounds.y - 1e-3
      && box.x + box.width <= bounds.x + bounds.width + 1e-3
      && box.y + box.height <= bounds.y + bounds.height + 1e-3,
    message,
  )
}

function readIds(document) {
  return [...document.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1])
}

test('every committed HD component passes validation', () => {
  const components = loadComponents()
  assert.deepEqual([...components.keys()], Object.keys(HD_COMPONENTS))
  for (const [name, component] of components) {
    assert.equal(component.width, HD_COMPONENTS[name].width, name)
    assert.equal(component.height, HD_COMPONENTS[name].height, name)
    assert.notEqual(component.body, '', name)
  }
})

test('readComponent rejects unsafe, malformed or off-spec SVG', () => {
  const cases = [
    ['ace-cups', 'nope', /text content is not allowed/],
    ['ace-cups', '', /is not a complete <svg> document/],
    ['unknown', svg(1, 1, ''), /is not a Tarot HD component/],
    ['pip-cups', svg(36, 36, '<text x="1" y="9">A</text>'), /<text> is not allowed/],
    ['pip-cups', svg(36, 36, '<style>rect{fill:red}</style>'), /<style> is not allowed/],
    ['pip-cups', svg(36, 36, '<script>alert(1)</script>'), /<script> is not allowed/],
    ['pip-cups', svg(36, 36, '<image href="https://example.com/a.png" width="9" height="9"/>'), /<image> is not allowed/],
    ['pip-cups', svg(36, 36, '<use href="#a"/>'), /<use> is not allowed/],
    ['pip-cups', svg(36, 36, '<rect width="9" height="9" style="fill:red"/>'), /may not set style/],
    ['pip-cups', svg(36, 36, '<rect width="9" height="9" onclick="x()"/>'), /may not set onclick/],
    ['pip-cups', svg(36, 36, '<rect width="9" height="9" fill="url(https://example.com/a#b)"/>'), /is not allowed/],
    ['pip-cups', svg(36, 36, '<rect width="9" height="9" clip-path="url(https://example.com/a#b)"/>'), /clip-path may only reference a local id/],
    ['pip-cups', svg(36, 36, '<rect width="9" height="9" fill="red"/>'), /fill="red" is not allowed/],
    ['pip-cups', svg(36, 36, '<rect width="9" height="9" fill="url(#missing)"/>'), /references undefined id "missing"/],
    ['pip-cups', svg(36, 36, '<rect id="a" width="1" height="1"/><rect id="a" width="1" height="1"/>'), /duplicate id "a"/],
    ['pip-cups', svg(36, 36, '<rect width="9" height="9" fill="#ffffff" fill="#000000"/>'), /repeats fill/],
    ['pip-cups', svg(36, 36, '<g><rect width="9" height="9"/>'), /unbalanced|not a complete/],
    ['pip-cups', svg(36, 36, '<rect width=\'9\' height=\'9\'/>'), /text content is not allowed|malformed/],
    ['pip-cups', svg(36, 36, 'loose text'), /text content is not allowed/],
    ['pip-cups', svg(36, 36, '<svg viewBox="0 0 1 1"/>'), /nested <svg> is not allowed/],
    ['pip-cups', `${svg(36, 36, '')}${svg(36, 36, '')}`, /single <svg> root/],
    ['pip-cups', `<!DOCTYPE svg [<!ENTITY a "b">]>${svg(36, 36, '')}`, /declarations/],
    ['pip-cups', svg(30, 36, ''), /viewBox must be "0 0 36 36"/],
    ['pip-cups', svg(36, 36, '', ' width="72"'), /width must be 36/],
    ['pip-cups', svg(36, 36, '', ' style="color:red"'), /root <svg> may not set style/],
    ['pip-cups', '<svg viewBox="0 0 36 36"></svg>', /xmlns must be/],
    ['rank-2', svg(28, 28, '<path d="M0 0H9" stroke="#18141f"/>'), /stroke="#18141f" is not allowed/],
    ['rank-2', svg(28, 28, '<path d="M0 0H9" stroke="currentColor" opacity="0.5"/>'), /index ink may not set opacity/],
    ['suit-H', svg(28, 28, '<linearGradient id="g"/>'), /index ink may not use <linearGradient>/],
  ]
  for (const [name, source, error] of cases) {
    assert.throws(() => readComponent(name, source), error, `${name}: ${source}`)
  }
})

test('readComponent strips comments and the XML declaration and keeps the body', () => {
  const component = readComponent('rank-A', `\uFEFF<?xml version="1.0"?>\n<!-- index -->\n${
    svg(28, 28, '<path d="M2 26L14 2L26 26" fill="none" stroke="currentColor" stroke-width="3"/>')}\n`)
  assert.equal(component.width, 28)
  assert.equal(component.height, 28)
  assert.equal(component.body, '<path d="M2 26L14 2L26 26" fill="none" stroke="currentColor" stroke-width="3"/>')
  assert.ok(Object.isFrozen(component))
})

test('loadComponents requires exactly the expected component files', (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'soulcard-hd-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  cpSync(HD_SOURCE_DIR, directory, { recursive: true })
  assert.equal(loadComponents(directory).size, Object.keys(HD_COMPONENTS).length)

  writeFileSync(path.join(directory, 'extra.svg'), svg(1, 1, ''))
  assert.throws(() => loadComponents(directory), /Unexpected files .*extra\.svg/)
  unlinkSync(path.join(directory, 'extra.svg'))

  unlinkSync(path.join(directory, 'pip-cups.svg'))
  assert.throws(() => loadComponents(directory), /Missing components .*pip-cups\.svg/)
})

test('composed cards place the frame, cartouche, window art and indices from the composition', () => {
  const components = markerComponents()
  for (const cardId of CARD_IDS) {
    const composition = getTarotComposition(cardId)
    const document = composeCardSvg(cardId, components)
    const placements = readPlacements(document)

    assert.equal(placements[0].name, 'frame', cardId)
    assertBox(placements[0].box, { x: 0, y: 0, width: 300, height: 420 }, `${cardId} frame`)

    const cartouche = placements.filter(({ name }) => /^(numeral-|cartouche-sun|title-)/.test(name))
    const expectedCartouche = {
      numeral: () => [...composition.cartouche.text].map((letter) => `numeral-${letter}`),
      sun: () => ['cartouche-sun'],
      title: () => [`title-${composition.cartouche.text.toLowerCase()}`],
    }[composition.cartouche.kind]()
    assert.deepEqual(cartouche.map(({ name }) => name), expectedCartouche, cardId)
    for (const { box } of cartouche) assertWithin(box, HD_CARTOUCHE_INTERIOR, `${cardId} cartouche`)
    const left = cartouche[0].box.x - HD_CARTOUCHE_INTERIOR.x
    const last = cartouche.at(-1).box
    const right = HD_CARTOUCHE_INTERIOR.x + HD_CARTOUCHE_INTERIOR.width - last.x - last.width
    assert.ok(Math.abs(left - right) < 1e-3, `${cardId}: the cartouche content is centred`)
    for (let index = 1; index < cartouche.length; index += 1) {
      const previous = cartouche[index - 1].box
      assert.ok(Math.abs(cartouche[index].box.x - previous.x - previous.width - HD_NUMERAL_GAP) < 1e-3, cardId)
    }

    const windowArt = placements.filter(({ inWindow }) => inWindow)
    if (composition.kind === 'pips') {
      assert.equal(windowArt.length, composition.pips.length, cardId)
      composition.pips.forEach((point, index) => {
        assert.equal(windowArt[index].name, `pip-${composition.tarotSuit}`, cardId)
        assertBox(windowArt[index].box, getTarotPipBox(point), `${cardId} pip ${index}`)
      })
    } else {
      assert.deepEqual(windowArt.map(({ name }) => name), [composition.figureId], cardId)
      assertBox(windowArt[0].box, TAROT_LAYOUT.window, `${cardId} figure`)
    }

    const indices = placements.filter(({ name }) => /^(rank|suit)-/.test(name))
    assert.deepEqual(
      indices.map(({ name, rotated }) => [name, rotated]),
      [
        [`rank-${composition.rank}`, false],
        [`suit-${composition.suit}`, false],
        [`rank-${composition.rank}`, true],
        [`suit-${composition.suit}`, true],
      ],
      cardId,
    )
    indices.forEach(({ box }, index) => {
      assertBox(box, index % 2 === 0 ? TAROT_LAYOUT.index.rank : TAROT_LAYOUT.index.suit, `${cardId} index`)
    })
    assert.ok(document.includes(`<g color="${composition.index.color}">`), cardId)
    assert.equal(placements.length, 1 + cartouche.length + windowArt.length + indices.length, cardId)
  }
})

test('composed documents render at 1200×1680 with unique ids, resolved references and no text', () => {
  const components = loadComponents()
  const documents = [
    ...CARD_IDS.map((cardId) => [cardId, composeCardSvg(cardId, components)]),
    ['back', composeBackSvg(components)],
  ]
  for (const [id, document] of documents) {
    assert.match(document, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="1200" height="1680" viewBox="0 0 300 420">/, id)
    assert.doesNotMatch(document, /<(text|image|use|style|script|foreignObject)\b/, id)
    const ids = readIds(document)
    assert.equal(new Set(ids).size, ids.length, `${id}: duplicate ids`)
    for (const [, reference] of document.matchAll(/url\(#([^)]+)\)/g)) {
      assert.ok(ids.includes(reference), `${id}: url(#${reference}) is undefined`)
    }
    if (id === 'back') continue
    const composition = getTarotComposition(id)
    const pips = document.split(`viewBox="0 0 ${TAROT_LAYOUT.pip.width} ${TAROT_LAYOUT.pip.height}"`).length - 1
    assert.equal(pips, composition.kind === 'pips' ? composition.pips.length : 0, `${id}: pips`)
    assert.ok(document.includes(`<clipPath id="tarot-window"><path d="${getWindowPath()}"/></clipPath>`), id)
  }
})

test('the HD window path follows the shared arched window', () => {
  assert.equal(getWindowPath(), 'M68 380V112A82 48 0 0 1 232 112V380Z')
})

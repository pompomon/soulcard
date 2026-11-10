// Composes the Tarot (HD) card SVGs from the components in art/tarot-hd/ and
// validates those components. Node built-ins only, so the unit tests can check
// the sources without the native rasterizer; build-hd.mjs renders the result.
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  TAROT_LAYOUT,
  TAROT_LOGICAL_SIZE,
  getTarotComposition,
  getTarotPipBox,
} from '../../src/presentation/themes/tarot-composition.js'

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const HD_SOURCE_DIR = path.join(REPO_ROOT, 'art/tarot-hd')
export const HD_OUTPUT_DIR = path.join(REPO_ROOT, 'src/assets/card-art/tarot-hd')
export const HD_MODULE_PATH = path.join(REPO_ROOT, 'src/presentation/themes/tarot-hd-assets.js')
// Sources render at 4× the logical card (1200×1680) before downsampling.
export const HD_RENDER_SCALE = 4
export const HD_FILE_PREFIX = 'tarot-hd-art-'
// The whole pack, in bytes (plan §10, question 7).
export const HD_PACK_BUDGET_BYTES = 8_000_000

// Besides every file in art/tarot-hd/, these inputs determine the pack, so the
// generated module records their digest and the unit tests detect a stale pack.
export const HD_TOOL_INPUTS = Object.freeze([
  'tools/card-art/hd-compose.mjs',
  'tools/card-art/build-hd.mjs',
  'tools/card-art/package-lock.json',
  'src/presentation/themes/tarot-composition.js',
  'src/presentation/themes/tarot-hd-layout.js',
])

const SUITS = ['cups', 'pentacles', 'wands', 'swords']
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A']
const CARD_SUITS = ['S', 'H', 'D', 'C']
const COURTS = ['page', 'queen', 'king']

// Art components use literal colours; ink components (the indices) paint only
// with currentColor so the composer can apply the index colour.
const art = ({ width, height }) => Object.freeze({ width, height, ink: false })
const ink = ({ width, height }) => Object.freeze({ width, height, ink: true })
const size = (width, height) => ({ width, height })

export const HD_COMPONENTS = Object.freeze(Object.fromEntries([
  ['frame', art(TAROT_LOGICAL_SIZE)],
  ['back', art(TAROT_LOGICAL_SIZE)],
  ...RANKS.map((rank) => [`rank-${rank}`, ink(TAROT_LAYOUT.index.rank)]),
  ...CARD_SUITS.map((suit) => [`suit-${suit}`, ink(TAROT_LAYOUT.index.suit)]),
  ['numeral-I', art(size(7, 18))],
  ['numeral-V', art(size(14, 18))],
  ['numeral-X', art(size(14, 18))],
  ['cartouche-sun', art(size(28, 28))],
  ['title-page', art(size(44, 16))],
  ['title-queen', art(size(56, 16))],
  ['title-king', art(size(42, 16))],
  ...SUITS.map((suit) => [`pip-${suit}`, art(TAROT_LAYOUT.pip)]),
  ...SUITS.map((suit) => [`ace-${suit}`, art(TAROT_LAYOUT.window)]),
  ...COURTS.flatMap((court) => SUITS.map((suit) => [`${court}-${suit}`, art(TAROT_LAYOUT.window)])),
]))

// Cartouche content is centred inside the cartouche's 4 px border.
const CARTOUCHE_INSET = 4
export const HD_CARTOUCHE_INTERIOR = Object.freeze({
  x: TAROT_LAYOUT.cartouche.x + CARTOUCHE_INSET,
  y: TAROT_LAYOUT.cartouche.y + CARTOUCHE_INSET,
  width: TAROT_LAYOUT.cartouche.width - CARTOUCHE_INSET * 2,
  height: TAROT_LAYOUT.cartouche.height - CARTOUCHE_INSET * 2,
})
export const HD_NUMERAL_GAP = 1.5

const ELEMENTS = new Set([
  'svg', 'g', 'defs', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'linearGradient', 'radialGradient', 'stop', 'clipPath',
])
const INK_ELEMENTS = new Set(['g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon'])
const ROOT_ATTRIBUTES = new Set(['xmlns', 'viewBox', 'width', 'height'])
const ATTRIBUTES = new Set([
  'id', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'fx', 'fy',
  'width', 'height', 'd', 'points', 'transform', 'opacity', 'clip-path', 'clip-rule',
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity',
  'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray',
  'stroke-dashoffset', 'offset', 'stop-color', 'stop-opacity', 'gradientUnits',
  'gradientTransform', 'spreadMethod', 'clipPathUnits',
])
const PAINT_ATTRIBUTES = new Set(['fill', 'stroke', 'stop-color'])
const INK_FORBIDDEN_ATTRIBUTES = new Set(['opacity', 'fill-opacity', 'stroke-opacity', 'clip-path'])
const ART_PAINT = /^(?:none|#[0-9a-f]{6}|url\(#[A-Za-z][\w-]*\))$/
const INK_PAINT = /^(?:none|currentColor)$/
const ID_PATTERN = /^[A-Za-z][\w-]*$/
const LOCAL_REFERENCE = /^url\(#[A-Za-z][\w-]*\)$/
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
const TAG = /<(\/?)([A-Za-z][\w:-]*)((?:\s+[A-Za-z][\w:-]*\s*=\s*"[^"<]*")*)\s*(\/?)>/g
const ATTRIBUTE = /([A-Za-z][\w:-]*)\s*=\s*"([^"<]*)"/g
const REFERENCE = /url\(#([^)]*)\)/g

function fail(name, message) {
  throw new Error(`${name}.svg: ${message}`)
}

function readAttributes(name, element, source) {
  const attributes = new Map()
  for (const [, key, value] of source.matchAll(ATTRIBUTE)) {
    if (attributes.has(key)) fail(name, `<${element}> repeats ${key}`)
    attributes.set(key, value)
  }
  return attributes
}

function checkRoot(name, attributes, spec) {
  for (const key of attributes.keys()) {
    if (!ROOT_ATTRIBUTES.has(key)) fail(name, `the root <svg> may not set ${key}`)
  }
  if (attributes.get('xmlns') !== SVG_NAMESPACE) fail(name, `xmlns must be ${SVG_NAMESPACE}`)
  const viewBox = `0 0 ${spec.width} ${spec.height}`
  if (attributes.get('viewBox') !== viewBox) fail(name, `viewBox must be "${viewBox}"`)
  for (const key of ['width', 'height']) {
    if (attributes.has(key) && attributes.get(key) !== String(spec[key])) {
      fail(name, `${key} must be ${spec[key]}`)
    }
  }
}

function checkAttributes(name, element, attributes, spec, ids, references) {
  for (const [key, value] of attributes) {
    if (!ATTRIBUTES.has(key)) fail(name, `<${element}> may not set ${key}`)
    if (spec.ink && INK_FORBIDDEN_ATTRIBUTES.has(key)) {
      fail(name, `index ink may not set ${key}`)
    }
    if (PAINT_ATTRIBUTES.has(key) && !(spec.ink ? INK_PAINT : ART_PAINT).test(value)) {
      fail(name, `<${element}> ${key}="${value}" is not allowed`)
    }
    if (value.includes('url(') && !LOCAL_REFERENCE.test(value)) {
      fail(name, `<${element}> ${key} may only reference a local id`)
    }
    if (key === 'id') {
      if (!ID_PATTERN.test(value)) fail(name, `invalid id "${value}"`)
      if (ids.has(value)) fail(name, `duplicate id "${value}"`)
      ids.add(value)
    }
    for (const [, reference] of value.matchAll(REFERENCE)) references.add(reference)
  }
}

// Parses one component and checks the authoring rules in art/README.md: a
// fixed viewBox, plain shapes and gradients only (no text, images, styles,
// scripts or external references), and local ids.
export function readComponent(name, source) {
  const spec = HD_COMPONENTS[name]
  if (!spec) fail(name, 'is not a Tarot HD component')
  if (typeof source !== 'string') fail(name, 'source must be a string')
  const text = source
    .replace(/^\uFEFF/, '')
    .replace(/^\s*<\?xml[^?]*\?>/, '')
    .replace(/<!--[\s\S]*?-->/g, '')
  if (/<[!?]/.test(text)) fail(name, 'declarations, CDATA and processing instructions are not allowed')

  const stack = []
  const ids = new Set()
  const references = new Set()
  let rootAttributes = null
  let bodyStart = -1
  let bodyEnd = -1
  let cursor = 0
  for (const match of text.matchAll(TAG)) {
    const [tag, closing, element, attributeSource, selfClosing] = match
    if (text.slice(cursor, match.index).trim() !== '') fail(name, 'text content is not allowed')
    cursor = match.index + tag.length
    if (!ELEMENTS.has(element)) fail(name, `<${element}> is not allowed`)
    if (spec.ink && element !== 'svg' && !INK_ELEMENTS.has(element)) {
      fail(name, `index ink may not use <${element}>`)
    }
    if (closing) {
      if (attributeSource.trim() !== '' || selfClosing) fail(name, `malformed </${element}>`)
      if (stack.pop() !== element) fail(name, `unbalanced </${element}>`)
      if (stack.length === 0) bodyEnd = match.index
      continue
    }
    const attributes = readAttributes(name, element, attributeSource)
    if (stack.length === 0) {
      if (rootAttributes !== null || element !== 'svg') fail(name, 'must have a single <svg> root')
      checkRoot(name, attributes, spec)
      rootAttributes = attributes
      bodyStart = cursor
    } else {
      if (element === 'svg') fail(name, 'nested <svg> is not allowed')
      checkAttributes(name, element, attributes, spec, ids, references)
    }
    if (!selfClosing) stack.push(element)
  }
  if (text.slice(cursor).trim() !== '') fail(name, 'text content is not allowed')
  if (rootAttributes === null || stack.length !== 0 || bodyEnd < 0) fail(name, 'is not a complete <svg> document')
  if (text.replace(TAG, '').includes('<') || text.replace(TAG, '').includes('>')) {
    fail(name, 'contains malformed markup')
  }
  for (const reference of references) {
    if (!ids.has(reference)) fail(name, `references undefined id "${reference}"`)
  }
  return Object.freeze({
    name,
    width: spec.width,
    height: spec.height,
    body: text.slice(bodyStart, bodyEnd).trim(),
  })
}

// Reads every component; a missing or unexpected file is an error.
export function loadComponents(sourceDir = HD_SOURCE_DIR) {
  const expected = Object.keys(HD_COMPONENTS).map((name) => `${name}.svg`)
  const present = readdirSync(sourceDir).sort()
  const unexpected = present.filter((file) => !expected.includes(file))
  if (unexpected.length > 0) throw new Error(`Unexpected files in ${sourceDir}: ${unexpected.join(', ')}`)
  const missing = expected.filter((file) => !present.includes(file))
  if (missing.length > 0) throw new Error(`Missing components in ${sourceDir}: ${missing.join(', ')}`)
  return new Map(Object.keys(HD_COMPONENTS).map((name) => [
    name,
    readComponent(name, readFileSync(path.join(sourceDir, `${name}.svg`), 'utf8')),
  ]))
}

const format = (value) => String(Number(value.toFixed(3)))

// Every placed component gets its own id prefix, so repeated pips and the
// rotated indices never share ids.
function place(component, { x, y, width, height }, prefix) {
  const body = component.body
    .replace(/\bid="([^"]+)"/g, `id="${prefix}$1"`)
    .replace(REFERENCE, `url(#${prefix}$1)`)
  return `<svg x="${format(x)}" y="${format(y)}" width="${format(width)}" height="${format(height)}"`
    + ` viewBox="0 0 ${component.width} ${component.height}">${body}</svg>`
}

function centreIn(box, { width, height }) {
  return {
    x: box.x + (box.width - width) / 2,
    y: box.y + (box.height - height) / 2,
    width,
    height,
  }
}

export function getWindowPath() {
  const { x, y, width, height, archHeight } = TAROT_LAYOUT.window
  const spring = y + archHeight
  return `M${x} ${y + height}V${spring}A${width / 2} ${archHeight} 0 0 1 ${x + width} ${spring}`
    + `V${y + height}Z`
}

function document(parts, defs = '') {
  const { width, height } = TAROT_LOGICAL_SIZE
  return `<svg xmlns="${SVG_NAMESPACE}" width="${width * HD_RENDER_SCALE}" height="${height * HD_RENDER_SCALE}"`
    + ` viewBox="0 0 ${width} ${height}">${defs}${parts.join('')}</svg>`
}

function getComponent(components, name) {
  const component = components.get(name)
  if (!component) throw new Error(`Missing Tarot HD component: ${name}`)
  return component
}

function cartoucheParts(cartouche, components, placeNext) {
  if (cartouche.kind === 'numeral') {
    const glyphs = [...cartouche.text].map((letter) => getComponent(components, `numeral-${letter}`))
    const width = glyphs.reduce((total, glyph) => total + glyph.width, 0)
      + HD_NUMERAL_GAP * (glyphs.length - 1)
    const height = Math.max(...glyphs.map((glyph) => glyph.height))
    const line = centreIn(HD_CARTOUCHE_INTERIOR, { width, height })
    let { x } = line
    return glyphs.map((glyph) => {
      const box = { x, y: line.y + height - glyph.height, width: glyph.width, height: glyph.height }
      x += glyph.width + HD_NUMERAL_GAP
      return placeNext(glyph, box)
    })
  }
  const name = cartouche.kind === 'sun' ? 'cartouche-sun' : `title-${cartouche.text.toLowerCase()}`
  const component = getComponent(components, name)
  return [placeNext(component, centreIn(HD_CARTOUCHE_INTERIOR, component))]
}

// One card front as an SVG document at the 1200×1680 render size. Layers: the
// frame, the cartouche content, the pips or figure clipped to the arched window,
// then the indices and their 180° copies in the index colour.
export function composeCardSvg(cardId, components) {
  const composition = getTarotComposition(cardId)
  let serial = 0
  const placeNext = (component, box) => {
    serial += 1
    return place(component, box, `c${serial}-`)
  }
  const frame = getComponent(components, 'frame')
  const parts = [placeNext(frame, { x: 0, y: 0, ...TAROT_LOGICAL_SIZE })]
  parts.push(...cartoucheParts(composition.cartouche, components, placeNext))

  const windowParts = composition.kind === 'pips'
    ? composition.pips.map((point) => placeNext(
      getComponent(components, `pip-${composition.tarotSuit}`),
      getTarotPipBox(point),
    ))
    : [placeNext(getComponent(components, composition.figureId), TAROT_LAYOUT.window)]
  parts.push('<g clip-path="url(#tarot-window)">', ...windowParts, '</g>')

  const rank = getComponent(components, `rank-${composition.rank}`)
  const suit = getComponent(components, `suit-${composition.suit}`)
  const indices = () => [
    placeNext(rank, TAROT_LAYOUT.index.rank),
    placeNext(suit, TAROT_LAYOUT.index.suit),
  ]
  const { width, height } = TAROT_LOGICAL_SIZE
  parts.push(
    `<g color="${composition.index.color}">`,
    ...indices(),
    `<g transform="rotate(180 ${width / 2} ${height / 2})">`,
    ...indices(),
    '</g></g>',
  )
  const defs = `<defs><clipPath id="tarot-window"><path d="${getWindowPath()}"/></clipPath></defs>`
  return document(parts, defs)
}

export function composeBackSvg(components) {
  return document([place(getComponent(components, 'back'), { x: 0, y: 0, ...TAROT_LOGICAL_SIZE }, 'b-')])
}

export function getAssetFileName(id) {
  return `${HD_FILE_PREFIX}${id}.webp`
}

export function listSourceInputs(root = REPO_ROOT) {
  const sources = readdirSync(path.join(root, 'art/tarot-hd'))
    .sort()
    .map((file) => `art/tarot-hd/${file}`)
  return [...sources, ...HD_TOOL_INPUTS]
}

// Line endings are normalized so a CRLF checkout computes the same digest.
export function computeSourceDigest(root = REPO_ROOT) {
  const hash = createHash('sha256')
  for (const relative of listSourceInputs(root)) {
    const text = readFileSync(path.join(root, relative), 'utf8').replace(/\r\n/g, '\n')
    hash.update(relative).update('\0').update(text).update('\0')
  }
  return hash.digest('hex')
}

export function renderAssetsModule(entries, sourceDigest) {
  const lines = [
    '// Generated by tools/card-art/build-hd.mjs from art/tarot-hd/. Do not edit;',
    '// regenerate with `npm --prefix tools/card-art run build:hd` (see art/README.md).',
    '// Each URL is a static literal so Vite emits the file with a content hash.',
    'const asset = (id, url, bytes, sha256) => Object.freeze({ id, url, bytes, sha256 })',
    '',
    `export const TAROT_HD_SOURCE_SHA256 = '${sourceDigest}'`,
    '',
    'export const TAROT_HD_ASSETS = Object.freeze([',
    ...entries.map(({ id, bytes, sha256 }) => (
      `  asset('${id}', new URL('../../assets/card-art/tarot-hd/${getAssetFileName(id)}', `
      + `import.meta.url).href, ${bytes}, '${sha256}'),`
    )),
    '])',
    '',
  ]
  return lines.join('\n')
}

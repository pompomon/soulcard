import assert from 'node:assert/strict'
import test from 'node:test'
import { CARDS } from '../../src/domain/cards.js'
import {
  CLASSIC_BACK_THEME_ID,
  CLASSIC_FRONT_THEME_ID,
} from '../../src/presentation/themes/classic.js'
import {
  createThemeRegistry,
  isThemeId,
} from '../../src/presentation/themes/registry.js'
import {
  ALTERNATE_BACK_THEME,
  ALTERNATE_FRONT_THEME,
  ALTERNATE_THEME_SELECTION,
  UNKNOWN_THEME_SELECTION,
} from '../fixtures/themes.js'

function createFixtureCanvas(width, height) {
  const operations = []
  const context = {
    operations,
    scale(...args) { operations.push(['scale', ...args]) },
    fillRect(...args) { operations.push(['fillRect', ...args]) },
    strokeRect(...args) { operations.push(['strokeRect', ...args]) },
    fillText(...args) { operations.push(['fillText', ...args]) },
  }
  return {
    width,
    height,
    context,
    getContext: () => context,
  }
}

test('registry contains immutable classic fallbacks and independently registered themes', () => {
  const registry = createThemeRegistry({
    frontThemes: [ALTERNATE_FRONT_THEME],
    backThemes: [ALTERNATE_BACK_THEME],
  })
  assert.equal(registry.fallbackFrontThemeId, CLASSIC_FRONT_THEME_ID)
  assert.equal(registry.fallbackBackThemeId, CLASSIC_BACK_THEME_ID)
  assert.deepEqual(
    registry.listFrontThemes().map(({ id }) => id),
    [CLASSIC_FRONT_THEME_ID, ALTERNATE_FRONT_THEME.id],
  )
  assert.deepEqual(
    registry.listBackThemes().map(({ id }) => id),
    [CLASSIC_BACK_THEME_ID, ALTERNATE_BACK_THEME.id],
  )
  assert.ok(Object.isFrozen(registry))
  assert.ok(Object.isFrozen(registry.listFrontThemes()))
  assert.ok(registry.listFrontThemes().every(Object.isFrozen))

  const selection = registry.resolveSelection(ALTERNATE_THEME_SELECTION)
  assert.deepEqual(selection, ALTERNATE_THEME_SELECTION)
  assert.ok(Object.isFrozen(selection))
  assert.equal(registry.resolveFront(selection.frontThemeId).kind, 'front')
  assert.equal(registry.resolveBack(selection.backThemeId).kind, 'back')
})

test('saved IDs fall back independently with immutable structured diagnostics', () => {
  const diagnostics = []
  const registry = createThemeRegistry({
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  })
  assert.deepEqual(registry.resolveSelection(UNKNOWN_THEME_SELECTION), {
    frontThemeId: CLASSIC_FRONT_THEME_ID,
    backThemeId: CLASSIC_BACK_THEME_ID,
  })
  assert.deepEqual(
    diagnostics.map(({ kind, reason, requestedId, fallbackId }) => ({
      kind,
      reason,
      requestedId,
      fallbackId,
    })),
    [
      {
        kind: 'front',
        reason: 'unknown-id',
        requestedId: 'missing-front-v1',
        fallbackId: CLASSIC_FRONT_THEME_ID,
      },
      {
        kind: 'back',
        reason: 'unknown-id',
        requestedId: 'missing-back-v1',
        fallbackId: CLASSIC_BACK_THEME_ID,
      },
    ],
  )
  assert.ok(diagnostics.every(Object.isFrozen))

  diagnostics.length = 0
  assert.deepEqual(registry.resolveSelection({
    frontThemeId: CLASSIC_FRONT_THEME_ID,
    backThemeId: 42,
  }), {
    frontThemeId: CLASSIC_FRONT_THEME_ID,
    backThemeId: CLASSIC_BACK_THEME_ID,
  })
  assert.deepEqual(diagnostics, [{
    type: 'theme-fallback',
    kind: 'back',
    requestedId: null,
    fallbackId: CLASSIC_BACK_THEME_ID,
    reason: 'invalid-id',
  }])

  diagnostics.length = 0
  assert.deepEqual(registry.resolveSelection(), {
    frontThemeId: CLASSIC_FRONT_THEME_ID,
    backThemeId: CLASSIC_BACK_THEME_ID,
  })
  assert.deepEqual(diagnostics.map(({ reason }) => reason), ['missing', 'missing'])
})

test('selection validation does not invoke accessors and diagnostic failures are isolated', () => {
  let invoked = false
  const selection = { backThemeId: CLASSIC_BACK_THEME_ID }
  Object.defineProperty(selection, 'frontThemeId', {
    enumerable: true,
    get() {
      invoked = true
      return CLASSIC_FRONT_THEME_ID
    },
  })
  const registry = createThemeRegistry({
    onDiagnostic() {
      throw new Error('diagnostic sink failed')
    },
  })
  assert.deepEqual(registry.resolveSelection(selection), {
    frontThemeId: CLASSIC_FRONT_THEME_ID,
    backThemeId: CLASSIC_BACK_THEME_ID,
  })
  assert.equal(invoked, false)
})

test('alternate fixture creates cards without changing domain identities', () => {
  const before = JSON.stringify(CARDS)
  const registry = createThemeRegistry({
    frontThemes: [ALTERNATE_FRONT_THEME],
    backThemes: [ALTERNATE_BACK_THEME],
  })
  const front = registry.resolveFront(ALTERNATE_FRONT_THEME.id).create('c-AS', {
    scale: 2,
    createCanvas: createFixtureCanvas,
  })
  const back = registry.resolveBack(ALTERNATE_BACK_THEME.id).create({
    scale: 2,
    createCanvas: createFixtureCanvas,
  })
  assert.deepEqual([front.width, front.height], [96, 144])
  assert.deepEqual([back.width, back.height], [96, 144])
  assert.ok(front.context.operations.some(([operation]) => operation === 'fillText'))
  assert.ok(back.context.operations.some(([operation]) => operation === 'strokeRect'))
  assert.equal(JSON.stringify(CARDS), before)
})

test('registrations validate IDs and contracts and reject collisions per kind', () => {
  assert.equal(isThemeId('theme-v1'), true)
  for (const invalid of [undefined, null, '', 'Theme-v1', 'theme_v1', 'theme v1', 1]) {
    assert.equal(isThemeId(invalid), false)
  }
  assert.throws(() => createThemeRegistry({ frontThemes: null }), /frontThemes/)
  assert.throws(() => createThemeRegistry({ onDiagnostic: null }), /onDiagnostic/)

  const registry = createThemeRegistry()
  assert.throws(() => registry.registerFront(ALTERNATE_FRONT_THEME), /already registered/)
  const sharedFront = registry.registerFront({ id: 'shared-v1', create() {} })
  const sharedBack = registry.registerBack({ id: 'shared-v1', create() {} })
  assert.equal(sharedFront.kind, 'front')
  assert.equal(sharedBack.kind, 'back')
  assert.throws(
    () => registry.registerFront({ id: 'shared-v1', create() {} }),
    /already registered/,
  )
  for (const descriptor of [
    null,
    {},
    { id: 'invalid id', create() {} },
    { id: 'valid-v1', create: true },
    { id: 'valid-v1', create() {}, extra: true },
  ]) {
    assert.throws(() => registry.registerFront(descriptor), /theme/)
  }
})

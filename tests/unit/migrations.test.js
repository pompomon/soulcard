import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  UnsupportedGameRulesVersionError,
  UnsupportedSaveVersionError,
} from '../../src/persistence/run-schema.js'
import { migrateRunSave } from '../../src/persistence/migrations.js'

const FIXTURE_ROOT = new URL('../fixtures/', import.meta.url)

function fixture(name) {
  return JSON.parse(readFileSync(new URL(name, FIXTURE_ROOT), 'utf8'))
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function allObjects(value) {
  if (value === null || typeof value !== 'object') return []
  return [value, ...Object.values(value).flatMap(allObjects)]
}

test('current schema saves are validated, cloned, and frozen', () => {
  for (const name of ['run-save-v5.json', 'campaign-save-informed-v5.json']) {
    const current = fixture(name)
    const migrated = migrateRunSave(current)

    assert.deepEqual(migrated, current)
    assert.notEqual(migrated, current)
    assert.ok(allObjects(migrated).every(Object.isFrozen))
  }
})

test('schema 4 Classic saves carry over unchanged as schema 5', () => {
  for (const name of ['run-save-v4.json', 'run-save-paused-v4.json', 'run-save-terminal-v4.json']) {
    const legacy = fixture(name)
    const before = clone(legacy)
    const migrated = migrateRunSave(legacy)

    assert.deepEqual(migrated, fixture(name.replace('-v4.json', '-v5.json')))
    assert.deepEqual(Object.keys(migrated), Object.keys(legacy))
    assert.ok(allObjects(migrated).every(Object.isFrozen))
    assert.deepEqual(legacy, before)
  }
  assert.throws(
    () => migrateRunSave({ ...fixture('run-save-v4.json'), gameRulesVersion: 1 }),
    UnsupportedGameRulesVersionError,
  )
  const corrupt = fixture('run-save-v4.json')
  corrupt.match.sourceDeck.pop()
  assert.throws(() => migrateRunSave(corrupt), /must contain all 52 cards/)
  assert.throws(
    () => migrateRunSave({ ...fixture('run-save-v4.json'), extra: true }),
    /save must contain only/,
  )
})

test('schema 4 Campaign saves are quarantined as incompatible game rules', () => {
  const legacy = fixture('campaign-save-v4.json')
  let invoked = false
  Object.defineProperty(legacy.match, 'pendingReward', {
    enumerable: true,
    get() {
      invoked = true
      return null
    },
  })
  assert.throws(
    () => migrateRunSave(legacy),
    (error) => error instanceof UnsupportedGameRulesVersionError && error.version === 3,
  )
  assert.equal(invoked, false)
  assert.throws(
    () => migrateRunSave({ ...fixture('campaign-save-v4.json'), gameRulesVersion: '3' }),
    TypeError,
  )

  const runTypeAccessor = fixture('campaign-save-v4.json')
  Object.defineProperty(runTypeAccessor, 'runType', {
    enumerable: true,
    get() {
      invoked = true
      return 'campaign'
    },
  })
  assert.throws(() => migrateRunSave(runTypeAccessor), /JSON-compatible data/)
  assert.equal(invoked, false)
})

test('schema versions 1 through 3 are deliberately quarantined without migration', () => {
  for (const [name, version] of [
    ['run-save-v1.json', 1],
    ['run-save-v2.json', 2],
    ['run-save-v2.json', 3],
  ]) {
    const legacy = fixture(name)
    legacy.saveSchemaVersion = version
    assert.throws(
      () => migrateRunSave(legacy),
      (error) => error instanceof UnsupportedSaveVersionError && error.version === version,
    )
  }
})

test('future, malformed, and incompatible current versions are rejected', () => {
  const current = fixture('run-save-v5.json')
  for (const saveSchemaVersion of [6, 20]) {
    assert.throws(
      () => migrateRunSave({ ...clone(current), saveSchemaVersion }),
      UnsupportedSaveVersionError,
    )
  }
  for (const save of [
    {},
    { ...clone(current), saveSchemaVersion: 0 },
    { ...clone(current), saveSchemaVersion: 1.5 },
    { ...clone(current), saveSchemaVersion: '5' },
  ]) {
    assert.throws(() => migrateRunSave(save), TypeError)
  }
  assert.throws(
    () => migrateRunSave({ ...clone(current), gameRulesVersion: 1 }),
    UnsupportedGameRulesVersionError,
  )
})

test('legacy quarantine does not inspect or invoke nested accessors', () => {
  const legacy = fixture('run-save-v1.json')
  let invoked = false
  Object.defineProperty(legacy.match, 'sourceDeck', {
    enumerable: true,
    get() {
      invoked = true
      return []
    },
  })

  assert.throws(() => migrateRunSave(legacy), UnsupportedSaveVersionError)
  assert.equal(invoked, false)
})

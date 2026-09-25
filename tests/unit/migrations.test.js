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
  const current = fixture('run-save-v4.json')
  const migrated = migrateRunSave(current)

  assert.deepEqual(migrated, current)
  assert.notEqual(migrated, current)
  assert.ok(allObjects(migrated).every(Object.isFrozen))
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
  const current = fixture('run-save-v4.json')
  assert.throws(
    () => migrateRunSave({ ...clone(current), saveSchemaVersion: 20 }),
    UnsupportedSaveVersionError,
  )
  for (const save of [
    {},
    { ...clone(current), saveSchemaVersion: 0 },
    { ...clone(current), saveSchemaVersion: 1.5 },
    { ...clone(current), saveSchemaVersion: '4' },
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

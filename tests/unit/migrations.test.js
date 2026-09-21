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

test('version 1 active saves migrate one step to the complete version 2 fixture', () => {
  const legacy = fixture('run-save-v1.json')
  const before = clone(legacy)
  const migrated = migrateRunSave(legacy)

  assert.deepEqual(migrated, fixture('run-save-v2.json'))
  assert.deepEqual(legacy, before)
  assert.ok(allObjects(migrated).every(Object.isFrozen))
  assert.notEqual(migrated, legacy)
  assert.notEqual(migrated.match, legacy.match)
})

test('current saves are validated, cloned, and frozen without migration', () => {
  const current = fixture('run-save-v2.json')
  const migrated = migrateRunSave(current)

  assert.deepEqual(migrated, current)
  assert.notEqual(migrated, current)
  assert.ok(allObjects(migrated).every(Object.isFrozen))
})

test('unknown, skipped, malformed, and incompatible versions are rejected', () => {
  const current = fixture('run-save-v2.json')
  const invalidVersions = [
    { ...clone(current), saveSchemaVersion: 3 },
    { ...clone(current), saveSchemaVersion: 20 },
  ]
  for (const save of invalidVersions) {
    assert.throws(() => migrateRunSave(save), UnsupportedSaveVersionError)
  }

  for (const save of [
    {},
    { ...clone(current), saveSchemaVersion: 0 },
    { ...clone(current), saveSchemaVersion: 1.5 },
    { ...clone(current), saveSchemaVersion: '1' },
  ]) {
    assert.throws(() => migrateRunSave(save), TypeError)
  }

  assert.throws(
    () => migrateRunSave({ ...clone(current), gameRulesVersion: 2 }),
    UnsupportedGameRulesVersionError,
  )
  const legacy = fixture('run-save-v1.json')
  assert.throws(
    () => migrateRunSave({ ...clone(legacy), gameRulesVersion: 2 }),
    UnsupportedGameRulesVersionError,
  )
})

test('legacy migration rejects ambiguous terminal and shape variants', () => {
  const terminal = fixture('run-save-terminal-v2.json')
  terminal.saveSchemaVersion = 1
  delete terminal.match.outcome
  assert.throws(
    () => migrateRunSave(terminal),
    /version 1 supports only active ready matches/,
  )

  const legacyWithOutcome = fixture('run-save-v1.json')
  legacyWithOutcome.match.outcome = null
  assert.throws(() => migrateRunSave(legacyWithOutcome), /must contain only/)

  const incomplete = fixture('run-save-v1.json')
  incomplete.match.sourceDeck.pop()
  assert.throws(() => migrateRunSave(incomplete), /all 52 cards/)
})

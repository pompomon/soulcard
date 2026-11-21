import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { revealOrContinue } from '../../src/domain/match-machine.js'
import {
  restoreRunSave,
  UnsupportedGameRulesVersionError,
  UnsupportedSaveVersionError,
} from '../../src/persistence/run-schema.js'
import { migrateRunSave } from '../../src/persistence/migrations.js'
import { CAMPAIGN_SAVE_FIXTURES } from '../fixtures/campaign-route.js'

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
  for (const name of [
    'run-save-v8.json',
    'run-save-short-deck-v8.json',
    'campaign-save-informed-v8.json',
    'campaign-save-shop-v8.json',
    'campaign-save-shop-exhausted-v8.json',
    'campaign-save-rest-v8.json',
    'campaign-save-victory-v8.json',
  ]) {
    const current = fixture(name)
    const migrated = migrateRunSave(current)

    assert.deepEqual(migrated, current)
    assert.notEqual(migrated, current)
    assert.ok(allObjects(migrated).every(Object.isFrozen))
  }
})

test('schema 4 to 7 Classic saves carry over unchanged as schema 8 with version-4 events', () => {
  for (const version of [4, 5, 6, 7]) {
    for (const name of ['run-save', 'run-save-paused', 'run-save-terminal']) {
      const legacy = fixture(`${name}-v${version}.json`)
      const before = clone(legacy)
      const migrated = migrateRunSave(legacy)

      assert.deepEqual(migrated, { ...fixture(`${name}-v7.json`), saveSchemaVersion: 8 })
      assert.equal(migrated.pendingEvent.eventVersion, 4)
      assert.equal(Object.hasOwn(migrated.pendingEvent, 'deck'), false)
      assert.deepEqual(Object.keys(migrated), Object.keys(legacy))
      assert.ok(allObjects(migrated).every(Object.isFrozen))
      assert.deepEqual(legacy, before)
    }
    const name = `run-save-v${version}.json`
    assert.throws(
      () => migrateRunSave({ ...fixture(name), gameRulesVersion: 1 }),
      UnsupportedGameRulesVersionError,
    )
    const corrupt = fixture(name)
    corrupt.match.sourceDeck.pop()
    assert.throws(() => migrateRunSave(corrupt), /must contain all 52 cards/)
    assert.throws(
      () => migrateRunSave({ ...fixture(name), extra: true }),
      /save must contain only/,
    )
  }
})

test('a carried Classic save resumes into version-6 events', () => {
  const carried = restoreRunSave(migrateRunSave(fixture('run-save-v7.json')))
  const current = restoreRunSave(fixture('run-save-v8.json'))
  const { pendingEvent: carriedEvent, ...carriedState } = carried
  const { pendingEvent: currentEvent, ...currentState } = current
  const { deck, ...currentEventV4 } = currentEvent

  assert.deepEqual(carriedState, currentState)
  assert.deepEqual(carriedEvent, { ...currentEventV4, eventVersion: 4 })
  assert.deepEqual(revealOrContinue(carried), revealOrContinue(current))
  assert.equal(revealOrContinue(carried).event.eventVersion, 6)
  assert.equal(revealOrContinue(carried).event.deck, 'standard-52')
})

test('schema 7 Campaign saves carry over unchanged as schema 8', () => {
  assert.equal(CAMPAIGN_SAVE_FIXTURES.length, 12)
  for (const [name] of CAMPAIGN_SAVE_FIXTURES) {
    const legacy = fixture(name.replace(/-v8\.json$/, '-v7.json'))
    const before = clone(legacy)
    const migrated = migrateRunSave(legacy)

    assert.equal(legacy.saveSchemaVersion, 7, name)
    assert.deepEqual(migrated, fixture(name), name)
    assert.ok(allObjects(migrated).every(Object.isFrozen), name)
    assert.deepEqual(legacy, before, name)
  }
  assert.throws(
    () => migrateRunSave({ ...fixture('campaign-save-route-v7.json'), gameRulesVersion: 6 }),
    (error) => error instanceof UnsupportedGameRulesVersionError && error.version === 6,
  )
})

test('schema 4, 5, and 6 Campaign saves are quarantined with their rules version', () => {
  for (const [name, rulesVersion] of [
    ['campaign-save-v4.json', 3],
    ['campaign-save-reward-v5.json', 4],
    ['campaign-save-informed-v5.json', 4],
    ['campaign-save-modifiers-v5.json', 4],
    ['campaign-save-route-v6-rules5.json', 5],
    ['campaign-save-reward-v6.json', 6],
    ['campaign-save-route-v6.json', 6],
    ['campaign-save-shop-v6.json', 6],
    ['campaign-save-shop-exhausted-v6.json', 6],
    ['campaign-save-event-v6.json', 6],
    ['campaign-save-informed-v6.json', 6],
    ['campaign-save-modifiers-v6.json', 6],
  ]) {
    const legacy = fixture(name)
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
      (error) => error instanceof UnsupportedGameRulesVersionError && error.version === rulesVersion,
    )
    assert.equal(invoked, false, name)
    assert.throws(
      () => migrateRunSave({ ...fixture(name), gameRulesVersion: String(rulesVersion) }),
      TypeError,
    )

    const runTypeAccessor = fixture(name)
    Object.defineProperty(runTypeAccessor, 'runType', {
      enumerable: true,
      get() {
        invoked = true
        return 'campaign'
      },
    })
    assert.throws(() => migrateRunSave(runTypeAccessor), /JSON-compatible data/)
    assert.equal(invoked, false, name)
  }
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
  const current = fixture('run-save-v8.json')
  for (const saveSchemaVersion of [9, 20]) {
    assert.throws(
      () => migrateRunSave({ ...clone(current), saveSchemaVersion }),
      UnsupportedSaveVersionError,
    )
  }
  for (const save of [
    {},
    { ...clone(current), saveSchemaVersion: 0 },
    { ...clone(current), saveSchemaVersion: 1.5 },
    { ...clone(current), saveSchemaVersion: '8' },
  ]) {
    assert.throws(() => migrateRunSave(save), TypeError)
  }
  assert.throws(
    () => migrateRunSave({ ...clone(current), gameRulesVersion: 1 }),
    UnsupportedGameRulesVersionError,
  )
  assert.throws(
    () => migrateRunSave({ ...fixture('campaign-save-route-v8.json'), gameRulesVersion: 6 }),
    (error) => error instanceof UnsupportedGameRulesVersionError && error.version === 6,
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

import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ART_DIR = fileURLToPath(new URL('../../art/', import.meta.url))
const UNRECORDED = new Set(['README.md', 'provenance.json'])
const FIELDS = Object.freeze(['path', 'author', 'date', 'license', 'tool', 'origin'])

function listArtFiles(directory = ART_DIR) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) return listArtFiles(absolute)
    const relative = path.relative(ART_DIR, absolute).split(path.sep).join('/')
    return UNRECORDED.has(relative) ? [] : [relative]
  })
}

function readRecords() {
  const provenance = JSON.parse(readFileSync(path.join(ART_DIR, 'provenance.json'), 'utf8'))
  assert.deepEqual(Object.keys(provenance), ['files'])
  assert.ok(Array.isArray(provenance.files))
  return provenance.files
}

test('every card art source has exactly one complete provenance record', () => {
  const files = listArtFiles().sort()
  const records = readRecords()
  const recorded = records.map((record) => record.path)

  assert.ok(files.length > 0)
  assert.deepEqual([...recorded].sort(), files)
  assert.equal(new Set(recorded).size, recorded.length, 'duplicate provenance records')
  for (const record of records) {
    assert.deepEqual(Object.keys(record), FIELDS, `${record.path}: unexpected fields`)
    for (const field of FIELDS) {
      assert.equal(typeof record[field], 'string', `${record.path}: ${field}`)
      assert.notEqual(record[field].trim(), '', `${record.path}: empty ${field}`)
    }
    assert.match(record.date, /^\d{4}-\d{2}-\d{2}$/, `${record.path}: date`)
    assert.equal(
      new Date(`${record.date}T00:00:00Z`).toISOString().slice(0, 10),
      record.date,
      `${record.path}: date`,
    )
  }
})

test('every provenance record names a file inside art/', () => {
  for (const { path: recordPath } of readRecords()) {
    const absolute = path.resolve(ART_DIR, recordPath)
    assert.ok(
      absolute.startsWith(ART_DIR) && !UNRECORDED.has(recordPath),
      `${recordPath}: outside the recorded art sources`,
    )
    assert.ok(existsSync(absolute) && statSync(absolute).isFile(), `${recordPath}: missing`)
  }
})

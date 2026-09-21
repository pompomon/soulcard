import assert from 'node:assert/strict'
import test from 'node:test'
import { bootstrap } from '../../src/app/bootstrap.js'
import { createSettingsRepository } from '../../src/persistence/settings-repository.js'

test('coordinator construction failure destroys the settings controller', () => {
  let listener = null
  let removedListener = null
  const mediaQueryList = {
    matches: false,
    addEventListener(type, callback) {
      assert.equal(type, 'change')
      listener = callback
    },
    removeEventListener(type, callback) {
      assert.equal(type, 'change')
      removedListener = callback
    },
  }

  assert.throws(
    () => bootstrap({
      root: null,
      settingsRepository: createSettingsRepository({ storage: null }),
      matchMedia: () => mediaQueryList,
    }),
    /root must support replaceChildren/,
  )
  assert.equal(typeof listener, 'function')
  assert.equal(removedListener, listener)
})

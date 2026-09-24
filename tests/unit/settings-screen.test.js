import assert from 'node:assert/strict'
import test from 'node:test'
import { createSettingsRepository } from '../../src/persistence/settings-repository.js'
import { createSettingsController } from '../../src/ui/settings-controller.js'
import { createSettingsScreen } from '../../src/ui/menus.js'

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase()
    this.children = []
    this.dataset = {}
    this.attributes = {}
    this.listeners = new Map()
    this.className = ''
    this.textContent = ''
    this.value = ''
    this.hidden = false
    this.disabled = false
  }

  append(...children) {
    this.children.push(...children)
  }

  setAttribute(name, value) {
    this.attributes[name] = value
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener)
  }

  dispatch(type) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener({ type, target: this, currentTarget: this })
    }
  }
}

function descendants(element) {
  return [element, ...element.children.flatMap(descendants)]
}

function setting(screen, name) {
  return descendants(screen.element).find((element) => element.dataset.setting === name)
}

function createStorage() {
  const values = new Map()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  }
}

test('Settings screen renders five semantic controls and applies changes immediately', (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  const storage = createStorage()
  const controller = createSettingsController({
    repository: createSettingsRepository({ storage }),
    matchMedia: null,
  })
  let backCalls = 0
  const screen = createSettingsScreen({
    settingsController: controller,
    onBack: () => {
      backCalls += 1
    },
  })

  const burnEnabled = setting(screen, 'burn-enabled')
  const quality = setting(screen, 'quality')
  const renderScale = setting(screen, 'render-scale-cap')
  const animationSpeed = setting(screen, 'animation-speed')
  const reducedMotion = setting(screen, 'reduced-motion')
  assert.deepEqual(
    [
      burnEnabled.value,
      quality.value,
      renderScale.value,
      animationSpeed.value,
      reducedMotion.value,
    ],
    ['enabled', 'balanced', '2', '1', 'system'],
  )
  assert.equal(
    descendants(screen.element).filter((element) => element.tagName === 'SELECT').length,
    5,
  )
  assert.match(
    descendants(screen.element).map((element) => element.textContent).join(' '),
    /newly started or restarted games/,
  )

  burnEnabled.value = 'disabled'
  burnEnabled.dispatch('change')
  quality.value = 'high'
  quality.dispatch('change')
  renderScale.value = '1.5'
  renderScale.dispatch('change')
  animationSpeed.value = '2'
  animationSpeed.dispatch('change')
  reducedMotion.value = 'full'
  reducedMotion.dispatch('change')

  assert.deepEqual(controller.getSnapshot(), {
    burnEnabled: false,
    quality: 'high',
    renderScaleCap: 1.5,
    animationSpeed: 2,
    reducedMotionOverride: false,
    reducedMotion: false,
  })

  const back = descendants(screen.element).find((element) => element.dataset.action === 'back')
  back.dispatch('click')
  assert.equal(backCalls, 1)

  screen.teardown()
  quality.value = 'low'
  quality.dispatch('change')
  back.dispatch('click')
  controller.setQuality('low')
  assert.equal(backCalls, 1)
  assert.equal(quality.value, 'low')

  const remounted = createSettingsScreen({
    settingsController: controller,
    onBack() {},
  })
  assert.deepEqual([
    setting(remounted, 'burn-enabled').value,
    setting(remounted, 'quality').value,
    setting(remounted, 'render-scale-cap').value,
    setting(remounted, 'animation-speed').value,
    setting(remounted, 'reduced-motion').value,
  ], ['disabled', 'low', '1.5', '2', 'full'])
  remounted.teardown()
  controller.destroy()
})

test('Settings screen reports session-only fallback without blocking controls', (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  const controller = createSettingsController({
    repository: createSettingsRepository({ storage: null }),
    matchMedia: null,
  })
  const screen = createSettingsScreen({
    settingsController: controller,
    onBack() {},
  })
  const status = descendants(screen.element).find(
    (element) => Object.hasOwn(element.dataset, 'settingsStatus'),
  )

  assert.equal(status.hidden, false)
  assert.equal(status.attributes.role, 'status')
  assert.equal(status.attributes['aria-live'], 'polite')
  assert.equal(status.attributes['aria-atomic'], 'true')
  assert.match(status.textContent, /session only/)
  const quality = setting(screen, 'quality')
  quality.value = 'high'
  quality.dispatch('change')
  assert.equal(controller.getSnapshot().quality, 'high')

  screen.teardown()
  controller.destroy()
})

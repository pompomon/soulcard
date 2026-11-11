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

  focus() {
    globalThis.document.activeElement = this
  }
}

function descendants(element) {
  return [element, ...element.children.flatMap(descendants)]
}

function setting(screen, name) {
  return descendants(screen.element).find((element) => element.dataset.setting === name)
}

function withDataset(screen, key) {
  return descendants(screen.element).find((element) => Object.hasOwn(element.dataset, key))
}

function withAction(screen, action) {
  return descendants(screen.element).find((element) => element.dataset.action === action)
}

function cardArtBlock(screen) {
  return withDataset(screen, 'cardArtStatusBlock')
}

function installDocument(t) {
  const previousDocument = globalThis.document
  globalThis.document = {
    activeElement: null,
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })
}

function installReportError(t) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'reportError')
  const errors = []
  globalThis.reportError = (error) => errors.push(error)
  t.after(() => {
    if (previous === undefined) delete globalThis.reportError
    else Object.defineProperty(globalThis, 'reportError', previous)
  })
  return errors
}

function cardArtSnapshot(requested, hd = {}) {
  return {
    requested,
    hd: {
      status: 'idle',
      loadedBytes: 0,
      totalBytes: null,
      reason: null,
      sessionOnly: false,
      ...hd,
    },
  }
}

function createFakeCardArt(initial = cardArtSnapshot('tarot-pixel')) {
  let snapshot = initial
  const listeners = new Set()
  const calls = []
  const removals = []
  return {
    calls,
    listeners,
    removals,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      listener(snapshot)
      return () => listeners.delete(listener)
    },
    publish(next) {
      snapshot = next
      for (const listener of [...listeners]) listener(snapshot)
    },
    retry() {
      calls.push('retry')
      return Promise.resolve(true)
    },
    removeDownload() {
      calls.push('removeDownload')
      return new Promise((resolve, reject) => removals.push({ resolve, reject }))
    },
    refresh() {
      calls.push('refresh')
      return Promise.resolve()
    },
  }
}

function settled() {
  return new Promise((resolve) => setImmediate(resolve))
}

function mountWithCardArt(cardArt) {
  const controller = createSettingsController({
    repository: createSettingsRepository({ storage: createStorage() }),
    matchMedia: null,
  })
  const screen = createSettingsScreen({ settingsController: controller, onBack() {}, cardArt })
  return { controller, screen }
}

function createStorage() {
  const values = new Map()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  }
}

test('Settings screen renders six semantic controls and applies changes immediately', (t) => {
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
  const cardArt = setting(screen, 'card-art')
  const quality = setting(screen, 'quality')
  const renderScale = setting(screen, 'render-scale-cap')
  const animationSpeed = setting(screen, 'animation-speed')
  const reducedMotion = setting(screen, 'reduced-motion')
  assert.deepEqual(
    [
      burnEnabled.value,
      cardArt.value,
      quality.value,
      renderScale.value,
      animationSpeed.value,
      reducedMotion.value,
    ],
    ['enabled', 'tarot-pixel', 'balanced', '2', '1', 'system'],
  )
  assert.equal(
    descendants(screen.element).filter((element) => element.tagName === 'SELECT').length,
    6,
  )
  assert.equal(cardArtBlock(screen).hidden, true)
  assert.match(
    descendants(screen.element).map((element) => element.textContent).join(' '),
    /newly started or restarted games/,
  )

  burnEnabled.value = 'disabled'
  burnEnabled.dispatch('change')
  cardArt.value = 'tarot-hd'
  cardArt.dispatch('change')
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
    cardArt: 'tarot-hd',
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
    setting(remounted, 'card-art').value,
    setting(remounted, 'quality').value,
    setting(remounted, 'render-scale-cap').value,
    setting(remounted, 'animation-speed').value,
    setting(remounted, 'reduced-motion').value,
  ], ['disabled', 'tarot-hd', 'low', '1.5', '2', 'full'])
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

const SUITS = 'Suits: Cups ♥, Pentacles ♦, Wands ♣, Swords ♠.'
const HD_BYTES = 1_025_826

test('Settings screen describes card art and announces every HD state', (t) => {
  installDocument(t)
  const cardArt = createFakeCardArt()
  const { controller, screen } = mountWithCardArt(cardArt)

  const select = setting(screen, 'card-art')
  assert.deepEqual(
    select.children.map((option) => [option.value, option.textContent]),
    [['tarot-pixel', 'Tarot (pixel)'], ['tarot-hd', 'Tarot (HD)']],
  )
  const hint = descendants(screen.element).find((element) => element.id === 'card-art-hint')
  assert.equal(select.attributes['aria-describedby'], 'card-art-hint')
  assert.equal(hint.textContent, `HD downloads once and then works offline. ${SUITS}`)

  const block = cardArtBlock(screen)
  const status = withDataset(screen, 'cardArtStatus')
  const progress = withDataset(screen, 'cardArtProgress')
  const retry = withAction(screen, 'retry-hd')
  const remove = withAction(screen, 'remove-hd')
  assert.equal(block.hidden, false)
  assert.equal(status.attributes.role, 'status')
  assert.equal(status.attributes['aria-live'], 'polite')
  assert.equal(status.attributes['aria-atomic'], 'true')
  assert.equal(progress.tagName, 'PROGRESS')
  assert.equal(progress.attributes['aria-label'], 'HD card art download')
  assert.equal(status.textContent, 'Pixel card art is in use.')
  assert.deepEqual([progress.hidden, retry.hidden, remove.hidden], [true, true, true])
  assert.deepEqual(cardArt.calls, ['refresh'])

  cardArt.publish(cardArtSnapshot('tarot-pixel', { totalBytes: HD_BYTES }))
  assert.equal(
    hint.textContent,
    `HD downloads about 1.0 MB once and then works offline. ${SUITS}`,
  )

  const unavailable = 'Pixel card art is in use.'
  const cases = [
    [{ status: 'idle' }, 'Checking HD card art…', false],
    [{ status: 'checking' }, 'Checking HD card art…', false],
    [
      { status: 'downloading', loadedBytes: 0 },
      `Downloading HD card art: 0.0 of 1.0 MB. ${unavailable.slice(0, -1)} until it finishes.`,
      false,
    ],
    [{ status: 'preparing' }, 'Preparing HD card art…', false],
    [{ status: 'ready' }, 'HD card art is ready and works offline.', false],
    [
      { status: 'ready', sessionOnly: true },
      'HD card art is in use for this session only. It downloads again next time.',
      false,
    ],
    [
      { status: 'offline' },
      `Connect to the internet to download HD card art. ${unavailable}`,
      true,
    ],
    [{ status: 'paused' }, 'Data saver is on. Select Retry to download HD card art.', true],
    [
      { status: 'failed', reason: 'quota' },
      `There isn't enough storage for HD card art. ${unavailable}`,
      true,
    ],
    [
      { status: 'failed', reason: 'network' },
      `HD card art couldn't be downloaded. ${unavailable}`,
      true,
    ],
    [
      { status: 'failed', reason: 'integrity' },
      `HD card art couldn't be downloaded. ${unavailable}`,
      true,
    ],
    [{ status: 'failed', reason: 'decode' }, `HD card art couldn't be loaded. ${unavailable}`, true],
    [{ status: 'failed', reason: 'missing' }, `HD card art couldn't be loaded. ${unavailable}`, true],
    [
      { status: 'failed', reason: 'unsupported' },
      `This browser can't show HD card art. ${unavailable}`,
      true,
    ],
  ]
  for (const [hd, text, retryable] of cases) {
    cardArt.publish(cardArtSnapshot('tarot-hd', { totalBytes: HD_BYTES, ...hd }))
    assert.equal(status.textContent, text, JSON.stringify(hd))
    assert.equal(retry.hidden, !retryable, JSON.stringify(hd))
    assert.equal(remove.hidden, true, JSON.stringify(hd))
    assert.equal(progress.hidden, hd.status !== 'downloading', JSON.stringify(hd))
  }

  controller.setCardArt('tarot-hd')
  assert.equal(select.value, 'tarot-hd')
  screen.teardown()
  controller.destroy()
})

test('Settings screen announces download progress by quarters but tracks every byte', (t) => {
  installDocument(t)
  const total = 4_000_000
  const cardArt = createFakeCardArt(cardArtSnapshot('tarot-hd', { status: 'checking' }))
  const { controller, screen } = mountWithCardArt(cardArt)
  const status = withDataset(screen, 'cardArtStatus')
  const progress = withDataset(screen, 'cardArtProgress')

  cardArt.publish(cardArtSnapshot('tarot-hd', { status: 'downloading', totalBytes: null }))
  assert.equal(
    status.textContent,
    'Downloading HD card art. Pixel card art is in use until it finishes.',
  )
  assert.equal(progress.hidden, true)

  const seen = []
  for (const loadedBytes of [0, 500_000, 999_999, 1_000_000, 2_500_000, 2_900_000, total]) {
    cardArt.publish(cardArtSnapshot('tarot-hd', {
      status: 'downloading',
      loadedBytes,
      totalBytes: total,
    }))
    assert.equal(progress.hidden, false)
    assert.equal(progress.max, total)
    assert.equal(progress.value, loadedBytes)
    seen.push(status.textContent.match(/: (\S+) of/)[1])
  }
  assert.deepEqual(seen, ['0.0', '0.0', '0.0', '1.0', '2.5', '2.5', '4.0'])

  cardArt.publish(cardArtSnapshot('tarot-hd', { status: 'preparing', totalBytes: total }))
  assert.equal(progress.hidden, true)
  assert.equal(status.textContent, 'Preparing HD card art…')
  screen.teardown()
  controller.destroy()
})

test('Settings screen retries and removes HD downloads through the card-art controller', async (t) => {
  installDocument(t)
  const errors = installReportError(t)
  const cardArt = createFakeCardArt(cardArtSnapshot('tarot-hd', {
    status: 'failed',
    reason: 'network',
    totalBytes: HD_BYTES,
  }))
  const { controller, screen } = mountWithCardArt(cardArt)
  const select = setting(screen, 'card-art')
  const status = withDataset(screen, 'cardArtStatus')
  const retry = withAction(screen, 'retry-hd')
  const remove = withAction(screen, 'remove-hd')

  assert.equal(retry.hidden, false)
  retry.dispatch('click')
  assert.deepEqual(cardArt.calls, ['refresh', 'retry'])

  retry.focus()
  cardArt.publish(cardArtSnapshot('tarot-pixel', { loadedBytes: HD_BYTES, totalBytes: HD_BYTES }))
  assert.equal(retry.hidden, true)
  assert.equal(globalThis.document.activeElement, select)
  assert.equal(remove.hidden, false)
  assert.equal(status.textContent, 'Pixel card art is in use.')

  remove.focus()
  remove.dispatch('click')
  remove.dispatch('click')
  assert.deepEqual(cardArt.calls, ['refresh', 'retry', 'removeDownload'])
  cardArt.publish(cardArtSnapshot('tarot-pixel', { loadedBytes: 0, totalBytes: HD_BYTES }))
  assert.equal(remove.hidden, true)
  assert.equal(globalThis.document.activeElement, select)
  cardArt.removals.shift().resolve(true)
  await settled()
  assert.equal(status.textContent, 'HD card art download removed. Pixel card art is in use.')

  cardArt.publish(cardArtSnapshot('tarot-pixel', { loadedBytes: HD_BYTES, totalBytes: HD_BYTES }))
  assert.equal(remove.hidden, false)
  const failure = new Error('clear failed')
  remove.dispatch('click')
  cardArt.removals.shift().reject(failure)
  await settled()
  assert.deepEqual(errors, [failure])
  assert.equal(status.textContent, 'HD card art download removed. Pixel card art is in use.')
  remove.dispatch('click')
  assert.equal(cardArt.calls.filter((call) => call === 'removeDownload').length, 3)
  cardArt.removals.shift().resolve(false)
  await settled()
  assert.equal(remove.hidden, false)

  cardArt.publish(cardArtSnapshot('tarot-hd', { status: 'checking', totalBytes: HD_BYTES }))
  assert.equal(status.textContent, 'Checking HD card art…')
  screen.teardown()
  controller.destroy()
})

test('Settings screen teardown stops card-art updates and late removals', async (t) => {
  installDocument(t)
  const errors = installReportError(t)
  const refreshFailure = new Error('refresh failed')
  const cardArt = createFakeCardArt(cardArtSnapshot('tarot-pixel', {
    loadedBytes: HD_BYTES,
    totalBytes: HD_BYTES,
  }))
  cardArt.refresh = () => Promise.reject(refreshFailure)
  const { controller, screen } = mountWithCardArt(cardArt)
  await settled()
  assert.deepEqual(errors, [refreshFailure])

  const select = setting(screen, 'card-art')
  const status = withDataset(screen, 'cardArtStatus')
  const retry = withAction(screen, 'retry-hd')
  const remove = withAction(screen, 'remove-hd')
  remove.dispatch('click')
  screen.teardown()
  assert.equal(cardArt.listeners.size, 0)

  cardArt.removals.shift().resolve(true)
  await settled()
  cardArt.publish(cardArtSnapshot('tarot-hd', { status: 'failed', reason: 'network' }))
  assert.equal(status.textContent, 'Pixel card art is in use.')
  assert.equal(retry.hidden, true)
  retry.dispatch('click')
  remove.dispatch('click')
  select.value = 'tarot-hd'
  select.dispatch('change')
  assert.deepEqual(cardArt.calls, ['removeDownload'])
  assert.equal(controller.getSnapshot().cardArt, 'tarot-pixel')
  controller.destroy()
})

test('Settings screen validates the card-art controller and releases settings on failure', (t) => {
  installDocument(t)
  const controller = createSettingsController({
    repository: createSettingsRepository({ storage: createStorage() }),
    matchMedia: null,
  })
  t.after(() => controller.destroy())

  for (const cardArt of [null, {}, 'tarot-hd', { ...createFakeCardArt(), refresh: undefined }]) {
    assert.throws(
      () => createSettingsScreen({ settingsController: controller, onBack() {}, cardArt }),
      { name: 'TypeError', message: 'cardArt must implement the card-art controller interface' },
    )
  }

  let settingsSubscriptions = 0
  const tracked = Object.create(controller, {
    subscribe: {
      value(listener) {
        settingsSubscriptions += 1
        const unsubscribe = controller.subscribe(listener)
        return () => {
          settingsSubscriptions -= 1
          unsubscribe()
        }
      },
    },
  })
  const failure = new Error('subscribe failed')
  const cardArt = createFakeCardArt()
  cardArt.subscribe = () => {
    throw failure
  }
  assert.throws(
    () => createSettingsScreen({ settingsController: tracked, onBack() {}, cardArt }),
    failure,
  )
  assert.equal(settingsSubscriptions, 0)
  assert.deepEqual(cardArt.calls, [])
})

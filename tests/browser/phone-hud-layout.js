import { bootstrap } from '../../src/app/bootstrap.js'
import { createRunController } from '../../src/app/run-controller.js'
import { createRunSave, restoreRunSave } from '../../src/persistence/run-schema.js'
import { createSettingsRepository } from '../../src/persistence/settings-repository.js'

const root = document.querySelector('#app')
const output = document.querySelector('#phone-hud-results')
const errors = []
const originalError = console.error.bind(console)
console.error = (...values) => {
  errors.push(values.map(String).join(' '))
  originalError(...values)
}
globalThis.addEventListener('error', (event) => errors.push(event.error?.message ?? event.message))
globalThis.addEventListener('unhandledrejection', (event) => errors.push(String(event.reason)))

const viewports = [
  [344, 882, true], [344, 720], [320, 480], [300, 450], [390, 844], [412, 915],
  [882, 344], [844, 390], [640, 360], [480, 320],
  [690, 829], [768, 1024], [1280, 800],
]
const statuses = [
  'Hold Insight shows both next cards. Choose the prepared card or the card in Hold.',
  'Graphics recovery failed (webgl-context-lost). Pause and save remain available; reload to retry.',
]

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function waitFor(predicate, label) {
  const deadline = performance.now() + 10000
  while (!predicate()) {
    assert(performance.now() < deadline, `Timed out: ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function settleLayout() {
  window.dispatchEvent(new Event('resize'))
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
}

function visible(element) {
  const style = getComputedStyle(element)
  return !element.hidden && style.display !== 'none' && style.visibility !== 'hidden'
    && element.getBoundingClientRect().width > 0
}

function measure(label, strict = true) {
  const mode = root.querySelector('.screen--game').dataset.layoutMode
  const portrait = mode === 'phone-portrait'
  const panels = [...root.querySelectorAll(
    '.zone-panel, .hud-metrics--piles, .game-feedback, .game-controls')]
    .filter(visible)
  const overflow = panels.map((panel) => ({
    panel: panel.className,
    pixels: Math.max(0, panel.scrollHeight - panel.clientHeight),
  }))
  if (strict) {
    assert(overflow.every((item) => item.pixels === 0),
      `${label}: overflow ${JSON.stringify(overflow)}`)
  }
  assert(root.querySelectorAll('canvas').length === 1, `${label}: one canvas`)
  if (portrait && strict) {
    const header = root.querySelector('.game-hud__header')
    assert(parseFloat(getComputedStyle(header).height) === 72,
      `${label}: header reserve changed`)
    const headerOverflow = header.scrollHeight - header.clientHeight
    const hud = root.querySelector('.game-hud')
    hud.style.gridTemplate = `
      "header header" var(--hud-header-reserve, 4.5rem)
      "comparison comparison" var(--hud-comparison-reserve, 5rem)
      ". ." minmax(0, 1fr)
      "opponent player" 64px "piles piles" 36px "status status" 48px
      "controls controls" calc(var(--hud-footer-reserve, 210px) - 148px) / 1fr 1fr`
    const baselineOverflow = header.scrollHeight - header.clientHeight
    hud.style.gridTemplate = ''
    assert(headerOverflow === baselineOverflow, `${label}: header overflow regressed`)
    const labels = [...root.querySelectorAll('.zone-panel dt, .hud-metrics--piles dt')]
      .filter(visible)
    for (const term of labels) {
      const style = getComputedStyle(term)
      assert(parseFloat(style.fontSize) >= 12, `${label}: label below 12px`)
      assert(term.getBoundingClientRect().height <= parseFloat(style.lineHeight) + 1,
        `${label}: wrapped ${term.textContent}`)
      assert(term.scrollWidth <= term.clientWidth + 1, `${label}: label too wide`)
    }
    for (const value of root.querySelectorAll('.zone-panel dd, .hud-metrics--piles dd')) {
      if (!visible(value)) continue
      const box = value.getBoundingClientRect()
      const panel = value.closest('.zone-panel, .hud-metrics--piles').getBoundingClientRect()
      assert(box.top >= panel.top - 1 && box.bottom <= panel.bottom + 1
        && box.left >= panel.left - 1 && box.right <= panel.right + 1,
      `${label}: value outside panel`)
    }
    assert(parseFloat(getComputedStyle(root.querySelector('.game-status')).fontSize) >= 12,
      `${label}: status below 12px`)
    const controls = [...root.querySelectorAll('.game-controls .game-button, .auto-reveal-toggle')]
      .filter(visible)
    for (const control of controls) {
      const box = control.getBoundingClientRect()
      assert(box.width >= 44 - 0.02 && box.height >= 44 - 0.02,
        `${label}: ${control.textContent.trim()} control ${box.width}x${box.height} below 44px`)
    }
  }
  if (strict && (portrait || mode === 'phone-landscape')) {
    for (let i = 0; i < panels.length; i += 1) {
      for (let j = i + 1; j < panels.length; j += 1) {
        const a = panels[i].getBoundingClientRect()
        const b = panels[j].getBoundingClientRect()
        const overlap = Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1
          && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1
        assert(!overlap, `${label}: overlapping ${panels[i].className}/${panels[j].className}`)
      }
    }
  }
  const header = root.querySelector('.game-hud__header')
  return {
    label, mode, overflow,
    headerOverflow: Math.max(0, header.scrollHeight - header.clientHeight),
  }
}

async function matrix(name, warning = false) {
  const report = []
  for (const [width, height, inset = false] of viewports) {
    root.style.width = `${width}px`
    root.style.height = `${height}px`
    root.toggleAttribute('data-pwa-inset', inset)
    await settleLayout()
    const mode = root.querySelector('.screen--game').dataset.layoutMode
    const strict = !(width === 480 && height === 320)
      && !(warning && mode === 'phone-landscape')
    const label = `${name} ${width}x${height}${inset ? ' inset' : ''}`
    report.push(measure(label, strict))
    const status = root.querySelector('.game-status')
    const original = status.textContent
    for (const text of statuses) {
      status.textContent = text
      report.push(measure(`${label} long status`, strict))
    }
    status.textContent = original
  }
  return report
}

async function mount(name) {
  const response = await fetch(new URL(`../fixtures/${name}`, import.meta.url))
  assert(response.ok, `Load ${name}`)
  let record = await response.text()
  let failNextSave = false
  const controller = createRunController({
    repository: {
      load: async () => ({
        status: 'resumable', savedAt: JSON.parse(record).savedAt,
        match: restoreRunSave(JSON.parse(record)),
      }),
      save: async (run) => {
        if (failNextSave) {
          failNextSave = false
          return { status: 'storage-unavailable', operation: 'save', reason: 'storage-error' }
        }
        const savedAt = new Date().toISOString()
        record = JSON.stringify(createRunSave(run, { savedAt }))
        return { status: 'saved', savedAt }
      },
      discard: async () => ({ status: 'discarded' }),
    },
  })
  const settings = createSettingsRepository({ storage: null })
  settings.setReducedMotionOverride(true)
  const app = bootstrap({
    root, runController: controller, settingsRepository: settings, matchMedia: null,
    pageLifecycleFactory: () => ({ destroy() {} }),
    updateController: {
      getSnapshot: () => ({ status: 'unsupported' }),
      subscribe(listener) { listener({ status: 'unsupported' }); return () => {} },
      requestActivation: async () => ({ status: 'skipped' }),
      destroy: async () => {},
    },
    updateNoticeFactory: () => ({ teardown() {} }),
  })
  await app.ready
  const resume = root.querySelector('[data-action="resume"]')
  await waitFor(() => !resume.disabled, 'Resume enabled')
  resume.click()
  await waitFor(() => app.activeScreen === 'game', 'Game mounted')
  return { app, controller, failSave() { failNextSave = true } }
}

async function run() {
  const report = []
  for (const name of ['campaign-save-modifiers-v7.json', 'run-save-v7.json']) {
    const { app, controller, failSave } = await mount(name)
    try {
      report.push(...await matrix(name))
      failSave()
      await controller.revealOrContinue()
      await controller.whenIdle()
      await waitFor(() => !root.querySelector('.game-save-warning').hidden, 'Save warning')
      report.push(...await matrix(`${name} warning`, true))
      root.style.width = '344px'
      root.style.height = '882px'
      document.documentElement.style.fontSize = '18.4px'
      await settleLayout()
      report.push(measure(`${name} 115% text (informational)`, false))
      document.documentElement.style.fontSize = ''
    } finally {
      document.documentElement.style.fontSize = ''
      await app.destroy()
    }
  }
  assert(errors.length === 0, `Console errors: ${errors.join('; ')}`)
  output.dataset.status = 'passed'
  output.textContent = JSON.stringify({ status: 'passed', errors, report }, null, 2)
}

run().catch((error) => {
  output.dataset.status = 'failed'
  output.textContent = error.stack ?? String(error)
  console.error(error)
})

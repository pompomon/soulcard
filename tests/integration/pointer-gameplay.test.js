import assert from 'node:assert/strict'
import test from 'node:test'
import { createRunController } from '../../src/app/run-controller.js'
import { createMatch, revealOrContinue } from '../../src/domain/match-machine.js'
import { BASELINE_RULESET } from '../../src/domain/ruleset.js'
import { createEventPlayer } from '../../src/presentation/event-player.js'
import { createGameScreen } from '../../src/ui/hud.js'

const ZERO_TIMING = Object.freeze({
  revealMs: 0,
  settlementMs: 0,
  burnMs: 0,
})

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase()
    this.children = []
    this.dataset = {}
    this.attributes = {}
    this.listeners = new Map()
    this.className = ''
    this.textContent = ''
    this.hidden = false
    this.disabled = false
    this.style = { setProperty() {} }
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

  dispatch(type, values = {}) {
    const event = {
      type,
      target: this,
      currentTarget: this,
      button: type.startsWith('pointer') ? 0 : undefined,
      detail: 0,
      isPrimary: true,
      pointerId: 1,
      pointerType: 'mouse',
      preventDefault() {},
      stopPropagation() {},
      ...values,
    }
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event)
  }
}

function descendants(element) {
  return [element, ...element.children.flatMap(descendants)]
}

async function waitFor(predicate, rounds = 100) {
  for (let index = 0; index < rounds; index += 1) {
    if (predicate()) return
    await Promise.resolve()
  }
  assert.fail('Condition did not settle')
}

test('one pointer action commits, saves, and presents exactly one deterministic clash', async (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  const initial = createMatch({
    runId: 'pointer-integration',
    seed: 12345,
    ruleset: BASELINE_RULESET,
  })
  const initialCopy = JSON.parse(JSON.stringify(initial))
  const expected = revealOrContinue(initial).match
  const saves = []
  const controller = createRunController({
    repository: {
      load: async () => ({ status: 'empty' }),
      async save(match) {
        saves.push(match)
        return {
          status: 'saved',
          savedAt: '2026-09-22T17:20:00.000Z',
        }
      },
    },
    initialMatch: initial,
  })
  const calls = []
  const screen = createGameScreen({
    runController: controller,
    mountBattlefield: () => ({
      syncSnapshot(match, context) {
        assert.notEqual(match, controller.currentMatch)
        assert.equal(Object.isFrozen(match), true)
        assert.equal(Object.isFrozen(match.zones), true)
        calls.push(['sync', match.turn, context.reason])
      },
      beginEvent(event, match) {
        assert.equal(Object.isFrozen(event), true)
        assert.equal(Object.isFrozen(match), true)
        calls.push(['begin', event.id])
      },
      applyStep(step, context) {
        assert.equal(Object.isFrozen(step), true)
        assert.equal(Object.isFrozen(context.match), true)
        calls.push(['step', step.kind])
      },
      setPaused() {},
      teardown() {},
    }),
    eventPlayerFactory: (options) => createEventPlayer({
      ...options,
      timing: ZERO_TIMING,
    }),
  })
  const reveal = descendants(screen.element).find(
    (element) => element.dataset.action === 'reveal',
  )

  await waitFor(() => calls.some(([kind]) => kind === 'sync'))
  reveal.dispatch('pointerdown', { pointerType: 'pen', pointerId: 9 })
  reveal.dispatch('pointerup', { pointerType: 'pen', pointerId: 9 })
  reveal.dispatch('click', { detail: 1, button: 0 })

  assert.equal(controller.currentMatch.turn, 1)
  assert.equal(reveal.disabled, true)
  await controller.whenIdle()
  await waitFor(() => !reveal.disabled)

  assert.equal(saves.length, 1)
  assert.deepEqual(controller.currentMatch, expected)
  assert.deepEqual(initial, initialCopy)
  assert.equal(calls.filter(([kind]) => kind === 'begin').length, 1)
  assert.ok(calls.some(([kind]) => kind === 'step'))
  assert.equal(calls.filter(([kind, turn]) => kind === 'sync' && turn === 1).length, 1)

  screen.teardown()
  await controller.destroy()
})

test('source and personal active-deck activation each use the guarded Reveal flow', async (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  const source = createMatch({
    runId: 'deck-source-integration',
    seed: 0,
    ruleset: BASELINE_RULESET,
  })
  let personal = createMatch({
    runId: 'deck-personal-integration',
    seed: 0,
    ruleset: BASELINE_RULESET,
  })
  while (personal.stage === 'source') {
    personal = revealOrContinue(personal).match
  }

  for (const initial of [source, personal]) {
    const expected = revealOrContinue(initial).match
    const saves = []
    const controller = createRunController({
      repository: {
        load: async () => ({ status: 'empty' }),
        async save(match) {
          saves.push(match)
          return {
            status: 'saved',
            savedAt: '2026-09-22T21:00:00.000Z',
          }
        },
      },
      initialMatch: initial,
    })
    const deckStates = []
    let activateDeck
    const screen = createGameScreen({
      runController: controller,
      mountBattlefield: (host, options) => {
        activateDeck = options.onDeckActivate
        return {
          syncSnapshot() {},
          beginEvent() {},
          applyStep() {},
          setPaused() {},
          setDeckInputState(state) {
            deckStates.push(state)
          },
          teardown() {},
        }
      },
      eventPlayerFactory: (options) => createEventPlayer({
        ...options,
        timing: ZERO_TIMING,
      }),
    })

    await waitFor(() => {
      const state = deckStates.at(-1)
      return state?.enabled === true && state.busy === false
    })
    activateDeck({ pointerType: 'touch' })
    activateDeck({ pointerType: 'touch' })
    assert.equal(controller.currentMatch.turn, initial.turn + 1)
    assert.deepEqual(deckStates.at(-1), { enabled: true, busy: true })

    await controller.whenIdle()
    await waitFor(() => deckStates.at(-1)?.busy === false)
    assert.equal(saves.length, 1)
    assert.deepEqual(controller.currentMatch, expected)

    screen.teardown()
    await controller.destroy()
  }
})

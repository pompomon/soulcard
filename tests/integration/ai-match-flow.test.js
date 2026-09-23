import assert from 'node:assert/strict'
import test from 'node:test'
import { createRunController } from '../../src/app/run-controller.js'
import {
  createMatch,
  revealOrContinue,
} from '../../src/domain/match-machine.js'
import { BASELINE_RULESET } from '../../src/domain/ruleset.js'
import { createGameScreen } from '../../src/ui/hud.js'

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase()
    this.children = []
    this.dataset = {}
    this.attributes = {}
    this.listeners = new Map()
    this.className = ''
    this.textContent = ''
    this.type = ''
    this.checked = false
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
      button: type === 'click' ? 0 : undefined,
      detail: 0,
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

function byAction(screen, action) {
  return descendants(screen.element).find((element) => element.dataset.action === action)
}

function byValue(screen, value) {
  return descendants(screen.element).find((element) => element.dataset.value === value)
}

function createBaselineMatch(runId, seed) {
  return createMatch({ runId, seed, ruleset: BASELINE_RULESET })
}

function canonicalReplay(runId, seed) {
  let match = createBaselineMatch(runId, seed)
  const transitions = []
  while (match.status === 'active') {
    assert.ok(transitions.length < 100, 'complete match exceeded the integration guard')
    const transition = revealOrContinue(match)
    transitions.push(transition)
    match = transition.match
  }
  return transitions
}

async function waitFor(predicate, rounds = 100) {
  for (let index = 0; index < rounds; index += 1) {
    if (predicate()) return
    await Promise.resolve()
  }
  assert.fail('Condition did not settle')
}

test('locked encounters save every deterministic clash through the AI run path', async () => {
  const cases = [
    [0, { result: 'win', winner: 'player', reason: 'opponentUnableToReveal' }],
    [5, { result: 'win', winner: 'opponent', reason: 'playerUnableToReveal' }],
    [32, { result: 'draw', reason: 'mutualInability' }],
  ]

  for (const [seed, outcome] of cases) {
    const runId = `ai-integration-${seed}`
    const expected = canonicalReplay(runId, seed)
    const saves = []
    const controller = createRunController({
      repository: {
        load: async () => ({ status: 'empty' }),
        async save(match) {
          saves.push(match)
          return {
            status: 'saved',
            savedAt: '2026-09-22T21:30:00.000Z',
          }
        },
      },
      initialMatch: createBaselineMatch(runId, seed),
    })
    let stageTransitions = 0

    for (const canonical of expected) {
      const previous = controller.currentMatch
      const actual = await controller.revealOrContinue()
      assert.deepEqual(actual.match, canonical.match)
      assert.deepEqual(actual.event, canonical.event)
      assert.equal(actual.event, actual.match.pendingEvent)
      assert.equal(saves.length, actual.match.turn)
      assert.equal(saves.at(-1), actual.match)
      if (previous.stage === 'source' && actual.match.stage === 'personal') {
        stageTransitions += 1
      }
    }

    assert.equal(stageTransitions, 1)
    assert.deepEqual(controller.currentMatch.outcome, outcome)
    assert.equal(controller.currentMatch.turn, expected.length)
    await controller.destroy()
  }
})

test('HUD drives and presents one complete automatic-opponent match', async (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  const runId = 'ai-hud-complete'
  const expected = canonicalReplay(runId, 0)
  const saves = []
  const controller = createRunController({
    repository: {
      load: async () => ({ status: 'empty' }),
      async save(match) {
        saves.push(match)
        return {
          status: 'saved',
          savedAt: '2026-09-22T21:31:00.000Z',
        }
      },
    },
    initialMatch: createBaselineMatch(runId, 0),
  })
  const presented = []
  const screen = createGameScreen({
    runController: controller,
    mountBattlefield: () => undefined,
    eventPlayerFactory: ({ onStateChange }) => ({
      present(match) {
        const event = match.pendingEvent
        if (event === null) {
          return Promise.resolve({ status: 'synchronized', eventId: null, reason: null })
        }
        presented.push(event)
        onStateChange({
          status: 'completed',
          eventId: event.id,
          stepIndex: null,
          stepCount: event.reveals.length,
          stepKind: null,
          reason: 'reduced-motion',
        })
        return Promise.resolve({
          status: 'completed',
          eventId: event.id,
          reason: 'reduced-motion',
        })
      },
      setPaused() {},
      destroy() {},
    }),
  })
  const reveal = byAction(screen, 'reveal')
  const pause = byAction(screen, 'pause')
  const status = descendants(screen.element).find(
    (element) => Object.hasOwn(element.dataset, 'statusHost'),
  )
  let stageTransitions = 0

  for (const canonical of expected) {
    const previous = controller.currentMatch
    const saveCount = saves.length
    const presentationCount = presented.length

    assert.equal(reveal.disabled, false)
    reveal.dispatch('click')
    assert.equal(controller.currentMatch.turn, previous.turn + 1)
    await controller.whenIdle()
    await waitFor(() => (
      saves.length === saveCount + 1
      && presented.length === presentationCount + 1
      && (
        controller.currentMatch.status === 'ended'
        || reveal.disabled === false
      )
    ))

    const match = controller.currentMatch
    assert.deepEqual(match, canonical.match)
    assert.deepEqual(presented.at(-1), canonical.event)
    assert.equal(byValue(screen, 'source-count').textContent, String(match.zones.sourceDeck.length))
    assert.equal(byValue(screen, 'player-won-count').textContent, String(match.zones.player.wonPile.length))
    assert.equal(byValue(screen, 'opponent-won-count').textContent, String(match.zones.opponent.wonPile.length))
    for (let index = 0; index < canonical.event.reveals.length; index += 1) {
      assert.equal(
        canonical.event.reveals[index].suppliedBy,
        index % 2 === 0 ? 'player' : 'opponent',
      )
    }

    if (previous.stage === 'source' && match.stage === 'personal') {
      stageTransitions += 1
      assert.equal(previous.zones.sourceDeck.length, 2)
      assert.equal(match.zones.sourceDeck.length, 0)
      assert.equal(byValue(screen, 'stage').textContent, 'Personal')
      assert.deepEqual(match.rng, canonical.match.rng)
      assert.deepEqual(match.zones.player.drawPile, canonical.match.zones.player.drawPile)
      assert.deepEqual(match.zones.opponent.drawPile, canonical.match.zones.opponent.drawPile)
    }
  }

  assert.equal(stageTransitions, 1)
  assert.equal(saves.length, expected.length)
  assert.equal(presented.length, expected.length)
  assert.deepEqual(controller.currentMatch.outcome, {
    result: 'win',
    winner: 'player',
    reason: 'opponentUnableToReveal',
  })
  assert.match(status.textContent, /Player won the match/)
  assert.equal(reveal.disabled, true)
  assert.equal(pause.disabled, true)

  screen.teardown()
  await controller.destroy()
})

test('one manual Reveal with Auto-reveal completes one canonical saved presentation per clash', async (t) => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  }
  t.after(() => {
    globalThis.document = previousDocument
  })

  const runId = 'ai-hud-auto-complete'
  const expected = canonicalReplay(runId, 0)
  const saves = []
  const controller = createRunController({
    repository: {
      load: async () => ({ status: 'empty' }),
      async save(match) {
        saves.push(match)
        return {
          status: 'saved',
          savedAt: '2026-09-23T12:06:00.000Z',
        }
      },
    },
    initialMatch: createBaselineMatch(runId, 0),
  })
  const presented = []
  const screen = createGameScreen({
    runController: controller,
    mountBattlefield: () => undefined,
    eventPlayerFactory: ({ onStateChange }) => ({
      present(match) {
        const event = match.pendingEvent
        if (event === null) {
          return Promise.resolve({ status: 'synchronized', eventId: null, reason: null })
        }
        presented.push(event)
        onStateChange({
          status: 'completed',
          eventId: event.id,
          stepIndex: null,
          stepCount: event.reveals.length,
          stepKind: null,
          reason: null,
        })
        return Promise.resolve({
          status: 'completed',
          eventId: event.id,
          reason: null,
        })
      },
      setPaused() {},
      destroy() {},
    }),
  })
  const autoReveal = byAction(screen, 'auto-reveal')
  autoReveal.checked = true
  autoReveal.dispatch('change')
  byAction(screen, 'reveal').dispatch('click')

  await waitFor(() => (
    controller.currentMatch.status === 'ended'
    && saves.length === expected.length
    && presented.length === expected.length
  ), expected.length * 20)
  await controller.whenIdle()

  assert.deepEqual(controller.currentMatch, expected.at(-1).match)
  assert.deepEqual(saves, expected.map(({ match }) => match))
  assert.deepEqual(presented, expected.map(({ event }) => event))
  assert.equal(byAction(screen, 'reveal').disabled, true)
  assert.equal(byAction(screen, 'pause').disabled, true)
  assert.equal(autoReveal.disabled, true)

  const settledCounts = [saves.length, presented.length]
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual([saves.length, presented.length], settledCounts)

  screen.teardown()
  await controller.destroy()
})

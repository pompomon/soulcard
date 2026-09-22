import {
  revealOrContinue,
  validateMatchState,
} from './match-machine.js'

function validateEncounterTransition(input, transition) {
  if (
    transition === null
    || typeof transition !== 'object'
    || Array.isArray(transition)
    || Reflect.ownKeys(transition).length !== 2
    || !Object.hasOwn(transition, 'match')
    || !Object.hasOwn(transition, 'event')
  ) {
    throw new TypeError('AI advancement must return only match and event')
  }

  validateMatchState(transition.match)
  if (
    transition.match.runId !== input.runId
    || transition.match.turn !== input.turn + 1
    || transition.event !== transition.match.pendingEvent
  ) {
    throw new Error('AI advancement must commit exactly one matching clash')
  }
  return transition
}

export function createAiController({
  resolveClash = revealOrContinue,
} = {}) {
  if (typeof resolveClash !== 'function') {
    throw new TypeError('resolveClash must be a function')
  }

  return Object.freeze({
    advanceEncounter(match) {
      validateMatchState(match)
      return validateEncounterTransition(match, resolveClash(match))
    },
  })
}

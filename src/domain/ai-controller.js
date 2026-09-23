import { validateMatchState } from './match-machine.js'

export const REVEAL_OR_CONTINUE_ACTION = 'revealOrContinue'

export function createAiController() {
  return Object.freeze({
    chooseEncounterAction(match) {
      validateMatchState(match)
      if (match.machineState === 'ended') {
        throw new Error('An ended match cannot reveal or continue')
      }
      if (match.machineState === 'paused') {
        throw new Error('A paused match cannot reveal or continue')
      }
      return REVEAL_OR_CONTINUE_ACTION
    },
  })
}

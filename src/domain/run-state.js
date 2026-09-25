import {
  isCampaignState,
  pauseCampaign,
  resumeCampaign,
  validateCampaignState,
} from './campaign-machine.js'
import {
  pauseMatch,
  resumeMatch,
  validateMatchState,
} from './match-machine.js'

export { isCampaignState }

export function validateRunState(run) {
  return isCampaignState(run)
    ? validateCampaignState(run)
    : validateMatchState(run)
}

export function pauseRun(run) {
  return isCampaignState(run) ? pauseCampaign(run) : pauseMatch(run)
}

export function resumeRun(run) {
  return isCampaignState(run) ? resumeCampaign(run) : resumeMatch(run)
}

export function resolveRunCardId(run, identity) {
  if (!isCampaignState(run)) return identity
  return run.cards.find(({ instanceId }) => instanceId === identity)?.cardId
}

export function runVisualKey(record) {
  return record.instanceId ?? record.cardId
}

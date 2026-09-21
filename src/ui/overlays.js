function assertCallback(callback, name) {
  if (typeof callback !== 'function') {
    throw new TypeError(`${name} must be a function`)
  }
}

function saveStatusText({ saveStatus, saveReason }) {
  switch (saveStatus) {
    case 'saving':
      return 'Saving…'
    case 'saved':
      return 'Game saved.'
    case 'failed':
      return `Save failed${saveReason ? ` (${saveReason})` : ''}. Your game remains available in this session.`
    case 'unsaved':
      return 'Game has unsaved changes.'
    default:
      return 'No save has been written yet.'
  }
}

export function createPauseOverlay({ onResume } = {}) {
  assertCallback(onResume, 'onResume')

  const element = document.createElement('section')
  element.className = 'pause-overlay'
  element.dataset.pauseOverlay = ''
  element.setAttribute('role', 'dialog')
  element.setAttribute('aria-modal', 'true')
  element.setAttribute('aria-labelledby', 'pause-overlay-title')
  element.hidden = true

  const panel = document.createElement('div')
  panel.className = 'pause-overlay__panel'

  const heading = document.createElement('h2')
  heading.id = 'pause-overlay-title'
  heading.textContent = 'Game paused'

  const saveStatus = document.createElement('p')
  saveStatus.className = 'pause-overlay__status'
  saveStatus.dataset.saveStatus = ''
  saveStatus.setAttribute('role', 'status')
  saveStatus.setAttribute('aria-live', 'polite')

  const resumeButton = document.createElement('button')
  resumeButton.type = 'button'
  resumeButton.className = 'game-button game-button--primary'
  resumeButton.dataset.action = 'resume'
  resumeButton.textContent = 'Resume'
  resumeButton.addEventListener('click', onResume)

  panel.append(heading, saveStatus, resumeButton)
  element.append(panel)

  return {
    element,
    update(snapshot) {
      saveStatus.textContent = saveStatusText(snapshot)
    },
    teardown() {
      resumeButton.removeEventListener('click', onResume)
    },
  }
}

export const BATTLEFIELD_LAYOUT_MODES = Object.freeze([
  'phone-portrait',
  'phone-landscape',
  'tablet',
  'desktop',
])

export const BATTLEFIELD_ZONE_IDS = Object.freeze([
  'sourceDeck',
  'playerSourcePile',
  'opponentSourcePile',
  'hold',
  'opponentDrawPile',
  'opponentWonPile',
  'opponentReveal',
  'playerReveal',
  'playerDrawPile',
  'playerWonPile',
  'contestedPile',
  'burnPile',
])

export const MINIMUM_VIEWPORT = Object.freeze({
  width: 320,
  height: 480,
})

const MODE_SPECS = Object.freeze({
  'phone-portrait': Object.freeze({
    world: Object.freeze({ width: 7.5, height: 11 }),
    hud: Object.freeze({ header: 72, comparison: 80, footer: 210, side: 0 }),
    visuals: Object.freeze({
      activeDeckScale: 1.55,
      revealScale: 1.55,
      secondaryPileScale: 1.12,
    }),
    zones: Object.freeze({
      sourceDeck: Object.freeze({ x: -2.65, y: 0, z: 0.2 }),
      playerSourcePile: Object.freeze({ x: -2.65, y: -2.25, z: 0.2 }),
      opponentSourcePile: Object.freeze({ x: -2.65, y: 2.25, z: 0.2 }),
      hold: Object.freeze({ x: 2.75, y: -2.65, z: 0.2 }),
      opponentDrawPile: Object.freeze({ x: -2.35, y: 4.1, z: 0.2 }),
      opponentWonPile: Object.freeze({ x: 2.35, y: 4.1, z: 0.2 }),
      opponentReveal: Object.freeze({ x: 0.35, y: 1.45, z: 0.3 }),
      playerReveal: Object.freeze({ x: 0.35, y: -1.45, z: 0.3 }),
      playerDrawPile: Object.freeze({ x: -2.35, y: -4.1, z: 0.2 }),
      playerWonPile: Object.freeze({ x: 2.35, y: -4.1, z: 0.2 }),
      contestedPile: Object.freeze({ x: 2.75, y: 0.85, z: 0.2 }),
      burnPile: Object.freeze({ x: 2.75, y: -0.85, z: 0.2 }),
    }),
  }),
  'phone-landscape': Object.freeze({
    world: Object.freeze({ width: 12, height: 6.5 }),
    hud: Object.freeze({ header: 44, comparison: 72, footer: 80, side: 100 }),
    visuals: Object.freeze({
      activeDeckScale: 1.4,
      revealScale: 1.4,
      secondaryPileScale: 1.02,
    }),
    zones: Object.freeze({
      sourceDeck: Object.freeze({ x: -5, y: 0, z: 0.2 }),
      playerSourcePile: Object.freeze({ x: -5, y: -1.55, z: 0.2 }),
      opponentSourcePile: Object.freeze({ x: -5, y: 1.55, z: 0.2 }),
      hold: Object.freeze({ x: 4.8, y: -2.1, z: 0.2 }),
      opponentDrawPile: Object.freeze({ x: -3.9, y: 2.1, z: 0.2 }),
      opponentWonPile: Object.freeze({ x: -2.1, y: 2.1, z: 0.2 }),
      opponentReveal: Object.freeze({ x: 0.3, y: 1.1, z: 0.3 }),
      playerReveal: Object.freeze({ x: 0.3, y: -1.1, z: 0.3 }),
      playerDrawPile: Object.freeze({ x: -3.9, y: -2.1, z: 0.2 }),
      playerWonPile: Object.freeze({ x: -2.1, y: -2.1, z: 0.2 }),
      contestedPile: Object.freeze({ x: 3.5, y: 0.85, z: 0.2 }),
      burnPile: Object.freeze({ x: 4.8, y: -0.85, z: 0.2 }),
    }),
  }),
  tablet: Object.freeze({
    world: Object.freeze({ width: 10, height: 9 }),
    hud: Object.freeze({ header: 60, comparison: 128, footer: 108, side: 120 }),
    visuals: Object.freeze({
      activeDeckScale: 1.75,
      revealScale: 1.75,
      secondaryPileScale: 1.2,
    }),
    zones: Object.freeze({
      sourceDeck: Object.freeze({ x: -3.8, y: 0, z: 0.2 }),
      playerSourcePile: Object.freeze({ x: -3.8, y: -2, z: 0.2 }),
      opponentSourcePile: Object.freeze({ x: -3.8, y: 2, z: 0.2 }),
      hold: Object.freeze({ x: 3.8, y: -2.45, z: 0.2 }),
      opponentDrawPile: Object.freeze({ x: -3.2, y: 3.2, z: 0.2 }),
      opponentWonPile: Object.freeze({ x: -1.1, y: 3.2, z: 0.2 }),
      opponentReveal: Object.freeze({ x: 0.5, y: 1.45, z: 0.3 }),
      playerReveal: Object.freeze({ x: 0.5, y: -1.45, z: 0.3 }),
      playerDrawPile: Object.freeze({ x: -3.2, y: -3.2, z: 0.2 }),
      playerWonPile: Object.freeze({ x: -1.1, y: -3.2, z: 0.2 }),
      contestedPile: Object.freeze({ x: 3.25, y: 0.95, z: 0.2 }),
      burnPile: Object.freeze({ x: 3.8, y: -1, z: 0.2 }),
    }),
  }),
  desktop: Object.freeze({
    world: Object.freeze({ width: 12, height: 8 }),
    hud: Object.freeze({ header: 76, comparison: 88, footer: 92, side: 208 }),
    visuals: Object.freeze({
      activeDeckScale: 1.75,
      revealScale: 1.75,
      secondaryPileScale: 1.2,
    }),
    zones: Object.freeze({
      sourceDeck: Object.freeze({ x: -4.8, y: 0, z: 0.2 }),
      playerSourcePile: Object.freeze({ x: -4.8, y: -2.1, z: 0.2 }),
      opponentSourcePile: Object.freeze({ x: -4.8, y: 2.1, z: 0.2 }),
      hold: Object.freeze({ x: 4.7, y: -2.35, z: 0.2 }),
      opponentDrawPile: Object.freeze({ x: -3.6, y: 2.65, z: 0.2 }),
      opponentWonPile: Object.freeze({ x: -1.35, y: 2.65, z: 0.2 }),
      opponentReveal: Object.freeze({ x: 0.45, y: 1.4, z: 0.3 }),
      playerReveal: Object.freeze({ x: 0.45, y: -1.4, z: 0.3 }),
      playerDrawPile: Object.freeze({ x: -3.6, y: -2.65, z: 0.2 }),
      playerWonPile: Object.freeze({ x: -1.35, y: -2.65, z: 0.2 }),
      contestedPile: Object.freeze({ x: 3.35, y: 0.9, z: 0.2 }),
      burnPile: Object.freeze({ x: 4.7, y: -0.9, z: 0.2 }),
    }),
  }),
})

function assertPositiveFinite(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive finite number`)
  }
}

function normalizeSafeArea(safeArea) {
  if (safeArea === undefined) {
    return { top: 0, right: 0, bottom: 0, left: 0 }
  }
  if (safeArea === null || typeof safeArea !== 'object' || Array.isArray(safeArea)) {
    throw new TypeError('safeArea must be an object')
  }

  const keys = ['top', 'right', 'bottom', 'left']
  if (
    Object.keys(safeArea).length !== keys.length
    || keys.some((key) => !Object.hasOwn(safeArea, key))
  ) {
    throw new TypeError('safeArea must contain exactly top, right, bottom, and left')
  }
  for (const key of keys) {
    if (!Number.isFinite(safeArea[key]) || safeArea[key] < 0) {
      throw new TypeError(`safeArea.${key} must be a nonnegative finite number`)
    }
  }
  return {
    top: safeArea.top,
    right: safeArea.right,
    bottom: safeArea.bottom,
    left: safeArea.left,
  }
}

function freezeRectangle(x, y, width, height) {
  return Object.freeze({ x, y, width, height })
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value
  }
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}

export function classifyBattlefieldLayout(width, height) {
  assertPositiveFinite(width, 'width')
  assertPositiveFinite(height, 'height')

  if (Math.min(width, height) <= 520) {
    return width > height ? 'phone-landscape' : 'phone-portrait'
  }
  if (width < 1180 || height < 700) return 'tablet'
  return 'desktop'
}

export function createBattlefieldLayout({
  width,
  height,
  safeArea = undefined,
} = {}) {
  assertPositiveFinite(width, 'width')
  assertPositiveFinite(height, 'height')
  const safe = normalizeSafeArea(safeArea)
  const mode = classifyBattlefieldLayout(width, height)
  const spec = MODE_SPECS[mode]
  const minimumWidth = mode === 'phone-landscape'
    ? MINIMUM_VIEWPORT.height
    : MINIMUM_VIEWPORT.width
  const minimumHeight = mode === 'phone-landscape'
    ? MINIMUM_VIEWPORT.width
    : MINIMUM_VIEWPORT.height
  const logicalWidth = Math.max(width, minimumWidth)
  const logicalHeight = Math.max(height, minimumHeight)
  if (safe.left + safe.right >= width) {
    throw new RangeError('safeArea horizontal insets must leave visible width')
  }
  if (safe.top + safe.bottom >= height) {
    throw new RangeError('safeArea vertical insets must leave visible height')
  }
  const scale = Math.min(width / logicalWidth, height / logicalHeight, 1)
  const letterboxed = scale < 1
  const footerReserve = spec.hud.footer
    + 44 * (1 / scale - 1)
  const logicalSafe = Object.fromEntries(
    Object.entries(safe).map(([side, value]) => [side, value / scale]),
  )
  const contentWidth = Math.max(1, logicalWidth - logicalSafe.left - logicalSafe.right)
  const contentHeight = Math.max(1, logicalHeight - logicalSafe.top - logicalSafe.bottom)
  const header = freezeRectangle(
    logicalSafe.left,
    logicalSafe.top,
    contentWidth,
    Math.min(spec.hud.header, contentHeight),
  )
  const footerHeight = Math.min(
    footerReserve,
    Math.max(0, contentHeight - header.height),
  )
  const footer = freezeRectangle(
    logicalSafe.left,
    logicalHeight - logicalSafe.bottom - footerHeight,
    contentWidth,
    footerHeight,
  )
  const comparisonY = header.y + header.height
  const comparison = freezeRectangle(
    logicalSafe.left,
    comparisonY,
    contentWidth,
    Math.min(spec.hud.comparison, Math.max(0, footer.y - comparisonY - 1)),
  )
  const middleY = comparison.y + comparison.height
  const middleHeight = Math.max(1, footer.y - middleY)
  const panelY = mode === 'phone-landscape'
    ? header.y + header.height
    : middleY
  const panelHeight = Math.max(1, footer.y - panelY)
  const sideWidth = Math.min(spec.hud.side, Math.max(0, contentWidth / 2 - 1))
  const leftPanel = freezeRectangle(logicalSafe.left, panelY, sideWidth, panelHeight)
  const rightPanel = freezeRectangle(
    logicalWidth - logicalSafe.right - sideWidth,
    panelY,
    sideWidth,
    panelHeight,
  )
  const battlefield = freezeRectangle(
    logicalSafe.left + sideWidth,
    middleY,
    Math.max(1, contentWidth - sideWidth * 2),
    middleHeight,
  )

  const fov = 38
  const aspect = width / height
  const battlefieldWidthFraction = battlefield.width * scale / width
  const battlefieldHeightFraction = battlefield.height * scale / height
  const verticalRadians = fov * Math.PI / 180
  const verticalDistance = spec.world.height
    / (2 * Math.tan(verticalRadians / 2) * battlefieldHeightFraction)
  const horizontalDistance = spec.world.width
    / (2 * Math.tan(verticalRadians / 2) * aspect * battlefieldWidthFraction)
  const distance = Math.max(verticalDistance, horizontalDistance) * 1.08
  const visibleHeight = 2 * distance * Math.tan(verticalRadians / 2)
  const visibleWidth = visibleHeight * aspect
  const battlefieldCenterX = battlefield.x + battlefield.width / 2
  const battlefieldCenterY = battlefield.y + battlefield.height / 2
  const renderedWidth = logicalWidth * scale
  const renderedHeight = logicalHeight * scale
  const normalizedCenterX = (
    (width - renderedWidth) / 2 + battlefieldCenterX * scale
  ) / width * 2 - 1
  const normalizedCenterY = 1 - (
    (height - renderedHeight) / 2 + battlefieldCenterY * scale
  ) / height * 2

  return deepFreeze({
    mode,
    viewport: {
      width,
      height,
      logicalWidth,
      logicalHeight,
      minimumWidth,
      minimumHeight,
      scale,
      letterboxed,
    },
    safeArea: logicalSafe,
    hud: {
      header,
      comparison,
      footer,
      leftPanel,
      rightPanel,
      battlefield,
    },
    camera: {
      fov,
      near: 0.1,
      far: distance + Math.max(spec.world.width, spec.world.height),
      aspect,
      distance,
      target: {
        x: -normalizedCenterX * visibleWidth / 2,
        y: -normalizedCenterY * visibleHeight / 2,
        z: 0,
      },
    },
    world: {
      width: spec.world.width,
      height: spec.world.height,
    },
    visuals: {
      ...spec.visuals,
    },
    zones: Object.fromEntries(
      BATTLEFIELD_ZONE_IDS.map((zoneId) => [
        zoneId,
        { ...spec.zones[zoneId] },
      ]),
    ),
  })
}

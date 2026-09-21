import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BATTLEFIELD_LAYOUT_MODES,
  BATTLEFIELD_ZONE_IDS,
  MINIMUM_VIEWPORT,
  classifyBattlefieldLayout,
  createBattlefieldLayout,
} from '../../src/presentation/layout.js'

function allObjects(value) {
  if (value === null || typeof value !== 'object') return []
  return [value, ...Object.values(value).flatMap(allObjects)]
}

test('layout modes cover representative phone, tablet, and desktop viewports', () => {
  assert.deepEqual(BATTLEFIELD_LAYOUT_MODES, [
    'phone-portrait',
    'phone-landscape',
    'tablet',
    'desktop',
  ])
  assert.equal(classifyBattlefieldLayout(320, 480), 'phone-portrait')
  assert.equal(classifyBattlefieldLayout(844, 390), 'phone-landscape')
  assert.equal(classifyBattlefieldLayout(768, 1024), 'tablet')
  assert.equal(classifyBattlefieldLayout(1440, 900), 'desktop')

  assert.equal(classifyBattlefieldLayout(520, 900), 'phone-portrait')
  assert.equal(classifyBattlefieldLayout(900, 520), 'phone-landscape')
  assert.equal(classifyBattlefieldLayout(521, 700), 'tablet')
  assert.equal(classifyBattlefieldLayout(1180, 700), 'desktop')
})

test('layout exposes immutable logical anchors for every battlefield zone', () => {
  const layout = createBattlefieldLayout({ width: 1440, height: 900 })

  assert.deepEqual(Object.keys(layout.zones), BATTLEFIELD_ZONE_IDS)
  assert.ok(BATTLEFIELD_ZONE_IDS.every((zoneId) => {
    const position = layout.zones[zoneId]
    return [position.x, position.y, position.z].every(Number.isFinite)
  }))
  assert.ok(layout.zones.opponentReveal.y > layout.zones.playerReveal.y)
  assert.ok(layout.zones.opponentDrawPile.y > 0)
  assert.ok(layout.zones.playerDrawPile.y < 0)
  assert.ok(allObjects(layout).every(Object.isFrozen))
})

test('safe areas and HUD reserves leave a positive camera-fitting battlefield rectangle', () => {
  const layout = createBattlefieldLayout({
    width: 1440,
    height: 900,
    safeArea: { top: 10, right: 20, bottom: 30, left: 40 },
  })

  assert.deepEqual(layout.safeArea, { top: 10, right: 20, bottom: 30, left: 40 })
  assert.deepEqual(layout.hud.header, {
    x: 40,
    y: 10,
    width: 1380,
    height: 76,
  })
  assert.equal(layout.hud.footer.y + layout.hud.footer.height, 870)
  assert.equal(layout.hud.battlefield.y, layout.hud.header.y + layout.hud.header.height)
  assert.equal(
    layout.hud.battlefield.y + layout.hud.battlefield.height,
    layout.hud.footer.y,
  )
  assert.ok(layout.hud.battlefield.width > 0)
  assert.ok(layout.hud.battlefield.height > 0)

  const verticalRadians = layout.camera.fov * Math.PI / 180
  const visibleHeight = 2 * layout.camera.distance * Math.tan(verticalRadians / 2)
  const visibleWidth = visibleHeight * layout.camera.aspect
  assert.ok(
    visibleHeight * layout.hud.battlefield.height / layout.viewport.logicalHeight
      >= layout.world.height,
  )
  assert.ok(
    visibleWidth * layout.hud.battlefield.width / layout.viewport.logicalWidth
      >= layout.world.width,
  )
})

test('the minimum viewport is direct and smaller viewports use a stable letterbox scale', () => {
  const minimum = createBattlefieldLayout(MINIMUM_VIEWPORT)
  assert.equal(minimum.viewport.letterboxed, false)
  assert.equal(minimum.viewport.scale, 1)
  assert.equal(minimum.viewport.logicalWidth, 320)
  assert.equal(minimum.viewport.logicalHeight, 480)
  assert.equal(minimum.viewport.minimumWidth, 320)
  assert.equal(minimum.viewport.minimumHeight, 480)

  const smaller = createBattlefieldLayout({ width: 280, height: 400 })
  assert.equal(smaller.mode, 'phone-portrait')
  assert.equal(smaller.viewport.letterboxed, true)
  assert.equal(smaller.viewport.logicalWidth, 320)
  assert.equal(smaller.viewport.logicalHeight, 480)
  assert.equal(smaller.viewport.scale, 5 / 6)

  const landscape = createBattlefieldLayout({ width: 844, height: 390 })
  assert.equal(landscape.viewport.letterboxed, false)
  assert.equal(landscape.viewport.logicalWidth, 844)
  assert.equal(landscape.viewport.logicalHeight, 390)
  assert.equal(landscape.viewport.minimumWidth, 480)
  assert.equal(landscape.viewport.minimumHeight, 320)
  assert.equal(landscape.hud.footer.height, 114)

  const tablet = createBattlefieldLayout({ width: 768, height: 1024 })
  assert.equal(tablet.hud.footer.height, 114)

  const smallerLandscape = createBattlefieldLayout({ width: 400, height: 280 })
  assert.equal(smallerLandscape.viewport.letterboxed, true)
  assert.equal(smallerLandscape.viewport.logicalWidth, 480)
  assert.equal(smallerLandscape.viewport.logicalHeight, 320)
  assert.equal(smallerLandscape.viewport.scale, 5 / 6)
  assert.ok(Math.abs(smallerLandscape.hud.footer.height - 131.6) < Number.EPSILON * 100)

  assert.equal(minimum.hud.footer.height, 210)
  assert.ok(
    Math.abs(smaller.hud.footer.height - 218.8) < Number.EPSILON * 100,
  )
})

test('camera far plane includes the fitted distance and battlefield depth margin', () => {
  const layout = createBattlefieldLayout({
    width: 320,
    height: 480,
    safeArea: { top: 60, right: 0, bottom: 60, left: 0 },
  })

  assert.ok(layout.camera.distance > 100)
  assert.equal(
    layout.camera.far,
    layout.camera.distance + Math.max(layout.world.width, layout.world.height),
  )
})

test('letterboxed layouts preserve physical safe areas and fit the scaled battlefield', () => {
  const physicalSafeArea = { top: 20, right: 10, bottom: 12, left: 8 }
  const layout = createBattlefieldLayout({
    width: 280,
    height: 480,
    safeArea: physicalSafeArea,
  })

  for (const [side, value] of Object.entries(physicalSafeArea)) {
    assert.equal(layout.safeArea[side] * layout.viewport.scale, value)
  }

  const verticalRadians = layout.camera.fov * Math.PI / 180
  const visibleHeight = 2 * layout.camera.distance * Math.tan(verticalRadians / 2)
  const visibleWidth = visibleHeight * layout.camera.aspect
  assert.ok(
    visibleHeight * layout.hud.battlefield.height * layout.viewport.scale
      / layout.viewport.height >= layout.world.height,
  )
  assert.ok(
    visibleWidth * layout.hud.battlefield.width * layout.viewport.scale
      / layout.viewport.width >= layout.world.width,
  )
})

test('layout rejects malformed dimensions and safe areas', () => {
  assert.throws(() => classifyBattlefieldLayout(0, 480), /width/)
  assert.throws(() => classifyBattlefieldLayout(320, Number.NaN), /height/)
  assert.throws(() => createBattlefieldLayout(), /width/)
  assert.throws(
    () => createBattlefieldLayout({
      width: 320,
      height: 480,
      safeArea: { top: 0, right: 0, bottom: 0 },
    }),
    /exactly/,
  )
  assert.throws(
    () => createBattlefieldLayout({
      width: 320,
      height: 480,
      safeArea: { top: -1, right: 0, bottom: 0, left: 0 },
    }),
    /safeArea.top/,
  )
  assert.throws(
    () => createBattlefieldLayout({
      width: 320,
      height: 480,
      safeArea: { top: 240, right: 0, bottom: 240, left: 0 },
    }),
    /visible height/,
  )
})

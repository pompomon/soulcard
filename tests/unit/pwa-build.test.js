import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import viteConfig, { createServiceWorkerPlugin } from '../../vite.config.js'

const ROOT = new URL('../../', import.meta.url)
const PUBLIC_FILES = [
  'apple-touch-icon.png',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
  'icon.svg',
  'manifest.webmanifest',
]
const WORKER_TEMPLATE = `
const BUILD_REVISION = /* INJECT_BUILD_REVISION */ 'dev'
const BUILD_ASSETS = /* INJECT_BUILD_ASSETS */ []
`

function pngDimensions(buffer) {
  assert.equal(buffer.subarray(1, 4).toString(), 'PNG')
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  }
}

test('manifest and document expose relative install metadata and complete icons', async () => {
  const manifest = JSON.parse(await readFile(new URL('public/manifest.webmanifest', ROOT)))
  assert.equal(manifest.id, './')
  assert.equal(manifest.scope, './')
  assert.equal(manifest.start_url, './')
  assert.equal(manifest.display, 'fullscreen')

  const expectedIcons = new Map([
    ['./icon.svg', ['any', 'any']],
    ['./icon-192.png', ['192x192', 'any']],
    ['./icon-512.png', ['512x512', 'any']],
    ['./icon-maskable-512.png', ['512x512', 'maskable']],
  ])
  assert.equal(manifest.icons.length, expectedIcons.size)
  for (const icon of manifest.icons) {
    assert.deepEqual([icon.sizes, icon.purpose], expectedIcons.get(icon.src))
    assert.match(icon.src, /^\.\//)
  }

  for (const [fileName, size] of [
    ['icon-192.png', 192],
    ['icon-512.png', 512],
    ['icon-maskable-512.png', 512],
    ['apple-touch-icon.png', 180],
  ]) {
    assert.deepEqual(
      pngDimensions(await readFile(new URL(`public/${fileName}`, ROOT))),
      { width: size, height: size },
    )
  }

  const html = await readFile(new URL('index.html', ROOT), 'utf8')
  assert.match(html, /viewport-fit=cover/)
  assert.match(html, /rel="manifest" href="\.\/manifest\.webmanifest"/)
  assert.match(html, /rel="apple-touch-icon" href="\.\/apple-touch-icon\.png"/)
})

test('build plugin injects a deterministic complete shell and content revision', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'soulcard-pwa-build-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const hdChunk = 'assets/tarot-hd-Cq1x9ZpA.js'
  const hdArt = 'assets/tarot-hd-art-c-2S-B4xkF2aQ.webp'
  await mkdir(join(directory, 'assets'))
  await Promise.all([
    writeFile(join(directory, 'sw.js'), WORKER_TEMPLATE),
    writeFile(join(directory, 'index.html'), '<main>first</main>'),
    writeFile(join(directory, 'assets-app.js'), 'console.log("app")'),
    writeFile(join(directory, 'assets-app.css'), 'body{}'),
    writeFile(join(directory, hdChunk), 'export const hd = true'),
    writeFile(join(directory, hdArt), 'first art'),
    ...PUBLIC_FILES.map((fileName) => writeFile(
      join(directory, fileName),
      `${fileName}-content`,
    )),
  ])
  const bundle = {
    'assets-app.js': {},
    'index.html': {},
    'assets-app.css': {},
    [hdChunk]: {},
    [hdArt]: {},
  }
  const plugin = createServiceWorkerPlugin()

  await plugin.writeBundle({ dir: directory }, bundle)
  const first = await readFile(join(directory, 'sw.js'), 'utf8')
  assert.doesNotMatch(first, /INJECT_BUILD/)
  const assets = JSON.parse(first.match(/const BUILD_ASSETS = (\[[^\n]+\])/)[1])
  assert.deepEqual(assets, [
    './',
    './index.html',
    './apple-touch-icon.png',
    './icon-192.png',
    './icon-512.png',
    './icon-maskable-512.png',
    './icon.svg',
    './manifest.webmanifest',
    './assets-app.css',
    './assets-app.js',
    `./${hdChunk}`,
  ])
  const firstRevision = first.match(/const BUILD_REVISION = "([a-f0-9]{12})"/)[1]

  // The opt-in art pack is neither precached nor part of the shell revision.
  await writeFile(join(directory, hdArt), 'revised art')
  await writeFile(join(directory, 'sw.js'), WORKER_TEMPLATE)
  await plugin.writeBundle({ dir: directory }, bundle)
  const revisedArt = await readFile(join(directory, 'sw.js'), 'utf8')
  assert.equal(
    revisedArt.match(/const BUILD_REVISION = "([a-f0-9]{12})"/)[1],
    firstRevision,
  )
  assert.doesNotMatch(revisedArt, /tarot-hd-art-/)

  await writeFile(join(directory, 'index.html'), '<main>second</main>')
  await writeFile(join(directory, 'sw.js'), WORKER_TEMPLATE)
  await plugin.writeBundle({ dir: directory }, bundle)
  const second = await readFile(join(directory, 'sw.js'), 'utf8')
  const secondRevision = second.match(/const BUILD_REVISION = "([a-f0-9]{12})"/)[1]
  assert.notEqual(secondRevision, firstRevision)

  await writeFile(join(directory, 'sw.js'), 'const missing = true')
  await assert.rejects(
    plugin.writeBundle({ dir: directory }, bundle),
    /placeholders are missing/,
  )
})

test('card art is always emitted as a file instead of being inlined', () => {
  const inline = viteConfig.build.assetsInlineLimit
  assert.equal(typeof inline, 'function')
  const content = Buffer.alloc(16)
  assert.equal(inline('/repo/src/assets/card-art/tarot-hd/tarot-hd-art-back.webp', content), false)
  assert.equal(
    inline('C:\\repo\\src\\assets\\card-art\\tarot-hd\\tarot-hd-art-back.webp', content),
    false,
  )
  assert.equal(inline('/repo/src/assets/other.png', content), undefined)
  assert.equal(inline('/repo/public/icon.svg', content), undefined)
})

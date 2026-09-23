import { defineConfig } from 'vite'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const ASSETS_PLACEHOLDER = '/* INJECT_BUILD_ASSETS */ []'
const REVISION_PLACEHOLDER = "/* INJECT_BUILD_REVISION */ 'dev'"
const PUBLIC_SHELL_FILES = Object.freeze([
  'apple-touch-icon.png',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
  'icon.svg',
  'manifest.webmanifest',
])

export function createServiceWorkerPlugin() {
  return {
    name: 'inject-service-worker-assets',
    apply: 'build',
    async writeBundle(options, bundle) {
      const outputDirectory = options.dir
      const serviceWorker = resolve(outputDirectory, 'sw.js')
      const source = await readFile(serviceWorker, 'utf8')
      if (
        !source.includes(ASSETS_PLACEHOLDER)
        || !source.includes(REVISION_PLACEHOLDER)
      ) {
        throw new Error('Service worker injection placeholders are missing')
      }

      const emittedFiles = Object.keys(bundle)
        .filter((fileName) => fileName !== 'index.html' && fileName !== 'sw.js')
        .sort()
      const contentFiles = [
        'index.html',
        ...PUBLIC_SHELL_FILES,
        ...emittedFiles,
      ]
      const assets = [
        './',
        ...contentFiles.map((fileName) => `./${fileName}`),
      ]
      const revisionHash = createHash('sha256')
        .update('sw.js\0')
        .update(source)

      for (const fileName of contentFiles) {
        revisionHash
          .update(`\0${fileName}\0`)
          .update(await readFile(resolve(outputDirectory, fileName)))
      }
      const revision = revisionHash.digest('hex').slice(0, 12)
      const injected = source
        .replace(ASSETS_PLACEHOLDER, JSON.stringify(assets))
        .replace(REVISION_PLACEHOLDER, JSON.stringify(revision))

      if (
        injected.includes('INJECT_BUILD_ASSETS')
        || injected.includes('INJECT_BUILD_REVISION')
      ) {
        throw new Error('Service worker injection did not replace every placeholder')
      }
      await writeFile(serviceWorker, injected)
    },
  }
}

export default defineConfig({
  base: './',
  plugins: [createServiceWorkerPlugin()],
})

import { defineConfig } from 'vite'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export default defineConfig({
  base: './',
  plugins: [
    {
      name: 'inject-service-worker-assets',
      apply: 'build',
      async writeBundle(options, bundle) {
        const serviceWorker = resolve(options.dir, 'sw.js')
        const source = await readFile(serviceWorker, 'utf8')
        const assets = Object.keys(bundle)
          .filter((fileName) => fileName !== 'index.html')
          .map((fileName) => `./${fileName}`)
        const appShellContent = await Promise.all(
          ['manifest.webmanifest', 'icon.svg'].map((fileName) =>
            readFile(resolve(options.dir, fileName)),
          ),
        )
        const revision = createHash('sha256')
          .update(JSON.stringify(assets))
          .update(Buffer.concat(appShellContent))
          .digest('hex')
          .slice(0, 12)

        await writeFile(
          serviceWorker,
          source
            .replace('/* INJECT_BUILD_ASSETS */ []', JSON.stringify(assets))
            .replace("/* INJECT_BUILD_REVISION */ 'dev'", JSON.stringify(revision)),
        )
      },
    },
  ],
})

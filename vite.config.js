import { defineConfig } from 'vite'
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

        await writeFile(
          serviceWorker,
          source.replace('/* INJECT_BUILD_ASSETS */ []', JSON.stringify(assets)),
        )
      },
    },
  ],
})

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: path.join(HERE, 'panel'),
  plugins: [viteSingleFile()],
  build: {
    outDir: path.join(HERE, 'dist'),
    emptyOutDir: true,
    assetsInlineLimit: 100_000_000,
    rollupOptions: {
      input: path.join(HERE, 'panel', 'index.html'),
    },
  },
})

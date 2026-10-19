import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // The lazily loaded editor chunk (ProseMirror, Tiptap, Yjs) is ~530 kB, ~170 kB gzipped,
    // and only downloads when a document opens. Anything else crossing this limit is a regression.
    chunkSizeWarningLimit: 600,
  },
  server: {
    port: 5173,
    // Same-origin /api in development, WebSockets included, mirroring the Vercel rewrite.
    proxy: {
      '/api': { target: 'http://localhost:8000', changeOrigin: true, ws: true },
    },
  },
  test: {
    environment: 'jsdom',
    // The first test in a file that opens a document imports the editor (ProseMirror, Tiptap,
    // Yjs), which can take seconds on a busy machine: 5 s made healthy tests time out.
    testTimeout: 15_000,
    setupFiles: ['./src/test/setup.ts'],
    unstubGlobals: true,
  },
})

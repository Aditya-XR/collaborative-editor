import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { defineConfig } from 'vitest/config'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // The app shell offline, and installable (ADR 0019). Workbox precaches every file the build
    // emits, the lazily loaded editor and export chunks included, so a document opens with no
    // network; the API and WebSockets are never cached or intercepted.
    VitePWA({
      // src/lib/serviceWorker.ts registers it, and asks before switching to a new version.
      injectRegister: false,
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'CollabEdit',
        short_name: 'CollabEdit',
        description: 'Write together in real time, offline too.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#4f46e5',
        icons: [
          { src: '/pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/pwa-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/pwa-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
        // Every page of this single-page app is index.html; addresses under /api are the API's.
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        // The editor chunk is ~530 kB; Workbox skips files over 2 MiB by default, silently.
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        // The first worker takes over the page that installed it, so a document opens offline
        // even before any reload. Updates still wait for the person (prompt above).
        clientsClaim: true,
      },
    }),
  ],
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

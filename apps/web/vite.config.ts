import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'script-defer',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Ndox',
        short_name: 'Ndox',
        description: 'Quand la mer dit non, Ndox paie.',
        lang: 'fr',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#F6F8FA',
        theme_color: '#0B5C8E',
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
        // The app shell plus the Latin subsets of Inter; other scripts load on demand.
        globPatterns: ['**/*.{js,css,html,svg,png}', '**/inter-latin*-wght-normal-*.woff2'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/e\//, /^\/healthz/],
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            // The reads the home page needs offline (status, pool, schedule): fresh when online,
            // the last answer when the network is gone. Admin is never cached. A RegExp, not a
            // function: workbox serialises this into sw.js, where closures do not exist.
            urlPattern: /\/api\/(today|pool|meta)(\?|$)/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'ndox-public-api',
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 10, maxAgeSeconds: 7 * 24 * 3600 },
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8080',
      '/healthz': 'http://localhost:8080',
      '/e/': 'http://localhost:8080',
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
  },
});

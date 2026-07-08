import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// GitHub Pages sirve el sitio bajo /<nombre-del-repo>/.
// Si cambias el nombre del repo, actualiza BASE aqui.
const BASE = '/rc_pwa/';

export default defineConfig({
  base: BASE,
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      // Precachea TODO el bundle -> la app carga y funciona 100% offline.
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
      },
      includeAssets: ['apple-touch-icon.png', 'favicon.svg'],
      manifest: {
        name: 'Tablero RF - Control Remoto',
        short_name: 'Tablero',
        description: 'Control remoto BLE para el tablero marcador de futbol.',
        lang: 'es',
        display: 'fullscreen',
        display_override: ['fullscreen', 'standalone'],
        orientation: 'portrait',
        background_color: '#0b0f17',
        theme_color: '#0b0f17',
        start_url: '.',
        scope: BASE,
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      devOptions: {
        // Permite probar el SW/manifest tambien en `npm run dev`.
        enabled: true,
      },
    }),
  ],
});

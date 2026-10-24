import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

const backendPort = process.env.LUMEN_DEV_BACKEND_PORT ?? '3000';
if (!/^\d+$/.test(backendPort) || Number(backendPort) < 1 || Number(backendPort) > 65535) throw new Error('LUMEN_DEV_BACKEND_PORT must be a port from 1 to 65535.');
const backendOrigin = `http://127.0.0.1:${backendPort}`;
const backendSocket = `ws://127.0.0.1:${backendPort}`;

export default defineConfig({
  // Each local Watch launcher owns its optimizer cache; simultaneous isolated
  // tests must not invalidate a normal Studio development server's modules.
  cacheDir: process.env.LUMEN_DEV_VITE_CACHE_DIR ?? 'node_modules/.vite',
  plugins: [vue(), tailwindcss()],
  // PowerSync ships module workers and WASM. Prebundling breaks their URLs.
  optimizeDeps: { exclude: ['@powersync/web'] },
  worker: { format: 'es' },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': backendOrigin,
      '/media': backendOrigin,
      '/ws': { target: backendSocket, ws: true },
      '/studio/ws': { target: backendSocket, ws: true },
      '/mobile/signal': { target: backendSocket, ws: true },
    },
  },
});

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: the Vite server proxies /api to the live Worker by default (real data, no wrangler needed);
// set API_PROXY=http://127.0.0.1:8787 to use `wrangler dev` instead.
// Prod: the Worker serves dist/ itself, so no proxy is needed.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  server: {
    port: 5173,
    // `vite --mode localapi` (npm run dev:local) talks to `wrangler dev` on 8787; default = the live Worker
    proxy: { '/api': { target: mode === 'localapi' ? (process.env.API_PROXY ?? 'http://127.0.0.1:8787') : (process.env.API_PROXY ?? 'https://leadtouch.eduportbi.workers.dev'), changeOrigin: true } },
  },
  build: {
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: { vendor: ['react', 'react-dom', 'react-router-dom'], charts: ['recharts'], table: ['@tanstack/react-table', '@tanstack/react-query'] },
      },
    },
  },
}));

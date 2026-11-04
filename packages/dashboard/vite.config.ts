import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const worker = 'http://localhost:8787';

// The dashboard is served by the Worker's static assets at /app/ (the Worker answers deep links with index.html).
// `vite` runs it on :5174 against `wrangler dev` on :8787.
export default defineConfig({
  plugins: [preact()],
  base: '/app/',
  server: {
    port: 5174,
    strictPort: true,
    proxy: Object.fromEntries(['/v1', '/login', '/logout', '/dev', '/widget.js'].map((p) => [p, worker])),
  },
  build: {
    outDir: resolve(here, '../worker/public/app'),
    emptyOutDir: true,
    sourcemap: false,
    modulePreload: { polyfill: false },
  },
});

import { defineConfig, type Plugin } from 'vite';
import preact from '@preact/preset-vite';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outFile = resolve(here, 'dist/widget.js');
const workerCopy = resolve(here, '../worker/public/widget.js');

/** After `vite build`, copy the bundle to the Worker's static assets so it serves /widget.js. */
function copyToWorker(): Plugin {
  return {
    name: 'annotate:copy-to-worker',
    apply: 'build',
    closeBundle() {
      if (!existsSync(outFile)) return;
      mkdirSync(dirname(workerCopy), { recursive: true });
      copyFileSync(outFile, workerCopy);
      console.log(`\n  copied dist/widget.js → ${workerCopy}`);
    },
  };
}

/** `vite` serves the test page at / as well as /dev/index.html. */
function devIndex(): Plugin {
  return {
    name: 'annotate:dev-index',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url === '/' || req.url?.startsWith('/?')) req.url = '/dev/index.html' + req.url.slice(1);
        next();
      });
    },
  };
}

export default defineConfig(({ command }) => ({
  plugins: [preact(), copyToWorker(), devIndex()],
  publicDir: false,
  server: { port: 5173, strictPort: true },
  // Library mode doesn't replace this by itself; dependencies may branch on it.
  define: command === 'build' ? { 'process.env.NODE_ENV': JSON.stringify('production') } : {},
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    minify: true,
    lib: {
      entry: resolve(here, 'src/index.ts'),
      name: 'AnnotateWidget',
      formats: ['iife'],
      fileName: () => 'widget.js',
    },
  },
}));

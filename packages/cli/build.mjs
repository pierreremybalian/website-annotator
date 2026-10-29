// Bundles src/index.ts into a single executable dist/annotate.mjs (Node ≥20, ESM, no runtime deps).
// The skill's SKILL.md is inlined as text (`?raw` imports).
import { build } from 'esbuild';
import { chmod, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(await readFile(path.join(here, 'package.json'), 'utf8'));
const outfile = path.join(here, 'dist', 'annotate.mjs');

/** @type {import('esbuild').Plugin} */
const raw = {
  name: 'raw',
  setup(b) {
    b.onResolve({ filter: /\?raw$/ }, (args) => ({
      path: path.resolve(args.resolveDir, args.path.slice(0, -'?raw'.length)),
      namespace: 'raw',
    }));
    b.onLoad({ filter: /.*/, namespace: 'raw' }, async (args) => ({
      contents: await readFile(args.path, 'utf8'),
      loader: 'text',
      watchFiles: [args.path],
    }));
  },
};

await build({
  entryPoints: [path.join(here, 'src', 'index.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  banner: { js: '#!/usr/bin/env node' },
  define: { __ANNOTATE_VERSION__: JSON.stringify(pkg.version) },
  plugins: [raw],
  legalComments: 'none',
  logLevel: 'warning',
});
await chmod(outfile, 0o755);
console.log(`built ${path.relative(process.cwd(), outfile)} (v${pkg.version})`);

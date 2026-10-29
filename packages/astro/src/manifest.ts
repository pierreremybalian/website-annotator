// Source hints for production builds.
//
// How Astro scopes styles (verified against astro 7.4 / @astrojs/compiler-rs 0.5):
// - A component with a scoped <style> gets one scope hash: 8 chars of [a-z2-7], derived only from its
//   root-relative path (the compiler's `normalizedFilename`, e.g. "/src/components/Hero.astro"), not from its
//   contents. So the same file has the same hash in dev, CI and every local build of the same project.
// - With the default `scopedStyleStrategy: 'attribute'`, every element in that component's own template
//   (except <head>/<title>/<script>/<style>) is compiled with `data-astro-cid-<hash>`, and child components
//   receive `"data-astro-cid-<hash>": true` as a prop. With 'class'/'where' the hash is a class `astro-<hash>`.
//   Components without scoped styles get no attribute.
//
// The manifest is built from the compiled module output: after Astro's plugin compiles a .astro file, the
// hash appears in the generated template code. We take the most frequent one per module (it is on every
// element) and map it to the module's path relative to the project root. No compiler internals are imported
// and nothing is recomputed, so it keeps working if the hash function changes.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const MANIFEST_DIR = '.annotate';
export const MANIFEST_FILE = 'astro-cids.json';

export type ScopedStyleStrategy = 'attribute' | 'class' | 'where';

/** The subset of a Vite plugin these helpers return (avoids a direct `vite` dependency). */
export interface VitePluginLike {
  name: string;
  enforce?: 'pre' | 'post';
  apply?: 'build' | 'serve';
  load?: (id: string) => Promise<string | null> | string | null;
  transform?: (code: string, id: string) => null;
}

const ATTR_RE = /data-astro-cid-([a-z0-9]+)/g;
const CLASS_RE = /(?<![\w-])astro-([a-z2-7]{8})(?![\w-])/g;
/** Astro sub-requests: Foo.astro?astro&type=style&index=0&lang.css etc. */
const SUB_REQUEST_RE = /[?&]astro(?:[&=]|$)/;

/** The component's scope hash in its compiled module code, or null if it has no scoped styles. */
export function extractScopeHash(code: string, strategy: ScopedStyleStrategy = 'attribute'): string | null {
  const re = strategy === 'attribute' ? ATTR_RE : CLASS_RE;
  const counts = new Map<string, number>();
  for (const m of code.matchAll(re)) {
    const hash = m[1] as string;
    counts.set(hash, (counts.get(hash) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [hash, count] of counts) {
    if (count > bestCount) {
      best = hash;
      bestCount = count;
    }
  }
  return best;
}

/** Absolute file path of an .astro module id (query stripped), or null for virtual/sub-request/non-.astro ids. */
export function astroModuleFile(id: string): string | null {
  if (id.startsWith('\0') || id.startsWith('virtual:')) return null;
  if (SUB_REQUEST_RE.test(id)) return null;
  const file = id.replace(/[?#].*$/, '');
  if (!file.endsWith('.astro')) return null;
  return file.startsWith('/@fs/') ? file.slice(4) : file;
}

/** Path relative to the project root, with forward slashes ("src/components/Hero.astro"). */
export function relativeToRoot(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

/** Collects cid hash → component file while Vite builds. */
export class CidCollector {
  private readonly entries = new Map<string, string>();

  constructor(
    private readonly root: string,
    private readonly strategy: ScopedStyleStrategy = 'attribute',
  ) {}

  /** Record a compiled module. Returns the hash it found, if any. */
  add(id: string, code: string): string | null {
    const file = astroModuleFile(id);
    if (!file) return null;
    const hash = extractScopeHash(code, this.strategy);
    if (!hash) return null;
    // The same component compiles once per Vite environment (ssr/prerender); first one wins.
    if (!this.entries.has(hash)) this.entries.set(hash, relativeToRoot(this.root, file));
    return hash;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Sorted by hash for stable diffs. */
  toJSON(): Record<string, string> {
    return Object.fromEntries([...this.entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }
}

/** Build-only Vite plugin: sees each .astro module after Astro compiled it and records its scope hash. */
export function cidManifestPlugin(collector: CidCollector): VitePluginLike {
  return {
    name: 'annotate:astro-cids',
    enforce: 'post',
    apply: 'build',
    transform(code, id) {
      collector.add(id, code);
      return null;
    },
  };
}

/**
 * Write `<root>/.annotate/astro-cids.json` and a `.annotate/.gitignore` containing `*`, so the folder is ignored
 * by git in any repo without touching the site's own .gitignore. Returns the manifest path.
 */
export async function writeManifest(root: string, entries: Record<string, string>): Promise<string> {
  const dir = path.join(root, MANIFEST_DIR);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, MANIFEST_FILE);
  await writeFile(file, `${JSON.stringify(entries, null, 2)}\n`);
  const ignore = path.join(dir, '.gitignore');
  const current = await readFile(ignore, 'utf8').catch(() => null);
  if (current === null) await writeFile(ignore, '# Written by @annotate/astro: build metadata, never commit or deploy.\n*\n');
  return file;
}

// ---------------------------------------------------------------------------
// Opt-in `sourceAttributes`: data-annotate-source on component root elements (staging builds).

const FRONTMATTER_RE = /^(\s*---[^\S\r\n]*\r?\n(?:[\s\S]*?\r?\n)?---[^\S\r\n]*)(?:\r?\n|$)/;
const SKIP_ROOTS = new Set(['html', 'head', 'body', 'slot', 'script', 'style']);

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Add `data-annotate-source="<file>"` to the component's root element, in the .astro source before Astro
 * compiles it. Conservative: only when the template's first node (after frontmatter, whitespace, comments,
 * doctype and top-level <style>/<script>) is a plain lowercase HTML element other than html/head/body/slot.
 * Anything else (a component, an expression, text, Fragment) is left alone. Same line count, so line numbers
 * in errors and source maps stay right. Returns null when nothing changed.
 */
export function addSourceAttribute(source: string, file: string): string | null {
  const fm = FRONTMATTER_RE.exec(source);
  let i = fm ? fm[1]!.length : 0;
  const n = source.length;
  for (;;) {
    while (i < n && /\s/.test(source[i]!)) i++;
    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i + 4);
      if (end < 0) return null;
      i = end + 3;
      continue;
    }
    if (source.startsWith('<!', i)) {
      const end = source.indexOf('>', i);
      if (end < 0) return null;
      i = end + 1;
      continue;
    }
    const block = /^<(style|script)\b/i.exec(source.slice(i, i + 8));
    if (block) {
      const close = source.toLowerCase().indexOf(`</${block[1]!.toLowerCase()}`, i);
      if (close < 0) return null;
      const end = source.indexOf('>', close);
      if (end < 0) return null;
      i = end + 1;
      continue;
    }
    break;
  }
  const tag = /^<([a-z][a-z0-9]*(?:-[a-z0-9]+)*)(?=[\s/>])/.exec(source.slice(i, i + 80));
  if (!tag) return null;
  const name = tag[1]!;
  if (SKIP_ROOTS.has(name)) return null;
  const openEnd = source.indexOf('>', i);
  if (openEnd >= 0 && /\sdata-annotate-source\s*=/.test(source.slice(i, openEnd))) return null;
  const at = i + 1 + name.length;
  return `${source.slice(0, at)} data-annotate-source="${escapeAttr(file)}"${source.slice(at)}`;
}

/**
 * Build-only Vite plugin (enforce 'pre'): loads .astro files inside the project (not node_modules) and adds the
 * root attribute before Astro's compiler sees them. Astro compiles in its transform hook, so a load hook is the
 * one place that runs before it regardless of plugin order.
 */
export function sourceAttributesPlugin(root: string): VitePluginLike {
  return {
    name: 'annotate:astro-source-attributes',
    enforce: 'pre',
    apply: 'build',
    async load(id) {
      const file = astroModuleFile(id);
      if (!file || id !== file) return null; // only plain module requests, no query
      const rel = relativeToRoot(root, file);
      if (rel.startsWith('..') || path.isAbsolute(rel) || rel.split('/').includes('node_modules')) return null;
      const source = await readFile(file, 'utf8').catch(() => null);
      if (source === null) return null;
      return addSourceAttribute(source, rel); // null: unchanged, let Vite load it as usual
    },
  };
}

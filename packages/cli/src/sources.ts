// Map an issue's source hints to files in the local checkout. Runs locally only: file paths never
// travel over the network. All returned paths are POSIX, relative to the search root (git root, else
// the cwd); directories end in "/"; a known line is appended as ":<line>".
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { AgentIssueDetail, PageContext, SourceHint } from '@annotate/shared';

export interface PageTemplateHint {
  kind: 'page-template';
  /** context.page.template as reported by the WordPress adapter. */
  value: string;
}

export interface ResolvedSource {
  hint: SourceHint | PageTemplateHint;
  files: string[];
}

export interface ResolveResult {
  sources: ResolvedSource[];
  /** The file walk hit its limits, so some matches may be missing. */
  truncated: boolean;
}

export interface WalkLimits {
  maxDepth: number;
  maxEntries: number;
}

const SKIP_DIRS = new Set([
  'node_modules',
  'vendor',
  '.git',
  'dist',
  'build',
  '.astro',
  '.svn',
  '.hg',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.wrangler',
  '.vercel',
  '.netlify',
]);
const SKIP_PATHS = [/(^|\/)wp-content\/uploads$/, /(^|\/)\.annotate\/screenshots$/];
const ASSET_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.avif', '.ico', '.bmp',
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp4', '.webm', '.mov', '.mp3', '.wav',
  '.pdf', '.zip', '.map', '.lock', '.log',
]);
const MAX_FILES_PER_HINT = 10;
const MAX_JSON_BYTES = 512 * 1024;
const MAX_BLOCK_JSON = 5000;

const posix = path.posix;
const uniq = (xs: string[]) => [...new Set(xs)];
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Lazy breadth-first listing of the repo, skipping dependency/build/output directories. */
export class RepoIndex {
  files: string[] = [];
  dirs: string[] = [];
  truncated = false;
  private built = false;
  private jsonCache = new Map<string, unknown>();

  constructor(
    readonly root: string,
    readonly limits: WalkLimits = { maxDepth: 12, maxEntries: 100_000 },
  ) {}

  ensure(): this {
    if (this.built) return this;
    this.built = true;
    let count = 0;
    const queue: Array<[string, number]> = [['', 0]];
    for (let qi = 0; qi < queue.length; qi++) {
      const [rel, depth] = queue[qi] as [string, number];
      let entries;
      try {
        entries = readdirSync(rel ? path.join(this.root, rel) : this.root, { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const e of entries) {
        if (++count > this.limits.maxEntries) {
          this.truncated = true;
          return this;
        }
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(e.name) || SKIP_PATHS.some((re) => re.test(childRel))) continue;
          this.dirs.push(childRel);
          if (depth + 1 < this.limits.maxDepth) queue.push([childRel, depth + 1]);
          else this.truncated = true;
        } else if (e.isFile()) {
          this.files.push(childRel);
        }
      }
    }
    return this;
  }

  abs(rel: string): string {
    return path.join(this.root, rel);
  }

  kind(rel: string): 'file' | 'dir' | null {
    try {
      const st = statSync(this.abs(rel));
      return st.isDirectory() ? 'dir' : st.isFile() ? 'file' : null;
    } catch {
      return null;
    }
  }

  readJson(rel: string): unknown {
    if (this.jsonCache.has(rel)) return this.jsonCache.get(rel);
    let value: unknown = null;
    try {
      if (statSync(this.abs(rel)).size <= MAX_JSON_BYTES) value = JSON.parse(readFileSync(this.abs(rel), 'utf8'));
    } catch {
      value = null;
    }
    this.jsonCache.set(rel, value);
    return value;
  }
}

/** "src/x.astro:12:3" → { path: "src/x.astro", line: 12 } */
export function splitLine(raw: string): { path: string; line?: number } {
  const m = /^(.*?):(\d+)(?::\d+)?$/.exec(raw);
  if (m && m[1]) return { path: m[1], line: Number(m[2]) };
  return { path: raw };
}

const withLine = (file: string, line?: number) => (line && !file.endsWith('/') ? `${file}:${line}` : file);

export class SourceResolver {
  readonly index: RepoIndex;

  constructor(
    readonly root: string,
    readonly cwd: string = root,
    limits?: WalkLimits,
  ) {
    this.index = new RepoIndex(root, limits);
  }

  private display(rel: string, kind: 'file' | 'dir'): string {
    const clean = rel === '' ? '.' : rel;
    return kind === 'dir' ? `${clean.replace(/\/$/, '')}/` : clean;
  }

  /** Root-relative POSIX path for an absolute path under the root; null otherwise. */
  private underRoot(abs: string): string | null {
    const rel = path.relative(this.root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return rel.split(path.sep).join('/');
  }

  /**
   * A path as given: absolute under the root, relative to the root or the cwd. Paths from another
   * machine (/home/ci/site/src/x.astro) fall back to their longest suffix that exists here.
   */
  resolvePath(raw: string): string | null {
    const p = raw.trim().replace(/^file:\/\//, '');
    if (!p) return null;
    const tries: string[] = [];
    if (path.isAbsolute(p)) {
      const rel = this.underRoot(p);
      if (rel !== null) tries.push(rel);
    } else {
      tries.push(posix.normalize(p.replace(/\\/g, '/')).replace(/^\.\//, ''));
      const rel = this.underRoot(path.resolve(this.cwd, p));
      if (rel !== null) tries.push(rel);
    }
    for (const t of tries) {
      if (t.startsWith('..')) continue;
      const k = this.index.kind(t);
      if (k) return this.display(t, k);
    }
    const segs = p.replace(/\\/g, '/').split('/').filter(Boolean);
    for (let i = 1; i < segs.length; i++) {
      const suffix = segs.slice(i).join('/');
      const k = this.index.kind(suffix);
      if (k === 'file') return suffix;
    }
    return null;
  }

  resolveHint(hint: SourceHint): string[] {
    switch (hint.kind) {
      case 'wp-block':
        return this.wpBlock(hint.value);
      case 'astro-source':
        return this.astroSource(hint);
      case 'astro-cid':
        return this.astroCid(hint.value);
      case 'annotate':
        return this.annotate(hint);
      default:
        return [];
    }
  }

  /** block.json files whose "name" matches (+ their render template), then blocks/<slug>/, template-parts/blocks/<slug>*. */
  wpBlock(name: string): string[] {
    const idx = this.index.ensure();
    const out: string[] = [];
    let parsed = 0;
    for (const f of idx.files) {
      if (posix.basename(f) !== 'block.json') continue;
      if (++parsed > MAX_BLOCK_JSON) break;
      const json = idx.readJson(f) as Record<string, unknown> | null;
      if (!json || typeof json !== 'object' || json.name !== name) continue;
      const dir = posix.dirname(f);
      out.push(dir === '.' ? './' : `${dir}/`);
      for (const tpl of renderTemplates(json)) {
        const found = this.blockTemplate(dir, tpl);
        if (found) out.push(found);
      }
    }
    const slug = name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name;
    if (slug) {
      for (const d of idx.dirs) if (d === `blocks/${slug}` || d.endsWith(`/blocks/${slug}`)) out.push(`${d}/`);
      const re = new RegExp(`(^|/)template-parts/blocks/${escapeRe(slug)}[^/]*$`);
      for (const d of idx.dirs) if (re.test(d)) out.push(`${d}/`);
      for (const f of idx.files) if (re.test(f)) out.push(f);
    }
    return uniq(out).slice(0, MAX_FILES_PER_HINT);
  }

  /** A render template path from block.json: relative to the block's directory, else (ACF) to the theme. */
  private blockTemplate(dir: string, tpl: string): string | null {
    const clean = tpl.replace(/^file:/, '').trim();
    if (!clean) return null;
    const rel = posix.normalize(posix.join(dir, clean));
    if (!rel.startsWith('..') && this.index.kind(rel) === 'file') return rel;
    const themeRel = posix.normalize(clean).replace(/^(\.\/)+/, '').replace(/^\/+/, '');
    if (!themeRel || themeRel.startsWith('..')) return null;
    // Prefer a match that shares the block's top-level directories (same theme).
    const matches = this.index.files.filter((f) => f === themeRel || f.endsWith(`/${themeRel}`));
    const top = dir.split('/').slice(0, 3).join('/');
    return matches.find((m) => m.startsWith(top)) ?? matches[0] ?? null;
  }

  astroSource(hint: SourceHint): string[] {
    const { path: p, line } = splitLine(hint.file || hint.value);
    const found = this.resolvePath(p);
    return found ? [withLine(found, hint.line ?? line)] : [];
  }

  /** Look the hash up in every .annotate/astro-cids.json; entries are relative to the manifest's project. */
  astroCid(value: string): string[] {
    const hash = value.replace(/^data-astro-cid-/, '');
    const idx = this.index.ensure();
    const manifests = idx.files.filter((f) => f === '.annotate/astro-cids.json' || f.endsWith('/.annotate/astro-cids.json'));
    const out: string[] = [];
    for (const m of manifests) {
      const json = idx.readJson(m) as Record<string, unknown> | null;
      if (!json || typeof json !== 'object') continue;
      const entry = json[hash];
      const projectRoot = posix.dirname(posix.dirname(m));
      for (const file of Array.isArray(entry) ? entry : [entry]) {
        if (typeof file !== 'string' || !file) continue;
        const rel = posix.normalize(posix.join(projectRoot, file.replace(/\\/g, '/')));
        if (!rel.startsWith('..') && idx.kind(rel) === 'file') out.push(rel);
      }
    }
    return uniq(out).slice(0, MAX_FILES_PER_HINT);
  }

  /** A path that exists, else files with that basename (or that name plus any source extension). */
  annotate(hint: SourceHint): string[] {
    const { path: p, line: parsedLine } = splitLine(hint.file || hint.value);
    const line = hint.line ?? parsedLine;
    const direct = this.resolvePath(p) ?? (hint.file && hint.value !== hint.file ? this.resolvePath(splitLine(hint.value).path) : null);
    if (direct) return [withLine(direct, line)];
    const base = posix.basename(p.replace(/\\/g, '/').replace(/\/+$/, ''));
    if (!base) return [];
    const idx = this.index.ensure();
    const tail = posix.normalize(p.replace(/\\/g, '/')).replace(/^(\.\/|\/)+/, '');
    // Files whose path ends with the given partial path first.
    let matches = idx.files
      .filter((f) => posix.basename(f) === base)
      .sort((a, b) => Number(!(a === tail || a.endsWith(`/${tail}`))) - Number(!(b === tail || b.endsWith(`/${tail}`))));
    if (!matches.length) {
      const want = base.toLowerCase();
      matches = idx.files.filter((f) => {
        const b = posix.basename(f);
        const ext = posix.extname(b);
        return ext && !ASSET_EXT.has(ext.toLowerCase()) && b.slice(0, -ext.length).toLowerCase() === want;
      });
    }
    return matches.slice(0, MAX_FILES_PER_HINT).map((f) => withLine(f, line));
  }

  /** WordPress page template (context.page.template): a file name, theme-relative path, absolute server path or block template slug. */
  pageTemplate(template: string, theme?: string): string[] {
    const raw = template.trim().replace(/\\/g, '/');
    const candidates = posix.extname(raw) ? [raw] : [`${raw}.php`, `templates/${raw}.html`, `${raw}.html`];
    const idx = this.index.ensure();
    let matches: string[] = [];
    for (const cand of candidates) {
      const segs = cand.split('/').filter(Boolean);
      for (let k = segs.length; k >= 1 && !matches.length; k--) {
        const suffix = segs.slice(-k).join('/');
        matches = idx.files.filter((f) => f === suffix || f.endsWith(`/${suffix}`));
      }
      if (matches.length) break;
    }
    const score = (f: string) => {
      let s = 0;
      if (theme && (f.startsWith(`${theme}/`) || f.includes(`/${theme}/`))) s -= 2;
      if (f.includes('themes/')) s -= 1;
      return s;
    };
    return uniq(matches)
      .sort((a, b) => score(a) - score(b))
      .slice(0, 5);
  }

  resolveIssue(issue: Pick<AgentIssueDetail, 'sources' | 'context'>): ResolveResult {
    const hints = dedupeHints(issue.context?.element?.sources ?? issue.sources ?? []);
    const sources: ResolvedSource[] = hints.map((hint) => ({ hint, files: this.resolveHint(hint) }));
    const tpl = pageTemplateOf(issue.context?.page ?? null);
    if (tpl) {
      const theme = typeof issue.context?.page?.theme === 'string' ? issue.context.page.theme : undefined;
      sources.push({ hint: { kind: 'page-template', value: tpl }, files: this.pageTemplate(tpl, theme) });
    }
    return { sources, truncated: this.index.truncated };
  }
}

function renderTemplates(json: Record<string, unknown>): string[] {
  const acf = json.acf && typeof json.acf === 'object' ? (json.acf as Record<string, unknown>) : {};
  return [json.renderTemplate, acf.renderTemplate, json.render].filter((v): v is string => typeof v === 'string' && !!v.trim());
}

function dedupeHints(hints: SourceHint[]): SourceHint[] {
  const seen = new Set<string>();
  return hints.filter((h) => {
    if (!h || typeof h.value !== 'string') return false;
    const key = `${h.kind}\0${h.value}\0${h.file ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function pageTemplateOf(page: PageContext | null): string | null {
  const t = page?.template;
  if (typeof t !== 'string') return null;
  const v = t.trim();
  if (!v || v === 'default') return null;
  return v;
}

export function resolveSources(
  issue: Pick<AgentIssueDetail, 'sources' | 'context'>,
  opts: { root: string; cwd?: string; limits?: WalkLimits },
): ResolveResult {
  return new SourceResolver(opts.root, opts.cwd ?? opts.root, opts.limits).resolveIssue(issue);
}


import { chmodSync, existsSync, readFileSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Ctx } from './context';
import { CliError, EXIT, UsageError } from './errors';

export const CONFIG_FILE = '.annotate.json';
export const SCREENSHOT_DIR = '.annotate/screenshots';
export const DEFAULT_ENDPOINT = 'https://annotate.pierre-51f.workers.dev';

export interface AnnotateConfig {
  endpoint?: string;
  projectKey?: string;
  agentToken?: string;
  projectName?: string;
  boardName?: string;
  boardUrl?: string;
}

export interface FoundConfig {
  path: string;
  dir: string;
  config: AnnotateConfig;
}

/** Walk up from `start` to the filesystem root looking for .annotate.json, like git does for .git. */
export function findConfig(start: string): FoundConfig | null {
  let dir = path.resolve(start);
  for (;;) {
    const file = path.join(dir, CONFIG_FILE);
    if (existsSync(file) && statSync(file).isFile()) {
      let config: unknown;
      try {
        config = JSON.parse(readFileSync(file, 'utf8'));
      } catch (err) {
        throw new CliError(`${file} is not valid JSON (${(err as Error).message})`, EXIT.error);
      }
      if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw new CliError(`${file} must contain a JSON object`, EXIT.error);
      }
      return { path: file, dir, config: config as AnnotateConfig };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Nearest directory at or above `start` containing .git (a directory, or a file for worktrees). */
export function findGitRoot(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function normalizeEndpoint(raw: string): string {
  const value = raw.trim().replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UsageError(`invalid endpoint '${raw}' (expected a URL like ${DEFAULT_ENDPOINT})`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new UsageError(`invalid endpoint '${raw}' (expected http or https)`);
  }
  return value;
}

export interface Settings {
  endpoint: string;
  token: string | null;
  found: FoundConfig | null;
  /** Where project-local files go (.annotate/screenshots): the config's directory, else the cwd. */
  projectDir: string;
}

/** Precedence: --endpoint, ANNOTATE_ENDPOINT, .annotate.json, default. ANNOTATE_TOKEN beats the file's token. */
export function loadSettings(ctx: Ctx, endpointFlag?: string): Settings {
  const found = findConfig(ctx.cwd);
  const endpoint = normalizeEndpoint(endpointFlag || ctx.env.ANNOTATE_ENDPOINT || found?.config.endpoint || DEFAULT_ENDPOINT);
  const token = ctx.env.ANNOTATE_TOKEN || found?.config.agentToken || null;
  return { endpoint, token, found, projectDir: found?.dir ?? ctx.cwd };
}

export function requireToken(settings: Settings): string {
  if (settings.token) return settings.token;
  throw new CliError('not configured: no .annotate.json found here or above, and ANNOTATE_TOKEN is not set.', EXIT.notFound, {
    hint: 'Run `annotate init` to link this repo to a project (or `annotate connect` for a new one).',
  });
}

/** Writes .annotate.json with mode 0600 (also tightening an existing file). */
export function writeConfig(dir: string, config: AnnotateConfig): string {
  const file = path.join(dir, CONFIG_FILE);
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

/** Is `rel` (relative to the git root) ignored? Uses git when available, else a plain line match. */
function isIgnored(gitRoot: string, rel: string, lines: string[]): boolean {
  const r = spawnSync('git', ['check-ignore', '-q', '--no-index', rel], { cwd: gitRoot, stdio: 'ignore' });
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  const base = rel.replace(/\/$/, '');
  const wanted = new Set([base, `/${base}`, `${base}/`, `/${base}/`, `**/${base}`, `**/${base}/`, path.posix.basename(base)]);
  return lines.some((l) => wanted.has(l.trim()));
}

/**
 * If `dir` is inside a git repo whose .gitignore doesn't cover .annotate.json and .annotate/screenshots/,
 * append them to the repo's root .gitignore. Returns the entries added.
 */
export function ensureGitignored(dir: string): { gitignore: string; added: string[] } | null {
  const gitRoot = findGitRoot(dir);
  if (!gitRoot) return null;
  const gitignore = path.join(gitRoot, '.gitignore');
  const existing = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : '';
  const lines = existing.split(/\r?\n/);
  const prefix = path.relative(gitRoot, dir).split(path.sep).join('/');
  const entries = [
    // A pattern without a slash matches at any depth.
    { check: prefix ? `${prefix}/${CONFIG_FILE}` : CONFIG_FILE, write: CONFIG_FILE },
    // A pattern with a slash is anchored to the .gitignore's directory.
    { check: prefix ? `${prefix}/${SCREENSHOT_DIR}/` : `${SCREENSHOT_DIR}/`, write: prefix ? `/${prefix}/${SCREENSHOT_DIR}/` : `${SCREENSHOT_DIR}/` },
  ];
  const added = entries.filter((e) => !isIgnored(gitRoot, e.check, lines)).map((e) => e.write);
  if (!added.length) return { gitignore, added };
  const sep = existing && !existing.endsWith('\n') ? '\n' : '';
  appendFileSync(gitignore, `${sep}${existing ? '\n' : ''}# Annotate CLI (agent token, downloaded screenshots)\n${added.join('\n')}\n`);
  return { gitignore, added };
}

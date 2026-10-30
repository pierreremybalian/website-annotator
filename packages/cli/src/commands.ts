import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ParseArgsConfig } from 'node:util';
import type {
  AgentClaimRequest,
  AgentCommentRequest,
  AgentIssueDetail,
  AgentListIssuesResponse,
  AgentOriginRequest,
  AgentOriginsResponse,
  AgentProject,
  AgentReopenRequest,
  AgentResolveRequest,
} from '@annotate/shared';
import { AgentApi, NetworkError } from './api';
import { findGitRoot, loadSettings, requireToken, SCREENSHOT_DIR, type Settings } from './config';
import type { Ctx } from './context';
import { VERSION } from './context';
import { CliError, EXIT, exitCodeForStatus, UsageError } from './errors';
import { fmtWhen, type Style } from './format';
import { renderHandoff, runHandoff } from './handoff';
import { emptyIssuesMessage, renderIssueDetail, renderIssueTable, renderProject } from './render';
import { installSkill, SKILL, skillTarget } from './skill';
import { SourceResolver } from './sources';
import { watch } from './watch';

export type OptionSpec = NonNullable<ParseArgsConfig['options']>;

export interface Invocation {
  ctx: Ctx;
  command: string;
  values: Record<string, string | boolean | undefined>;
  positionals: string[];
  json: boolean;
  endpointFlag?: string;
  /** Styles for stdout. */
  style: Style;
  print(lines: string | string[]): void;
  printJson(data: unknown): void;
  warn(message: string): void;
}

export interface Command {
  name: string;
  aliases?: string[];
  options?: OptionSpec;
  /** Max positionals; extra ones are a usage error. Infinity for free text. */
  maxPositionals: number;
  run(inv: Invocation): Promise<number | void>;
}

export const ISSUE_STATUSES = ['open', 'new', 'in_progress', 'review', 'resolved', 'archived', 'all'] as const;

// ---------------------------------------------------------------------------
// Helpers

function agentApi(inv: Invocation): { api: AgentApi; settings: Settings } {
  const settings = loadSettings(inv.ctx, inv.endpointFlag);
  return { api: new AgentApi(inv.ctx, settings.endpoint, requireToken(settings)), settings };
}

export function parseIssueNumber(raw: string | undefined, command: string): number {
  if (raw === undefined || raw === '') throw new UsageError('missing issue number', command);
  const m = /^#?(\d+)$/.exec(raw.trim());
  if (!m) throw new UsageError(`'${raw}' is not an issue number (expected e.g. 12)`, command);
  return Number(m[1]);
}

function str(inv: Invocation, key: string): string | undefined {
  const v = inv.values[key];
  return typeof v === 'string' ? v : undefined;
}

function requiredText(inv: Invocation, key: string): string {
  const v = str(inv, key)?.trim();
  if (!v) throw new UsageError(`--${key} "<text>" is required`, inv.command);
  return v;
}

function unwrapIssue(data: unknown): AgentIssueDetail {
  const d = data as { issue?: AgentIssueDetail } | AgentIssueDetail;
  return ('issue' in d && d.issue ? d.issue : d) as AgentIssueDetail;
}

function author(inv: Invocation): string {
  return str(inv, 'as')?.trim() || inv.ctx.agentName;
}

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim() };
}

/** `--commit auto` → short HEAD; warns when tracked files have uncommitted changes. */
export function resolveCommit(inv: Invocation, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const v = value.trim();
  if (!v) throw new UsageError('--commit needs a sha or "auto"', inv.command);
  if (v !== 'auto') return v;
  const head = git(inv.ctx.cwd, ['rev-parse', '--short', 'HEAD']);
  if (!head.ok || !head.out) throw new CliError("--commit auto: couldn't read HEAD (not a git repository, or no commits yet)", EXIT.error);
  const dirty = git(inv.ctx.cwd, ['status', '--porcelain', '--untracked-files=no']);
  if (dirty.ok && dirty.out) inv.warn(`uncommitted changes in the working tree; the fix may not be in ${head.out}`);
  return head.out;
}

function normalizeOrigin(raw: string, command: string): string {
  const v = raw.trim();
  let url: URL;
  try {
    url = new URL(v.includes('://') ? v : `https://${v}`);
  } catch {
    throw new UsageError(`'${raw}' is not a valid origin (expected e.g. https://example.com)`, command);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new UsageError(`'${raw}' is not a valid origin (expected http or https)`, command);
  }
  return url.origin;
}

const EXT_BY_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};

function imageExt(contentType: string, url: string, fallback: string): string {
  const fromType = EXT_BY_TYPE[contentType.split(';')[0]?.trim().toLowerCase() ?? ''];
  if (fromType) return fromType;
  try {
    const ext = path.extname(new URL(url).pathname).slice(1).toLowerCase();
    if (ext && /^(png|jpe?g|webp|gif|avif)$/.test(ext)) return ext === 'jpeg' ? 'jpg' : ext;
  } catch {
    // ignore
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Commands

const handoff = (mode: 'connect' | 'link'): Command['run'] =>
  async (inv) => {
    const settings = loadSettings(inv.ctx, inv.endpointFlag);
    let site = str(inv, 'site');
    if (site !== undefined) {
      try {
        site = new URL(site).toString();
      } catch {
        throw new UsageError(`--site '${site}' is not a URL (expected e.g. https://example.com)`, inv.command);
      }
    }
    const result = await runHandoff(inv.ctx, {
      mode,
      endpoint: settings.endpoint,
      site,
      open: inv.values['no-open'] !== true,
      json: inv.json,
      style: inv.style,
    });
    if (inv.json) return inv.printJson(result);
    const gitRoot = findGitRoot(inv.ctx.cwd);
    const gitignore = gitRoot ? path.relative(inv.ctx.cwd, path.join(gitRoot, '.gitignore')) || '.gitignore' : undefined;
    inv.print(renderHandoff({ ...result, configPath: path.relative(inv.ctx.cwd, result.configPath) || result.configPath }, mode, site, inv.style, gitignore));
  };

export const COMMANDS: Command[] = [
  {
    name: 'connect',
    options: { site: { type: 'string' }, 'no-open': { type: 'boolean' } },
    maxPositionals: 0,
    run: handoff('connect'),
  },
  {
    name: 'init',
    options: { 'no-open': { type: 'boolean' } },
    maxPositionals: 0,
    run: handoff('link'),
  },
  {
    name: 'project',
    aliases: ['whoami'],
    maxPositionals: 0,
    async run(inv) {
      const { api, settings } = agentApi(inv);
      const data = await api.get('/project');
      if (inv.json) return inv.printJson(data);
      const d = data as { project?: AgentProject } & AgentProject;
      inv.print(renderProject(d.project ?? d, inv.style, { endpoint: settings.endpoint, configPath: settings.found?.path ?? null }));
    },
  },
  {
    name: 'issues',
    options: { status: { type: 'string' }, url: { type: 'string' } },
    maxPositionals: 0,
    async run(inv) {
      const status = str(inv, 'status');
      const url = str(inv, 'url');
      if (status !== undefined && !(ISSUE_STATUSES as readonly string[]).includes(status)) {
        throw new UsageError(`--status must be one of ${ISSUE_STATUSES.join(', ')}`, inv.command);
      }
      const { api } = agentApi(inv);
      const qs = new URLSearchParams();
      if (status) qs.set('status', status);
      if (url) qs.set('url', url);
      const q = qs.toString();
      const data = await api.get<AgentListIssuesResponse>(`/issues${q ? `?${q}` : ''}`);
      if (inv.json) return inv.printJson(data);
      const issues = data.issues ?? [];
      if (!issues.length) return inv.print(emptyIssuesMessage(status, url));
      inv.print(renderIssueTable(issues, inv.style, { now: inv.ctx.now(), columns: inv.ctx.stdout.isTTY ? inv.ctx.stdout.columns : undefined }));
    },
  },
  {
    name: 'show',
    maxPositionals: 1,
    async run(inv) {
      const n = parseIssueNumber(inv.positionals[0], inv.command);
      const { api } = agentApi(inv);
      const issue = unwrapIssue(await api.get(`/issues/${n}`));
      const root = findGitRoot(inv.ctx.cwd) ?? inv.ctx.cwd;
      const { sources, truncated } = new SourceResolver(root, inv.ctx.cwd).resolveIssue(issue);
      if (inv.json) return inv.printJson({ ...issue, resolvedSources: sources });
      inv.print(renderIssueDetail(issue, { sources, truncated, root, cwd: inv.ctx.cwd }, inv.style, { now: inv.ctx.now() }));
    },
  },
  {
    name: 'screenshot',
    options: { context: { type: 'boolean' }, output: { type: 'string', short: 'o' } },
    maxPositionals: 1,
    async run(inv) {
      const n = parseIssueNumber(inv.positionals[0], inv.command);
      const context = inv.values.context === true;
      const { api, settings } = agentApi(inv);
      const issue = unwrapIssue(await api.get(`/issues/${n}`));
      const url = context ? issue.contextUrl : issue.screenshotUrl;
      if (!url) throw new CliError(`#${n} has no ${context ? 'context screenshot' : 'screenshot'}`, EXIT.notFound);
      let res: Response;
      try {
        res = await inv.ctx.fetch(url, { headers: { 'User-Agent': `annotate-cli/${VERSION}` }, signal: AbortSignal.timeout(60_000) });
      } catch (err) {
        throw new NetworkError(url, err);
      }
      if (!res.ok) throw new CliError(`screenshot download failed (HTTP ${res.status})`, exitCodeForStatus(res.status));
      const bytes = Buffer.from(await res.arrayBuffer());
      const name = `issue-${n}${context ? '-context' : ''}.${imageExt(res.headers.get('content-type') ?? '', url, context ? 'jpg' : 'png')}`;
      const out = str(inv, 'output');
      let file: string;
      if (out) {
        const abs = path.resolve(inv.ctx.cwd, out);
        file = /[\\/]$/.test(out) || (existsSync(abs) && statSync(abs).isDirectory()) ? path.join(abs, name) : abs;
      } else {
        file = path.join(settings.projectDir, SCREENSHOT_DIR, name);
      }
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, bytes);
      if (inv.json) return inv.printJson({ path: file });
      inv.print(file);
    },
  },
  {
    name: 'claim',
    options: { minutes: { type: 'string' }, as: { type: 'string' } },
    maxPositionals: 1,
    async run(inv) {
      const n = parseIssueNumber(inv.positionals[0], inv.command);
      const body: AgentClaimRequest = { agent: author(inv) };
      const minutes = str(inv, 'minutes');
      if (minutes !== undefined) {
        const m = /^\d+$/.test(minutes.trim()) ? Number(minutes) : NaN;
        if (!(m >= 1 && m <= 240)) throw new UsageError('--minutes must be a whole number from 1 to 240', inv.command);
        body.minutes = m;
      }
      const { api } = agentApi(inv);
      // A 409 (code 'claimed') becomes exit 4; the server's message names the claimant and the time.
      const data = await api.post(`/issues/${n}/claim`, body);
      if (inv.json) return inv.printJson(data);
      const issue = unwrapIssue(data);
      const until = issue.claimedUntil ? ` until ${fmtWhen(issue.claimedUntil, inv.ctx.now())}` : '';
      inv.print([`Claimed #${n} as ${issue.claimedBy ?? body.agent}${until}.`, inv.style.dim(`Next: annotate show ${n}`)]);
    },
  },
  {
    name: 'release',
    maxPositionals: 1,
    async run(inv) {
      const n = parseIssueNumber(inv.positionals[0], inv.command);
      const { api } = agentApi(inv);
      const data = await api.post(`/issues/${n}/release`, {});
      if (inv.json) return inv.printJson(data);
      inv.print(`Released #${n}.`);
    },
  },
  {
    name: 'comment',
    options: { as: { type: 'string' } },
    maxPositionals: Infinity,
    async run(inv) {
      const n = parseIssueNumber(inv.positionals[0], inv.command);
      const text = inv.positionals.slice(1).join(' ').trim();
      if (!text) throw new UsageError('missing comment text', inv.command);
      const { api } = agentApi(inv);
      const body: AgentCommentRequest = { text, author: author(inv) };
      const data = await api.post(`/issues/${n}/comments`, body);
      if (inv.json) return inv.printJson(data);
      inv.print(`Commented on #${n}.`);
    },
  },
  {
    name: 'resolve',
    options: { note: { type: 'string' }, commit: { type: 'string' }, as: { type: 'string' } },
    maxPositionals: 1,
    async run(inv) {
      const n = parseIssueNumber(inv.positionals[0], inv.command);
      const note = requiredText(inv, 'note');
      const commit = resolveCommit(inv, str(inv, 'commit'));
      const body: AgentResolveRequest = { note, author: author(inv) };
      if (commit) body.commit = commit;
      const { api } = agentApi(inv);
      const data = await api.post(`/issues/${n}/resolve`, body);
      if (inv.json) return inv.printJson(data);
      inv.print([
        `${inv.style.green('✓')} #${n} is now ${inv.style.bold('Done')}${commit ? ` (commit ${commit})` : ''}.`,
        'Anyone can reopen it from the pin or Trello.',
      ]);
    },
  },
  {
    name: 'reopen',
    options: { note: { type: 'string' }, as: { type: 'string' } },
    maxPositionals: 1,
    async run(inv) {
      const n = parseIssueNumber(inv.positionals[0], inv.command);
      const body: AgentReopenRequest = { note: requiredText(inv, 'note'), author: author(inv) };
      const { api } = agentApi(inv);
      const data = await api.post(`/issues/${n}/reopen`, body);
      if (inv.json) return inv.printJson(data);
      inv.print(`Reopened #${n} (status new).`);
    },
  },
  {
    name: 'origins',
    maxPositionals: 2,
    async run(inv) {
      const [sub = 'list', arg] = inv.positionals;
      let data: AgentOriginsResponse;
      let done = '';
      if (sub === 'list' || sub === 'ls') {
        if (arg !== undefined) throw new UsageError(`unexpected argument '${arg}'`, inv.command);
        data = await agentApi(inv).api.get<AgentOriginsResponse>('/origins');
      } else if (sub === 'add' || sub === 'remove' || sub === 'rm') {
        if (!arg) throw new UsageError(`missing origin (e.g. annotate origins ${sub} https://example.com)`, inv.command);
        const origin = normalizeOrigin(arg, inv.command);
        const body: AgentOriginRequest = { origin };
        const { api } = agentApi(inv);
        if (sub === 'add') {
          data = await api.post<AgentOriginsResponse>('/origins', body);
          done = `Allowed ${origin}.`;
        } else {
          data = await api.delete<AgentOriginsResponse>(`/origins?origin=${encodeURIComponent(origin)}`, body);
          done = `Removed ${origin}.`;
        }
      } else {
        throw new UsageError(`unknown subcommand '${sub}' (expected list, add or remove)`, inv.command);
      }
      if (inv.json) return inv.printJson(data);
      const origins = data.origins ?? [];
      const lines = done ? [done] : [];
      if (!origins.length) lines.push('No allowed origins.');
      else lines.push(...(done ? [inv.style.dim('Allowed origins:')] : []), ...origins.map((o) => (done ? `  ${o}` : o)));
      inv.print(lines);
    },
  },
  {
    name: 'skill',
    options: { global: { type: 'boolean' } },
    maxPositionals: 1,
    async run(inv) {
      const sub = inv.positionals[0];
      if (sub === 'print') {
        if (inv.json) return inv.printJson({ content: SKILL });
        inv.ctx.stdout.write(SKILL.endsWith('\n') ? SKILL : `${SKILL}\n`);
        return;
      }
      if (sub !== 'install') {
        throw new UsageError(sub ? `unknown subcommand '${sub}' (expected install or print)` : 'expected install or print', inv.command);
      }
      const target = skillTarget({ global: inv.values.global === true, cwd: inv.ctx.cwd, homedir: inv.ctx.homedir });
      let status: ReturnType<typeof installSkill>;
      try {
        status = installSkill(target);
      } catch (err) {
        throw new CliError(`couldn't write ${target}: ${(err as Error).message}`, EXIT.error);
      }
      if (inv.json) return inv.printJson({ path: target, status });
      const verb = status === 'created' ? 'Installed' : status === 'updated' ? 'Updated' : 'Already up to date:';
      inv.print([`${verb} ${target}`, inv.style.dim('Claude Code picks it up for "fix the QA issues" and similar requests.')]);
    },
  },
  {
    name: 'watch',
    options: {
      once: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      reset: { type: 'boolean' },
      interval: { type: 'string' },
      timeout: { type: 'string' },
    },
    maxPositionals: 0,
    async run(inv) {
      const num = (key: string, def: number, min: number, max: number) => {
        const raw = str(inv, key);
        if (raw === undefined) return def;
        const n = /^\d+$/.test(raw.trim()) ? Number(raw) : NaN;
        if (!(n >= min && n <= max)) throw new UsageError(`--${key} must be a whole number from ${min} to ${max}`, inv.command);
        return n;
      };
      return watch(inv.ctx, inv.endpointFlag, {
        once: inv.values.once === true,
        dryRun: inv.values['dry-run'] === true,
        reset: inv.values.reset === true,
        intervalSec: num('interval', 120, 15, 86_400),
        timeoutMin: num('timeout', 60, 1, 600),
      });
    },
  },
];

export function findCommand(name: string): Command | undefined {
  return COMMANDS.find((c) => c.name === name || c.aliases?.includes(name));
}

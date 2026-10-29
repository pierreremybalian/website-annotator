// connect / init: device-style hand-off. The CLI keeps a random verifier, sends only its hash, opens
// the browser on the session URL and polls with the verifier until the browser side finishes.
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import type { CliPollResponse, CliResult, CliSessionRequest, CliSessionResponse } from '@annotate/shared';
import type { Ctx, Out } from './context';
import { httpError, NetworkError, requestJson } from './api';
import { ensureGitignored, findGitRoot, normalizeEndpoint, writeConfig, type AnnotateConfig } from './config';
import { CliError, EXIT } from './errors';
import type { Style } from './format';

const SESSION_TTL_MS = 15 * 60_000;
const MAX_NETWORK_RETRIES = 5;

export function makeVerifier(): { verifier: string; verifierHash: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, verifierHash: hashVerifier(verifier) };
}

export function hashVerifier(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function startSpinner(out: Out, text: string): { stop(): void } {
  if (!out.isTTY) return { stop() {} };
  const frames = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
  let i = 0;
  const timer = setInterval(() => out.write(`\r${frames[i++ % frames.length]} ${text}`), 100);
  return {
    stop() {
      clearInterval(timer);
      out.write('\r\x1b[K');
    },
  };
}

export async function pollSession(ctx: Ctx, endpoint: string, session: CliSessionResponse, verifier: string): Promise<CliResult> {
  const expires = Date.parse(session.expiresAt);
  const deadline = Math.min(ctx.now() + SESSION_TTL_MS, Number.isFinite(expires) ? expires + 5_000 : Infinity);
  const url = `${endpoint}/cli/sessions/${encodeURIComponent(session.id)}/poll`;
  const spinner = startSpinner(ctx.stderr, 'Waiting for the browser… (Ctrl-C to cancel)');
  let failures = 0;
  try {
    for (;;) {
      if (ctx.now() >= deadline) throw new CliError('timed out waiting for the browser (15 min). Run the command again.', EXIT.error);
      await ctx.sleep(ctx.pollIntervalMs);
      let res;
      try {
        res = await requestJson(ctx, 'POST', url, { body: { verifier } });
        failures = 0;
      } catch (err) {
        if (err instanceof NetworkError && ++failures < MAX_NETWORK_RETRIES) continue;
        throw err;
      }
      if (res.status === 202) continue;
      if (res.status === 200) {
        const data = res.data as Partial<CliPollResponse> | null;
        if (data?.status === 'done' && data.result) return data.result;
        continue;
      }
      if (res.status === 410) throw new CliError('the connect link expired or was already used. Run the command again.', EXIT.error);
      if (res.status === 403) throw new CliError('the server rejected this session\'s verifier. Run the command again.', EXIT.auth);
      throw httpError(res);
    }
  } finally {
    spinner.stop();
  }
}

export interface HandoffOptions {
  mode: 'connect' | 'link';
  endpoint: string;
  site?: string;
  open: boolean;
  json: boolean;
  style: Style;
}

export interface HandoffOutput {
  configPath: string;
  endpoint: string;
  projectKey: string;
  projectName: string;
  boardName: string;
  boardUrl: string;
  origins: string[];
  accessKey: string;
  gitignore: string[];
}

export async function runHandoff(ctx: Ctx, opts: HandoffOptions): Promise<HandoffOutput> {
  const { verifier, verifierHash } = makeVerifier();
  const repoName = path.basename(findGitRoot(ctx.cwd) ?? ctx.cwd);
  const host = ctx.hostname.replace(/\.local$/, '');
  const body: CliSessionRequest = { verifierHash, mode: opts.mode, label: `${host}:${repoName}`.slice(0, 80) };
  if (opts.site) body.siteUrl = opts.site;

  const created = await requestJson(ctx, 'POST', `${opts.endpoint}/cli/sessions`, { body });
  if (!created.ok) throw httpError(created);
  const session = created.data as Partial<CliSessionResponse> | null;
  if (!session?.id || !session.url) throw new CliError('unexpected response from /cli/sessions (no id or url)', EXIT.error);

  // Progress goes to stderr under --json so stdout stays pure JSON.
  const log = opts.json ? ctx.stderr : ctx.stdout;
  const what = opts.mode === 'connect' ? 'connect a Trello board' : 'link this repo to a project';
  log.write(`Open this link to ${what}:\n  ${session.url}\n`);
  if (opts.open && !ctx.openUrl(session.url)) log.write('(Could not open a browser; open the link yourself.)\n');

  const result = await pollSession(ctx, opts.endpoint, session as CliSessionResponse, verifier);

  const endpoint = result.endpoint ? normalizeEndpoint(result.endpoint) : opts.endpoint;
  const config: AnnotateConfig = {
    endpoint,
    projectKey: result.projectKey,
    agentToken: result.agentToken,
    projectName: result.projectName,
    boardName: result.boardName,
    boardUrl: result.boardUrl,
  };
  const configPath = writeConfig(ctx.cwd, config);
  const ignored = ensureGitignored(ctx.cwd);
  return {
    configPath,
    endpoint,
    projectKey: result.projectKey,
    projectName: result.projectName,
    boardName: result.boardName,
    boardUrl: result.boardUrl,
    origins: result.origins ?? [],
    accessKey: result.accessKey,
    gitignore: ignored?.added ?? [],
  };
}

function activationLink(origin: string | undefined, accessKey: string): string {
  if (origin) {
    try {
      const u = new URL(origin);
      u.searchParams.set('annotate', accessKey);
      return u.toString();
    } catch {
      // fall through
    }
  }
  return `<site>?annotate=${accessKey}`;
}

export function renderHandoff(o: HandoffOutput, mode: 'connect' | 'link', site: string | undefined, style: Style, gitignorePath?: string): string[] {
  const embed = `<script src="${o.endpoint}/widget.js" data-endpoint="${o.endpoint}" data-project="${o.projectKey}" defer></script>`;
  const site0 = o.origins.find((x) => !/\/\/(localhost|127\.0\.0\.1)(:|$)/.test(x)) ?? o.origins[0] ?? site;
  const lines = [
    `${style.green('✓')} ${mode === 'connect' ? 'Connected' : 'Linked to'} ${style.bold(o.projectName)} ${style.dim(`(${o.projectKey})`)} · Trello board ${style.bold(o.boardName)}`,
    `  ${style.dim(o.boardUrl)}`,
    `Wrote ${o.configPath} ${style.dim('(holds the agent token; keep it out of git)')}`,
  ];
  if (o.gitignore.length) lines.push(`Added ${o.gitignore.join(', ')} to ${gitignorePath ?? '.gitignore'}`);
  lines.push(
    '',
    style.bold('Embed the widget') + style.dim(' (any site, before </body>; the WordPress plugin does this for you):'),
    `  ${embed}`,
    '',
    style.bold('Astro') + style.dim(' (astro.config.mjs):'),
    `  import annotate from '@annotate/astro'`,
    `  integrations: [annotate({ project: '${o.projectKey}' })]`,
    '',
    style.bold('Activation link') + style.dim(' (shows the widget to anyone who opens it; share it with reviewers):'),
    `  ${activationLink(site0, o.accessKey)}`,
    '',
    `Next: ${style.bold('annotate issues')}`,
  );
  return lines;
}


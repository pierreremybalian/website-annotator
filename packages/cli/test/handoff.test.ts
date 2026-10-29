import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { CliResult } from '@annotate/shared';
import { describe, expect, it } from 'vitest';
import { hashVerifier } from '../src/handoff';
import { mockFetch, runCli, tmpDir, type FetchCall, type Reply } from './helpers';

const result: CliResult = {
  endpoint: 'https://annotate.test/',
  projectKey: 'pk_new',
  accessKey: 'ak_new',
  agentToken: 'at_new',
  projectName: 'Strauss Houses',
  boardName: 'Website QA',
  boardUrl: 'https://trello.com/b/xyz/website-qa',
  origins: ['https://strausshouses.com'],
};

function sessionServer(polls: Reply[]) {
  let i = 0;
  return mockFetch((c: FetchCall) => {
    if (c.method === 'POST' && c.url === 'https://annotate.test/cli/sessions') {
      return { status: 200, body: { id: 'sess_1', url: 'https://annotate.test/connect?cli=sess_1', expiresAt: '2099-01-01T00:00:00Z' } };
    }
    if (c.method === 'POST' && c.url === 'https://annotate.test/cli/sessions/sess_1/poll') {
      return polls[Math.min(i++, polls.length - 1)] as Reply;
    }
    return { status: 404, body: { error: 'Not found', code: 'not_found' } };
  });
}

const env = { ANNOTATE_ENDPOINT: 'https://annotate.test' };

describe('connect / init hand-off', () => {
  it('pending → done: writes .annotate.json (0600), updates .gitignore, prints the snippet', async () => {
    const cwd = tmpDir();
    execFileSync('git', ['init', '-q'], { cwd });
    const fetch = sessionServer([
      { status: 202, body: { status: 'pending' } },
      { status: 202, body: { status: 'pending' } },
      { status: 200, body: { status: 'done', result } },
    ]);
    const opened: string[] = [];
    const r = await runCli(['connect', '--site', 'https://strausshouses.com'], {
      cwd,
      env,
      fetch,
      openUrl: (u) => (opened.push(u), true),
    });
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);

    const create = fetch.calls[0]!;
    const body = create.body as { verifierHash: string; mode: string; label: string; siteUrl: string };
    expect(body).toMatchObject({ mode: 'connect', label: `box:${path.basename(cwd)}`, siteUrl: 'https://strausshouses.com/' });
    expect(body.verifierHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const polls = fetch.calls.slice(1);
    expect(polls).toHaveLength(3);
    const verifier = (polls[0]!.body as { verifier: string }).verifier;
    expect(hashVerifier(verifier)).toBe(body.verifierHash);
    expect(opened).toEqual(['https://annotate.test/connect?cli=sess_1']);

    const file = path.join(cwd, '.annotate.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      endpoint: 'https://annotate.test',
      projectKey: 'pk_new',
      agentToken: 'at_new',
      projectName: 'Strauss Houses',
      boardName: 'Website QA',
      boardUrl: 'https://trello.com/b/xyz/website-qa',
    });
    expect(readFileSync(path.join(cwd, '.gitignore'), 'utf8')).toContain('.annotate.json\n.annotate/screenshots/\n');

    expect(r.stdout).toContain('https://annotate.test/connect?cli=sess_1');
    expect(r.stdout).toContain('Connected Strauss Houses (pk_new)');
    expect(r.stdout).toContain('Added .annotate.json, .annotate/screenshots/ to .gitignore');
    expect(r.stdout).toContain(
      '<script src="https://annotate.test/widget.js" data-endpoint="https://annotate.test" data-project="pk_new" defer></script>',
    );
    expect(r.stdout).toContain("import annotate from '@annotate/astro'");
    expect(r.stdout).toContain("integrations: [annotate({ project: 'pk_new' })]");
    expect(r.stdout).toContain('https://strausshouses.com/?annotate=ak_new');
  });

  it('init uses mode link; --json keeps stdout pure and omits the token', async () => {
    const cwd = tmpDir();
    const fetch = sessionServer([{ status: 200, body: { status: 'done', result } }]);
    const r = await runCli(['init', '--json', '--no-open'], { cwd, env, fetch, openUrl: () => expect.fail('opened') });
    expect(r.code).toBe(0);
    expect((fetch.calls[0]!.body as { mode: string }).mode).toBe('link');
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({ configPath: path.join(cwd, '.annotate.json'), projectKey: 'pk_new', accessKey: 'ak_new', gitignore: [] });
    expect(r.stdout).not.toContain('at_new');
    expect(r.stderr).toContain('https://annotate.test/connect?cli=sess_1');
  });

  it('init from a subfolder writes the config at the git root, so it is found from the repo root', async () => {
    const root = tmpDir();
    execFileSync('git', ['init', '-q'], { cwd: root });
    const sub = path.join(root, 'wp-content', 'themes', 'site');
    mkdirSync(sub, { recursive: true });
    const fetch = sessionServer([{ status: 200, body: { status: 'done', result } }]);
    const r = await runCli(['init', '--json', '--no-open'], { cwd: sub, env, fetch, openUrl: () => true });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).configPath).toBe(path.join(root, '.annotate.json'));
    expect(() => statSync(path.join(sub, '.annotate.json'))).toThrow();
  });

  it('410 → exit 1, nothing written', async () => {
    const cwd = tmpDir();
    const fetch = sessionServer([
      { status: 202, body: { status: 'pending' } },
      { status: 410, body: { error: 'This connect session has expired or was already used. Run the command again.', code: 'expired' } },
    ]);
    const r = await runCli(['init'], { cwd, env, fetch });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^error: the connect link expired or was already used/);
    expect(() => statSync(path.join(cwd, '.annotate.json'))).toThrow();
  });

  it('403 → exit 5', async () => {
    const fetch = sessionServer([{ status: 403, body: { error: 'Forbidden', code: 'forbidden' } }]);
    const r = await runCli(['init'], { env, fetch });
    expect(r.code).toBe(5);
    expect(r.stderr).toMatch(/verifier/);
  });

  it('gives up after 15 minutes', async () => {
    let now = 0;
    const fetch = sessionServer([{ status: 202, body: { status: 'pending' } }]);
    const r = await runCli(['init'], {
      env,
      fetch,
      now: () => now,
      sleep: async () => {
        now += 2000;
      },
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/timed out/);
    expect(fetch.calls.length).toBeGreaterThan(400);
  });

  it('rides out a transient network error while polling', async () => {
    const fetch = sessionServer([new TypeError('fetch failed'), { status: 200, body: { status: 'done', result } }]);
    const r = await runCli(['init', '--json'], { env, fetch });
    expect(r.code).toBe(0);
  });
});

describe('pollSession on a TTY', () => {
  it('draws a spinner on stderr and clears it', async () => {
    const { pollSession } = await import('../src/handoff');
    const { makeCtx } = await import('../src/context');
    let err = '';
    const ctx = makeCtx({
      stderr: { write: (s: string) => (err += s), isTTY: true },
      fetch: sessionServer([{ status: 200, body: { status: 'done', result } }]),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      pollIntervalMs: 250,
    });
    const out = await pollSession(ctx, 'https://annotate.test', { id: 'sess_1', url: 'u', expiresAt: '2099-01-01T00:00:00Z' }, 'v');
    expect(out.projectKey).toBe('pk_new');
    expect(err).toMatch(/^\r⠋ Waiting for the browser/);
    expect(err.endsWith('\r\x1b[K')).toBe(true);
  });
});

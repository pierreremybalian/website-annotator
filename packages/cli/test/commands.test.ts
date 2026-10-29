import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentIssue } from '@annotate/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { SKILL } from '../src/skill';
import { configuredDir, issueFixture, mockFetch, runCli, writeTree, type Handler } from './helpers';

beforeAll(() => {
  process.env.TZ = 'UTC';
});

const API = 'https://annotate.test/v1/agent';

function listItem(overrides: Partial<AgentIssue> = {}): AgentIssue {
  const { anchor: _a, env: _e, context: _c, comments: _m, resolution: _r, ...summary } = issueFixture();
  return { ...summary, ...overrides };
}

function api(routes: Record<string, Handler>) {
  return mockFetch((c) => {
    const key = `${c.method} ${c.url.replace(API, '')}`;
    const h = routes[key];
    return h ? h(c) : { status: 404, body: { error: `no route ${key}`, code: 'not_found' } };
  });
}

describe('issues', () => {
  const issues = [
    listItem(),
    listItem({
      number: 13,
      title: 'Footer links are the wrong colour and the copyright year is still 2024 on every single page',
      status: 'in_progress',
      pageUrl: 'https://example.com/',
      claimedBy: 'claude@ci',
      claimedUntil: '2026-10-28T12:30:00Z',
    }),
  ];

  it('prints a compact table', async () => {
    const r = await runCli(['issues'], { cwd: configuredDir(), fetch: api({ 'GET /issues': () => ({ status: 200, body: { issues } }) }) });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      [
        '#    STATUS       TITLE                                               PAGE            CLAIMED',
        '#12  new          Hero button overlaps the menu on mobile             /about?ref=nav',
        '#13  in progress  Footer links are the wrong colour and the copyrig…  /               claude@ci',
        '',
      ].join('\n'),
    );
  });

  it('--json prints exactly the API JSON', async () => {
    const body = { issues };
    const r = await runCli(['issues', '--json', '--status', 'all', '--url', 'https://example.com/about'], {
      cwd: configuredDir(),
      fetch: api({ 'GET /issues?status=all&url=https%3A%2F%2Fexample.com%2Fabout': () => ({ status: 200, body }) }),
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${JSON.stringify(body)}\n`);
  });

  it('empty → "No open issues." and exit 0', async () => {
    const fetch = api({
      'GET /issues': () => ({ status: 200, body: { issues: [] } }),
      'GET /issues?status=review': () => ({ status: 200, body: { issues: [] } }),
    });
    const cwd = configuredDir();
    expect(await runCli(['issues'], { cwd, fetch })).toEqual({ code: 0, stdout: 'No open issues.\n', stderr: '' });
    expect((await runCli(['issues', '--status', 'review'], { cwd, fetch })).stdout).toBe('No issues in review.\n');
  });
});

describe('show', () => {
  function themeRepo(): string {
    const cwd = configuredDir();
    execFileSync('git', ['init', '-q'], { cwd });
    writeTree(cwd, {
      'wp-content/themes/strauss/blocks/hero/block.json': { name: 'acf/hero', acf: { renderTemplate: 'hero.php' } },
      'wp-content/themes/strauss/blocks/hero/hero.php': '',
      'wp-content/themes/strauss/page-about.php': '',
    });
    return cwd;
  }

  it('prints header, where (with resolved sources), element, env, comments and the screenshot hint', async () => {
    const issue = issueFixture({ claimedBy: 'claude@ci', claimedUntil: '2026-10-28T12:30:00Z', status: 'in_progress' });
    const r = await runCli(['show', '12'], { cwd: themeRepo(), fetch: api({ 'GET /issues/12': () => ({ status: 200, body: { issue } }) }) });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      [
        '#12 Hero button overlaps the menu on mobile',
        'in progress · claimed by claude@ci until 12:30 · reported by Jane Client 2026-10-28 09:15',
        '',
        '  The orange CTA covers the hamburger menu.',
        '  Only on my phone.',
        '',
        'Where',
        '  Page      https://example.com/about?ref=nav',
        '  Viewport  390×844 @3x',
        '  Selector  section.hero > a.btn-primary',
        '  Landmark  Our story',
        '  Sources',
        '    wp-block acf/hero (1 up)',
        '      wp-content/themes/strauss/blocks/hero/',
        '      wp-content/themes/strauss/blocks/hero/hero.php',
        '    page-template page-about.php',
        '      wp-content/themes/strauss/page-about.php',
        '',
        'Element <a> "Book a tour"',
        '  <a class="btn btn-primary" href="/tour">Book a tour</a>',
        '  display: inline-block · position: absolute · z-index: 20',
        '',
        'Environment',
        '  Safari 18 · iOS · 390×844 · en-US · 2026-10-28 09:15',
        '  Console errors (1)',
        '    error TypeError: menu is undefined',
        '',
        'Comments (1)',
        '  Jane Client via widget · 2026-10-28 09:30',
        '    Also on iPad.',
        '',
        'Trello      https://trello.com/c/abc123',
        'Screenshot  annotate screenshot 12  (--context for the full viewport)',
        '',
      ].join('\n'),
    );
  });

  it('--json prints the API issue plus resolvedSources', async () => {
    const issue = issueFixture();
    const r = await runCli(['show', '12', '--json'], { cwd: themeRepo(), fetch: api({ 'GET /issues/12': () => ({ status: 200, body: { issue } }) }) });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    const { resolvedSources, ...rest } = out;
    expect(rest).toEqual(issue);
    expect(resolvedSources).toEqual([
      {
        hint: { kind: 'wp-block', value: 'acf/hero', depth: 1 },
        files: ['wp-content/themes/strauss/blocks/hero/', 'wp-content/themes/strauss/blocks/hero/hero.php'],
      },
      { hint: { kind: 'page-template', value: 'page-about.php' }, files: ['wp-content/themes/strauss/page-about.php'] },
    ]);
    expect(r.stdout).toBe(`${JSON.stringify({ ...issue, resolvedSources })}\n`);
  });

  it('trims long single-line HTML to about 40 lines', async () => {
    const items = Array.from({ length: 60 }, (_, i) => `<li class="item">Item ${i}</li>`).join('');
    const issue = issueFixture({ context: { page: null, element: { ...issueFixture().context!.element!, html: `<ul class="list">${items}</ul>` } } });
    const r = await runCli(['show', '12'], { cwd: configuredDir(), fetch: api({ 'GET /issues/12': () => ({ status: 200, body: { issue } }) }) });
    const el = r.stdout.split('\nElement')[1]!.split('\n\n')[0]!.split('\n').slice(1);
    expect(el[0]).toBe('  <ul class="list">');
    expect(el[1]).toBe('    <li class="item">Item 0</li>');
    expect(el[39]).toBe('  … 23 more lines (--json has the full HTML)');
  });
});

describe('exit codes', () => {
  const cases: Array<[number, string, number]> = [
    [401, 'Invalid agent token', 5],
    [403, 'Forbidden', 5],
    [404, 'Issue #99 not found', 3],
    [409, 'Already claimed by claude@other until 2026-10-28T12:40:00Z', 4],
    [500, 'Internal error', 1],
  ];
  it.each(cases)('HTTP %i → exit %i', async (status, error, code) => {
    const fetch = mockFetch(() => ({ status, body: { error, code: 'x' } }));
    const r = await runCli(['claim', '99', '--json'], { cwd: configuredDir(), fetch });
    expect(r.code).toBe(code);
    expect(r.stdout).toBe('');
    expect(r.stderr.split('\n')[0]).toBe(`error: ${error}`);
  });

  it('409 on claim names the claimant', async () => {
    const fetch = api({
      'POST /issues/12/claim': () => ({ status: 409, body: { error: '#12 is claimed by claude@other until 12:40', code: 'claimed' } }),
    });
    const r = await runCli(['claim', '12'], { cwd: configuredDir(), fetch });
    expect(r.code).toBe(4);
    expect(r.stderr).toContain('claude@other');
  });

  it('401 adds a hint; non-JSON errors fall back to the status', async () => {
    const r401 = await runCli(['issues'], { cwd: configuredDir(), fetch: mockFetch(() => ({ status: 401, body: { error: 'Invalid agent token', code: 'unauthorized' } })) });
    expect(r401.stderr).toContain('annotate init');
    const r502 = await runCli(['issues'], { cwd: configuredDir(), fetch: mockFetch(() => ({ status: 502, body: new Uint8Array([60, 104]) })) });
    expect(r502).toMatchObject({ code: 1, stderr: 'error: request failed (HTTP 502)\n' });
  });

  it('network failure → exit 1', async () => {
    const err = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const r = await runCli(['issues'], { cwd: configuredDir(), fetch: mockFetch(() => err) });
    expect(r).toMatchObject({ code: 1, stderr: 'error: cannot reach https://annotate.test: ECONNREFUSED\n' });
  });
});

describe('claim / release / comment / resolve / reopen', () => {
  const ok: Handler = (c) => ({ status: 200, body: { issue: issueFixture({ claimedBy: (c.body as { agent?: string })?.agent ?? null, claimedUntil: '2026-10-28T12:30:00Z' }) } });

  it('claim sends the default agent name and minutes', async () => {
    const fetch = api({ 'POST /issues/12/claim': ok });
    const r = await runCli(['claim', '12', '--minutes', '45'], { cwd: configuredDir(), fetch });
    expect(r.code).toBe(0);
    expect(fetch.calls[0]?.body).toEqual({ agent: 'tester@box', minutes: 45 });
    expect(r.stdout).toBe('Claimed #12 as tester@box until 12:30.\nNext: annotate show 12\n');
  });

  it('--as overrides the name; writes print the API JSON', async () => {
    const fetch = api({ 'POST /issues/12/claim': ok, 'POST /issues/12/release': ok, 'POST /issues/12/reopen': ok });
    const cwd = configuredDir();
    const r = await runCli(['claim', '12', '--as', 'claude', '--json'], { cwd, fetch });
    expect(fetch.calls[0]?.body).toEqual({ agent: 'claude' });
    expect(JSON.parse(r.stdout).issue.claimedBy).toBe('claude');
    expect((await runCli(['release', '12'], { cwd, fetch })).stdout).toBe('Released #12.\n');
    expect(fetch.calls[1]?.body).toEqual({});
    await runCli(['reopen', '12', '--note', 'Still overlapping on iPad'], { cwd, fetch });
    expect(fetch.calls[2]?.body).toEqual({ note: 'Still overlapping on iPad', author: 'tester@box' });
  });

  it('resolve --commit auto uses git rev-parse --short HEAD and says it is ready for review', async () => {
    const cwd = configuredDir();
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
    git('init', '-q');
    writeTree(cwd, { '.gitignore': '.annotate.json\n', 'style.css': 'a{}' });
    git('add', '.');
    git('commit', '-q', '-m', 'Fix hero CTA (annotate #12)');
    const sha = git('rev-parse', '--short', 'HEAD');
    const fetch = api({ 'POST /issues/12/resolve': () => ({ status: 200, body: { issue: issueFixture({ status: 'review' }) } }) });
    const r = await runCli(['resolve', '12', '--note', 'Moved the CTA below the menu under 400px', '--commit', 'auto'], { cwd, fetch });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expect(fetch.calls[0]?.body).toEqual({ note: 'Moved the CTA below the menu under 400px', commit: sha, author: 'tester@box' });
    expect(r.stdout).toContain(`#12 is now Ready for review (commit ${sha}).`);
    expect(r.stdout).toContain('A human confirms it on the site');

    writeTree(cwd, { 'style.css': 'a{color:red}' });
    const dirty = await runCli(['resolve', '12', '--note', 'x', '--commit', 'auto', '--json'], { cwd, fetch });
    expect(dirty.code).toBe(0);
    expect(dirty.stderr).toMatch(/^warning: uncommitted changes/);
    expect(JSON.parse(dirty.stdout).issue.status).toBe('review');
  });

  it('resolve --commit auto outside a repo → exit 1', async () => {
    const r = await runCli(['resolve', '12', '--note', 'x', '--commit', 'auto'], { cwd: configuredDir(), fetch: api({}) });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/--commit auto: couldn't read HEAD/);
  });
});

describe('screenshot', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const fetchFor = () =>
    mockFetch((c) => {
      if (c.url === `${API}/issues/12`) return { status: 200, body: { issue: issueFixture() } };
      if (c.url.startsWith('https://annotate.test/v1/screenshots/s1.png')) return { status: 200, body: png, headers: { 'content-type': 'image/png' } };
      if (c.url.startsWith('https://annotate.test/v1/screenshots/c1.jpg')) return { status: 200, body: png, headers: { 'content-type': 'image/jpeg' } };
      return { status: 404, body: {} };
    });

  it('saves to .annotate/screenshots next to the config and prints the path', async () => {
    const cwd = configuredDir();
    const fetch = fetchFor();
    const r = await runCli(['screenshot', '12'], { cwd, fetch });
    const file = path.join(cwd, '.annotate/screenshots/issue-12.png');
    expect(r).toEqual({ code: 0, stdout: `${file}\n`, stderr: '' });
    expect(readFileSync(file)).toEqual(Buffer.from(png));
    expect(fetch.calls[1]?.headers.authorization).toBeUndefined();

    const ctxShot = await runCli(['screenshot', '12', '--context', '--json'], { cwd, fetch });
    expect(JSON.parse(ctxShot.stdout)).toEqual({ path: path.join(cwd, '.annotate/screenshots/issue-12-context.jpg') });
  });

  it('-o takes a file or a directory', async () => {
    const cwd = configuredDir();
    await runCli(['screenshot', '12', '-o', 'shot.png'], { cwd, fetch: fetchFor() });
    expect(existsSync(path.join(cwd, 'shot.png'))).toBe(true);
    const r = await runCli(['screenshot', '12', '-o', 'out/'], { cwd, fetch: fetchFor() });
    expect(r.stdout.trim()).toBe(path.join(cwd, 'out/issue-12.png'));
  });
});

describe('project and origins', () => {
  const project = {
    name: 'Strauss Houses',
    projectKey: 'pk_test',
    boardName: 'Website QA',
    boardUrl: 'https://trello.com/b/xyz',
    origins: ['https://strausshouses.com'],
    counts: { new: 3, in_progress: 1, review: 2, resolved: 10, archived: 0 },
  };

  it('project prints a summary; whoami is an alias', async () => {
    const cwd = configuredDir();
    const fetch = api({ 'GET /project': () => ({ status: 200, body: project }) });
    const r = await runCli(['whoami'], { cwd, fetch });
    expect(r.stdout.split('\n').slice(0, 4)).toEqual([
      'Strauss Houses  (pk_test)',
      'Board    Website QA  https://trello.com/b/xyz',
      'Origins  https://strausshouses.com',
      'Issues   3 new · 1 in progress · 2 review · 10 resolved · 0 archived',
    ]);
    expect((await runCli(['project', '--json'], { cwd, fetch })).stdout).toBe(`${JSON.stringify(project)}\n`);
  });

  it('origins list/add/remove; add reduces a URL to its origin', async () => {
    const cwd = configuredDir();
    const fetch = api({
      'GET /origins': () => ({ status: 200, body: { origins: ['https://a.com'] } }),
      'POST /origins': () => ({ status: 200, body: { origins: ['https://a.com', 'https://b.com'] } }),
      'DELETE /origins?origin=https%3A%2F%2Fa.com': () => ({ status: 200, body: { origins: [] } }),
    });
    expect((await runCli(['origins'], { cwd, fetch })).stdout).toBe('https://a.com\n');
    const add = await runCli(['origins', 'add', 'https://b.com/some/page'], { cwd, fetch });
    expect(fetch.calls[1]?.body).toEqual({ origin: 'https://b.com' });
    expect(add.stdout).toBe('Allowed https://b.com.\nAllowed origins:\n  https://a.com\n  https://b.com\n');
    const rm = await runCli(['origins', 'remove', 'a.com', '--json'], { cwd, fetch });
    expect(fetch.calls[2]?.body).toEqual({ origin: 'https://a.com' });
    expect(rm.stdout).toBe('{"origins":[]}\n');
  });
});

describe('skill', () => {
  it('install writes into the git root, --global into ~/.claude', async () => {
    const cwd = configuredDir();
    execFileSync('git', ['init', '-q'], { cwd });
    writeTree(cwd, { 'sub/x': '' });
    const r = await runCli(['skill', 'install', '--json'], { cwd: path.join(cwd, 'sub') });
    const target = path.join(cwd, '.claude/skills/annotate-qa/SKILL.md');
    expect(JSON.parse(r.stdout)).toEqual({ path: target, status: 'created' });
    expect(readFileSync(target, 'utf8')).toBe(SKILL);
    expect(JSON.parse((await runCli(['skill', 'install', '--json'], { cwd })).stdout).status).toBe('unchanged');

    const home = configuredDir();
    const g = await runCli(['skill', 'install', '--global'], { cwd, homedir: home });
    expect(g.stdout).toContain(path.join(home, '.claude/skills/annotate-qa/SKILL.md'));
  });

  it('print writes the embedded skill', async () => {
    const r = await runCli(['skill', 'print']);
    expect(r.stdout).toBe(SKILL);
    expect(SKILL).toMatch(/^---\nname: annotate-qa\ndescription: /);
  });
});

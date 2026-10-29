import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ApiError, CliPollResponse, CliSessionRequest, CliSessionResponse } from '@annotate/shared';
import { randomId, type AgentTokenRow, type CliSessionRow, type ConnectSessionRow, type ProjectRow } from '../src/db';
import { sha256Base64Url, sha256Hex } from '../src/crypto';
import { MOCK_TOKEN, MOCK_TOKEN_OUTSIDER, mockTrelloState, resetMockTrello } from '../src/trello';
import type { ConnectCliDoneResponse, ConnectFinishResponse, ConnectListsResponse } from '../src/routes/connect';

const BASE = 'http://localhost:8787'; // PUBLIC_URL in the test bindings

const json = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  SELF.fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

interface Cli {
  id: string;
  verifier: string;
  res: CliSessionResponse;
  poll(verifier?: string): Promise<Response>;
}

/** What the CLI does: make a verifier, send its hash, keep the verifier for polling. */
async function createCli(req: Partial<CliSessionRequest> = {}): Promise<Cli> {
  const verifier = randomId(32);
  const res = await json('/cli/sessions', { verifierHash: await sha256Base64Url(verifier), mode: 'connect', ...req });
  expect(res.status).toBe(200);
  const body = (await res.json()) as CliSessionResponse;
  return { id: body.id, verifier, res: body, poll: (v = verifier) => json(`/cli/sessions/${body.id}/poll`, { verifier: v }) };
}

interface Flow {
  s: string;
  html: string;
  get(path: string): Promise<Response>;
  post(path: string, body: unknown): Promise<Response>;
}

/** Open a connect URL like a browser: keep the session id and the browser-binding cookie. */
async function open(url: string): Promise<Flow> {
  const res = await SELF.fetch(url);
  expect(res.status).toBe(200);
  const html = await res.text();
  const s = /\/connect\/callback\?s=([\w-]+)/.exec(html)?.[1];
  expect(s).toBeTruthy();
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!;
  expect(cookie).toBe(`acs_${s}=1`);
  const headers = { cookie };
  return {
    s: s!,
    html,
    get: (path) => SELF.fetch(`${BASE}${path}`, { headers }),
    post: (path, body) => json(path, body, headers),
  };
}

async function login(flow: Flow, token = MOCK_TOKEN) {
  const res = await flow.post('/connect/session', { s: flow.s, token });
  expect(res.status).toBe(200);
}

const cliRow = (id: string) => env.DB.prepare('SELECT * FROM cli_sessions WHERE id = ?').bind(id).first<CliSessionRow>();
const connectRow = (id: string) => env.DB.prepare('SELECT * FROM connect_sessions WHERE id = ?').bind(id).first<ConnectSessionRow>();
const projectByKey = (pk: string) => env.DB.prepare('SELECT * FROM projects WHERE public_key = ?').bind(pk).first<ProjectRow>();
const tokensFor = async (projectId: string) =>
  (await env.DB.prepare('SELECT * FROM agent_tokens WHERE project_id = ? ORDER BY created_at').bind(projectId).all<AgentTokenRow>()).results;

/** An existing project, connected through the WordPress popup. */
async function popupProject(name = 'Strauss Houses', origin = 'https://strausshouses.test') {
  const flow = await open(`${BASE}/connect?origin=${encodeURIComponent(origin)}&name=${encodeURIComponent(name)}`);
  await login(flow);
  const fin = await flow.post('/connect/finish', { s: flow.s, boardId: 'board-1', newListId: 'list-1', doneListIds: ['list-3'] });
  expect(fin.status).toBe(200);
  return (await projectByKey(((await fin.json()) as ConnectFinishResponse).message.projectKey))!;
}

beforeEach(() => resetMockTrello());

describe('POST /cli/sessions', () => {
  it('creates a 15-minute session and returns the connect URL', async () => {
    const cli = await createCli({ mode: 'link', label: '  pierre-mbp:strausshouses ', siteUrl: 'http://localhost:4321/' });
    expect(cli.res.url).toBe(`${BASE}/connect?cli=${cli.id}`);
    const exp = Date.parse(cli.res.expiresAt);
    expect(exp).toBeGreaterThan(Date.now() + 14 * 60_000);
    expect(exp).toBeLessThanOrEqual(Date.now() + 15 * 60_000);
    expect(await cliRow(cli.id)).toMatchObject({
      verifier_hash: await sha256Base64Url(cli.verifier),
      mode: 'link',
      label: 'pierre-mbp:strausshouses',
      site_url: 'http://localhost:4321/',
      result_enc: null,
      expires_at: exp,
    });
  });

  it('validates the request', async () => {
    const hash = await sha256Base64Url('x'.repeat(43));
    const bad = async (body: unknown) => {
      const res = await json('/cli/sessions', body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as ApiError).code).toBe('bad_request');
    };
    await bad({ verifierHash: hash.slice(1), mode: 'connect' });
    await bad({ verifierHash: `${hash.slice(1)}=`, mode: 'connect' });
    await bad({ verifierHash: hash, mode: 'other' });
    await bad({ verifierHash: hash });
    await bad({ verifierHash: hash, mode: 'connect', label: 'x'.repeat(81) });
    await bad({ verifierHash: hash, mode: 'connect', label: 7 });
    await bad({ verifierHash: hash, mode: 'connect', siteUrl: 'ftp://example.com' });
    await bad({ verifierHash: hash, mode: 'connect', siteUrl: 'example.com' });
    await bad([]);
    const res = await SELF.fetch(`${BASE}/cli/sessions`, { method: 'POST', body: 'nope' });
    expect(res.status).toBe(400);
    expect((await json('/cli/sessions', { verifierHash: hash, mode: 'connect', label: 'x'.repeat(80) })).status).toBe(200);
  });

  it('sets no cookies and is not cacheable', async () => {
    const res = await json('/cli/sessions', { verifierHash: await sha256Base64Url('v'), mode: 'connect' });
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('POST /cli/sessions/:id/poll', () => {
  it('202 pending, 403 for a wrong verifier, 400 without one', async () => {
    const cli = await createCli();
    const pending = await cli.poll();
    expect(pending.status).toBe(202);
    expect(await pending.json()).toEqual({ status: 'pending' });

    const wrong = await cli.poll(randomId(32));
    expect(wrong.status).toBe(403);
    expect(((await wrong.json()) as ApiError).code).toBe('forbidden');

    expect((await json(`/cli/sessions/${cli.id}/poll`, {})).status).toBe(400);
    expect(await cliRow(cli.id)).not.toBeNull();
  });

  it('410 for an unknown or expired session, and deletes the expired row', async () => {
    const unknown = await json(`/cli/sessions/${randomId()}/poll`, { verifier: 'v' });
    expect(unknown.status).toBe(410);
    expect(((await unknown.json()) as ApiError).code).toBe('expired');

    const cli = await createCli();
    await env.DB.prepare('UPDATE cli_sessions SET expires_at = ? WHERE id = ?').bind(Date.now() - 1, cli.id).run();
    const res = await cli.poll();
    expect(res.status).toBe(410);
    expect(((await res.json()) as ApiError).code).toBe('expired');
    expect(await cliRow(cli.id)).toBeNull();
  });
});

describe('CLI connect (new board)', () => {
  it('end to end: session → login → boards → finish → poll once', async () => {
    // 1. The CLI creates a session.
    const cli = await createCli({ mode: 'connect', label: 'pierre-mbp:client', siteUrl: 'https://client.test/' });

    // 2. The browser opens the URL: a connect session tied to the CLI session, and the cookie.
    const flow = await open(cli.res.url);
    expect(flow.html).toContain('Connect your terminal to Trello');
    expect(flow.html).toContain('pierre-mbp:client');
    const row = await connectRow(flow.s);
    expect(row).toMatchObject({ cli_session_id: cli.id, opener_origin: null, site_url: 'https://client.test/', site_name: null, project_id: null });
    expect(row!.expires_at).toBeLessThanOrEqual(Date.parse(cli.res.expiresAt));

    // 3. Log in.
    await login(flow);

    // 4. Boards: connect mode puts the new board first, with the site URL field prefilled.
    const boards = await flow.get(`/connect/boards?s=${flow.s}`);
    expect(boards.status).toBe(200);
    const html = await boards.text();
    expect(html).toContain('Mock Board');
    expect(html).toContain('id="siteUrl" value="https://client.test/"');
    expect(html.indexOf('Connect a new board')).toBeGreaterThan(0);
    expect(html.indexOf('Connect a new board')).toBeLessThan(html.indexOf('Link an existing project'));
    expect(html).toContain('No projects yet. Connect a new board above.');
    expect(html).toContain('id="reviewList"');
    expect(html).toContain('"cli":true');

    // The CLI is still waiting.
    expect((await cli.poll()).status).toBe(202);

    // 5. Finish with a site URL and a new review list.
    const fin = await flow.post('/connect/finish', {
      s: flow.s,
      boardId: 'board-1',
      newListId: 'list-1',
      doneListIds: ['list-3'],
      reviewListId: '__create__',
      siteUrl: 'https://client.test/',
    });
    expect(fin.status).toBe(200);
    const done = (await fin.json()) as ConnectCliDoneResponse & Partial<ConnectFinishResponse>;
    expect(done).toEqual({ cli: { action: 'connected', projectName: 'client.test', boardName: 'Mock Board', boardUrl: 'https://trello.com/b/mock1/mock-board' } });
    expect(JSON.stringify(done)).not.toMatch(/ak_|at_|pk_/); // keys go to the terminal only
    expect(await connectRow(flow.s)).toBeNull();

    const result = (await cliRow(cli.id))!;
    expect(result.result_enc).toBeTruthy();
    expect(result.result_enc).not.toContain('at_');

    // 6. Poll: the result, once.
    const res = await cli.poll();
    expect(res.status).toBe(200);
    const out = (await res.json()) as CliPollResponse;
    expect(out.status).toBe('done');
    const r = out.result;
    expect(r).toMatchObject({ endpoint: BASE, projectName: 'client.test', boardName: 'Mock Board', boardUrl: 'https://trello.com/b/mock1/mock-board', origins: ['https://client.test'] });
    expect(r.agentToken).toMatch(/^at_[\w-]{43}$/);

    const p = (await projectByKey(r.projectKey))!;
    expect(p).toMatchObject({ name: 'client.test', access_key: r.accessKey, allowed_origins: '["https://client.test"]', trello_board_id: 'board-1' });
    expect(p.webhook_id).toBeTruthy();
    expect(mockTrelloState().webhooks.get(p.webhook_id!)).toMatchObject({ callbackURL: `${BASE}/trello/webhook`, idModel: 'board-1' });
    expect(mockTrelloState().lists.get(p.review_list_id!)?.name).toBe('Ready for review');

    // The agent token is stored hashed, with the CLI's label.
    const tokens = await tokensFor(p.id);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ token_hash: await sha256Hex(r.agentToken), label: 'pierre-mbp:client', last_used_at: null });
    const { results: plain } = await env.DB.prepare('SELECT id FROM agent_tokens WHERE token_hash = ?').bind(r.agentToken).all();
    expect(plain).toHaveLength(0);

    // 7. One-shot.
    expect(await cliRow(cli.id)).toBeNull();
    expect((await cli.poll()).status).toBe(410);
  });

  it('a CLI session that already has a result (or was collected) cannot start /connect again', async () => {
    const cli = await createCli({ siteUrl: 'https://client.test/' });
    const flow = await open(cli.res.url);
    await login(flow);
    const fin = await flow.post('/connect/finish', { s: flow.s, boardId: 'board-1', newListId: 'list-1', doneListIds: ['list-3'], siteUrl: 'https://client.test/' });
    expect(fin.status).toBe(200);

    const used = await SELF.fetch(cli.res.url);
    expect(used.status).toBe(410);
    expect(used.headers.get('content-type')).toContain('text/html');
    expect(await used.text()).toContain('already used');
    expect(used.headers.get('set-cookie')).toBeNull();

    expect((await cli.poll()).status).toBe(200);
    const gone = await SELF.fetch(cli.res.url);
    expect(gone.status).toBe(410);
    expect(await gone.text()).toContain('expired');
  });

  it('an expired or unknown CLI session shows a friendly error page', async () => {
    const cli = await createCli();
    await env.DB.prepare('UPDATE cli_sessions SET expires_at = ? WHERE id = ?').bind(Date.now() - 1, cli.id).run();
    for (const url of [cli.res.url, `${BASE}/connect?cli=${randomId()}`, `${BASE}/connect?cli=`, `${BASE}/connect?cli=${encodeURIComponent('<x>')}`]) {
      const res = await SELF.fetch(url);
      expect(res.status).toBe(410);
      const html = await res.text();
      expect(html).toContain('This link has expired');
      expect(html).toContain('Run the command in your terminal again');
    }
  });

  it('finish fails cleanly if the terminal stopped waiting mid-flow', async () => {
    const cli = await createCli({ siteUrl: 'https://client.test/' });
    const flow = await open(cli.res.url);
    await login(flow);
    await env.DB.prepare('UPDATE cli_sessions SET expires_at = ? WHERE id = ?').bind(Date.now() - 1, cli.id).run();
    const countProjects = async () => (await env.DB.prepare('SELECT COUNT(*) AS n FROM projects').first<{ n: number }>())!.n;
    const before = await countProjects();
    const fin = await flow.post('/connect/finish', { s: flow.s, boardId: 'board-1', newListId: 'list-1', doneListIds: ['list-3'], siteUrl: 'https://client.test/' });
    expect(fin.status).toBe(410);
    expect(((await fin.json()) as ApiError).code).toBe('expired');
    expect(await countProjects()).toBe(before);
    expect(mockTrelloState().webhooks.size).toBe(0);
  });

  it('applies the owner rule and the browser binding', async () => {
    await env.DB.prepare('DELETE FROM settings').run();
    await popupProject(); // member-1 becomes the owner

    const cli = await createCli();
    const outsider = await open(cli.res.url);
    const res = await outsider.post('/connect/session', { s: outsider.s, token: MOCK_TOKEN_OUTSIDER });
    expect(res.status).toBe(403);

    const flow = await open(cli.res.url);
    await login(flow);
    const p = (await env.DB.prepare('SELECT id FROM projects').first<{ id: string }>())!;
    const stranger = await json('/connect/link', { s: flow.s, projectId: p.id }); // no cookie
    expect(stranger.status).toBe(403);
    expect((await cli.poll()).status).toBe(202);
  });

  it('create-board in CLI mode makes the four lists with review preselected', async () => {
    const cli = await createCli({ siteUrl: 'https://client.test/' });
    const flow = await open(cli.res.url);
    await login(flow);
    const created = (await (await flow.post('/connect/boards', { s: flow.s, siteUrl: 'https://client.test/' })).json()) as ConnectListsResponse;
    expect(created.board.name).toBe('Website feedback – client.test');
    expect(created.lists.map((l) => l.name)).toEqual(['New', 'In progress', 'Ready for review', 'Done']);
    expect(created.defaults).toEqual({ newListId: created.lists[0]!.id, doneListId: created.lists[3]!.id, reviewListId: created.lists[2]!.id });
  });
});

describe('CLI link (existing project)', () => {
  it('lists the projects on the member’s boards and links one', async () => {
    const project = await popupProject();
    const cli = await createCli({ mode: 'link' });
    const flow = await open(cli.res.url);
    await login(flow);

    const html = await (await flow.get(`/connect/boards?s=${flow.s}`)).text();
    expect(html.indexOf('Link an existing project')).toBeGreaterThan(0);
    expect(html.indexOf('Link an existing project')).toBeLessThan(html.indexOf('Connect a new board'));
    expect(html).toContain('Strauss Houses');
    expect(html).toContain('Board: Mock Board');
    expect(html).toContain('strausshouses.test');
    expect(html).toContain(`data-link="${project.id}"`);
    expect(html).not.toContain(project.access_key);

    const res = await flow.post('/connect/link', { s: flow.s, projectId: project.id });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      cli: { action: 'linked', projectName: 'Strauss Houses', boardName: 'Mock Board', boardUrl: 'https://trello.com/b/mock1/mock-board' },
    });
    expect(await connectRow(flow.s)).toBeNull();

    const out = (await (await cli.poll()).json()) as CliPollResponse;
    expect(out.result).toEqual({
      endpoint: BASE,
      projectKey: project.public_key,
      accessKey: project.access_key,
      agentToken: expect.stringMatching(/^at_[\w-]{43}$/),
      projectName: 'Strauss Houses',
      boardName: 'Mock Board',
      boardUrl: 'https://trello.com/b/mock1/mock-board',
      origins: ['https://strausshouses.test'],
    });
    const tokens = await tokensFor(project.id);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ token_hash: await sha256Hex(out.result.agentToken), label: 'cli' });
    expect((await cli.poll()).status).toBe(410);

    // Linking doesn't touch the project.
    expect(await projectByKey(project.public_key)).toEqual(project);
  });

  it('empty state when the member has no projects', async () => {
    await popupProject();
    mockTrelloState().boards.delete('board-1'); // the member lost access to the only project's board
    const cli = await createCli({ mode: 'link' });
    const flow = await open(cli.res.url);
    await login(flow);
    const html = await (await flow.get(`/connect/boards?s=${flow.s}`)).text();
    expect(html).toContain('No projects yet. Connect a new board below.');
  });

  it('403 for a project on a board the member can’t access, and it isn’t listed', async () => {
    await popupProject();
    // Same row shape as a real project, on a board this Trello member doesn't see.
    const hidden = { ...(await env.DB.prepare('SELECT * FROM projects').first<ProjectRow>())!, id: 'p-hidden', public_key: 'pk_hidden', name: 'Hidden Co', trello_board_id: 'board-secret' };
    const cols = Object.keys(hidden);
    await env.DB.prepare(`INSERT INTO projects (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
      .bind(...cols.map((k) => hidden[k as keyof ProjectRow]))
      .run();

    const cli = await createCli({ mode: 'link' });
    const flow = await open(cli.res.url);
    await login(flow);
    const html = await (await flow.get(`/connect/boards?s=${flow.s}`)).text();
    expect(html).toContain('Strauss Houses');
    expect(html).not.toContain('Hidden Co');

    const res = await flow.post('/connect/link', { s: flow.s, projectId: 'p-hidden' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as ApiError).code).toBe('forbidden');
    expect(await tokensFor('p-hidden')).toHaveLength(0);
    expect((await cli.poll()).status).toBe(202);
    expect((await flow.post('/connect/link', { s: flow.s, projectId: 'nope' })).status).toBe(404);
  });

  it('only one window can complete a CLI session', async () => {
    const project = await popupProject();
    const cli = await createCli({ mode: 'link' });
    const a = await open(cli.res.url);
    const b = await open(cli.res.url);
    await login(a);
    await login(b);
    expect((await a.post('/connect/link', { s: a.s, projectId: project.id })).status).toBe(200);
    const second = await b.post('/connect/link', { s: b.s, projectId: project.id });
    expect(second.status).toBe(410);
    expect(await tokensFor(project.id)).toHaveLength(1);
  });

  it('link is CLI-only and needs a Trello login', async () => {
    const project = await popupProject();
    const popup = await open(`${BASE}/connect?origin=https://strausshouses.test&name=Site`);
    await login(popup);
    expect((await popup.post('/connect/link', { s: popup.s, projectId: project.id })).status).toBe(400);

    const cli = await createCli({ mode: 'link' });
    const flow = await open(cli.res.url);
    expect((await flow.post('/connect/link', { s: flow.s, projectId: project.id })).status).toBe(401);
    expect(await tokensFor(project.id)).toHaveLength(0);
  });
});

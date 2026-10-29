import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ApiError } from '@annotate/shared';
import app from '../src/index';
import { decryptToken } from '../src/crypto';
import type { ConnectSessionRow, ProjectRow } from '../src/db';
import { MOCK_ORG_ID, MOCK_TOKEN, mockTrelloState, resetMockTrello } from '../src/trello';
import type { ConnectFinishResponse, ConnectListsResponse } from '../src/routes/connect';

const BASE = 'http://localhost:8787'; // PUBLIC_URL in wrangler.toml

type Fetch = (req: Request) => Promise<Response>;
const viaSelf: Fetch = (req) => SELF.fetch(req);
/** Call the app directly with overridden bindings. */
const withEnv =
  (overrides: Partial<typeof env>): Fetch =>
  async (req) =>
    app.fetch(req, { ...env, ...overrides });

interface Flow {
  s: string;
  cookie: string;
  html: string;
  get(path: string): Promise<Response>;
  post(path: string, body: unknown): Promise<Response>;
}

/** GET /connect and keep the session id and the browser-binding cookie for the next steps. */
async function start(query: string, f: Fetch = viaSelf): Promise<Flow> {
  const res = await f(new Request(`${BASE}/connect?${query}`));
  expect(res.status).toBe(200);
  const html = await res.text();
  const s = /\/connect\/callback\?s=([\w-]+)/.exec(html)?.[1];
  expect(s).toBeTruthy();
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!;
  expect(cookie).toBe(`acs_${s}=1`);
  const headers = { cookie };
  return {
    s: s!,
    cookie,
    html,
    get: (path) => f(new Request(`${BASE}${path}`, { headers })),
    post: (path, body) => f(new Request(`${BASE}${path}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) })),
  };
}

async function login(flow: Flow) {
  const res = await flow.post('/connect/session', { s: flow.s, token: MOCK_TOKEN });
  expect(res.status).toBe(200);
}

const session = (id: string) => env.DB.prepare('SELECT * FROM connect_sessions WHERE id = ?').bind(id).first<ConnectSessionRow>();
const projectByKey = (pk: string) => env.DB.prepare('SELECT * FROM projects WHERE public_key = ?').bind(pk).first<ProjectRow>();

/** Run the whole flow on the mock board with its default lists. */
async function connectMockBoard(query = 'origin=http://site.test&name=Site') {
  const flow = await start(query);
  await login(flow);
  const res = await flow.post('/connect/finish', { s: flow.s, boardId: 'board-1', newListId: 'list-1', doneListIds: ['list-3'] });
  expect(res.status).toBe(200);
  return (await res.json()) as ConnectFinishResponse;
}

beforeEach(() => resetMockTrello());

describe('connect flow', () => {
  it('connects a site to an existing board, end to end', async () => {
    // 1. Start: session row + authorize link.
    const flow = await start('origin=http://site.test&name=Site');
    expect(flow.html).toContain('Connect Site to Trello');
    expect(flow.html).toContain(`href="${BASE}/connect/callback?s=${flow.s}#token=${MOCK_TOKEN}"`);
    expect(flow.html).toContain('site.test');
    const row = await session(flow.s);
    expect(row).toMatchObject({ opener_origin: 'http://site.test', site_name: 'Site', project_id: null, trello_token_enc: null });
    expect(row!.expires_at).toBeGreaterThan(Date.now() + 14 * 60_000);

    // The callback page reads the fragment client-side.
    const cb = await flow.get(`/connect/callback?s=${flow.s}`);
    expect(cb.status).toBe(200);
    expect(await cb.text()).toContain('/connect/session');

    // 2. Token → session, stored encrypted.
    await login(flow);
    const withToken = await session(flow.s);
    expect(withToken!.trello_member_id).toBe('member-1');
    expect(withToken!.trello_token_enc).not.toContain(MOCK_TOKEN);
    expect(await decryptToken(env, withToken!.trello_token_enc!)).toBe(MOCK_TOKEN);

    // 3. Board picker.
    const boards = await flow.get(`/connect/boards?s=${flow.s}`);
    expect(boards.status).toBe(200);
    const boardsHtml = await boards.text();
    expect(boardsHtml).toContain('Mock Board');
    expect(boardsHtml).toContain('Create a new board for me');
    expect(boardsHtml).not.toContain('id="siteUrl"'); // opened from a site: no URL needed

    // 4. Lists + smart defaults.
    const lists = await flow.get(`/connect/lists?s=${flow.s}&board=board-1`);
    expect(lists.status).toBe(200);
    const l = (await lists.json()) as ConnectListsResponse;
    expect(l.lists.map((x) => x.name)).toEqual(['To Do', 'Doing', 'Done']);
    expect(l.defaults).toEqual({ newListId: 'list-1', doneListId: 'list-3' });

    // 5. Finish.
    const fin = await flow.post('/connect/finish', { s: flow.s, boardId: 'board-1', newListId: 'list-1', doneListIds: ['list-3'] });
    expect(fin.status).toBe(200);
    const out = (await fin.json()) as ConnectFinishResponse;
    expect(out.message).toMatchObject({ type: 'annotate:connected', boardName: 'Mock Board', boardUrl: 'https://trello.com/b/mock1/mock-board', endpoint: BASE });
    expect(out.message.projectKey).toMatch(/^pk_[\w-]{20,}$/);
    expect(out.message.accessKey).toMatch(/^ak_[\w-]{30,}$/);
    expect(out.snippet).toBe(`<script src="${BASE}/widget.js" data-endpoint="${BASE}" data-project="${out.message.projectKey}" defer></script>`);
    expect(out.activationUrl).toBe(`http://site.test/?annotate=${out.message.accessKey}`);

    const p = await projectByKey(out.message.projectKey);
    expect(p).toMatchObject({
      name: 'Site',
      access_key: out.message.accessKey,
      allowed_origins: '["http://site.test"]',
      trello_member_id: 'member-1',
      trello_board_id: 'board-1',
      trello_board_name: 'Mock Board',
      new_list_id: 'list-1',
      done_list_ids: '["list-3"]',
      token_revoked: 0,
    });
    expect(p!.webhook_id).toBeTruthy();
    expect(await decryptToken(env, p!.trello_token_enc)).toBe(MOCK_TOKEN);
    // The test shares the Worker's isolate, so the mock store is visible here.
    expect(mockTrelloState().webhooks.get(p!.webhook_id!)).toMatchObject({ callbackURL: `${BASE}/trello/webhook`, idModel: 'board-1' });

    // The session is single-use.
    expect(await session(flow.s)).toBeNull();
    expect((await flow.post('/connect/finish', { s: flow.s, boardId: 'board-1', newListId: 'list-1', doneListIds: ['list-3'] })).status).toBe(410);
  });

  it('creates a board with New / In progress / Done and connects to it', async () => {
    const flow = await start('origin=http://site.test&name=Site');
    await login(flow);
    const res = await flow.post('/connect/boards', { s: flow.s });
    expect(res.status).toBe(200);
    const created = (await res.json()) as ConnectListsResponse;
    expect(created.board.name).toBe('Website feedback – Site');
    expect(created.lists.map((l) => l.name)).toEqual(['New', 'In progress', 'Done']);
    expect(created.defaults).toEqual({ newListId: created.lists[0]!.id, doneListId: created.lists[2]!.id });
    expect(mockTrelloState().boards.get(created.board.id)?.idOrganization).toBeNull(); // no ALLOWED_TRELLO_ORG in tests

    // Trello now returns the same lists in the same order.
    const lists = (await (await flow.get(`/connect/lists?s=${flow.s}&board=${created.board.id}`)).json()) as ConnectListsResponse;
    expect(lists.lists).toEqual(created.lists);
    expect(lists.defaults).toEqual(created.defaults);

    const fin = await flow.post('/connect/finish', {
      s: flow.s,
      boardId: created.board.id,
      newListId: created.defaults.newListId,
      doneListIds: [created.defaults.doneListId],
    });
    expect(fin.status).toBe(200);
    const out = (await fin.json()) as ConnectFinishResponse;
    expect(out.message.boardName).toBe('Website feedback – Site');
    const p = await projectByKey(out.message.projectKey);
    expect(p).toMatchObject({ trello_board_id: created.board.id, new_list_id: created.lists[0]!.id, done_list_ids: JSON.stringify([created.lists[2]!.id]) });
  });

  it('standalone: asks for the site URL and uses it for origins and the activation link', async () => {
    const flow = await start('');
    expect(flow.html).toContain('Connect your site to Trello');
    await login(flow);
    const html = await (await flow.get(`/connect/boards?s=${flow.s}`)).text();
    expect(html).toContain('id="siteUrl"');
    expect(html).toContain('"nameFromSite":true');
    const created = (await (await flow.post('/connect/boards', { s: flow.s, siteUrl: 'https://client.example/shop/' })).json()) as ConnectListsResponse;
    expect(created.board.name).toBe('Website feedback – client.example');

    const missing = await flow.post('/connect/finish', { s: flow.s, boardId: 'board-1', newListId: 'list-1', doneListIds: ['list-3'] });
    expect(missing.status).toBe(400);

    const fin = await flow.post('/connect/finish', { s: flow.s, boardId: 'board-1', newListId: 'list-1', doneListIds: ['list-3'], siteUrl: 'https://client.example/shop/' });
    expect(fin.status).toBe(200);
    const out = (await fin.json()) as ConnectFinishResponse;
    expect(out.activationUrl).toBe(`https://client.example/shop/?annotate=${out.message.accessKey}`);
    const p = await projectByKey(out.message.projectKey);
    expect(p).toMatchObject({ name: 'client.example', allowed_origins: '["https://client.example"]' });
  });

  it('allows both the opener origin and the site URL origin (wp-admin vs home), deduplicated', async () => {
    const out = await connectMockBoard(`origin=https://admin.client.test&name=Site&site=${encodeURIComponent('https://www.client.test/blog/')}`);
    const p = await projectByKey(out.message.projectKey);
    expect(JSON.parse(p!.allowed_origins)).toEqual(['https://admin.client.test', 'https://www.client.test']);
    expect(out.activationUrl).toBe(`https://www.client.test/blog/?annotate=${out.message.accessKey}`);

    const same = await connectMockBoard(`origin=https://client.test&name=Site&site=${encodeURIComponent('https://client.test/')}`);
    expect((await projectByKey(same.message.projectKey))!.allowed_origins).toBe('["https://client.test"]');
  });

  it('rejects an expired session with 410', async () => {
    const flow = await start('origin=http://site.test&name=Site');
    await env.DB.prepare('UPDATE connect_sessions SET expires_at = ? WHERE id = ?').bind(Date.now() - 1, flow.s).run();

    const res = await flow.post('/connect/session', { s: flow.s, token: MOCK_TOKEN });
    expect(res.status).toBe(410);
    expect(((await res.json()) as ApiError).error).toMatch(/15 minutes/);

    const page = await flow.get(`/connect/boards?s=${flow.s}`);
    expect(page.status).toBe(410);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toContain('expired');
  });

  it('rejects an invalid Trello token with 401', async () => {
    const flow = await start('origin=http://site.test&name=Site');
    const res = await flow.post('/connect/session', { s: flow.s, token: 'not-a-real-token' });
    expect(res.status).toBe(401);
    expect(((await res.json()) as ApiError).code).toBe('unauthorized');
    expect((await session(flow.s))!.trello_token_enc).toBeNull();
  });

  it('rejects a member outside ALLOWED_TRELLO_ORG with 403', async () => {
    const f = withEnv({ ALLOWED_TRELLO_ORG: 'other' });
    const flow = await start('origin=http://site.test&name=Site', f);
    const res = await flow.post('/connect/session', { s: flow.s, token: MOCK_TOKEN });
    expect(res.status).toBe(403);
    expect(((await res.json()) as ApiError).error).toMatch(/isn’t in the allowed workspace/);
    expect((await session(flow.s))!.trello_token_enc).toBeNull();
  });

  it('with ALLOWED_TRELLO_ORG, lets members in and limits boards to that workspace', async () => {
    const f = withEnv({ ALLOWED_TRELLO_ORG: MOCK_ORG_ID });
    mockTrelloState().boards.set('board-x', { id: 'board-x', name: 'Personal Board', url: 'https://trello.com/b/x', idOrganization: null });
    const flow = await start('origin=http://site.test&name=Site', f);
    await login(flow);
    const html = await (await flow.get(`/connect/boards?s=${flow.s}`)).text();
    expect(html).toContain('Mock Board');
    expect(html).not.toContain('Personal Board');
    expect((await flow.get(`/connect/lists?s=${flow.s}&board=board-x`)).status).toBe(404);

    const created = (await (await flow.post('/connect/boards', { s: flow.s })).json()) as ConnectListsResponse;
    expect(mockTrelloState().boards.get(created.board.id)?.idOrganization).toBe(MOCK_ORG_ID);
  });

  it('reconnect keeps the keys and swaps the board and webhook', async () => {
    const first = await connectMockBoard();
    const { projectKey, accessKey } = first.message;
    const before = (await projectByKey(projectKey))!;

    // A wrong access key is refused.
    const bad = await SELF.fetch(`${BASE}/connect?origin=http://site.test&project=${projectKey}&access=ak_wrong`);
    expect(bad.status).toBe(404);

    const flow = await start(`origin=http://site.test&project=${projectKey}&access=${accessKey}`);
    expect(flow.html).toContain('Reconnect Site to Trello');
    expect((await session(flow.s))!.project_id).toBe(before.id);
    await login(flow);

    // The picker preselects the current board, with the project's current lists as defaults.
    expect(await (await flow.get(`/connect/boards?s=${flow.s}`)).text()).toContain('"currentBoardId":"board-1"');
    const same = (await (await flow.get(`/connect/lists?s=${flow.s}&board=board-1`)).json()) as ConnectListsResponse;
    expect(same.defaults).toEqual({ newListId: 'list-1', doneListId: 'list-3' });

    const created = (await (await flow.post('/connect/boards', { s: flow.s })).json()) as ConnectListsResponse;
    const fin = await flow.post('/connect/finish', { s: flow.s, boardId: created.board.id, newListId: created.lists[0]!.id, doneListIds: [created.lists[2]!.id] });
    expect(fin.status).toBe(200);
    const out = (await fin.json()) as ConnectFinishResponse;
    expect(out.message).toMatchObject({ projectKey, accessKey, boardName: 'Website feedback – Site' });

    const after = (await projectByKey(projectKey))!;
    expect(after).toMatchObject({ id: before.id, access_key: accessKey, trello_board_id: created.board.id, new_list_id: created.lists[0]!.id, allowed_origins: '["http://site.test"]' });
    expect(after.webhook_id).toBeTruthy();
    expect(after.webhook_id).not.toBe(before.webhook_id);
    const hooks = mockTrelloState().webhooks;
    expect(hooks.has(before.webhook_id!)).toBe(false);
    expect(hooks.get(after.webhook_id!)?.idModel).toBe(created.board.id);
    const { results } = await env.DB.prepare('SELECT id FROM projects WHERE public_key = ?').bind(projectKey).all();
    expect(results).toHaveLength(1);
  });

  it('validates the board and lists on finish', async () => {
    const flow = await start('origin=http://site.test&name=Site');
    await login(flow);
    const finish = (body: object) => flow.post('/connect/finish', { s: flow.s, ...body });
    expect((await finish({ boardId: 'nope', newListId: 'list-1', doneListIds: ['list-3'] })).status).toBe(400);
    expect((await finish({ boardId: 'board-1', newListId: 'list-x', doneListIds: ['list-3'] })).status).toBe(400);
    expect((await finish({ boardId: 'board-1', newListId: 'list-1', doneListIds: ['list-1'] })).status).toBe(400);
    expect((await finish({ boardId: 'board-1', newListId: 'list-1', doneListIds: [] })).status).toBe(400);
    expect(await session(flow.s)).not.toBeNull();
  });

  it('still connects when the webhook cannot be registered', async () => {
    const flow = await start('origin=http://site.test&name=Site');
    await login(flow);
    // Simulate Trello refusing the webhook (e.g. it can't reach localhost).
    const real = mockTrelloState().webhooks;
    const set = real.set.bind(real);
    real.set = () => {
      throw new Error('callback unreachable');
    };
    try {
      const fin = await flow.post('/connect/finish', { s: flow.s, boardId: 'board-1', newListId: 'list-1', doneListIds: ['list-3'] });
      expect(fin.status).toBe(200);
      const out = (await fin.json()) as ConnectFinishResponse;
      expect((await projectByKey(out.message.projectKey))!.webhook_id).toBeNull();
    } finally {
      real.set = set;
    }
  });

  it('binds the session to the browser that started it', async () => {
    const flow = await start('origin=http://site.test&name=Site');
    const res = await SELF.fetch(`${BASE}/connect/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ s: flow.s, token: MOCK_TOKEN }),
    });
    expect(res.status).toBe(403);
    expect((await session(flow.s))!.trello_token_enc).toBeNull();
  });

  it('requires a Trello login before the board steps', async () => {
    const flow = await start('origin=http://site.test&name=Site');
    expect((await flow.get(`/connect/lists?s=${flow.s}&board=board-1`)).status).toBe(401);
    expect((await flow.post('/connect/boards', { s: flow.s })).status).toBe(401);
  });

  it('rejects a bad origin and sends the security headers', async () => {
    const bad = await SELF.fetch(`${BASE}/connect?origin=${encodeURIComponent('javascript:alert(1)')}`);
    expect(bad.status).toBe(400);
    expect((await SELF.fetch(`${BASE}/connect?origin=${encodeURIComponent('https://a.test/path')}`)).status).toBe(400);
    for (const res of [bad, await SELF.fetch(`${BASE}/connect?origin=https://a.test/`)]) {
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    }
    const ok = await SELF.fetch(`${BASE}/connect?name=${encodeURIComponent('<b>Evil</b>')}`);
    expect(ok.headers.get('content-security-policy')).toMatch(/script-src 'nonce-[\w-]+'/);
    const html = await ok.text();
    expect(html).not.toContain('<b>Evil</b>');
    expect(html).toContain('&lt;b&gt;Evil&lt;/b&gt;');
  });

  it('redirects to PUBLIC_URL so the session cookie lands on the right host', async () => {
    const res = await SELF.fetch('http://127.0.0.1:8787/connect?name=Site', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${BASE}/connect?name=Site`);
  });
});

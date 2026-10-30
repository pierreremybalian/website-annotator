import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  HEADER_ACCESS,
  HEADER_PROJECT,
  type AgentIssueResponse,
  type AgentListIssuesResponse,
  type AgentOriginsResponse,
  type AgentProject,
  type ApiError,
  type CreateIssueMeta,
  type CreateIssueResponse,
  type IssueContext,
} from '@annotate/shared';
import { encryptToken, sha256Hex } from '../src/crypto';
import { randomId, type AgentTokenRow, type IssueRow, type ProjectRow } from '../src/db';
import { MOCK_TOKEN, mockMoveCard, mockTrelloState, resetMockTrello, trello } from '../src/trello';

const BASE = 'http://worker.test';
const ORIGIN = 'https://client.example';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 5, 6, 7, 8]);

type TestProject = { id: string; publicKey: string; accessKey: string; token: string };

async function createProject(opts: { doneListIds?: string[]; boardId?: string; trelloToken?: string } = {}): Promise<TestProject> {
  const id = randomId();
  const publicKey = `pk-${randomId(6)}`;
  const accessKey = `ak-${randomId(12)}`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO projects (id, name, public_key, access_key, allowed_origins, trello_token_enc, trello_member_id,
       trello_board_id, trello_board_name, trello_board_url, new_list_id, done_list_ids, created_at, updated_at)
     VALUES (?, 'Client site', ?, ?, ?, ?, 'member-1', ?, 'Mock Board', 'https://trello.com/b/mock1/mock-board', 'list-1', ?, ?, ?)`,
  )
    .bind(
      id,
      publicKey,
      accessKey,
      JSON.stringify([ORIGIN]),
      await encryptToken(env, opts.trelloToken ?? MOCK_TOKEN),
      opts.boardId ?? 'board-1',
      JSON.stringify(opts.doneListIds ?? ['list-3']),
      now,
      now,
    )
    .run();
  const token = await mintToken(id);
  return { id, publicKey, accessKey, token };
}

async function mintToken(projectId: string): Promise<string> {
  const token = `at_${randomId(24)}`;
  await env.DB.prepare('INSERT INTO agent_tokens (id, project_id, token_hash, label, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(randomId(), projectId, await sha256Hex(token), 'test', new Date().toISOString())
    .run();
  return token;
}

const widgetHeaders = (p: TestProject): Record<string, string> => ({ [HEADER_PROJECT]: p.publicKey, [HEADER_ACCESS]: p.accessKey, Origin: ORIGIN });

const CONTEXT: IssueContext = {
  page: { platform: 'wordpress', postId: 42, template: 'page.php' },
  element: {
    tag: 'section',
    html: '<section class="hero">…</section>',
    text: 'Welcome',
    landmark: 'Hero',
    styles: { display: 'block' },
    sources: [
      { kind: 'wp-block', value: 'acf/hero', depth: 0 },
      { kind: 'astro-source', value: 'src/components/Hero.astro', file: 'src/components/Hero.astro', line: 12, depth: 1 },
    ],
  },
};

function makeMeta(over: { url?: string; title?: string; context?: IssueContext } = {}): CreateIssueMeta {
  const meta: CreateIssueMeta = {
    title: over.title ?? 'Button overlaps footer',
    notes: 'The buy button overlaps the footer.',
    reporter: { name: 'Jane Client', email: 'jane@client.example' },
    anchor: { mode: 'element', selector: '#buy', relative: { x: 0, y: 0, width: 1, height: 1 }, absolute: { x: 10, y: 20, width: 300, height: 80 }, viewportWidth: 1440, text: 'Buy now' },
    env: {
      url: over.url ?? 'https://client.example/pricing/',
      title: 'Pricing',
      referrer: '',
      viewport: { width: 1440, height: 900 },
      dpr: 2,
      scroll: { x: 0, y: 0 },
      userAgent: 'Mozilla/5.0',
      browser: 'Chrome 130',
      os: 'macOS',
      language: 'en-US',
      timestamp: '2026-10-28T12:00:00.000Z',
      consoleErrors: [],
    },
  };
  if (over.context) meta.context = over.context;
  return meta;
}

async function createIssue(p: TestProject, meta = makeMeta()): Promise<CreateIssueResponse> {
  const form = new FormData();
  form.set('meta', JSON.stringify(meta));
  form.set('selection', new File([PNG], 'selection.png', { type: 'image/png' }));
  form.set('context', new File([JPEG], 'context.jpg', { type: 'image/jpeg' }));
  const res = await SELF.fetch(`${BASE}/v1/issues`, { method: 'POST', headers: widgetHeaders(p), body: form });
  expect(res.status).toBe(201);
  return res.json<CreateIssueResponse>();
}

function agent(p: TestProject | string, path: string, init: { method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { Authorization: `Bearer ${typeof p === 'string' ? p : p.token}` };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  return SELF.fetch(`${BASE}/v1/agent${path}`, {
    method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: init.body === undefined ? undefined : typeof init.body === 'string' ? init.body : JSON.stringify(init.body),
  });
}
const post = (p: TestProject, path: string, body: unknown = {}) => agent(p, path, { method: 'POST', body });
const detail = async (p: TestProject, n: number) => (await (await agent(p, `/issues/${n}`)).json<AgentIssueResponse>()).issue;
const list = async (p: TestProject, query = '') => (await (await agent(p, `/issues${query}`)).json<AgentListIssuesResponse>()).issues;

const issueRow = (id: string) => env.DB.prepare('SELECT * FROM issues WHERE id = ?').bind(id).first<IssueRow>();
const projectRow = (id: string) => env.DB.prepare('SELECT * FROM projects WHERE id = ?').bind(id).first<ProjectRow>();
const cardOf = async (id: string) => mockTrelloState().cards.get((await issueRow(id))!.trello_card_id)!;
const commentsOf = async (id: string) => (mockTrelloState().comments.get((await issueRow(id))!.trello_card_id) ?? []).map((c) => c.data.text);
const setStatus = (id: string, status: string) => env.DB.prepare('UPDATE issues SET status = ? WHERE id = ?').bind(status, id).run();

beforeEach(() => resetMockTrello());

describe('agent auth', () => {
  it('401s without a token, with a wrong one, and with a widget key', async () => {
    const p = await createProject();
    const none = await SELF.fetch(`${BASE}/v1/agent/project`);
    expect(none.status).toBe(401);
    expect(await none.json<ApiError>()).toMatchObject({ code: 'unauthorized' });
    expect((await agent('at_wrong', '/project')).status).toBe(401);
    expect((await agent(p.accessKey, '/project')).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/v1/agent/project`, { headers: { Authorization: p.token } })).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/v1/agent/issues`, { headers: widgetHeaders(p) })).status).toBe(401);
  });

  it('accepts a valid token and records last_used_at', async () => {
    const p = await createProject();
    const before = await env.DB.prepare('SELECT * FROM agent_tokens WHERE project_id = ?').bind(p.id).first<AgentTokenRow>();
    expect(before!.last_used_at).toBeNull();
    expect((await agent(p, '/project')).status).toBe(200);
    const after = await env.DB.prepare('SELECT * FROM agent_tokens WHERE project_id = ?').bind(p.id).first<AgentTokenRow>();
    expect(after!.last_used_at).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it('scopes the token to its project', async () => {
    const p = await createProject();
    const other = await createProject();
    await createIssue(other);
    expect(await list(p, '?status=all')).toHaveLength(0);
    expect((await agent(p, '/issues/1')).status).toBe(404);
  });
});

describe('GET /v1/agent/project', () => {
  it('returns the project with zero-filled counts', async () => {
    const p = await createProject();
    const a = await createIssue(p);
    await createIssue(p);
    await createIssue(p);
    await setStatus(a.id, 'review');
    const res = await agent(p, '/project');
    expect(res.status).toBe(200);
    expect(await res.json<AgentProject>()).toEqual({
      name: 'Client site',
      projectKey: p.publicKey,
      boardName: 'Mock Board',
      boardUrl: 'https://trello.com/b/mock1/mock-board',
      origins: [ORIGIN],
      counts: { new: 2, in_progress: 0, review: 1, resolved: 0, archived: 0 },
    });
  });
});

describe('GET /v1/agent/issues', () => {
  it('filters by status (open by default) and orders by number', async () => {
    const p = await createProject();
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push((await createIssue(p)).id);
    await setStatus(ids[1]!, 'in_progress');
    await setStatus(ids[2]!, 'review');
    await setStatus(ids[3]!, 'resolved');
    await setStatus(ids[4]!, 'archived');

    expect((await list(p)).map((i) => [i.number, i.status])).toEqual([
      [1, 'new'],
      [2, 'in_progress'],
    ]);
    expect((await list(p, '?status=open')).map((i) => i.number)).toEqual([1, 2]);
    expect((await list(p, '?status=review')).map((i) => i.number)).toEqual([3]);
    expect((await list(p, '?status=archived')).map((i) => i.number)).toEqual([5]);
    expect((await list(p, '?status=all')).map((i) => i.number)).toEqual([1, 2, 3, 4, 5]);
    const bad = await agent(p, '/issues?status=closed');
    expect(bad.status).toBe(400);
    expect(await bad.json<ApiError>()).toMatchObject({ code: 'bad_request' });
    expect((await agent(p, '/issues?status=constructor')).status).toBe(400);
  });

  it('filters by normalized page URL', async () => {
    const p = await createProject();
    await createIssue(p, makeMeta({ url: 'https://client.example/pricing/?utm_source=x' }));
    await createIssue(p, makeMeta({ url: 'https://client.example/about' }));
    const issues = await list(p, `?url=${encodeURIComponent('https://CLIENT.example/pricing#plans')}`);
    expect(issues.map((i) => i.number)).toEqual([1]);
    expect(issues[0]!.pageUrl).toBe('https://client.example/pricing/?utm_source=x');
    expect((await agent(p, '/issues?url=nope')).status).toBe(400);
  });

  it('returns the agent shape with signed URLs, sources and lease state', async () => {
    const p = await createProject();
    const a = await createIssue(p, makeMeta({ context: CONTEXT }));
    const b = await createIssue(p);
    await env.DB.prepare('UPDATE issues SET claimed_by = ?, claimed_until = ? WHERE id = ?').bind('bot-1', Date.now() + 60_000, a.id).run();
    await env.DB.prepare('UPDATE issues SET claimed_by = ?, claimed_until = ? WHERE id = ?').bind('bot-2', Date.now() - 1, b.id).run();

    const [first, second] = await list(p);
    expect(first).toMatchObject({
      id: a.id,
      number: 1,
      title: 'Button overlaps footer',
      status: 'new',
      notes: 'The buy button overlaps the footer.',
      reporterName: 'Jane Client',
      shortUrl: a.shortUrl,
      claimedBy: 'bot-1',
      selector: '#buy',
      sources: CONTEXT.element!.sources,
    });
    expect(first!.claimedUntil).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
    expect(first!.screenshotUrl).toMatch(new RegExp(`^${env.PUBLIC_URL}/v1/screenshots/${p.id}/${a.id}/selection\\.png\\?exp=\\d+&sig=`));
    expect(first!.contextUrl).toContain(`/v1/screenshots/${p.id}/${a.id}/context.jpg?exp=`);
    // Expired lease and no context.
    expect(second).toMatchObject({ number: 2, claimedBy: null, claimedUntil: null, sources: [] });
  });
});

describe('GET /v1/agent/issues/:number', () => {
  it('returns the detail with context, sources, env and comments', async () => {
    const p = await createProject();
    const created = await createIssue(p, makeMeta({ context: CONTEXT }));
    const res = await agent(p, '/issues/1');
    expect(res.status).toBe(200);
    const { issue } = await res.json<AgentIssueResponse>();
    expect(issue).toMatchObject({ id: created.id, number: 1, status: 'new', context: CONTEXT, sources: CONTEXT.element!.sources, comments: [], resolution: null });
    expect(issue.anchor.selector).toBe('#buy');
    expect(issue.env.browser).toBe('Chrome 130');
  });

  it('returns null context for an issue reported without one', async () => {
    const p = await createProject();
    await createIssue(p);
    expect(await detail(p, 1)).toMatchObject({ context: null, sources: [] });
  });

  it('heals the status from Trello', async () => {
    const p = await createProject();
    const created = await createIssue(p);
    mockMoveCard((await issueRow(created.id))!.trello_card_id, 'list-2');
    expect((await detail(p, 1)).status).toBe('in_progress');
    expect((await issueRow(created.id))!.status).toBe('in_progress');
  });

  it('404s for an unknown number and 400s for a non-number', async () => {
    const p = await createProject();
    await createIssue(p);
    expect((await agent(p, '/issues/2')).status).toBe(404);
    expect((await agent(p, '/issues/abc')).status).toBe(400);
    expect((await agent(p, '/issues/%231')).status).toBe(200);
  });
});

describe('claim / release', () => {
  it('claims, renews without a second comment, and refuses another agent', async () => {
    const p = await createProject();
    const created = await createIssue(p);

    const res = await post(p, '/issues/1/claim', { agent: 'claude@mbp', minutes: 10 });
    expect(res.status).toBe(200);
    const { issue } = await res.json<AgentIssueResponse>();
    expect(issue).toMatchObject({ claimedBy: 'claude@mbp', status: 'in_progress' });
    const until = Date.parse(issue.claimedUntil!);
    expect(until).toBeGreaterThan(Date.now() + 9 * 60_000);
    expect(until).toBeLessThanOrEqual(Date.now() + 10 * 60_000);
    expect(await commentsOf(created.id)).toEqual(['**claude@mbp** (via agent): 🤖 Working on this']);
    expect((await cardOf(created.id)).idList).toBe('list-2'); // the board's "Doing" list
    expect((await projectRow(p.id))!.progress_list_id).toBe('list-2');
    expect((await issueRow(created.id))!.status).toBe('in_progress');

    const conflict = await post(p, '/issues/1/claim', { agent: 'codex@ci' });
    expect(conflict.status).toBe(409);
    const err = await conflict.json<ApiError>();
    expect(err.code).toBe('claimed');
    expect(err.error).toContain('claude@mbp');
    expect(err.error).toContain(issue.claimedUntil!);

    const renew = await post(p, '/issues/1/claim', { agent: 'claude@mbp', minutes: 60 });
    expect(renew.status).toBe(200);
    expect(Date.parse((await renew.json<AgentIssueResponse>()).issue.claimedUntil!)).toBeGreaterThan(Date.now() + 59 * 60_000);
    expect(await commentsOf(created.id)).toHaveLength(1);
  });

  it('lets another agent take an expired lease', async () => {
    const p = await createProject();
    const created = await createIssue(p);
    expect((await post(p, '/issues/1/claim', { agent: 'a' })).status).toBe(200);
    await env.DB.prepare('UPDATE issues SET claimed_until = ? WHERE id = ?').bind(Date.now() - 1000, created.id).run();
    expect((await detail(p, 1)).claimedBy).toBeNull();

    const res = await post(p, '/issues/1/claim', { agent: 'b' });
    expect(res.status).toBe(200);
    expect((await res.json<AgentIssueResponse>()).issue.claimedBy).toBe('b');
    expect(await commentsOf(created.id)).toEqual(['**a** (via agent): 🤖 Working on this', '**b** (via agent): 🤖 Working on this']);
  });

  it('releases the lease and moves the card back to the new list', async () => {
    const p = await createProject();
    const created = await createIssue(p);
    await post(p, '/issues/1/claim', { agent: 'a' });
    const res = await post(p, '/issues/1/release');
    expect(res.status).toBe(200);
    expect((await res.json<AgentIssueResponse>()).issue).toMatchObject({ claimedBy: null, claimedUntil: null, status: 'new' });
    expect(await issueRow(created.id)).toMatchObject({ claimed_by: null, status: 'new' });
    expect((await cardOf(created.id)).idList).toBe('list-1');
    expect((await post(p, '/issues/1/claim', { agent: 'b' })).status).toBe(200);
  });

  it('leaves a card a human moved elsewhere since the claim', async () => {
    const p = await createProject();
    const created = await createIssue(p);
    await post(p, '/issues/1/claim', { agent: 'a' });
    mockTrelloState().lists.set('list-blocked', { id: 'list-blocked', name: 'Blocked', pos: 2500, idBoard: 'board-1' });
    mockMoveCard((await issueRow(created.id))!.trello_card_id, 'list-blocked');
    expect((await post(p, '/issues/1/release')).status).toBe(200);
    expect((await cardOf(created.id)).idList).toBe('list-blocked');
    expect((await issueRow(created.id))!.status).toBe('in_progress');
  });

  it('creates an "In progress" list after the new list when none fits', async () => {
    const p = await createProject();
    mockTrelloState().lists.get('list-2')!.name = 'Backlog';
    const created = await createIssue(p);
    expect((await post(p, '/issues/1/claim', { agent: 'a' })).status).toBe(200);
    const id = (await projectRow(p.id))!.progress_list_id!;
    expect(mockTrelloState().lists.get(id)).toMatchObject({ name: 'In progress', pos: (1024 + 2048) / 2 });
    expect((await cardOf(created.id)).idList).toBe(id);

    // Reused, not recreated.
    await createIssue(p);
    expect((await post(p, '/issues/2/claim', { agent: 'a' })).status).toBe(200);
    expect([...mockTrelloState().lists.values()].filter((l) => l.name === 'In progress')).toHaveLength(1);
  });

  it("doesn't move an issue that isn't new", async () => {
    const p = await createProject();
    const created = await createIssue(p);
    mockTrelloState().lists.set('list-qa', { id: 'list-qa', name: 'QA', pos: 2500, idBoard: 'board-1' });
    await env.DB.prepare("UPDATE projects SET review_list_id = 'list-qa' WHERE id = ?").bind(p.id).run();
    mockMoveCard((await issueRow(created.id))!.trello_card_id, 'list-qa');
    await env.DB.prepare("UPDATE issues SET status = 'review' WHERE id = ?").bind(created.id).run();
    expect((await post(p, '/issues/1/claim', { agent: 'a' })).status).toBe(200);
    expect((await cardOf(created.id)).idList).toBe('list-qa');
    expect((await projectRow(p.id))!.progress_list_id).toBeNull();
  });

  it.each<[string, unknown]>([
    ['missing agent', {}],
    ['blank agent', { agent: '  ' }],
    ['minutes over 240', { agent: 'a', minutes: 241 }],
    ['zero minutes', { agent: 'a', minutes: 0 }],
    ['string minutes', { agent: 'a', minutes: '30' }],
    ['non-object body', '"hi"'],
  ])('400s on %s', async (_name, body) => {
    const p = await createProject();
    await createIssue(p);
    const res = await post(p, '/issues/1/claim', body);
    expect(res.status).toBe(400);
    expect(await res.json<ApiError>()).toMatchObject({ code: 'bad_request' });
  });

  it('rolls the lease back when Trello rejects the comment', async () => {
    const p = await createProject();
    const created = await createIssue(p);
    await env.DB.prepare('UPDATE projects SET trello_token_enc = ? WHERE id = ?').bind(await encryptToken(env, 'bad-token'), p.id).run();
    const res = await post(p, '/issues/1/claim', { agent: 'a' });
    expect(res.status).toBe(502);
    expect(await res.json<ApiError>()).toMatchObject({ code: 'token_revoked' });
    expect((await issueRow(created.id))!.claimed_by).toBeNull();
    expect((await projectRow(p.id))!.token_revoked).toBe(1);
  });
});

describe('comments', () => {
  it('posts "(via agent)" comments and parses every kind back', async () => {
    const p = await createProject();
    const created = await createIssue(p);
    const res = await post(p, '/issues/1/comments', { text: 'Found it in **Hero.astro**.\nFixing.', author: 'Claude' });
    expect(res.status).toBe(201);
    expect((await post(p, '/issues/1/comments', { text: 'No author' })).status).toBe(201);
    expect(await commentsOf(created.id)).toEqual(['**Claude** (via agent): Found it in **Hero.astro**.\nFixing.', '**Agent** (via agent): No author']);

    // A widget comment and a plain Trello comment.
    await SELF.fetch(`${BASE}/v1/issues/${created.id}/comments`, {
      method: 'POST',
      headers: { ...widgetHeaders(p), 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Thanks!', reporter: { name: 'Jane Client', email: 'jane@client.example' } }),
    });
    await trello(env, MOCK_TOKEN).addComment((await issueRow(created.id))!.trello_card_id, 'On it.');

    const { comments } = await detail(p, 1);
    expect(comments.map(({ author, text, via, viaWidget }) => ({ author, text, via, viaWidget }))).toEqual([
      { author: 'Claude', text: 'Found it in **Hero.astro**.\nFixing.', via: 'agent', viaWidget: false },
      { author: 'Agent', text: 'No author', via: 'agent', viaWidget: false },
      { author: 'Jane Client', text: 'Thanks!', via: 'widget', viaWidget: true },
      { author: 'Mock User', text: 'On it.', via: 'trello', viaWidget: false },
    ]);
  });

  it('400s on empty or oversized text and 404s on an unknown issue', async () => {
    const p = await createProject();
    await createIssue(p);
    expect((await post(p, '/issues/1/comments', { text: ' ' })).status).toBe(400);
    expect((await post(p, '/issues/1/comments', { text: 'a'.repeat(5001) })).status).toBe(400);
    expect((await post(p, '/issues/1/comments', { text: 'hi', author: 7 })).status).toBe(400);
    expect((await post(p, '/issues/9/comments', { text: 'hi' })).status).toBe(404);
  });
});

describe('resolve', () => {
  it('moves the card to Done and records the resolution', async () => {
    const p = await createProject();
    const a = await createIssue(p);
    await post(p, '/issues/1/claim', { agent: 'claude' });

    const res = await post(p, '/issues/1/resolve', { note: 'Fixed the z-index.', commit: 'abc1234', author: 'Claude' });
    expect(res.status).toBe(200);
    const { issue } = await res.json<AgentIssueResponse>();
    expect(issue).toMatchObject({ status: 'resolved', resolution: 'Fixed the z-index.', claimedBy: null, claimedUntil: null });
    expect((await cardOf(a.id)).idList).toBe('list-3');
    expect(await issueRow(a.id)).toMatchObject({ status: 'resolved', resolution: 'Fixed the z-index.', claimed_by: null, claimed_until: null });
    expect((await commentsOf(a.id)).at(-1)).toBe('**Claude** (via agent): ✅ Fixed: Fixed the z-index.\nCommit: abc1234');
    expect(issue.comments.at(-1)).toMatchObject({ author: 'Claude', via: 'agent', text: '✅ Fixed: Fixed the z-index.\nCommit: abc1234' });
    expect([...mockTrelloState().lists.values()].some((l) => l.name === 'Ready for review')).toBe(false);

    // Self-heal agrees.
    expect((await detail(p, 1)).status).toBe('resolved');
    expect((await list(p, '?status=resolved')).map((i) => i.number)).toEqual([1]);
  });

  it('uses the first done list', async () => {
    const p = await createProject({ doneListIds: ['list-3', 'list-verified'] });
    mockTrelloState().lists.set('list-verified', { id: 'list-verified', name: 'Verified', pos: 5000, idBoard: 'board-1' });
    const a = await createIssue(p);
    expect((await post(p, '/issues/1/resolve', { note: 'x' })).status).toBe(200);
    expect((await cardOf(a.id)).idList).toBe('list-3');
  });

  it('400s when the project has no done list', async () => {
    const p = await createProject({ doneListIds: [] });
    const a = await createIssue(p);
    expect((await post(p, '/issues/1/resolve', { note: 'x' })).status).toBe(400);
    expect((await issueRow(a.id))!.status).toBe('new');
  });

  it('400s without a note', async () => {
    const p = await createProject();
    await createIssue(p);
    expect((await post(p, '/issues/1/resolve', {})).status).toBe(400);
    expect((await post(p, '/issues/1/resolve', { note: 'x', commit: 5 })).status).toBe(400);
    expect(mockTrelloState().lists.size).toBe(3);
  });

  it('502s with trello_error on a Trello failure and token_revoked on a 401', async () => {
    const p = await createProject();
    const created = await createIssue(p);
    mockTrelloState().lists.delete('list-3');
    const res = await post(p, '/issues/1/resolve', { note: 'x' });
    expect(res.status).toBe(502);
    expect(await res.json<ApiError>()).toMatchObject({ code: 'trello_error' });
    expect((await issueRow(created.id))!.status).toBe('new');

    const q = await createProject();
    await createIssue(q);
    await env.DB.prepare('UPDATE projects SET trello_token_enc = ? WHERE id = ?').bind(await encryptToken(env, 'bad-token'), q.id).run();
    const revoked = await post(q, '/issues/1/resolve', { note: 'x' });
    expect(revoked.status).toBe(502);
    expect(await revoked.json<ApiError>()).toMatchObject({ code: 'token_revoked' });
  });
});

describe('reopen', () => {
  it('moves the card back to the new list with a note', async () => {
    const p = await createProject();
    const a = await createIssue(p);
    await post(p, '/issues/1/resolve', { note: 'Fixed' });
    const res = await post(p, '/issues/1/reopen', { note: 'Wrong element', author: 'Claude' });
    expect(res.status).toBe(200);
    expect((await res.json<AgentIssueResponse>()).issue).toMatchObject({ status: 'new', resolution: 'Fixed' });
    expect((await cardOf(a.id)).idList).toBe('list-1');
    expect((await issueRow(a.id))!.status).toBe('new');
    expect((await commentsOf(a.id)).at(-1)).toBe('**Claude** (via agent): 🔁 Reopened: Wrong element');
    expect((await post(p, '/issues/1/reopen', {})).status).toBe(400);
  });
});

describe('origins', () => {
  const origins = async (res: Response) => {
    expect(res.status).toBe(200);
    return (await res.json<AgentOriginsResponse>()).origins;
  };

  it('lists, adds (normalized, deduped) and removes origins', async () => {
    const p = await createProject();
    expect(await origins(await agent(p, '/origins'))).toEqual([ORIGIN]);
    expect(await origins(await post(p, '/origins', { origin: 'https://Staging.Client.example/some/page?x=1' }))).toEqual([ORIGIN, 'https://staging.client.example']);
    expect(await origins(await post(p, '/origins', { origin: 'https://staging.client.example/' }))).toEqual([ORIGIN, 'https://staging.client.example']);
    expect(await origins(await post(p, '/origins', { origin: 'http://localhost:4321' }))).toEqual([ORIGIN, 'https://staging.client.example', 'http://localhost:4321']);
    expect(JSON.parse((await projectRow(p.id))!.allowed_origins)).toHaveLength(3);

    // The widget now works from the new origin.
    const widget = await SELF.fetch(`${BASE}/v1/issues?url=${encodeURIComponent('http://localhost:4321/')}`, { headers: { ...widgetHeaders(p), Origin: 'http://localhost:4321' } });
    expect(widget.status).toBe(200);

    expect(await origins(await agent(p, '/origins', { method: 'DELETE', body: { origin: 'https://staging.client.example' } }))).toEqual([ORIGIN, 'http://localhost:4321']);
    expect(await origins(await agent(p, '/origins', { method: 'DELETE', body: { origin: 'https://not-there.example' } }))).toEqual([ORIGIN, 'http://localhost:4321']);
    expect((await agent(p, '/project').then((r) => r.json<AgentProject>())).origins).toEqual([ORIGIN, 'http://localhost:4321']);
  });

  it.each([['ftp://files.example'], ['not a url'], ['javascript:alert(1)'], ['']])('400s on %j', async (origin) => {
    const p = await createProject();
    const res = await post(p, '/origins', { origin });
    expect(res.status).toBe(400);
    expect(await res.json<ApiError>()).toMatchObject({ code: 'bad_request' });
  });

  it('caps the list at 20', async () => {
    const p = await createProject();
    for (let i = 1; i < 20; i++) expect((await post(p, '/origins', { origin: `https://s${i}.example` })).status).toBe(200);
    const res = await post(p, '/origins', { origin: 'https://one-too-many.example' });
    expect(res.status).toBe(400);
    expect(await origins(await post(p, '/origins', { origin: ORIGIN }))).toHaveLength(20); // existing: still fine
  });
});

describe('/dev seed', () => {
  it('creates the dev agent token', async () => {
    expect((await SELF.fetch(`${BASE}/dev/seed`, { method: 'POST' })).status).toBe(200);
    const seeded = await (await SELF.fetch(`${BASE}/dev/seed`, { method: 'POST' })).json<{ agentToken: string }>();
    expect(seeded.agentToken).toBe('at_dev-token');
    const res = await agent('at_dev-token', '/project');
    expect(res.status).toBe(200);
    expect((await res.json<AgentProject>()).projectKey).toBe('dev-project');
    const row = await env.DB.prepare('SELECT * FROM agent_tokens WHERE token_hash = ?').bind(await sha256Hex('at_dev-token')).first<AgentTokenRow>();
    expect(row!.token_hash).not.toContain('dev-token');
  });
});

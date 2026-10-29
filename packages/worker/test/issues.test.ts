import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  HEADER_ACCESS,
  HEADER_PROJECT,
  type AddCommentResponse,
  type ApiError,
  type CreateIssueMeta,
  type CreateIssueResponse,
  type GetIssueResponse,
  type IssueActionResponse,
  type IssueContext,
  type ListIssuesResponse,
  type ProjectStatus,
} from '@annotate/shared';
import { encryptToken } from '../src/crypto';
import { randomId, type IssueRow, type ProjectRow } from '../src/db';
import { MOCK_TOKEN, mockMoveCard, mockTrelloState, resetMockTrello, trello } from '../src/trello';
import { signedScreenshotUrl } from '../src/sign';

const BASE = 'http://worker.test';
const ORIGIN = 'https://client.example';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 5, 6, 7, 8]);

type TestProject = { id: string; publicKey: string; accessKey: string };

async function createProject(opts: { token?: string; newListId?: string; ignoreQuery?: boolean } = {}): Promise<TestProject> {
  const id = randomId();
  const publicKey = `pk-${randomId(6)}`;
  const accessKey = `ak-${randomId(12)}`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO projects (id, name, public_key, access_key, allowed_origins, trello_token_enc, trello_member_id,
       trello_board_id, trello_board_name, trello_board_url, new_list_id, done_list_ids, ignore_query, created_at, updated_at)
     VALUES (?, 'Client site', ?, ?, ?, ?, 'member-1', 'board-1', 'Mock Board', 'https://trello.com/b/mock1/mock-board', ?, '["list-3"]', ?, ?, ?)`,
  )
    .bind(
      id,
      publicKey,
      accessKey,
      JSON.stringify([ORIGIN]),
      await encryptToken(env, opts.token ?? MOCK_TOKEN),
      opts.newListId ?? 'list-1',
      opts.ignoreQuery ? 1 : 0,
      now,
      now,
    )
    .run();
  return { id, publicKey, accessKey };
}

const authHeaders = (p: TestProject): Record<string, string> => ({ [HEADER_PROJECT]: p.publicKey, [HEADER_ACCESS]: p.accessKey, Origin: ORIGIN });

function makeMeta(over: Partial<CreateIssueMeta> & { url?: string } = {}): CreateIssueMeta {
  const { url, ...rest } = over;
  return {
    title: 'Button overlaps footer',
    notes: 'The buy button overlaps the footer on narrow screens.\nSeen on the pricing page.',
    reporter: { name: 'Jane Client', email: 'jane@client.example' },
    anchor: {
      selector: '#buy',
      relative: { x: 0, y: 0, width: 1, height: 1 },
      absolute: { x: 10, y: 20, width: 300, height: 80 },
      viewportWidth: 1440,
      text: 'Buy now',
    },
    env: {
      url: url ?? 'https://client.example/pricing/?utm_source=newsletter',
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
    ...rest,
  };
}

type Parts = { meta?: string | null; selection?: File | null; context?: File | null };

function issueForm(meta: CreateIssueMeta | string, parts: Parts = {}): FormData {
  const form = new FormData();
  const m = parts.meta !== undefined ? parts.meta : typeof meta === 'string' ? meta : JSON.stringify(meta);
  if (m !== null) form.set('meta', m);
  const sel = parts.selection !== undefined ? parts.selection : new File([PNG], 'selection.png', { type: 'image/png' });
  const ctx = parts.context !== undefined ? parts.context : new File([JPEG], 'context.jpg', { type: 'image/jpeg' });
  if (sel) form.set('selection', sel);
  if (ctx) form.set('context', ctx);
  return form;
}

const postIssue = (p: TestProject, body: FormData) => SELF.fetch(`${BASE}/v1/issues`, { method: 'POST', headers: authHeaders(p), body });

async function createIssue(p: TestProject, meta = makeMeta()): Promise<CreateIssueResponse> {
  const res = await postIssue(p, issueForm(meta));
  expect(res.status).toBe(201);
  return res.json<CreateIssueResponse>();
}

const listIssues = (p: TestProject, url: string, all = false) =>
  SELF.fetch(`${BASE}/v1/issues?url=${encodeURIComponent(url)}${all ? '&all=1' : ''}`, { headers: authHeaders(p) });

const getIssue = (p: TestProject, id: string) => SELF.fetch(`${BASE}/v1/issues/${id}`, { headers: authHeaders(p) });

const issueRow = (id: string) => env.DB.prepare('SELECT * FROM issues WHERE id = ?').bind(id).first<IssueRow>();
const projectRow = (id: string) => env.DB.prepare('SELECT * FROM projects WHERE id = ?').bind(id).first<ProjectRow>();

/** Path + query of an absolute signed URL, fetched against the test Worker. */
const fetchSigned = (url: string) => {
  const u = new URL(url);
  return SELF.fetch(`${BASE}${u.pathname}${u.search}`);
};

beforeEach(() => resetMockTrello());

describe('POST /v1/issues', () => {
  it('creates a Trello card, stores images and records the issue', async () => {
    const p = await createProject();
    const res = await postIssue(p, issueForm(makeMeta()));
    expect(res.status).toBe(201);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    const body = await res.json<CreateIssueResponse>();
    expect(body.number).toBe(1);

    const cards = [...mockTrelloState().cards.values()];
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    expect(body.shortUrl).toBe(card.shortUrl);
    expect(card.idList).toBe('list-1');
    expect(card.name).toBe('#1 Button overlaps footer');
    expect(card.desc).toBe(
      [
        'The buy button overlaps the footer on narrow screens.',
        'Seen on the pricing page.',
        '',
        '---',
        '**Page:** [Pricing](https://client.example/pricing/?utm_source=newsletter)',
        '**Reporter:** Jane Client <jane@client.example>',
        '**Env:** Chrome 130 · macOS · 1440×900 @2x',
      ].join('\n'),
    );
    expect(card.attachments).toEqual([
      expect.objectContaining({ name: 'issue-1.png', cover: true, size: PNG.length }),
      expect.objectContaining({ name: 'issue-1-context.jpg', cover: false, size: JPEG.length }),
    ]);

    const row = await issueRow(body.id);
    expect(row).toMatchObject({
      project_id: p.id,
      number: 1,
      trello_card_id: card.id,
      trello_short_url: card.shortUrl,
      page_url: 'https://client.example/pricing',
      page_url_raw: 'https://client.example/pricing/?utm_source=newsletter',
      title: 'Button overlaps footer',
      reporter_name: 'Jane Client',
      reporter_email: 'jane@client.example',
      status: 'new',
    });
    expect(JSON.parse(row!.anchor)).toEqual(makeMeta().anchor);
    expect(JSON.parse(row!.env).browser).toBe('Chrome 130');

    const sel = await env.SCREENSHOTS.get(row!.screenshot_key);
    const ctx = await env.SCREENSHOTS.get(row!.context_key);
    expect(row!.screenshot_key).toBe(`${p.id}/${body.id}/selection.png`);
    expect(sel?.httpMetadata?.contentType).toBe('image/png');
    expect(new Uint8Array(await sel!.arrayBuffer())).toEqual(PNG);
    expect(ctx?.httpMetadata?.contentType).toBe('image/jpeg');
  });

  it('numbers issues sequentially per project', async () => {
    const p = await createProject();
    const other = await createProject();
    expect((await createIssue(p)).number).toBe(1);
    expect((await createIssue(p)).number).toBe(2);
    expect((await createIssue(other)).number).toBe(1);
    expect((await projectRow(p.id))!.next_number).toBe(3);
  });

  it('falls back to the first line of the notes, truncated to 80 chars', async () => {
    const p = await createProject();
    const longLine = 'x'.repeat(120);
    await createIssue(p, makeMeta({ title: '  ', notes: `${longLine}\nmore detail` }));
    const card = [...mockTrelloState().cards.values()][0]!;
    expect(card.name).toBe(`#1 ${'x'.repeat(79)}…`);
    expect(card.name.length).toBe(3 + 80);
  });

  it('lists console errors in a code block', async () => {
    const p = await createProject();
    const meta = makeMeta();
    meta.env.consoleErrors = [
      { kind: 'error', message: 'Uncaught TypeError: x is undefined', stack: 'at foo (app.js:1:2)', at: 1 },
      { kind: 'console.error', message: 'Failed to load ```thing```', at: 2 },
    ];
    await createIssue(p, meta);
    const desc = [...mockTrelloState().cards.values()][0]!.desc;
    expect(desc).toContain(
      '**Console errors:** 2\n```\n[error] Uncaught TypeError: x is undefined\nat foo (app.js:1:2)\n[console.error] Failed to load \'\'\'thing\'\'\'\n```',
    );
  });

  it('keeps the description under 16000 chars with many large console errors', async () => {
    const p = await createProject();
    const meta = makeMeta({ notes: 'n'.repeat(10000) });
    meta.env.consoleErrors = Array.from({ length: 20 }, (_, i) => ({ kind: 'error' as const, message: `err ${i} ${'m'.repeat(900)}`, stack: 's'.repeat(1900), at: i }));
    await createIssue(p, meta);
    const desc = [...mockTrelloState().cards.values()][0]!.desc;
    expect(desc.length).toBeLessThanOrEqual(16000);
    expect(desc).toContain('**Console errors:** 20');
    expect(desc).toMatch(/older errors omitted/);
    expect(desc).toContain('err 19 '); // the newest is kept
    expect(desc.endsWith('```')).toBe(true);
  });

  it('stores the element context and lists source hints in the card description', async () => {
    const p = await createProject();
    const context: IssueContext = {
      page: { platform: 'astro', route: '/pricing' },
      element: {
        tag: 'button',
        html: '<button id="buy">Buy now</button>',
        text: 'Buy now',
        landmark: 'Pricing',
        styles: { display: 'inline-block' },
        sources: [
          { kind: 'wp-block', value: 'acf/hero', depth: 0 },
          { kind: 'astro-source', value: 'src/components/Hero.astro', file: 'src/components/Hero.astro', line: 12, depth: 1 },
          { kind: 'wp-block', value: 'acf/hero', depth: 2 },
          { kind: 'astro-cid', value: 'abc123', depth: 2 },
          { kind: 'annotate', value: 'Footer', depth: 3 },
        ],
      },
    };
    const created = await createIssue(p, makeMeta({ context }));
    expect(JSON.parse((await issueRow(created.id))!.context!)).toEqual(context);
    const desc = [...mockTrelloState().cards.values()][0]!.desc;
    expect(desc.split('\n').at(-1)).toBe('**Source:** `acf/hero`, `src/components/Hero.astro:12`, `data-astro-cid-abc123`');
  });

  it('stores no context for a pre-0.2 report and adds no Source line', async () => {
    const p = await createProject();
    const created = await createIssue(p, makeMeta({ context: null as unknown as IssueContext }));
    expect((await issueRow(created.id))!.context).toBeNull();
    expect([...mockTrelloState().cards.values()][0]!.desc).not.toContain('**Source:**');
  });

  const big = new Uint8Array(8 * 1024 * 1024 + 1);
  big.set(PNG);
  it.each<[string, Parts, CreateIssueMeta | string]>([
    ['missing notes', {}, makeMeta({ notes: '   ' })],
    ['notes over 10000 chars', {}, makeMeta({ notes: 'a'.repeat(10001) })],
    ['title over 200 chars', {}, makeMeta({ title: 't'.repeat(201) })],
    ['missing reporter name', {}, makeMeta({ reporter: { name: '', email: 'a@b.co' } })],
    ['invalid reporter email', {}, makeMeta({ reporter: { name: 'A', email: 'not-an-email' } })],
    ['missing anchor.absolute', {}, { ...makeMeta(), anchor: { selector: null } } as unknown as CreateIssueMeta],
    ['missing env.url', {}, makeMeta({ url: '' })],
    ['non-http env.url', {}, makeMeta({ url: 'javascript:alert(1)' })],
    ['context not an object', {}, makeMeta({ context: 'hero' as unknown as IssueContext })],
    ['context.element not an object', {}, makeMeta({ context: { page: null, element: [] as unknown as IssueContext['element'] } })],
    ['context over 16 KB', {}, makeMeta({ context: { page: { blob: 'x'.repeat(17 * 1024) }, element: null } })],
    ['invalid meta JSON', {}, '{nope'],
    ['missing meta', { meta: null }, makeMeta()],
    ['missing selection', { selection: null }, makeMeta()],
    ['missing context', { context: null }, makeMeta()],
    ['wrong image type', { selection: new File(['<svg/>'], 's.svg', { type: 'image/svg+xml' }) }, makeMeta()],
    ['content not matching the declared type', { selection: new File([JPEG], 's.png', { type: 'image/png' }) }, makeMeta()],
    ['image over 8MB', { selection: new File([big], 's.png', { type: 'image/png' }) }, makeMeta()],
  ])('400s on %s', async (_name, parts, meta) => {
    const p = await createProject();
    const res = await postIssue(p, issueForm(meta, parts));
    expect(res.status).toBe(400);
    const err = await res.json<ApiError>();
    expect(err.code).toBe('bad_request');
    expect(err.error.length).toBeGreaterThan(3);
    expect(mockTrelloState().cards.size).toBe(0);
    expect((await projectRow(p.id))!.next_number).toBe(1);
  });

  it('400s on a non-multipart body', async () => {
    const p = await createProject();
    const res = await SELF.fetch(`${BASE}/v1/issues`, { method: 'POST', headers: { ...authHeaders(p), 'Content-Type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(400);
  });

  it('marks the token revoked and cleans up R2 on a Trello 401', async () => {
    const p = await createProject({ token: 'bad-token' });
    const res = await postIssue(p, issueForm(makeMeta()));
    expect(res.status).toBe(502);
    expect(await res.json<ApiError>()).toMatchObject({ code: 'token_revoked' });
    expect((await projectRow(p.id))!.token_revoked).toBe(1);
    expect((await env.SCREENSHOTS.list({ prefix: `${p.id}/` })).objects).toHaveLength(0);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM issues WHERE project_id = ?').bind(p.id).first<{ n: number }>())!.n).toBe(0);
  });

  it('502s with trello_error on other Trello failures and cleans up R2', async () => {
    const p = await createProject({ newListId: 'list-gone' });
    const res = await postIssue(p, issueForm(makeMeta()));
    expect(res.status).toBe(502);
    expect(await res.json<ApiError>()).toMatchObject({ code: 'trello_error' });
    expect((await projectRow(p.id))!.token_revoked).toBe(0);
    expect((await env.SCREENSHOTS.list({ prefix: `${p.id}/` })).objects).toHaveLength(0);
  });
});

describe('GET /v1/issues', () => {
  it('filters by normalized page URL and hides resolved issues unless all=1', async () => {
    const p = await createProject();
    const a = await createIssue(p, makeMeta({ url: 'https://client.example/pricing/?utm_source=newsletter' }));
    const b = await createIssue(p, makeMeta({ url: 'https://CLIENT.example/pricing?gclid=123#plans' }));
    await createIssue(p, makeMeta({ url: 'https://client.example/about' }));
    await env.DB.prepare("UPDATE issues SET status = 'resolved' WHERE id = ?").bind(a.id).run();

    const res = await listIssues(p, 'https://client.example/pricing/?fbclid=zzz&annotate=key');
    expect(res.status).toBe(200);
    const { issues } = await res.json<ListIssuesResponse>();
    expect(issues.map((i) => i.id)).toEqual([b.id]);
    const [issue] = issues;
    expect(issue).toMatchObject({ number: 2, title: 'Button overlaps footer', status: 'new', reporterName: 'Jane Client', shortUrl: b.shortUrl });
    expect(issue!.anchor.absolute).toEqual({ x: 10, y: 20, width: 300, height: 80 });
    expect(issue!.screenshotUrl).toMatch(new RegExp(`^${env.PUBLIC_URL}/v1/screenshots/${p.id}/${b.id}/selection\\.png\\?exp=\\d+&sig=[\\w-]+$`));

    const all = await (await listIssues(p, 'https://client.example/pricing', true)).json<ListIssuesResponse>();
    expect(all.issues.map((i) => [i.number, i.status])).toEqual([
      [1, 'resolved'],
      [2, 'new'],
    ]);
  });

  it('shows issues in review (that is where the reporter confirms them)', async () => {
    const p = await createProject();
    const a = await createIssue(p);
    await env.DB.prepare("UPDATE issues SET status = 'review' WHERE id = ?").bind(a.id).run();
    const { issues } = await (await listIssues(p, makeMeta().env.url)).json<ListIssuesResponse>();
    expect(issues.map((i) => [i.id, i.status])).toEqual([[a.id, 'review']]);
  });

  it('hides archived issues too', async () => {
    const p = await createProject();
    const a = await createIssue(p);
    await env.DB.prepare("UPDATE issues SET status = 'archived' WHERE id = ?").bind(a.id).run();
    expect((await (await listIssues(p, makeMeta().env.url)).json<ListIssuesResponse>()).issues).toHaveLength(0);
  });

  it('only returns the calling project’s issues', async () => {
    const p = await createProject();
    const other = await createProject();
    await createIssue(other);
    expect((await (await listIssues(p, makeMeta().env.url)).json<ListIssuesResponse>()).issues).toHaveLength(0);
  });

  it('ignores the query string when the project says so', async () => {
    const p = await createProject({ ignoreQuery: true });
    await createIssue(p, makeMeta({ url: 'https://client.example/shop?page=2' }));
    const { issues } = await (await listIssues(p, 'https://client.example/shop?page=3')).json<ListIssuesResponse>();
    expect(issues).toHaveLength(1);
  });

  it('400s without a valid url', async () => {
    const p = await createProject();
    expect((await SELF.fetch(`${BASE}/v1/issues`, { headers: authHeaders(p) })).status).toBe(400);
    expect((await listIssues(p, 'not a url')).status).toBe(400);
  });
});

describe('GET /v1/issues/:id', () => {
  it('returns the issue with signed URLs and env', async () => {
    const p = await createProject();
    const created = await createIssue(p);
    const res = await getIssue(p, created.id);
    expect(res.status).toBe(200);
    const { issue } = await res.json<GetIssueResponse>();
    expect(issue).toMatchObject({ id: created.id, number: 1, status: 'new', notes: makeMeta().notes, comments: [] });
    expect(issue.env.url).toBe(makeMeta().env.url);
    expect(issue.contextUrl).toContain(`/v1/screenshots/${p.id}/${created.id}/context.jpg?exp=`);
  });

  it('heals the status from Trello after a card move', async () => {
    const p = await createProject();
    const created = await createIssue(p);
    const row = (await issueRow(created.id))!;

    const move = await SELF.fetch(`${BASE}/dev/move-card`, { method: 'POST', body: JSON.stringify({ cardId: row.trello_card_id, listId: 'list-3' }) });
    expect(move.status).toBe(200);
    expect((await (await getIssue(p, created.id)).json<GetIssueResponse>()).issue.status).toBe('resolved');
    expect((await issueRow(created.id))!.status).toBe('resolved');

    await SELF.fetch(`${BASE}/dev/move-card`, { method: 'POST', body: JSON.stringify({ cardId: row.trello_card_id, listId: 'list-2' }) });
    expect((await (await getIssue(p, created.id)).json<GetIssueResponse>()).issue.status).toBe('in_progress');

    mockTrelloState().cards.get(row.trello_card_id)!.closed = true;
    expect((await (await getIssue(p, created.id)).json<GetIssueResponse>()).issue.status).toBe('archived');
    expect((await issueRow(created.id))!.status).toBe('archived');
  });

  it('404s and removes the row when the card was deleted', async () => {
    const p = await createProject();
    const created = await createIssue(p);
    const row = (await issueRow(created.id))!;
    const del = await SELF.fetch(`${BASE}/dev/delete-card`, { method: 'POST', body: JSON.stringify({ cardId: row.trello_card_id }) });
    expect(del.status).toBe(200);
    expect(mockTrelloState().cards.has(row.trello_card_id)).toBe(false);

    const res = await getIssue(p, created.id);
    expect(res.status).toBe(404);
    expect(await res.json<ApiError>()).toMatchObject({ code: 'not_found' });
    expect(await issueRow(created.id)).toBeNull();
    expect(await env.SCREENSHOTS.get(row.screenshot_key)).toBeNull();
  });

  it('404s for another project’s issue', async () => {
    const p = await createProject();
    const other = await createProject();
    const created = await createIssue(other);
    expect((await getIssue(p, created.id)).status).toBe(404);
    expect((await getIssue(p, 'does-not-exist')).status).toBe(404);
  });

  it('serves the stored status without comments when Trello says the token is revoked', async () => {
    const p = await createProject();
    const created = await createIssue(p);
    await env.DB.prepare('UPDATE projects SET trello_token_enc = ? WHERE id = ?').bind(await encryptToken(env, 'bad-token'), p.id).run();
    const res = await getIssue(p, created.id);
    expect(res.status).toBe(200);
    const { issue } = await res.json<GetIssueResponse>();
    expect(issue.status).toBe('new');
    expect(issue.comments).toEqual([]);
    expect((await projectRow(p.id))!.token_revoked).toBe(1);
  });
});

describe('comments', () => {
  const postComment = (p: TestProject, id: string, body: unknown) =>
    SELF.fetch(`${BASE}/v1/issues/${id}/comments`, { method: 'POST', headers: { ...authHeaders(p), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('round-trips widget and Trello comments', async () => {
    const p = await createProject();
    const created = await createIssue(p);
    const cardId = (await issueRow(created.id))!.trello_card_id;

    const res = await postComment(p, created.id, { text: 'Still broken on **mobile**.\nSecond line', reporter: { name: 'Jane Client', email: 'jane@client.example' } });
    expect(res.status).toBe(201);
    const { comment } = await res.json<AddCommentResponse>();
    expect(comment).toMatchObject({ author: 'Jane Client', text: 'Still broken on **mobile**.\nSecond line', viaWidget: true });
    expect(mockTrelloState().comments.get(cardId)![0]!.data.text).toBe('**Jane Client** (via widget): Still broken on **mobile**.\nSecond line');

    // A teammate replies in Trello.
    await trello(env, MOCK_TOKEN).addComment(cardId, 'Fixed in the latest deploy.');

    const { issue } = await (await getIssue(p, created.id)).json<GetIssueResponse>();
    expect(issue.comments.map(({ author, text, viaWidget, via }) => ({ author, text, viaWidget, via }))).toEqual([
      { author: 'Jane Client', text: 'Still broken on **mobile**.\nSecond line', viaWidget: true, via: 'widget' },
      { author: 'Mock User', text: 'Fixed in the latest deploy.', viaWidget: false, via: 'trello' },
    ]);
    expect(issue.comments[0]!.id).toBe(comment.id);
  });

  it.each<[string, unknown]>([
    ['empty text', { text: '  ', reporter: { name: 'A', email: 'a@b.co' } }],
    ['text over 5000 chars', { text: 'a'.repeat(5001), reporter: { name: 'A', email: 'a@b.co' } }],
    ['missing reporter', { text: 'hi' }],
    ['bad email', { text: 'hi', reporter: { name: 'A', email: 'nope' } }],
    ['non-object body', 'hello'],
  ])('400s on %s', async (_name, body) => {
    const p = await createProject();
    const created = await createIssue(p);
    const res = await postComment(p, created.id, body);
    expect(res.status).toBe(400);
    expect(await res.json<ApiError>()).toMatchObject({ code: 'bad_request' });
  });

  it('404s for an unknown issue', async () => {
    const p = await createProject();
    expect((await postComment(p, 'nope', { text: 'hi', reporter: { name: 'A', email: 'a@b.co' } })).status).toBe(404);
  });
});

describe('confirm / reopen', () => {
  const reporter = { name: 'Jane Client', email: 'jane@client.example' };
  const act = (p: TestProject, id: string, action: 'confirm' | 'reopen', body: unknown) =>
    SELF.fetch(`${BASE}/v1/issues/${id}/${action}`, { method: 'POST', headers: { ...authHeaders(p), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const setStatus = (id: string, status: string) => env.DB.prepare('UPDATE issues SET status = ? WHERE id = ?').bind(status, id).run();
  const lastComment = (cardId: string) => mockTrelloState().comments.get(cardId)?.at(-1)?.data.text;

  it('confirms an issue in review: card to the done list, status resolved', async () => {
    const p = await createProject();
    const created = await createIssue(p);
    const cardId = (await issueRow(created.id))!.trello_card_id;
    await setStatus(created.id, 'review');

    const res = await act(p, created.id, 'confirm', { reporter });
    expect(res.status).toBe(200);
    const { issue } = await res.json<IssueActionResponse>();
    expect(issue).toMatchObject({ id: created.id, number: 1, status: 'resolved' });
    expect(mockTrelloState().cards.get(cardId)!.idList).toBe('list-3');
    expect((await issueRow(created.id))!.status).toBe('resolved');
    expect(lastComment(cardId)).toBe('**Jane Client** (via widget): ✅ Confirmed fixed');
  });

  it('only confirms from review', async () => {
    const p = await createProject();
    const created = await createIssue(p);
    for (const status of ['new', 'in_progress', 'resolved']) {
      await setStatus(created.id, status);
      const res = await act(p, created.id, 'confirm', { reporter });
      expect(res.status).toBe(409);
      const err = await res.json<ApiError>();
      expect(err.code).toBe('bad_request');
      expect(err.error).toContain(status);
    }
    expect(mockTrelloState().comments.size).toBe(0);
  });

  it('400s confirming without a done list or a reporter', async () => {
    const p = await createProject();
    const created = await createIssue(p);
    await setStatus(created.id, 'review');
    expect((await act(p, created.id, 'confirm', {})).status).toBe(400);
    await env.DB.prepare("UPDATE projects SET done_list_ids = '[]' WHERE id = ?").bind(p.id).run();
    const res = await act(p, created.id, 'confirm', { reporter });
    expect(res.status).toBe(400);
    expect(await res.json<ApiError>()).toMatchObject({ code: 'bad_request' });
  });

  it.each(['review', 'resolved'])('reopens from %s: card to the new list with a note', async (from) => {
    const p = await createProject();
    const created = await createIssue(p);
    const cardId = (await issueRow(created.id))!.trello_card_id;
    mockMoveCard(cardId, 'list-3');
    await setStatus(created.id, from);

    const res = await act(p, created.id, 'reopen', { reporter, text: '  Still overlaps on iPhone.  ' });
    expect(res.status).toBe(200);
    expect((await res.json<IssueActionResponse>()).issue.status).toBe('new');
    expect(mockTrelloState().cards.get(cardId)!.idList).toBe('list-1');
    expect((await issueRow(created.id))!.status).toBe('new');
    expect(lastComment(cardId)).toBe('**Jane Client** (via widget): ❌ Still broken: Still overlaps on iPhone.');
  });

  it('refuses to reopen a new issue and validates the text', async () => {
    const p = await createProject();
    const created = await createIssue(p);
    expect((await act(p, created.id, 'reopen', { reporter, text: 'x' })).status).toBe(409);
    await setStatus(created.id, 'review');
    expect((await act(p, created.id, 'reopen', { reporter })).status).toBe(400);
    expect((await act(p, created.id, 'reopen', { reporter, text: 'a'.repeat(5001) })).status).toBe(400);
    expect((await act(p, 'nope', 'reopen', { reporter, text: 'x' })).status).toBe(404);
  });

  it('502s with token_revoked when Trello rejects the token', async () => {
    const p = await createProject();
    const created = await createIssue(p);
    await setStatus(created.id, 'review');
    await env.DB.prepare('UPDATE projects SET trello_token_enc = ? WHERE id = ?').bind(await encryptToken(env, 'bad-token'), p.id).run();
    const res = await act(p, created.id, 'confirm', { reporter });
    expect(res.status).toBe(502);
    expect(await res.json<ApiError>()).toMatchObject({ code: 'token_revoked' });
    expect((await issueRow(created.id))!.status).toBe('review');
  });
});

describe('screenshots', () => {
  async function screenshotFor(p: TestProject) {
    await createIssue(p);
    const { issues } = await (await listIssues(p, makeMeta().env.url)).json<ListIssuesResponse>();
    return issues[0]!.screenshotUrl;
  }

  it('serves a validly signed URL without auth headers', async () => {
    const p = await createProject();
    const res = await fetchSigned(await screenshotFor(p));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=3600');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
  });

  it('403s on a tampered signature', async () => {
    const p = await createProject();
    const url = new URL(await screenshotFor(p));
    const sig = url.searchParams.get('sig')!;
    url.searchParams.set('sig', `${sig[0] === 'A' ? 'B' : 'A'}${sig.slice(1)}`);
    const res = await fetchSigned(url.toString());
    expect(res.status).toBe(403);
  });

  it('403s when the signature is reused for another key', async () => {
    const p = await createProject();
    const url = new URL(await screenshotFor(p));
    url.pathname = url.pathname.replace('selection.png', 'context.jpg');
    expect((await fetchSigned(url.toString())).status).toBe(403);
  });

  it('403s on an extended expiry', async () => {
    const p = await createProject();
    const url = new URL(await screenshotFor(p));
    url.searchParams.set('exp', String(Number(url.searchParams.get('exp')) + 3600));
    expect((await fetchSigned(url.toString())).status).toBe(403);
  });

  it('403s on an expired URL', async () => {
    const p = await createProject();
    const created = await createIssue(p);
    const key = (await issueRow(created.id))!.screenshot_key;
    expect((await fetchSigned(await signedScreenshotUrl(env, key, -10))).status).toBe(403);
    expect((await fetchSigned(await signedScreenshotUrl(env, key, 60))).status).toBe(200);
  });

  it('403s without a signature', async () => {
    const p = await createProject();
    const url = new URL(await screenshotFor(p));
    expect((await SELF.fetch(`${BASE}${url.pathname}`)).status).toBe(403);
  });
});

describe('GET /v1/project', () => {
  it('reports a connected project', async () => {
    const p = await createProject();
    await createIssue(p);
    await createIssue(p);
    const res = await SELF.fetch(`${BASE}/v1/project`, { headers: authHeaders(p) });
    expect(res.status).toBe(200);
    expect(await res.json<ProjectStatus>()).toEqual({
      connected: true,
      name: 'Client site',
      boardName: 'Mock Board',
      boardUrl: 'https://trello.com/b/mock1/mock-board',
      issueCount: 2,
    });
  });

  it('reports and flags a revoked token, and clears the flag once the token works', async () => {
    const p = await createProject({ token: 'bad-token' });
    const res = await SELF.fetch(`${BASE}/v1/project`, { headers: authHeaders(p) });
    expect(await res.json<ProjectStatus>()).toMatchObject({ connected: false, reason: 'token_revoked' });
    expect((await projectRow(p.id))!.token_revoked).toBe(1);

    await env.DB.prepare('UPDATE projects SET trello_token_enc = ? WHERE id = ?').bind(await encryptToken(env, MOCK_TOKEN), p.id).run();
    const again = await (await SELF.fetch(`${BASE}/v1/project`, { headers: authHeaders(p) })).json<ProjectStatus>();
    expect(again.connected).toBe(true);
    expect(again.reason).toBeUndefined();
    expect((await projectRow(p.id))!.token_revoked).toBe(0);
  });
});

describe('/dev', () => {
  it('seeds the dev project idempotently and works end to end', async () => {
    const seeded = await (await SELF.fetch(`${BASE}/dev/seed`, { method: 'POST' })).json<{ projectKey: string; accessKey: string }>();
    expect(seeded).toMatchObject({ projectKey: 'dev-project', accessKey: 'dev-access' });
    expect((await SELF.fetch(`${BASE}/dev/seed`)).status).toBe(200);
    const rows = await env.DB.prepare("SELECT * FROM projects WHERE public_key = 'dev-project'").all<ProjectRow>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]).toMatchObject({ new_list_id: 'list-1', done_list_ids: '["list-3"]', trello_board_name: 'Mock Board' });

    const dev = { id: rows.results[0]!.id, publicKey: 'dev-project', accessKey: 'dev-access' };
    const res = await SELF.fetch(`${BASE}/v1/issues`, {
      method: 'POST',
      headers: { [HEADER_PROJECT]: dev.publicKey, [HEADER_ACCESS]: dev.accessKey, Origin: 'http://localhost:5173' },
      body: issueForm(makeMeta()),
    });
    expect(res.status).toBe(201);
  });

  it('exposes the mock state as JSON', async () => {
    const p = await createProject();
    await createIssue(p);
    const state = await (await SELF.fetch(`${BASE}/dev/state`)).json<{ cards: { name: string; attachments: { name: string; cover: boolean }[] }[]; lists: unknown[] }>();
    expect(state.lists).toHaveLength(3);
    expect(state.cards).toHaveLength(1);
    expect(state.cards[0]!.name).toBe('#1 Button overlaps footer');
    expect(state.cards[0]!.attachments.map((a) => a.cover)).toEqual([true, false]);
  });

  it('404s move-card for an unknown card', async () => {
    const res = await SELF.fetch(`${BASE}/dev/move-card`, { method: 'POST', body: JSON.stringify({ cardId: 'nope', listId: 'list-3' }) });
    expect(res.status).toBe(404);
  });
});

// Trello connect flow, run in a popup (or standalone at <worker>/connect):
//   GET  /connect            → session + "Log in with Trello"
//   GET  /connect/callback   → reads #token, POSTs it to /connect/session
//   POST /connect/session    → verifies the token (and workspace), stores it encrypted on the session
//   GET  /connect/boards     → board picker;  GET /connect/lists → lists + smart defaults (JSON)
//   POST /connect/boards     → creates "Website feedback – {site}" with New / In progress / Done
//   POST /connect/finish     → creates or updates the project, registers the board webhook
// Sessions are bound to the browser that started them by a short-lived cookie, so a session id
// lured into someone else's browser (or a token lured into ours) can't complete the flow.

import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { ConnectResultMessage } from '@annotate/shared';
import type { AppEnv, Env } from '../env';
import { nowIso, randomId, type ConnectSessionRow, type ProjectRow } from '../db';
import { authorizeUrl, trello, TrelloError, type Trello, type TrelloBoard } from '../trello';
import { decryptToken, encryptToken, safeEqual, trelloForProject } from '../crypto';
import { BoardsPage, CallbackPage, StartPage } from '../connect/pages';
import { ConnectError, sendError, sendPage } from '../connect/render';
import { cleanLabel, defaultLists, hostOf, parseHttpUrl, parseOrigin, publicBase, webhookCallbackUrl } from '../connect/util';

type Ctx = Context<AppEnv>;

export interface ConnectListsResponse {
  board: { id: string; name: string; url: string };
  lists: { id: string; name: string }[];
  defaults: { newListId: string | null; doneListId: string | null };
}

export interface ConnectFinishResponse {
  message: ConnectResultMessage;
  /** The <script> tag to paste into a non-WP site. */
  snippet: string;
  /** `${siteUrl}?annotate=${accessKey}`: opening it once turns on feedback mode in that browser. */
  activationUrl: string | null;
}

const SESSION_TTL_MS = 15 * 60 * 1000;
const NEW_BOARD_LISTS = ['New', 'In progress', 'Done'] as const;
const cookieName = (sessionId: string) => `acs_${sessionId}`;

const EXPIRED = 'Connecting has to be finished within 15 minutes. Close this window and click Connect again.';

const app = new Hono<AppEnv>();

app.use('*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
});

app.onError((err, c) => {
  // Pages get a friendly HTML error; fetch() calls from the pages get ApiError JSON.
  const asPage = c.req.method === 'GET' && !c.req.path.endsWith('/lists');
  if (err instanceof ConnectError) return sendError(c, err, asPage);
  if (err instanceof TrelloError) {
    console.error('connect: Trello error:', err.message);
    const e = err.revoked
      ? new ConnectError(401, 'Your Trello login has expired. Close this window and click Connect again.', 'token_revoked', 'Trello login expired')
      : new ConnectError(502, 'Trello didn’t respond as expected. Please try again in a moment.', 'trello_error', 'Trello is having trouble');
    return sendError(c, e, asPage);
  }
  console.error('connect: unexpected error:', err);
  return sendError(c, new ConnectError(500, 'Something went wrong on our side. Please try again.', 'internal'), asPage);
});

// ① Start --------------------------------------------------------------------

app.get('/', async (c) => {
  const base = publicBase(c.env);
  // The session cookie must live on the host Trello sends the user back to.
  const here = new URL(c.req.url);
  if (here.origin !== new URL(base).origin) return c.redirect(`${base}${here.pathname}${here.search}`, 302);

  const q = c.req.query();
  let openerOrigin: string | null = null;
  if (q.origin) {
    openerOrigin = parseOrigin(q.origin);
    if (!openerOrigin) throw new ConnectError(400, 'The site that opened this window sent an invalid address. Update the Annotate plugin and try again.', 'bad_request', 'Broken connect link');
  }
  const siteUrl = parseHttpUrl(q.site)?.href ?? null;
  let siteName = cleanLabel(q.name);

  let project: ProjectRow | null = null;
  if (q.project || q.access) {
    if (q.project && q.access) {
      project = await c.env.DB.prepare('SELECT * FROM projects WHERE public_key = ?').bind(q.project).first<ProjectRow>();
    }
    if (!project || !safeEqual(project.access_key, q.access ?? '')) {
      throw new ConnectError(404, 'We couldn’t find the project to reconnect. Disconnect in your site settings, then connect again.', 'not_found', 'Project not found');
    }
    siteName ??= project.name;
  }

  const id = randomId();
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM connect_sessions WHERE expires_at < ?').bind(Date.now()),
    c.env.DB.prepare('INSERT INTO connect_sessions (id, opener_origin, site_name, site_url, project_id, expires_at) VALUES (?, ?, ?, ?, ?, ?)').bind(
      id,
      openerOrigin,
      siteName,
      siteUrl,
      project?.id ?? null,
      Date.now() + SESSION_TTL_MS,
    ),
  ]);
  setCookie(c, cookieName(id), '1', {
    path: '/connect',
    httpOnly: true,
    sameSite: 'Lax',
    secure: base.startsWith('https:'),
    maxAge: SESSION_TTL_MS / 1000,
  });

  const loginUrl = authorizeUrl(c.env, callbackUrl(c.env, id));
  return sendPage(c, (nonce) =>
    StartPage({
      nonce,
      siteName: siteName ?? hostOf(siteUrl) ?? hostOf(openerOrigin),
      openerHost: hostOf(openerOrigin),
      authorizeUrl: loginUrl,
      reconnect: !!project,
    }),
  );
});

// ② Back from Trello ----------------------------------------------------------

app.get('/callback', async (c) => {
  const s = await loadSession(c, c.req.query('s'));
  const retryUrl = authorizeUrl(c.env, callbackUrl(c.env, s.id));
  return sendPage(c, (nonce) => CallbackPage({ nonce, s: s.id, retryUrl }));
});

app.post('/session', async (c) => {
  const body = await readJson(c);
  const s = await loadSession(c, body.s);
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  const rejected = new ConnectError(401, 'Trello didn’t accept that login. Please try again.', 'unauthorized', 'Trello login didn’t work');
  if (!token || token.length > 512 || !/^[\w.-]+$/.test(token)) throw rejected;

  let member;
  try {
    member = await trello(c.env, token).me();
  } catch (e) {
    if (e instanceof TrelloError && (e.status === 400 || e.status === 401)) throw rejected;
    throw e;
  }
  const org = allowedOrg(c.env);
  if (org && !(member.idOrganizations ?? []).includes(org)) {
    throw new ConnectError(
      403,
      'This Trello account isn’t in the allowed workspace. Log in with the account you use for work, or ask an admin to add you to the workspace.',
      'forbidden',
      'This account can’t connect',
    );
  }

  await c.env.DB.prepare('UPDATE connect_sessions SET trello_token_enc = ?, trello_member_id = ? WHERE id = ?')
    .bind(await encryptToken(c.env, token), member.id, s.id)
    .run();
  return c.json({ ok: true, member: { username: member.username, fullName: member.fullName } });
});

// ③ Board picker --------------------------------------------------------------

app.get('/boards', async (c) => {
  const s = await loadSession(c, c.req.query('s'), { needToken: true });
  const t = await sessionTrello(c.env, s);
  const boards = (await visibleBoards(c.env, t)).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const project = s.project_id ? await getProject(c.env, s.project_id) : null;

  let siteUrl = s.site_url;
  if (!siteUrl && project) siteUrl = parseStringArray(project.allowed_origins)[0] ?? null;

  return sendPage(c, (nonce) =>
    BoardsPage({
      nonce,
      s: s.id,
      siteName: s.site_name ?? hostOf(s.site_url) ?? hostOf(s.opener_origin),
      openerOrigin: s.opener_origin,
      openerHost: hostOf(s.opener_origin),
      boards: boards.map(({ id, name }) => ({ id, name })),
      newBoardName: newBoardName(s),
      nameFromSite: !s.site_name && !s.opener_origin,
      askSiteUrl: !s.opener_origin,
      siteUrl,
      currentBoardId: project?.trello_board_id ?? null,
    }),
  );
});

app.get('/lists', async (c) => {
  const s = await loadSession(c, c.req.query('s'), { needToken: true });
  const t = await sessionTrello(c.env, s);
  const boardId = c.req.query('board') ?? '';
  const board = (await visibleBoards(c.env, t)).find((b) => b.id === boardId);
  if (!board) throw new ConnectError(404, 'That board isn’t available to this Trello account.', 'not_found');

  const lists = (await t.lists(board.id)).sort((a, b) => a.pos - b.pos).map(({ id, name }) => ({ id, name }));
  let defaults = defaultLists(lists);
  // Reconnecting to the same board: keep the lists the project already uses.
  const project = s.project_id ? await getProject(c.env, s.project_id) : null;
  if (project && project.trello_board_id === board.id) {
    const ids = new Set(lists.map((l) => l.id));
    const done = parseStringArray(project.done_list_ids).find((id) => ids.has(id));
    if (ids.has(project.new_list_id) && done && done !== project.new_list_id) defaults = { newListId: project.new_list_id, doneListId: done };
  }
  return c.json<ConnectListsResponse>({ board: boardInfo(board), lists, defaults });
});

app.post('/boards', async (c) => {
  const body = await readJson(c);
  const s = await loadSession(c, body.s, { needToken: true });
  const t = await sessionTrello(c.env, s);
  // Standalone users may have typed their site URL already; name the board after it.
  const board = await t.createBoard(newBoardName(s, parseHttpUrl(body.siteUrl)?.href), allowedOrg(c.env) || null);
  const lists: { id: string; name: string }[] = [];
  // One at a time with explicit positions, so the order is guaranteed.
  for (const [i, name] of NEW_BOARD_LISTS.entries()) {
    const list = await t.createList(board.id, name, (i + 1) * 1024);
    lists.push({ id: list.id, name: list.name });
  }
  return c.json<ConnectListsResponse>({
    board: boardInfo(board),
    lists,
    defaults: { newListId: lists[0]?.id ?? null, doneListId: lists[lists.length - 1]?.id ?? null },
  });
});

// ④ Finish --------------------------------------------------------------------

app.post('/finish', async (c) => {
  const env = c.env;
  const body = await readJson(c);
  const s = await loadSession(c, body.s, { needToken: true });

  const boardId = typeof body.boardId === 'string' ? body.boardId : '';
  const newListId = typeof body.newListId === 'string' ? body.newListId : '';
  const doneListIds = Array.isArray(body.doneListIds) ? [...new Set(body.doneListIds.filter((v): v is string => typeof v === 'string' && !!v))] : [];
  if (!boardId || !newListId || doneListIds.length === 0) throw new ConnectError(400, 'Choose a board and both lists first.', 'bad_request');
  if (doneListIds.includes(newListId)) throw new ConnectError(400, 'Pick a different list for resolved issues than for new ones.', 'bad_request');

  let siteUrl: URL | null = null;
  if (body.siteUrl !== undefined && body.siteUrl !== null && body.siteUrl !== '') {
    siteUrl = parseHttpUrl(body.siteUrl);
    if (!siteUrl) throw new ConnectError(400, 'Enter your site’s full address, like https://example.com.', 'bad_request');
  }
  if (!s.opener_origin && !s.project_id && !siteUrl) throw new ConnectError(400, 'Enter your site’s address so we know where feedback comes from.', 'bad_request');

  const t = await sessionTrello(env, s);
  const board = (await visibleBoards(env, t)).find((b) => b.id === boardId);
  if (!board) throw new ConnectError(400, 'That board isn’t available to this Trello account.', 'bad_request');
  const listIds = new Set((await t.lists(board.id)).map((l) => l.id));
  if (!listIds.has(newListId) || !doneListIds.every((id) => listIds.has(id))) {
    throw new ConnectError(400, 'Those lists aren’t on this board anymore. Pick the board again.', 'bad_request');
  }

  const existing = s.project_id ? await getProject(env, s.project_id) : null;
  if (s.project_id && !existing) throw new ConnectError(410, 'The project you were reconnecting no longer exists. Connect again from your site settings.', 'not_found');

  // Webhook: replace the old one on reconnect. Real Trello can't reach localhost, so a failure is not fatal.
  const oldGone = existing ? await dropWebhook(env, existing, t) : true;
  let webhookId: string | null = null;
  try {
    webhookId = (await t.createWebhook(webhookCallbackUrl(env), board.id, 'Annotate')).id;
  } catch (e) {
    console.warn('connect: could not register the Trello webhook; status will only refresh when an issue is opened.', e instanceof Error ? e.message : e);
    // Most likely a duplicate of the old webhook we couldn't delete: it still points at us, so keep it.
    if (existing && !oldGone && existing.trello_board_id === board.id) webhookId = existing.webhook_id;
  }

  const origins = new Set(existing ? parseStringArray(existing.allowed_origins) : []);
  for (const o of [s.opener_origin, siteUrl?.origin, parseHttpUrl(s.site_url)?.origin]) if (o) origins.add(o);

  const now = nowIso();
  const publicKey = existing?.public_key ?? `pk_${randomId()}`;
  const accessKey = existing?.access_key ?? `ak_${randomId(24)}`;
  const common = [s.trello_token_enc, s.trello_member_id ?? '', board.id, board.name, board.url, newListId, JSON.stringify(doneListIds), webhookId] as const;

  const write = existing
    ? env.DB.prepare(
        `UPDATE projects SET allowed_origins = ?, trello_token_enc = ?, trello_member_id = ?, trello_board_id = ?, trello_board_name = ?,
           trello_board_url = ?, new_list_id = ?, done_list_ids = ?, webhook_id = ?, token_revoked = 0, updated_at = ? WHERE id = ?`,
      ).bind(JSON.stringify([...origins]), ...common, now, existing.id)
    : env.DB.prepare(
        `INSERT INTO projects (id, name, public_key, access_key, allowed_origins, trello_token_enc, trello_member_id, trello_board_id,
           trello_board_name, trello_board_url, new_list_id, done_list_ids, webhook_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        randomId(),
        s.site_name || hostOf(siteUrl?.href) || hostOf(s.site_url) || hostOf(s.opener_origin) || 'My site',
        publicKey,
        accessKey,
        JSON.stringify([...origins]),
        ...common,
        now,
        now,
      );
  await env.DB.batch([write, env.DB.prepare('DELETE FROM connect_sessions WHERE id = ?').bind(s.id)]);
  deleteCookie(c, cookieName(s.id), { path: '/connect', secure: publicBase(env).startsWith('https:') });

  const base = publicBase(env);
  const activationBase = siteUrl?.href ?? s.site_url ?? s.opener_origin ?? [...origins][0] ?? null;
  let activationUrl: string | null = null;
  if (activationBase) {
    const u = new URL(activationBase);
    u.searchParams.set('annotate', accessKey);
    activationUrl = u.href;
  }

  return c.json<ConnectFinishResponse>({
    message: { type: 'annotate:connected', projectKey: publicKey, accessKey, boardName: board.name, boardUrl: board.url, endpoint: base },
    snippet: `<script src="${base}/widget.js" data-endpoint="${base}" data-project="${publicKey}" defer></script>`,
    activationUrl,
  });
});

export default app;

// Helpers ---------------------------------------------------------------------

const callbackUrl = (env: Env, sessionId: string) => `${publicBase(env)}/connect/callback?s=${encodeURIComponent(sessionId)}`;

const allowedOrg = (env: Env) => (env.ALLOWED_TRELLO_ORG ?? '').trim();

function newBoardName(s: ConnectSessionRow, siteUrl?: string | null) {
  return `Website feedback – ${s.site_name || hostOf(siteUrl) || hostOf(s.site_url) || hostOf(s.opener_origin) || 'My site'}`;
}

const boardInfo = (b: TrelloBoard) => ({ id: b.id, name: b.name, url: b.url });

/** JSON string[] column → array (tolerates bad data). */
function parseStringArray(json: string): string[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

async function readJson(c: Ctx): Promise<Record<string, unknown>> {
  const body: unknown = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ConnectError(400, 'Invalid request.', 'bad_request');
  return body as Record<string, unknown>;
}

async function loadSession(c: Ctx, id: unknown, opts: { needToken?: boolean } = {}): Promise<ConnectSessionRow & { trello_token_enc: string }> {
  if (typeof id !== 'string' || !/^[\w-]{8,64}$/.test(id)) {
    throw new ConnectError(400, 'This connect link is incomplete. Close this window and click Connect again.', 'bad_request', 'Broken connect link');
  }
  const row = await c.env.DB.prepare('SELECT * FROM connect_sessions WHERE id = ?').bind(id).first<ConnectSessionRow>();
  if (!row || row.expires_at <= Date.now()) {
    if (row) await c.env.DB.prepare('DELETE FROM connect_sessions WHERE id = ?').bind(id).run();
    throw new ConnectError(410, EXPIRED, 'expired', 'This window has expired');
  }
  if (getCookie(c, cookieName(id)) !== '1') {
    throw new ConnectError(
      403,
      'We couldn’t confirm this is the browser that started connecting. Make sure cookies are allowed, then close this window and click Connect again.',
      'forbidden',
      'Start again from your site',
    );
  }
  if (opts.needToken && !row.trello_token_enc) throw new ConnectError(401, 'Log in with Trello first.', 'unauthorized', 'Not logged in yet');
  return row as ConnectSessionRow & { trello_token_enc: string };
}

async function sessionTrello(env: Env, s: { trello_token_enc: string | null }): Promise<Trello> {
  if (!s.trello_token_enc) throw new ConnectError(401, 'Log in with Trello first.', 'unauthorized', 'Not logged in yet');
  return trello(env, await decryptToken(env, s.trello_token_enc));
}

/** The member's open boards, limited to the allowed workspace when one is configured. */
async function visibleBoards(env: Env, t: Trello): Promise<TrelloBoard[]> {
  const org = allowedOrg(env);
  const boards = await t.boards();
  return org ? boards.filter((b) => b.idOrganization === org) : boards;
}

function getProject(env: Env, id: string) {
  return env.DB.prepare('SELECT * FROM projects WHERE id = ?').bind(id).first<ProjectRow>();
}

/** Delete a project's current webhook, trying its own token first. Returns false if it may still exist. */
async function dropWebhook(env: Env, project: ProjectRow, fresh: Trello): Promise<boolean> {
  if (!project.webhook_id) return true;
  const clients: Trello[] = [];
  try {
    clients.push(await trelloForProject(env, project));
  } catch {
    /* undecryptable token: fall through to the new one */
  }
  clients.push(fresh);
  for (const t of clients) {
    try {
      await t.deleteWebhook(project.webhook_id);
      return true;
    } catch {
      /* revoked token or already gone; try the next */
    }
  }
  return false;
}

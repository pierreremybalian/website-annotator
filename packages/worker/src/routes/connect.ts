// Trello connect flow, run in a popup (or standalone at <worker>/connect, or for the CLI at /connect?cli=<id>):
//   GET  /connect            → session + "Log in with Trello"
//   GET  /connect/callback   → reads #token, POSTs it to /connect/session
//   POST /connect/session    → verifies the token (and workspace), stores it encrypted on the session
//   GET  /connect/boards     → board picker (CLI mode: also the projects to link);  GET /connect/lists → lists + smart defaults (JSON)
//   POST /connect/boards     → creates "Website feedback – {site}" with New / In progress / Ready for review / Done
//   POST /connect/finish     → creates or updates the project, registers the board webhook (CLI mode: hands it to the terminal)
//   POST /connect/link       → CLI mode only: hands an existing project on one of the member's boards to the terminal
// Sessions are bound to the browser that started them by a short-lived cookie, so a session id
// lured into someone else's browser (or a token lured into ours) can't complete the flow.
// CLI mode never sends keys to the browser: the result is stored encrypted on the CLI session,
// which the terminal polls (routes/cli.ts).

import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { ConnectResultMessage } from '@annotate/shared';
import type { AppEnv, Env } from '../env';
import { nowIso, randomId, type CliSessionRow, type ConnectSessionRow, type ProjectRow } from '../db';
import { authorizeUrl, trello, TrelloError, type Trello, type TrelloBoard } from '../trello';
import { decryptToken, encryptToken, safeEqual, trelloForProject } from '../crypto';
import { BoardsPage, CallbackPage, StartPage, type LinkableProject } from '../connect/pages';
import { ConnectError, sendError, sendPage } from '../connect/render';
import { cliHandoff, cliSessionOpen, getCliSession, isSessionId } from '../connect/cli-session';
import {
  cleanLabel,
  CREATE_REVIEW_LIST,
  defaultLists,
  defaultReviewList,
  hostOf,
  parseHttpUrl,
  parseOrigin,
  posBefore,
  publicBase,
  REVIEW_LIST_NAME,
  webhookCallbackUrl,
  type ListDefaults,
} from '../connect/util';
import { mayConnect } from '../owner';

type Ctx = Context<AppEnv>;

export interface ConnectListsResponse {
  board: { id: string; name: string; url: string };
  lists: { id: string; name: string }[];
  defaults: ListDefaults;
}

export interface ConnectFinishResponse {
  message: ConnectResultMessage;
  /** The <script> tag to paste into a non-WP site. */
  snippet: string;
  /** `${siteUrl}?annotate=${accessKey}`: opening it once turns on feedback mode in that browser. */
  activationUrl: string | null;
}

/** /connect/finish and /connect/link in CLI mode. The keys went to the terminal, not here. */
export interface ConnectCliDoneResponse {
  cli: { action: 'connected' | 'linked'; projectName: string; boardName: string; boardUrl: string };
}

const SESSION_TTL_MS = 15 * 60 * 1000;
const NEW_BOARD_LISTS = ['New', 'In progress', REVIEW_LIST_NAME, 'Done'] as const;
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
  if (q.cli !== undefined) return startCli(c, q.cli);

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

  const id = await createSession(c, { openerOrigin, siteName, siteUrl, projectId: project?.id ?? null, cliSessionId: null });
  const loginUrl = authorizeUrl(c.env, callbackUrl(c.env, id));
  return sendPage(c, (nonce) =>
    StartPage({
      nonce,
      siteName: siteName ?? hostOf(siteUrl) ?? hostOf(openerOrigin),
      openerHost: hostOf(openerOrigin),
      authorizeUrl: loginUrl,
      reconnect: !!project,
      cli: null,
    }),
  );
});

/** /connect?cli=<id>: the terminal opened this page. No opener; the site URL comes from the CLI. */
async function startCli(c: Ctx, cliId: string) {
  const cli = await getCliSession(c.env, cliId);
  if (!cliSessionOpen(cli)) throw cliGone(cli);
  const id = await createSession(c, { openerOrigin: null, siteName: null, siteUrl: cli.site_url, projectId: null, cliSessionId: cli.id }, cli.expires_at);
  const loginUrl = authorizeUrl(c.env, callbackUrl(c.env, id));
  return sendPage(c, (nonce) =>
    StartPage({ nonce, siteName: hostOf(cli.site_url), openerHost: null, authorizeUrl: loginUrl, reconnect: false, cli: { label: cli.label } }),
  );
}

/** Insert a connect session and bind it to this browser with the session cookie. */
async function createSession(
  c: Ctx,
  f: { openerOrigin: string | null; siteName: string | null; siteUrl: string | null; projectId: string | null; cliSessionId: string | null },
  notAfter = Infinity,
) {
  const id = randomId();
  const now = Date.now();
  const expiresAt = Math.min(now + SESSION_TTL_MS, notAfter);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM connect_sessions WHERE expires_at < ?').bind(now),
    c.env.DB.prepare(
      'INSERT INTO connect_sessions (id, opener_origin, cli_session_id, site_name, site_url, project_id, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind(id, f.openerOrigin, f.cliSessionId, f.siteName, f.siteUrl, f.projectId, expiresAt),
  ]);
  setCookie(c, cookieName(id), '1', {
    path: '/connect',
    httpOnly: true,
    sameSite: 'Lax',
    secure: publicBase(c.env).startsWith('https:'),
    maxAge: Math.max(1, Math.round((expiresAt - now) / 1000)),
  });
  return id;
}

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
  if (!(await mayConnect(c.env, member))) {
    throw new ConnectError(
      403,
      'This Trello account isn’t part of the workspace Annotate is set up for. Log in with your work account, or ask the owner to add you to their Trello workspace.',
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
  const cli = s.cli_session_id ? await openCliSession(c.env, s.cli_session_id) : null;
  const t = await sessionTrello(c.env, s);
  const boards = (await visibleBoards(c.env, t)).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const project = s.project_id ? await getProject(c.env, s.project_id) : null;

  let siteUrl = s.site_url;
  if (!siteUrl && project) siteUrl = parseStringArray(project.allowed_origins)[0] ?? null;
  const projects = cli ? await linkableProjects(c.env, boards) : [];

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
      cli: cli ? { mode: cli.mode, label: cli.label, projects } : null,
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
    if (ids.has(project.new_list_id) && done && done !== project.new_list_id) {
      const r = project.review_list_id;
      const review = r && ids.has(r) && r !== project.new_list_id && r !== done ? r : defaultReviewList(lists, project.new_list_id, done);
      defaults = { newListId: project.new_list_id, doneListId: done, reviewListId: review };
    }
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
    defaults: {
      newListId: lists[0]?.id ?? null,
      doneListId: lists[lists.length - 1]?.id ?? null,
      reviewListId: lists.find((l) => l.name === REVIEW_LIST_NAME)?.id ?? null,
    },
  });
});

// ③b Link an existing project (CLI mode) ---------------------------------------

app.post('/link', async (c) => {
  const env = c.env;
  const body = await readJson(c);
  const s = await loadSession(c, body.s, { needToken: true });
  if (!s.cli_session_id) throw new ConnectError(400, 'Linking a project only works when you connect from the terminal.', 'bad_request');
  const cli = await openCliSession(env, s.cli_session_id);

  const project = typeof body.projectId === 'string' && body.projectId ? await getProject(env, body.projectId) : null;
  if (!project) throw new ConnectError(404, 'That project doesn’t exist anymore. Reload this page and pick another.', 'not_found');
  const t = await sessionTrello(env, s);
  const board = (await visibleBoards(env, t)).find((b) => b.id === project.trello_board_id);
  if (!board) throw new ConnectError(403, 'Your Trello account can’t see that project’s board, so you can’t link it.', 'forbidden', 'No access to this project');

  const handoff = await cliHandoff(env, cli, project.id, {
    endpoint: publicBase(env),
    projectKey: project.public_key,
    accessKey: project.access_key,
    projectName: project.name,
    boardName: board.name,
    boardUrl: board.url,
    origins: parseStringArray(project.allowed_origins),
  });
  const [stored] = await env.DB.batch([...handoff, env.DB.prepare('DELETE FROM connect_sessions WHERE id = ?').bind(s.id)]);
  deleteCookie(c, cookieName(s.id), { path: '/connect', secure: publicBase(env).startsWith('https:') });
  if (!stored?.meta.changes) throw cliGone(null);

  return c.json<ConnectCliDoneResponse>({ cli: { action: 'linked', projectName: project.name, boardName: board.name, boardUrl: board.url } });
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
  // A list id, CREATE_REVIEW_LIST, or absent (older pages and API callers: keep the current one, else none).
  const reviewChoice = typeof body.reviewListId === 'string' && body.reviewListId ? body.reviewListId : null;
  if (body.reviewListId !== undefined && body.reviewListId !== null && body.reviewListId !== '' && !reviewChoice) {
    throw new ConnectError(400, 'Invalid review list.', 'bad_request');
  }
  if (reviewChoice && (reviewChoice === newListId || doneListIds.includes(reviewChoice))) {
    throw new ConnectError(400, 'Pick a different list for issues ready for review than for new or resolved ones.', 'bad_request');
  }

  let siteUrl: URL | null = null;
  if (body.siteUrl !== undefined && body.siteUrl !== null && body.siteUrl !== '') {
    siteUrl = parseHttpUrl(body.siteUrl);
    if (!siteUrl) throw new ConnectError(400, 'Enter your site’s full address, like https://example.com.', 'bad_request');
  }
  if (!s.opener_origin && !s.project_id && !siteUrl && !s.site_url) throw new ConnectError(400, 'Enter your site’s address so we know where feedback comes from.', 'bad_request');
  // CLI mode: make sure the terminal is still waiting before changing anything.
  const cli = s.cli_session_id ? await openCliSession(env, s.cli_session_id) : null;

  const t = await sessionTrello(env, s);
  const board = (await visibleBoards(env, t)).find((b) => b.id === boardId);
  if (!board) throw new ConnectError(400, 'That board isn’t available to this Trello account.', 'bad_request');
  const boardLists = await t.lists(board.id);
  const listIds = new Set(boardLists.map((l) => l.id));
  if (!listIds.has(newListId) || !doneListIds.every((id) => listIds.has(id)) || (reviewChoice && reviewChoice !== CREATE_REVIEW_LIST && !listIds.has(reviewChoice))) {
    throw new ConnectError(400, 'Those lists aren’t on this board anymore. Pick the board again.', 'bad_request');
  }

  const existing = s.project_id ? await getProject(env, s.project_id) : null;
  if (s.project_id && !existing) throw new ConnectError(410, 'The project you were reconnecting no longer exists. Connect again from your site settings.', 'not_found');

  let reviewListId: string | null = null;
  if (reviewChoice === CREATE_REVIEW_LIST) {
    reviewListId = (await t.createList(board.id, REVIEW_LIST_NAME, posBefore(boardLists, doneListIds))).id;
  } else if (reviewChoice) {
    reviewListId = reviewChoice;
  } else if (existing?.review_list_id && existing.trello_board_id === board.id) {
    const r = existing.review_list_id;
    if (listIds.has(r) && r !== newListId && !doneListIds.includes(r)) reviewListId = r;
  }

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
  const projectId = existing?.id ?? randomId();
  const projectName = existing?.name ?? (s.site_name || hostOf(siteUrl?.href) || hostOf(s.site_url) || hostOf(s.opener_origin) || 'My site');
  const publicKey = existing?.public_key ?? `pk_${randomId()}`;
  const accessKey = existing?.access_key ?? `ak_${randomId(24)}`;
  const common = [
    s.trello_token_enc,
    s.trello_member_id ?? '',
    board.id,
    board.name,
    board.url,
    newListId,
    JSON.stringify(doneListIds),
    reviewListId,
    webhookId,
  ] as const;

  const write = existing
    ? env.DB.prepare(
        `UPDATE projects SET allowed_origins = ?, trello_token_enc = ?, trello_member_id = ?, trello_board_id = ?, trello_board_name = ?,
           trello_board_url = ?, new_list_id = ?, done_list_ids = ?, review_list_id = ?, webhook_id = ?, token_revoked = 0, updated_at = ? WHERE id = ?`,
      ).bind(JSON.stringify([...origins]), ...common, now, existing.id)
    : env.DB.prepare(
        `INSERT INTO projects (id, name, public_key, access_key, allowed_origins, trello_token_enc, trello_member_id, trello_board_id,
           trello_board_name, trello_board_url, new_list_id, done_list_ids, review_list_id, webhook_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(projectId, projectName, publicKey, accessKey, JSON.stringify([...origins]), ...common, now, now);

  const base = publicBase(env);
  const handoff = cli
    ? await cliHandoff(env, cli, projectId, {
        endpoint: base,
        projectKey: publicKey,
        accessKey,
        projectName,
        boardName: board.name,
        boardUrl: board.url,
        origins: [...origins],
      })
    : [];
  const results = await env.DB.batch([write, ...handoff, env.DB.prepare('DELETE FROM connect_sessions WHERE id = ?').bind(s.id)]);
  deleteCookie(c, cookieName(s.id), { path: '/connect', secure: base.startsWith('https:') });

  if (cli) {
    // Another window finished this terminal session first (or it just expired). The board is connected anyway.
    if (!results[1]?.meta.changes) {
      throw new ConnectError(410, `${board.name} is connected, but your terminal stopped waiting. Run “annotate init” in your terminal to link it.`, 'expired', 'Terminal session ended');
    }
    return c.json<ConnectCliDoneResponse>({ cli: { action: 'connected', projectName, boardName: board.name, boardUrl: board.url } });
  }

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

/** Why a CLI session can't take a result anymore. */
function cliGone(cli: CliSessionRow | null) {
  if (cli && cli.result_enc && cli.expires_at > Date.now()) {
    return new ConnectError(410, 'Your terminal already got its keys from this link. To connect again, run the command in your terminal again.', 'expired', 'This link was already used');
  }
  return new ConnectError(410, 'Terminal links work for 15 minutes. Run the command in your terminal again to get a new one.', 'expired', 'This link has expired');
}

/** The CLI session behind a connect session, if the terminal is still waiting; else a friendly 410. */
async function openCliSession(env: Env, id: string): Promise<CliSessionRow> {
  const cli = await getCliSession(env, id);
  if (!cliSessionOpen(cli)) throw cliGone(cli);
  return cli;
}

/** Projects whose board is among the member's boards, for the "Link an existing project" list. */
async function linkableProjects(env: Env, boards: TrelloBoard[]): Promise<LinkableProject[]> {
  const byId = new Map(boards.map((b) => [b.id, b]));
  // Self-hosted: a handful of projects. Filtering here avoids D1's bound-parameter limit for members with many boards.
  const { results } = await env.DB.prepare('SELECT id, name, trello_board_id, trello_board_name, allowed_origins FROM projects ORDER BY name COLLATE NOCASE, created_at').all<
    Pick<ProjectRow, 'id' | 'name' | 'trello_board_id' | 'trello_board_name' | 'allowed_origins'>
  >();
  return results
    .filter((p) => byId.has(p.trello_board_id))
    .map((p) => ({ id: p.id, name: p.name, boardName: byId.get(p.trello_board_id)?.name ?? p.trello_board_name, origins: parseStringArray(p.allowed_origins) }));
}

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
  if (!isSessionId(id)) {
    throw new ConnectError(400, 'This connect link is incomplete. Close this window and click Connect again.', 'bad_request', 'Broken connect link');
  }
  const row = await c.env.DB.prepare('SELECT * FROM connect_sessions WHERE id = ?').bind(id).first<ConnectSessionRow>();
  if (!row || row.expires_at <= Date.now()) {
    if (row) await c.env.DB.prepare('DELETE FROM connect_sessions WHERE id = ?').bind(id).run();
    if (row?.cli_session_id) throw cliGone(null);
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

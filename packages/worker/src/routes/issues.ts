import { Hono, type Context } from 'hono';
import type {
  Comment,
  CreateIssueMeta,
  CreateIssueResponse,
  GetIssueResponse,
  IssueActionResponse,
  IssueContext,
  IssueStatus,
  IssueSummary,
  ListIssuesResponse,
  SourceHint,
} from '@annotate/shared';
import type { AppEnv, Env } from '../env';
import { nowIso, randomId, statusForList, type IssueRow, type ProjectRow } from '../db';
import { apiError, markTokenRevoked, requireProject } from '../auth';
import { trelloForProject } from '../crypto';
import { TrelloError, type TrelloCard } from '../trello';
import { normalizeUrl } from '../url';
import { signedScreenshotUrl } from '../sign';
import { cardDescription, cardName, commentAuthorName, issueTitle, parseComment, widgetCommentText } from '../card';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_META_CHARS = 512 * 1024;
const MAX_CONTEXT_BYTES = 16 * 1024;
const MAX_SOURCES = 10;
const SOURCE_KINDS = new Set<SourceHint['kind']>(['annotate', 'wp-block', 'astro-source', 'astro-cid']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Returns an error message, or null when the reporter is valid. */
export function reporterError(r: unknown): string | null {
  if (!isObj(r)) return 'reporter is required';
  if (typeof r.name !== 'string' || !r.name.trim()) return 'reporter.name is required';
  if (r.name.trim().length > 200) return 'reporter.name must be at most 200 characters';
  if (typeof r.email !== 'string' || !EMAIL_RE.test(r.email.trim()) || r.email.trim().length > 254) return 'reporter.email must be a valid email address';
  return null;
}

function metaError(m: unknown): string | null {
  if (!isObj(m)) return 'meta must be a JSON object';
  if (m.title !== undefined && typeof m.title !== 'string') return 'title must be a string';
  if (typeof m.title === 'string' && m.title.trim().length > 200) return 'title must be at most 200 characters';
  if (typeof m.notes !== 'string' || !m.notes.trim()) return 'notes are required';
  if (m.notes.trim().length > 10000) return 'notes must be at most 10000 characters';
  const rErr = reporterError(m.reporter);
  if (rErr) return rErr;
  const abs = isObj(m.anchor) ? m.anchor.absolute : undefined;
  if (!isObj(abs) || !isNum(abs.x) || !isNum(abs.y) || !isNum(abs.width) || !isNum(abs.height)) return 'anchor.absolute must be a rect';
  if (!isObj(m.env) || typeof m.env.url !== 'string' || !m.env.url) return 'env.url is required';
  try {
    const u = new URL(m.env.url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'env.url must be an http(s) URL';
  } catch {
    return 'env.url must be a valid URL';
  }
  return contextError(m.context);
}

/** meta.context (0.2) is optional: null/undefined, or { page, element } at most 16 KB as JSON. */
function contextError(ctx: unknown): string | null {
  if (ctx === undefined || ctx === null) return null;
  if (!isObj(ctx)) return 'context must be an object';
  if (ctx.page !== undefined && ctx.page !== null && !isObj(ctx.page)) return 'context.page must be an object or null';
  const el = ctx.element;
  if (el !== undefined && el !== null) {
    if (!isObj(el)) return 'context.element must be an object or null';
    if (el.sources !== undefined && !Array.isArray(el.sources)) return 'context.element.sources must be an array';
  }
  if (new TextEncoder().encode(JSON.stringify(ctx)).length > MAX_CONTEXT_BYTES) return 'context must be at most 16 KB';
  return null;
}

const isSourceHint = (h: unknown): h is SourceHint =>
  isObj(h) && SOURCE_KINDS.has(h.kind as SourceHint['kind']) && typeof h.value === 'string' && (h.file === undefined || typeof h.file === 'string');

/** Context as stored: both keys present, source hints filtered to well-formed ones. Null when absent. */
function cleanContext(ctx: unknown): IssueContext | null {
  if (!isObj(ctx)) return null;
  const page = isObj(ctx.page) ? ctx.page : null;
  let element = isObj(ctx.element) ? (ctx.element as unknown as IssueContext['element']) : null;
  if (element) {
    const raw: unknown[] = Array.isArray(element.sources) ? element.sources : [];
    element = { ...element, sources: raw.filter(isSourceHint).slice(0, MAX_SOURCES) };
  }
  return page || element ? { page, element } : null;
}

/** Trim the free-text fields and fill optional ones so later code can rely on them. */
function cleanMeta(m: CreateIssueMeta): CreateIssueMeta {
  const context = cleanContext(m.context);
  const out: CreateIssueMeta = {
    ...m,
    title: (m.title ?? '').trim(),
    notes: m.notes.trim(),
    reporter: { name: m.reporter.name.trim(), email: m.reporter.email.trim() },
    env: { ...m.env, consoleErrors: Array.isArray(m.env.consoleErrors) ? m.env.consoleErrors : [] },
  };
  if (context) out.context = context;
  else delete out.context;
  return out;
}

type Image = { file: File; type: 'image/png' | 'image/jpeg'; ext: 'png' | 'jpg' };

async function readImage(form: FormData, field: string): Promise<Image | string> {
  const v = form.get(field);
  if (!v || typeof v === 'string') return `${field} image is required`;
  if (v.type !== 'image/png' && v.type !== 'image/jpeg') return `${field} must be image/png or image/jpeg`;
  if (v.size === 0) return `${field} is empty`;
  if (v.size > MAX_IMAGE_BYTES) return `${field} must be at most 8MB`;
  const head = new Uint8Array(await v.slice(0, 4).arrayBuffer());
  const isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
  const isJpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  if (v.type === 'image/png' ? !isPng : !isJpeg) return `${field} content does not match ${v.type}`;
  return { file: v, type: v.type, ext: v.type === 'image/png' ? 'png' : 'jpg' };
}

/** 502 for a Trello failure; a 401 also flags the project's token as revoked. Rethrows non-Trello errors. */
export async function trelloFailure(c: Context<AppEnv>, project: ProjectRow, e: unknown) {
  if (!(e instanceof TrelloError)) throw e;
  if (e.revoked) {
    await markTokenRevoked(c.env, project.id);
    return apiError(c, 502, 'token_revoked', 'The Trello connection was revoked; reconnect Trello for this project');
  }
  console.error(e);
  return apiError(c, 502, 'trello_error', `Trello request failed (${e.status})`);
}

export async function issueForProject(env: Env, projectId: string, id: string): Promise<IssueRow | null> {
  return env.DB.prepare('SELECT * FROM issues WHERE id = ? AND project_id = ?').bind(id, projectId).first<IssueRow>();
}

/**
 * Re-read the issue's card so a missed webhook doesn't leave a stale status, and fetch its comments
 * (oldest first). Returns null when the card was deleted (the row and screenshots are removed).
 * Trello failures are not fatal: the stored status is kept and comments are empty (a 401 flags the token).
 */
export async function refreshFromTrello(env: Env, project: ProjectRow, row: IssueRow): Promise<{ status: IssueStatus; comments: Comment[] } | null> {
  let status = row.status;
  let comments: Comment[] = [];
  try {
    const trello = await trelloForProject(env, project);
    const card = await trello.getCard(row.trello_card_id);
    if (!card) {
      await env.DB.prepare('DELETE FROM issues WHERE id = ?').bind(row.id).run();
      await env.SCREENSHOTS.delete([row.screenshot_key, row.context_key]);
      return null;
    }
    const fresh: IssueStatus = card.closed ? 'archived' : statusForList(project, card.idList);
    if (fresh !== row.status) {
      await env.DB.prepare('UPDATE issues SET status = ?, updated_at = ? WHERE id = ?').bind(fresh, nowIso(), row.id).run();
      status = fresh;
    }
    // Trello returns newest first; clients show oldest first.
    comments = (await trello.getComments(row.trello_card_id)).reverse().map(parseComment);
  } catch (e) {
    if (e instanceof TrelloError && e.revoked) await markTokenRevoked(env, project.id);
    else console.error(`Trello refresh failed for issue ${row.id}`, e);
  }
  return { status, comments };
}

async function toSummary(env: Env, row: IssueRow, status: IssueStatus = row.status): Promise<IssueSummary> {
  return {
    id: row.id,
    number: row.number,
    title: row.title,
    status,
    anchor: JSON.parse(row.anchor),
    reporterName: row.reporter_name,
    createdAt: row.created_at,
    screenshotUrl: await signedScreenshotUrl(env, row.screenshot_key),
    shortUrl: row.trello_short_url,
  };
}

const app = new Hono<AppEnv>();

app.post('/', requireProject, async (c) => {
  const project = c.var.project;
  const bad = (msg: string) => apiError(c, 400, 'bad_request', msg);

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return bad('Expected a multipart/form-data body');
  }
  const metaRaw = form.get('meta');
  if (typeof metaRaw !== 'string' || !metaRaw) return bad('meta field is required');
  if (metaRaw.length > MAX_META_CHARS) return bad('meta is too large');
  let parsed: unknown;
  try {
    parsed = JSON.parse(metaRaw);
  } catch {
    return bad('meta is not valid JSON');
  }
  const err = metaError(parsed);
  if (err) return bad(err);
  const meta = cleanMeta(parsed as CreateIssueMeta);

  const selection = await readImage(form, 'selection');
  if (typeof selection === 'string') return bad(selection);
  const context = await readImage(form, 'context');
  if (typeof context === 'string') return bad(context);

  const pageUrl = normalizeUrl(meta.env.url, { ignoreQuery: project.ignore_query });
  const trello = await trelloForProject(c.env, project);

  const next = await c.env.DB.prepare('UPDATE projects SET next_number = next_number + 1 WHERE id = ? RETURNING next_number - 1 AS n')
    .bind(project.id)
    .first<{ n: number }>();
  if (!next) throw new Error(`project ${project.id} disappeared`);
  const number = next.n;

  const id = randomId();
  const screenshotKey = `${project.id}/${id}/selection.${selection.ext}`;
  const contextKey = `${project.id}/${id}/context.${context.ext}`;
  await Promise.all([
    c.env.SCREENSHOTS.put(screenshotKey, await selection.file.arrayBuffer(), { httpMetadata: { contentType: selection.type } }),
    c.env.SCREENSHOTS.put(contextKey, await context.file.arrayBuffer(), { httpMetadata: { contentType: context.type } }),
  ]);

  let card: TrelloCard;
  try {
    card = await trello.createCard({ idList: project.new_list_id, name: cardName(number, meta.title, meta.notes), desc: cardDescription(meta), pos: 'top' });
  } catch (e) {
    await c.env.SCREENSHOTS.delete([screenshotKey, contextKey]);
    return trelloFailure(c, project, e);
  }

  // The card exists now, so the issue is recorded even if an attachment fails: a 502 here would
  // leave an untracked card behind and the reporter's retry would create a duplicate.
  try {
    await trello.addAttachment(card.id, selection.file, `issue-${number}.${selection.ext}`, true);
    await trello.addAttachment(card.id, context.file, `issue-${number}-context.${context.ext}`);
  } catch (e) {
    console.error(`attachment upload failed for card ${card.id}`, e);
    if (e instanceof TrelloError && e.revoked) await markTokenRevoked(c.env, project.id);
  }

  const now = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO issues (id, project_id, number, trello_card_id, trello_short_url, page_url, page_url_raw, title, notes,
       anchor, env, context, reporter_name, reporter_email, screenshot_key, context_key, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)`,
  )
    .bind(
      id,
      project.id,
      number,
      card.id,
      card.shortUrl,
      pageUrl,
      meta.env.url,
      issueTitle(meta.title, meta.notes),
      meta.notes,
      JSON.stringify(meta.anchor),
      JSON.stringify(meta.env),
      meta.context ? JSON.stringify(meta.context) : null,
      meta.reporter.name,
      meta.reporter.email,
      screenshotKey,
      contextKey,
      now,
      now,
    )
    .run();

  return c.json<CreateIssueResponse>({ id, number, shortUrl: card.shortUrl }, 201);
});

app.get('/', requireProject, async (c) => {
  const project = c.var.project;
  const url = c.req.query('url');
  if (!url) return apiError(c, 400, 'bad_request', 'url query parameter is required');
  let pageUrl: string;
  try {
    pageUrl = normalizeUrl(url, { ignoreQuery: project.ignore_query });
  } catch {
    return apiError(c, 400, 'bad_request', 'url must be a valid URL');
  }
  const all = c.req.query('all') === '1' || c.req.query('all') === 'true';
  // 'review' issues stay visible: that's where the reporter confirms or reopens them.
  const sql = `SELECT * FROM issues WHERE project_id = ? AND page_url = ?${all ? '' : " AND status NOT IN ('resolved', 'archived')"} ORDER BY number`;
  const { results } = await c.env.DB.prepare(sql).bind(project.id, pageUrl).all<IssueRow>();
  const issues = await Promise.all(results.map((r) => toSummary(c.env, r)));
  return c.json<ListIssuesResponse>({ issues });
});

app.get('/:id', requireProject, async (c) => {
  const project = c.var.project;
  const row = await issueForProject(c.env, project.id, c.req.param('id'));
  if (!row) return apiError(c, 404, 'not_found', 'Issue not found');

  const fresh = await refreshFromTrello(c.env, project, row);
  if (!fresh) return apiError(c, 404, 'not_found', 'Issue not found');

  const summary = await toSummary(c.env, row, fresh.status);
  return c.json<GetIssueResponse>({
    issue: {
      ...summary,
      notes: row.notes,
      contextUrl: await signedScreenshotUrl(c.env, row.context_key),
      env: JSON.parse(row.env),
      comments: fresh.comments,
    },
  });
});

type ActionBody = { name: string; text: string };

/** Parse a widget action body: { reporter, text? }. Returns an error response or the cleaned values. */
async function actionBody(c: Context<AppEnv>, needText: boolean): Promise<ActionBody | Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return apiError(c, 400, 'bad_request', 'Expected a JSON body');
  }
  if (!isObj(body)) return apiError(c, 400, 'bad_request', 'Expected a JSON object');
  const rErr = reporterError(body.reporter);
  if (rErr) return apiError(c, 400, 'bad_request', rErr);
  let text = '';
  if (needText) {
    if (typeof body.text !== 'string' || !body.text.trim()) return apiError(c, 400, 'bad_request', 'text is required');
    text = body.text.trim();
    if (text.length > 5000) return apiError(c, 400, 'bad_request', 'text must be at most 5000 characters');
  }
  return { name: commentAuthorName((body.reporter as { name: string }).name), text };
}

/** Move the issue's card, record the new status and post a widget comment. */
async function widgetAction(c: Context<AppEnv>, row: IssueRow, listId: string, status: IssueStatus, comment: string) {
  const project = c.var.project;
  try {
    const trello = await trelloForProject(c.env, project);
    await trello.moveCard(row.trello_card_id, listId);
    const now = nowIso();
    await c.env.DB.prepare('UPDATE issues SET status = ?, updated_at = ? WHERE id = ?').bind(status, now, row.id).run();
    await trello.addComment(row.trello_card_id, comment);
  } catch (e) {
    return trelloFailure(c, project, e);
  }
  return c.json<IssueActionResponse>({ issue: await toSummary(c.env, row, status) });
}

app.post('/:id/confirm', requireProject, async (c) => {
  const project = c.var.project;
  const row = await issueForProject(c.env, project.id, c.req.param('id'));
  if (!row) return apiError(c, 404, 'not_found', 'Issue not found');
  const body = await actionBody(c, false);
  if (body instanceof Response) return body;
  if (row.status !== 'review') return apiError(c, 409, 'bad_request', `Only issues in review can be confirmed (this one is ${row.status})`);
  const doneListId = (JSON.parse(project.done_list_ids) as string[])[0];
  if (!doneListId) return apiError(c, 400, 'bad_request', 'This project has no done list');
  return widgetAction(c, row, doneListId, 'resolved', widgetCommentText(body.name, '✅ Confirmed fixed'));
});

app.post('/:id/reopen', requireProject, async (c) => {
  const project = c.var.project;
  const row = await issueForProject(c.env, project.id, c.req.param('id'));
  if (!row) return apiError(c, 404, 'not_found', 'Issue not found');
  const body = await actionBody(c, true);
  if (body instanceof Response) return body;
  if (row.status !== 'review' && row.status !== 'resolved') {
    return apiError(c, 409, 'bad_request', `Only issues in review or resolved can be reopened (this one is ${row.status})`);
  }
  return widgetAction(c, row, project.new_list_id, 'new', widgetCommentText(body.name, `❌ Still broken: ${body.text}`));
});

export default app;

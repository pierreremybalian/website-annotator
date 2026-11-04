import { Hono, type Context } from 'hono';
import type {
  CreateIssueMeta,
  CreateIssueResponse,
  GetIssueResponse,
  IssueActionResponse,
  IssueContext,
  IssueSummary,
  ListIssuesResponse,
  SourceHint,
} from '@annotate/shared';
import type { AppEnv, Env } from '../env';
import { hasTrello, nowIso, randomId, type IssueRow } from '../db';
import { apiError, requireProject } from '../auth';
import { normalizeUrl } from '../url';
import { signedScreenshotUrl } from '../sign';
import { commentAuthorName, issueTitle, toComment } from '../card';
import { createIssue, listComments, setStatus, type NewComment } from '../tracker';

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

export async function issueForProject(env: Env, projectId: string, id: string): Promise<IssueRow | null> {
  return env.DB.prepare('SELECT * FROM issues WHERE id = ? AND project_id = ?').bind(id, projectId).first<IssueRow>();
}

async function toSummary(env: Env, row: IssueRow): Promise<IssueSummary> {
  return {
    id: row.id,
    number: row.number,
    title: row.title,
    status: row.status,
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

  const now = nowIso();
  // Recorded even when Trello is down: the card is created later by the cron (src/cron.ts).
  const issue = await createIssue(c.env, project, {
    id,
    project_id: project.id,
    number,
    page_url: pageUrl,
    page_url_raw: meta.env.url,
    title: issueTitle(meta.title, meta.notes),
    notes: meta.notes,
    anchor: JSON.stringify(meta.anchor),
    env: JSON.stringify(meta.env),
    context: meta.context ? JSON.stringify(meta.context) : null,
    reporter_name: meta.reporter.name,
    reporter_email: meta.reporter.email,
    screenshot_key: screenshotKey,
    context_key: contextKey,
    created_at: now,
    updated_at: now,
  });

  return c.json<CreateIssueResponse>({ id, number, shortUrl: issue.trello_short_url }, 201);
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

  return c.json<GetIssueResponse>({
    issue: {
      ...(await toSummary(c.env, row)),
      notes: row.notes,
      contextUrl: await signedScreenshotUrl(c.env, row.context_key),
      env: JSON.parse(row.env),
      comments: (await listComments(c.env, project, row)).map(toComment),
    },
  });
});

type ActionBody = { name: string; email: string; text: string };

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
  const reporter = body.reporter as { name: string; email: string };
  return { name: commentAuthorName(reporter.name), email: reporter.email.trim(), text };
}

const widgetComment = (body: ActionBody, text: string): NewComment => ({ via: 'widget', author: body.name, email: body.email, text });

app.post('/:id/confirm', requireProject, async (c) => {
  const project = c.var.project;
  const row = await issueForProject(c.env, project.id, c.req.param('id'));
  if (!row) return apiError(c, 404, 'not_found', 'Issue not found');
  const body = await actionBody(c, false);
  if (body instanceof Response) return body;
  if (row.status !== 'review') return apiError(c, 409, 'bad_request', `Only issues in review can be confirmed (this one is ${row.status})`);
  if (hasTrello(project) && !(JSON.parse(project.done_list_ids) as string[])[0]) return apiError(c, 400, 'bad_request', 'This project has no done list');
  const updated = await setStatus(c.env, project, row, 'resolved', { comment: widgetComment(body, '✅ Confirmed fixed') });
  return c.json<IssueActionResponse>({ issue: await toSummary(c.env, updated) });
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
  const updated = await setStatus(c.env, project, row, 'new', { comment: widgetComment(body, `❌ Still broken: ${body.text}`) });
  return c.json<IssueActionResponse>({ issue: await toSummary(c.env, updated) });
});

export default app;

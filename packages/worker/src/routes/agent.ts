// Agent API (/v1/agent/*): what the `annotate` CLI calls on behalf of a coding agent.
// Auth is a per-project agent token (requireAgent). Issues are addressed by their per-project NUMBER.
// Claim moves the card to the "In progress" list, release puts it back, and resolve (after the agent has
// verified the fix live) moves it to Done. Anyone can reopen it from the pin or Trello.

import { Hono, type Context } from 'hono';
import type {
  AgentIssue,
  AgentIssueDetail,
  AgentIssueResponse,
  AgentListIssuesResponse,
  AgentOriginsResponse,
  AgentProject,
  Anchor,
  IssueContext,
  IssueStatus,
} from '@annotate/shared';
import type { AppEnv, Env } from '../env';
import { nowIso, type IssueRow, type ProjectRow } from '../db';
import { apiError } from '../auth';
import { requireAgent } from '../agent-auth';
import { trelloForProject } from '../crypto';
import { signedScreenshotUrl } from '../sign';
import { normalizeUrl } from '../url';
import { agentCommentText, commentAuthorName } from '../card';
import { ensureProgressList } from '../progress';
import { refreshFromTrello, trelloFailure } from './issues';

const STATUSES: readonly IssueStatus[] = ['new', 'in_progress', 'review', 'resolved', 'archived'];
const STATUS_FILTERS: Record<string, readonly IssueStatus[] | null> = {
  open: ['new', 'in_progress'],
  all: null,
  ...Object.fromEntries(STATUSES.map((s) => [s, [s]])),
};
const DEFAULT_LEASE_MIN = 30;
const MAX_LEASE_MIN = 240;
const MAX_TEXT = 5000;
const MAX_NAME = 200;
const MAX_ORIGINS = 20;

type Ctx = Context<AppEnv>;
type Body = Record<string, unknown>;

const isObj = (v: unknown): v is Body => typeof v === 'object' && v !== null && !Array.isArray(v);

function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

const leaseActive = (row: Pick<IssueRow, 'claimed_by' | 'claimed_until'>, now = Date.now()) =>
  !!row.claimed_by && row.claimed_until !== null && row.claimed_until > now;

async function toAgentIssue(env: Env, row: IssueRow, status: IssueStatus = row.status): Promise<AgentIssue> {
  const anchor = parseJson<Partial<Anchor> | null>(row.anchor, null);
  const context = parseJson<IssueContext | null>(row.context, null);
  const active = leaseActive(row);
  const [screenshotUrl, contextUrl] = await Promise.all([signedScreenshotUrl(env, row.screenshot_key), signedScreenshotUrl(env, row.context_key)]);
  return {
    id: row.id,
    number: row.number,
    title: row.title,
    status,
    pageUrl: row.page_url_raw,
    notes: row.notes,
    reporterName: row.reporter_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    shortUrl: row.trello_short_url,
    claimedBy: active ? row.claimed_by : null,
    claimedUntil: active ? new Date(row.claimed_until!).toISOString() : null,
    screenshotUrl,
    contextUrl,
    selector: anchor?.selector ?? null,
    sources: Array.isArray(context?.element?.sources) ? context.element.sources : [],
  };
}

const issueByNumber = (env: Env, projectId: string, number: number) =>
  env.DB.prepare('SELECT * FROM issues WHERE project_id = ? AND number = ?').bind(projectId, number).first<IssueRow>();

/** The :number param as an integer, or null. Accepts "12" and "#12". */
function issueNumber(c: Ctx): number | null {
  const m = /^#?(\d{1,9})$/.exec(c.req.param('number') ?? '');
  return m ? Number(m[1]) : null;
}

/** Load the issue addressed by :number, or an error response. */
async function loadIssue(c: Ctx): Promise<IssueRow | Response> {
  const number = issueNumber(c);
  if (number === null) return apiError(c, 400, 'bad_request', 'Issue number must be a positive integer');
  const row = await issueByNumber(c.env, c.var.project.id, number);
  return row ?? apiError(c, 404, 'not_found', `Issue #${number} not found`);
}

/**
 * The full issue as AgentIssueResponse, re-read from D1 and refreshed from Trello (status self-heal +
 * comments).
 */
async function respondDetail(c: Ctx, number: number, project: ProjectRow = c.var.project, status: 200 | 201 = 200) {
  const row = await issueByNumber(c.env, project.id, number);
  if (!row) return apiError(c, 404, 'not_found', `Issue #${number} not found`);
  const fresh = await refreshFromTrello(c.env, project, row);
  if (!fresh) return apiError(c, 404, 'not_found', `Issue #${number} no longer exists in Trello`);
  const issue: AgentIssueDetail = {
    ...(await toAgentIssue(c.env, row, fresh.status)),
    anchor: JSON.parse(row.anchor) as Anchor,
    env: JSON.parse(row.env) as AgentIssueDetail['env'],
    context: parseJson<IssueContext | null>(row.context, null),
    comments: fresh.comments,
    resolution: row.resolution,
  };
  return c.json<AgentIssueResponse>({ issue }, status);
}

async function jsonBody(c: Ctx): Promise<Body | Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return apiError(c, 400, 'bad_request', 'Expected a JSON body');
  }
  return isObj(body) ? body : apiError(c, 400, 'bad_request', 'Expected a JSON object');
}

/** A trimmed string field. Returns the value, undefined when optional and absent/blank, or an error message. */
function strField(body: Body, key: string, opts: { required?: boolean; max: number }): string | undefined | { error: string } {
  const v = body[key];
  if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) return opts.required ? { error: `${key} is required` } : undefined;
  if (typeof v !== 'string') return { error: `${key} must be a string` };
  const s = v.trim();
  if (s.length > opts.max) return { error: `${key} must be at most ${opts.max} characters` };
  return s;
}
const isErr = (v: unknown): v is { error: string } => isObj(v) && typeof v.error === 'string';

const app = new Hono<AppEnv>();

app.use('*', requireAgent);

// ---------------------------------------------------------------------------
// Project

app.get('/project', async (c) => {
  const project = c.var.project;
  const { results } = await c.env.DB.prepare('SELECT status, COUNT(*) AS n FROM issues WHERE project_id = ? GROUP BY status')
    .bind(project.id)
    .all<{ status: IssueStatus; n: number }>();
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<IssueStatus, number>;
  for (const r of results) if (Object.hasOwn(counts, r.status)) counts[r.status] = r.n;
  return c.json<AgentProject>({
    name: project.name,
    projectKey: project.public_key,
    boardName: project.trello_board_name,
    boardUrl: project.trello_board_url,
    origins: storedOrigins(project),
    counts,
  });
});

// ---------------------------------------------------------------------------
// Issues

app.get('/issues', async (c) => {
  const project = c.var.project;
  const statusParam = c.req.query('status') || 'open';
  if (!Object.hasOwn(STATUS_FILTERS, statusParam)) {
    return apiError(c, 400, 'bad_request', `status must be one of ${Object.keys(STATUS_FILTERS).join(', ')}`);
  }
  const statuses = STATUS_FILTERS[statusParam]!;

  const where = ['project_id = ?'];
  const binds: unknown[] = [project.id];
  if (statuses) {
    where.push(`status IN (${statuses.map(() => '?').join(', ')})`);
    binds.push(...statuses);
  }
  const url = c.req.query('url');
  if (url) {
    try {
      binds.push(normalizeUrl(url, { ignoreQuery: project.ignore_query }));
    } catch {
      return apiError(c, 400, 'bad_request', 'url must be a valid URL');
    }
    where.push('page_url = ?');
  }
  const { results } = await c.env.DB.prepare(`SELECT * FROM issues WHERE ${where.join(' AND ')} ORDER BY number`)
    .bind(...binds)
    .all<IssueRow>();
  const issues = await Promise.all(results.map((r) => toAgentIssue(c.env, r)));
  return c.json<AgentListIssuesResponse>({ issues });
});

app.get('/issues/:number', async (c) => {
  const row = await loadIssue(c);
  if (row instanceof Response) return row;
  return respondDetail(c, row.number);
});

app.post('/issues/:number/claim', async (c) => {
  const project = c.var.project;
  const row = await loadIssue(c);
  if (row instanceof Response) return row;
  const body = await jsonBody(c);
  if (body instanceof Response) return body;

  const agentField = strField(body, 'agent', { required: true, max: MAX_NAME });
  if (isErr(agentField)) return apiError(c, 400, 'bad_request', agentField.error);
  const agent = commentAuthorName(agentField!, 'Agent');
  const minutes = body.minutes ?? DEFAULT_LEASE_MIN;
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_LEASE_MIN) {
    return apiError(c, 400, 'bad_request', `minutes must be a number between 1 and ${MAX_LEASE_MIN}`);
  }

  const now = Date.now();
  const until = now + Math.round(minutes * 60_000);
  const renewal = leaseActive(row, now) && row.claimed_by === agent;
  // Atomic: only take the lease if it's free, expired, or already ours.
  const claimed = await c.env.DB.prepare(
    `UPDATE issues SET claimed_by = ?, claimed_until = ?, updated_at = ?
     WHERE id = ? AND (claimed_by IS NULL OR claimed_until IS NULL OR claimed_until <= ? OR claimed_by = ?)
     RETURNING id`,
  )
    .bind(agent, until, nowIso(), row.id, now, agent)
    .first<{ id: string }>();
  if (!claimed) {
    const holder = (await issueByNumber(c.env, project.id, row.number)) ?? row;
    const who = holder.claimed_by ?? 'another agent';
    const till = holder.claimed_until ? new Date(holder.claimed_until).toISOString() : 'later';
    return apiError(c, 409, 'claimed', `Issue #${row.number} is claimed by ${who} until ${till}`);
  }

  if (!renewal) {
    try {
      const trello = await trelloForProject(c.env, project);
      if (row.status === 'new') {
        await trello.moveCard(row.trello_card_id, await ensureProgressList(c.env, project, trello));
        await c.env.DB.prepare("UPDATE issues SET status = 'in_progress' WHERE id = ?").bind(row.id).run();
      }
      await trello.addComment(row.trello_card_id, `**${agent}** (via agent): 🤖 Working on this`);
    } catch (e) {
      // Undo the lease (if it's still the one we set) so a failed claim leaves nothing behind.
      await c.env.DB.prepare('UPDATE issues SET claimed_by = ?, claimed_until = ? WHERE id = ? AND claimed_by = ? AND claimed_until = ?')
        .bind(row.claimed_by, row.claimed_until, row.id, agent, until)
        .run();
      return trelloFailure(c, project, e);
    }
  }
  return respondDetail(c, row.number);
});

app.post('/issues/:number/release', async (c) => {
  const project = c.var.project;
  const row = await loadIssue(c);
  if (row instanceof Response) return row;
  let status = row.status;
  // Back to the new list, unless someone has moved the card out of "In progress" since the claim.
  if (status === 'in_progress' && project.progress_list_id) {
    try {
      const trello = await trelloForProject(c.env, project);
      if ((await trello.getCard(row.trello_card_id))?.idList === project.progress_list_id) {
        await trello.moveCard(row.trello_card_id, project.new_list_id);
        status = 'new';
      }
    } catch (e) {
      return trelloFailure(c, project, e);
    }
  }
  await c.env.DB.prepare('UPDATE issues SET status = ?, claimed_by = NULL, claimed_until = NULL, updated_at = ? WHERE id = ?').bind(status, nowIso(), row.id).run();
  return respondDetail(c, row.number);
});

app.post('/issues/:number/comments', async (c) => {
  const project = c.var.project;
  const row = await loadIssue(c);
  if (row instanceof Response) return row;
  const body = await jsonBody(c);
  if (body instanceof Response) return body;
  const text = strField(body, 'text', { required: true, max: MAX_TEXT });
  if (isErr(text)) return apiError(c, 400, 'bad_request', text.error);
  const author = strField(body, 'author', { max: MAX_NAME });
  if (isErr(author)) return apiError(c, 400, 'bad_request', author.error);

  try {
    const trello = await trelloForProject(c.env, project);
    await trello.addComment(row.trello_card_id, agentCommentText(author, text!));
  } catch (e) {
    return trelloFailure(c, project, e);
  }
  return respondDetail(c, row.number, project, 201);
});

app.post('/issues/:number/resolve', async (c) => {
  const project = c.var.project;
  const row = await loadIssue(c);
  if (row instanceof Response) return row;
  const body = await jsonBody(c);
  if (body instanceof Response) return body;
  const note = strField(body, 'note', { required: true, max: MAX_TEXT });
  if (isErr(note)) return apiError(c, 400, 'bad_request', note.error);
  const commit = strField(body, 'commit', { max: MAX_NAME });
  if (isErr(commit)) return apiError(c, 400, 'bad_request', commit.error);
  const author = strField(body, 'author', { max: MAX_NAME });
  if (isErr(author)) return apiError(c, 400, 'bad_request', author.error);

  const doneListId = parseJson<string[]>(project.done_list_ids, [])[0];
  if (!doneListId) return apiError(c, 400, 'bad_request', 'This project has no done list');

  try {
    const trello = await trelloForProject(c.env, project);
    await trello.moveCard(row.trello_card_id, doneListId);
    await c.env.DB.prepare("UPDATE issues SET status = 'resolved', resolution = ?, claimed_by = NULL, claimed_until = NULL, updated_at = ? WHERE id = ?")
      .bind(note!, nowIso(), row.id)
      .run();
    const commitLine = commit ? `\nCommit: ${commit.replace(/\s+/g, ' ')}` : '';
    await trello.addComment(row.trello_card_id, agentCommentText(author, `✅ Fixed: ${note!}${commitLine}`));
  } catch (e) {
    return trelloFailure(c, project, e);
  }
  return respondDetail(c, row.number);
});

app.post('/issues/:number/reopen', async (c) => {
  const project = c.var.project;
  const row = await loadIssue(c);
  if (row instanceof Response) return row;
  const body = await jsonBody(c);
  if (body instanceof Response) return body;
  const note = strField(body, 'note', { required: true, max: MAX_TEXT });
  if (isErr(note)) return apiError(c, 400, 'bad_request', note.error);
  const author = strField(body, 'author', { max: MAX_NAME });
  if (isErr(author)) return apiError(c, 400, 'bad_request', author.error);

  try {
    const trello = await trelloForProject(c.env, project);
    await trello.moveCard(row.trello_card_id, project.new_list_id);
    await c.env.DB.prepare("UPDATE issues SET status = 'new', updated_at = ? WHERE id = ?").bind(nowIso(), row.id).run();
    await trello.addComment(row.trello_card_id, agentCommentText(author, `🔁 Reopened: ${note!}`));
  } catch (e) {
    return trelloFailure(c, project, e);
  }
  return respondDetail(c, row.number);
});

// ---------------------------------------------------------------------------
// Allowed origins (where the widget may run)

/** "https://example.com" for an http(s) URL or origin, else null. */
function canonicalOrigin(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

function storedOrigins(project: Pick<ProjectRow, 'allowed_origins'>): string[] {
  const list = parseJson<unknown>(project.allowed_origins, []);
  return Array.isArray(list) ? list.filter((o): o is string => typeof o === 'string') : [];
}

/** Canonical, deduped form of a list of origins (unparseable entries dropped). */
const cleanOrigins = (list: string[]) => [...new Set(list.map(canonicalOrigin).filter((o): o is string => o !== null))];

async function originParam(c: Ctx): Promise<string | Response> {
  let raw: unknown = c.req.query('origin');
  if (raw === undefined) {
    const body = await jsonBody(c);
    if (body instanceof Response) return body;
    raw = body.origin;
  }
  if (typeof raw !== 'string' || !raw.trim()) return apiError(c, 400, 'bad_request', 'origin is required');
  return canonicalOrigin(raw) ?? apiError(c, 400, 'bad_request', 'origin must be an http(s) URL, e.g. https://example.com');
}

async function saveOrigins(c: Ctx, origins: string[]) {
  await c.env.DB.prepare('UPDATE projects SET allowed_origins = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify(origins), nowIso(), c.var.project.id).run();
  return c.json<AgentOriginsResponse>({ origins });
}

app.get('/origins', (c) => c.json<AgentOriginsResponse>({ origins: storedOrigins(c.var.project) }));

app.post('/origins', async (c) => {
  const origin = await originParam(c);
  if (origin instanceof Response) return origin;
  const current = cleanOrigins(storedOrigins(c.var.project));
  if (current.includes(origin)) return saveOrigins(c, current);
  if (current.length >= MAX_ORIGINS) return apiError(c, 400, 'bad_request', `A project can have at most ${MAX_ORIGINS} origins`);
  return saveOrigins(c, [...current, origin]);
});

app.delete('/origins', async (c) => {
  const origin = await originParam(c);
  if (origin instanceof Response) return origin;
  return saveOrigins(c, cleanOrigins(storedOrigins(c.var.project)).filter((o) => o !== origin));
});

export default app;

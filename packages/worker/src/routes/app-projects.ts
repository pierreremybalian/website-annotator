// /v1/app projects, issues and agent tokens: the dashboard's board. Mounted inside routes/app.ts, behind its
// session and same-origin checks. Everything is loaded through src/access.ts; writes go through the tracker,
// so projects that sync to Trello see dashboard changes on the board too.

import { Hono, type Context } from 'hono';
import type {
  AppAgentToken,
  AppAgentTokensResponse,
  AppIssue,
  AppIssueDetail,
  AppIssueResponse,
  AppIssuesResponse,
  AppNewAgentTokenResponse,
  AppProject,
  AppProjectsResponse,
  IssueStatus,
  Role,
} from '@annotate/shared';
import type { AppEnv } from '../env';
import { hasTrello, nowIso, randomId, type IssueRow } from '../db';
import { apiError } from '../auth';
import { atLeast, issueFor, orgRole, projectFor, projectsFor, type ScopedProject } from '../access';
import { addComment, setStatus } from '../tracker';
import { publicBase } from '../connect/util';
import { trelloForProject } from '../crypto';
import { mintAgentToken } from '../agent-tokens';
import { boardName, boardUrl, canonicalOrigin, cleanOrigins, issueDetail, storedOrigins, toAgentIssue } from './agent';

const STATUSES: readonly IssueStatus[] = ['new', 'in_progress', 'review', 'resolved', 'archived'];
const FILTERS: Record<string, readonly IssueStatus[] | null> = {
  board: ['new', 'in_progress', 'review', 'resolved'],
  open: ['new', 'in_progress'],
  all: null,
  ...Object.fromEntries(STATUSES.map((s) => [s, [s]])),
};
const MAX_ORIGINS = 20;
const MAX_TEXT = 5000;

type Ctx = Context<AppEnv>;
type Body = Record<string, unknown>;

async function jsonBody(c: Ctx): Promise<Body | Response> {
  const body = await c.req.json<unknown>().catch(() => null);
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Body) : apiError(c, 400, 'bad_request', 'Expected a JSON object');
}

const notFound = (c: Ctx, what = 'Project') => apiError(c, 404, 'not_found', `${what} not found`);
const needRole = (c: Ctx, role: Role, min: Role) => (atLeast(role, min) ? null : apiError(c, 403, 'forbidden', `Only ${min}s and up can do that`));
const cleanName = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 100) : '');

/**
 * Screenshot links as same-origin paths: they're signed for PUBLIC_URL, but the dashboard may be on another of
 * the Worker's hosts (the signature doesn't cover the host, and the dashboard's CSP only allows 'self').
 */
function here<T extends { screenshotUrl: string; contextUrl: string }>(issue: T): T {
  const path = (u: string) => {
    const url = new URL(u);
    return url.pathname + url.search;
  };
  return { ...issue, screenshotUrl: path(issue.screenshotUrl), contextUrl: path(issue.contextUrl) };
}

async function statusCounts(c: Ctx, projectIds: string[]): Promise<Map<string, Record<IssueStatus, number>>> {
  const out = new Map(projectIds.map((id) => [id, Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<IssueStatus, number>]));
  if (!projectIds.length) return out;
  const { results } = await c.env.DB.prepare(`SELECT project_id, status, COUNT(*) AS n FROM issues WHERE project_id IN (${projectIds.map(() => '?').join(', ')}) GROUP BY project_id, status`)
    .bind(...projectIds)
    .all<{ project_id: string; status: IssueStatus; n: number }>();
  for (const r of results) {
    const counts = out.get(r.project_id);
    if (counts && Object.hasOwn(counts, r.status)) counts[r.status] = r.n;
  }
  return out;
}

function toAppProject(c: Ctx, p: ScopedProject, counts: Record<IssueStatus, number>): AppProject {
  const endpoint = publicBase(c.env);
  return {
    id: p.id,
    orgId: p.org_id!,
    name: p.name,
    role: p.role,
    origins: storedOrigins(p),
    ignoreQuery: p.ignore_query === 1,
    trello: hasTrello(p) ? { boardName: p.trello_board_name, boardUrl: p.trello_board_url, revoked: p.token_revoked === 1, error: p.trello_error } : null,
    counts,
    createdAt: p.created_at,
    ...(atLeast(p.role, 'member')
      ? {
          install: {
            projectKey: p.public_key,
            accessKey: p.access_key,
            endpoint,
            snippet: `<script src="${endpoint}/widget.js" data-endpoint="${endpoint}" data-project="${p.public_key}" defer></script>`,
          },
        }
      : {}),
  };
}

async function projectResponse(c: Ctx, userId: string, projectId: string, status: 200 | 201 = 200) {
  const p = await projectFor(c.env, userId, projectId);
  if (!p) return notFound(c);
  return c.json<AppProject>(toAppProject(c, p, (await statusCounts(c, [p.id])).get(p.id)!), status);
}

/** Origins from a request body: a list of http(s) origins, normalized. Error message on bad input. */
function originsField(v: unknown): string[] | string {
  if (!Array.isArray(v) || !v.every((o) => typeof o === 'string')) return 'origins must be a list of site addresses';
  const raw = (v as string[]).map((o) => o.trim()).filter(Boolean);
  if (raw.some((o) => !canonicalOrigin(o))) return 'Each origin must be an http(s) address, e.g. https://example.com';
  const origins = cleanOrigins(raw);
  if (origins.length > MAX_ORIGINS) return `A project can have at most ${MAX_ORIGINS} origins`;
  return origins;
}

async function appIssueDetail(c: Ctx, project: ScopedProject, row: IssueRow): Promise<AppIssueDetail> {
  return {
    ...here(await issueDetail(c.env, project, row)),
    projectId: project.id,
    ...(atLeast(project.role, 'member') ? { reporterEmail: row.reporter_email } : {}),
  };
}

async function tokens(c: Ctx, projectId: string): Promise<AppAgentToken[]> {
  const { results } = await c.env.DB.prepare(
    `SELECT t.id, t.label, u.email AS created_by, t.created_at, t.last_used_at, t.revoked_at FROM agent_tokens t
     LEFT JOIN users u ON u.id = t.created_by WHERE t.project_id = ? ORDER BY t.revoked_at IS NOT NULL, t.created_at DESC`,
  )
    .bind(projectId)
    .all<{ id: string; label: string; created_by: string | null; created_at: string; last_used_at: string | null; revoked_at: string | null }>();
  return results.map((r) => ({ id: r.id, label: r.label, createdBy: r.created_by, createdAt: r.created_at, lastUsedAt: r.last_used_at, revokedAt: r.revoked_at }));
}

const app = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// Projects

app.get('/orgs/:org/projects', async (c) => {
  const orgId = c.req.param('org');
  if (!(await orgRole(c.env, c.var.user.id, orgId))) return notFound(c, 'Organization');
  const projects = await projectsFor(c.env, c.var.user.id, orgId);
  const counts = await statusCounts(c, projects.map((p) => p.id));
  return c.json<AppProjectsResponse>({ projects: projects.map((p) => toAppProject(c, p, counts.get(p.id)!)) });
});

app.post('/orgs/:org/projects', async (c) => {
  const orgId = c.req.param('org');
  const role = await orgRole(c.env, c.var.user.id, orgId);
  if (!role) return notFound(c, 'Organization');
  const denied = needRole(c, role, 'member');
  if (denied) return denied;
  const body = await jsonBody(c);
  if (body instanceof Response) return body;
  const name = cleanName(body.name);
  if (!name) return apiError(c, 400, 'bad_request', 'name is required');
  const origins = originsField(body.origins);
  if (typeof origins === 'string') return apiError(c, 400, 'bad_request', origins);
  if (!origins.length) return apiError(c, 400, 'bad_request', 'Add the address of the site the widget runs on');
  const id = randomId();
  const now = nowIso();
  await c.env.DB.prepare('INSERT INTO projects (id, name, public_key, access_key, allowed_origins, org_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, name, `pk_${randomId()}`, `ak_${randomId(24)}`, JSON.stringify(origins), orgId, now, now)
    .run();
  return projectResponse(c, c.var.user.id, id, 201);
});

app.get('/projects/:id', (c) => projectResponse(c, c.var.user.id, c.req.param('id')));

app.patch('/projects/:id', async (c) => {
  const p = await projectFor(c.env, c.var.user.id, c.req.param('id'));
  if (!p) return notFound(c);
  const denied = needRole(c, p.role, 'member');
  if (denied) return denied;
  const body = await jsonBody(c);
  if (body instanceof Response) return body;
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (body.name !== undefined) {
    const name = cleanName(body.name);
    if (!name) return apiError(c, 400, 'bad_request', 'name must not be empty');
    sets.push('name = ?');
    binds.push(name);
  }
  if (body.origins !== undefined) {
    const origins = originsField(body.origins);
    if (typeof origins === 'string') return apiError(c, 400, 'bad_request', origins);
    sets.push('allowed_origins = ?');
    binds.push(JSON.stringify(origins));
  }
  if (body.ignoreQuery !== undefined) {
    if (typeof body.ignoreQuery !== 'boolean') return apiError(c, 400, 'bad_request', 'ignoreQuery must be true or false');
    sets.push('ignore_query = ?');
    binds.push(body.ignoreQuery ? 1 : 0);
  }
  if (sets.length) await c.env.DB.prepare(`UPDATE projects SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).bind(...binds, nowIso(), p.id).run();
  return projectResponse(c, c.var.user.id, p.id);
});

app.delete('/projects/:id', async (c) => {
  const p = await projectFor(c.env, c.var.user.id, c.req.param('id'));
  if (!p) return notFound(c);
  const denied = needRole(c, p.role, 'admin');
  if (denied) return denied;
  if (hasTrello(p) && p.webhook_id) {
    try {
      await (await trelloForProject(c.env, p)).deleteWebhook(p.webhook_id);
    } catch (e) {
      console.error(`project delete: webhook ${p.webhook_id} not removed`, e);
    }
  }
  // Issues, comments, agent tokens and client access go with it (ON DELETE CASCADE).
  await c.env.DB.prepare('DELETE FROM projects WHERE id = ?').bind(p.id).run();
  let cursor: string | undefined;
  do {
    const page = await c.env.SCREENSHOTS.list({ prefix: `${p.id}/`, cursor });
    if (page.objects.length) await c.env.SCREENSHOTS.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Issues

app.get('/projects/:id/issues', async (c) => {
  const p = await projectFor(c.env, c.var.user.id, c.req.param('id'));
  if (!p) return notFound(c);
  const filter = c.req.query('status') || 'board';
  if (!Object.hasOwn(FILTERS, filter)) return apiError(c, 400, 'bad_request', `status must be one of ${Object.keys(FILTERS).join(', ')}`);
  const statuses = FILTERS[filter];
  const { results } = await c.env.DB.prepare(
    `SELECT i.*, (SELECT COUNT(*) FROM comments WHERE issue_id = i.id) AS comment_count FROM issues i
     WHERE i.project_id = ?${statuses ? ` AND i.status IN (${statuses.map(() => '?').join(', ')})` : ''} ORDER BY i.status_at DESC, i.number DESC`,
  )
    .bind(p.id, ...(statuses ?? []))
    .all<IssueRow & { comment_count: number }>();
  const issues: AppIssue[] = await Promise.all(results.map(async (r) => ({ ...here(await toAgentIssue(c.env, r)), projectId: p.id, commentCount: r.comment_count })));
  return c.json<AppIssuesResponse>({ issues });
});

app.get('/issues/:id', async (c) => {
  const found = await issueFor(c.env, c.var.user.id, c.req.param('id'));
  if (!found) return notFound(c, 'Issue');
  return c.json<AppIssueResponse>({ issue: await appIssueDetail(c, found.project, found.issue) });
});

const author = (c: Ctx) => c.var.user.name || c.var.user.email;

app.patch('/issues/:id', async (c) => {
  const found = await issueFor(c.env, c.var.user.id, c.req.param('id'));
  if (!found) return notFound(c, 'Issue');
  const { issue, project } = found;
  const body = await jsonBody(c);
  if (body instanceof Response) return body;
  const status = body.status as IssueStatus;
  if (!STATUSES.includes(status)) return apiError(c, 400, 'bad_request', `status must be one of ${STATUSES.join(', ')}`);
  const text = typeof body.comment === 'string' ? body.comment.trim() : '';
  if (text.length > MAX_TEXT) return apiError(c, 400, 'bad_request', `comment must be at most ${MAX_TEXT} characters`);
  if (project.role === 'client') {
    const confirm = issue.status === 'review' && status === 'resolved';
    const reopen = (issue.status === 'review' || issue.status === 'resolved') && status === 'new';
    if (!confirm && !reopen) return apiError(c, 403, 'forbidden', 'Clients can confirm a fix or reopen an issue');
    if (reopen && !text) return apiError(c, 400, 'bad_request', "Say what's still wrong");
  }
  if (status !== issue.status || text) {
    await setStatus(c.env, project, issue, status, {
      // Moving an issue off "In progress" by hand drops the agent's claim.
      clearClaim: status !== 'in_progress',
      ...(text ? { comment: { via: 'app', author: author(c), email: c.var.user.email, userId: c.var.user.id, text } } : {}),
    });
  }
  const row = (await c.env.DB.prepare('SELECT * FROM issues WHERE id = ?').bind(issue.id).first<IssueRow>())!;
  return c.json<AppIssueResponse>({ issue: await appIssueDetail(c, project, row) });
});

app.post('/issues/:id/comments', async (c) => {
  const found = await issueFor(c.env, c.var.user.id, c.req.param('id'));
  if (!found) return notFound(c, 'Issue');
  const body = await jsonBody(c);
  if (body instanceof Response) return body;
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return apiError(c, 400, 'bad_request', 'text is required');
  if (text.length > MAX_TEXT) return apiError(c, 400, 'bad_request', `text must be at most ${MAX_TEXT} characters`);
  await addComment(c.env, found.project, found.issue, { via: 'app', author: author(c), email: c.var.user.email, userId: c.var.user.id, text });
  const row = (await c.env.DB.prepare('SELECT * FROM issues WHERE id = ?').bind(found.issue.id).first<IssueRow>())!;
  return c.json<AppIssueResponse>({ issue: await appIssueDetail(c, found.project, row) }, 201);
});

// ---------------------------------------------------------------------------
// Agent tokens (what `annotate` and `annotate watch` authenticate with)

async function memberProject(c: Ctx): Promise<ScopedProject | Response> {
  const p = await projectFor(c.env, c.var.user.id, c.req.param('id') ?? '');
  if (!p) return notFound(c);
  return needRole(c, p.role, 'member') ?? p;
}

app.get('/projects/:id/tokens', async (c) => {
  const p = await memberProject(c);
  if (p instanceof Response) return p;
  return c.json<AppAgentTokensResponse>({ tokens: await tokens(c, p.id) });
});

app.post('/projects/:id/tokens', async (c) => {
  const p = await memberProject(c);
  if (p instanceof Response) return p;
  const body = await jsonBody(c);
  if (body instanceof Response) return body;
  const label = cleanName(body.label) || 'dashboard';
  const { token, id } = await mintAgentToken(c.env, p.id, label, c.var.user.id);
  const config = {
    endpoint: publicBase(c.env),
    projectKey: p.public_key,
    agentToken: token,
    projectName: p.name,
    boardName: boardName(p),
    boardUrl: boardUrl(c.env, p),
  };
  return c.json<AppNewAgentTokenResponse>({ token: (await tokens(c, p.id)).find((t) => t.id === id)!, config: `${JSON.stringify(config, null, 2)}\n` }, 201);
});

app.delete('/projects/:id/tokens/:tokenId', async (c) => {
  const p = await memberProject(c);
  if (p instanceof Response) return p;
  const row = await c.env.DB.prepare('SELECT created_by FROM agent_tokens WHERE id = ? AND project_id = ?').bind(c.req.param('tokenId'), p.id).first<{ created_by: string | null }>();
  if (!row) return notFound(c, 'Token');
  if (row.created_by !== c.var.user.id && !atLeast(p.role, 'admin')) return apiError(c, 403, 'forbidden', 'Only admins can revoke tokens other people made');
  await c.env.DB.prepare('UPDATE agent_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?').bind(nowIso(), c.req.param('tokenId')).run();
  return c.json<AppAgentTokensResponse>({ tokens: await tokens(c, p.id) });
});

export default app;

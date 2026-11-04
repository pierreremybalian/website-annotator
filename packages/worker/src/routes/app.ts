// /v1/app/*: the dashboard's JSON API. Session cookie auth (src/session.ts), same-origin writes only, and every
// org, project and issue loaded through src/access.ts. Out-of-scope ids answer 404 like missing ones.

import { Hono, type Context } from 'hono';
import type { AppInviteRequest, AppMe, AppMember, AppMembersResponse, AppOrg, Role } from '@annotate/shared';
import type { AppEnv } from '../env';
import { nowIso, randomId, type UserRow } from '../db';
import { apiError } from '../auth';
import { requireUser, sameOrigin } from '../session';
import { atLeast, orgRole, orgsFor } from '../access';
import { DAY, hit } from '../rate-limit';
import { MailError, sendMail, simpleHtml } from '../mail';
import { createLoginToken, normalizeEmail, signupOpen, validEmail } from './auth';

const ROLES: readonly Role[] = ['owner', 'admin', 'member', 'client'];
const MAX_NAME = 100;

type Ctx = Context<AppEnv>;
type Body = Record<string, unknown>;

async function jsonBody(c: Ctx): Promise<Body | Response> {
  const body = await c.req.json<unknown>().catch(() => null);
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Body) : apiError(c, 400, 'bad_request', 'Expected a JSON object');
}

const cleanName = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME) : '');

/** The caller's role in :org, or a 404 response. */
async function orgAccess(c: Ctx, min: Role): Promise<{ orgId: string; role: Role } | Response> {
  const orgId = c.req.param('org') ?? '';
  const role = await orgRole(c.env, c.var.user.id, orgId);
  if (!role) return apiError(c, 404, 'not_found', 'Organization not found');
  if (!atLeast(role, min)) return apiError(c, 403, 'forbidden', `Only ${min === 'owner' ? 'owners' : `${min}s and up`} can do that`);
  return { orgId, role };
}

async function members(c: Ctx, orgId: string): Promise<AppMember[]> {
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.email_verified_at, m.role, m.created_at,
       (SELECT json_group_array(pm.project_id) FROM project_members pm JOIN projects p ON p.id = pm.project_id
         WHERE pm.user_id = u.id AND p.org_id = m.org_id) AS project_ids
     FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY m.created_at`,
  )
    .bind(orgId)
    .all<{ id: string; email: string; name: string; email_verified_at: string | null; role: Role; created_at: string; project_ids: string }>();
  return results.map((r) => ({
    userId: r.id,
    email: r.email,
    name: r.name,
    role: r.role,
    verified: !!r.email_verified_at,
    projectIds: r.role === 'client' ? (JSON.parse(r.project_ids) as string[]) : [],
    createdAt: r.created_at,
  }));
}

/** projectIds that all belong to the org, or an error message. */
async function orgProjectIds(c: Ctx, orgId: string, raw: unknown): Promise<string[] | string> {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 200 || !raw.every((v) => typeof v === 'string')) return 'projectIds must be a list of project ids';
  const ids = [...new Set(raw as string[])];
  if (!ids.length) return ids;
  const { results } = await c.env.DB.prepare(`SELECT id FROM projects WHERE org_id = ? AND id IN (${ids.map(() => '?').join(', ')})`)
    .bind(orgId, ...ids)
    .all<{ id: string }>();
  return results.length === ids.length ? ids : 'Some of those projects are not in this organization';
}

const ownerCount = async (c: Ctx, orgId: string) =>
  (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM memberships WHERE org_id = ? AND role = 'owner'").bind(orgId).first<{ n: number }>())!.n;

const app = new Hono<AppEnv>();

app.use('*', sameOrigin, requireUser);

app.get('/me', async (c) => {
  const u = c.var.user;
  const orgs: AppOrg[] = await orgsFor(c.env, u.id);
  return c.json<AppMe>({ user: { id: u.id, email: u.email, name: u.name }, orgs, canCreateOrg: signupOpen(c.env) });
});

app.patch('/me', async (c) => {
  const body = await jsonBody(c);
  if (body instanceof Response) return body;
  const name = cleanName(body.name);
  await c.env.DB.prepare('UPDATE users SET name = ? WHERE id = ?').bind(name, c.var.user.id).run();
  return c.json({ ok: true });
});

app.post('/orgs', async (c) => {
  if (!signupOpen(c.env)) return apiError(c, 403, 'forbidden', 'New organizations are by invitation for now');
  const body = await jsonBody(c);
  if (body instanceof Response) return body;
  const name = cleanName(body.name);
  if (!name) return apiError(c, 400, 'bad_request', 'name is required');
  if (!(await hit(c.env, `org-create:${c.var.user.id}`, 5, DAY))) return apiError(c, 429, 'rate_limited', 'Too many new organizations today');
  const id = randomId();
  const now = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO orgs (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').bind(id, name, now, now),
    c.env.DB.prepare("INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").bind(id, c.var.user.id, now),
  ]);
  return c.json<AppOrg>({ id, name, role: 'owner' }, 201);
});

app.patch('/orgs/:org', async (c) => {
  const access = await orgAccess(c, 'owner');
  if (access instanceof Response) return access;
  const body = await jsonBody(c);
  if (body instanceof Response) return body;
  const name = cleanName(body.name);
  if (!name) return apiError(c, 400, 'bad_request', 'name is required');
  await c.env.DB.prepare('UPDATE orgs SET name = ?, updated_at = ? WHERE id = ?').bind(name, nowIso(), access.orgId).run();
  return c.json<AppOrg>({ id: access.orgId, name, role: access.role });
});

app.get('/orgs/:org/members', async (c) => {
  const access = await orgAccess(c, 'member');
  if (access instanceof Response) return access;
  return c.json<AppMembersResponse>({ members: await members(c, access.orgId) });
});

app.post('/orgs/:org/members', async (c) => {
  const access = await orgAccess(c, 'admin');
  if (access instanceof Response) return access;
  const body = (await jsonBody(c)) as Partial<AppInviteRequest> | Response;
  if (body instanceof Response) return body;
  const email = typeof body.email === 'string' ? normalizeEmail(body.email) : '';
  if (!validEmail(email)) return apiError(c, 400, 'bad_request', 'A valid email is required');
  if (!ROLES.includes(body.role as Role)) return apiError(c, 400, 'bad_request', `role must be one of ${ROLES.join(', ')}`);
  const role = body.role as Role;
  if (role === 'owner' && access.role !== 'owner') return apiError(c, 403, 'forbidden', 'Only owners can add owners');
  const projectIds = await orgProjectIds(c, access.orgId, body.projectIds);
  if (typeof projectIds === 'string') return apiError(c, 400, 'bad_request', projectIds);
  if (role === 'client' && !projectIds.length) return apiError(c, 400, 'bad_request', 'Pick the projects this client sees');
  if (!(await hit(c.env, `invite:${access.orgId}`, 50, DAY))) return apiError(c, 429, 'rate_limited', 'Too many invitations today');

  const now = nowIso();
  await c.env.DB.prepare('INSERT OR IGNORE INTO users (id, email, created_at) VALUES (?, ?, ?)').bind(randomId(), email, now).run();
  const user = (await c.env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<UserRow>())!;
  const existing = await orgRole(c.env, user.id, access.orgId);
  if (existing) return apiError(c, 409, 'bad_request', `${email} is already a member (${existing})`);
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?)').bind(access.orgId, user.id, role, now),
    ...(role === 'client' ? projectIds : []).map((pid) => c.env.DB.prepare('INSERT OR IGNORE INTO project_members (project_id, user_id, created_at) VALUES (?, ?, ?)').bind(pid, user.id, now)),
  ]);

  const org = (await c.env.DB.prepare('SELECT name FROM orgs WHERE id = ?').bind(access.orgId).first<{ name: string }>())!;
  const inviter = c.var.user.name || c.var.user.email;
  const { link } = await createLoginToken(c.env, email, 'invite', new URL(c.req.url).origin, '/app/');
  let emailed = true;
  try {
    await sendMail(c.env, {
      to: email,
      subject: `${inviter} invited you to ${org.name} on Annotate`,
      text: `${inviter} invited you to ${org.name} on Annotate, where website feedback and fixes are tracked.\n\nAccept the invitation:\n${link}\n\nThe link works once, for 7 days. Later, log in with your email at ${new URL(c.req.url).origin}/login`,
      html: simpleHtml(
        [`${inviter} invited you to ${org.name} on Annotate, where website feedback and fixes are tracked.`],
        { label: 'Accept the invitation', url: link },
        'The link works once, for 7 days. After that, log in with your email address.',
      ),
    });
  } catch (e) {
    if (!(e instanceof MailError)) throw e;
    console.error('invite email failed', e);
    emailed = false;
  }
  const member = (await members(c, access.orgId)).find((m) => m.userId === user.id)!;
  return c.json({ member, emailed }, 201);
});

app.patch('/orgs/:org/members/:userId', async (c) => {
  const access = await orgAccess(c, 'admin');
  if (access instanceof Response) return access;
  const userId = c.req.param('userId');
  const current = await orgRole(c.env, userId, access.orgId);
  if (!current) return apiError(c, 404, 'not_found', 'Member not found');
  const body = await jsonBody(c);
  if (body instanceof Response) return body;
  const role = (body.role ?? current) as Role;
  if (!ROLES.includes(role)) return apiError(c, 400, 'bad_request', `role must be one of ${ROLES.join(', ')}`);
  if ((role === 'owner' || current === 'owner') && access.role !== 'owner') return apiError(c, 403, 'forbidden', 'Only owners can change owners');
  if (current === 'owner' && role !== 'owner' && (await ownerCount(c, access.orgId)) <= 1) {
    return apiError(c, 409, 'bad_request', 'An organization needs at least one owner');
  }
  const projectIds = await orgProjectIds(c, access.orgId, body.projectIds);
  if (typeof projectIds === 'string') return apiError(c, 400, 'bad_request', projectIds);
  if (role === 'client' && body.projectIds !== undefined && !projectIds.length) return apiError(c, 400, 'bad_request', 'Pick the projects this client sees');

  const now = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE memberships SET role = ? WHERE org_id = ? AND user_id = ?').bind(role, access.orgId, userId),
    // Project access only means something for clients; other roles see the whole org.
    ...(role !== 'client' || body.projectIds !== undefined
      ? [c.env.DB.prepare('DELETE FROM project_members WHERE user_id = ? AND project_id IN (SELECT id FROM projects WHERE org_id = ?)').bind(userId, access.orgId)]
      : []),
    ...(role === 'client' ? projectIds : []).map((pid) => c.env.DB.prepare('INSERT OR IGNORE INTO project_members (project_id, user_id, created_at) VALUES (?, ?, ?)').bind(pid, userId, now)),
  ]);
  return c.json({ member: (await members(c, access.orgId)).find((m) => m.userId === userId)! });
});

app.delete('/orgs/:org/members/:userId', async (c) => {
  const userId = c.req.param('userId');
  // Anyone may leave; removing someone else takes an admin.
  const access = await orgAccess(c, userId === c.var.user.id ? 'client' : 'admin');
  if (access instanceof Response) return access;
  const current = await orgRole(c.env, userId, access.orgId);
  if (!current) return apiError(c, 404, 'not_found', 'Member not found');
  if (current === 'owner' && access.role !== 'owner') return apiError(c, 403, 'forbidden', 'Only owners can remove owners');
  if (current === 'owner' && (await ownerCount(c, access.orgId)) <= 1) return apiError(c, 409, 'bad_request', 'An organization needs at least one owner');
  const now = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM memberships WHERE org_id = ? AND user_id = ?').bind(access.orgId, userId),
    c.env.DB.prepare('DELETE FROM project_members WHERE user_id = ? AND project_id IN (SELECT id FROM projects WHERE org_id = ?)').bind(userId, access.orgId),
    // Their agents lose access to the org's projects too.
    c.env.DB.prepare('UPDATE agent_tokens SET revoked_at = ? WHERE created_by = ? AND revoked_at IS NULL AND project_id IN (SELECT id FROM projects WHERE org_id = ?)').bind(now, userId, access.orgId),
  ]);
  return c.json({ ok: true });
});

export default app;

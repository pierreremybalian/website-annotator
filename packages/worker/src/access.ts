// Who may see what. The /v1/app routes load orgs, projects and issues only through these, so every query is
// scoped to the caller's memberships. The org always comes from the row, never from the request. Anything
// out of reach is reported as not found, so ids from other tenants don't leak.

import type { Role } from '@annotate/shared';
import type { Env } from './env';
import type { IssueRow, ProjectRow } from './db';

const RANK: Record<Role, number> = { client: 0, member: 1, admin: 2, owner: 3 };

/** Whether `role` is at least `min`. */
export const atLeast = (role: Role, min: Role) => RANK[role] >= RANK[min];

export async function orgRole(env: Env, userId: string, orgId: string): Promise<Role | null> {
  const row = await env.DB.prepare('SELECT role FROM memberships WHERE org_id = ? AND user_id = ?').bind(orgId, userId).first<{ role: Role }>();
  return row?.role ?? null;
}

export async function orgsFor(env: Env, userId: string): Promise<{ id: string; name: string; role: Role }[]> {
  const { results } = await env.DB.prepare('SELECT o.id, o.name, m.role FROM memberships m JOIN orgs o ON o.id = m.org_id WHERE m.user_id = ? ORDER BY o.name COLLATE NOCASE')
    .bind(userId)
    .all<{ id: string; name: string; role: Role }>();
  return results;
}

export type ScopedProject = ProjectRow & { role: Role };

/** The project, with the caller's role in its org, if the caller may see it. */
export function projectFor(env: Env, userId: string, projectId: string): Promise<ScopedProject | null> {
  return env.DB.prepare(
    `SELECT p.*, m.role FROM projects p JOIN memberships m ON m.org_id = p.org_id AND m.user_id = ?1
     WHERE p.id = ?2 AND (m.role <> 'client' OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = ?1))`,
  )
    .bind(userId, projectId)
    .first<ScopedProject>();
}

/** The projects of an org the caller may see. */
export async function projectsFor(env: Env, userId: string, orgId: string): Promise<ScopedProject[]> {
  const { results } = await env.DB.prepare(
    `SELECT p.*, m.role FROM projects p JOIN memberships m ON m.org_id = p.org_id AND m.user_id = ?1
     WHERE p.org_id = ?2 AND (m.role <> 'client' OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = ?1))
     ORDER BY p.name COLLATE NOCASE`,
  )
    .bind(userId, orgId)
    .all<ScopedProject>();
  return results;
}

/** The issue and its project, if the caller may see the project. */
export async function issueFor(env: Env, userId: string, issueId: string): Promise<{ issue: IssueRow; project: ScopedProject } | null> {
  const issue = await env.DB.prepare('SELECT * FROM issues WHERE id = ?').bind(issueId).first<IssueRow>();
  const project = issue && (await projectFor(env, userId, issue.project_id));
  return issue && project ? { issue, project } : null;
}

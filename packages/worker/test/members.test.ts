import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { AppMe, AppMember, AppMembersResponse, ApiError } from '@annotate/shared';
import { nowIso, randomId } from '../src/db';
import { Browser, lastLink, lastMail, seedOrg, seedProject, uniqueEmail } from './browser';

async function ownerBrowser(name = 'Agency') {
  const org = await seedOrg(name);
  const b = new Browser();
  await b.login(org.ownerEmail);
  return { ...org, b };
}

const invite = (b: Browser, orgId: string, body: object) => b.post(`/v1/app/orgs/${orgId}/members`, body);
const membersOf = async (b: Browser, orgId: string) => (await (await b.fetch(`/v1/app/orgs/${orgId}/members`)).json<AppMembersResponse>()).members;
const count = async (table: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;

describe('inviting people', () => {
  it('invites by email; the link logs them in as a member of the org', async () => {
    const { orgId, b } = await ownerBrowser('Balian Design');
    const email = uniqueEmail('dev');
    const res = await invite(b, orgId, { email: email.toUpperCase(), role: 'member' });
    expect(res.status).toBe(201);
    const { member, emailed } = await res.json<{ member: AppMember; emailed: boolean }>();
    expect(member).toMatchObject({ email, role: 'member', verified: false, projectIds: [] });
    expect(emailed).toBe(true);
    expect(lastMail(email)!.subject).toBe('Balian Design Owner invited you to Balian Design on Annotate');

    const invitee = new Browser();
    expect((await invitee.post('/login/verify', { t: new URL(lastLink(email)).searchParams.get('t') })).status).toBe(200);
    expect((await (await invitee.fetch('/v1/app/me')).json<AppMe>()).orgs).toEqual([{ id: orgId, name: 'Balian Design', role: 'member' }]);
    expect((await membersOf(b, orgId)).find((m) => m.email === email)!.verified).toBe(true);
    // Invited people can also log in with a code later, signup closed or not.
    await new Browser().login(email);
  });

  it('gives clients only the projects picked for them, from this org', async () => {
    const { orgId, b } = await ownerBrowser();
    const site = await seedProject(orgId, 'Client site');
    const other = await seedOrg();
    const foreign = await seedProject(other.orgId, 'Someone else’s');
    const email = uniqueEmail('client');
    expect((await invite(b, orgId, { email, role: 'client' })).status).toBe(400);
    expect((await invite(b, orgId, { email, role: 'client', projectIds: [foreign.id] })).status).toBe(400);
    const res = await invite(b, orgId, { email, role: 'client', projectIds: [site.id] });
    expect(res.status).toBe(201);
    expect((await res.json<{ member: AppMember }>()).member).toMatchObject({ role: 'client', projectIds: [site.id] });
  });

  it('refuses duplicates, bad roles and members who try to invite', async () => {
    const { orgId, b, ownerEmail } = await ownerBrowser();
    expect((await invite(b, orgId, { email: ownerEmail, role: 'member' })).status).toBe(409);
    expect((await invite(b, orgId, { email: uniqueEmail(), role: 'boss' })).status).toBe(400);
    const email = uniqueEmail('member');
    await invite(b, orgId, { email, role: 'member' });
    const member = new Browser();
    await member.login(email);
    expect((await invite(member, orgId, { email: uniqueEmail(), role: 'member' })).status).toBe(403);
    expect((await membersOf(member, orgId)).length).toBe(2);
  });
});

describe('roles', () => {
  async function withAdmin() {
    const o = await ownerBrowser();
    const adminEmail = uniqueEmail('admin');
    await invite(o.b, o.orgId, { email: adminEmail, role: 'admin' });
    const admin = new Browser();
    await admin.login(adminEmail);
    const adminId = (await membersOf(o.b, o.orgId)).find((m) => m.email === adminEmail)!.userId;
    return { ...o, admin, adminId };
  }

  it('lets admins manage members but not owners', async () => {
    const { orgId, ownerId, admin } = await withAdmin();
    expect((await invite(admin, orgId, { email: uniqueEmail(), role: 'owner' })).status).toBe(403);
    const email = uniqueEmail('m');
    await invite(admin, orgId, { email, role: 'member' });
    const userId = (await membersOf(admin, orgId)).find((m) => m.email === email)!.userId;
    expect((await admin.fetch(`/v1/app/orgs/${orgId}/members/${userId}`, { method: 'PATCH', body: { role: 'admin' } })).status).toBe(200);
    expect((await admin.fetch(`/v1/app/orgs/${orgId}/members/${userId}`, { method: 'PATCH', body: { role: 'owner' } })).status).toBe(403);
    expect((await admin.fetch(`/v1/app/orgs/${orgId}/members/${ownerId}`, { method: 'PATCH', body: { role: 'member' } })).status).toBe(403);
    expect((await admin.fetch(`/v1/app/orgs/${orgId}/members/${ownerId}`, { method: 'DELETE' })).status).toBe(403);
  });

  it('keeps at least one owner', async () => {
    const { orgId, ownerId, b, adminId } = await withAdmin();
    expect((await b.fetch(`/v1/app/orgs/${orgId}/members/${ownerId}`, { method: 'PATCH', body: { role: 'admin' } })).status).toBe(409);
    expect((await b.fetch(`/v1/app/orgs/${orgId}/members/${ownerId}`, { method: 'DELETE' })).status).toBe(409);
    expect((await b.fetch(`/v1/app/orgs/${orgId}/members/${adminId}`, { method: 'PATCH', body: { role: 'owner' } })).status).toBe(200);
    expect((await b.fetch(`/v1/app/orgs/${orgId}/members/${ownerId}`, { method: 'PATCH', body: { role: 'admin' } })).status).toBe(200);
  });

  it('revokes the agent tokens of someone who is removed', async () => {
    const { orgId, b, adminId, admin } = await withAdmin();
    const site = await seedProject(orgId);
    await env.DB.prepare('INSERT INTO agent_tokens (id, project_id, token_hash, label, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(randomId(), site.id, randomId(), 'laptop', adminId, nowIso())
      .run();
    expect((await b.fetch(`/v1/app/orgs/${orgId}/members/${adminId}`, { method: 'DELETE' })).status).toBe(200);
    expect(await env.DB.prepare('SELECT revoked_at FROM agent_tokens WHERE created_by = ?').bind(adminId).first()).toMatchObject({ revoked_at: expect.any(String) });
    expect((await admin.fetch('/v1/app/me').then((r) => r.json<AppMe>())).orgs).toEqual([]);
  });
});

describe('tenant isolation', () => {
  it('gives another org’s admin nothing: 404 on every member route, and no rows change', async () => {
    const a = await ownerBrowser('Org A');
    const memberEmail = uniqueEmail('a-member');
    await invite(a.b, a.orgId, { email: memberEmail, role: 'member' });
    const aMember = (await membersOf(a.b, a.orgId)).find((m) => m.email === memberEmail)!.userId;
    const b = await ownerBrowser('Org B');

    const before = await Promise.all(['memberships', 'users', 'project_members', 'orgs'].map(count));
    const calls: [string, string, object?][] = [
      ['GET', `/v1/app/orgs/${a.orgId}/members`],
      ['POST', `/v1/app/orgs/${a.orgId}/members`, { email: uniqueEmail(), role: 'admin' }],
      ['PATCH', `/v1/app/orgs/${a.orgId}/members/${aMember}`, { role: 'owner' }],
      ['DELETE', `/v1/app/orgs/${a.orgId}/members/${aMember}`],
      ['PATCH', `/v1/app/orgs/${a.orgId}`, { name: 'Taken over' }],
    ];
    for (const [method, path, body] of calls) {
      const res = await b.b.fetch(path, { method, body });
      expect(res.status, `${method} ${path}`).toBe(404);
      expect((await res.json<ApiError>()).code).toBe('not_found');
    }
    expect(await Promise.all(['memberships', 'users', 'project_members', 'orgs'].map(count))).toEqual(before);
    for (const [method, path, body] of calls) expect((await new Browser().fetch(path, { method, body })).status).toBe(401);
  });
});

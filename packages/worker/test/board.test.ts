import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  HEADER_ACCESS,
  HEADER_PROJECT,
  type AgentProject,
  type AppIssueResponse,
  type AppIssuesResponse,
  type AppNewAgentTokenResponse,
  type AppProject,
  type AppProjectsResponse,
  type CreateIssueResponse,
} from '@annotate/shared';
import { encryptToken } from '../src/crypto';
import { nowIso } from '../src/db';
import { MOCK_TOKEN, mockTrelloState, resetMockTrello } from '../src/trello';
import { BASE, Browser, seedOrg, seedProject, uniqueEmail } from './browser';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 5, 6, 7, 8]);
const SITE = 'https://client.example';

/** A widget report on the project, as a client's browser would send it. */
async function report(p: { publicKey: string; accessKey: string }, title = 'Button overlaps footer'): Promise<CreateIssueResponse> {
  const form = new FormData();
  form.set(
    'meta',
    JSON.stringify({
      title,
      notes: 'Overlaps on narrow screens.',
      reporter: { name: 'Jane Client', email: 'jane@client.example' },
      anchor: { selector: '#buy', relative: { x: 0, y: 0, width: 1, height: 1 }, absolute: { x: 1, y: 2, width: 3, height: 4 }, viewportWidth: 1440, text: 'Buy' },
      env: { url: `${SITE}/pricing`, title: 'Pricing', referrer: '', viewport: { width: 1440, height: 900 }, dpr: 2, scroll: { x: 0, y: 0 }, userAgent: 'x', browser: 'Chrome', os: 'macOS', language: 'en', timestamp: nowIso(), consoleErrors: [] },
    }),
  );
  form.set('selection', new File([PNG], 's.png', { type: 'image/png' }));
  form.set('context', new File([JPEG], 'c.jpg', { type: 'image/jpeg' }));
  const res = await SELF.fetch(`${BASE}/v1/issues`, { method: 'POST', headers: { [HEADER_PROJECT]: p.publicKey, [HEADER_ACCESS]: p.accessKey, Origin: SITE }, body: form });
  expect(res.status).toBe(201);
  return res.json<CreateIssueResponse>();
}

async function agency(name: string) {
  const org = await seedOrg(name);
  const owner = new Browser();
  await owner.login(org.ownerEmail);
  return { ...org, owner };
}

beforeEach(() => resetMockTrello());

describe('projects', () => {
  it('creates a project without Trello, with its install snippet, and lists it with counts', async () => {
    const { orgId, owner } = await agency('Balian Design');
    const res = await owner.post(`/v1/app/orgs/${orgId}/projects`, { name: ' Strauss  Houses ', origins: ['https://strausshouses.balian.dev/', 'https://strausshouses.com'] });
    expect(res.status).toBe(201);
    const project = await res.json<AppProject>();
    expect(project).toMatchObject({ name: 'Strauss Houses', orgId, role: 'owner', origins: ['https://strausshouses.balian.dev', 'https://strausshouses.com'], trello: null });
    expect(project.install!.snippet).toBe(`<script src="http://localhost:8787/widget.js" data-endpoint="http://localhost:8787" data-project="${project.install!.projectKey}" defer></script>`);

    const { projects } = await (await owner.fetch(`/v1/app/orgs/${orgId}/projects`)).json<AppProjectsResponse>();
    expect(projects.map((p) => p.name)).toEqual(['Strauss Houses']);

    expect((await owner.post(`/v1/app/orgs/${orgId}/projects`, { name: 'x', origins: ['not a url'] })).status).toBe(400);
    expect((await owner.post(`/v1/app/orgs/${orgId}/projects`, { name: 'x', origins: [] })).status).toBe(400);
  });

  it('updates settings and deletes a project with its issues and screenshots (admins only)', async () => {
    const { orgId, owner } = await agency('Agency');
    const p = await seedProject(orgId);
    const created = await report(p);
    const patched = await (await owner.fetch(`/v1/app/projects/${p.id}`, { method: 'PATCH', body: { name: 'Renamed', origins: [SITE, 'http://localhost:3000'], ignoreQuery: true } })).json<AppProject>();
    expect(patched).toMatchObject({ name: 'Renamed', origins: [SITE, 'http://localhost:3000'], ignoreQuery: true, counts: { new: 1 } });

    const memberEmail = uniqueEmail('member');
    await owner.post(`/v1/app/orgs/${orgId}/members`, { email: memberEmail, role: 'member' });
    const member = new Browser();
    await member.login(memberEmail);
    expect((await member.fetch(`/v1/app/projects/${p.id}`, { method: 'DELETE' })).status).toBe(403);

    expect((await owner.fetch(`/v1/app/projects/${p.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(await env.DB.prepare('SELECT id FROM issues WHERE id = ?').bind(created.id).first()).toBeNull();
    expect((await env.SCREENSHOTS.list({ prefix: `${p.id}/` })).objects).toHaveLength(0);
    expect((await owner.fetch(`/v1/app/projects/${p.id}`)).status).toBe(404);
  });
});

describe('board', () => {
  it('lists issues, moves them, comments, and the widget sees the same thing', async () => {
    const { orgId, owner } = await agency('Agency');
    const p = await seedProject(orgId);
    const created = await report(p);
    await report(p, 'Logo blurry');

    const { issues } = await (await owner.fetch(`/v1/app/projects/${p.id}/issues`)).json<AppIssuesResponse>();
    expect(issues.map((i) => [i.number, i.status, i.commentCount])).toEqual([
      [2, 'new', 0],
      [1, 'new', 0],
    ]);
    expect(issues[0]!.screenshotUrl).toMatch(/^\/v1\/screenshots\/.+\?exp=\d+\&sig=/);

    const moved = await owner.fetch(`/v1/app/issues/${created.id}`, { method: 'PATCH', body: { status: 'review', comment: 'Fixed on staging, can you check?' } });
    expect(moved.status).toBe(200);
    const { issue } = await moved.json<AppIssueResponse>();
    expect(issue).toMatchObject({ status: 'review', reporterEmail: 'jane@client.example' });
    expect(issue.comments.at(-1)).toMatchObject({ author: 'Agency Owner', via: 'app', text: 'Fixed on staging, can you check?' });

    expect((await owner.post(`/v1/app/issues/${created.id}/comments`, { text: 'Also on tablet.' })).status).toBe(201);
    const widget = await (await SELF.fetch(`${BASE}/v1/issues/${created.id}`, { headers: { [HEADER_PROJECT]: p.publicKey, [HEADER_ACCESS]: p.accessKey, Origin: SITE } })).json<{ issue: { status: string; comments: { text: string }[] } }>();
    expect(widget.issue.status).toBe('review');
    expect(widget.issue.comments.map((c) => c.text)).toEqual(['Fixed on staging, can you check?', 'Also on tablet.']);
    expect((await owner.fetch(`/v1/app/issues/${created.id}`, { method: 'PATCH', body: { status: 'done' } })).status).toBe(400);
  });

  it('drops an agent’s claim when a person moves the issue off In progress', async () => {
    const { orgId, owner } = await agency('Agency');
    const p = await seedProject(orgId);
    const created = await report(p);
    await env.DB.prepare("UPDATE issues SET status = 'in_progress', claimed_by = 'claude', claimed_until = ? WHERE id = ?").bind(Date.now() + 60_000, created.id).run();
    const { issue } = await (await owner.fetch(`/v1/app/issues/${created.id}`, { method: 'PATCH', body: { status: 'new' } })).json<AppIssueResponse>();
    expect(issue).toMatchObject({ status: 'new', claimedBy: null });
  });

  it('mirrors dashboard moves and comments to Trello for projects that sync', async () => {
    const { orgId, owner } = await agency('Agency');
    const p = await seedProject(orgId);
    await env.DB.prepare(
      `UPDATE projects SET trello_token_enc = ?, trello_member_id = 'member-1', trello_board_id = 'board-1', trello_board_name = 'Mock Board',
         trello_board_url = 'https://trello.com/b/mock1', new_list_id = 'list-1', done_list_ids = '["list-3"]' WHERE id = ?`,
    )
      .bind(await encryptToken(env, MOCK_TOKEN), p.id)
      .run();
    const created = await report(p);
    const cardId = (await env.DB.prepare('SELECT trello_card_id FROM issues WHERE id = ?').bind(created.id).first<{ trello_card_id: string }>())!.trello_card_id;
    await owner.fetch(`/v1/app/issues/${created.id}`, { method: 'PATCH', body: { status: 'review' } });
    const review = [...mockTrelloState().lists.values()].find((l) => l.name === 'Ready for review')!;
    expect(mockTrelloState().cards.get(cardId)!.idList).toBe(review.id);
    await owner.post(`/v1/app/issues/${created.id}/comments`, { text: 'Please check' });
    expect(mockTrelloState().comments.get(cardId)!.at(-1)!.data.text).toBe('**Agency Owner** (via Annotate): Please check');
    expect((await (await owner.fetch(`/v1/app/projects/${p.id}`)).json<AppProject>()).trello).toMatchObject({ boardName: 'Mock Board', revoked: false, error: null });
  });
});

describe('clients', () => {
  it('see only their projects, without keys, and can only confirm or reopen', async () => {
    const { orgId, owner } = await agency('Agency');
    const theirs = await seedProject(orgId, 'Their site');
    const other = await seedProject(orgId, 'Other client');
    const created = await report(theirs);
    const hidden = await report(other);
    const email = uniqueEmail('client');
    await owner.post(`/v1/app/orgs/${orgId}/members`, { email, role: 'client', projectIds: [theirs.id] });
    const client = new Browser();
    await client.login(email);

    const { projects } = await (await client.fetch(`/v1/app/orgs/${orgId}/projects`)).json<AppProjectsResponse>();
    expect(projects.map((p) => [p.name, p.role, p.install])).toEqual([['Their site', 'client', undefined]]);
    expect((await client.fetch(`/v1/app/projects/${other.id}`)).status).toBe(404);
    expect((await client.fetch(`/v1/app/issues/${hidden.id}`)).status).toBe(404);
    expect((await (await client.fetch(`/v1/app/issues/${created.id}`)).json<AppIssueResponse>()).issue.reporterEmail).toBeUndefined();
    expect((await client.fetch(`/v1/app/projects/${theirs.id}/tokens`)).status).toBe(403);
    expect((await client.fetch(`/v1/app/projects/${theirs.id}`, { method: 'PATCH', body: { name: 'Mine now' } })).status).toBe(403);

    expect((await client.fetch(`/v1/app/issues/${created.id}`, { method: 'PATCH', body: { status: 'in_progress' } })).status).toBe(403);
    await owner.fetch(`/v1/app/issues/${created.id}`, { method: 'PATCH', body: { status: 'review' } });
    expect((await client.fetch(`/v1/app/issues/${created.id}`, { method: 'PATCH', body: { status: 'new' } })).status).toBe(400);
    expect((await client.fetch(`/v1/app/issues/${created.id}`, { method: 'PATCH', body: { status: 'new', comment: 'Still overlaps' } })).status).toBe(200);
    await owner.fetch(`/v1/app/issues/${created.id}`, { method: 'PATCH', body: { status: 'review' } });
    expect((await client.fetch(`/v1/app/issues/${created.id}`, { method: 'PATCH', body: { status: 'resolved' } })).status).toBe(200);
    expect((await client.post(`/v1/app/issues/${created.id}/comments`, { text: 'Thanks!' })).status).toBe(201);
  });
});

describe('agent tokens', () => {
  it('mints a token with a ready .annotate.json that works with the agent API, and revokes it', async () => {
    const { orgId, owner, ownerEmail } = await agency('Agency');
    const p = await seedProject(orgId, 'Native site');
    const res = await owner.post(`/v1/app/projects/${p.id}/tokens`, { label: 'VPS' });
    expect(res.status).toBe(201);
    const { token, config } = await res.json<AppNewAgentTokenResponse>();
    expect(token).toMatchObject({ label: 'VPS', createdBy: ownerEmail, revokedAt: null });
    const cfg = JSON.parse(config) as { agentToken: string; projectKey: string; boardName: string };
    expect(cfg).toMatchObject({ projectKey: p.publicKey, boardName: 'Native site' });

    const agent = () => SELF.fetch(`${BASE}/v1/agent/project`, { headers: { Authorization: `Bearer ${cfg.agentToken}` } });
    expect((await (await agent()).json<AgentProject>()).name).toBe('Native site');
    expect((await owner.fetch(`/v1/app/projects/${p.id}/tokens/${token.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await agent()).status).toBe(401);
  });

  it('lets members revoke only their own tokens', async () => {
    const { orgId, owner } = await agency('Agency');
    const p = await seedProject(orgId);
    const ownersToken = (await (await owner.post(`/v1/app/projects/${p.id}/tokens`, { label: 'owner laptop' })).json<AppNewAgentTokenResponse>()).token;
    const email = uniqueEmail('member');
    await owner.post(`/v1/app/orgs/${orgId}/members`, { email, role: 'member' });
    const member = new Browser();
    await member.login(email);
    const mine = (await (await member.post(`/v1/app/projects/${p.id}/tokens`, { label: 'mine' })).json<AppNewAgentTokenResponse>()).token;
    expect((await member.fetch(`/v1/app/projects/${p.id}/tokens/${ownersToken.id}`, { method: 'DELETE' })).status).toBe(403);
    expect((await member.fetch(`/v1/app/projects/${p.id}/tokens/${mine.id}`, { method: 'DELETE' })).status).toBe(200);
  });
});

describe('tenant isolation', () => {
  it('gives another org nothing on any project, issue or token route, and changes nothing', async () => {
    const a = await agency('Org A');
    const p = await seedProject(a.orgId, 'A site');
    const issue = await report(p);
    const token = (await (await a.owner.post(`/v1/app/projects/${p.id}/tokens`, { label: 'a' })).json<AppNewAgentTokenResponse>()).token;
    const b = await agency('Org B');

    const state = async () => {
      const rows = await env.DB.prepare(
        `SELECT (SELECT COUNT(*) FROM projects) p, (SELECT COUNT(*) FROM issues) i, (SELECT COUNT(*) FROM comments) c, (SELECT COUNT(*) FROM agent_tokens) t,
           (SELECT COUNT(*) FROM agent_tokens WHERE revoked_at IS NOT NULL) r, (SELECT MAX(updated_at) FROM projects) pu, (SELECT MAX(updated_at) FROM issues) iu`,
      ).first();
      return { rows, seq: mockTrelloState().seq, objects: (await env.SCREENSHOTS.list({ prefix: `${p.id}/` })).objects.length };
    };
    const before = await state();
    const calls: [string, string, object?][] = [
      ['GET', `/v1/app/orgs/${a.orgId}/projects`],
      ['POST', `/v1/app/orgs/${a.orgId}/projects`, { name: 'Sneaky', origins: [SITE] }],
      ['GET', `/v1/app/projects/${p.id}`],
      ['PATCH', `/v1/app/projects/${p.id}`, { name: 'Mine' }],
      ['DELETE', `/v1/app/projects/${p.id}`],
      ['GET', `/v1/app/projects/${p.id}/issues`],
      ['GET', `/v1/app/issues/${issue.id}`],
      ['PATCH', `/v1/app/issues/${issue.id}`, { status: 'resolved' }],
      ['POST', `/v1/app/issues/${issue.id}/comments`, { text: 'hi' }],
      ['GET', `/v1/app/projects/${p.id}/tokens`],
      ['POST', `/v1/app/projects/${p.id}/tokens`, { label: 'b' }],
      ['DELETE', `/v1/app/projects/${p.id}/tokens/${token.id}`],
    ];
    for (const [method, path, body] of calls) {
      const res = await b.owner.fetch(path, { method, body });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    for (const [method, path, body] of calls) expect((await new Browser().fetch(path, { method, body })).status, `${method} ${path} logged out`).toBe(401);
    expect(await state()).toEqual(before);
  });

  it('keeps project ids from another org out of an org-scoped request', async () => {
    const a = await agency('Org A');
    const b = await agency('Org B');
    const theirs = await seedProject(b.orgId, 'B site');
    const res = await a.owner.post(`/v1/app/orgs/${a.orgId}/members`, { email: uniqueEmail(), role: 'client', projectIds: [theirs.id] });
    expect(res.status).toBe(400);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM project_members WHERE project_id = ?').bind(theirs.id).first()).toEqual({ n: 0 });
  });
});

import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { HEADER_ACCESS, HEADER_PROJECT, type ApiError } from '@annotate/shared';
import { encryptToken } from '../src/crypto';
import { randomId } from '../src/db';
import { MOCK_TOKEN, resetMockTrello } from '../src/trello';

const BASE = 'http://worker.test';
const ORIGIN = 'https://client.example';

async function createProject(allowedOrigins: string[] = [ORIGIN]) {
  const id = randomId();
  const publicKey = `pk-${randomId(6)}`;
  const accessKey = `ak-${randomId(12)}`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO projects (id, name, public_key, access_key, allowed_origins, trello_token_enc, trello_member_id,
       trello_board_id, trello_board_name, trello_board_url, new_list_id, done_list_ids, created_at, updated_at)
     VALUES (?, 'Auth test', ?, ?, ?, ?, 'member-1', 'board-1', 'Mock Board', 'https://trello.com/b/mock1/mock-board', 'list-1', '["list-3"]', ?, ?)`,
  )
    .bind(id, publicKey, accessKey, JSON.stringify(allowedOrigins), await encryptToken(env, MOCK_TOKEN), now, now)
    .run();
  return { id, publicKey, accessKey };
}

const get = (path: string, headers: Record<string, string>) => SELF.fetch(`${BASE}${path}`, { headers });

beforeEach(() => resetMockTrello());

describe('v1Cors', () => {
  it('answers preflight for any Origin', async () => {
    const res = await SELF.fetch(`${BASE}/v1/issues`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://anything.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-annotate-project' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://anything.example');
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, OPTIONS');
    const allowHeaders = res.headers.get('Access-Control-Allow-Headers')!.toLowerCase();
    for (const h of ['content-type', HEADER_PROJECT.toLowerCase(), HEADER_ACCESS.toLowerCase()]) expect(allowHeaders).toContain(h);
    expect(res.headers.get('Access-Control-Max-Age')).toBe('86400');
    expect(res.headers.get('Vary')).toContain('Origin');
  });

  it('answers preflight on nested paths too', async () => {
    const res = await SELF.fetch(`${BASE}/v1/issues/abc/comments`, { method: 'OPTIONS', headers: { Origin: ORIGIN } });
    expect(res.status).toBe(204);
  });

  it('reflects the Origin on normal responses, including errors', async () => {
    const res = await get('/v1/project', { Origin: 'https://evil.example' });
    expect(res.status).toBe(401);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://evil.example');
    expect(res.headers.get('Vary')).toContain('Origin');
  });
});

describe('requireProject', () => {
  it('401s without keys', async () => {
    const res = await get('/v1/project', {});
    expect(res.status).toBe(401);
    expect(await res.json<ApiError>()).toMatchObject({ code: 'unauthorized' });
  });

  it('401s on an unknown project', async () => {
    const res = await get('/v1/project', { [HEADER_PROJECT]: 'nope', [HEADER_ACCESS]: 'nope' });
    expect(res.status).toBe(401);
    expect(await res.json<ApiError>()).toMatchObject({ code: 'unauthorized' });
  });

  it('401s on a bad access key', async () => {
    const p = await createProject();
    const res = await get('/v1/project', { [HEADER_PROJECT]: p.publicKey, [HEADER_ACCESS]: `${p.accessKey}x`, Origin: ORIGIN });
    expect(res.status).toBe(401);
    expect(await res.json<ApiError>()).toMatchObject({ code: 'unauthorized' });
  });

  it('403s on a disallowed Origin', async () => {
    const p = await createProject();
    const res = await get('/v1/issues?url=https://client.example/', { [HEADER_PROJECT]: p.publicKey, [HEADER_ACCESS]: p.accessKey, Origin: 'https://other.example' });
    expect(res.status).toBe(403);
    expect(await res.json<ApiError>()).toMatchObject({ code: 'forbidden_origin' });
  });

  it('403s on Origin: null', async () => {
    const p = await createProject();
    const res = await get('/v1/project', { [HEADER_PROJECT]: p.publicKey, [HEADER_ACCESS]: p.accessKey, Origin: 'null' });
    expect(res.status).toBe(403);
  });

  it('accepts an allowed Origin and reflects it', async () => {
    const p = await createProject();
    const res = await get('/v1/project', { [HEADER_PROJECT]: p.publicKey, [HEADER_ACCESS]: p.accessKey, Origin: ORIGIN });
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
  });

  it('compares origins canonically (case, trailing slash, default port)', async () => {
    const p = await createProject(['https://Client.Example:443/']);
    const res = await get('/v1/project', { [HEADER_PROJECT]: p.publicKey, [HEADER_ACCESS]: p.accessKey, Origin: ORIGIN });
    expect(res.status).toBe(200);
  });

  it('allows a missing Origin (server-to-server from the WP plugin)', async () => {
    const p = await createProject();
    const res = await get('/v1/project', { [HEADER_PROJECT]: p.publicKey, [HEADER_ACCESS]: p.accessKey });
    expect(res.status).toBe(200);
  });
});

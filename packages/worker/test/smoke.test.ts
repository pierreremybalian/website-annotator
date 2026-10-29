import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { decryptToken, encryptToken } from '../src/crypto';

describe('smoke', () => {
  it('serves /health', async () => {
    const res = await SELF.fetch('http://example.com/health');
    expect(await res.json()).toEqual({ ok: true });
  });

  it('has migrated tables', async () => {
    const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(expect.arrayContaining(['projects', 'issues', 'connect_sessions']));
  });

  it('round-trips token encryption', async () => {
    const enc = await encryptToken(env, 'secret-token');
    expect(enc).not.toContain('secret-token');
    expect(await decryptToken(env, enc)).toBe('secret-token');
  });
});

import { env, SELF } from 'cloudflare:test';
import type { Env } from '../src/env';
import worker from '../src/index';
import { nowIso, randomId } from '../src/db';
import { sentMail } from '../src/mail';

export const BASE = 'http://worker.test';

/**
 * A browser for the cookie-authenticated routes: keeps cookies, sends this origin's Origin header, and has
 * its own IP (rate limits are per IP). `bindings` override the Worker's env (e.g. SIGNUP_MODE).
 */
export class Browser {
  cookies = new Map<string, string>();
  ip = `198.51.100.${Math.floor(Math.random() * 250)}-${randomId(4)}`;
  constructor(private bindings: Partial<Env> = {}) {}

  async fetch(path: string, init: { method?: string; body?: unknown; origin?: string | null } = {}): Promise<Response> {
    const headers = new Headers({ 'CF-Connecting-IP': this.ip });
    if (this.cookies.size) headers.set('Cookie', [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    if (init.origin !== null) headers.set('Origin', init.origin ?? BASE);
    if (init.body !== undefined) headers.set('Content-Type', 'application/json');
    const req = new Request(BASE + path, {
      method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: 'manual',
    });
    const res = Object.keys(this.bindings).length
      ? await worker.fetch(req, { ...env, ...this.bindings }, { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext)
      : await SELF.fetch(req);
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const [name, value = ''] = pair!.split('=');
      if (!value || /max-age=0\b/i.test(c)) this.cookies.delete(name!);
      else this.cookies.set(name!, value);
    }
    return res;
  }

  post = (path: string, body: unknown = {}) => this.fetch(path, { method: 'POST', body });

  /** Log in as `email` with the emailed code. */
  async login(email: string): Promise<void> {
    const start = await this.post('/login/start', { email });
    if (start.status !== 200) throw new Error(`login start → ${start.status} ${await start.text()}`);
    const res = await this.post('/login/code', { code: lastCode(email) });
    if (res.status !== 200) throw new Error(`login code → ${res.status} ${await res.text()}`);
  }
}

export const lastMail = (to: string) => [...sentMail()].reverse().find((m) => m.to === to);
export const lastCode = (to: string) => /code is (\d{6})/.exec(lastMail(to)?.text ?? '')?.[1] ?? '';
export const lastLink = (to: string) => /(http\S+\/login\/verify\?t=\S+)/.exec(lastMail(to)?.text ?? '')?.[1] ?? '';

export const uniqueEmail = (tag = 'user') => `${tag}-${randomId(6).toLowerCase().replace(/[^a-z0-9]/g, '')}@example.test`;

/** An org with an owner (a user row; they still have to log in). */
export async function seedOrg(name = 'Agency'): Promise<{ orgId: string; ownerId: string; ownerEmail: string }> {
  const orgId = randomId();
  const ownerId = randomId();
  const ownerEmail = uniqueEmail('owner');
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO orgs (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').bind(orgId, name, now, now),
    env.DB.prepare('INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)').bind(ownerId, ownerEmail, `${name} Owner`, now),
    env.DB.prepare("INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").bind(orgId, ownerId, now),
  ]);
  return { orgId, ownerId, ownerEmail };
}

/** A project without Trello in `orgId`. */
export async function seedProject(orgId: string, name = 'Site'): Promise<{ id: string; publicKey: string; accessKey: string }> {
  const id = randomId();
  const publicKey = `pk_${randomId(8)}`;
  const accessKey = `ak_${randomId(12)}`;
  const now = nowIso();
  await env.DB.prepare('INSERT INTO projects (id, name, public_key, access_key, allowed_origins, org_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, name, publicKey, accessKey, JSON.stringify(['https://client.example']), orgId, now, now)
    .run();
  return { id, publicKey, accessKey };
}

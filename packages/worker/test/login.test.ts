import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { AppMe, ApiError, LoginDoneResponse } from '@annotate/shared';
import { sentMail } from '../src/mail';
import { Browser, lastCode, lastLink, lastMail, seedOrg, uniqueEmail } from './browser';

const userRow = (email: string) => env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<{ email_verified_at: string | null; last_login_at: string | null }>();

describe('login by code', () => {
  it('emails a code and a link, and the code logs this browser in', async () => {
    const { ownerEmail, orgId } = await seedOrg('Balian Design');
    const b = new Browser();
    const start = await b.post('/login/start', { email: `  ${ownerEmail.toUpperCase()} `, next: '/app/p/x' });
    expect(start.status).toBe(200);
    const mail = lastMail(ownerEmail)!;
    expect(mail.subject).toMatch(/^Your Annotate login code: \d{6}$/);
    expect(mail.html).toContain(lastLink(ownerEmail).replace(/&/g, '&#38;'));
    expect(b.cookies.has('__Host-annotate_login')).toBe(true);

    const res = await b.post('/login/code', { code: lastCode(ownerEmail) });
    expect(res.status).toBe(200);
    expect(await res.json<LoginDoneResponse>()).toEqual({ next: '/app/p/x' });
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('__Host-annotate='))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//);
    expect(b.cookies.has('__Host-annotate_login')).toBe(false);

    const me = await (await b.fetch('/v1/app/me')).json<AppMe>();
    expect(me).toMatchObject({ user: { email: ownerEmail, name: 'Balian Design Owner' }, orgs: [{ id: orgId, name: 'Balian Design', role: 'owner' }], canCreateOrg: false });
    expect((await userRow(ownerEmail))!.email_verified_at).not.toBeNull();
    expect((await (await b.fetch('/login/status')).json<{ loggedIn: boolean }>()).loggedIn).toBe(true);
  });

  it('only accepts the code in the browser that asked for it', async () => {
    const { ownerEmail } = await seedOrg();
    const asker = new Browser();
    await asker.post('/login/start', { email: ownerEmail });
    const other = new Browser();
    expect((await other.post('/login/code', { code: lastCode(ownerEmail) })).status).toBe(400);
    expect((await asker.post('/login/code', { code: lastCode(ownerEmail) })).status).toBe(200);
  });

  it('kills the code after 5 wrong tries, and each code works once', async () => {
    const { ownerEmail } = await seedOrg();
    const b = new Browser();
    await b.post('/login/start', { email: ownerEmail });
    const right = lastCode(ownerEmail);
    const wrong = right === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) expect((await b.post('/login/code', { code: wrong })).status).toBe(400);
    const dead = await b.post('/login/code', { code: right });
    expect(dead.status).toBe(400);
    expect((await dead.json<ApiError>()).code).toBe('expired');

    await b.post('/login/start', { email: ownerEmail });
    const code = lastCode(ownerEmail);
    expect((await b.post('/login/code', { code })).status).toBe(200);
    // The login cookie is gone, and the token is used.
    expect((await b.post('/login/code', { code })).status).toBe(400);
  });

  it('expires codes after 15 minutes', async () => {
    const { ownerEmail } = await seedOrg();
    const b = new Browser();
    await b.post('/login/start', { email: ownerEmail });
    await env.DB.prepare('UPDATE login_tokens SET expires_at = ? WHERE email = ?').bind(Date.now() - 1, ownerEmail).run();
    expect(await (await b.post('/login/code', { code: lastCode(ownerEmail) })).json<ApiError>()).toMatchObject({ code: 'expired' });
  });
});

describe('login by link', () => {
  it('shows a page on GET (scanners can’t use it up) and logs in on POST, once, in any browser', async () => {
    const { ownerEmail } = await seedOrg();
    await new Browser().post('/login/start', { email: ownerEmail });
    const t = new URL(lastLink(ownerEmail)).searchParams.get('t')!;

    const other = new Browser();
    const page = await other.fetch(`/login/verify?t=${encodeURIComponent(t)}`);
    expect(page.status).toBe(200);
    expect(page.headers.get('Content-Security-Policy')).toContain("script-src 'nonce-");
    expect(await page.text()).toContain('Continue to Annotate');
    expect(other.cookies.has('__Host-annotate')).toBe(false);

    const res = await other.post('/login/verify', { t });
    expect(res.status).toBe(200);
    expect(await res.json<LoginDoneResponse>()).toEqual({ next: '/app/' });
    expect((await other.fetch('/v1/app/me')).status).toBe(200);
    expect((await new Browser().post('/login/verify', { t })).status).toBe(400);
  });
});

describe('who gets an email', () => {
  it('sends nothing to an address that was never invited, and answers the same', async () => {
    const email = uniqueEmail('stranger');
    const before = sentMail().length;
    const b = new Browser();
    const res = await b.post('/login/start', { email });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(b.cookies.has('__Host-annotate_login')).toBe(true);
    expect(sentMail().length).toBe(before);
    expect((await b.post('/login/code', { code: '123456' })).status).toBe(400);
    expect(await userRow(email)).toBeNull();
  });

  it('lets anyone in when signup is open, and they can then create an org', async () => {
    const email = uniqueEmail('agency');
    const b = new Browser({ SIGNUP_MODE: 'open' });
    await b.login(email);
    expect(await (await b.fetch('/v1/app/me')).json<AppMe>()).toMatchObject({ user: { email }, orgs: [], canCreateOrg: true });
    const org = await b.post('/v1/app/orgs', { name: '  Acme   Web ' });
    expect(org.status).toBe(201);
    expect((await (await b.fetch('/v1/app/me')).json<AppMe>()).orgs).toEqual([{ id: (await org.json<{ id: string }>()).id, name: 'Acme Web', role: 'owner' }]);
  });

  it('refuses to create orgs while signup is closed', async () => {
    const { ownerEmail } = await seedOrg();
    const b = new Browser();
    await b.login(ownerEmail);
    expect((await b.post('/v1/app/orgs', { name: 'Side gig' })).status).toBe(403);
  });

  it('rate-limits login emails per address', async () => {
    const { ownerEmail } = await seedOrg();
    for (let i = 0; i < 5; i++) expect((await new Browser().post('/login/start', { email: ownerEmail })).status).toBe(200);
    const res = await new Browser().post('/login/start', { email: ownerEmail });
    expect(res.status).toBe(429);
    expect((await res.json<ApiError>()).code).toBe('rate_limited');
  });

  it('400s on a bad address and keeps `next` on this site', async () => {
    expect((await new Browser().post('/login/start', { email: 'nope' })).status).toBe(400);
    const { ownerEmail } = await seedOrg();
    const b = new Browser();
    await b.post('/login/start', { email: ownerEmail, next: '//evil.example/app' });
    expect(await (await b.post('/login/code', { code: lastCode(ownerEmail) })).json<LoginDoneResponse>()).toEqual({ next: '/app/' });
  });
});

describe('sessions', () => {
  it('logs out, and refuses unknown or expired sessions', async () => {
    const { ownerEmail } = await seedOrg();
    const b = new Browser();
    await b.login(ownerEmail);
    const token = b.cookies.get('__Host-annotate')!;
    expect((await b.post('/logout')).status).toBe(200);
    expect((await b.fetch('/v1/app/me')).status).toBe(401);
    b.cookies.set('__Host-annotate', token);
    expect((await b.fetch('/v1/app/me')).status).toBe(401);

    await b.login(ownerEmail);
    await env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = (SELECT id FROM users WHERE email = ?)').bind(Date.now() - 1, ownerEmail).run();
    expect((await b.fetch('/v1/app/me')).status).toBe(401);
  });

  it('refuses cross-origin writes and has no CORS for the dashboard API', async () => {
    const { ownerEmail } = await seedOrg();
    const b = new Browser();
    expect((await b.fetch('/login/start', { method: 'POST', body: { email: ownerEmail }, origin: 'https://client.balian.dev' })).status).toBe(403);
    expect((await b.fetch('/login/start', { method: 'POST', body: { email: ownerEmail }, origin: null })).status).toBe(403);
    await b.login(ownerEmail);
    expect((await b.fetch('/v1/app/me', { method: 'PATCH', body: { name: 'x' }, origin: 'https://evil.example' })).status).toBe(403);
    const preflight = await b.fetch('/v1/app/me', { method: 'OPTIONS', origin: 'https://evil.example' });
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

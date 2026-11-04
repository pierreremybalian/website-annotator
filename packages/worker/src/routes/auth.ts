// Login by email: POST /login/start mails a link and a 6-digit code. The code can only be redeemed in the
// browser that asked for it (login cookie); the link works anywhere, but opening it only shows a page and a
// POST consumes it, so mail scanners that prefetch links can't burn it. Either way the user gets a session
// cookie (src/session.ts). While SIGNUP_MODE isn't 'open', only people already invited get an email; the
// response is the same either way.

import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { LoginDoneResponse } from '@annotate/shared';
import type { AppEnv, Env } from '../env';
import { nowIso, randomId, type LoginTokenRow, type UserRow } from '../db';
import { apiError } from '../auth';
import { hmac, safeEqual, sha256Hex } from '../crypto';
import { DAY, HOUR, hit, over } from '../rate-limit';
import { MailError, sendMail, simpleHtml } from '../mail';
import { currentUser, endSession, sameOrigin, startSession } from '../session';
import { sendPage } from '../connect/render';
import { LoginErrorPage, LoginPage, VerifyPage } from '../connect/login';

const LOGIN_COOKIE = '__Host-annotate_login';
const LOGIN_MS = 15 * 60_000;
export const INVITE_MS = 7 * DAY;
const MAX_CODE_ATTEMPTS = 5;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Ctx = Context<AppEnv>;

export const normalizeEmail = (s: string) => s.trim().toLowerCase();
export const validEmail = (s: string) => EMAIL_RE.test(s) && s.length <= 254;
export const signupOpen = (env: Env) => env.SIGNUP_MODE === 'open';

/** A same-origin path to continue to after logging in: the dashboard or the connect flow, else the dashboard. */
export function safeNext(v: unknown): string {
  if (typeof v !== 'string' || !/^\/(app|connect)(\/|\?|$)/.test(v) || v.includes('\\') || v.length > 2000) return '/app/';
  return v;
}

const codeHash = (env: Env, id: string, code: string) => hmac('SHA-256', env.SIGNING_SECRET, `login:${id}:${code}`);
const newCode = () => String(crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000).padStart(6, '0');
const origin = (c: Ctx) => new URL(c.req.url).origin;

/** Create a login or invite token for `email` and return the link (and code, for logins) to mail. */
export async function createLoginToken(env: Env, email: string, kind: 'login' | 'invite', base: string, next: string) {
  const id = randomId(16);
  const secret = randomId(32);
  const code = kind === 'login' ? newCode() : null;
  const now = Date.now();
  await env.DB.prepare('INSERT INTO login_tokens (id, kind, email, link_hash, code_hash, next, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, kind, email, await sha256Hex(secret), code ? await codeHash(env, id, code) : null, next, now, now + (kind === 'login' ? LOGIN_MS : INVITE_MS))
    .run();
  return { id, code, link: `${base}/login/verify?t=${encodeURIComponent(secret)}` };
}

/** Use up a token (once), log its email in (creating the user if signup is open or they were invited), start a session. */
async function redeem(c: Ctx, token: LoginTokenRow): Promise<Response> {
  const used = await c.env.DB.prepare('UPDATE login_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ? RETURNING id')
    .bind(Date.now(), token.id, Date.now())
    .first();
  if (!used) return apiError(c, 400, 'expired', 'That login has expired or was already used. Ask for a new code.');
  let user = await c.env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(token.email).first<UserRow>();
  if (!user) {
    if (!signupOpen(c.env)) return apiError(c, 403, 'forbidden', "You haven't been invited yet. Ask your agency to add you.");
    user = { id: randomId(), email: token.email, name: '', email_verified_at: nowIso(), created_at: nowIso(), last_login_at: null };
    await c.env.DB.prepare('INSERT OR IGNORE INTO users (id, email, name, email_verified_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(user.id, user.email, user.name, user.email_verified_at, user.created_at)
      .run();
    user = (await c.env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(token.email).first<UserRow>())!;
  }
  await startSession(c, user.id);
  deleteCookie(c, LOGIN_COOKIE, { secure: true, path: '/' });
  return c.json<LoginDoneResponse>({ next: safeNext(token.next) });
}

const app = new Hono<AppEnv>();

app.use('*', sameOrigin);

app.get('/', async (c) => {
  const next = safeNext(c.req.query('next'));
  if (await currentUser(c)) return c.redirect(next);
  const email = (c.req.query('email') ?? '').slice(0, 254);
  return sendPage(c, (nonce) => LoginPage({ nonce, next, email, signupOpen: signupOpen(c.env) }));
});

app.post('/start', async (c) => {
  const body = await c.req.json<{ email?: unknown; next?: unknown }>().catch(() => ({}) as { email?: unknown; next?: unknown });
  const email = typeof body.email === 'string' ? normalizeEmail(body.email) : '';
  if (!validEmail(email)) return apiError(c, 400, 'bad_request', 'Enter a valid email address.');
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  const allowed =
    (await hit(c.env, `login:ip:${ip}`, 20, HOUR)) && (await hit(c.env, `login:email:${email}`, 5, HOUR)) && (await hit(c.env, `login:email-day:${email}`, 10, DAY));
  if (!allowed) return apiError(c, 429, 'rate_limited', 'Too many login emails. Wait a while and try again.');

  // The browser gets a login cookie either way, so an unknown address looks the same as a known one.
  let id = randomId(16);
  const known = signupOpen(c.env) || !!(await c.env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first());
  if (known) {
    const token = await createLoginToken(c.env, email, 'login', origin(c), safeNext(body.next));
    id = token.id;
    try {
      await sendMail(c.env, {
        to: email,
        subject: `Your Annotate login code: ${token.code}`,
        text: `Your login code is ${token.code}\n\nOr open this link to log in:\n${token.link}\n\nThe code and link work once, for 15 minutes. If you didn't ask to log in, ignore this email.`,
        html: simpleHtml([`Your login code is ${token.code}.`, 'Or use this button to log in:'], { label: 'Log in to Annotate', url: token.link }, "The code and link work once, for 15 minutes. If you didn't ask to log in, ignore this email."),
      });
    } catch (e) {
      if (!(e instanceof MailError)) throw e;
      console.error('login email failed', e);
      return apiError(c, 503, 'internal', "We couldn't send the email just now. Try again in a few minutes.");
    }
  }
  setCookie(c, LOGIN_COOKIE, id, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: LOGIN_MS / 1000 });
  return c.json({ ok: true });
});

app.post('/code', async (c) => {
  const body = await c.req.json<{ code?: unknown }>().catch(() => ({}) as { code?: unknown });
  const code = typeof body.code === 'string' ? body.code.replace(/\D/g, '') : '';
  if (code.length !== 6) return apiError(c, 400, 'bad_request', 'Enter the 6 digits from the email.');
  const id = getCookie(c, LOGIN_COOKIE);
  if (!id) return apiError(c, 400, 'expired', 'Ask for a new code: this browser has no login in progress.');
  if (!(await hit(c.env, `code:ip:${c.req.header('CF-Connecting-IP') ?? 'unknown'}`, 30, 15 * 60_000))) {
    return apiError(c, 429, 'rate_limited', 'Too many tries. Wait a few minutes.');
  }
  const token = await c.env.DB.prepare("SELECT * FROM login_tokens WHERE id = ? AND kind = 'login'").bind(id).first<LoginTokenRow>();
  const wrong = () => apiError(c, 400, 'bad_request', "That code isn't right. Check the latest email and try again.");
  if (!token) return wrong();
  if (token.used_at || token.expires_at <= Date.now() || token.attempts >= MAX_CODE_ATTEMPTS) {
    return apiError(c, 400, 'expired', 'That code has expired. Ask for a new one.');
  }
  if (await over(c.env, `code-fail:${token.email}`, 10, DAY)) {
    return apiError(c, 429, 'rate_limited', 'Too many wrong codes today. Use the link in the email instead.');
  }
  if (!token.code_hash || !safeEqual(await codeHash(c.env, token.id, code), token.code_hash)) {
    await c.env.DB.prepare('UPDATE login_tokens SET attempts = attempts + 1 WHERE id = ?').bind(token.id).run();
    await hit(c.env, `code-fail:${token.email}`, 10, DAY);
    return wrong();
  }
  return redeem(c, token);
});

app.get('/verify', (c) => {
  const t = c.req.query('t') ?? '';
  if (!t || t.length > 100) return sendPage(c, (nonce) => LoginErrorPage({ nonce, title: 'Link not valid', message: 'Open the latest link we emailed you, or ask for a new one.' }), 400);
  return sendPage(c, (nonce) => VerifyPage({ nonce, token: t }));
});

app.post('/verify', async (c) => {
  const body = await c.req.json<{ t?: unknown }>().catch(() => ({}) as { t?: unknown });
  if (typeof body.t !== 'string' || !body.t || body.t.length > 100) return apiError(c, 400, 'bad_request', 'Missing link token');
  if (!(await hit(c.env, `verify:ip:${c.req.header('CF-Connecting-IP') ?? 'unknown'}`, 30, 15 * 60_000))) {
    return apiError(c, 429, 'rate_limited', 'Too many tries. Wait a few minutes.');
  }
  const token = await c.env.DB.prepare('SELECT * FROM login_tokens WHERE link_hash = ?').bind(await sha256Hex(body.t)).first<LoginTokenRow>();
  if (!token) return apiError(c, 400, 'expired', 'That link has expired or was already used. Ask for a new code.');
  return redeem(c, token);
});

app.get('/status', async (c) => c.json({ loggedIn: !!(await currentUser(c)) }));

export const logout = async (c: Ctx) => {
  await endSession(c);
  return c.json({ ok: true });
};


export default app;

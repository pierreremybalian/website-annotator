// Login sessions: a random cookie value, stored only as its SHA-256 (like agent tokens). 30 days, sliding.
// The cookie is host-only (__Host-), so the client sites on sibling subdomains can neither read nor set it.

import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppEnv } from './env';
import { nowIso, randomId, type UserRow } from './db';
import { apiError } from './auth';
import { sha256Hex } from './crypto';
import { DAY } from './rate-limit';

export const SESSION_COOKIE = '__Host-annotate';
const SESSION_MS = 30 * DAY;

type Ctx = Context<AppEnv>;

export async function startSession(c: Ctx, userId: string): Promise<void> {
  const token = randomId(32);
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, seen_at, expires_at) VALUES (?, ?, ?, ?, ?)').bind(await sha256Hex(token), userId, now, now, now + SESSION_MS),
    c.env.DB.prepare('UPDATE users SET last_login_at = ?, email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?').bind(nowIso(), nowIso(), userId),
  ]);
  setCookie(c, SESSION_COOKIE, token, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: SESSION_MS / 1000 });
}

/** The logged-in user, or null. Extends the session when it was last seen over a day ago. */
export async function currentUser(c: Ctx): Promise<UserRow | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const hash = await sha256Hex(token);
  const now = Date.now();
  const row = await c.env.DB.prepare('SELECT u.*, s.seen_at AS session_seen_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?')
    .bind(hash, now)
    .first<UserRow & { session_seen_at: number }>();
  if (!row) return null;
  const { session_seen_at: seen, ...user } = row;
  if (seen < now - DAY) await c.env.DB.prepare('UPDATE sessions SET seen_at = ?, expires_at = ? WHERE token_hash = ?').bind(now, now + SESSION_MS, hash).run();
  return user;
}

export async function endSession(c: Ctx): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
  deleteCookie(c, SESSION_COOKIE, { secure: true, path: '/' });
}

/** 401 without a session; sets c.var.user. */
export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = await currentUser(c);
  if (!user) return apiError(c, 401, 'unauthorized', 'Log in first');
  c.set('user', user);
  await next();
};

/**
 * CSRF guard for cookie-authenticated writes: the request must come from a page on this same origin. SameSite
 * alone isn't enough, since client sites on sibling subdomains (*.balian.dev) count as the same site.
 */
export const sameOrigin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && c.req.header('Origin') !== new URL(c.req.url).origin) {
    return apiError(c, 403, 'forbidden_origin', 'Cross-origin request refused');
  }
  await next();
};

// Fixed-window counters in D1 (rate_limits). Good enough for login and invite abuse; not for request floods.

import type { Env } from './env';

/** Count one hit against `key`. False once it's over `limit` in the current window. */
export async function hit(env: Env, key: string, limit: number, windowMs: number): Promise<boolean> {
  const now = Date.now();
  const start = now - windowMs;
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN window_start <= ? THEN 1 ELSE count + 1 END,
       window_start = CASE WHEN window_start <= ? THEN ? ELSE window_start END
     RETURNING count`,
  )
    .bind(key, now, start, start, now)
    .first<{ count: number }>();
  return (row?.count ?? 1) <= limit;
}

/** Whether `key` is already over `limit` in its current window, without counting a hit. */
export async function over(env: Env, key: string, limit: number, windowMs: number): Promise<boolean> {
  const row = await env.DB.prepare('SELECT count FROM rate_limits WHERE key = ? AND window_start > ?').bind(key, Date.now() - windowMs).first<{ count: number }>();
  return (row?.count ?? 0) >= limit;
}

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

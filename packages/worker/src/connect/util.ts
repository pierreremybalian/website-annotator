import type { Env } from '../env';
import type { TrelloList } from '../trello';

/** PUBLIC_URL without a trailing slash. */
export const publicBase = (env: Pick<Env, 'PUBLIC_URL'>) => env.PUBLIC_URL.replace(/\/+$/, '');

/** The callback URL the board webhook is registered with. The webhook signature covers it, so both sides must agree. */
export const webhookCallbackUrl = (env: Pick<Env, 'PUBLIC_URL'>) => `${publicBase(env)}/trello/webhook`;

/** Parse an absolute http(s) URL, or null. */
export function parseHttpUrl(v: unknown): URL | null {
  if (typeof v !== 'string' || !v.trim() || v.length > 2048) return null;
  try {
    const u = new URL(v.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

/** A bare http(s) origin like "https://example.com" (a trailing slash is tolerated), normalized; else null. */
export function parseOrigin(v: string): string | null {
  const u = parseHttpUrl(v);
  if (!u || u.username || u.password) return null;
  return v.trim().replace(/\/$/, '') === u.origin ? u.origin : null;
}

export const hostOf = (url: string | null | undefined) => (url ? (parseHttpUrl(url)?.host ?? null) : null);

/** Collapse whitespace and cap the length of a user-supplied label. */
export function cleanLabel(v: string | undefined, max = 80): string | null {
  const s = (v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  return s || null;
}

const DONE_RE = /done|complete|resolved|closed|fixed/i;

/** Smart list defaults: new issues → first list; resolved → a "done"-like list, else the last one. */
export function defaultLists(lists: Pick<TrelloList, 'id' | 'name'>[]): { newListId: string | null; doneListId: string | null } {
  const first = lists[0];
  if (!first) return { newListId: null, doneListId: null };
  const rest = lists.slice(1);
  const done = rest.find((l) => DONE_RE.test(l.name)) ?? rest[rest.length - 1];
  return { newListId: first.id, doneListId: done?.id ?? null };
}

/** JSON safe to embed inside a <script type="application/json"> element. */
export const jsonForScript = (data: unknown) =>
  JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

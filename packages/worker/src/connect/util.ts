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
/** Lists that look like a "ready for review" stage. Also embedded in the board picker's script. */
export const REVIEW_RE = /ready for review|review|qa|testing|verif/i;
/** Review dropdown value: create a "Ready for review" list on finish. */
export const CREATE_REVIEW_LIST = '__create__';
export const REVIEW_LIST_NAME = 'Ready for review';

export interface ListDefaults {
  newListId: string | null;
  doneListId: string | null;
  /** A list id, or CREATE_REVIEW_LIST when no list looks like a review stage. Null when the board has no lists. */
  reviewListId: string | null;
}

/** Review default: the first review-like list other than the new and done lists, else "create one". */
export function defaultReviewList(lists: Pick<TrelloList, 'id' | 'name'>[], newListId: string | null, doneListId: string | null): string | null {
  if (lists.length === 0) return null;
  return lists.find((l) => l.id !== newListId && l.id !== doneListId && REVIEW_RE.test(l.name))?.id ?? CREATE_REVIEW_LIST;
}

/** Smart list defaults: new issues → first list; resolved → a "done"-like list, else the last one; review → see defaultReviewList. */
export function defaultLists(lists: Pick<TrelloList, 'id' | 'name'>[]): ListDefaults {
  const first = lists[0];
  if (!first) return { newListId: null, doneListId: null, reviewListId: null };
  const rest = lists.slice(1);
  const done = rest.find((l) => DONE_RE.test(l.name)) ?? rest[rest.length - 1];
  const doneListId = done?.id ?? null;
  return { newListId: first.id, doneListId, reviewListId: defaultReviewList(lists, first.id, doneListId) };
}

/** A Trello `pos` just before the first of `beforeIds` on the board (halfway to the list in front of it). */
export function posBefore(lists: Pick<TrelloList, 'id' | 'pos'>[], beforeIds: string[]): number | 'bottom' {
  const sorted = [...lists].sort((a, b) => a.pos - b.pos);
  const i = sorted.findIndex((l) => beforeIds.includes(l.id));
  const target = sorted[i];
  if (!target) return 'bottom';
  const prev = sorted[i - 1]?.pos ?? 0;
  return (prev + target.pos) / 2;
}

/** JSON safe to embed inside a <script type="application/json"> element. */
export const jsonForScript = (data: unknown) =>
  JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

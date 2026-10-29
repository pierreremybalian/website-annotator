import { ACTIVATION_PARAM } from '@annotate/shared';

const TRACKING_PARAMS = new Set(['fbclid', 'gclid', 'msclkid', '_ga', 'mc_cid', 'mc_eid', ACTIVATION_PARAM]);

const isTracking = (name: string) => {
  const n = name.toLowerCase();
  return n.startsWith('utm_') || TRACKING_PARAMS.has(n);
};

/**
 * Canonical form of a page URL, used to match issues to pages.
 * Lowercases the host, drops default ports, the hash, tracking params and a trailing slash on
 * non-root paths, and sorts the remaining params. With ignoreQuery the whole query is dropped.
 * Throws TypeError on an unparseable URL.
 */
export function normalizeUrl(raw: string, opts: { ignoreQuery?: boolean | number } = {}): string {
  // The URL parser already lowercases the host and drops default ports.
  const u = new URL(raw.trim());
  u.hash = '';

  if (opts.ignoreQuery) {
    u.search = '';
  } else {
    for (const name of [...new Set(u.searchParams.keys())]) if (isTracking(name)) u.searchParams.delete(name);
    u.searchParams.sort();
    // sort() re-serializes; an emptied query leaves a bare "?" on some runtimes.
    if (![...u.searchParams.keys()].length) u.search = '';
  }

  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.replace(/\/+$/, '') || '/';

  return u.toString();
}

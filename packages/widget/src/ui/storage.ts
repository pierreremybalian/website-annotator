// localStorage can throw (Safari private mode, blocked storage, sandboxed iframes): never let it.
import type { Reporter } from '@annotate/shared';

export const REPORTER_KEY = 'annotate:reporter';
export const accessKeyFor = (projectKey: string) => `annotate:access:${projectKey}`;

export function storageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function storageSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

export function storageRemove(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export function loadReporter(): Reporter | null {
  const raw = storageGet(REPORTER_KEY);
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as Partial<Reporter>;
    if (typeof r.name === 'string' && r.name.trim() && typeof r.email === 'string' && r.email.trim()) {
      return { name: r.name.trim(), email: r.email.trim() };
    }
  } catch {
    /* corrupt value */
  }
  return null;
}

export function saveReporter(r: Reporter): void {
  storageSet(REPORTER_KEY, JSON.stringify({ name: r.name, email: r.email }));
}

// The dashboard's calls to /v1/app (same origin, session cookie). A 401 means the session ended: go log in.

import type { ApiError } from '@annotate/shared';

export class ApiRequestError extends Error {
  constructor(
    public status: number,
    public code: ApiError['code'] | 'network',
    message: string,
  ) {
    super(message);
  }
}

export function loginUrl(next = location.pathname + location.search): string {
  return `/login?next=${encodeURIComponent(next)}`;
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/v1/app${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      credentials: 'same-origin',
      headers: init.body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new ApiRequestError(0, 'network', "Can't reach Annotate. Check your connection.");
  }
  if (res.status === 401) {
    location.assign(loginUrl());
    throw new ApiRequestError(401, 'unauthorized', 'Log in first');
  }
  const body = (await res.json().catch(() => null)) as (T & Partial<ApiError>) | null;
  if (!res.ok) throw new ApiRequestError(res.status, body?.code ?? 'internal', body?.error ?? `Request failed (${res.status})`);
  return body as T;
}

export const logout = () => fetch('/logout', { method: 'POST', credentials: 'same-origin' }).then(() => location.assign('/login'));

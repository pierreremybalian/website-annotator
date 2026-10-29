import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ApiError } from '@annotate/shared';
import type { AppEnv } from '../env';
import { randomId } from '../db';
import { pageCsp } from './layout';
import { ErrorPage } from './pages';

/** Thrown by connect handlers; rendered as an HTML error page for page routes, ApiError JSON otherwise. */
export class ConnectError extends Error {
  constructor(
    public status: ContentfulStatusCode,
    message: string,
    public code: ApiError['code'],
    public title = 'Something went wrong',
  ) {
    super(message);
  }
}

/** Render a page with a fresh CSP nonce for its inline scripts. */
export function sendPage(c: Context<AppEnv>, build: (nonce: string) => string | Promise<string>, status: ContentfulStatusCode = 200) {
  const nonce = randomId(16);
  c.header('Content-Security-Policy', pageCsp(nonce));
  return c.html(build(nonce), status);
}

export function sendError(c: Context<AppEnv>, err: ConnectError, asPage: boolean) {
  if (asPage) return sendPage(c, (nonce) => ErrorPage({ nonce, title: err.title, message: err.message }), err.status);
  return c.json<ApiError>({ error: err.message, code: err.code }, err.status);
}

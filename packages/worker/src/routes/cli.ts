// CLI hand-off, device-style. JSON only, no cookies: these calls come from Node.
//   POST /cli/sessions           CliSessionRequest → 200 CliSessionResponse
//   POST /cli/sessions/:id/poll  { verifier } → 202 { status: 'pending' } | 200 CliPollResponse (once, then deleted)
//                                | 400 bad_request | 403 forbidden (wrong verifier) | 410 expired (unknown, expired or already collected)
// The browser side is /connect?cli=<id> (routes/connect.ts), which stores the encrypted CliResult.

import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ApiError, CliPollResponse, CliSessionRequest, CliSessionResponse } from '@annotate/shared';
import type { AppEnv } from '../env';
import { randomId } from '../db';
import { safeEqual, sha256Base64Url } from '../crypto';
import { CLI_SESSION_TTL_MS, getCliSession, readCliResult } from '../connect/cli-session';
import { parseHttpUrl, publicBase } from '../connect/util';

const app = new Hono<AppEnv>();

app.use('*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
});

const fail = (c: Context<AppEnv>, status: ContentfulStatusCode, code: ApiError['code'], error: string) => c.json<ApiError>({ error, code }, status);

async function readBody(c: Context<AppEnv>): Promise<Record<string, unknown> | null> {
  const body: unknown = await c.req.json().catch(() => null);
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

app.post('/sessions', async (c) => {
  const body = await readBody(c);
  if (!body) return fail(c, 400, 'bad_request', 'Send a JSON body.');

  const { verifierHash, mode, label, siteUrl } = body as Partial<Record<keyof CliSessionRequest, unknown>>;
  if (typeof verifierHash !== 'string' || !/^[\w-]{43}$/.test(verifierHash)) {
    return fail(c, 400, 'bad_request', 'verifierHash must be base64url(SHA-256(verifier)), 43 characters.');
  }
  if (mode !== 'connect' && mode !== 'link') return fail(c, 400, 'bad_request', "mode must be 'connect' or 'link'.");

  let cleanLabel: string | null = null;
  if (label !== undefined && label !== null) {
    if (typeof label !== 'string') return fail(c, 400, 'bad_request', 'label must be a string.');
    cleanLabel = label.replace(/\s+/g, ' ').trim() || null;
    if (cleanLabel && cleanLabel.length > 80) return fail(c, 400, 'bad_request', 'label must be 80 characters or fewer.');
  }

  let site: string | null = null;
  if (siteUrl !== undefined && siteUrl !== null && siteUrl !== '') {
    site = parseHttpUrl(siteUrl)?.href ?? null;
    if (!site) return fail(c, 400, 'bad_request', 'siteUrl must be an absolute http(s) URL.');
  }

  const id = randomId();
  const expiresAt = Date.now() + CLI_SESSION_TTL_MS;
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM cli_sessions WHERE expires_at < ?').bind(Date.now()),
    c.env.DB.prepare('INSERT INTO cli_sessions (id, verifier_hash, mode, label, site_url, expires_at) VALUES (?, ?, ?, ?, ?, ?)').bind(
      id,
      verifierHash,
      mode,
      cleanLabel,
      site,
      expiresAt,
    ),
  ]);

  return c.json<CliSessionResponse>({ id, url: `${publicBase(c.env)}/connect?cli=${encodeURIComponent(id)}`, expiresAt: new Date(expiresAt).toISOString() });
});

app.post('/sessions/:id/poll', async (c) => {
  const body = await readBody(c);
  const verifier = body?.verifier;
  if (typeof verifier !== 'string' || !verifier || verifier.length > 512) return fail(c, 400, 'bad_request', 'Send { "verifier": "…" }.');

  const id = c.req.param('id');
  const expired = () => fail(c, 410, 'expired', 'This connect session has expired or was already used. Run the command again.');
  const row = await getCliSession(c.env, id);
  if (!row) return expired();
  if (row.expires_at <= Date.now()) {
    await c.env.DB.prepare('DELETE FROM cli_sessions WHERE id = ?').bind(row.id).run();
    return expired();
  }
  if (!safeEqual(await sha256Base64Url(verifier), row.verifier_hash)) return fail(c, 403, 'forbidden', 'Wrong verifier for this session.');
  if (!row.result_enc) return c.json({ status: 'pending' as const }, 202);

  // One-shot: only the poll that deletes the row gets the result.
  const taken = await c.env.DB.prepare('DELETE FROM cli_sessions WHERE id = ? AND result_enc IS NOT NULL RETURNING result_enc')
    .bind(row.id)
    .first<{ result_enc: string }>();
  if (!taken) return expired();
  return c.json<CliPollResponse>({ status: 'done', result: await readCliResult(c.env, taken.result_enc) });
});

export default app;

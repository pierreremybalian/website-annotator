// Agent API auth: `Authorization: Bearer at_…`. Tokens are per project and stored only as a hex
// SHA-256 (agent_tokens.token_hash). No Origin check: agents call from a CLI, not a browser.
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from './env';
import { nowIso, type ProjectRow } from './db';
import { apiError } from './auth';
import { sha256Hex } from './crypto';

const BEARER_RE = /^Bearer\s+(at_[\x21-\x7e]{1,256})$/i;

/** `Authorization: Bearer at_…` → look up agent_tokens by SHA-256 hash, set c.var.project, bump last_used_at. */
export const requireAgent: MiddlewareHandler<AppEnv> = async (c, next) => {
  const m = BEARER_RE.exec((c.req.header('Authorization') ?? '').trim());
  if (!m) return apiError(c, 401, 'unauthorized', 'Missing agent token (Authorization: Bearer at_…)');

  const hash = await sha256Hex(m[1]!);
  const row = await c.env.DB.prepare('SELECT t.id AS agent_token_id, p.* FROM agent_tokens t JOIN projects p ON p.id = t.project_id WHERE t.token_hash = ?')
    .bind(hash)
    .first<ProjectRow & { agent_token_id: string }>();
  if (!row) return apiError(c, 401, 'unauthorized', 'Invalid agent token');

  const { agent_token_id: tokenId, ...project } = row;
  try {
    await c.env.DB.prepare('UPDATE agent_tokens SET last_used_at = ? WHERE id = ?').bind(nowIso(), tokenId).run();
  } catch (e) {
    console.error('agent token: failed to bump last_used_at', e);
  }

  c.set('project', project);
  await next();
};

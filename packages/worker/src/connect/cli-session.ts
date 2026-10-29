// CLI hand-off sessions (see the comment above CliSessionRequest in @annotate/shared).
// routes/cli.ts creates and polls them; the connect flow fills in the result.

import type { CliResult } from '@annotate/shared';
import type { Env } from '../env';
import type { CliSessionRow } from '../db';
import { agentTokenInsert, newAgentToken } from '../agent-tokens';
import { decryptToken, encryptToken } from '../crypto';

export const CLI_SESSION_TTL_MS = 15 * 60 * 1000;
/** Once the browser finishes, the CLI gets at least this long to pick the result up. */
const CLI_PICKUP_MS = 2 * 60 * 1000;

export const isSessionId = (v: unknown): v is string => typeof v === 'string' && /^[\w-]{8,64}$/.test(v);

export async function getCliSession(env: Env, id: unknown): Promise<CliSessionRow | null> {
  if (!isSessionId(id)) return null;
  return env.DB.prepare('SELECT * FROM cli_sessions WHERE id = ?').bind(id).first<CliSessionRow>();
}

/** Still waiting for the browser: exists, unexpired and has no result yet. */
export const cliSessionOpen = (row: CliSessionRow | null): row is CliSessionRow => !!row && row.expires_at > Date.now() && !row.result_enc;

export async function readCliResult(env: Env, resultEnc: string): Promise<CliResult> {
  return JSON.parse(await decryptToken(env, resultEnc)) as CliResult;
}

/**
 * Statements that hand a project to the CLI, to run in one batch with the caller's other writes:
 *   1. store the encrypted CliResult, only if the session is still open (no other window finished first);
 *   2. insert the agent token, only if (1) stored our result.
 * The caller checks `results[i].meta.changes` of statement (1) to know whether the hand-off happened.
 */
export async function cliHandoff(env: Env, cli: CliSessionRow, projectId: string, result: Omit<CliResult, 'agentToken'>) {
  const agentToken = newAgentToken();
  const resultEnc = await encryptToken(env, JSON.stringify({ ...result, agentToken } satisfies CliResult));
  const now = Date.now();
  const store = env.DB.prepare(
    'UPDATE cli_sessions SET result_enc = ?, expires_at = MAX(expires_at, ?) WHERE id = ? AND result_enc IS NULL AND expires_at > ?',
  ).bind(resultEnc, now + CLI_PICKUP_MS, cli.id, now);
  const insert = await agentTokenInsert(env, projectId, agentToken, cli.label ?? 'cli', { cliSessionId: cli.id, resultEnc });
  return [store, insert] as const;
}

// Per-project agent tokens ("at_…") for the agent API. Only the hex SHA-256 is stored;
// the plaintext is returned once, to whoever minted it (the CLI hand-off).

import type { Env } from './env';
import { nowIso, randomId } from './db';
import { sha256Hex } from './crypto';

export const AGENT_TOKEN_PREFIX = 'at_';

/** A fresh plaintext token. Store it only through agentTokenInsert (hashed). */
export const newAgentToken = () => `${AGENT_TOKEN_PREFIX}${randomId(32)}`;

const cleanTokenLabel = (label: string) => label.replace(/\s+/g, ' ').trim().slice(0, 80) || 'cli';

/**
 * The INSERT for a token row, for callers that batch it with other writes.
 * With `onlyIfCliResult`, the insert is a no-op unless that CLI session now holds exactly `resultEnc`,
 * i.e. our hand-off won (a token nobody received is never stored).
 */
export async function agentTokenInsert(
  env: Env,
  projectId: string,
  token: string,
  label: string,
  onlyIfCliResult?: { cliSessionId: string; resultEnc: string },
): Promise<D1PreparedStatement> {
  const row = [randomId(), projectId, await sha256Hex(token), cleanTokenLabel(label), nowIso()];
  if (!onlyIfCliResult) {
    return env.DB.prepare('INSERT INTO agent_tokens (id, project_id, token_hash, label, created_at) VALUES (?, ?, ?, ?, ?)').bind(...row);
  }
  return env.DB.prepare(
    `INSERT INTO agent_tokens (id, project_id, token_hash, label, created_at)
     SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM cli_sessions WHERE id = ? AND result_enc = ?)`,
  ).bind(...row, onlyIfCliResult.cliSessionId, onlyIfCliResult.resultEnc);
}

/** Mint a token for a project. Returns the plaintext; it can't be recovered later. */
export async function mintAgentToken(env: Env, projectId: string, label: string): Promise<string> {
  const token = newAgentToken();
  await (await agentTokenInsert(env, projectId, token, label)).run();
  return token;
}

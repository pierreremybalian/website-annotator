// Every 10 minutes (wrangler.toml [triggers]): retry failed pushes to Trello, import pre-0.3 comments, pull one
// board to catch missed webhooks, and drop expired sessions, login tokens and rate-limit windows. Each step is
// small, so a run stays well inside the Worker's subrequest and CPU limits; whatever's left waits for the next.

import type { Env } from './env';
import { hasTrello, type IssueRow, type ProjectRow } from './db';
import { push } from './sync';
import { importComments, reconcileBoard } from './ingest';
import { TrelloError } from './trello';
import { markTokenRevoked } from './auth';
import { DAY } from './rate-limit';

const BATCH = 10;

export async function scheduled(env: Env): Promise<void> {
  const steps: [string, () => Promise<void>][] = [
    ['retry', () => retryPending(env)],
    ['import', () => importBatch(env)],
    ['reconcile', () => reconcileOne(env)],
    ['cleanup', () => cleanup(env)],
  ];
  for (const [name, step] of steps) {
    try {
      await step();
    } catch (e) {
      console.error(`cron: ${name} failed`, e);
    }
  }
}

/** Issues (with their project) on projects that sync to a Trello board whose token works. */
async function syncedIssues(env: Env, where: string): Promise<{ issue: IssueRow; project: ProjectRow }[]> {
  const { results } = await env.DB.prepare(
    `SELECT i.id FROM issues i JOIN projects p ON p.id = i.project_id
     WHERE ${where} AND p.trello_board_id IS NOT NULL AND p.token_revoked = 0 ORDER BY i.updated_at LIMIT ?`,
  )
    .bind(BATCH)
    .all<{ id: string }>();
  const out = [];
  for (const { id } of results) {
    const issue = await env.DB.prepare('SELECT * FROM issues WHERE id = ?').bind(id).first<IssueRow>();
    const project = issue && (await env.DB.prepare('SELECT * FROM projects WHERE id = ?').bind(issue.project_id).first<ProjectRow>());
    if (issue && project) out.push({ issue, project });
  }
  return out;
}

async function retryPending(env: Env) {
  for (const { issue, project } of await syncedIssues(env, 'i.trello_pending = 1')) {
    // Cleared first: a failure inside push() sets it again.
    await env.DB.prepare('UPDATE issues SET trello_pending = 0 WHERE id = ?').bind(issue.id).run();
    await push(env, project, issue.id, (s) => s.catchUp(issue));
  }
}

async function importBatch(env: Env) {
  for (const { issue, project } of await syncedIssues(env, 'i.comments_imported_at IS NULL AND i.trello_card_id IS NOT NULL')) {
    await importComments(env, project, issue);
  }
}

async function reconcileOne(env: Env) {
  const project = await env.DB.prepare(
    'SELECT * FROM projects WHERE trello_board_id IS NOT NULL AND token_revoked = 0 ORDER BY trello_reconciled_at IS NOT NULL, trello_reconciled_at LIMIT 1',
  ).first<ProjectRow>();
  if (!project || !hasTrello(project)) return;
  try {
    await reconcileBoard(env, project);
  } catch (e) {
    // Its turn is used up either way, so one broken board can't hold up the others.
    await env.DB.prepare('UPDATE projects SET trello_reconciled_at = ? WHERE id = ?').bind(Date.now(), project.id).run();
    if (e instanceof TrelloError && e.revoked) await markTokenRevoked(env, project.id);
    else throw e;
  }
}

async function cleanup(env: Env) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM connect_sessions WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM cli_sessions WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM login_tokens WHERE expires_at < ?').bind(now - DAY),
    env.DB.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(now - 2 * DAY),
  ]);
}

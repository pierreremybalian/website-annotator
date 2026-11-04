// The one write path for issues, whichever way a change comes in (widget, agent API, dashboard): D1 first,
// then the change is pushed to Trello for projects that sync (src/sync.ts). Reads of comments come from D1
// too; a card's comments from before 0.3 are imported from Trello the first time they're needed.

import type { IssueStatus } from '@annotate/shared';
import type { Env } from './env';
import { hasTrello, nowIso, randomId, type CommentRow, type CommentVia, type IssueRow, type ProjectRow } from './db';
import { push } from './sync';
import { importComments } from './ingest';

export interface NewComment {
  via: Exclude<CommentVia, 'trello'>;
  author: string;
  text: string;
  email?: string | null;
  userId?: string | null;
}

export type NewIssue = Omit<
  IssueRow,
  'status' | 'status_at' | 'claimed_by' | 'claimed_until' | 'resolution' | 'trello_card_id' | 'trello_short_url' | 'trello_list_id' | 'trello_pending' | 'comments_imported_at'
>;

const issueById = (env: Env, id: string) => env.DB.prepare('SELECT * FROM issues WHERE id = ?').bind(id).first<IssueRow>();

function commentRow(issueId: string, c: NewComment): CommentRow {
  const now = nowIso();
  return { id: randomId(), issue_id: issueId, via: c.via, author_name: c.author, author_email: c.email ?? null, user_id: c.userId ?? null, text: c.text, trello_action_id: null, created_at: now, updated_at: now };
}

const insertComment = (env: Env, r: CommentRow) =>
  env.DB.prepare(
    'INSERT INTO comments (id, issue_id, via, author_name, author_email, user_id, text, trello_action_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(r.id, r.issue_id, r.via, r.author_name, r.author_email, r.user_id, r.text, r.trello_action_id, r.created_at, r.updated_at);

/** Record a new issue (status new) and create its Trello card. Returns the stored row, with the card if it was created. */
export async function createIssue(env: Env, project: ProjectRow, issue: NewIssue): Promise<IssueRow> {
  const cols = Object.keys(issue) as (keyof NewIssue)[];
  // comments_imported_at: a card we create has no older comments to import.
  await env.DB.prepare(`INSERT INTO issues (${cols.join(', ')}, status, status_at, comments_imported_at) VALUES (${cols.map(() => '?').join(', ')}, 'new', ?, ?)`)
    .bind(...cols.map((k) => issue[k]), Date.now(), nowIso())
    .run();
  await push(env, project, issue.id, async (s) => s.created((await issueById(env, issue.id))!));
  return (await issueById(env, issue.id))!;
}

export async function addComment(env: Env, project: ProjectRow, issue: IssueRow, c: NewComment): Promise<CommentRow> {
  const row = commentRow(issue.id, c);
  await env.DB.batch([insertComment(env, row), env.DB.prepare('UPDATE issues SET updated_at = ? WHERE id = ?').bind(row.created_at, issue.id)]);
  await push(env, project, issue.id, (s) => s.commented(issue, row));
  return row;
}

export interface StatusChange {
  comment?: NewComment;
  /** Stored as the issue's latest resolution note. */
  resolution?: string;
  /** Drop the agent's claim. */
  clearClaim?: boolean;
}

/** Change the issue's status (and post the comment that explains it, if any) in one batch, then push both. */
export async function setStatus(env: Env, project: ProjectRow, issue: IssueRow, status: IssueStatus, change: StatusChange = {}): Promise<IssueRow> {
  const now = nowIso();
  const sets = ['status = ?', 'status_at = ?', 'updated_at = ?'];
  const binds: unknown[] = [status, Date.now(), now];
  if (change.resolution !== undefined) {
    sets.push('resolution = ?');
    binds.push(change.resolution);
  }
  if (change.clearClaim) sets.push('claimed_by = NULL', 'claimed_until = NULL');
  const comment = change.comment ? commentRow(issue.id, change.comment) : null;
  await env.DB.batch([
    env.DB.prepare(`UPDATE issues SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, issue.id),
    ...(comment ? [insertComment(env, comment)] : []),
  ]);
  const updated = (await issueById(env, issue.id))!;
  if (status !== issue.status || comment) {
    await push(env, project, issue.id, async (s) => {
      if (status !== issue.status) await s.statusChanged(updated, issue.status);
      if (comment) await s.commented(updated, comment);
    });
  }
  return (await issueById(env, issue.id)) ?? updated;
}

/** The issue's comments, oldest first. Imports the card's Trello comments the first time (pre-0.3 issues). */
export async function listComments(env: Env, project: ProjectRow, issue: IssueRow): Promise<CommentRow[]> {
  if (issue.trello_card_id && !issue.comments_imported_at && hasTrello(project) && !project.token_revoked) {
    await importComments(env, project, issue);
  }
  const { results } = await env.DB.prepare('SELECT * FROM comments WHERE issue_id = ? ORDER BY created_at, rowid').bind(issue.id).all<CommentRow>();
  return results;
}

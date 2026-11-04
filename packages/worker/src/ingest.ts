// Trello sync, inbound: board webhook actions, the one-time import of a card's older comments, and the cron's
// board pull. All of it writes D1 only and never pushes back to Trello (src/sync.ts), so nothing echoes.
// Our own pushes come back as webhook actions too; they're recognised and skipped:
// - a move to the list we last put the card in, or one older than the issue's latest status change;
// - a comment whose Trello id we stored, or that carries our prefix and matches an unlinked comment.

import type { IssueStatus } from '@annotate/shared';
import type { Env } from './env';
import { hasTrello, nowIso, randomId, statusForList, type IssueRow, type ProjectRow, type TrelloProject } from './db';
import { trelloForProject } from './crypto';
import { TrelloError, type TrelloComment } from './trello';
import { decodeComment } from './card';
import { markTokenRevoked } from './auth';

export interface TrelloAction {
  id?: string;
  type?: string;
  date?: string;
  memberCreator?: { fullName?: string; username?: string };
  data?: {
    text?: string;
    card?: { id?: string; idList?: string; closed?: boolean };
    listAfter?: { id?: string };
    old?: { closed?: boolean; idList?: string };
    board?: { id?: string };
    /** updateComment / deleteComment: the comment itself */
    action?: { id?: string; text?: string };
  };
}

type IssueWithLists = IssueRow & Pick<ProjectRow, 'new_list_id' | 'done_list_ids' | 'review_list_id'>;

/** Apply one board webhook action. Actions for cards we don't track are ignored. */
export async function ingestAction(env: Env, boardId: string, action: TrelloAction): Promise<void> {
  const cardId = action.data?.card?.id;
  if (!action.type || !cardId) return;
  const issue = await env.DB.prepare(
    `SELECT i.*, p.new_list_id, p.done_list_ids, p.review_list_id FROM issues i JOIN projects p ON p.id = i.project_id
     WHERE i.trello_card_id = ? AND p.trello_board_id = ?`,
  )
    .bind(cardId, boardId)
    .first<IssueWithLists>();
  if (!issue) return;

  const data = action.data ?? {};
  const at = Date.parse(action.date ?? '') || Date.now();
  switch (action.type) {
    case 'updateCard':
      if (data.listAfter?.id) return moved(env, issue, at, data.listAfter.id, false);
      if (data.old?.closed !== undefined && data.card?.closed) return moved(env, issue, at, data.card.idList ?? issue.trello_list_id, true);
      if (data.old?.closed !== undefined && data.card?.idList) return moved(env, issue, at, data.card.idList, false);
      return;
    case 'deleteCard':
    case 'moveCardFromBoard':
      // The issue stays (D1 is the source of truth), archived and no longer linked to a card.
      await env.DB.prepare(
        "UPDATE issues SET status = 'archived', status_at = ?, trello_card_id = NULL, trello_short_url = NULL, trello_list_id = NULL, trello_pending = 0, updated_at = ? WHERE id = ?",
      )
        .bind(at, nowIso(), issue.id)
        .run();
      return;
    case 'commentCard':
      if (action.id) await ingestComment(env, issue.id, { id: action.id, date: action.date ?? new Date(at).toISOString(), memberCreator: action.memberCreator, data: { text: data.text ?? '' } });
      return;
    case 'updateComment':
      if (data.action?.id && typeof data.action.text === 'string') {
        const { text } = decodeComment({ data: { text: data.action.text } });
        await env.DB.prepare('UPDATE comments SET text = ?, updated_at = ? WHERE trello_action_id = ? AND issue_id = ?').bind(text, nowIso(), data.action.id, issue.id).run();
      }
      return;
    case 'deleteComment':
      if (data.action?.id) await env.DB.prepare('DELETE FROM comments WHERE trello_action_id = ? AND issue_id = ?').bind(data.action.id, issue.id).run();
      return;
  }
}

/** The card is now in `listId` (archived if `closed`) as of `at`: update the status unless that's stale or ours. */
async function moved(env: Env, issue: IssueWithLists, at: number, listId: string | null, closed: boolean) {
  const status: IssueStatus = closed || !listId ? 'archived' : statusForList(issue, listId);
  if (listId === issue.trello_list_id && status === issue.status) return;
  if (issue.status_at !== null && at < issue.status_at) return;
  await env.DB.prepare('UPDATE issues SET status = ?, status_at = ?, trello_list_id = ?, updated_at = ? WHERE id = ?').bind(status, at, listId, nowIso(), issue.id).run();
}

/** How far apart our comment and its Trello copy can be and still be matched up. */
const MATCH_WINDOW_MS = 10 * 60_000;

/** Store a Trello comment unless we have it: by its id, or (one of ours) by matching the comment it mirrors. */
export async function ingestComment(env: Env, issueId: string, tc: Pick<TrelloComment, 'id' | 'date'> & Parameters<typeof decodeComment>[0]): Promise<void> {
  const seen = await env.DB.prepare('SELECT 1 FROM comments WHERE trello_action_id = ?').bind(tc.id).first();
  if (seen) return;
  const decoded = decodeComment(tc);
  if (decoded.via !== 'trello') {
    const at = Date.parse(tc.date);
    const linked = await env.DB.prepare(
      `UPDATE comments SET trello_action_id = ? WHERE id = (
         SELECT id FROM comments WHERE issue_id = ? AND trello_action_id IS NULL AND via = ? AND text = ?
           AND created_at BETWEEN ? AND ? ORDER BY created_at LIMIT 1
       ) RETURNING id`,
    )
      .bind(tc.id, issueId, decoded.via, decoded.text, new Date(at - MATCH_WINDOW_MS).toISOString(), new Date(at + MATCH_WINDOW_MS).toISOString())
      .first();
    if (linked) return;
  }
  await env.DB.prepare(
    `INSERT OR IGNORE INTO comments (id, issue_id, via, author_name, text, trello_action_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(randomId(), issueId, decoded.via, decoded.author, decoded.text, tc.id, tc.date, tc.date)
    .run();
}

/**
 * Copy a pre-0.3 card's comments into D1, once. Safe to repeat or to race the webhook: comments are keyed by
 * their Trello id. Trello failures leave the issue to be imported later (a 401 flags the token).
 */
export async function importComments(env: Env, project: TrelloProject | ProjectRow, issue: IssueRow): Promise<void> {
  if (!issue.trello_card_id || !hasTrello(project)) return;
  try {
    const trello = await trelloForProject(env, project);
    // Trello returns newest first.
    for (const tc of (await trello.getComments(issue.trello_card_id)).reverse()) await ingestComment(env, issue.id, tc);
    await env.DB.prepare('UPDATE issues SET comments_imported_at = ? WHERE id = ?').bind(nowIso(), issue.id).run();
  } catch (e) {
    if (e instanceof TrelloError && e.revoked) await markTokenRevoked(env, project.id);
    else console.error(`comment import failed for issue ${issue.id}`, e);
  }
}

/** Changes younger than this are left alone by the board pull: a push may still be on its way to Trello. */
const SETTLE_MS = 2 * 60_000;

/**
 * Pull the board and fix any issue whose card was moved or (un)archived without us hearing about it (a missed
 * webhook). Issues waiting on a retried push are skipped: Annotate has the newer state for those.
 */
export async function reconcileBoard(env: Env, project: TrelloProject): Promise<void> {
  const trello = await trelloForProject(env, project);
  const cards = new Map((await trello.boardCards(project.trello_board_id)).map((c) => [c.id, c]));
  const { results } = await env.DB.prepare('SELECT * FROM issues WHERE project_id = ? AND trello_card_id IS NOT NULL AND trello_pending = 0 AND (status_at IS NULL OR status_at < ?)')
    .bind(project.id, Date.now() - SETTLE_MS)
    .all<IssueRow>();
  const updates = [];
  for (const issue of results) {
    const card = cards.get(issue.trello_card_id!);
    if (!card) continue; // deleted cards arrive as a webhook action; a pull can't tell deleted from not listed
    const status: IssueStatus = card.closed ? 'archived' : statusForList(project, card.idList);
    if (status === issue.status && card.idList === issue.trello_list_id) continue;
    updates.push(env.DB.prepare('UPDATE issues SET status = ?, trello_list_id = ?, updated_at = ? WHERE id = ?').bind(status, card.idList, nowIso(), issue.id));
  }
  updates.push(env.DB.prepare('UPDATE projects SET trello_reconciled_at = ? WHERE id = ?').bind(Date.now(), project.id));
  await env.DB.batch(updates);
}

// Trello sync, outbound: mirrors changes that start in Annotate (widget, agent API, dashboard) to the
// project's Trello board. D1 is written first and is the source of truth; a failed push never fails the
// request: the issue is flagged trello_pending and the cron retries it. Changes that start in Trello
// (src/ingest.ts) write D1 only and never come back through here, so nothing echoes.

import type { CreateIssueMeta, IssueStatus } from '@annotate/shared';
import type { Env } from './env';
import { hasTrello, nowIso, type CommentRow, type IssueRow, type ProjectRow, type TrelloProject } from './db';
import { markTokenRevoked } from './auth';
import { trelloForProject } from './crypto';
import { TrelloError, type Trello } from './trello';
import { cardDescription, cardName, trelloCommentText } from './card';
import { ensureProgressList, ensureReviewList } from './progress';

export class TrelloSync {
  constructor(
    private env: Env,
    private project: TrelloProject,
    private trello: Trello,
  ) {}

  /** Create the issue's card (both screenshots attached, the selection as cover) and link it. */
  async created(issue: IssueRow): Promise<IssueRow> {
    const meta: CreateIssueMeta = {
      title: issue.title,
      notes: issue.notes,
      reporter: { name: issue.reporter_name, email: issue.reporter_email },
      anchor: JSON.parse(issue.anchor),
      env: JSON.parse(issue.env),
      ...(issue.context ? { context: JSON.parse(issue.context) } : {}),
    };
    const card = await this.trello.createCard({ idList: this.project.new_list_id, name: cardName(issue.number, issue.title, issue.notes), desc: cardDescription(meta), pos: 'top' });
    await this.env.DB.prepare('UPDATE issues SET trello_card_id = ?, trello_short_url = ?, trello_list_id = ? WHERE id = ?')
      .bind(card.id, card.shortUrl, card.idList, issue.id)
      .run();
    const linked = { ...issue, trello_card_id: card.id, trello_short_url: card.shortUrl, trello_list_id: card.idList };
    // The card exists now: a failed attachment is logged, not retried (it would only duplicate the cover).
    try {
      for (const [key, name, cover] of [
        [issue.screenshot_key, `issue-${issue.number}.${ext(issue.screenshot_key)}`, true],
        [issue.context_key, `issue-${issue.number}-context.${ext(issue.context_key)}`, false],
      ] as const) {
        const obj = await this.env.SCREENSHOTS.get(key);
        if (obj) await this.trello.addAttachment(card.id, new Blob([await obj.arrayBuffer()], { type: obj.httpMetadata?.contentType }), name, cover);
      }
    } catch (e) {
      if (e instanceof TrelloError && e.revoked) throw e;
      console.error(`attachment upload failed for card ${card.id}`, e);
    }
    return linked;
  }

  /**
   * Make the card match issue.status. Always moves (cheap, and idempotent): skipping on what we last saw would
   * leave the card behind after a missed webhook. `from` is the previous status; undefined (a retry) means the
   * card's archived state is unknown too.
   */
  async statusChanged(issue: IssueRow, from?: IssueStatus): Promise<void> {
    const cardId = issue.trello_card_id;
    if (!cardId) return;
    if (issue.status === 'archived') {
      await this.trello.setClosed(cardId, true);
      return;
    }
    if (from === undefined || from === 'archived') await this.trello.setClosed(cardId, false);
    const listId = await this.listFor(issue.status);
    if (!listId) return;
    await this.trello.moveCard(cardId, listId);
    await this.env.DB.prepare('UPDATE issues SET trello_list_id = ? WHERE id = ?').bind(listId, issue.id).run();
  }

  /** Post a comment that started in Annotate and remember which Trello comment mirrors it. */
  async commented(issue: IssueRow, comment: CommentRow): Promise<void> {
    if (!issue.trello_card_id || comment.via === 'trello' || comment.trello_action_id) return;
    const tc = await this.trello.addComment(issue.trello_card_id, trelloCommentText(comment.via, comment.author_name, comment.text));
    // The webhook may have linked it already (src/ingest.ts); either way it's the same Trello comment.
    await this.env.DB.prepare('UPDATE OR IGNORE comments SET trello_action_id = ? WHERE id = ? AND trello_action_id IS NULL').bind(tc.id, comment.id).run();
  }

  /** Everything the cron retries for a flagged issue: the card if it's missing, its list, unposted comments. */
  async catchUp(issue: IssueRow): Promise<void> {
    const row = issue.trello_card_id ? issue : await this.created(issue);
    // A new card starts open in the new list.
    await this.statusChanged(row, issue.trello_card_id ? undefined : 'new');
    const { results } = await this.env.DB.prepare("SELECT * FROM comments WHERE issue_id = ? AND trello_action_id IS NULL AND via <> 'trello' ORDER BY created_at")
      .bind(issue.id)
      .all<CommentRow>();
    for (const c of results) await this.commented(row, c);
  }

  private listFor(status: IssueStatus): Promise<string | null> | string | null {
    switch (status) {
      case 'new':
        return this.project.new_list_id;
      case 'in_progress':
        return ensureProgressList(this.env, this.project, this.trello);
      case 'review':
        return ensureReviewList(this.env, this.project, this.trello);
      case 'resolved':
        return (JSON.parse(this.project.done_list_ids) as string[])[0] ?? null;
      default:
        return null;
    }
  }
}

const ext = (key: string) => key.slice(key.lastIndexOf('.') + 1);

/**
 * Run `f` against the project's Trello board, if it has one. Never throws: on failure the issue is flagged
 * for the cron to retry (a 401 also flags the project's token as revoked). A project whose token is already
 * known to be revoked isn't tried; its issues wait, flagged, until Trello is reconnected.
 */
export async function push(env: Env, project: ProjectRow, issueId: string, f: (s: TrelloSync) => Promise<unknown>): Promise<void> {
  if (!hasTrello(project)) return;
  try {
    if (project.token_revoked) throw new TrelloError(401, 'Trello token revoked');
    await f(new TrelloSync(env, project, await trelloForProject(env, project)));
  } catch (e) {
    const message = e instanceof Error ? e.message.slice(0, 500) : String(e);
    if (e instanceof TrelloError && e.revoked) {
      if (!project.token_revoked) await markTokenRevoked(env, project.id);
    } else console.error(`Trello push failed for issue ${issueId}`, e);
    await env.DB.batch([
      env.DB.prepare('UPDATE issues SET trello_pending = 1 WHERE id = ?').bind(issueId),
      env.DB.prepare('UPDATE projects SET trello_error = ?, updated_at = ? WHERE id = ?').bind(message, nowIso(), project.id),
    ]);
  }
}

// Trello board webhook: keeps issue status in sync when cards move, get archived or deleted.
// Trello sends HEAD when the webhook is created, then POSTs every board action. It retries
// non-2xx responses, so anything we can't use is acknowledged with 200 and ignored.

import { Hono } from 'hono';
import type { IssueStatus } from '@annotate/shared';
import type { AppEnv, Env } from '../env';
import { nowIso, statusForList, type IssueRow, type ProjectRow } from '../db';
import { hmac, safeEqual } from '../crypto';
import { webhookCallbackUrl } from '../connect/util';

interface TrelloWebhookPayload {
  action?: {
    type?: string;
    data?: {
      card?: { id?: string; idList?: string; closed?: boolean };
      listAfter?: { id?: string };
      old?: { closed?: boolean; idList?: string };
      board?: { id?: string };
    };
  };
  model?: { id?: string };
}

/** The project columns statusForList needs; review_list_id makes a move to the review list → 'review'. */
type ListIds = Pick<ProjectRow, 'new_list_id' | 'done_list_ids' | 'review_list_id'>;

type Change = { kind: 'status'; status: IssueStatus } | { kind: 'delete' } | null;

const app = new Hono<AppEnv>();

// Trello verifies the callback URL with HEAD (Hono serves HEAD from GET routes).
app.get('/', (c) => c.body(null, 200));

app.post('/', async (c) => {
  const raw = await c.req.text();
  const signature = c.req.header('X-Trello-Webhook') ?? '';
  if (!c.env.TRELLO_SECRET) {
    console.error('webhook: TRELLO_SECRET is not set; rejecting');
    return c.body(null, 401);
  }
  const expected = await hmac('SHA-1', c.env.TRELLO_SECRET, raw + webhookCallbackUrl(c.env));
  if (!safeEqual(signature, expected)) return c.body(null, 401);

  try {
    await handle(c.env, JSON.parse(raw) as TrelloWebhookPayload);
  } catch (e) {
    // A missed update fixes itself: GET /v1/issues/:id refreshes status from the card.
    console.error('webhook: failed to process action', e);
  }
  return c.body(null, 200);
});

export default app;

async function handle(env: Env, payload: TrelloWebhookPayload) {
  const db = env.DB;
  const action = payload.action;
  const cardId = action?.data?.card?.id;
  const boardId = payload.model?.id ?? action?.data?.board?.id;
  if (!action?.type || !cardId || !boardId) return;

  const issue = await db
    .prepare(
      `SELECT i.id, i.screenshot_key, i.context_key, p.new_list_id, p.done_list_ids, p.review_list_id FROM issues i JOIN projects p ON p.id = i.project_id
       WHERE i.trello_card_id = ? AND p.trello_board_id = ?`,
    )
    .bind(cardId, boardId)
    .first<Pick<IssueRow, 'id' | 'screenshot_key' | 'context_key'> & ListIds>();
  if (!issue) return;

  const change = changeFor(action, issue);
  if (!change) return;
  if (change.kind === 'delete') {
    await db.prepare('DELETE FROM issues WHERE id = ?').bind(issue.id).run();
    await env.SCREENSHOTS.delete([issue.screenshot_key, issue.context_key]);
  } else {
    await db.prepare('UPDATE issues SET status = ?, updated_at = ? WHERE id = ?').bind(change.status, nowIso(), issue.id).run();
  }
}

function changeFor(action: NonNullable<TrelloWebhookPayload['action']>, project: ListIds): Change {
  const data = action.data ?? {};
  switch (action.type) {
    case 'updateCard':
      if (data.listAfter?.id) return { kind: 'status', status: statusForList(project, data.listAfter.id) };
      if (data.old && data.old.closed !== undefined) {
        if (data.card?.closed) return { kind: 'status', status: 'archived' };
        if (data.card?.idList) return { kind: 'status', status: statusForList(project, data.card.idList) };
      }
      return null;
    case 'deleteCard':
      return { kind: 'delete' };
    case 'moveCardFromBoard':
      return { kind: 'status', status: 'archived' };
    default:
      return null;
  }
}

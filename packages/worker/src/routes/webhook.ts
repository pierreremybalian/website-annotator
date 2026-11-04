// Trello board webhook: card moves, archiving, deletes and comments made in Trello flow into D1 (src/ingest.ts).
// Trello sends HEAD when the webhook is created, then POSTs every board action. It retries non-2xx responses,
// so anything we can't use is acknowledged with 200 and ignored.

import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { hmac, safeEqual } from '../crypto';
import { webhookCallbackUrls } from '../connect/util';
import { ingestAction, type TrelloAction } from '../ingest';

interface TrelloWebhookPayload {
  action?: TrelloAction;
  model?: { id?: string };
}

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
  // The signature covers the URL the webhook was registered with, which may be the Worker's earlier one.
  let valid = false;
  for (const url of webhookCallbackUrls(c.env)) valid ||= safeEqual(signature, await hmac('SHA-1', c.env.TRELLO_SECRET, raw + url));
  if (!valid) return c.body(null, 401);

  try {
    const payload = JSON.parse(raw) as TrelloWebhookPayload;
    const boardId = payload.model?.id ?? payload.action?.data?.board?.id;
    if (boardId && payload.action) await ingestAction(c.env, boardId, payload.action);
  } catch (e) {
    // A missed update fixes itself: the cron pulls each board (src/ingest.ts reconcileBoard).
    console.error('webhook: failed to process action', e);
  }
  return c.body(null, 200);
});

export default app;

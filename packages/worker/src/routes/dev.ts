// Dev/test helpers. Every route 404s unless TRELLO_MOCK=1. Used by local dev and e2e tests.
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { nowIso } from '../db';
import { apiError } from '../auth';
import { encryptToken } from '../crypto';
import { MOCK_TOKEN, mockMoveCard, mockTrelloState } from '../trello';

export const DEV_PROJECT = {
  id: 'dev',
  publicKey: 'dev-project',
  accessKey: 'dev-access',
  name: 'Dev site',
  allowedOrigins: ['http://localhost:5173', 'http://localhost:8787'],
  boardId: 'board-1',
  boardName: 'Mock Board',
  newListId: 'list-1',
  doneListIds: ['list-3'],
};

const app = new Hono<AppEnv>();

app.use('*', async (c, next) => {
  if (c.env.TRELLO_MOCK !== '1') return apiError(c, 404, 'not_found', 'Not found');
  await next();
});

async function seed(c: Context<AppEnv>) {
  const p = DEV_PROJECT;
  const boardUrl = mockTrelloState().boards.get(p.boardId)?.url ?? 'https://trello.com/b/mock1/mock-board';
  const tokenEnc = await encryptToken(c.env, MOCK_TOKEN);
  const now = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO projects (id, name, public_key, access_key, allowed_origins, trello_token_enc, trello_member_id,
       trello_board_id, trello_board_name, trello_board_url, new_list_id, done_list_ids, token_revoked, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'member-1', ?, ?, ?, ?, ?, 0, ?, ?)
     ON CONFLICT (public_key) DO UPDATE SET
       name = excluded.name, access_key = excluded.access_key, allowed_origins = excluded.allowed_origins,
       trello_token_enc = excluded.trello_token_enc, trello_member_id = excluded.trello_member_id,
       trello_board_id = excluded.trello_board_id, trello_board_name = excluded.trello_board_name,
       trello_board_url = excluded.trello_board_url, new_list_id = excluded.new_list_id,
       done_list_ids = excluded.done_list_ids, token_revoked = 0, updated_at = excluded.updated_at`,
  )
    .bind(p.id, p.name, p.publicKey, p.accessKey, JSON.stringify(p.allowedOrigins), tokenEnc, p.boardId, p.boardName, boardUrl, p.newListId, JSON.stringify(p.doneListIds), now, now)
    .run();
  const row = await c.env.DB.prepare('SELECT id FROM projects WHERE public_key = ?').bind(p.publicKey).first<{ id: string }>();
  return c.json({ projectId: row?.id ?? p.id, projectKey: p.publicKey, accessKey: p.accessKey, boardName: p.boardName, boardUrl, endpoint: c.env.PUBLIC_URL });
}

app.post('/seed', seed);
app.get('/seed', seed);

app.post('/move-card', async (c) => {
  const body = await c.req.json<{ cardId?: string; listId?: string }>().catch(() => ({}) as { cardId?: string; listId?: string });
  if (!body.cardId || !body.listId) return apiError(c, 400, 'bad_request', 'cardId and listId are required');
  if (!mockTrelloState().cards.has(body.cardId)) return apiError(c, 404, 'not_found', 'Card not found');
  mockMoveCard(body.cardId, body.listId);
  return c.json({ ok: true });
});

/** Test helper: delete a card from the fake, like a user deleting it in Trello. */
app.post('/delete-card', async (c) => {
  const body = await c.req.json<{ cardId?: string }>().catch(() => ({}) as { cardId?: string });
  if (!body.cardId) return apiError(c, 400, 'bad_request', 'cardId is required');
  const state = mockTrelloState();
  if (!state.cards.has(body.cardId)) return apiError(c, 404, 'not_found', 'Card not found');
  state.cards.delete(body.cardId);
  state.comments.delete(body.cardId);
  return c.json({ ok: true });
});

app.get('/state', (c) => {
  const s = mockTrelloState();
  return c.json({
    boards: [...s.boards.values()],
    lists: [...s.lists.values()],
    // The fake keeps only attachment metadata (name, size, cover), never the bytes.
    cards: [...s.cards.values()].map((card) => ({ ...card, attachments: card.attachments.map(({ id, name, size, cover }) => ({ id, name, size, cover })) })),
    comments: [...s.comments.entries()].map(([cardId, comments]) => ({ cardId, comments })),
    webhooks: [...s.webhooks.values()],
    seq: s.seq,
  });
});

export default app;

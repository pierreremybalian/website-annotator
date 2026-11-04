// Dev/test helpers. Every route 404s unless TRELLO_MOCK=1. Used by local dev and e2e tests.
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { nowIso } from '../db';
import { apiError } from '../auth';
import { encryptToken, sha256Hex } from '../crypto';
import { MOCK_TOKEN, mockAddComment, mockMoveCard, mockTrelloState } from '../trello';
import { ingestAction } from '../ingest';
import { sentMail } from '../mail';

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
  /** Agent API token for the dev project (stored hashed, like real ones). */
  agentToken: 'at_dev-token',
};

/** The dev agency and its owner; both dev projects belong to it. Log in as DEV_USER (the code is in /dev/mail). */
export const DEV_ORG = { id: 'dev-org', name: 'Dev agency' };
export const DEV_USER = { id: 'dev-user', email: 'dev@annotate.test', name: 'Dev Owner' };

async function seedOrg(c: Context<AppEnv>) {
  const now = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT OR IGNORE INTO orgs (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').bind(DEV_ORG.id, DEV_ORG.name, now, now),
    c.env.DB.prepare('INSERT OR IGNORE INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)').bind(DEV_USER.id, DEV_USER.email, DEV_USER.name, now),
    c.env.DB.prepare("INSERT OR IGNORE INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").bind(DEV_ORG.id, DEV_USER.id, now),
    c.env.DB.prepare("UPDATE projects SET org_id = ? WHERE id IN ('dev', 'dev-native') AND org_id IS NULL").bind(DEV_ORG.id),
  ]);
}

/** A dev project without a Trello board: `/dev/seed?trello=0`. */
export const DEV_NATIVE_PROJECT = {
  id: 'dev-native',
  publicKey: 'dev-native-project',
  accessKey: 'dev-native-access',
  name: 'Dev site (no Trello)',
  agentToken: 'at_dev-native-token',
};

/** What the fake board's webhook would deliver for a change made in Trello. */
const deliver = (c: Context<AppEnv>, cardId: string, action: Record<string, unknown>) =>
  ingestAction(c.env, DEV_PROJECT.boardId, { id: `action-dev-${Date.now()}`, date: new Date().toISOString(), ...action, data: { card: { id: cardId }, ...(action.data as object) } });

const app = new Hono<AppEnv>();

app.use('*', async (c, next) => {
  if (c.env.TRELLO_MOCK !== '1') return apiError(c, 404, 'not_found', 'Not found');
  await next();
});

async function seedNative(c: Context<AppEnv>) {
  const p = DEV_NATIVE_PROJECT;
  const now = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO projects (id, name, public_key, access_key, allowed_origins, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (public_key) DO UPDATE SET name = excluded.name, access_key = excluded.access_key, allowed_origins = excluded.allowed_origins, updated_at = excluded.updated_at`,
  )
    .bind(p.id, p.name, p.publicKey, p.accessKey, JSON.stringify(DEV_PROJECT.allowedOrigins), now, now)
    .run();
  await c.env.DB.prepare(`INSERT OR REPLACE INTO agent_tokens (id, project_id, token_hash, label, created_at) VALUES ('dev-native-agent', ?, ?, 'dev', ?)`)
    .bind(p.id, await sha256Hex(p.agentToken), now)
    .run();
  await seedOrg(c);
  return c.json({ projectId: p.id, projectKey: p.publicKey, accessKey: p.accessKey, agentToken: p.agentToken, boardName: null, boardUrl: null, endpoint: c.env.PUBLIC_URL });
}

async function seed(c: Context<AppEnv>) {
  if (c.req.query('trello') === '0') return seedNative(c);
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
  const projectId = row?.id ?? p.id;
  // The progress list is left alone: ensureProgressList finds or creates it on the first agent claim.
  await c.env.DB.prepare(`INSERT OR REPLACE INTO agent_tokens (id, project_id, token_hash, label, created_at) VALUES ('dev-agent', ?, ?, 'dev', ?)`)
    .bind(projectId, await sha256Hex(p.agentToken), now)
    .run();
  await seedOrg(c);
  return c.json({
    projectId,
    projectKey: p.publicKey,
    accessKey: p.accessKey,
    agentToken: p.agentToken,
    boardName: p.boardName,
    boardUrl,
    endpoint: c.env.PUBLIC_URL,
  });
}

app.post('/seed', seed);
app.get('/seed', seed);

app.post('/move-card', async (c) => {
  const body = await c.req.json<{ cardId?: string; listId?: string }>().catch(() => ({}) as { cardId?: string; listId?: string });
  if (!body.cardId || !body.listId) return apiError(c, 400, 'bad_request', 'cardId and listId are required');
  if (!mockTrelloState().cards.has(body.cardId)) return apiError(c, 404, 'not_found', 'Card not found');
  mockMoveCard(body.cardId, body.listId);
  await deliver(c, body.cardId, { type: 'updateCard', data: { card: { id: body.cardId, idList: body.listId }, listAfter: { id: body.listId } } });
  return c.json({ ok: true });
});

/** Test helper: a board member comments on the card in Trello. */
app.post('/trello-comment', async (c) => {
  const body = await c.req.json<{ cardId?: string; text?: string; author?: string }>().catch(() => ({}) as { cardId?: string; text?: string; author?: string });
  if (!body.cardId || !body.text) return apiError(c, 400, 'bad_request', 'cardId and text are required');
  if (!mockTrelloState().cards.has(body.cardId)) return apiError(c, 404, 'not_found', 'Card not found');
  const tc = mockAddComment(body.cardId, body.text, { fullName: body.author ?? 'Trello Person', username: 'person' });
  await deliver(c, body.cardId, { id: tc.id, type: 'commentCard', date: tc.date, memberCreator: tc.memberCreator, data: { text: tc.data.text } });
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
  await deliver(c, body.cardId, { type: 'deleteCard' });
  return c.json({ ok: true });
});

/** Mail that would have been sent (no MAIL_PROVIDER in dev), newest first. */
app.get('/mail', (c) => c.json({ mail: [...sentMail()].reverse() }));

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

import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { hmac } from '../src/crypto';
import { nowIso, randomId, type IssueRow } from '../src/db';

const URL_ = 'http://localhost:8787/trello/webhook'; // PUBLIC_URL + /trello/webhook
const BOARD = 'wh-board';
const NEW = 'wh-list-new';
const DOING = 'wh-list-doing';
const DONE = 'wh-list-done';
const REVIEW = 'wh-list-review';

let cardId: string;
let issueId: string;
let shotKey: string;
let contextKey: string;

async function seed() {
  const projectId = randomId();
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO projects (id, name, public_key, access_key, allowed_origins, trello_token_enc, trello_member_id, trello_board_id,
       trello_board_name, trello_board_url, new_list_id, done_list_ids, review_list_id, webhook_id, created_at, updated_at)
     VALUES (?, 'Site', ?, ?, '["http://site.test"]', 'x.y', 'member-1', ?, 'Board', 'https://trello.com/b/wh', ?, ?, ?, 'hook-1', ?, ?)`,
  )
    .bind(projectId, `pk_${randomId()}`, `ak_${randomId(24)}`, BOARD, NEW, JSON.stringify([DONE]), REVIEW, now, now)
    .run();
  cardId = `card-${randomId(6)}`;
  issueId = randomId();
  shotKey = `shots/${issueId}.png`;
  contextKey = `shots/${issueId}-context.jpg`;
  await env.SCREENSHOTS.put(shotKey, 'png');
  await env.SCREENSHOTS.put(contextKey, 'jpg');
  await env.DB.prepare(
    `INSERT INTO issues (id, project_id, number, trello_card_id, trello_short_url, page_url, page_url_raw, title, notes, anchor, env,
       reporter_name, reporter_email, screenshot_key, context_key, status, created_at, updated_at)
     VALUES (?, ?, 1, ?, 'https://trello.com/c/x', 'http://site.test/', 'http://site.test/', 't', 'n', '{}', '{}', 'R', 'r@x.test', ?, ?, 'new', ?, ?)`,
  )
    .bind(issueId, projectId, cardId, shotKey, contextKey, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')
    .run();
}

const issue = () => env.DB.prepare('SELECT * FROM issues WHERE id = ?').bind(issueId).first<IssueRow>();

async function send(payload: unknown, signature?: string) {
  const body = JSON.stringify(payload);
  return SELF.fetch(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-trello-webhook': signature ?? (await hmac('SHA-1', 'mock-secret', body + URL_)) },
    body,
  });
}

const action = (type: string, data: object, board = BOARD) => ({ model: { id: board }, action: { id: randomId(), type, data: { board: { id: board }, ...data } } });
const moveTo = (list: string) => action('updateCard', { card: { id: cardId, idList: list }, listBefore: { id: NEW }, listAfter: { id: list }, old: { idList: NEW } });

beforeEach(seed);

describe('trello webhook', () => {
  it('answers Trello’s HEAD/GET callback check', async () => {
    expect((await SELF.fetch(URL_, { method: 'HEAD' })).status).toBe(200);
    expect((await SELF.fetch(URL_)).status).toBe(200);
  });

  it('rejects a bad or missing signature', async () => {
    expect((await send(moveTo(DONE), 'bm90LXRoZS1yaWdodC1zaWc=')).status).toBe(401);
    expect((await send(moveTo(DONE), '')).status).toBe(401);
    // Signed for another callback URL.
    const body = JSON.stringify(moveTo(DONE));
    expect((await send(moveTo(DONE), await hmac('SHA-1', 'mock-secret', body + 'https://elsewhere.test/trello/webhook'))).status).toBe(401);
    expect((await issue())!.status).toBe('new');
  });

  it('maps list moves to statuses', async () => {
    expect((await send(moveTo(DONE))).status).toBe(200);
    const resolved = (await issue())!;
    expect(resolved.status).toBe('resolved');
    expect(resolved.updated_at).not.toBe('2020-01-01T00:00:00.000Z');

    await send(moveTo(DOING));
    expect((await issue())!.status).toBe('in_progress');

    await send(moveTo(NEW));
    expect((await issue())!.status).toBe('new');
  });

  it('maps a move to the review list to review', async () => {
    await send(moveTo(REVIEW));
    expect((await issue())!.status).toBe('review');
    await send(moveTo(DONE));
    expect((await issue())!.status).toBe('resolved');
  });

  it('marks archived cards and restores unarchived ones', async () => {
    await send(action('updateCard', { card: { id: cardId, closed: true }, old: { closed: false } }));
    expect((await issue())!.status).toBe('archived');

    await send(action('updateCard', { card: { id: cardId, closed: false, idList: DONE }, old: { closed: true } }));
    expect((await issue())!.status).toBe('resolved');
  });

  it('deletes the issue and its screenshots when the card is deleted', async () => {
    expect(await env.SCREENSHOTS.head(shotKey)).not.toBeNull();
    expect((await send(action('deleteCard', { card: { id: cardId, idShort: 1 } }))).status).toBe(200);
    expect(await issue()).toBeNull();
    expect(await env.SCREENSHOTS.head(shotKey)).toBeNull();
    expect(await env.SCREENSHOTS.head(contextKey)).toBeNull();
  });

  it('archives the issue when the card moves to another board', async () => {
    await send(action('moveCardFromBoard', { card: { id: cardId }, boardTarget: { id: 'other-board' } }));
    expect((await issue())!.status).toBe('archived');
  });

  it('ignores unknown boards, unknown cards, other actions and junk', async () => {
    const other = { model: { id: 'unknown-board' }, action: { type: 'updateCard', data: { card: { id: cardId }, listAfter: { id: DONE } } } };
    expect((await send(other)).status).toBe(200);
    expect((await send(action('updateCard', { card: { id: 'card-unknown' }, listAfter: { id: DONE } }))).status).toBe(200);
    expect((await send(action('commentCard', { card: { id: cardId }, text: 'hi' }))).status).toBe(200);
    expect((await send(action('updateCard', { card: { id: cardId, name: 'Renamed' }, old: { name: 'x' } }))).status).toBe(200);
    expect((await issue())!.status).toBe('new');
    expect(await env.SCREENSHOTS.head(shotKey)).not.toBeNull();

    const junk = 'not json';
    const res = await SELF.fetch(URL_, { method: 'POST', headers: { 'x-trello-webhook': await hmac('SHA-1', 'mock-secret', junk + URL_) }, body: junk });
    expect(res.status).toBe(200);
  });
});

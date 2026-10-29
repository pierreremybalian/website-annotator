// Thin Trello REST client. With TRELLO_MOCK=1 every call hits an in-memory fake instead,
// so the whole system runs and tests without Trello credentials.

import type { Env } from './env';

const API = 'https://api.trello.com/1';

export interface TrelloMember {
  id: string;
  username: string;
  fullName: string;
  idOrganizations: string[];
}
export interface TrelloBoard {
  id: string;
  name: string;
  url: string;
  idOrganization: string | null;
}
export interface TrelloList {
  id: string;
  name: string;
  pos: number;
}
export interface TrelloCard {
  id: string;
  name: string;
  idList: string;
  closed: boolean;
  shortUrl: string;
  url: string;
}
export interface TrelloComment {
  id: string;
  date: string;
  memberCreator: { fullName: string; username: string };
  data: { text: string };
}
export interface TrelloWebhook {
  id: string;
}

export class TrelloError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
  /** 401 means the stored token was revoked or expired. */
  get revoked() {
    return this.status === 401;
  }
}

export interface Trello {
  me(): Promise<TrelloMember>;
  boards(): Promise<TrelloBoard[]>;
  lists(boardId: string): Promise<TrelloList[]>;
  createBoard(name: string, idOrganization?: string | null): Promise<TrelloBoard>;
  createList(boardId: string, name: string, pos: number | 'top' | 'bottom'): Promise<TrelloList>;
  createCard(input: { idList: string; name: string; desc: string; pos?: 'top' | 'bottom' }): Promise<TrelloCard>;
  addAttachment(cardId: string, file: Blob, name: string, setCover?: boolean): Promise<{ id: string }>;
  /** Returns null when the card no longer exists. */
  getCard(cardId: string): Promise<TrelloCard | null>;
  /** Move a card to another list (top of the list). */
  moveCard(cardId: string, idList: string): Promise<TrelloCard>;
  /** Newest first, as Trello returns them. */
  getComments(cardId: string): Promise<TrelloComment[]>;
  addComment(cardId: string, text: string): Promise<TrelloComment>;
  createWebhook(callbackURL: string, idModel: string, description: string): Promise<TrelloWebhook>;
  deleteWebhook(id: string): Promise<void>;
}

/** URL the user is sent to to grant a token. The token comes back in the return_url fragment as #token=... */
export function authorizeUrl(env: Env, returnUrl: string, appName = 'Annotate'): string {
  if (env.TRELLO_MOCK === '1') return `${returnUrl}#token=${MOCK_TOKEN}`;
  const q = new URLSearchParams({
    key: env.TRELLO_KEY,
    name: appName,
    scope: 'read,write',
    expiration: 'never',
    response_type: 'token',
    callback_method: 'fragment',
    return_url: returnUrl,
  });
  return `https://trello.com/1/authorize?${q}`;
}

export function trello(env: Env, token: string): Trello {
  return env.TRELLO_MOCK === '1' ? new MockTrello(token) : new HttpTrello(env.TRELLO_KEY, token);
}

class HttpTrello implements Trello {
  constructor(
    private key: string,
    private token: string,
  ) {}

  private async req<T>(method: string, path: string, params?: Record<string, string>, body?: BodyInit): Promise<T> {
    const url = new URL(API + path);
    if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url, {
      method,
      body,
      headers: { Authorization: `OAuth oauth_consumer_key="${this.key}", oauth_token="${this.token}"`, Accept: 'application/json' },
    });
    if (!res.ok) throw new TrelloError(res.status, `Trello ${method} ${path} → ${res.status}: ${await res.text()}`);
    if (res.status === 204) return undefined as T;
    return res.json<T>();
  }

  me() {
    return this.req<TrelloMember>('GET', '/members/me', { fields: 'id,username,fullName,idOrganizations' });
  }
  boards() {
    return this.req<TrelloBoard[]>('GET', '/members/me/boards', { filter: 'open', fields: 'id,name,url,idOrganization' });
  }
  lists(boardId: string) {
    return this.req<TrelloList[]>('GET', `/boards/${boardId}/lists`, { filter: 'open', fields: 'id,name,pos' });
  }
  createBoard(name: string, idOrganization?: string | null) {
    const p: Record<string, string> = { name, defaultLists: 'false', prefs_permissionLevel: 'private' };
    if (idOrganization) p.idOrganization = idOrganization;
    return this.req<TrelloBoard>('POST', '/boards', p);
  }
  createList(boardId: string, name: string, pos: number | 'top' | 'bottom') {
    return this.req<TrelloList>('POST', '/lists', { idBoard: boardId, name, pos: String(pos) });
  }
  createCard(input: { idList: string; name: string; desc: string; pos?: 'top' | 'bottom' }) {
    return this.req<TrelloCard>('POST', '/cards', { idList: input.idList, name: input.name, desc: input.desc, pos: input.pos ?? 'top' });
  }
  addAttachment(cardId: string, file: Blob, name: string, setCover = false) {
    const form = new FormData();
    form.set('file', file, name);
    form.set('name', name);
    form.set('setCover', String(setCover));
    return this.req<{ id: string }>('POST', `/cards/${cardId}/attachments`, undefined, form);
  }
  async getCard(cardId: string) {
    try {
      return await this.req<TrelloCard>('GET', `/cards/${cardId}`, { fields: 'id,name,idList,closed,shortUrl,url' });
    } catch (e) {
      if (e instanceof TrelloError && e.status === 404) return null;
      throw e;
    }
  }
  moveCard(cardId: string, idList: string) {
    return this.req<TrelloCard>('PUT', `/cards/${cardId}`, { idList, pos: 'top' });
  }
  getComments(cardId: string) {
    return this.req<TrelloComment[]>('GET', `/cards/${cardId}/actions`, { filter: 'commentCard', limit: '100' });
  }
  addComment(cardId: string, text: string) {
    return this.req<TrelloComment>('POST', `/cards/${cardId}/actions/comments`, { text });
  }
  createWebhook(callbackURL: string, idModel: string, description: string) {
    return this.req<TrelloWebhook>('POST', '/webhooks', { callbackURL, idModel, description });
  }
  async deleteWebhook(id: string) {
    await this.req<void>('DELETE', `/webhooks/${id}`);
  }
}

// ---------------------------------------------------------------------------
// In-memory fake. State is module-level, so it lives as long as the isolate
// (good enough for `wrangler dev` and tests). Call resetMockTrello() between tests.

export const MOCK_TOKEN = 'mock-token';
export const MOCK_ORG_ID = 'mock-org';
/** A second valid login: a member outside MOCK_ORG_ID, for access-control tests. */
export const MOCK_TOKEN_OUTSIDER = 'mock-token-outsider';

interface MockState {
  boards: Map<string, TrelloBoard>;
  lists: Map<string, TrelloList & { idBoard: string }>;
  cards: Map<string, TrelloCard & { desc: string; attachments: { id: string; name: string; size: number; cover: boolean }[] }>;
  comments: Map<string, TrelloComment[]>;
  webhooks: Map<string, { id: string; callbackURL: string; idModel: string }>;
  seq: number;
}

let mock: MockState = freshMock();

function freshMock(): MockState {
  const s: MockState = { boards: new Map(), lists: new Map(), cards: new Map(), comments: new Map(), webhooks: new Map(), seq: 0 };
  const board: TrelloBoard = { id: 'board-1', name: 'Mock Board', url: 'https://trello.com/b/mock1/mock-board', idOrganization: MOCK_ORG_ID };
  s.boards.set(board.id, board);
  ['To Do', 'Doing', 'Done'].forEach((name, i) => s.lists.set(`list-${i + 1}`, { id: `list-${i + 1}`, name, pos: (i + 1) * 1024, idBoard: board.id }));
  return s;
}

export function resetMockTrello() {
  mock = freshMock();
}

/** Test/dev helper: inspect the fake's state. */
export function mockTrelloState(): Readonly<MockState> {
  return mock;
}

/** Test/dev helper: move a card to another list, like a user dragging it in Trello. */
export function mockMoveCard(cardId: string, idList: string) {
  const c = mock.cards.get(cardId);
  if (c) c.idList = idList;
}

class MockTrello implements Trello {
  constructor(private token: string) {}

  private auth() {
    if (this.token !== MOCK_TOKEN && this.token !== MOCK_TOKEN_OUTSIDER) throw new TrelloError(401, 'invalid token');
  }
  private id(prefix: string) {
    return `${prefix}-${++mock.seq}-${Math.random().toString(36).slice(2, 8)}`;
  }

  async me() {
    this.auth();
    if (this.token === MOCK_TOKEN_OUTSIDER) return { id: 'member-2', username: 'outsider', fullName: 'Out Sider', idOrganizations: ['outsider-org'] };
    return { id: 'member-1', username: 'mockuser', fullName: 'Mock User', idOrganizations: [MOCK_ORG_ID] };
  }
  async boards() {
    this.auth();
    return [...mock.boards.values()];
  }
  async lists(boardId: string) {
    this.auth();
    if (!mock.boards.has(boardId)) throw new TrelloError(404, 'board not found');
    return [...mock.lists.values()].filter((l) => l.idBoard === boardId).sort((a, b) => a.pos - b.pos).map(({ id, name, pos }) => ({ id, name, pos }));
  }
  async createBoard(name: string, idOrganization?: string | null) {
    this.auth();
    const id = this.id('board');
    const board = { id, name, url: `https://trello.com/b/${id}`, idOrganization: idOrganization ?? null };
    mock.boards.set(id, board);
    return board;
  }
  async createList(boardId: string, name: string, pos: number | 'top' | 'bottom') {
    this.auth();
    const existing = [...mock.lists.values()].filter((l) => l.idBoard === boardId).map((l) => l.pos);
    const p = typeof pos === 'number' ? pos : pos === 'top' ? Math.min(0, ...existing) - 1024 : Math.max(0, ...existing) + 1024;
    const list = { id: this.id('list'), name, pos: p, idBoard: boardId };
    mock.lists.set(list.id, list);
    return { id: list.id, name, pos: p };
  }
  async createCard(input: { idList: string; name: string; desc: string }) {
    this.auth();
    if (!mock.lists.has(input.idList)) throw new TrelloError(400, 'invalid idList');
    const id = this.id('card');
    const card = { id, name: input.name, idList: input.idList, closed: false, shortUrl: `https://trello.com/c/${id}`, url: `https://trello.com/c/${id}/x`, desc: input.desc, attachments: [] };
    mock.cards.set(id, card);
    const { desc: _d, attachments: _a, ...pub } = card;
    return pub;
  }
  async addAttachment(cardId: string, file: Blob, name: string, setCover = false) {
    this.auth();
    const c = mock.cards.get(cardId);
    if (!c) throw new TrelloError(404, 'card not found');
    const att = { id: this.id('att'), name, size: file.size, cover: setCover };
    c.attachments.push(att);
    return { id: att.id };
  }
  async getCard(cardId: string) {
    this.auth();
    const c = mock.cards.get(cardId);
    if (!c) return null;
    const { desc: _d, attachments: _a, ...pub } = c;
    return pub;
  }
  async moveCard(cardId: string, idList: string) {
    this.auth();
    const c = mock.cards.get(cardId);
    if (!c) throw new TrelloError(404, 'card not found');
    if (!mock.lists.has(idList)) throw new TrelloError(400, 'invalid idList');
    c.idList = idList;
    const { desc: _d, attachments: _a, ...pub } = c;
    return pub;
  }
  async getComments(cardId: string) {
    this.auth();
    return [...(mock.comments.get(cardId) ?? [])].reverse();
  }
  async addComment(cardId: string, text: string) {
    this.auth();
    if (!mock.cards.has(cardId)) throw new TrelloError(404, 'card not found');
    const comment: TrelloComment = { id: this.id('action'), date: new Date().toISOString(), memberCreator: { fullName: 'Mock User', username: 'mockuser' }, data: { text } };
    mock.comments.set(cardId, [...(mock.comments.get(cardId) ?? []), comment]);
    return comment;
  }
  async createWebhook(callbackURL: string, idModel: string, _description: string) {
    this.auth();
    const hook = { id: this.id('webhook'), callbackURL, idModel };
    mock.webhooks.set(hook.id, hook);
    return { id: hook.id };
  }
  async deleteWebhook(id: string) {
    this.auth();
    mock.webhooks.delete(id);
  }
}

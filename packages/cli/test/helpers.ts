import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentIssueDetail } from '@annotate/shared';
import { run } from '../src/cli';
import type { Ctx } from '../src/context';

export const NOW = Date.parse('2026-10-28T12:00:00Z');

export function tmpDir(): string {
  return realpathSync(mkdtempSync(path.join(os.tmpdir(), 'annotate-cli-')));
}

/** Write files: { 'a/b.txt': 'content' } under root. Objects are JSON-encoded. */
export function writeTree(root: string, files: Record<string, string | object>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content));
  }
}

export interface FetchCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | Error;
export type Handler = (call: FetchCall) => Reply | Promise<Reply>;

export function mockFetch(handler: Handler): typeof fetch & { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) headers[k.toLowerCase()] = v;
    const raw = init?.body;
    const call: FetchCall = {
      method: init?.method ?? 'GET',
      url: String(input),
      headers,
      body: typeof raw === 'string' ? JSON.parse(raw) : undefined,
    };
    calls.push(call);
    const reply = await handler(call);
    if (reply instanceof Error) throw reply;
    const isBytes = reply.body instanceof Uint8Array;
    const body = reply.body === undefined ? null : isBytes ? (reply.body as Uint8Array) : JSON.stringify(reply.body);
    return new Response(body as ConstructorParameters<typeof Response>[0], {
      status: reply.status,
      headers: reply.headers ?? (isBytes ? {} : { 'content-type': 'application/json' }),
    });
  }) as typeof fetch & { calls: FetchCall[] };
  fn.calls = calls;
  return fn;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function runCli(argv: string[], ctx: Partial<Ctx> = {}): Promise<RunResult> {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, {
    cwd: ctx.cwd ?? tmpDir(),
    env: {},
    homedir: ctx.homedir ?? tmpDir(),
    agentName: 'tester@box',
    hostname: 'box',
    now: () => NOW,
    sleep: async () => {},
    pollIntervalMs: 0,
    openUrl: () => true,
    fetch: mockFetch(() => ({ status: 500, body: { error: 'unexpected request', code: 'internal' } })),
    ...ctx,
    stdout: { write: (s: string) => (stdout += s), isTTY: false },
    stderr: { write: (s: string) => (stderr += s), isTTY: false },
  });
  return { code, stdout, stderr };
}

/** A configured project directory (with .annotate.json) to run commands in. */
export function configuredDir(extra: object = {}): string {
  const dir = tmpDir();
  writeTree(dir, {
    '.annotate.json': { endpoint: 'https://annotate.test', projectKey: 'pk_test', agentToken: 'at_test', ...extra },
  });
  return dir;
}

export function issueFixture(overrides: Partial<AgentIssueDetail> = {}): AgentIssueDetail {
  return {
    id: 'iss_1',
    number: 12,
    title: 'Hero button overlaps the menu on mobile',
    status: 'new',
    pageUrl: 'https://example.com/about?ref=nav',
    notes: 'The orange CTA covers the hamburger menu.\nOnly on my phone.',
    reporterName: 'Jane Client',
    createdAt: '2026-10-28T09:15:00Z',
    updatedAt: '2026-10-28T09:15:00Z',
    shortUrl: 'https://trello.com/c/abc123',
    claimedBy: null,
    claimedUntil: null,
    screenshotUrl: 'https://annotate.test/v1/screenshots/s1.png?sig=x',
    contextUrl: 'https://annotate.test/v1/screenshots/c1.jpg?sig=y',
    selector: 'section.hero > a.btn-primary',
    sources: [{ kind: 'wp-block', value: 'acf/hero', depth: 1 }],
    anchor: {
      mode: 'element',
      selector: 'section.hero > a.btn-primary',
      relative: { x: 0, y: 0, width: 1, height: 1 },
      absolute: { x: 10, y: 20, width: 180, height: 48 },
      viewportWidth: 390,
      text: 'Book a tour',
    },
    env: {
      url: 'https://example.com/about?ref=nav',
      title: 'About',
      referrer: '',
      viewport: { width: 390, height: 844 },
      dpr: 3,
      scroll: { x: 0, y: 0 },
      userAgent: 'Mozilla/5.0',
      browser: 'Safari 18',
      os: 'iOS',
      language: 'en-US',
      timestamp: '2026-10-28T09:15:00Z',
      consoleErrors: [{ kind: 'error', message: 'TypeError: menu is undefined\n    at app.js:1', at: 1 }],
    },
    context: {
      page: { platform: 'wordpress', postId: 7, template: 'page-about.php', theme: 'strauss' },
      element: {
        tag: 'a',
        html: '<a class="btn btn-primary" href="/tour">Book a tour</a>',
        text: 'Book a tour',
        landmark: 'Our story',
        styles: { display: 'inline-block', position: 'absolute', 'z-index': '20' },
        sources: [{ kind: 'wp-block', value: 'acf/hero', depth: 1 }],
      },
    },
    comments: [
      { id: 'c1', author: 'Jane Client', text: 'Also on iPad.', createdAt: '2026-10-28T09:30:00Z', viaWidget: true, via: 'widget' },
    ],
    resolution: null,
    ...overrides,
  };
}

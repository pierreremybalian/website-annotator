// Everything the CLI touches in the outside world, injectable so tests can run commands in-process.
import os from 'node:os';
import { spawn } from 'node:child_process';

export interface Out {
  write(chunk: string): unknown;
  isTTY?: boolean;
  columns?: number;
}

export interface Ctx {
  cwd: string;
  env: Record<string, string | undefined>;
  stdout: Out;
  stderr: Out;
  fetch: typeof globalThis.fetch;
  /** Open a URL in the browser. Returns false if no opener could be started. */
  openUrl: (url: string) => boolean;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  homedir: string;
  /** Default name for claims and comments: `${username}@${hostname}`. */
  agentName: string;
  hostname: string;
  /** Hand-off poll interval. */
  pollIntervalMs: number;
}

declare const __ANNOTATE_VERSION__: string | undefined;
export const VERSION: string = typeof __ANNOTATE_VERSION__ === 'string' ? __ANNOTATE_VERSION__ : 'dev';

function username(): string {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USER || process.env.USERNAME || 'agent';
  }
}

export function openInBrowser(url: string): boolean {
  const [cmd, args]: [string, string[]] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export function makeCtx(overrides: Partial<Ctx> = {}): Ctx {
  const hostname = overrides.hostname ?? os.hostname();
  return {
    cwd: process.cwd(),
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
    fetch: globalThis.fetch,
    openUrl: openInBrowser,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    homedir: os.homedir(),
    agentName: `${username()}@${hostname}`,
    hostname,
    pollIntervalMs: 2000,
    ...overrides,
  };
}

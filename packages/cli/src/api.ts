import type { ApiError } from '@annotate/shared';
import type { Ctx } from './context';
import { VERSION } from './context';
import { CliError, EXIT, exitCodeForStatus } from './errors';

export interface HttpResult {
  status: number;
  ok: boolean;
  data: unknown;
}

const TIMEOUT_MS = 30_000;

function describeNetworkError(err: unknown): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'timed out';
  return e?.cause?.code || e?.cause?.message || e?.message || String(err);
}

export class NetworkError extends CliError {
  constructor(url: string, err: unknown) {
    let origin = url;
    try {
      origin = new URL(url).origin;
    } catch {
      // keep the raw url
    }
    super(`cannot reach ${origin}: ${describeNetworkError(err)}`, EXIT.error);
  }
}

export async function requestJson(
  ctx: Ctx,
  method: string,
  url: string,
  opts: { token?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': `annotate-cli/${VERSION}` };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await ctx.fetch(url, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
    });
  } catch (err) {
    throw new NetworkError(url, err);
  }
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    throw new NetworkError(url, err);
  }
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  return { status: res.status, ok: res.ok, data };
}

/** A CliError for a non-2xx response, using ApiError.error when the body has one. */
export function httpError(res: HttpResult, fallback?: string): CliError {
  const body = res.data as Partial<ApiError> | null;
  const message = (body && typeof body.error === 'string' && body.error) || fallback || `request failed (HTTP ${res.status})`;
  const exitCode = exitCodeForStatus(res.status);
  const hint =
    res.status === 401 ? 'Check ANNOTATE_TOKEN, or run `annotate init` to get a new agent token.' : undefined;
  return new CliError(message, exitCode, { status: res.status, code: body?.code, hint });
}

/** Agent API client: `${endpoint}/v1/agent`, Bearer agent token. */
export class AgentApi {
  constructor(
    private readonly ctx: Ctx,
    readonly endpoint: string,
    private readonly token: string,
  ) {}

  async call<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await requestJson(this.ctx, method, `${this.endpoint}/v1/agent${path}`, { token: this.token, body });
    if (!res.ok) throw httpError(res);
    // Some actions may answer 204; give --json something to print.
    return (res.data ?? { ok: true }) as T;
  }

  get<T = unknown>(path: string): Promise<T> {
    return this.call<T>('GET', path);
  }
  post<T = unknown>(path: string, body: unknown = {}): Promise<T> {
    return this.call<T>('POST', path, body);
  }
  delete<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.call<T>('DELETE', path, body);
  }
}

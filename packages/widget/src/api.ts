import {
  HEADER_ACCESS,
  HEADER_PROJECT,
  type AddCommentRequest,
  type AddCommentResponse,
  type ApiError,
  type ConfirmIssueRequest,
  type CreateIssueMeta,
  type CreateIssueResponse,
  type GetIssueResponse,
  type IssueActionResponse,
  type IssueSummary,
  type ListIssuesResponse,
  type ReopenIssueRequest,
  type Reporter,
} from '@annotate/shared';
import type { WidgetApi } from './types';

/** ApiError codes from the Worker, plus 'network' when the request never got a response. */
export type ApiErrorCode = ApiError['code'] | 'network';

export class ApiRequestError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  constructor(message: string, code: ApiErrorCode, status: number) {
    super(message);
    this.name = 'ApiRequestError';
    this.code = code;
    this.status = status;
  }
}

export interface ApiConfig {
  endpoint: string;
  projectKey: string;
  accessKey: string;
}

export function createApi(cfg: ApiConfig): WidgetApi {
  const base = cfg.endpoint.replace(/\/+$/, '');

  async function request<T>(path: string, init: RequestInit = {}, timeoutMs = 20000): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set(HEADER_PROJECT, cfg.projectKey);
    headers.set(HEADER_ACCESS, cfg.accessKey);
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : 0;
    let res: Response;
    try {
      res = await fetch(base + path, { ...init, headers, credentials: 'omit', mode: 'cors', signal: ctrl?.signal });
    } catch {
      const timedOut = ctrl?.signal.aborted;
      throw new ApiRequestError(
        timedOut ? 'The feedback server took too long to respond.' : "Couldn't reach the feedback server.",
        'network',
        0,
      );
    } finally {
      if (timer) clearTimeout(timer);
    }

    let body: unknown = null;
    const text = await res.text().catch(() => '');
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    if (!res.ok) {
      const e = body as Partial<ApiError> | null;
      throw new ApiRequestError(e?.error || `Request failed (HTTP ${res.status}).`, e?.code || 'internal', res.status);
    }
    return body as T;
  }

  return {
    async createIssue(meta: CreateIssueMeta, selection: Blob, context: Blob): Promise<CreateIssueResponse> {
      const form = new FormData();
      form.append('meta', JSON.stringify(meta));
      form.append('selection', selection, 'selection.png');
      form.append('context', context, 'context.jpg');
      return request<CreateIssueResponse>('/v1/issues', { method: 'POST', body: form }, 60000);
    },

    async listIssues(pageUrl: string, all = false) {
      const qs = `url=${encodeURIComponent(pageUrl)}${all ? '&all=1' : ''}`;
      const res = await request<ListIssuesResponse>(`/v1/issues?${qs}`);
      return res.issues;
    },

    async getIssue(id: string) {
      const res = await request<GetIssueResponse>(`/v1/issues/${encodeURIComponent(id)}`);
      return res.issue;
    },

    async addComment(id: string, text: string, reporter: Reporter) {
      const payload: AddCommentRequest = { text, reporter };
      const res = await request<AddCommentResponse>(`/v1/issues/${encodeURIComponent(id)}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return res.comment;
    },

    async confirmIssue(id: string, reporter: Reporter): Promise<IssueSummary> {
      const payload: ConfirmIssueRequest = { reporter };
      const res = await request<IssueActionResponse>(`/v1/issues/${encodeURIComponent(id)}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return res.issue;
    },

    async reopenIssue(id: string, text: string, reporter: Reporter): Promise<IssueSummary> {
      const payload: ReopenIssueRequest = { reporter, text };
      const res = await request<IssueActionResponse>(`/v1/issues/${encodeURIComponent(id)}/reopen`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return res.issue;
    },
  };
}

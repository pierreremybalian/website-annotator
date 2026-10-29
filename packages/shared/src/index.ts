// Contracts shared by the widget, the Worker and (by convention) the WP plugin.

export type IssueStatus = 'new' | 'in_progress' | 'resolved' | 'archived';

/** A rectangle in CSS pixels (or fractions 0..1 where noted). */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where an issue was reported, so a pin can be placed on the page again later. */
export interface Anchor {
  /** CSS selector of the smallest element fully containing the selection; null if none found. */
  selector: string | null;
  /** The selection as fractions (0..1) of the anchor element's bounding rect. Null when selector is null. */
  relative: Rect | null;
  /** Document-absolute selection rect (viewport rect + scroll offset) at capture time. Fallback position. */
  absolute: Rect;
  /** window.innerWidth at capture time. */
  viewportWidth: number;
  /** First 80 chars of the anchor element's textContent, whitespace-collapsed. Used to detect a stale selector. */
  text: string;
}

export interface ConsoleEntry {
  kind: 'error' | 'unhandledrejection' | 'console.error';
  message: string;
  stack?: string;
  /** epoch ms */
  at: number;
}

export interface CaptureEnv {
  url: string;
  title: string;
  referrer: string;
  viewport: { width: number; height: number };
  dpr: number;
  scroll: { x: number; y: number };
  userAgent: string;
  /** e.g. "Chrome 130" */
  browser: string;
  /** e.g. "macOS" */
  os: string;
  language: string;
  /** ISO 8601 */
  timestamp: string;
  /** Most recent last, max 20. */
  consoleErrors: ConsoleEntry[];
}

export interface Reporter {
  name: string;
  email: string;
}

/**
 * POST /v1/issues is multipart/form-data with fields:
 *   meta      — JSON.stringify(CreateIssueMeta)
 *   selection — image/png, the cropped selection
 *   context   — image/jpeg, the full viewport with the selection box drawn on it
 */
export interface CreateIssueMeta {
  /** May be empty; the Worker falls back to the first 80 chars of notes. */
  title: string;
  notes: string;
  reporter: Reporter;
  anchor: Anchor;
  env: CaptureEnv;
}

export interface CreateIssueResponse {
  id: string;
  number: number;
  shortUrl: string;
}

export interface IssueSummary {
  id: string;
  number: number;
  title: string;
  status: IssueStatus;
  anchor: Anchor;
  reporterName: string;
  /** ISO 8601 */
  createdAt: string;
  /** Absolute, signed URL to the selection image (usable directly in <img src>). */
  screenshotUrl: string;
  /** Trello card short URL. */
  shortUrl: string;
}

export interface Comment {
  id: string;
  author: string;
  text: string;
  /** ISO 8601 */
  createdAt: string;
  /** True when posted from the widget (author is then the reporter name, not the Trello member). */
  viaWidget: boolean;
}

export interface IssueDetail extends IssueSummary {
  notes: string;
  /** Absolute, signed URL to the context image. */
  contextUrl: string;
  env: CaptureEnv;
  comments: Comment[];
}

/** GET /v1/issues?url=<page url>[&all=1] */
export interface ListIssuesResponse {
  issues: IssueSummary[];
}

/** GET /v1/issues/:id */
export interface GetIssueResponse {
  issue: IssueDetail;
}

/** POST /v1/issues/:id/comments (JSON body) */
export interface AddCommentRequest {
  text: string;
  reporter: Reporter;
}

export interface AddCommentResponse {
  comment: Comment;
}

/** GET /v1/project */
export interface ProjectStatus {
  connected: boolean;
  name: string;
  boardName: string | null;
  boardUrl: string | null;
  issueCount: number;
  reason?: 'token_revoked';
}

/** Every non-2xx JSON response from the Worker. */
export interface ApiError {
  error: string;
  code:
    | 'bad_request'
    | 'unauthorized'
    | 'forbidden'
    | 'forbidden_origin'
    | 'expired'
    | 'not_found'
    | 'trello_error'
    | 'token_revoked'
    | 'rate_limited'
    | 'internal';
}

/**
 * Request headers the widget and WP plugin send on every /v1/* call.
 * Screenshot URLs are signed instead, since <img> can't send headers.
 */
export const HEADER_PROJECT = 'X-Annotate-Project';
export const HEADER_ACCESS = 'X-Annotate-Access';

/** Query param that activates the widget on any page: ?annotate=<access_key> */
export const ACTIVATION_PARAM = 'annotate';

/** Message the connect popup posts to window.opener when it finishes. */
export interface ConnectResultMessage {
  type: 'annotate:connected';
  projectKey: string;
  accessKey: string;
  boardName: string;
  boardUrl: string;
  /** Base URL of the Worker, e.g. https://feedback.baliandesign.com */
  endpoint: string;
}

/**
 * Widget configuration, read from the <script> tag's data-* attributes:
 *   data-endpoint, data-project, data-access, data-always-on,
 *   data-reporter-name, data-reporter-email, data-position
 */
export interface WidgetConfig {
  endpoint: string;
  projectKey: string;
  accessKey?: string;
  alwaysOn?: boolean;
  reporter?: Partial<Reporter>;
  position?: 'bottom-right' | 'bottom-left';
}

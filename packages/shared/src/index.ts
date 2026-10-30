// Contracts shared by the widget, the Worker and (by convention) the WP plugin.

/**
 * 'in_progress' = an agent claimed it (or a human moved the card). 'resolved' = fixed and verified live; anyone can
 * reopen it (→ new). 'review' = a human moved the card to the review list; the reporter confirms (→ resolved) on the pin.
 */
export type IssueStatus = 'new' | 'in_progress' | 'review' | 'resolved' | 'archived';

/** A rectangle in CSS pixels (or fractions 0..1 where noted). */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where an issue was reported, so a pin can be placed on the page again later. */
/** 'element' = the user picked a DOM element (relative is {0,0,1,1}); 'area' = the user drew a box. */
export type AnchorMode = 'element' | 'area';

export interface Anchor {
  /** Missing on pre-0.2 reports, which are all 'area'. */
  mode?: AnchorMode;
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
  /** Optional since 0.2. */
  context?: IssueContext;
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
  /** 0.2: where the comment came from. Optional for backward compatibility. */
  via?: 'widget' | 'agent' | 'trello';
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
    | 'claimed'
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

// ---------------------------------------------------------------------------
// 0.2: context capture (platform-agnostic)

/**
 * A hint about which source file/component rendered an element, read from attributes on the
 * element and its ancestors (nearest first):
 *   annotate     data-annotate-source="<file path or component name>"  (any platform, set by hand or an adapter)
 *   wp-block     data-annotate-block="acf/hero"                        (WP plugin; block name only)
 *   astro-source data-astro-source-file + data-astro-source-loc="12:3"  (Astro dev server)
 *   astro-cid    data-astro-cid-<hash>                                  (Astro production, scoped styles)
 */
export interface SourceHint {
  kind: 'annotate' | 'wp-block' | 'astro-source' | 'astro-cid';
  /** The attribute value (for astro-cid: the hash). */
  value: string;
  /** File path when known (annotate values that look like paths, astro-source). */
  file?: string;
  line?: number;
  /** How many ancestors up from the picked element (0 = the element itself). */
  depth: number;
}

export interface ElementContext {
  /** Lowercase tag name. */
  tag: string;
  /** outerHTML trimmed to 3000 chars; script/style contents removed, input/textarea/select values stripped. */
  html: string;
  /** textContent, whitespace-collapsed, max 200 chars. */
  text: string;
  /** Nearest preceding heading's text, or the closest section/landmark's id or aria-label. */
  landmark: string | null;
  /** A few computed styles: display, position, width, height, margin, padding, font-size, font-weight, line-height, color, background-color, overflow. */
  styles: Record<string, string>;
  /** Nearest first, max 10. */
  sources: SourceHint[];
}

/**
 * Page-level context from window.AnnotateContext (set by a platform adapter), max 4 KB as JSON.
 * Conventions: WordPress { platform: 'wordpress', postId, postType, template, slug, isFrontPage, theme };
 * Astro { platform: 'astro', route, ... }.
 */
export type PageContext = Record<string, unknown>;

export interface IssueContext {
  page: PageContext | null;
  element: ElementContext | null;
}

// ---------------------------------------------------------------------------
// 0.2: confirm / reopen from the widget (HEADER_PROJECT + HEADER_ACCESS auth, like other /v1 widget calls)

/** POST /v1/issues/:id/confirm — moves the card to the first done list (status resolved). */
export interface ConfirmIssueRequest {
  reporter: Reporter;
}
/** POST /v1/issues/:id/reopen — moves the card to the new list (status new) with a note. */
export interface ReopenIssueRequest {
  reporter: Reporter;
  text: string;
}
export interface IssueActionResponse {
  issue: IssueSummary;
}

// ---------------------------------------------------------------------------
// 0.2: agent API — /v1/agent/*, `Authorization: Bearer at_…` (per-project agent token).
// Issues are addressed by their per-project NUMBER (#12), not id.

export interface AgentProject {
  name: string;
  projectKey: string;
  boardName: string;
  boardUrl: string;
  origins: string[];
  counts: Record<IssueStatus, number>;
}

/** GET /v1/agent/issues?status=open|new|in_progress|review|resolved|archived|all&url=<page url> ('open' = new + in_progress; default) */
export interface AgentIssue {
  id: string;
  number: number;
  title: string;
  status: IssueStatus;
  /** Raw page URL as reported. */
  pageUrl: string;
  notes: string;
  reporterName: string;
  createdAt: string;
  updatedAt: string;
  shortUrl: string;
  claimedBy: string | null;
  /** ISO 8601; null when not claimed or the lease expired. */
  claimedUntil: string | null;
  /** Absolute, signed (1 h). */
  screenshotUrl: string;
  contextUrl: string;
  selector: string | null;
  sources: SourceHint[];
}

/** GET /v1/agent/issues/:number */
export interface AgentIssueDetail extends AgentIssue {
  anchor: Anchor;
  env: CaptureEnv;
  context: IssueContext | null;
  comments: Comment[];
  /** Latest resolve note. */
  resolution: string | null;
}

export interface AgentListIssuesResponse {
  issues: AgentIssue[];
}
export interface AgentIssueResponse {
  issue: AgentIssueDetail;
}

/** POST /v1/agent/issues/:number/claim → 200 AgentIssueResponse, or 409 ApiError code 'claimed'. A 'new' issue moves to the "In progress" list. */
export interface AgentClaimRequest {
  /** Who is working on it, e.g. "claude@pierre-mbp". */
  agent: string;
  /** Lease length, default 30, max 240. */
  minutes?: number;
}
/** POST /v1/agent/issues/:number/comments */
export interface AgentCommentRequest {
  text: string;
  author?: string;
}
/** POST /v1/agent/issues/:number/resolve → card to the first done list, status 'resolved', lease released. */
export interface AgentResolveRequest {
  note: string;
  commit?: string;
  author?: string;
}
/** POST /v1/agent/issues/:number/reopen → card to the new list, status 'new'. */
export interface AgentReopenRequest {
  note: string;
  author?: string;
}
/** GET /v1/agent/origins → AgentOriginsResponse; POST and DELETE take AgentOriginRequest. */
export interface AgentOriginRequest {
  origin: string;
}
export interface AgentOriginsResponse {
  origins: string[];
}

// ---------------------------------------------------------------------------
// 0.2: CLI hand-off (device-style). The CLI never sees a Trello token.
//   1. CLI: POST /cli/sessions CliSessionRequest → CliSessionResponse; opens `url` in the browser.
//   2. Browser: /connect?cli=<id> — the normal popup flow; at the end it either connects a new board
//      or links an existing project the member can access, mints an agent token, and stores the result.
//   3. CLI: POST /cli/sessions/:id/poll { verifier } → 202 { status: 'pending' } | 200 CliPollResponse (once; then deleted)
//      | 403 (bad verifier) | 410 (expired, 15 min).

export interface CliSessionRequest {
  /** base64url(SHA-256(verifier)); the verifier is 32+ random bytes, base64url, kept by the CLI. */
  verifierHash: string;
  /** 'connect' = new board/project (shows the board picker first); 'link' = existing project (shows projects first). Both offer both. */
  mode: 'connect' | 'link';
  /** Label for the minted agent token, e.g. "pierre-mbp:strausshouses". */
  label?: string;
  /** Site URL to prefill (connect mode). */
  siteUrl?: string;
}
export interface CliSessionResponse {
  id: string;
  url: string;
  expiresAt: string;
}
export interface CliResult {
  endpoint: string;
  projectKey: string;
  accessKey: string;
  agentToken: string;
  projectName: string;
  boardName: string;
  boardUrl: string;
  origins: string[];
}
export interface CliPollResponse {
  status: 'done';
  result: CliResult;
}

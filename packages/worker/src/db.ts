import type { IssueStatus } from '@annotate/shared';

/** Row shapes as stored in D1 (JSON columns are strings). See migrations/ (0005 has the current tables). */

export interface ProjectRow {
  id: string;
  name: string;
  public_key: string;
  access_key: string;
  allowed_origins: string;
  /** Trello sync: the trello_* columns and new_list_id are all null for a project without a board. */
  trello_token_enc: string | null;
  trello_member_id: string | null;
  trello_board_id: string | null;
  trello_board_name: string | null;
  trello_board_url: string | null;
  new_list_id: string | null;
  done_list_ids: string;
  webhook_id: string | null;
  review_list_id: string | null;
  progress_list_id: string | null;
  token_revoked: number;
  /** Last failed push to Trello. */
  trello_error: string | null;
  trello_reconciled_at: number | null;
  next_number: number;
  ignore_query: number;
  created_at: string;
  updated_at: string;
}

export interface ConnectSessionRow {
  id: string;
  opener_origin: string | null;
  cli_session_id: string | null;
  site_name: string | null;
  site_url: string | null;
  project_id: string | null;
  trello_token_enc: string | null;
  trello_member_id: string | null;
  expires_at: number;
}

export interface IssueRow {
  id: string;
  project_id: string;
  number: number;
  trello_card_id: string | null;
  trello_short_url: string | null;
  /** The list the card was last moved to by us, or seen in. */
  trello_list_id: string | null;
  /** 1 = a push to Trello failed; the cron retries it. */
  trello_pending: number;
  comments_imported_at: string | null;
  page_url: string;
  page_url_raw: string;
  title: string;
  notes: string;
  anchor: string;
  env: string;
  reporter_name: string;
  reporter_email: string;
  screenshot_key: string;
  context_key: string;
  status: IssueStatus;
  /** Epoch ms of the last status change made in Annotate (older Trello moves are stale echoes). */
  status_at: number | null;
  context: string | null;
  claimed_by: string | null;
  claimed_until: number | null;
  resolution: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentTokenRow {
  id: string;
  project_id: string;
  token_hash: string;
  label: string;
  created_by: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export type CommentVia = 'widget' | 'agent' | 'trello' | 'app';

export interface CommentRow {
  id: string;
  issue_id: string;
  via: CommentVia;
  author_name: string;
  /** Widget: as typed (unverified). */
  author_email: string | null;
  user_id: string | null;
  text: string;
  /** The Trello comment this one mirrors. */
  trello_action_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CliSessionRow {
  id: string;
  verifier_hash: string;
  mode: 'connect' | 'link';
  label: string | null;
  site_url: string | null;
  result_enc: string | null;
  expires_at: number;
}

export interface UserRow {
  id: string;
  email: string;
  name: string;
  email_verified_at: string | null;
  created_at: string;
  last_login_at: string | null;
}

export interface LoginTokenRow {
  id: string;
  kind: 'login' | 'invite';
  email: string;
  link_hash: string;
  code_hash: string | null;
  attempts: number;
  next: string | null;
  created_at: number;
  expires_at: number;
  used_at: number | null;
}

export const nowIso = () => new Date().toISOString();

/** URL-safe random id. */
export function randomId(bytes = 16): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...buf)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A project that syncs to a Trello board. */
export type TrelloProject = ProjectRow & {
  trello_token_enc: string;
  trello_member_id: string;
  trello_board_id: string;
  trello_board_name: string;
  trello_board_url: string;
  new_list_id: string;
};

export const hasTrello = (p: ProjectRow): p is TrelloProject => !!(p.trello_token_enc && p.trello_board_id && p.new_list_id);

/** Map a Trello list id to an issue status for a project. */
export function statusForList(
  project: { new_list_id: string | null; done_list_ids: string; review_list_id?: string | null },
  listId: string,
): IssueStatus {
  if (listId === project.new_list_id) return 'new';
  if (project.review_list_id && listId === project.review_list_id) return 'review';
  const done: string[] = JSON.parse(project.done_list_ids);
  return done.includes(listId) ? 'resolved' : 'in_progress';
}

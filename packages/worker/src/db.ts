import type { IssueStatus } from '@annotate/shared';

/** Row shapes as stored in D1 (JSON columns are strings). See migrations/0001_init.sql. */

export interface ProjectRow {
  id: string;
  name: string;
  public_key: string;
  access_key: string;
  allowed_origins: string;
  trello_token_enc: string;
  trello_member_id: string;
  trello_board_id: string;
  trello_board_name: string;
  trello_board_url: string;
  new_list_id: string;
  done_list_ids: string;
  webhook_id: string | null;
  review_list_id: string | null;
  progress_list_id: string | null;
  token_revoked: number;
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
  trello_card_id: string;
  trello_short_url: string;
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
  created_at: string;
  last_used_at: string | null;
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

export const nowIso = () => new Date().toISOString();

/** URL-safe random id. */
export function randomId(bytes = 16): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...buf)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Map a Trello list id to an issue status for a project. */
export function statusForList(
  project: Pick<ProjectRow, 'new_list_id' | 'done_list_ids'> & Partial<Pick<ProjectRow, 'review_list_id'>>,
  listId: string,
): IssueStatus {
  if (listId === project.new_list_id) return 'new';
  if (project.review_list_id && listId === project.review_list_id) return 'review';
  const done: string[] = JSON.parse(project.done_list_ids);
  return done.includes(listId) ? 'resolved' : 'in_progress';
}

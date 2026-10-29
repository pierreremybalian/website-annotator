// The Trello list agents move fixed issues to ("Ready for review"). Found or created lazily, the first
// time an agent resolves an issue, and remembered in projects.review_list_id.

import type { Env } from './env';
import { nowIso, type ProjectRow } from './db';
import type { Trello, TrelloList } from './trello';

export const REVIEW_LIST_NAME = 'Ready for review';
/** Names that already mean "waiting for someone to check it". */
const REVIEW_NAME_RE = /ready for review|review|\bqa\b|testing|verif/i;

type ListProject = Pick<ProjectRow, 'review_list_id' | 'new_list_id' | 'done_list_ids'>;

/** An existing list to use as the review list, or null. `lists` must be the board's open lists. */
export function findReviewList(project: ListProject, lists: readonly TrelloList[]): TrelloList | null {
  if (project.review_list_id) {
    const current = lists.find((l) => l.id === project.review_list_id);
    if (current) return current;
  }
  const done: string[] = JSON.parse(project.done_list_ids);
  return byPos(lists).find((l) => REVIEW_NAME_RE.test(l.name) && l.id !== project.new_list_id && !done.includes(l.id)) ?? null;
}

/** Where a new review list goes: between the first done list and the list before it, else at the bottom. */
export function reviewListPos(project: Pick<ProjectRow, 'done_list_ids'>, lists: readonly TrelloList[]): number | 'bottom' {
  const done: string[] = JSON.parse(project.done_list_ids);
  const sorted = byPos(lists);
  const i = sorted.findIndex((l) => done.includes(l.id));
  if (i < 0) return 'bottom';
  const after = sorted[i]!.pos;
  const before = i > 0 ? sorted[i - 1]!.pos : 0;
  return (before + after) / 2;
}

/**
 * The project's review list id: the stored one if it still exists on the board, else an existing list
 * whose name looks like review/QA, else a new "Ready for review" list just before the first done list.
 * Persists projects.review_list_id when it changes. Trello errors propagate.
 */
export async function ensureReviewList(env: Env, project: ProjectRow, trello: Trello): Promise<string> {
  const lists = await trello.lists(project.trello_board_id);
  const id = findReviewList(project, lists)?.id ?? (await trello.createList(project.trello_board_id, REVIEW_LIST_NAME, reviewListPos(project, lists))).id;
  if (id !== project.review_list_id) {
    await env.DB.prepare('UPDATE projects SET review_list_id = ?, updated_at = ? WHERE id = ?').bind(id, nowIso(), project.id).run();
  }
  return id;
}

const byPos = (lists: readonly TrelloList[]) => [...lists].sort((a, b) => a.pos - b.pos);

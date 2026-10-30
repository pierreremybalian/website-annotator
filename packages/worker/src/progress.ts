// The Trello list a card sits in while an agent works on it ("In progress"). Found or created lazily, the
// first time an agent claims an issue, and remembered in projects.progress_list_id.

import type { Env } from './env';
import { nowIso, type ProjectRow } from './db';
import type { Trello, TrelloList } from './trello';

export const PROGRESS_LIST_NAME = 'In progress';
/** Names that already mean "someone is working on it". */
const PROGRESS_NAME_RE = /in progress|doing|working|\bwip\b/i;

type ListProject = Pick<ProjectRow, 'progress_list_id' | 'new_list_id' | 'done_list_ids' | 'review_list_id'>;

/** An existing list to use as the progress list, or null. `lists` must be the board's open lists. */
export function findProgressList(project: ListProject, lists: readonly TrelloList[]): TrelloList | null {
  if (project.progress_list_id) {
    const current = lists.find((l) => l.id === project.progress_list_id);
    if (current) return current;
  }
  const taken = new Set<string | null>([project.new_list_id, project.review_list_id, ...(JSON.parse(project.done_list_ids) as string[])]);
  return byPos(lists).find((l) => PROGRESS_NAME_RE.test(l.name) && !taken.has(l.id)) ?? null;
}

/** Where a new progress list goes: right after the new list, else at the bottom. */
export function progressListPos(project: Pick<ProjectRow, 'new_list_id'>, lists: readonly TrelloList[]): number | 'bottom' {
  const sorted = byPos(lists);
  const i = sorted.findIndex((l) => l.id === project.new_list_id);
  const next = i < 0 ? undefined : sorted[i + 1];
  return next ? (sorted[i]!.pos + next.pos) / 2 : 'bottom';
}

/**
 * The project's progress list id: the stored one if it still exists on the board, else an existing list
 * whose name looks like in-progress, else a new "In progress" list just after the new list.
 * Persists projects.progress_list_id when it changes. Trello errors propagate.
 */
export async function ensureProgressList(env: Env, project: ProjectRow, trello: Trello): Promise<string> {
  const lists = await trello.lists(project.trello_board_id);
  const id = findProgressList(project, lists)?.id ?? (await trello.createList(project.trello_board_id, PROGRESS_LIST_NAME, progressListPos(project, lists))).id;
  if (id !== project.progress_list_id) {
    await env.DB.prepare('UPDATE projects SET progress_list_id = ?, updated_at = ? WHERE id = ?').bind(id, nowIso(), project.id).run();
  }
  return id;
}

const byPos = (lists: readonly TrelloList[]) => [...lists].sort((a, b) => a.pos - b.pos);

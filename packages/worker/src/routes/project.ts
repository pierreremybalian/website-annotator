import { Hono } from 'hono';
import type { ProjectStatus } from '@annotate/shared';
import type { AppEnv, Env } from '../env';
import { hasTrello, nowIso, type TrelloProject } from '../db';
import { markTokenRevoked, requireProject } from '../auth';
import { trelloForProject } from '../crypto';
import { TrelloError } from '../trello';

/** Ask Trello whether the stored token still works, keeping projects.token_revoked in step. */
async function trelloRevoked(env: Env, project: TrelloProject): Promise<boolean> {
  try {
    const trello = await trelloForProject(env, project).catch((e: unknown) => {
      // Undecryptable token (e.g. TOKEN_ENC_KEY rotated): as good as revoked, needs a reconnect.
      throw new TrelloError(401, `stored token unusable: ${e}`);
    });
    await trello.me();
    if (project.token_revoked) {
      // The token works again (or the flag was stale): clear it.
      await env.DB.prepare('UPDATE projects SET token_revoked = 0, updated_at = ? WHERE id = ?').bind(nowIso(), project.id).run();
    }
    return false;
  } catch (e) {
    if (e instanceof TrelloError && e.revoked) {
      await markTokenRevoked(env, project.id);
      return true;
    }
    // Trello unreachable or erroring: fall back to the stored flag.
    console.error('Trello status check failed', e);
    return project.token_revoked === 1;
  }
}

const app = new Hono<AppEnv>();

app.get('/', requireProject, async (c) => {
  const project = c.var.project;
  // A project without a Trello board has nothing that can come unplugged.
  const revoked = hasTrello(project) && (await trelloRevoked(c.env, project));
  const count = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM issues WHERE project_id = ?').bind(project.id).first<{ n: number }>();
  const status: ProjectStatus = {
    connected: !revoked,
    name: project.name,
    boardName: project.trello_board_name || null,
    boardUrl: project.trello_board_url || null,
    issueCount: count?.n ?? 0,
  };
  if (revoked) status.reason = 'token_revoked';
  return c.json(status);
});

export default app;

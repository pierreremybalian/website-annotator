import { Hono } from 'hono';
import type { ProjectStatus } from '@annotate/shared';
import type { AppEnv } from '../env';
import { nowIso } from '../db';
import { markTokenRevoked, requireProject } from '../auth';
import { trelloForProject } from '../crypto';
import { TrelloError } from '../trello';

const app = new Hono<AppEnv>();

app.get('/', requireProject, async (c) => {
  const project = c.var.project;
  let revoked = project.token_revoked === 1;

  // Ask Trello whether the stored token still works.
  try {
    const trello = await trelloForProject(c.env, project).catch((e: unknown) => {
      // Undecryptable token (e.g. TOKEN_ENC_KEY rotated): as good as revoked, needs a reconnect.
      throw new TrelloError(401, `stored token unusable: ${e}`);
    });
    await trello.me();
    if (revoked) {
      // The token works again (or the flag was stale): clear it.
      await c.env.DB.prepare('UPDATE projects SET token_revoked = 0, updated_at = ? WHERE id = ?').bind(nowIso(), project.id).run();
      revoked = false;
    }
  } catch (e) {
    if (e instanceof TrelloError && e.revoked) {
      await markTokenRevoked(c.env, project.id);
      revoked = true;
    } else {
      // Trello unreachable or erroring: fall back to the stored flag.
      console.error('Trello status check failed', e);
    }
  }

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

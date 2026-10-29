import { Hono } from 'hono';
import type { AddCommentResponse } from '@annotate/shared';
import type { AppEnv } from '../env';
import { apiError, markTokenRevoked, requireProject } from '../auth';
import { trelloForProject } from '../crypto';
import { TrelloError } from '../trello';
import { commentAuthorName, widgetCommentText } from '../card';
import { issueForProject, reporterError } from './issues';

const app = new Hono<AppEnv>();

app.post('/:id/comments', requireProject, async (c) => {
  const project = c.var.project;
  const issue = await issueForProject(c.env, project.id, c.req.param('id'));
  if (!issue) return apiError(c, 404, 'not_found', 'Issue not found');

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return apiError(c, 400, 'bad_request', 'Expected a JSON body');
  }
  if (typeof body !== 'object' || body === null) return apiError(c, 400, 'bad_request', 'Expected a JSON object');
  const { text, reporter } = body as Record<string, unknown>;
  if (typeof text !== 'string' || !text.trim()) return apiError(c, 400, 'bad_request', 'text is required');
  if (text.trim().length > 5000) return apiError(c, 400, 'bad_request', 'text must be at most 5000 characters');
  const rErr = reporterError(reporter);
  if (rErr) return apiError(c, 400, 'bad_request', rErr);

  const name = commentAuthorName((reporter as { name: string }).name);
  const clean = text.trim();
  try {
    const trello = await trelloForProject(c.env, project);
    const tc = await trello.addComment(issue.trello_card_id, widgetCommentText(name, clean));
    return c.json<AddCommentResponse>({ comment: { id: tc.id, author: name, text: clean, createdAt: tc.date, viaWidget: true } }, 201);
  } catch (e) {
    if (!(e instanceof TrelloError)) throw e;
    if (e.revoked) {
      await markTokenRevoked(c.env, project.id);
      return apiError(c, 502, 'token_revoked', 'The Trello connection was revoked; reconnect Trello for this project');
    }
    if (e.status === 404) return apiError(c, 404, 'not_found', 'The Trello card for this issue no longer exists');
    console.error(e);
    return apiError(c, 502, 'trello_error', `Trello request failed (${e.status})`);
  }
});

export default app;

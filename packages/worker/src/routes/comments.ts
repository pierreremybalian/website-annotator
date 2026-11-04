import { Hono } from 'hono';
import type { AddCommentResponse } from '@annotate/shared';
import type { AppEnv } from '../env';
import { apiError, requireProject } from '../auth';
import { commentAuthorName, toComment } from '../card';
import { addComment } from '../tracker';
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

  const { name, email } = reporter as { name: string; email: string };
  const row = await addComment(c.env, project, issue, { via: 'widget', author: commentAuthorName(name), email: email.trim(), text: text.trim() });
  return c.json<AddCommentResponse>({ comment: toComment(row) }, 201);
});

export default app;

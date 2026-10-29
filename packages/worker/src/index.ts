import { Hono } from 'hono';
import type { ApiError } from '@annotate/shared';
import type { AppEnv } from './env';
import { v1Cors } from './auth';
import issues from './routes/issues';
import comments from './routes/comments';
import screenshots from './routes/screenshots';
import project from './routes/project';
import connect from './routes/connect';
import webhook from './routes/webhook';
import dev from './routes/dev';

const app = new Hono<AppEnv>();

app.use('/v1/*', v1Cors);
app.route('/v1/issues', issues);
app.route('/v1/issues', comments);
app.route('/v1/screenshots', screenshots);
app.route('/v1/project', project);
app.route('/connect', connect);
app.route('/trello/webhook', webhook);
app.route('/dev', dev); // TRELLO_MOCK only

app.get('/health', (c) => c.json({ ok: true }));

app.notFound((c) => c.json<ApiError>({ error: 'Not found', code: 'not_found' }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json<ApiError>({ error: 'Internal error', code: 'internal' }, 500);
});

export default app;

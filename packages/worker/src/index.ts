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
import agent from './routes/agent';
import cli from './routes/cli';
import auth, { logout } from './routes/auth';
import appApi from './routes/app';
import { sameOrigin } from './session';
import { scheduled } from './cron';

const app = new Hono<AppEnv>();

// The dashboard API is same-origin only: no CORS, so cross-origin preflights fail.
app.use('/v1/*', (c, next) => (c.req.path.startsWith('/v1/app/') ? next() : v1Cors(c, next)));
app.route('/v1/app', appApi);
app.route('/v1/issues', issues);
app.route('/v1/issues', comments);
app.route('/v1/screenshots', screenshots);
app.route('/v1/project', project);
app.route('/v1/agent', agent);
app.route('/cli', cli);
app.route('/connect', connect);
app.route('/login', auth);
app.post('/logout', sameOrigin, logout);
app.route('/trello/webhook', webhook);
app.route('/dev', dev); // TRELLO_MOCK only

app.get('/health', (c) => c.json({ ok: true }));

// The dashboard (packages/dashboard) is static, under /app/. A deep link like /app/p/<id> has no file of its own:
// answer with the app's index.html, with the same headers public/_headers gives the files.
const DASHBOARD_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
app.get('/', (c) => c.redirect('/app/', 302));
app.get('/app', (c) => c.redirect('/app/', 301));
app.get('/app/*', async (c) => {
  if (c.req.path.startsWith('/app/assets/')) return c.text('Not found', 404);
  const index = await c.env.ASSETS.fetch(new Request(new URL('/app/', c.req.url)));
  const res = new Response(index.body, index);
  res.headers.set('Content-Security-Policy', DASHBOARD_CSP);
  res.headers.set('X-Content-Type-Options', 'nosniff');
  res.headers.set('Referrer-Policy', 'same-origin');
  res.headers.set('Cache-Control', 'no-cache');
  return res;
});

app.notFound((c) => c.json<ApiError>({ error: 'Not found', code: 'not_found' }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json<ApiError>({ error: 'Internal error', code: 'internal' }, 500);
});

export default {
  fetch: app.fetch,
  scheduled: (_event: ScheduledController, env: AppEnv['Bindings'], ctx: ExecutionContext) => ctx.waitUntil(scheduled(env)),
} satisfies ExportedHandler<AppEnv['Bindings']>;

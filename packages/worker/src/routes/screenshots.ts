import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { apiError } from '../auth';
import { verifyScreenshotSignature } from '../sign';

// No requireProject: <img> can't send headers, so the signed URL is the authorization.
const app = new Hono<AppEnv>();

app.get('/:key{.+}', async (c) => {
  const key = c.req.param('key');
  const ok = await verifyScreenshotSignature(c.env, key, c.req.query('exp'), c.req.query('sig'));
  if (!ok) return apiError(c, 403, 'forbidden', 'Invalid or expired screenshot signature');

  const obj = await c.env.SCREENSHOTS.get(key);
  if (!obj) return apiError(c, 404, 'not_found', 'Screenshot not found');

  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
      'Content-Length': String(obj.size),
      'Cache-Control': 'private, max-age=3600',
      ETag: obj.httpEtag,
      'X-Content-Type-Options': 'nosniff',
    },
  });
});

export default app;

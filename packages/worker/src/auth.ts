import type { Context, MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { HEADER_ACCESS, HEADER_PROJECT, type ApiError } from '@annotate/shared';
import type { AppEnv } from './env';
import type { ProjectRow } from './db';
import { safeEqual } from './crypto';

/** JSON error response in the shared ApiError shape. */
export const apiError = (c: Context, status: ContentfulStatusCode, code: ApiError['code'], error: string) =>
  c.json<ApiError>({ error, code }, status);

/**
 * CORS for /v1/*. Any Origin passes preflight; the real authorization (including the Origin
 * allowlist) happens in requireProject, so reflecting the Origin here leaks nothing.
 */
export const v1Cors: MiddlewareHandler<AppEnv> = async (c, next) => {
  const origin = c.req.header('Origin');
  if (c.req.method === 'OPTIONS') {
    const headers = new Headers({
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': `Content-Type, Authorization, ${HEADER_PROJECT}, ${HEADER_ACCESS}`,
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    });
    if (origin) headers.set('Access-Control-Allow-Origin', origin);
    return new Response(null, { status: 204, headers });
  }
  await next();
  if (origin) c.res.headers.set('Access-Control-Allow-Origin', origin);
  c.res.headers.append('Vary', 'Origin');
};

/** Canonical origin ("https://example.com"), or null if unparseable (including the literal "null"). */
function canonicalOrigin(o: string): string | null {
  try {
    const u = new URL(o);
    return u.origin === 'null' ? null : u.origin;
  } catch {
    return null;
  }
}

function originAllowed(project: ProjectRow, origin: string): boolean {
  const want = canonicalOrigin(origin);
  if (!want) return false;
  let allowed: unknown;
  try {
    allowed = JSON.parse(project.allowed_origins);
  } catch {
    return false;
  }
  return Array.isArray(allowed) && allowed.some((a) => typeof a === 'string' && canonicalOrigin(a) === want);
}

/**
 * Loads the project from X-Annotate-Project, checks X-Annotate-Access and the Origin allowlist,
 * and sets c.var.project. A missing Origin is allowed: the WP plugin calls /v1/project server-to-server.
 */
export const requireProject: MiddlewareHandler<AppEnv> = async (c, next) => {
  const publicKey = c.req.header(HEADER_PROJECT);
  const accessKey = c.req.header(HEADER_ACCESS);
  if (!publicKey || !accessKey) return apiError(c, 401, 'unauthorized', 'Missing project or access key');

  const project = await c.env.DB.prepare('SELECT * FROM projects WHERE public_key = ?').bind(publicKey).first<ProjectRow>();
  if (!project || !safeEqual(accessKey, project.access_key)) return apiError(c, 401, 'unauthorized', 'Invalid project or access key');

  const origin = c.req.header('Origin');
  if (origin !== undefined && !originAllowed(project, origin)) {
    return apiError(c, 403, 'forbidden_origin', `Origin ${origin} is not allowed for this project`);
  }

  c.set('project', project);
  await next();
};

/** Flag the project's Trello token as revoked (Trello answered 401). */
export async function markTokenRevoked(env: AppEnv['Bindings'], projectId: string): Promise<void> {
  await env.DB.prepare('UPDATE projects SET token_revoked = 1, updated_at = ? WHERE id = ?').bind(new Date().toISOString(), projectId).run();
}

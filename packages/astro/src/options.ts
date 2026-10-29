// Option types, defaults, validation and env fallback for the @annotate/astro integration.

export type AnnotateMode = 'activation' | 'always';
export type AnnotatePosition = 'bottom-right' | 'bottom-left';

export interface AnnotateOptions {
  /** Project key `pk_…`. Falls back to PUBLIC_ANNOTATE_PROJECT, then ANNOTATE_PROJECT. */
  project?: string;
  /** Worker base URL. Falls back to PUBLIC_ANNOTATE_ENDPOINT / ANNOTATE_ENDPOINT, then the hosted Worker. */
  endpoint?: string;
  /**
   * 'activation' (default, production-safe): a tiny inline loader fetches widget.js only for browsers that
   * opened an `?annotate=<access key>` link. 'always': the widget loads for every visitor (staging/preview).
   */
  mode?: AnnotateMode;
  /** Access key `ak_…`. Only used (and required) in 'always' mode. Falls back to ANNOTATE_ACCESS_KEY / PUBLIC_ANNOTATE_ACCESS_KEY. */
  accessKey?: string;
  /** Default true. When false nothing is injected (the source manifest is still written, see sourceManifest). */
  enabled?: boolean;
  position?: AnnotatePosition;
  /** Extra fields merged into window.AnnotateContext. JSON-serializable; the whole object must stay under 4 KB. */
  context?: Record<string, unknown>;
  /** Write `.annotate/astro-cids.json` (cid hash → component file) on `astro build`. Default true. Never deployed. */
  sourceManifest?: boolean;
  /**
   * Staging only, default false: add `data-annotate-source="src/components/X.astro"` to each component's root
   * element in built HTML. This puts source paths in public HTML, so tie it to a staging check.
   */
  sourceAttributes?: boolean;
}

export interface ResolvedOptions {
  enabled: boolean;
  /** Whether `enabled` was passed explicitly (always mode warns when it wasn't). */
  enabledExplicit: boolean;
  project: string;
  endpoint: string;
  mode: AnnotateMode;
  /** Set only in 'always' mode. Activation mode never carries the key. */
  accessKey?: string;
  position: AnnotatePosition;
  context: Record<string, unknown>;
  sourceManifest: boolean;
  sourceAttributes: boolean;
}

export type Env = Record<string, string | undefined>;

export const DEFAULT_ENDPOINT = 'https://annotate.pierre-51f.workers.dev';
/** PageContext max size as JSON (shared contract). */
export const MAX_CONTEXT_BYTES = 4096;

/** Same charset the WP plugin accepts for keys: they end up in data-* attributes, headers and links. */
const KEY_RE = /^[A-Za-z0-9._~-]{1,200}$/;
const MODES: readonly AnnotateMode[] = ['activation', 'always'];
const POSITIONS: readonly AnnotatePosition[] = ['bottom-right', 'bottom-left'];

export class AnnotateConfigError extends Error {
  constructor(message: string) {
    super(`[@annotate/astro] ${message}`);
    this.name = 'AnnotateConfigError';
  }
}

/** First non-empty value among env names. */
function fromEnv(env: Env, ...names: string[]): string | undefined {
  for (const name of names) {
    const v = env[name]?.trim();
    if (v) return v;
  }
  return undefined;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new AnnotateConfigError(`\`${name}\` must be a string.`);
  const v = value.trim();
  return v === '' ? undefined : v;
}

function optionalBoolean(value: unknown, name: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new AnnotateConfigError(`\`${name}\` must be a boolean.`);
  return value;
}

/** scheme://host[:port][/path], no trailing slash, query or hash. Mirrors annotate_sanitize_endpoint() in the WP plugin. */
export function normalizeEndpoint(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AnnotateConfigError(`\`endpoint\` is not a valid URL: ${JSON.stringify(raw)}.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new AnnotateConfigError('`endpoint` must be an http(s) URL.');
  }
  if (url.username || url.password) throw new AnnotateConfigError('`endpoint` must not contain credentials.');
  return url.origin + url.pathname.replace(/\/+$/, '');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Validate options and apply env fallbacks. Throws AnnotateConfigError on invalid config.
 * With `enabled: false` nothing is required (so builds without the env vars still pass).
 */
export function resolveOptions(input: AnnotateOptions | undefined, env: Env = {}): ResolvedOptions {
  const raw: unknown = input ?? {};
  if (!isPlainObject(raw)) throw new AnnotateConfigError('Options must be an object.');
  const options = raw as AnnotateOptions;

  const enabled = optionalBoolean(options.enabled, 'enabled', true);
  const sourceManifest = optionalBoolean(options.sourceManifest, 'sourceManifest', true);
  const sourceAttributes = optionalBoolean(options.sourceAttributes, 'sourceAttributes', false);
  const base = {
    enabledExplicit: options.enabled !== undefined,
    sourceManifest,
    sourceAttributes,
  };

  const mode = options.mode ?? 'activation';
  if (!MODES.includes(mode)) throw new AnnotateConfigError(`\`mode\` must be 'activation' or 'always', got ${JSON.stringify(mode)}.`);
  const position = options.position ?? 'bottom-right';
  if (!POSITIONS.includes(position)) {
    throw new AnnotateConfigError(`\`position\` must be 'bottom-right' or 'bottom-left', got ${JSON.stringify(position)}.`);
  }

  if (!enabled) {
    return { ...base, enabled: false, project: '', endpoint: DEFAULT_ENDPOINT, mode, position, context: {}, sourceAttributes: false };
  }

  const project = optionalString(options.project, 'project') ?? fromEnv(env, 'PUBLIC_ANNOTATE_PROJECT', 'ANNOTATE_PROJECT');
  if (!project) {
    throw new AnnotateConfigError(
      'Missing project key. Pass `project: "pk_…"` or set PUBLIC_ANNOTATE_PROJECT (or ANNOTATE_PROJECT). ' +
        'Get one with `annotate connect`, or set `enabled: false` for builds without Annotate.',
    );
  }
  if (!KEY_RE.test(project)) throw new AnnotateConfigError(`\`project\` has invalid characters: ${JSON.stringify(project)}.`);

  const endpointRaw =
    optionalString(options.endpoint, 'endpoint') ?? fromEnv(env, 'PUBLIC_ANNOTATE_ENDPOINT', 'ANNOTATE_ENDPOINT') ?? DEFAULT_ENDPOINT;
  const endpoint = normalizeEndpoint(endpointRaw);

  let accessKey: string | undefined;
  if (mode === 'always') {
    accessKey = optionalString(options.accessKey, 'accessKey') ?? fromEnv(env, 'ANNOTATE_ACCESS_KEY', 'PUBLIC_ANNOTATE_ACCESS_KEY');
    if (!accessKey) {
      throw new AnnotateConfigError(
        "mode 'always' needs `accessKey` (ak_…) or ANNOTATE_ACCESS_KEY. Use mode 'activation' for production sites.",
      );
    }
    if (!KEY_RE.test(accessKey)) throw new AnnotateConfigError('`accessKey` has invalid characters.');
  } else {
    // Validate the type even though it's unused, so a typo'd config fails loudly; never carry it.
    optionalString(options.accessKey, 'accessKey');
  }

  const context: unknown = options.context ?? {};
  if (!isPlainObject(context)) throw new AnnotateConfigError('`context` must be a plain object.');
  try {
    JSON.stringify(context);
  } catch (err) {
    throw new AnnotateConfigError(`\`context\` must be JSON-serializable (${(err as Error).message}).`);
  }

  return { ...base, enabled: true, project, endpoint, mode, accessKey, position, context };
}

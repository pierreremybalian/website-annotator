// @annotate/astro: injects the Annotate feedback widget into an Astro site and writes source hints for agents.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import type { AstroConfig, AstroIntegration, AstroIntegrationLogger } from 'astro';
import { CidCollector, cidManifestPlugin, sourceAttributesPlugin, writeManifest, type VitePluginLike } from './manifest.ts';
import { resolveOptions, type AnnotateOptions, type Env, type ResolvedOptions } from './options.ts';
import { buildHeadScripts, buildPageContext } from './scripts.ts';

export type { AnnotateMode, AnnotateOptions, AnnotatePosition } from './options.ts';
export { AnnotateConfigError, DEFAULT_ENDPOINT } from './options.ts';
export { MANIFEST_DIR, MANIFEST_FILE } from './manifest.ts';

const NAME = '@annotate/astro';
const ENV_KEYS = [
  'PUBLIC_ANNOTATE_PROJECT',
  'ANNOTATE_PROJECT',
  'PUBLIC_ANNOTATE_ENDPOINT',
  'ANNOTATE_ENDPOINT',
  'ANNOTATE_ACCESS_KEY',
  'PUBLIC_ANNOTATE_ACCESS_KEY',
];

/**
 * The ANNOTATE_* variables from process.env, then from the project's .env files (.env, .env.local, .env.<mode>,
 * .env.<mode>.local, later wins), since astro.config runs before Vite loads them. process.env wins over files.
 */
export function loadAnnotateEnv(root: string, mode: string, processEnv: Env = process.env): Env {
  const out: Env = {};
  for (const name of ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`]) {
    let text: string;
    try {
      text = readFileSync(path.join(root, name), 'utf8');
    } catch {
      continue;
    }
    let parsed: Record<string, string | undefined>;
    try {
      parsed = parseEnv(text) as Record<string, string | undefined>;
    } catch {
      continue;
    }
    for (const key of ENV_KEYS) if (parsed[key]) out[key] = parsed[key];
  }
  for (const key of ENV_KEYS) if (processEnv[key]) out[key] = processEnv[key];
  return out;
}

/** The project's installed astro version (falls back to the one this package resolves). */
function astroVersion(root: string): string {
  for (const from of [path.join(root, 'package.json'), fileURLToPath(import.meta.url)]) {
    try {
      const pkgPath = createRequire(from).resolve('astro/package.json');
      const version = (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown }).version;
      if (typeof version === 'string') return version;
    } catch {
      /* try the next one */
    }
  }
  return 'unknown';
}

/**
 * With Astro's `security.csp` on, script-src lists only 'self' and hashes, which would block widget.js.
 * Returns the config update that allows the endpoint's origin (keeping 'self', which Astro drops once any
 * resource is listed), or null when nothing is needed.
 */
export function cspUpdate(config: Pick<AstroConfig, 'security'>, endpoint: string): Partial<AstroConfig> | null {
  const csp = (config.security as { csp?: unknown } | undefined)?.csp;
  if (!csp) return null;
  const origin = new URL(endpoint).origin;
  const current =
    typeof csp === 'object' ? ((csp as { scriptDirective?: { resources?: string[] } }).scriptDirective?.resources ?? []) : [];
  if (current.includes(origin)) return null;
  const resources = current.length ? [origin] : ["'self'", origin];
  // `csp: true` becomes an object here. Config updates aren't re-parsed with schema defaults, so spell out
  // the algorithm `true` implies, or Astro's hashing fails with "Unrecognized algorithm name".
  const update = csp === true ? { algorithm: 'SHA-256', scriptDirective: { resources } } : { scriptDirective: { resources } };
  return { security: { csp: update } } as unknown as Partial<AstroConfig>;
}

function warnIfUnguarded(resolved: ResolvedOptions, logger: AstroIntegrationLogger): void {
  if (resolved.enabledExplicit) return;
  if (resolved.enabled && resolved.mode === 'always') {
    logger.warn(
      "mode 'always' loads the widget, with its access key, for every visitor. It's meant for staging/preview builds: " +
        "set `enabled` (e.g. `enabled: process.env.PUBLIC_STAGE === 'staging'`) so it can't ship to production by accident.",
    );
  }
  if (resolved.enabled && resolved.sourceAttributes) {
    logger.warn(
      '`sourceAttributes` adds source file paths to the public HTML. Set `enabled` to a staging check so it never ships to production.',
    );
  }
}

export default function annotate(options: AnnotateOptions = {}): AstroIntegration {
  let resolved: ResolvedOptions | undefined;
  let root = '';
  let collector: CidCollector | undefined;

  return {
    name: NAME,
    hooks: {
      'astro:config:setup': ({ config, command, injectScript, updateConfig, logger }) => {
        // `astro sync` / `astro check` / `astro preview` render nothing: don't require keys there.
        if (command !== 'dev' && command !== 'build') return;
        root = fileURLToPath(config.root);
        const env = loadAnnotateEnv(root, command === 'dev' ? 'development' : 'production');
        resolved = resolveOptions(options, env);
        warnIfUnguarded(resolved, logger);

        const plugins: VitePluginLike[] = [];
        // The manifest is build metadata outside dist, so it's written even when the widget is disabled:
        // a local `astro build` is how a developer (or agent) gets the map for issues reported on staging.
        if (command === 'build' && resolved.sourceManifest) {
          collector = new CidCollector(root, config.scopedStyleStrategy ?? 'attribute');
          plugins.push(cidManifestPlugin(collector));
        }

        if (resolved.enabled) {
          const ctx = buildPageContext({ astroVersion: astroVersion(root), base: config.base, context: resolved.context });
          for (const script of buildHeadScripts(resolved, ctx)) injectScript('head-inline', script);
          if (command === 'build' && resolved.sourceAttributes) plugins.push(sourceAttributesPlugin(root));
          const csp = cspUpdate(config, resolved.endpoint);
          if (csp) {
            updateConfig(csp);
            logger.info(`Added ${new URL(resolved.endpoint).origin} to security.csp script-src for widget.js.`);
          }
          logger.info(
            resolved.mode === 'always'
              ? `Widget always on (project ${resolved.project}).`
              : `Widget loader for activation links (project ${resolved.project}).`,
          );
        } else {
          logger.info('Disabled: nothing injected.');
        }

        if (plugins.length) updateConfig({ vite: { plugins: plugins as never } });
      },

      'astro:build:done': async ({ logger }) => {
        if (!collector) return;
        const file = await writeManifest(root, collector.toJSON());
        logger.info(`Wrote ${path.relative(root, file)} (${collector.size} components with scoped styles).`);
      },
    },
  };
}

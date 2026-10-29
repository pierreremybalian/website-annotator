import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import annotate, { cspUpdate, loadAnnotateEnv } from '../src/index.ts';
import type { AnnotateOptions } from '../src/options.ts';
import type { VitePluginLike } from '../src/manifest.ts';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'annotate-astro-int-'));
  for (const key of ['PUBLIC_ANNOTATE_PROJECT', 'ANNOTATE_PROJECT', 'PUBLIC_ANNOTATE_ENDPOINT', 'ANNOTATE_ENDPOINT', 'ANNOTATE_ACCESS_KEY', 'PUBLIC_ANNOTATE_ACCESS_KEY']) {
    vi.stubEnv(key, '');
  }
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

function fakeLogger() {
  const logs = { info: [] as string[], warn: [] as string[] };
  const logger = {
    info: (m: string) => logs.info.push(m),
    warn: (m: string) => logs.warn.push(m),
    error: () => {},
    debug: () => {},
    fork: () => logger,
  };
  return { logger, logs };
}

async function setup(options: AnnotateOptions, { command = 'build', config = {} }: { command?: string; config?: Record<string, unknown> } = {}) {
  const scripts: Array<{ stage: string; content: string }> = [];
  const updates: Array<Record<string, any>> = [];
  const { logger, logs } = fakeLogger();
  const integration = annotate(options);
  await integration.hooks['astro:config:setup']!({
    config: { root: pathToFileURL(`${root}/`), base: '/docs', scopedStyleStrategy: 'attribute', security: {}, ...config },
    command,
    isRestart: false,
    injectScript: (stage: string, content: string) => scripts.push({ stage, content }),
    updateConfig: (c: Record<string, any>) => (updates.push(c), c),
    logger,
  } as never);
  const plugins = updates.flatMap((u) => (u.vite?.plugins ?? []) as VitePluginLike[]);
  const buildDone = () => integration.hooks['astro:build:done']!({ logger, pages: [], dir: new URL('dist/', pathToFileURL(`${root}/`)), assets: new Map() } as never);
  return { scripts, updates, plugins, logs, buildDone };
}

describe('astro:config:setup', () => {
  it('activation mode injects one head-inline loader without the access key', async () => {
    const { scripts, logs } = await setup({ project: 'pk_int', accessKey: 'ak_never_public' });
    expect(scripts).toHaveLength(1);
    expect(scripts[0]!.stage).toBe('head-inline');
    expect(scripts[0]!.content).toContain('"pk_int"');
    expect(scripts[0]!.content).toContain('"base":"/docs"');
    expect(scripts[0]!.content).toMatch(/"astro":"\d+\.\d+\.\d+"/);
    expect(scripts[0]!.content).not.toContain('ak_never_public');
    expect(logs.warn).toEqual([]);
  });

  it('always mode injects the always-on tag and warns without an explicit enabled', async () => {
    const { scripts, logs } = await setup({ project: 'pk_int', mode: 'always', accessKey: 'ak_staging' });
    expect(scripts).toHaveLength(1);
    expect(scripts[0]!.content).toContain('"ak_staging"');
    expect(scripts[0]!.content).toContain("'data-always-on', 'true'");
    expect(logs.warn.join('\n')).toMatch(/staging/);
  });

  it("always mode with an explicit enabled doesn't warn", async () => {
    const { logs } = await setup({ project: 'pk_int', mode: 'always', accessKey: 'ak_staging', enabled: true });
    expect(logs.warn).toEqual([]);
  });

  it('enabled: false injects nothing and needs no project', async () => {
    const { scripts, logs } = await setup({ enabled: false, mode: 'always' });
    expect(scripts).toEqual([]);
    expect(logs.warn).toEqual([]);
  });

  it('reads the project from process.env and .env files', async () => {
    await writeFile(path.join(root, '.env'), 'PUBLIC_ANNOTATE_PROJECT=pk_from_dotenv\nOTHER=1\n');
    expect((await setup({})).scripts[0]!.content).toContain('"pk_from_dotenv"');
    vi.stubEnv('ANNOTATE_PROJECT', 'pk_from_process');
    vi.stubEnv('PUBLIC_ANNOTATE_PROJECT', '');
    // .env still has PUBLIC_ANNOTATE_PROJECT, which is checked before ANNOTATE_PROJECT.
    expect((await setup({})).scripts[0]!.content).toContain('"pk_from_dotenv"');
  });

  it('throws a clear error without a project', async () => {
    await expect(setup({})).rejects.toThrow(/Missing project key/);
    await expect(setup({}, { command: 'dev' })).rejects.toThrow(/Missing project key/);
  });

  it("does nothing (and requires nothing) for astro sync / check / preview", async () => {
    for (const command of ['sync', 'preview']) {
      const { scripts, updates } = await setup({}, { command });
      expect(scripts).toEqual([]);
      expect(updates).toEqual([]);
    }
  });

  it('adds the manifest plugin on build only, even when the widget is disabled', async () => {
    expect((await setup({ project: 'pk_int' })).plugins.map((p) => p.name)).toEqual(['annotate:astro-cids']);
    expect((await setup({ enabled: false })).plugins.map((p) => p.name)).toEqual(['annotate:astro-cids']);
    expect((await setup({ project: 'pk_int' }, { command: 'dev' })).plugins).toEqual([]);
    expect((await setup({ project: 'pk_int', sourceManifest: false })).plugins).toEqual([]);
  });

  it('adds the source-attributes plugin only when asked, and warns', async () => {
    const { plugins, logs } = await setup({ project: 'pk_int', sourceAttributes: true });
    expect(plugins.map((p) => p.name)).toEqual(['annotate:astro-cids', 'annotate:astro-source-attributes']);
    expect(logs.warn.join('\n')).toMatch(/source file paths/);
  });

  it('allows the endpoint in script-src when security.csp is on', async () => {
    const { updates } = await setup({ project: 'pk_int', endpoint: 'https://fb.example.com/x' }, { config: { security: { csp: true } } });
    expect(updates).toContainEqual({
      security: { csp: { algorithm: 'SHA-256', scriptDirective: { resources: ["'self'", 'https://fb.example.com'] } } },
    });
  });
});

describe('astro:build:done', () => {
  it('writes the manifest from fake module data', async () => {
    const { plugins, buildDone } = await setup({ project: 'pk_int' });
    const transform = plugins[0]!.transform!;
    transform('return $$render`<section data-astro-cid-ge2uvauf><h1 data-astro-cid-ge2uvauf>x</h1></section>`', path.join(root, 'src/components/Hero.astro'));
    transform('return $$render`<footer>x</footer>`', path.join(root, 'src/components/Plain.astro'));
    await buildDone();
    const manifest = JSON.parse(await readFile(path.join(root, '.annotate', 'astro-cids.json'), 'utf8'));
    expect(manifest).toEqual({ ge2uvauf: 'src/components/Hero.astro' });
  });

  it('writes nothing when sourceManifest is false', async () => {
    const { buildDone } = await setup({ project: 'pk_int', sourceManifest: false });
    await buildDone();
    await expect(readFile(path.join(root, '.annotate', 'astro-cids.json'), 'utf8')).rejects.toThrow();
  });
});

describe('loadAnnotateEnv', () => {
  it('layers .env files by mode and lets process.env win', async () => {
    await writeFile(path.join(root, '.env'), 'ANNOTATE_PROJECT=pk_base\nANNOTATE_ENDPOINT=http://base\n');
    await writeFile(path.join(root, '.env.production'), 'ANNOTATE_PROJECT=pk_prod\n');
    await writeFile(path.join(root, '.env.development.local'), 'ANNOTATE_PROJECT=pk_dev_local\n');
    expect(loadAnnotateEnv(root, 'production', {})).toEqual({ ANNOTATE_PROJECT: 'pk_prod', ANNOTATE_ENDPOINT: 'http://base' });
    expect(loadAnnotateEnv(root, 'development', {})).toMatchObject({ ANNOTATE_PROJECT: 'pk_dev_local' });
    expect(loadAnnotateEnv(root, 'production', { ANNOTATE_PROJECT: 'pk_shell' })).toMatchObject({ ANNOTATE_PROJECT: 'pk_shell' });
  });
});

describe('cspUpdate', () => {
  it('is a no-op without CSP or when the origin is already listed', () => {
    expect(cspUpdate({ security: {} } as never, 'https://a.example')).toBeNull();
    expect(cspUpdate({ security: { csp: { scriptDirective: { resources: ['https://a.example'] } } } } as never, 'https://a.example/x')).toBeNull();
  });

  it("adds only the origin when resources are already set (Astro then drops its default 'self')", () => {
    expect(cspUpdate({ security: { csp: { scriptDirective: { resources: ["'self'", 'https://cdn.example'] } } } } as never, 'https://a.example')).toEqual({
      security: { csp: { scriptDirective: { resources: ['https://a.example'] } } },
    });
  });
});

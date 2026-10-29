import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { resolveOptions } from '../src/options.ts';
import { activationScript, alwaysOnScript, buildHeadScripts, buildPageContext, CATCHER_JS, jsonForScript } from '../src/scripts.ts';

const ctx = buildPageContext({ astroVersion: '7.4.4', base: '/', context: { stage: 'test' } });
const opts = { project: 'pk_test', endpoint: 'https://annotate.example.com', position: 'bottom-left' as const };

interface FakeEl {
  tag: string;
  attrs: Record<string, string>;
  src?: string;
  async?: boolean;
  nonce?: string;
}

/** Run an injected script against a minimal fake window/document. */
function run(code: string, env: { search?: string; storage?: Record<string, string>; widget?: boolean } = {}) {
  const appended: FakeEl[] = [];
  const docListeners: Record<string, Array<() => void>> = {};
  const winListeners: Record<string, Array<(ev: unknown) => void>> = {};
  const location = { search: env.search ?? '' };
  const document = {
    currentScript: { nonce: 'nonce-123' },
    head: { appendChild: (el: FakeEl) => appended.push(el) },
    documentElement: { appendChild: (el: FakeEl) => appended.push(el) },
    createElement: (tag: string): FakeEl => ({
      tag,
      attrs: {},
      setAttribute(this: FakeEl, k: string, v: string) {
        this.attrs[k] = String(v);
      },
    } as FakeEl),
    querySelector: (sel: string) => (env.widget && sel === 'annotate-widget' ? {} : null),
    addEventListener: (type: string, fn: () => void) => (docListeners[type] ??= []).push(fn),
  };
  const errors: unknown[][] = [];
  const window: Record<string, unknown> = {
    location,
    localStorage: { getItem: (k: string) => env.storage?.[k] ?? null },
    addEventListener: (type: string, fn: (ev: unknown) => void) => (winListeners[type] ??= []).push(fn),
    console: { error: (...args: unknown[]) => errors.push(args) },
  };
  const context = vm.createContext({ window, document });
  const exec = () => vm.runInContext(code, context);
  exec();
  return { window, document, appended, docListeners, winListeners, location, errors, exec };
}

describe('jsonForScript', () => {
  it('cannot close the script tag or break out of strings', () => {
    const out = jsonForScript({ a: '</script><script>alert(1)</script>', b: "it's & co", c: '\u2028\u2029' });
    expect(out).not.toMatch(/[<>&']/);
    expect(out).not.toMatch(/[\u2028\u2029]/);
    expect(JSON.parse(out)).toEqual({ a: '</script><script>alert(1)</script>', b: "it's & co", c: '\u2028\u2029' });
  });
});

describe('buildPageContext', () => {
  it('sets platform, version and base, then merges context', () => {
    expect(ctx).toEqual({ platform: 'astro', astro: '7.4.4', base: '/', stage: 'test' });
  });

  it('enforces the 4 KB limit', () => {
    expect(() => buildPageContext({ astroVersion: '7', base: '/', context: { big: 'x'.repeat(5000) } })).toThrow(/4096/);
  });
});

describe('activation script', () => {
  const code = activationScript(opts, ctx);

  it('contains the project and endpoint but never an access key', () => {
    expect(code).toContain('"pk_test"');
    expect(code).toContain('"https://annotate.example.com/widget.js"');
    expect(code).toContain("'annotate:access:' + project");
    expect(code).not.toContain('data-access');
    expect(code).not.toContain('data-always-on');
    expect(code).not.toContain('ak_');
  });

  it('does nothing for regular visitors', () => {
    const r = run(code);
    expect(r.appended).toHaveLength(0);
    expect(r.window.AnnotateContext).toBeUndefined();
    expect(r.window.__annotateErrors).toBeUndefined();
    expect(r.winListeners.error).toBeUndefined();
  });

  it('loads the widget for ?annotate= links, with context and the error catcher first', () => {
    const r = run(code, { search: '?annotate=ak_link' });
    expect(r.appended).toHaveLength(1);
    const s = r.appended[0]!;
    expect(s.tag).toBe('script');
    expect(s.src).toBe('https://annotate.example.com/widget.js');
    expect(s.async).toBe(true);
    expect(s.nonce).toBe('nonce-123');
    expect(s.attrs).toEqual({
      'data-endpoint': 'https://annotate.example.com',
      'data-project': 'pk_test',
      'data-position': 'bottom-left',
    });
    expect(r.window.AnnotateContext).toEqual(ctx);
    expect(Array.isArray(r.window.__annotateErrors)).toBe(true);
    (r.window.console as { error: (...a: unknown[]) => void }).error('boom');
    expect(r.window.__annotateErrors).toMatchObject([{ kind: 'console.error', message: 'boom' }]);
    expect(r.errors).toEqual([['boom']]); // the original console.error still runs
  });

  it('loads the widget for browsers activated earlier', () => {
    expect(run(code, { storage: { 'annotate:access:pk_test': 'ak_saved' } }).appended).toHaveLength(1);
    expect(run(code, { storage: { 'annotate:access:pk_other': 'ak_saved' } }).appended).toHaveLength(0);
  });

  it('re-checks on astro:after-swap and never loads twice', () => {
    const r = run(code);
    expect(r.docListeners['astro:after-swap']).toHaveLength(1);
    const swap = r.docListeners['astro:after-swap']![0]!;
    swap();
    expect(r.appended).toHaveLength(0);
    r.location.search = '?annotate=ak_later';
    swap();
    swap();
    expect(r.appended).toHaveLength(1);
  });

  it('skips loading when a widget is already mounted', () => {
    expect(run(code, { search: '?annotate=ak_x', widget: true }).appended).toHaveLength(0);
  });
});

describe('always-on script', () => {
  const code = alwaysOnScript({ ...opts, accessKey: 'ak_staging' }, ctx);

  it('loads the widget for everyone with data-access and data-always-on', () => {
    const r = run(code);
    expect(r.appended).toHaveLength(1);
    expect(r.appended[0]!.attrs).toEqual({
      'data-endpoint': 'https://annotate.example.com',
      'data-project': 'pk_test',
      'data-access': 'ak_staging',
      'data-always-on': 'true',
      'data-position': 'bottom-left',
    });
    expect(r.window.AnnotateContext).toEqual(ctx);
    expect(Array.isArray(r.window.__annotateErrors)).toBe(true);
  });

  it('is idempotent if it runs again (e.g. a second copy after a swap)', () => {
    const r = run(code);
    r.exec();
    expect(r.appended).toHaveLength(1);
  });
});

describe('buildHeadScripts', () => {
  it('returns one script per mode and nothing when disabled', () => {
    const activation = buildHeadScripts(resolveOptions({ project: 'pk_a', accessKey: 'ak_never' }), ctx);
    expect(activation).toHaveLength(1);
    expect(activation[0]).not.toContain('ak_never');

    const always = buildHeadScripts(resolveOptions({ project: 'pk_a', mode: 'always', accessKey: 'ak_yes', enabled: true }), ctx);
    expect(always).toHaveLength(1);
    expect(always[0]).toContain('"ak_yes"');
    expect(always[0]!.indexOf(CATCHER_JS)).toBe(0);

    expect(buildHeadScripts(resolveOptions({ enabled: false }), ctx)).toEqual([]);
  });
});

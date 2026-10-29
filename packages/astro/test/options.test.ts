import { describe, expect, it } from 'vitest';
import { AnnotateConfigError, DEFAULT_ENDPOINT, normalizeEndpoint, resolveOptions } from '../src/options.ts';

describe('resolveOptions', () => {
  it('applies defaults', () => {
    const r = resolveOptions({ project: 'pk_abc' });
    expect(r).toMatchObject({
      enabled: true,
      enabledExplicit: false,
      project: 'pk_abc',
      endpoint: DEFAULT_ENDPOINT,
      mode: 'activation',
      position: 'bottom-right',
      context: {},
      sourceManifest: true,
      sourceAttributes: false,
    });
    expect(r.accessKey).toBeUndefined();
  });

  it('falls back to PUBLIC_ANNOTATE_PROJECT, then ANNOTATE_PROJECT', () => {
    expect(resolveOptions({}, { PUBLIC_ANNOTATE_PROJECT: 'pk_public', ANNOTATE_PROJECT: 'pk_private' }).project).toBe('pk_public');
    expect(resolveOptions({}, { ANNOTATE_PROJECT: 'pk_private' }).project).toBe('pk_private');
    expect(resolveOptions({}, { PUBLIC_ANNOTATE_PROJECT: '  ', ANNOTATE_PROJECT: 'pk_private' }).project).toBe('pk_private');
  });

  it('prefers the explicit option over env', () => {
    expect(resolveOptions({ project: 'pk_opt' }, { PUBLIC_ANNOTATE_PROJECT: 'pk_env' }).project).toBe('pk_opt');
  });

  it('reads endpoint and access key from env too', () => {
    const r = resolveOptions(
      { mode: 'always', enabled: true },
      { ANNOTATE_PROJECT: 'pk_x', ANNOTATE_ENDPOINT: 'http://localhost:8787/', ANNOTATE_ACCESS_KEY: 'ak_env' },
    );
    expect(r.endpoint).toBe('http://localhost:8787');
    expect(r.accessKey).toBe('ak_env');
  });

  it('requires a project when enabled', () => {
    expect(() => resolveOptions({})).toThrow(AnnotateConfigError);
    expect(() => resolveOptions({})).toThrow(/PUBLIC_ANNOTATE_PROJECT/);
  });

  it('requires nothing when disabled', () => {
    const r = resolveOptions({ enabled: false, mode: 'always' });
    expect(r.enabled).toBe(false);
    expect(r.enabledExplicit).toBe(true);
    expect(r.accessKey).toBeUndefined();
    expect(r.sourceManifest).toBe(true);
    expect(r.sourceAttributes).toBe(false);
  });

  it('rejects keys with unsafe characters', () => {
    expect(() => resolveOptions({ project: 'pk_"><script>' })).toThrow(/invalid characters/);
    expect(() => resolveOptions({ project: 'pk_a', mode: 'always', accessKey: 'ak bad' })).toThrow(/invalid characters/);
  });

  it('always mode requires an access key', () => {
    expect(() => resolveOptions({ project: 'pk_a', mode: 'always' })).toThrow(/accessKey/);
    expect(resolveOptions({ project: 'pk_a', mode: 'always', accessKey: 'ak_1' }).accessKey).toBe('ak_1');
  });

  it('never carries the access key in activation mode', () => {
    const r = resolveOptions({ project: 'pk_a', accessKey: 'ak_secret' }, { ANNOTATE_ACCESS_KEY: 'ak_env' });
    expect(r.mode).toBe('activation');
    expect(r.accessKey).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain('ak_');
  });

  it('validates mode, position and booleans', () => {
    expect(() => resolveOptions({ project: 'pk_a', mode: 'sometimes' as never })).toThrow(/mode/);
    expect(() => resolveOptions({ project: 'pk_a', position: 'top-left' as never })).toThrow(/position/);
    expect(() => resolveOptions({ project: 'pk_a', enabled: 'yes' as never })).toThrow(/enabled/);
    expect(() => resolveOptions({ project: 'pk_a', sourceManifest: 1 as never })).toThrow(/sourceManifest/);
    expect(resolveOptions({ project: 'pk_a', position: 'bottom-left' }).position).toBe('bottom-left');
  });

  it('validates context', () => {
    expect(() => resolveOptions({ project: 'pk_a', context: [] as never })).toThrow(/context/);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => resolveOptions({ project: 'pk_a', context: circular })).toThrow(/JSON-serializable/);
    expect(resolveOptions({ project: 'pk_a', context: { stage: 'staging' } }).context).toEqual({ stage: 'staging' });
  });
});

describe('normalizeEndpoint', () => {
  it('keeps scheme, host, port and path; drops trailing slash, query and hash', () => {
    expect(normalizeEndpoint('https://feedback.example.com/')).toBe('https://feedback.example.com');
    expect(normalizeEndpoint('http://localhost:8787')).toBe('http://localhost:8787');
    expect(normalizeEndpoint('https://example.com:443/annotate/?x=1#y')).toBe('https://example.com/annotate');
  });

  it('rejects non-http URLs and garbage', () => {
    expect(() => normalizeEndpoint('javascript:alert(1)')).toThrow(/http/);
    expect(() => normalizeEndpoint('not a url')).toThrow(/valid URL/);
    expect(() => normalizeEndpoint('https://user:pw@example.com')).toThrow(/credentials/);
  });
});

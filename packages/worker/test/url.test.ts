import { describe, expect, it } from 'vitest';
import { normalizeUrl } from '../src/url';

describe('normalizeUrl', () => {
  it.each([
    ['lowercases the host', 'https://Example.COM/About', 'https://example.com/About'],
    ['drops the https default port', 'https://example.com:443/a', 'https://example.com/a'],
    ['drops the http default port', 'http://example.com:80/a', 'http://example.com/a'],
    ['keeps a non-default port', 'http://localhost:5173/a', 'http://localhost:5173/a'],
    ['drops the hash', 'https://example.com/a#section-2', 'https://example.com/a'],
    ['drops a trailing slash on non-root paths', 'https://example.com/about/', 'https://example.com/about'],
    ['drops repeated trailing slashes', 'https://example.com/about//', 'https://example.com/about'],
    ['keeps the root slash', 'https://example.com/', 'https://example.com/'],
    ['adds the root slash', 'https://example.com', 'https://example.com/'],
    ['drops utm_* params', 'https://example.com/a?utm_source=x&utm_medium=y&UTM_Campaign=z', 'https://example.com/a'],
    [
      'drops click ids and mailchimp params',
      'https://example.com/a?fbclid=1&gclid=2&msclkid=3&_ga=4&mc_cid=5&mc_eid=6',
      'https://example.com/a',
    ],
    ['drops the activation param', 'https://example.com/a?annotate=secret-key&page=2', 'https://example.com/a?page=2'],
    ['sorts the remaining params', 'https://example.com/a?b=2&a=1&c=3', 'https://example.com/a?a=1&b=2&c=3'],
    ['keeps the order of repeated params', 'https://example.com/a?tag=z&a=1&tag=y', 'https://example.com/a?a=1&tag=z&tag=y'],
    ['drops an empty query', 'https://example.com/a?', 'https://example.com/a'],
    [
      'combines everything',
      'HTTPS://Shop.Example.com:443/products/shoes/?utm_source=news&size=9&color=red&fbclid=abc#reviews',
      'https://shop.example.com/products/shoes?color=red&size=9',
    ],
  ])('%s', (_name, raw, expected) => {
    expect(normalizeUrl(raw)).toBe(expected);
  });

  it('treats the same page with different tracking params as equal', () => {
    const a = normalizeUrl('https://example.com/pricing/?utm_source=google&gclid=1');
    const b = normalizeUrl('https://EXAMPLE.com/pricing#plans');
    const c = normalizeUrl('https://example.com/pricing?annotate=k&fbclid=2');
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('drops the whole query with ignoreQuery', () => {
    expect(normalizeUrl('https://example.com/a/?page=2&utm_source=x#h', { ignoreQuery: true })).toBe('https://example.com/a');
    expect(normalizeUrl('https://example.com/a?page=2', { ignoreQuery: 1 })).toBe('https://example.com/a');
    expect(normalizeUrl('https://example.com/a?page=2', { ignoreQuery: 0 })).toBe('https://example.com/a?page=2');
  });

  it('is idempotent', () => {
    const once = normalizeUrl('https://Example.com/a/b/?z=1&y=2&utm_x=3#q');
    expect(normalizeUrl(once)).toBe(once);
  });

  it('throws on an unparseable URL', () => {
    expect(() => normalizeUrl('not a url')).toThrow(TypeError);
  });
});

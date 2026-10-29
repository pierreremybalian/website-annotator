import path from 'node:path';
import type { SourceHint } from '@annotate/shared';
import { describe, expect, it } from 'vitest';
import { SourceResolver, resolveSources, splitLine } from '../src/sources';
import { issueFixture, tmpDir, writeTree } from './helpers';

const hint = (kind: SourceHint['kind'], value: string, extra: Partial<SourceHint> = {}): SourceHint => ({ kind, value, depth: 0, ...extra });

function wpRepo(): string {
  const root = tmpDir();
  writeTree(root, {
    'wp-content/themes/strauss/blocks/hero/block.json': { name: 'acf/hero', acf: { renderTemplate: 'hero.php' } },
    'wp-content/themes/strauss/blocks/hero/hero.php': '<section class="hero"></section>',
    'wp-content/themes/strauss/blocks/cards/block.json': { name: 'acf/cards', render: 'file:./render.php' },
    'wp-content/themes/strauss/blocks/cards/render.php': '',
    'wp-content/themes/strauss/src/quote/block.json': { name: 'acf/quote', acf: { renderTemplate: 'template-parts/blocks/quote.php' } },
    'wp-content/themes/strauss/template-parts/blocks/quote.php': '',
    'wp-content/themes/strauss/template-parts/blocks/cta-banner.php': '',
    'wp-content/themes/strauss/page-about.php': '',
    'wp-content/themes/twentytwenty/page-about.php': '',
    'wp-content/themes/strauss/templates/page-wide.html': '',
    // Skipped directories must not match.
    'node_modules/x/blocks/hero/block.json': { name: 'acf/hero' },
    'wp-content/uploads/blocks/hero/block.json': { name: 'acf/hero' },
    'vendor/blocks/hero/x.php': '',
  });
  return root;
}

describe('wp-block', () => {
  it('finds the block.json by name, plus its ACF render template', () => {
    const r = new SourceResolver(wpRepo());
    expect(r.wpBlock('acf/hero')).toEqual(['wp-content/themes/strauss/blocks/hero/', 'wp-content/themes/strauss/blocks/hero/hero.php']);
  });

  it('follows core "render": "file:./render.php"', () => {
    expect(new SourceResolver(wpRepo()).wpBlock('acf/cards')).toEqual([
      'wp-content/themes/strauss/blocks/cards/',
      'wp-content/themes/strauss/blocks/cards/render.php',
    ]);
  });

  it('resolves a theme-relative ACF renderTemplate', () => {
    expect(new SourceResolver(wpRepo()).wpBlock('acf/quote')).toEqual([
      'wp-content/themes/strauss/src/quote/',
      'wp-content/themes/strauss/template-parts/blocks/quote.php',
    ]);
  });

  it('falls back to conventional locations without a block.json', () => {
    expect(new SourceResolver(wpRepo()).wpBlock('acf/cta')).toEqual(['wp-content/themes/strauss/template-parts/blocks/cta-banner.php']);
    expect(new SourceResolver(wpRepo()).wpBlock('acf/missing')).toEqual([]);
  });
});

describe('astro', () => {
  function astroRepo(): string {
    const root = tmpDir();
    writeTree(root, {
      'site/src/components/Hero.astro': '---\n---\n<section/>',
      'site/src/components/Footer.astro': '',
      'site/.annotate/astro-cids.json': { abc123: 'src/components/Hero.astro', gone: 'src/components/Deleted.astro' },
      'site/dist/.annotate/astro-cids.json': { zzz: 'src/components/Footer.astro' },
    });
    return root;
  }

  it('astro-source: absolute under the root becomes relative, with :line', () => {
    const root = astroRepo();
    const r = new SourceResolver(root);
    const abs = path.join(root, 'site/src/components/Hero.astro');
    expect(r.astroSource(hint('astro-source', abs, { file: abs, line: 12 }))).toEqual(['site/src/components/Hero.astro:12']);
    expect(r.astroSource(hint('astro-source', 'site/src/components/Hero.astro'))).toEqual(['site/src/components/Hero.astro']);
  });

  it("astro-source: another machine's absolute path falls back to its longest existing suffix", () => {
    const r = new SourceResolver(astroRepo());
    expect(r.astroSource(hint('astro-source', '/home/ci/work/site/src/components/Hero.astro', { line: 3 }))).toEqual([
      'site/src/components/Hero.astro:3',
    ]);
    expect(r.astroSource(hint('astro-source', '/elsewhere/Nope.astro'))).toEqual([]);
  });

  it('astro-cid: looks the hash up in .annotate/astro-cids.json, relative to its project', () => {
    const r = new SourceResolver(astroRepo());
    expect(r.astroCid('abc123')).toEqual(['site/src/components/Hero.astro']);
    expect(r.astroCid('data-astro-cid-abc123')).toEqual(['site/src/components/Hero.astro']);
    expect(r.astroCid('gone')).toEqual([]);
    expect(r.astroCid('zzz')).toEqual([]); // manifests under dist/ are skipped
    expect(r.astroCid('unknown')).toEqual([]);
  });
});

describe('annotate', () => {
  it('uses an existing path, else basename matches', () => {
    const root = tmpDir();
    writeTree(root, {
      'src/components/Card.tsx': '',
      'src/legacy/Card.tsx': '',
      'src/components/PriceTable.vue': '',
      'src/components/pricetable.css': '',
      'public/pricetable.png': '',
    });
    const r = new SourceResolver(root);
    expect(r.annotate(hint('annotate', 'src/components/Card.tsx:8'))).toEqual(['src/components/Card.tsx:8']);
    expect(r.annotate(hint('annotate', 'components/Card.tsx'))).toEqual(['src/components/Card.tsx', 'src/legacy/Card.tsx']);
    expect(r.annotate(hint('annotate', 'PriceTable'))).toEqual(['src/components/PriceTable.vue', 'src/components/pricetable.css']);
    expect(r.annotate(hint('annotate', 'src/components'))).toEqual(['src/components/']);
  });
});

describe('resolveSources', () => {
  it('maps every hint (nearest first) and the WordPress page template', () => {
    const root = wpRepo();
    const issue = issueFixture({
      context: {
        page: { platform: 'wordpress', template: 'page-about.php', theme: 'strauss' },
        element: {
          tag: 'a',
          html: '',
          text: '',
          landmark: null,
          styles: {},
          sources: [hint('wp-block', 'acf/hero', { depth: 1 }), hint('wp-block', 'acf/hero', { depth: 1 }), hint('astro-cid', 'nope', { depth: 2 })],
        },
      },
    });
    const { sources, truncated } = resolveSources(issue, { root });
    expect(truncated).toBe(false);
    expect(sources).toEqual([
      {
        hint: { kind: 'wp-block', value: 'acf/hero', depth: 1 },
        files: ['wp-content/themes/strauss/blocks/hero/', 'wp-content/themes/strauss/blocks/hero/hero.php'],
      },
      { hint: { kind: 'astro-cid', value: 'nope', depth: 2 }, files: [] },
      { hint: { kind: 'page-template', value: 'page-about.php' }, files: ['wp-content/themes/strauss/page-about.php', 'wp-content/themes/twentytwenty/page-about.php'] },
    ]);
  });

  it('finds block-theme templates by slug and absolute server paths by suffix', () => {
    const r = new SourceResolver(wpRepo());
    expect(r.pageTemplate('page-wide')).toEqual(['wp-content/themes/strauss/templates/page-wide.html']);
    expect(r.pageTemplate('/var/www/html/wp-content/themes/strauss/page-about.php')).toEqual(['wp-content/themes/strauss/page-about.php']);
  });

  it('falls back to the issue-level sources and skips missing/default templates', () => {
    const root = wpRepo();
    const { sources } = resolveSources(issueFixture({ context: { page: { template: 'default' }, element: null } }), { root });
    expect(sources.map((s) => s.hint.kind)).toEqual(['wp-block']);
    expect(resolveSources(issueFixture({ context: null, sources: [] }), { root }).sources).toEqual([]);
  });

  it('stops at the walk limits and says so', () => {
    const root = wpRepo();
    const { truncated } = resolveSources(issueFixture(), { root, limits: { maxDepth: 12, maxEntries: 5 } });
    expect(truncated).toBe(true);
  });
});

describe('splitLine', () => {
  it('splits :line and :line:col', () => {
    expect(splitLine('a/b.astro:12:3')).toEqual({ path: 'a/b.astro', line: 12 });
    expect(splitLine('a/b.astro:7')).toEqual({ path: 'a/b.astro', line: 7 });
    expect(splitLine('a/b.astro')).toEqual({ path: 'a/b.astro' });
  });
});

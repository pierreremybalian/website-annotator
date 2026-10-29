import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addSourceAttribute,
  astroModuleFile,
  CidCollector,
  cidManifestPlugin,
  extractScopeHash,
  sourceAttributesPlugin,
  writeManifest,
} from '../src/manifest.ts';

/** Shaped like @astrojs/compiler-rs output for a component with scoped styles. */
const compiled = (hash: string) => `import { render as $$render, createComponent as $$createComponent, renderComponent as $$renderComponent, maybeRenderHead as $$maybeRenderHead } from "astro/compiler-runtime";
const $$Hero = $$createComponent(($$result, $$props, $$slots) => {
	const { heading } = Astro.props;
	return $$render\`\${$$maybeRenderHead($$result)}<section class="hero" data-astro-cid-${hash}><h1 data-astro-cid-${hash}>\${heading}</h1>\${$$renderComponent($$result, "Child", Child, {
		"data-astro-cid-${hash}": true
	})}</section>\`;
}, "/site/src/components/Hero.astro", undefined);
export default $$Hero;`;

describe('extractScopeHash', () => {
  it('finds the component hash in compiled code', () => {
    expect(extractScopeHash(compiled('ge2uvauf'))).toBe('ge2uvauf');
  });

  it('returns null without scoped styles', () => {
    expect(extractScopeHash('return $$render`<footer>Plain</footer>`;')).toBeNull();
  });

  it('picks the most frequent hash if user text mentions another', () => {
    const code = `${compiled('ge2uvauf')}\nconst note = "see data-astro-cid-zzzzzzzz";`;
    expect(extractScopeHash(code)).toBe('ge2uvauf');
  });

  it("supports the 'class' and 'where' strategies", () => {
    const code = 'return $$render`<div class="astro-3erryfcv"><p class="lede astro-3erryfcv">hi</p></div>`;';
    expect(extractScopeHash(code, 'class')).toBe('3erryfcv');
    expect(extractScopeHash(code, 'where')).toBe('3erryfcv');
    expect(extractScopeHash('<astro-island class="astro-island">', 'class')).toBeNull();
  });
});

describe('astroModuleFile', () => {
  it('accepts .astro modules and strips queries', () => {
    expect(astroModuleFile('/site/src/components/Hero.astro')).toBe('/site/src/components/Hero.astro');
    expect(astroModuleFile('/site/src/components/Hero.astro?v=123')).toBe('/site/src/components/Hero.astro');
    expect(astroModuleFile('/@fs/site/src/components/Hero.astro')).toBe('/site/src/components/Hero.astro');
  });

  it('ignores sub-requests, virtual modules and other files', () => {
    expect(astroModuleFile('/site/src/components/Hero.astro?astro&type=style&index=0&lang.css')).toBeNull();
    expect(astroModuleFile('/site/src/components/Hero.astro?astro&type=script&index=0&lang.ts')).toBeNull();
    expect(astroModuleFile('\0astro:page')).toBeNull();
    expect(astroModuleFile('/site/src/pages/index.md')).toBeNull();
    expect(astroModuleFile('/site/src/lib/util.ts')).toBeNull();
  });
});

describe('CidCollector + plugin', () => {
  it('maps hashes to root-relative paths from fake module data', () => {
    const collector = new CidCollector('/site');
    const plugin = cidManifestPlugin(collector);
    expect(plugin).toMatchObject({ name: 'annotate:astro-cids', enforce: 'post', apply: 'build' });
    const transform = plugin.transform!;
    expect(transform(compiled('ge2uvauf'), '/site/src/components/Hero.astro')).toBeNull();
    transform(compiled('yk4hkwyg'), '/site/src/components/Card.astro');
    transform(compiled('hkbrpulz'), '/site/src/layouts/Base.astro?v=1');
    transform('return $$render`<footer>x</footer>`', '/site/src/components/Plain.astro'); // no styles
    transform('.hero[data-astro-cid-ge2uvauf]{}', '/site/src/components/Other.astro?astro&type=style&index=0&lang.css');
    transform(compiled('aaaaaaaa'), '/site/src/lib/not-astro.ts');
    transform(compiled('bbbbbbbb'), '/packages/ui/src/Button.astro'); // linked package outside the root
    transform(compiled('ge2uvauf'), '/site/src/components/Hero.astro'); // second Vite environment
    expect(collector.toJSON()).toEqual({
      bbbbbbbb: '../packages/ui/src/Button.astro',
      ge2uvauf: 'src/components/Hero.astro',
      hkbrpulz: 'src/layouts/Base.astro',
      yk4hkwyg: 'src/components/Card.astro',
    });
    expect(Object.keys(collector.toJSON())).toEqual(['bbbbbbbb', 'ge2uvauf', 'hkbrpulz', 'yk4hkwyg']);
    expect(collector.size).toBe(4);
  });
});

describe('writeManifest', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'annotate-astro-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes .annotate/astro-cids.json and a .gitignore that ignores the folder', async () => {
    const file = await writeManifest(dir, { ge2uvauf: 'src/components/Hero.astro' });
    expect(file).toBe(path.join(dir, '.annotate', 'astro-cids.json'));
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ ge2uvauf: 'src/components/Hero.astro' });
    expect(await readFile(path.join(dir, '.annotate', '.gitignore'), 'utf8')).toMatch(/^\*$/m);
  });

  it('replaces the manifest on each build and keeps an existing .gitignore', async () => {
    await mkdir(path.join(dir, '.annotate'));
    await writeFile(path.join(dir, '.annotate', '.gitignore'), 'custom\n');
    await writeManifest(dir, { aaaaaaaa: 'src/Old.astro' });
    await writeManifest(dir, { bbbbbbbb: 'src/New.astro' });
    expect(JSON.parse(await readFile(path.join(dir, '.annotate', 'astro-cids.json'), 'utf8'))).toEqual({ bbbbbbbb: 'src/New.astro' });
    expect(await readFile(path.join(dir, '.annotate', '.gitignore'), 'utf8')).toBe('custom\n');
  });
});

describe('addSourceAttribute', () => {
  const file = 'src/components/Hero.astro';

  it('tags the root element after frontmatter, comments and style blocks', () => {
    const src = `---\nconst { a } = Astro.props;\n---\n<!-- hi -->\n<style>.x{}</style>\n<section class="hero">\n  <h1>{a}</h1>\n</section>\n`;
    const out = addSourceAttribute(src, file)!;
    expect(out).toContain('<section data-annotate-source="src/components/Hero.astro" class="hero">');
    expect(out.split('\n')).toHaveLength(src.split('\n').length);
  });

  it('handles no frontmatter, empty frontmatter and self-closing roots', () => {
    expect(addSourceAttribute('<div>x</div>', file)).toBe(`<div data-annotate-source="${file}">x</div>`);
    expect(addSourceAttribute('---\n---\n<p>x</p>', file)).toBe(`---\n---\n<p data-annotate-source="${file}">x</p>`);
    expect(addSourceAttribute('<my-el/>', file)).toBe(`<my-el data-annotate-source="${file}"/>`);
  });

  it('leaves components, expressions, slots, layouts and text alone', () => {
    expect(addSourceAttribute('---\n---\n<Layout><div /></Layout>', file)).toBeNull();
    expect(addSourceAttribute('{cond && <div />}', file)).toBeNull();
    expect(addSourceAttribute('<slot />', file)).toBeNull();
    expect(addSourceAttribute('<html><body /></html>', file)).toBeNull();
    expect(addSourceAttribute('<!doctype html>\n<html lang="en"></html>', file)).toBeNull();
    expect(addSourceAttribute('Hello <b>x</b>', file)).toBeNull();
    expect(addSourceAttribute('<Fragment><p /></Fragment>', file)).toBeNull();
  });

  it("doesn't overwrite an attribute set by hand", () => {
    expect(addSourceAttribute('<div data-annotate-source="Mine">x</div>', file)).toBeNull();
  });

  it('escapes the path', () => {
    expect(addSourceAttribute('<div></div>', 'src/a"b&.astro')).toBe('<div data-annotate-source="src/a&quot;b&amp;.astro"></div>');
  });
});

describe('sourceAttributesPlugin', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'annotate-astro-'));
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await writeFile(path.join(dir, 'src', 'Card.astro'), '---\n---\n<article>x</article>\n');
    await writeFile(path.join(dir, 'src', 'Page.astro'), '<Layout />\n');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('loads project .astro files with the attribute; ignores everything else', async () => {
    const plugin = sourceAttributesPlugin(dir);
    expect(plugin).toMatchObject({ enforce: 'pre', apply: 'build' });
    const load = plugin.load!;
    expect(await load(path.join(dir, 'src', 'Card.astro'))).toBe('---\n---\n<article data-annotate-source="src/Card.astro">x</article>\n');
    expect(await load(path.join(dir, 'src', 'Page.astro'))).toBeNull();
    expect(await load(`${path.join(dir, 'src', 'Card.astro')}?astro&type=style&index=0&lang.css`)).toBeNull();
    expect(await load(path.join(dir, 'node_modules', 'x', 'Y.astro'))).toBeNull();
    expect(await load(path.join(path.dirname(dir), 'elsewhere', 'Z.astro'))).toBeNull();
  });
});

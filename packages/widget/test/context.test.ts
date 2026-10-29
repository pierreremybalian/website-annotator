import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureContext, findLandmark, findSources, resetPageContextWarning } from '../src/capture/context';

function q(selector: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(selector);
  if (!found) throw new Error(`no ${selector}`);
  return found;
}

beforeEach(() => {
  document.body.innerHTML = '';
  delete window.AnnotateContext;
  resetPageContextWarning();
});

afterEach(() => {
  delete window.AnnotateContext;
  vi.restoreAllMocks();
});

describe('element html', () => {
  it('strips script/style contents and form values, never password values', () => {
    document.body.innerHTML = `
      <form id="f">
        <script>window.secret = "tok_123";</script>
        <style>.x { color: red }</style>
        <input name="user" value="pierre@example.com">
        <input type="password" name="pw" value="hunter2">
        <input type="hidden" name="nonce" value="a1b2c3">
        <textarea name="msg">private message</textarea>
        <select name="plan"><option value="pro" selected>Pro</option><option value="free">Free</option></select>
        <button type="submit">Send</button>
      </form>`;
    const input = q('input[name="user"]') as HTMLInputElement;
    input.value = 'typed later';
    const ctx = captureContext(q('#f')).element!;
    expect(ctx.tag).toBe('form');
    for (const leaked of ['tok_123', 'color: red', 'pierre@example.com', 'hunter2', 'a1b2c3', 'private message', 'typed later', 'selected']) {
      expect(ctx.html, leaked).not.toContain(leaked);
    }
    expect(ctx.html).toContain('<script></script>');
    expect(ctx.html).toContain('<style></style>');
    expect(ctx.html).toContain('<input type="password" name="pw">');
    expect(ctx.html).toContain('<textarea name="msg"></textarea>');
    expect(ctx.html).toContain('<button type="submit">Send</button>');
    expect(ctx.text).not.toContain('secret');
  });

  it('trims html to 3000 chars and text to 200', () => {
    const p = document.createElement('p');
    p.className = 'long';
    p.textContent = 'word '.repeat(2000);
    document.body.append(p);
    const ctx = captureContext(p).element!;
    expect(ctx.html.length).toBe(3000);
    expect(ctx.html.startsWith('<p class="long">word word')).toBe(true);
    expect(ctx.text.length).toBe(200);
  });

  it('collapses whitespace in text and escapes markup characters', () => {
    document.body.innerHTML = '<h2 class="t" title="a &quot;b&quot;">  Fish   &amp;\n chips &lt;3 </h2>';
    const ctx = captureContext(q('h2')).element!;
    expect(ctx.text).toBe('Fish & chips <3');
    expect(ctx.html).toBe('<h2 class="t" title="a &quot;b&quot;"> Fish &amp; chips &lt;3 </h2>');
  });

  it('leaves out the widget host', () => {
    document.body.innerHTML = '<div id="w"><p>page</p><annotate-widget></annotate-widget></div>';
    expect(captureContext(q('#w')).element!.html).toBe('<div id="w"><p>page</p></div>');
  });

  it('returns null element context for null', () => {
    expect(captureContext(null)).toEqual({ page: null, element: null });
  });
});

describe('source hints', () => {
  beforeEach(() => {
    document.documentElement.setAttribute('data-astro-cid-root', '');
    document.body.innerHTML = `
      <main data-annotate-source="Layout">
        <section id="services" data-annotate-block="acf/services" data-astro-cid-abc123>
          <div class="card" data-annotate-source="src/components/Card.astro" data-astro-cid-abc123 data-astro-cid-def456>
            <h3 data-astro-source-file="/repo/src/components/Card.astro" data-astro-source-loc="12:5">
              <span class="label" data-astro-cid-def456>Garden design</span>
            </h3>
          </div>
        </section>
      </main>`;
  });
  afterEach(() => document.documentElement.removeAttribute('data-astro-cid-root'));

  it('collects every kind, nearest first, with depth, deduped', () => {
    expect(findSources(q('.label'))).toEqual([
      { kind: 'astro-cid', value: 'def456', depth: 0 },
      { kind: 'astro-source', value: '/repo/src/components/Card.astro', file: '/repo/src/components/Card.astro', line: 12, depth: 1 },
      { kind: 'annotate', value: 'src/components/Card.astro', file: 'src/components/Card.astro', depth: 2 },
      { kind: 'astro-cid', value: 'abc123', depth: 2 },
      { kind: 'wp-block', value: 'acf/services', depth: 3 },
      { kind: 'annotate', value: 'Layout', depth: 4 },
      { kind: 'astro-cid', value: 'root', depth: 6 },
    ]);
  });

  it('sets file only for annotate values that look like paths', () => {
    q('main').setAttribute('data-annotate-source', 'Hero.tsx');
    const hints = findSources(q('main')).filter((h) => h.kind === 'annotate');
    expect(hints).toEqual([{ kind: 'annotate', value: 'Hero.tsx', file: 'Hero.tsx', depth: 0 }]);
    q('main').setAttribute('data-annotate-source', 'HeroBanner');
    expect(findSources(q('main'))[0]).toEqual({ kind: 'annotate', value: 'HeroBanner', depth: 0 });
  });

  it('caps the list at 10', () => {
    let html = '<span id="leaf">x</span>';
    for (let i = 0; i < 15; i++) html = `<div data-annotate-block="acme/b${i}">${html}</div>`;
    document.body.innerHTML = html;
    const hints = findSources(q('#leaf'));
    expect(hints).toHaveLength(10);
    expect(hints[0]).toEqual({ kind: 'wp-block', value: 'acme/b0', depth: 1 });
    expect(hints[9]).toEqual({ kind: 'wp-block', value: 'acme/b9', depth: 10 });
  });

  it('is part of captureContext', () => {
    expect(captureContext(q('.card')).element!.sources[0]).toMatchObject({ kind: 'annotate', file: 'src/components/Card.astro', depth: 0 });
  });
});

describe('landmark', () => {
  it('prefers the closest landmark with an aria-label or id', () => {
    document.body.innerHTML = `
      <h1>Page title</h1>
      <nav aria-label="Primary"><ul><li><a id="a1" href="/">Home</a></li></ul></nav>
      <section id="services"><h2>What we do</h2><div><p id="p1">Text</p></div></section>`;
    expect(findLandmark(q('#a1'))).toBe('nav "Primary"');
    expect(findLandmark(q('#p1'))).toBe('section#services');
  });

  it('skips landmarks with neither, and accepts [role]', () => {
    document.body.innerHTML = `
      <div role="banner" aria-label="Site header"><section><p id="p1">x</p></section></div>`;
    expect(findLandmark(q('#p1'))).toBe('div "Site header"');
  });

  it('falls back to the nearest preceding heading', () => {
    document.body.innerHTML = `
      <h1>Page title</h1>
      <div>
        <h2> About   the studio </h2>
        <div><p>One</p><p id="p2">Two</p></div>
      </div>
      <h3>Later heading</h3>`;
    expect(findLandmark(q('#p2'))).toBe('About the studio');
    expect(findLandmark(q('h2'))).toBe('Page title');
  });

  it('counts an enclosing heading', () => {
    document.body.innerHTML = '<h2>Intro <span id="s">here</span></h2>';
    expect(findLandmark(q('#s'))).toBe('Intro here');
  });

  it('is null with no landmark or heading', () => {
    document.body.innerHTML = '<div><p id="p">x</p></div>';
    expect(findLandmark(q('#p'))).toBeNull();
  });
});

describe('styles', () => {
  it('captures the listed computed styles, with margin/padding/overflow as shorthands', () => {
    document.body.innerHTML =
      '<div id="d" style="display:flex; position:relative; margin:4px 8px; padding:2px; overflow-x:hidden; overflow-y:auto; color:rgb(1, 2, 3); font-size:13px">x</div>';
    const s = captureContext(q('#d')).element!.styles;
    expect(s.display).toBe('flex');
    expect(s.position).toBe('relative');
    expect(s.margin).toBe('4px 8px');
    expect(s.padding).toBe('2px');
    expect(s.overflow).toBe('hidden auto');
    expect(s['font-size']).toBe('13px');
    expect(s.color).toBe('rgb(1, 2, 3)');
    for (const key of Object.keys(s)) {
      expect([
        'display', 'position', 'width', 'height', 'margin', 'padding', 'font-size', 'font-weight', 'line-height', 'color',
        'background-color', 'overflow',
      ]).toContain(key);
    }
  });
});

describe('page context', () => {
  it('reads window.AnnotateContext as a copy', () => {
    window.AnnotateContext = { platform: 'wordpress', postId: 42, template: 'page.php', nested: { a: [1, 2] } };
    const page = captureContext(null).page;
    expect(page).toEqual({ platform: 'wordpress', postId: 42, template: 'page.php', nested: { a: [1, 2] } });
    expect(page).not.toBe(window.AnnotateContext);
  });

  it('is null (no warning) when unset', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(captureContext(null).page).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('accepts exactly 4096 bytes of JSON and rejects more, warning once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const overhead = JSON.stringify({ k: '' }).length;
    window.AnnotateContext = { k: 'x'.repeat(4096 - overhead) };
    expect(captureContext(null).page).not.toBeNull();
    window.AnnotateContext = { k: 'x'.repeat(4097 - overhead) };
    expect(captureContext(null).page).toBeNull();
    expect(captureContext(null).page).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('counts bytes, not characters', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    window.AnnotateContext = { k: 'é'.repeat(2100) }; // 2100 chars, 4200 bytes
    expect(captureContext(null).page).toBeNull();
  });

  it('rejects non-plain objects and unserializable values', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    window.AnnotateContext = new Map() as unknown as Record<string, unknown>;
    expect(captureContext(null).page).toBeNull();
    window.AnnotateContext = ['a'] as unknown as Record<string, unknown>;
    expect(captureContext(null).page).toBeNull();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    window.AnnotateContext = cyclic;
    expect(captureContext(null).page).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Rect } from '@annotate/shared';
import { createAnchor, isStableClass, isStableId, resolveAnchor } from '../src/capture/anchor';

// happy-dom has no layout engine: give each element a fake box and hit-test those boxes ourselves.
interface Placed {
  rect: Rect;
  /** Stacking order for the fake elementsFromPoint; higher is on top. */
  z: number;
}
const layout = new Map<Element, Placed>();

function place(el: Element, rect: Rect, z = 0): void {
  layout.set(el, { rect, z });
  el.getBoundingClientRect = () => {
    const r = layout.get(el)?.rect ?? { x: 0, y: 0, width: 0, height: 0 };
    return {
      x: r.x,
      y: r.y,
      left: r.x,
      top: r.y,
      width: r.width,
      height: r.height,
      right: r.x + r.width,
      bottom: r.y + r.height,
      toJSON: () => r,
    } as DOMRect;
  };
}

function move(el: Element, rect: Rect): void {
  const p = layout.get(el);
  if (!p) throw new Error('element was never placed');
  p.rect = rect;
}

function depth(el: Element): number {
  let d = 0;
  for (let cur = el.parentElement; cur; cur = cur.parentElement) d++;
  return d;
}

function fakeElementsFromPoint(x: number, y: number): Element[] {
  const hits: Element[] = [];
  for (const [el, { rect }] of layout) {
    if (!el.isConnected) continue;
    if (x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height) hits.push(el);
  }
  // Topmost first: higher z, then deeper in the tree.
  return hits.sort((a, b) => layout.get(b)!.z - layout.get(a)!.z || depth(b) - depth(a));
}

const hadNativeElementsFromPoint = typeof document.elementsFromPoint === 'function';

function el(html: string): HTMLElement {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
}

let host: HTMLElement;

beforeEach(() => {
  layout.clear();
  document.body.innerHTML = '';
  window.scrollTo(0, 0);
  document.elementsFromPoint = fakeElementsFromPoint;

  // Page skeleton: html > body > main#content > section.hero > div.card > p.lede
  place(document.documentElement, { x: 0, y: 0, width: 1024, height: 3000 });
  place(document.body, { x: 0, y: 0, width: 1024, height: 3000 });
  document.body.append(
    el(`
      <main id="content">
        <section class="hero">
          <div class="card">
            <p class="lede">Welcome to   the
              Acme  widget store, where everything is fine.</p>
            <a class="cta" href="/buy">Buy now</a>
          </div>
        </section>
      </main>`),
  );
  place(q('main'), { x: 0, y: 0, width: 1024, height: 2000 });
  place(q('section'), { x: 0, y: 100, width: 1024, height: 500 });
  place(q('.card'), { x: 100, y: 150, width: 300, height: 200 });
  place(q('.lede'), { x: 120, y: 170, width: 260, height: 40 });
  place(q('.cta'), { x: 120, y: 280, width: 100, height: 30 });

  // The widget's host, covering the whole viewport on top of everything (as the selection overlay does).
  host = document.createElement('div');
  host.id = 'annotate-host';
  host.innerHTML = '<div class="overlay"></div>';
  document.body.append(host);
  place(host, { x: 0, y: 0, width: 1024, height: 768 }, 1000);
  place(host.firstElementChild!, { x: 0, y: 0, width: 1024, height: 768 }, 1001);
});

afterEach(() => {
  if (!hadNativeElementsFromPoint) delete (document as { elementsFromPoint?: unknown }).elementsFromPoint;
  window.scrollTo(0, 0);
});

function q(selector: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(selector);
  if (!found) throw new Error(`no ${selector}`);
  return found;
}

describe('createAnchor', () => {
  it('picks the smallest ancestor that fully contains the selection', () => {
    // Center (250, 195) lands on p.lede, but the box spills past it on the left, so the card is the anchor.
    const sel = { x: 110, y: 165, width: 280, height: 60 };
    const a = createAnchor(sel, host);
    expect(a.selector).toBeTruthy();
    expect(document.querySelector(a.selector!)).toBe(q('.card'));
    expect(a.relative!.x).toBeCloseTo(10 / 300);
    expect(a.relative!.y).toBeCloseTo(15 / 200);
    expect(a.relative!.width).toBeCloseTo(280 / 300);
    expect(a.relative!.height).toBeCloseTo(60 / 200);
    expect(a.absolute).toEqual(sel);
    expect(a.viewportWidth).toBe(window.innerWidth);
    expect(a.text).toBe('Welcome to the Acme widget store, where everything is fine. Buy now');
  });

  it('allows 2px of slack, so a box drawn just around an element anchors to that element', () => {
    const a = createAnchor({ x: 119, y: 169, width: 262, height: 42 }, host);
    expect(document.querySelector(a.selector!)).toBe(q('.lede'));
  });

  it('records the document-absolute rect using the scroll offset', () => {
    window.scrollTo(0, 400);
    expect(window.scrollY).toBe(400);
    const a = createAnchor({ x: 110, y: 165, width: 280, height: 60 }, host);
    expect(a.absolute).toEqual({ x: 110, y: 565, width: 280, height: 60 });
  });

  it('falls back to html when even body does not contain the selection', () => {
    // Short body/main (e.g. everything below is absolutely positioned); the box sits below both.
    move(document.body, { x: 0, y: 0, width: 1024, height: 120 });
    move(q('main'), { x: 0, y: 0, width: 1024, height: 120 });
    const a = createAnchor({ x: 50, y: 300, width: 900, height: 400 }, host);
    expect(a.selector).toBe('html');
    expect(a.text).toBe('');
  });

  it('skips the widget host and its descendants when hit-testing', () => {
    // Host and its overlay are the top two hits at every point; the anchor must still be on the page.
    expect(fakeElementsFromPoint(150, 290)[0]).toBe(host.firstElementChild);
    const a = createAnchor({ x: 125, y: 285, width: 50, height: 20 }, host);
    expect(a.selector).not.toContain('annotate-host');
    expect(document.querySelector(a.selector!)).toBe(q('.cta'));
  });
});

describe('selector hygiene', () => {
  it('does not use generated or hashed class names in the selector', () => {
    const card = q('.card');
    card.className = 'css-1q2w3e4 sc-bdVaJa jsx-2847169 a1b2c3d4e5 md:flex w-[13px] is-layout-flex wp-container-core-group-is-layout-3';
    // A sibling with the same tag so a bare `div` wouldn't be unique either.
    const sibling = el('<div class="css-9z8y7x6"></div>');
    q('section').append(sibling);
    place(sibling, { x: 500, y: 150, width: 300, height: 200 });

    const a = createAnchor({ x: 110, y: 165, width: 280, height: 60 }, host);
    expect(document.querySelector(a.selector!)).toBe(card);
    for (const bad of ['css-', 'sc-', 'jsx-', 'a1b2c3', 'md', '13px', 'is-layout', 'wp-container']) {
      expect(a.selector).not.toContain(bad);
    }
  });

  it('does not use ids with long digit runs', () => {
    q('.card').id = 'post-12345';
    const a = createAnchor({ x: 110, y: 165, width: 280, height: 60 }, host);
    expect(a.selector).not.toContain('post-12345');
    expect(document.querySelector(a.selector!)).toBe(q('.card'));
  });

  it('classifies class names and ids', () => {
    for (const ok of ['card', 'hero__title', 'site-header', 'wp-block-group', 'btn-primary', 'col-md-6', 'menu-item', 'card__item2']) {
      expect(isStableClass(ok), ok).toBe(true);
    }
    for (const bad of [
      'css-1q2w3e4',
      'sc-bdVaJa',
      'jsx-2847169',
      'emotion-0',
      'svelte-1ab2cd',
      'Button_primary__3xYz1',
      'a1b2c3d4',
      'md:flex',
      'w-[13px]',
      'w-1/2',
      'is-active',
      'has-text-color',
      'wp-container-core-group-is-layout-1',
      'wp-elements-6f7a1b',
      'active',
    ]) {
      expect(isStableClass(bad), bad).toBe(false);
    }
    expect(isStableId('content')).toBe(true);
    expect(isStableId('site-header')).toBe(true);
    expect(isStableId('post-123')).toBe(false);
    expect(isStableId('ember512')).toBe(false);
    expect(isStableId(':r1:')).toBe(false);
  });
});

describe('resolveAnchor', () => {
  it('maps the relative fractions onto the element after it moves', () => {
    const a = createAnchor({ x: 110, y: 165, width: 280, height: 60 }, host);
    // Responsive layout: the card is now elsewhere and twice the size.
    move(q('.card'), { x: 500, y: 800, width: 600, height: 400 });
    const r = resolveAnchor(a);
    expect(r.detached).toBe(false);
    expect(r.rect.x).toBeCloseTo(500 + (10 / 300) * 600);
    expect(r.rect.y).toBeCloseTo(800 + (15 / 200) * 400);
    expect(r.rect.width).toBeCloseTo(560);
    expect(r.rect.height).toBeCloseTo(120);
  });

  it('falls back to the absolute rect, detached, when the element is gone', () => {
    const a = createAnchor({ x: 110, y: 165, width: 280, height: 60 }, host);
    q('.card').remove();
    window.scrollTo(0, 100);
    const r = resolveAnchor(a);
    expect(r.detached).toBe(true);
    expect(r.rect).toEqual({ x: 110, y: 65, width: 280, height: 60 });
  });

  it('falls back, detached, when the text no longer matches', () => {
    const a = createAnchor({ x: 110, y: 165, width: 280, height: 60 }, host);
    q('.lede').textContent = 'Something completely different now.';
    q('.cta').textContent = 'Sign up';
    const r = resolveAnchor(a);
    expect(r.detached).toBe(true);
    expect(r.rect).toEqual({ x: 110, y: 165, width: 280, height: 60 });
  });

  it('still matches when only the tail of the text changed', () => {
    const a = createAnchor({ x: 110, y: 165, width: 280, height: 60 }, host);
    q('.cta').textContent = 'Buy later';
    expect(resolveAnchor(a).detached).toBe(false);
  });

  it('falls back when the element has no size (hidden)', () => {
    const a = createAnchor({ x: 110, y: 165, width: 280, height: 60 }, host);
    move(q('.card'), { x: 0, y: 0, width: 0, height: 0 });
    expect(resolveAnchor(a).detached).toBe(true);
  });

  it('survives an invalid stored selector', () => {
    const a = createAnchor({ x: 110, y: 165, width: 280, height: 60 }, host);
    const r = resolveAnchor({ ...a, selector: 'div[' });
    expect(r.detached).toBe(true);
    expect(r.rect).toEqual(a.absolute);
  });
});

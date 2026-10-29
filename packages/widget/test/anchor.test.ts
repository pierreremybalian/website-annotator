import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Rect } from '@annotate/shared';
import type { Anchor } from '@annotate/shared';
import {
  createAnchor,
  createElementAnchor,
  isStableClass,
  isStableId,
  matchAnchor,
  rectForAnchor,
  resolveAnchor,
} from '../src/capture/anchor';
import { childToward, describeElement, pageElementAt, parentTarget, smartTarget, snapTarget } from '../src/ui/Selector';

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
    expect(a.mode).toBe('area');
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

  it('reports hidden (not detached) when the element has no size', () => {
    const a = createAnchor({ x: 110, y: 165, width: 280, height: 60 }, host);
    move(q('.card'), { x: 0, y: 0, width: 0, height: 0 });
    const r = resolveAnchor(a);
    expect(r.hidden).toBe(true);
    expect(r.detached).toBe(false);
  });

  it('is neither hidden nor detached when the element is found and visible', () => {
    const r = resolveAnchor(createAnchor({ x: 110, y: 165, width: 280, height: 60 }, host));
    expect(r).toMatchObject({ detached: false, hidden: false });
  });

  it('survives an invalid stored selector', () => {
    const a = createAnchor({ x: 110, y: 165, width: 280, height: 60 }, host);
    const r = resolveAnchor({ ...a, selector: 'div[' });
    expect(r.detached).toBe(true);
    expect(r.rect).toEqual(a.absolute);
  });
});

describe('createElementAnchor', () => {
  it('anchors to exactly the element: mode element, relative 0,0,1,1, absolute = rect + scroll', () => {
    window.scrollTo(0, 250);
    const a = createElementAnchor(q('.card'));
    expect(a.mode).toBe('element');
    expect(document.querySelector(a.selector!)).toBe(q('.card'));
    expect(a.relative).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(a.absolute).toEqual({ x: 100, y: 400, width: 300, height: 200 });
    expect(a.viewportWidth).toBe(window.innerWidth);
    expect(a.text).toBe('Welcome to the Acme widget store, where everything is fine. Buy now');
  });

  it('uses the same selector hygiene as area anchors', () => {
    const card = q('.card');
    card.className = 'card css-1q2w3e4 is-active';
    q('section').append(el('<div class="card other"></div>'));
    const a = createElementAnchor(card);
    expect(document.querySelector(a.selector!)).toBe(card);
    expect(a.selector).not.toContain('css-');
    expect(a.selector).not.toContain('is-active');
  });

  it('records no text for body', () => {
    const a = createElementAnchor(document.body);
    expect(a.selector).toBe('body');
    expect(a.text).toBe('');
  });
});

describe('resolveAnchor, element mode', () => {
  it("returns the element's current rect exactly after it moves and resizes", () => {
    const a = createElementAnchor(q('.lede'));
    move(q('.lede'), { x: 33.5, y: 900.25, width: 701, height: 87 });
    expect(resolveAnchor(a)).toEqual({ rect: { x: 33.5, y: 900.25, width: 701, height: 87 }, detached: false, hidden: false });
  });

  it('is hidden when the element exists but has no box at this size', () => {
    const a = createElementAnchor(q('.cta'));
    move(q('.cta'), { x: 0, y: 0, width: 0, height: 0 });
    const r = resolveAnchor(a);
    expect(r.hidden).toBe(true);
    expect(r.detached).toBe(false);
  });

  it('is hidden when the element is visibility:hidden', () => {
    const a = createElementAnchor(q('.cta'));
    q('.cta').style.visibility = 'hidden';
    expect(resolveAnchor(a).hidden).toBe(true);
  });

  it('is detached, not hidden, when the text changed, even if the element is also hidden', () => {
    const a = createElementAnchor(q('.lede'));
    q('.lede').textContent = 'Totally new copy';
    move(q('.lede'), { x: 0, y: 0, width: 0, height: 0 });
    const r = resolveAnchor(a);
    expect(r).toMatchObject({ detached: true, hidden: false });
    expect(r.rect).toEqual({ x: 120, y: 170, width: 260, height: 40 });
  });

  it('is detached when the element is gone', () => {
    const a = createElementAnchor(q('.cta'));
    q('.cta').remove();
    window.scrollTo(0, 50);
    expect(resolveAnchor(a)).toEqual({ rect: { x: 120, y: 230, width: 100, height: 30 }, detached: true, hidden: false });
  });

  it('matchAnchor + rectForAnchor agree with resolveAnchor', () => {
    const a = createElementAnchor(q('.card'));
    const found = matchAnchor(a);
    expect(found).toBe(q('.card'));
    expect(rectForAnchor(a, found)).toEqual(resolveAnchor(a));
    expect(rectForAnchor(a, null)).toMatchObject({ detached: true, hidden: false });
  });
});

describe('pre-0.2 anchors (no mode)', () => {
  it('resolve as area anchors: fractions of the element', () => {
    const legacy: Anchor = {
      selector: 'main > section > div',
      relative: { x: 0.1, y: 0.25, width: 0.5, height: 0.5 },
      absolute: { x: 130, y: 200, width: 150, height: 100 },
      viewportWidth: 1440,
      text: 'Welcome to the Acme',
    };
    expect(legacy.mode).toBeUndefined();
    move(q('.card'), { x: 0, y: 0, width: 400, height: 400 });
    expect(resolveAnchor(legacy)).toEqual({ rect: { x: 40, y: 100, width: 200, height: 200 }, detached: false, hidden: false });
  });

  it('still fall back to the absolute rect when the selector is null', () => {
    const legacy: Anchor = {
      selector: null,
      relative: null,
      absolute: { x: 10, y: 20, width: 30, height: 40 },
      viewportWidth: 1440,
      text: '',
    };
    expect(resolveAnchor(legacy)).toEqual({ rect: { x: 10, y: 20, width: 30, height: 40 }, detached: true, hidden: false });
  });
});

describe('picking helpers (Selector)', () => {
  it('smart target skips tiny and inline-only elements, but not links', () => {
    // happy-dom has no UA stylesheet for inline elements, so say it explicitly.
    q('.lede').innerHTML = 'Welcome <span class="w" style="display:inline">to</span> the <em class="icon">*</em> store';
    place(q('.w'), { x: 190, y: 172, width: 20, height: 20 });
    place(q('.icon'), { x: 230, y: 175, width: 10, height: 10 });
    expect(smartTarget(q('.w'))).toBe(q('.lede')); // display:inline span
    expect(smartTarget(q('.icon'))).toBe(q('.lede')); // under 16×16
    expect(smartTarget(q('.cta'))).toBe(q('.cta')); // <a> is fine inline
    expect(smartTarget(q('.lede'))).toBe(q('.lede'));
  });

  it('elementAt skips the widget host; parent/child walk the tree', () => {
    expect(pageElementAt(150, 290, host)).toBe(q('.cta'));
    expect(parentTarget(q('.cta'))).toBe(q('.card'));
    expect(parentTarget(document.body)).toBe(document.body);
    expect(childToward(q('section'), q('.cta'))).toBe(q('.card'));
    expect(childToward(q('.card'), q('.cta'))).toBe(q('.cta'));
    expect(childToward(q('.cta'), q('.cta'))).toBeNull();
  });

  it('snaps a drawn box to an element it covers ≥80% when the element is ≤1.25× the box', () => {
    // .card is 300×200 at (100,150). A box just inside it covers 90%+ of it.
    expect(snapTarget({ x: 105, y: 155, width: 290, height: 190 }, host)).toBe(q('.card'));
    // A box a bit bigger than the card still snaps (card area ≤ 1.25× box, fully covered).
    expect(snapTarget({ x: 95, y: 145, width: 310, height: 210 }, host)).toBe(q('.card'));
  });

  it('does not snap a free area', () => {
    // Half of the card: covers only 50% of it.
    expect(snapTarget({ x: 100, y: 150, width: 150, height: 200 }, host)).toBeNull();
    // Empty space in the section, much smaller than the section.
    expect(snapTarget({ x: 600, y: 200, width: 200, height: 150 }, host)).toBeNull();
  });

  it('describes elements briefly', () => {
    expect(describeElement(q('.card'))).toBe('div.card');
    expect(describeElement(q('main'))).toBe('main#content');
  });
});

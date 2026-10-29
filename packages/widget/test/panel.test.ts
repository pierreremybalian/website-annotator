import { afterEach, expect, it, vi } from 'vitest';
import { h, render } from 'preact';
import { Pins } from '../src/ui/Pins';
import type { Anchor, IssueDetail, IssueSummary } from '@annotate/shared';
import type { PinsProps, WidgetApi } from '../src/types';

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

type Box = { x: number; y: number; w: number; h: number };
const domRect = ({ x, y, w, h }: Box) =>
  ({ x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, toJSON() {} }) as DOMRect;

const elementAnchor = (selector: string, text: string, viewportWidth = 1280): Anchor => ({
  mode: 'element', selector, relative: { x: 0, y: 0, width: 1, height: 1 }, absolute: { x: 10, y: 10, width: 100, height: 40 }, viewportWidth, text,
});

function summary(id: string, number: number, anchor: Anchor, over: Partial<IssueSummary> = {}): IssueSummary {
  return {
    id, number, title: `Issue ${number}`, status: 'new', anchor, reporterName: 'Ann', createdAt: new Date(Date.now() - 3 * 3600e3).toISOString(),
    screenshotUrl: `https://x/${id}.png`, shortUrl: 'https://trello.com/c/x', ...over,
  };
}

function fakeApi(list: IssueSummary[]) {
  return {
    createIssue: vi.fn(),
    listIssues: vi.fn(async () => list),
    getIssue: vi.fn(async (id: string): Promise<IssueDetail> => ({ ...list.find((i) => i.id === id)!, notes: '', contextUrl: '', env: {} as IssueDetail['env'], comments: [] })),
    addComment: vi.fn(),
    confirmIssue: vi.fn(),
    reopenIssue: vi.fn(),
  } satisfies WidgetApi;
}

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

function mount(api: WidgetApi, over: Partial<PinsProps> = {}) {
  const hostEl = document.createElement('div');
  document.documentElement.append(hostEl);
  const root = hostEl.attachShadow({ mode: 'open' });
  const mountEl = document.createElement('div');
  mountEl.className = 'annotate-root';
  root.append(mountEl);
  const onPanelOpenChange = vi.fn();
  let props: PinsProps = {
    api, pageUrl: 'https://site/', reporter: null, onReporterChange: vi.fn(), showResolved: false, refreshKey: 0, openIssueId: null,
    showPins: true, panelOpen: true, onPanelOpenChange, ...over,
  };
  const rerender = (next: Partial<PinsProps>) => {
    props = { ...props, ...next };
    render(h(Pins, props), mountEl);
  };
  rerender({});
  cleanup = () => {
    render(null, mountEl);
    hostEl.remove();
  };
  return { root, rerender, onPanelOpenChange };
}

/** A page with a visible element, one hidden at this size, and one whose element is gone. */
function page() {
  document.body.innerHTML = '<div class="hero">Hero text</div><nav class="mobile-nav">Menu</nav><footer class="far">Footer</footer>';
  const hero = document.querySelector('.hero')!;
  hero.getBoundingClientRect = () => domRect({ x: 40, y: 120, w: 400, h: 200 });
  // display:none at this width: no client rects, zero size.
  document.querySelector('.mobile-nav')!.getBoundingClientRect = () => domRect({ x: 0, y: 0, w: 0, h: 0 });
  const far = document.querySelector('.far')!;
  far.getBoundingClientRect = () => domRect({ x: 40, y: 2400, w: 600, h: 300 });
  const issues = [
    summary('v1', 1, elementAnchor('.hero', 'Hero text'), { status: 'in_progress' }),
    summary('h1', 2, elementAnchor('.mobile-nav', 'Menu', 390), { title: 'Menu overlaps logo' }),
    summary('d1', 3, { ...elementAnchor('.gone', 'Gone') }, { status: 'review' }),
    summary('f1', 4, elementAnchor('.far', 'Footer')),
  ];
  return { hero, far, issues };
}

const rows = (root: ShadowRoot) => [...root.querySelectorAll<HTMLButtonElement>('.an-panel-row')];
const pinNumbers = (root: ShadowRoot) => [...root.querySelectorAll('.an-pin')].map((p) => p.textContent);

it('lists every issue; hidden ones get no pin but show the reported width', async () => {
  const { issues } = page();
  const api = fakeApi(issues);
  const { root } = mount(api);
  await tick();
  // Pins: the visible hero and the detached one (at its old spot); not the hidden one; the footer is off-screen.
  expect(pinNumbers(root)).toEqual(['1', '3']);
  const panel = root.querySelector('.an-panel-drawer')!;
  expect(panel.querySelector('.an-panel-heading')!.textContent).toBe('Issues on this page');
  expect(panel.querySelector('.an-panel-count')!.textContent).toBe('4');
  const r = rows(root);
  expect(r.map((row) => row.querySelector('.an-panel-title')!.textContent)).toEqual([
    '#1 Issue 1', '#2 Menu overlaps logo', '#3 Issue 3', '#4 Issue 4',
  ]);
  expect(r[0]!.querySelector('.an-panel-badge')!.textContent).toBe('In progress');
  expect(r[0]!.querySelector('.an-panel-who')!.textContent).toBe('Ann · 3h ago');
  expect(r[0]!.querySelector('img')!.getAttribute('src')).toBe('https://x/v1.png');
  expect(r[0]!.querySelector('.an-panel-flag')).toBeFalsy();
  expect(r[1]!.querySelector('.an-panel-flag')!.textContent).toBe('Not visible at this screen size, reported at 390px');
  expect(r[2]!.querySelector('.an-panel-flag')!.textContent).toBe('Position may have moved');
  expect(r[2]!.querySelector('.an-panel-badge')!.textContent).toBe('Ready for review');
  expect(r[3]!.querySelector('.an-panel-flag')).toBeFalsy();
  // One fetch serves both pins and panel.
  expect(api.listIssues).toHaveBeenCalledTimes(1);
});

it('hidden and detached issues open the popover next to the panel', async () => {
  const { issues } = page();
  const { root } = mount(fakeApi(issues));
  await tick();
  rows(root)[1]!.click();
  await tick();
  const pop = root.querySelector<HTMLElement>('.an-pop')!;
  expect(pop.textContent).toContain('#2');
  expect(pop.textContent).toContain('Not visible at this screen size, reported at 390px');
  // happy-dom: 1024px viewport, the 360px drawer starts at 664 → popover 340px wide, 8px gap, to its left.
  expect(pop.style.left).toBe(`${664 - 8 - 340}px`);
  expect(rows(root)[1]!.className).toContain('an-panel-row--open');
  // Clicking another row switches (rows don't count as outside clicks).
  rows(root)[2]!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
  rows(root)[2]!.click();
  await tick();
  expect(root.querySelector('.an-pop')!.textContent).toContain('#3');
  expect(root.querySelector('.an-pop')!.textContent).toContain('Position may have moved');
  expect(root.querySelector<HTMLElement>('.an-pop')!.style.left).toBe(`${664 - 8 - 340}px`);
});

it('a visible issue opens its pin popover; an off-screen one scrolls into view first', async () => {
  const { far, issues } = page();
  const { root } = mount(fakeApi(issues));
  await tick();
  rows(root)[0]!.click();
  await tick();
  let pop = root.querySelector<HTMLElement>('.an-pop')!;
  expect(pop.textContent).toContain('#1');
  // Beside the pin (inside the hero's top-left corner at 44,124): 44 + 26 + 8.
  expect(pop.style.left).toBe(`${44 + 26 + 8}px`);
  expect(root.querySelector('.an-pin--open')!.textContent).toBe('1');

  const scrollIntoView = vi.fn();
  far.scrollIntoView = scrollIntoView;
  rows(root)[3]!.click();
  await tick();
  expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center', inline: 'nearest' });
  expect(root.querySelector('.an-pop')).toBeFalsy();
  // The target is outlined as soon as the scroll brings it on screen; the popover waits for the scroll to settle.
  far.getBoundingClientRect = () => domRect({ x: 40, y: 234, w: 600, h: 300 });
  window.dispatchEvent(new Event('scroll'));
  await tick(50);
  expect(root.querySelector<HTMLElement>('.an-hl')!.style.top).toBe('234px');
  expect(root.querySelector('.an-pop')).toBeFalsy();
  await tick(300);
  pop = root.querySelector<HTMLElement>('.an-pop')!;
  expect(pop.textContent).toContain('#4');
  expect(pinNumbers(root)).toContain('4');
  expect(pop.style.left).toBe(`${44 + 26 + 8}px`);
});

it('showPins=false: no pins, the panel still lists and opens issues', async () => {
  const { issues } = page();
  const api = fakeApi(issues);
  const { root, rerender } = mount(api, { showPins: false, panelOpen: false });
  await tick();
  // Nothing to show and nothing fetched.
  expect(root.querySelector('.an-pins')).toBeFalsy();
  expect(api.listIssues).not.toHaveBeenCalled();
  rerender({ panelOpen: true });
  await tick();
  expect(api.listIssues).toHaveBeenCalledTimes(1);
  expect(root.querySelectorAll('.an-pin')).toHaveLength(0);
  expect(rows(root)).toHaveLength(4);
  rows(root)[0]!.dispatchEvent(new MouseEvent('mouseenter'));
  await tick();
  expect(root.querySelector<HTMLElement>('.an-hl')!.style.width).toBe('400px');
  rows(root)[0]!.click();
  await tick();
  // No pin to sit beside: next to the panel.
  const pop = root.querySelector<HTMLElement>('.an-pop')!;
  expect(pop.textContent).toContain('#1');
  expect(pop.style.left).toBe(`${664 - 8 - 340}px`);
  expect(root.querySelectorAll('.an-pin')).toHaveLength(0);
});

it('Esc closes the popover first, then the panel; the close button closes it too', async () => {
  const { issues } = page();
  const { root, onPanelOpenChange } = mount(fakeApi(issues));
  await tick();
  rows(root)[1]!.click();
  await tick();
  expect(root.querySelector('.an-pop')).toBeTruthy();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  await tick();
  expect(root.querySelector('.an-pop')).toBeFalsy();
  expect(onPanelOpenChange).not.toHaveBeenCalled();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  await tick();
  expect(onPanelOpenChange).toHaveBeenCalledWith(false);
  onPanelOpenChange.mockClear();
  root.querySelector<HTMLButtonElement>('.an-panel-close')!.click();
  expect(onPanelOpenChange).toHaveBeenCalledWith(false);
});

it('empty, loading and error states', async () => {
  document.body.innerHTML = '';
  const api = fakeApi([]);
  let release!: (list: IssueSummary[]) => void;
  api.listIssues.mockImplementationOnce(() => new Promise<IssueSummary[]>((r) => (release = r)));
  const { root, rerender } = mount(api);
  await tick();
  expect(root.querySelector('.an-panel-body')!.textContent).toContain('Loading issues…');
  expect(root.querySelector('.an-panel-count')).toBeFalsy();
  release([]);
  await tick();
  expect(root.querySelector('.an-panel-empty')!.textContent).toBe('No open issues on this page');
  expect(root.querySelector('.an-panel-count')!.textContent).toBe('0');

  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  api.listIssues.mockRejectedValueOnce(new Error('boom'));
  rerender({ refreshKey: 1 });
  await tick();
  expect(root.querySelector('.an-panel-error')!.textContent).toContain("Couldn't load this page's issues.");
  const [hero] = [summary('v1', 1, elementAnchor('.x', ''))];
  api.listIssues.mockResolvedValueOnce([hero!]);
  root.querySelector<HTMLButtonElement>('.an-panel-error button')!.click();
  await tick();
  expect(root.querySelector('.an-panel-error')).toBeFalsy();
  expect(rows(root)).toHaveLength(1);
  warn.mockRestore();
});

it('narrow screens: a visible issue closes the sheet to make room; a hidden one opens over it', async () => {
  const hd = (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM;
  hd.setViewport({ width: 390, height: 844 });
  try {
    const { issues } = page();
    const { root, rerender, onPanelOpenChange } = mount(fakeApi(issues));
    await tick();
    rows(root)[1]!.click();
    await tick();
    expect(onPanelOpenChange).not.toHaveBeenCalled();
    // Over the sheet, at the top of the screen, centered: (390 - 340) / 2.
    expect([root.querySelector<HTMLElement>('.an-pop')!.style.left, root.querySelector<HTMLElement>('.an-pop')!.style.top]).toEqual(['25px', '8px']);
    rows(root)[0]!.click();
    await tick();
    expect(onPanelOpenChange).toHaveBeenCalledWith(false);
    rerender({ panelOpen: false });
    await tick();
    expect(root.querySelector('.an-panel-drawer')).toBeFalsy();
    expect(root.querySelector('.an-pop')!.textContent).toContain('#1');
    expect(root.querySelector('.an-pin--open')!.textContent).toBe('1');
  } finally {
    hd.setViewport({ width: 1024, height: 768 });
  }
});

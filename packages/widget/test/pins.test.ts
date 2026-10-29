import { expect, it, vi } from 'vitest';
import { h, render } from 'preact';
import { Pins } from '../src/ui/Pins';
import type { IssueDetail, IssueSummary } from '@annotate/shared';
import type { WidgetApi } from '../src/types';

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

it('renders pins, opens popover, posts a comment', async () => {
  document.body.innerHTML = '<div class="card">Hello card text</div>';
  const card = document.querySelector('.card')!;
  card.getBoundingClientRect = () => ({ x: 100, y: 200, left: 100, top: 200, width: 300, height: 100, right: 400, bottom: 300, toJSON() {} }) as DOMRect;
  const issue: IssueSummary = {
    id: 'i1', number: 7, title: 'Broken button', status: 'in_progress', reporterName: 'Ann', createdAt: new Date(Date.now() - 3600e3).toISOString(),
    screenshotUrl: 'https://x/s.png', shortUrl: 'https://trello.com/c/abc',
    anchor: { selector: '.card', relative: { x: 0.1, y: 0.2, width: 0.5, height: 0.5 }, absolute: { x: 1, y: 2, width: 3, height: 4 }, viewportWidth: 1024, text: 'Hello card text' },
  };
  const missing: IssueSummary = { ...issue, id: 'i2', number: 8, status: 'new', anchor: { ...issue.anchor, selector: '.gone' } };
  const detail: IssueDetail = { ...issue, notes: 'It does not work', contextUrl: 'https://x/c.jpg', env: {} as IssueDetail['env'],
    comments: [{ id: 'c2', author: 'Bob', text: 'second', createdAt: '2026-10-02T00:00:00Z', viaWidget: false }, { id: 'c1', author: 'Ann', text: 'first', createdAt: '2026-10-01T00:00:00Z', viaWidget: true }] };
  const api: WidgetApi = {
    createIssue: vi.fn(),
    listIssues: vi.fn(async () => [issue, missing]),
    getIssue: vi.fn(async () => detail),
    addComment: vi.fn(async (_id, text, r) => ({ id: 'c3', author: r.name, text, createdAt: new Date().toISOString(), viaWidget: true })),
    confirmIssue: vi.fn(async (id) => ({ ...issue, id, status: 'resolved' as const })),
    reopenIssue: vi.fn(async (id) => ({ ...issue, id, status: 'new' as const })),
  };
  const onReporterChange = vi.fn();
  const v02 = { showPins: true, panelOpen: false, onPanelOpenChange: vi.fn() };
  const hostEl = document.createElement('div');
  document.documentElement.append(hostEl);
  const root = hostEl.attachShadow({ mode: 'open' });
  const mountEl = document.createElement('div');
  mountEl.className = 'annotate-root';
  root.append(mountEl);
  render(h(Pins, { api, pageUrl: 'https://site/', reporter: null, onReporterChange, showResolved: false, refreshKey: 0, openIssueId: null, ...v02 }), mountEl);
  await tick();
  const pins = [...root.querySelectorAll<HTMLButtonElement>('.an-pin')];
  expect(pins.map((p) => p.textContent)).toEqual(['7', '8']);
  expect(pins[0]!.className).not.toContain('detached');
  expect(pins[1]!.className).toContain('an-pin--detached');
  expect(pins[0]!.style.left).toBe(`${100 + 30 - 26 + 5}px`);
  expect(pins[0]!.style.top).toBe(`${200 + 20 - 26 + 5}px`);
  pins[0]!.dispatchEvent(new MouseEvent('mouseenter'));
  await tick();
  expect(root.querySelector('.an-hl')).toBeTruthy();
  pins[0]!.click();
  await tick();
  const pop = root.querySelector('.an-pop')!;
  expect(pop).toBeTruthy();
  expect(pop.textContent).toContain('#7');
  expect(pop.textContent).toContain('In progress');
  expect(pop.textContent).toContain('It does not work');
  const authors = [...pop.querySelectorAll('.an-pop-comment-author')].map((n) => n.textContent);
  expect(authors).toEqual(['Ann', 'Bob']);
  // reply without reporter → requires name + email
  const ta = pop.querySelector('textarea')!;
  ta.value = 'my reply'; ta.dispatchEvent(new Event('input'));
  await tick();
  pop.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
  await tick();
  expect(pop.textContent).toContain('Add your name');
  const [nameIn, emailIn] = [...pop.querySelectorAll('input')];
  nameIn!.value = 'Zed'; nameIn!.dispatchEvent(new Event('input'));
  emailIn!.value = 'zed@example.com'; emailIn!.dispatchEvent(new Event('input'));
  await tick();
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
  await tick();
  expect(onReporterChange).toHaveBeenCalledWith({ name: 'Zed', email: 'zed@example.com' });
  expect(api.addComment).toHaveBeenCalledWith('i1', 'my reply', { name: 'Zed', email: 'zed@example.com' });
  expect([...pop.querySelectorAll('.an-pop-comment-author')].map((n) => n.textContent)).toEqual(['Ann', 'Bob', 'Zed']);
  expect(pop.querySelector('a')!.getAttribute('href')).toBe('https://trello.com/c/abc');
  // lightbox
  (pop.querySelector('.an-pop-thumb') as HTMLButtonElement).click();
  await tick();
  expect(root.querySelector('.an-pop-lightbox')).toBeTruthy();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  await tick();
  expect(root.querySelector('.an-pop-lightbox')).toBeFalsy();
  expect(root.querySelector('.an-pop')).toBeTruthy();
  // outside click closes
  document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
  await tick();
  expect(root.querySelector('.an-pop')).toBeFalsy();
  // pin moves on scroll after layout change
  card.getBoundingClientRect = () => ({ x: 100, y: 50, left: 100, top: 50, width: 300, height: 100, right: 400, bottom: 150, toJSON() {} }) as DOMRect;
  window.dispatchEvent(new Event('scroll'));
  await tick(50);
  expect(root.querySelector<HTMLElement>('.an-pin')!.style.top).toBe(`${50 + 20 - 26 + 5}px`);
  // empty list renders nothing
  (api.listIssues as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
  render(h(Pins, { api, pageUrl: 'https://site/', reporter: null, onReporterChange, showResolved: false, refreshKey: 1, openIssueId: null, ...v02 }), mountEl);
  await tick();
  expect(mountEl.innerHTML).toBe('');
  // openIssueId opens once loaded; list error warns once
  render(h(Pins, { api, pageUrl: 'https://site/', reporter: { name: 'A', email: 'a@b.co' }, onReporterChange, showResolved: false, refreshKey: 2, openIssueId: 'i2', ...v02 }), mountEl);
  await tick();
  expect(root.querySelector('.an-pop')!.textContent).toContain('Position may have moved');
  expect(root.querySelector('.an-pop-reply-who')).toBeFalsy();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  (api.listIssues as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
  render(h(Pins, { api, pageUrl: 'https://site/', reporter: null, onReporterChange, showResolved: false, refreshKey: 3, openIssueId: 'i2', ...v02 }), mountEl);
  await tick();
  render(h(Pins, { api, pageUrl: 'https://site/', reporter: null, onReporterChange, showResolved: false, refreshKey: 4, openIssueId: 'i2', ...v02 }), mountEl);
  await tick();
  expect(warn).toHaveBeenCalledTimes(1);
  render(null, mountEl);
});

// ---------------------------------------------------------------------------
// 0.2

type Box = { x: number; y: number; w: number; h: number };
const domRect = ({ x, y, w, h }: Box) =>
  ({ x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, toJSON() {} }) as DOMRect;

function summary(over: Partial<IssueSummary> & Pick<IssueSummary, 'id' | 'number'>): IssueSummary {
  return {
    title: `Issue ${over.number}`, status: 'new', reporterName: 'Ann', createdAt: new Date(Date.now() - 7200e3).toISOString(),
    screenshotUrl: 'https://x/s.png', shortUrl: 'https://trello.com/c/x',
    anchor: { selector: '.box', relative: { x: 0, y: 0, width: 1, height: 1 }, absolute: { x: 0, y: 0, width: 10, height: 10 }, viewportWidth: 1280, text: '' },
    ...over,
  };
}

function fakeApi(list: IssueSummary[], comments: IssueDetail['comments'] = []) {
  const statuses = new Map(list.map((i) => [i.id, i.status]));
  const find = (id: string) => ({ ...list.find((i) => i.id === id)!, status: statuses.get(id)! });
  const api = {
    createIssue: vi.fn(),
    listIssues: vi.fn(async () => list.map((i) => find(i.id))),
    getIssue: vi.fn(async (id: string): Promise<IssueDetail> => ({ ...find(id), notes: 'Notes', contextUrl: 'https://x/c.jpg', env: {} as IssueDetail['env'], comments })),
    addComment: vi.fn(),
    confirmIssue: vi.fn(async (id: string) => {
      statuses.set(id, 'resolved');
      return find(id);
    }),
    reopenIssue: vi.fn(async (id: string) => {
      statuses.set(id, 'new');
      return find(id);
    }),
  } satisfies WidgetApi;
  return api;
}

function mount() {
  const hostEl = document.createElement('div');
  document.documentElement.append(hostEl);
  const root = hostEl.attachShadow({ mode: 'open' });
  const mountEl = document.createElement('div');
  mountEl.className = 'annotate-root';
  root.append(mountEl);
  return { root, mountEl, unmount: () => { render(null, mountEl); hostEl.remove(); } };
}

const base = { pageUrl: 'https://site/', onReporterChange: vi.fn(), showResolved: false, refreshKey: 0, openIssueId: null, showPins: true, panelOpen: false, onPanelOpenChange: vi.fn() };

const input = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  el.value = value;
  el.dispatchEvent(new Event('input'));
};
const button = (root: ParentNode, text: string) =>
  [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text);

it('element-mode pin sits inside the element and its outline follows the live rect', async () => {
  document.body.innerHTML = '<button class="cta">Book a call</button>';
  const el = document.querySelector('.cta')!;
  let box: Box = { x: 50, y: 60, w: 200, h: 40 };
  el.getBoundingClientRect = () => domRect(box);
  const issue = summary({
    id: 'e1', number: 3,
    anchor: { mode: 'element', selector: '.cta', relative: { x: 0, y: 0, width: 1, height: 1 }, absolute: { x: 50, y: 60, width: 200, height: 40 }, viewportWidth: 1440, text: 'Book a call' },
  });
  const { root, mountEl, unmount } = mount();
  render(h(Pins, { ...base, api: fakeApi([issue]), reporter: null }), mountEl);
  await tick();
  const pin = root.querySelector<HTMLElement>('.an-pin')!;
  expect(pin.className).toContain('an-pin--el');
  expect(pin.className).not.toContain('detached');
  expect([pin.style.left, pin.style.top]).toEqual(['54px', '64px']);
  pin.dispatchEvent(new MouseEvent('mouseenter'));
  await tick();
  const hl = () => root.querySelector<HTMLElement>('.an-hl')!;
  expect([hl().style.left, hl().style.top, hl().style.width, hl().style.height]).toEqual(['50px', '60px', '200px', '40px']);

  // The element reflows (e.g. the window got narrower): pin and outline follow it exactly.
  box = { x: 80, y: 300, w: 320, h: 64 };
  window.dispatchEvent(new Event('resize'));
  await tick(50);
  expect([pin.style.left, pin.style.top]).toEqual(['84px', '304px']);
  expect([hl().style.left, hl().style.top, hl().style.width, hl().style.height]).toEqual(['80px', '300px', '320px', '64px']);

  // A tall element scrolled past its top keeps its pin on screen, inside the element.
  box = { x: 80, y: -500, w: 320, h: 900 };
  window.dispatchEvent(new Event('scroll'));
  await tick(50);
  expect([pin.style.left, pin.style.top]).toEqual(['84px', '2px']);
  unmount();
});

it('review banner: confirm updates in place then leaves; reopen requires a note; agent comments are tagged', async () => {
  document.body.innerHTML = '<div class="box">Box</div>';
  document.querySelector('.box')!.getBoundingClientRect = () => domRect({ x: 100, y: 100, w: 300, h: 200 });
  const a = summary({ id: 'r1', number: 11, status: 'review' });
  const b = summary({ id: 'r2', number: 12, status: 'review' });
  const api = fakeApi([a, b], [
    { id: 'c1', author: 'claude', text: 'Fixed the overlap in Hero.astro', createdAt: '2026-10-02T00:00:00Z', viaWidget: false, via: 'agent' },
    { id: 'c2', author: 'Bob', text: 'Thanks', createdAt: '2026-10-03T00:00:00Z', viaWidget: false, via: 'trello' },
  ]);
  const onReporterChange = vi.fn();
  const { root, mountEl, unmount } = mount();
  const props = { ...base, api, onReporterChange, reporter: null as { name: string; email: string } | null };
  render(h(Pins, props), mountEl);
  await tick();
  const pin = (n: number) => [...root.querySelectorAll<HTMLElement>('.an-pin')].find((p) => p.textContent === String(n));
  expect(pin(11)!.className).toContain('an-pin-st-review');
  pin(11)!.click();
  await tick();
  const pop = () => root.querySelector<HTMLElement>('.an-pop')!;
  expect(pop().textContent).toContain('Ready for review');
  expect(pop().querySelector('.an-pop-review')!.textContent).toContain('Marked as fixed. Does it look right now?');

  // Agent tag only on the agent's comment.
  const heads = [...pop().querySelectorAll('.an-pop-comment-head')];
  expect(heads.map((n) => !!n.querySelector('.an-pop-tag'))).toEqual([true, false]);
  expect(heads[0]!.querySelector('.an-pop-tag')!.textContent).toBe('agent');

  // No reporter yet: "Looks good" asks for name + email first (one set of fields on screen).
  button(pop(), 'Looks good ✓')!.click();
  await tick();
  expect(api.confirmIssue).not.toHaveBeenCalled();
  expect(pop().querySelector('.an-pop-review-who')).toBeTruthy();
  expect(pop().querySelector('.an-pop-reply-who')).toBeFalsy();
  pop().querySelector<HTMLFormElement>('.an-pop-review-form')!.dispatchEvent(new Event('submit', { cancelable: true }));
  await tick();
  expect(pop().querySelector('.an-pop-review-error')!.textContent).toContain('Add your name');
  const [nameIn, emailIn] = [...pop().querySelectorAll<HTMLInputElement>('.an-pop-review-who input')];
  input(nameIn!, 'Zed');
  input(emailIn!, 'zed@example.com');
  await tick();
  button(pop(), 'Confirm fix')!.click();
  await tick();
  const zed = { name: 'Zed', email: 'zed@example.com' };
  expect(onReporterChange).toHaveBeenCalledWith(zed);
  expect(api.confirmIssue).toHaveBeenCalledWith('r1', zed);
  expect(pop().textContent).toContain('Thanks! Marked as done.');
  expect(pop().querySelector('.an-pop-badge')!.textContent).toBe('Resolved');
  expect(pin(11)!.className).toContain('an-pin-st-resolved');
  // showResolved is off: the pin and popover leave after the "Thanks!" moment.
  await tick(1700);
  expect(pin(11)).toBeFalsy();
  expect(root.querySelector('.an-pop')).toBeFalsy();

  // Reopen (reporter saved now): the note is required, errors are shown, success updates the pin.
  render(h(Pins, { ...props, reporter: zed }), mountEl);
  await tick();
  pin(12)!.click();
  await tick();
  button(pop(), 'Still broken')!.click();
  await tick();
  const note = pop().querySelector<HTMLTextAreaElement>('.an-pop-review textarea')!;
  expect(pop().querySelector('.an-pop-review-who')).toBeFalsy();
  expect(button(pop(), 'Reopen issue')!.disabled).toBe(true);
  note.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
  await tick();
  expect(pop().querySelector('.an-pop-review-error')!.textContent).toContain('Describe what still looks wrong');
  expect(api.reopenIssue).not.toHaveBeenCalled();
  input(note, 'Still overlaps on mobile');
  await tick();
  api.reopenIssue.mockRejectedValueOnce(new Error('Network down.'));
  button(pop(), 'Reopen issue')!.click();
  await tick();
  expect(pop().querySelector('.an-pop-review-error')!.textContent).toBe("Couldn't reopen. Network down.");
  expect(pin(12)!.className).toContain('an-pin-st-review');
  const loads = api.getIssue.mock.calls.length;
  button(pop(), 'Reopen issue')!.click();
  await tick();
  expect(api.reopenIssue).toHaveBeenLastCalledWith('r2', 'Still overlaps on mobile', zed);
  expect(pop().textContent).toContain("reopened so the team can take another look");
  expect(pin(12)!.className).toContain('an-pin-st-new');
  expect(pop().querySelector('.an-pop-badge')!.textContent).toBe('New');
  expect(api.getIssue.mock.calls.length).toBeGreaterThan(loads); // reloads to show the posted note
  unmount();
});

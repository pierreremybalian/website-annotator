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
  };
  const onReporterChange = vi.fn();
  const hostEl = document.createElement('div');
  document.documentElement.append(hostEl);
  const root = hostEl.attachShadow({ mode: 'open' });
  const mountEl = document.createElement('div');
  mountEl.className = 'annotate-root';
  root.append(mountEl);
  render(h(Pins, { api, pageUrl: 'https://site/', reporter: null, onReporterChange, showResolved: false, refreshKey: 0, openIssueId: null }), mountEl);
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
  render(h(Pins, { api, pageUrl: 'https://site/', reporter: null, onReporterChange, showResolved: false, refreshKey: 1, openIssueId: null }), mountEl);
  await tick();
  expect(mountEl.innerHTML).toBe('');
  // openIssueId opens once loaded; list error warns once
  render(h(Pins, { api, pageUrl: 'https://site/', reporter: { name: 'A', email: 'a@b.co' }, onReporterChange, showResolved: false, refreshKey: 2, openIssueId: 'i2' }), mountEl);
  await tick();
  expect(root.querySelector('.an-pop')!.textContent).toContain('Position may have moved');
  expect(root.querySelector('.an-pop-reply-who')).toBeFalsy();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  (api.listIssues as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
  render(h(Pins, { api, pageUrl: 'https://site/', reporter: null, onReporterChange, showResolved: false, refreshKey: 3, openIssueId: 'i2' }), mountEl);
  await tick();
  render(h(Pins, { api, pageUrl: 'https://site/', reporter: null, onReporterChange, showResolved: false, refreshKey: 4, openIssueId: 'i2' }), mountEl);
  await tick();
  expect(warn).toHaveBeenCalledTimes(1);
  render(null, mountEl);
});

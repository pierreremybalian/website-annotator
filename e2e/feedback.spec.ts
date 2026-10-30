import { expect, test, type Page } from '@playwright/test';

const WORKER = 'http://localhost:8787';
const PAGE = 'http://localhost:5173/';

interface MockState {
  cards: { id: string; name: string; desc: string; idList: string; attachments: { name: string; cover: boolean }[] }[];
}

async function mockState(page: Page): Promise<MockState> {
  const res = await page.request.get(`${WORKER}/dev/state`);
  expect(res.ok()).toBeTruthy();
  return res.json();
}

test.beforeEach(async ({ request }) => {
  const res = await request.post(`${WORKER}/dev/seed`);
  expect(res.ok()).toBeTruthy();
});

test('capture → Trello card → pin → status follows Trello', async ({ page }) => {
  await page.goto(PAGE);
  // Start each run with a clean reporter so the name/email fields show.
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  const card = page.locator('#services .card').nth(1);
  await card.scrollIntoViewIfNeeded();
  const box = (await card.boundingBox())!;
  const cardsBefore = (await mockState(page)).cards.length;

  // 1. Launcher → Report an issue → Shift-drag around the second service card (snaps to the element).
  await page.getByRole('button', { name: 'Feedback' }).click();
  await page.getByText('Report an issue').click();
  await expect(page.locator('[data-annotate="selector"]')).toBeVisible();
  await page.keyboard.down('Shift');
  await page.mouse.move(box.x + 4, box.y + 4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
  await page.mouse.move(box.x + box.width - 4, box.y + box.height - 4, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up('Shift');

  // 2. Fill the form and send.
  const form = page.getByRole('dialog', { name: 'Report an issue' });
  await expect(form).toBeVisible({ timeout: 20_000 });
  await form.getByLabel('Title (optional)').fill('Card copy is cut off');
  await form.getByLabel("What's wrong?").fill('The last line of the Hard landscaping card is clipped on desktop.');
  await form.getByLabel('Your name').fill('E2E Tester');
  await form.getByLabel('Email').fill('e2e@example.com');
  await form.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText(/#\d+ created/)).toBeVisible({ timeout: 20_000 });

  // 3. The mock Trello board has the card with both screenshots, selection as cover.
  const state = await mockState(page);
  expect(state.cards.length).toBe(cardsBefore + 1);
  const created = state.cards.at(-1)!;
  expect(created.name).toMatch(/^#\d+ Card copy is cut off$/);
  expect(created.desc).toContain('The last line of the Hard landscaping card');
  expect(created.desc).toContain('**Reporter:** E2E Tester <e2e@example.com>');
  expect(created.attachments).toHaveLength(2);
  expect(created.attachments.find((a) => a.cover)?.name).toMatch(/\.png$/);

  // 4. After reload, the pin sits on the top-left corner of the reported card.
  await page.reload();
  await card.scrollIntoViewIfNeeded();
  const pin = page.getByRole('button', { name: /Card copy is cut off/ }).last();
  await expect(pin).toBeVisible();
  const pinBox = (await pin.boundingBox())!;
  const cardBox = (await card.boundingBox())!;
  expect(Math.abs(pinBox.x + pinBox.width / 2 - cardBox.x)).toBeLessThan(30);
  expect(Math.abs(pinBox.y + pinBox.height / 2 - cardBox.y)).toBeLessThan(30);

  // 5. Pin follows its element at a narrower viewport.
  await page.setViewportSize({ width: 768, height: 900 });
  await card.scrollIntoViewIfNeeded();
  await expect
    .poll(async () => {
      const [p, c] = await Promise.all([pin.boundingBox(), card.boundingBox()]);
      return p && c ? Math.abs(p.x + p.width / 2 - c.x) + Math.abs(p.y + p.height / 2 - c.y) : 999;
    })
    .toBeLessThan(40);

  // 6. Popover shows notes; a reply lands on the Trello card as a widget comment.
  await pin.click();
  const pop = page.getByRole('dialog', { name: /Issue #\d+/ });
  await expect(pop).toBeVisible();
  await expect(pop.getByText('The last line of the Hard landscaping card is clipped on desktop.')).toBeVisible();
  await pop.getByLabel('Reply').fill('Still happening on staging.');
  await pop.getByRole('button', { name: /send|reply/i }).click();
  await expect(pop.getByText('Still happening on staging.')).toBeVisible();

  // 7. Someone drags the card to Done in Trello → opening the pin refreshes status → hidden after reload.
  await page.request.post(`${WORKER}/dev/move-card`, { data: { cardId: created.id, listId: 'list-3' } });
  await page.getByRole('button', { name: 'Close' }).first().click();
  await pin.click();
  await expect(page.getByRole('dialog', { name: /Issue #\d+/ }).getByText('Resolved')).toBeVisible();
  await page.reload();
  await card.scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: /Card copy is cut off/ })).toHaveCount(0);
});

test('connect popup posts keys back to the opener', async ({ page, context }) => {
  // Stand-in for the WP settings page: any page on an origin, listening for the message.
  await page.goto(PAGE);
  await page.evaluate(() => {
    (window as any).__connected = null;
    window.addEventListener('message', (e) => {
      if (e.data?.type === 'annotate:connected') (window as any).__connected = e.data;
    });
  });
  const [popup] = await Promise.all([
    context.waitForEvent('page'),
    page.evaluate((w) => {
      window.open(`${w}/connect?origin=${encodeURIComponent(location.origin)}&name=E2E%20Site&site=${encodeURIComponent(location.origin)}`, 'annotate', 'width=520,height=720');
    }, WORKER),
  ]);
  await popup.getByRole('link', { name: /log in with trello/i }).click();
  await popup.getByText('Mock Board').click();
  await popup.getByRole('button', { name: /^connect/i }).click();

  await expect.poll(() => page.evaluate(() => (window as any).__connected)).toMatchObject({
    type: 'annotate:connected',
    boardName: 'Mock Board',
    projectKey: expect.stringMatching(/^pk_/),
    accessKey: expect.stringMatching(/^ak_/),
  });
});

test('agent loop: pick element → CLI show/claim/resolve → pin goes In progress, then Done', async ({ page }) => {
  const { execFileSync } = await import('node:child_process');
  execFileSync('pnpm', ['--filter', '@annotate/cli', 'build'], { stdio: 'ignore' });
  const cli = (...args: string[]) =>
    execFileSync('node', ['packages/cli/dist/annotate.mjs', ...args, '--endpoint', WORKER], {
      env: { ...process.env, ANNOTATE_TOKEN: 'at_dev-token' },
      encoding: 'utf8',
    });

  await page.goto(PAGE);
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  // Pick the hero heading by clicking it.
  const h1 = page.locator('h1').first();
  const hb = (await h1.boundingBox())!;
  await page.getByRole('button', { name: 'Feedback' }).click();
  await page.getByText('Report an issue').click();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2, { steps: 4 });
  await page.mouse.click(hb.x + hb.width / 2, hb.y + hb.height / 2);
  const form = page.getByRole('dialog', { name: 'Report an issue' });
  await expect(form).toBeVisible({ timeout: 20_000 });
  await form.getByLabel('Title (optional)').fill('Heading wraps awkwardly');
  await form.getByLabel("What's wrong?").fill('The hero heading breaks after one word at 1280px.');
  await form.getByLabel('Your name').fill('E2E Client');
  await form.getByLabel('Email').fill('client@example.com');
  await form.getByRole('button', { name: 'Send' }).click();
  const created = await page.getByText(/#\d+ created/).textContent({ timeout: 20_000 });
  const n = created!.match(/#(\d+)/)![1]!;

  // The agent sees element-mode context with source hints.
  const shown = JSON.parse(cli('show', n, '--json'));
  expect(shown.anchor.mode).toBe('element');
  expect(shown.context.page).toMatchObject({ platform: 'dev' });
  expect(shown.context.element.tag).toBe('h1');
  expect(shown.sources.length).toBeGreaterThan(0);

  // Claiming moves it to "In progress" on the pin.
  cli('claim', n, '--as', 'e2e-agent');
  await page.reload();
  await expect(page.getByRole('button', { name: `Issue #${n}: Heading wraps awkwardly (In progress)` })).toBeVisible();

  // Resolving (after verifying live) moves it to Done: hidden by default, listed under "Show resolved".
  const resolved = JSON.parse(cli('resolve', n, '--note', 'Balanced the heading with text-wrap', '--commit', 'abc1234', '--as', 'e2e-agent', '--json'));
  expect(resolved.issue.status).toBe('resolved');
  await page.reload();
  await page.getByRole('button', { name: 'Feedback' }).click();
  await page.getByRole('menuitemcheckbox', { name: /Show resolved/ }).click();
  const pin = page.getByRole('button', { name: `Issue #${n}: Heading wraps awkwardly (Resolved)` });
  await expect(pin).toBeVisible();
  await pin.click();
  await expect(page.getByRole('dialog', { name: new RegExp(`Issue #${n}`) }).getByText('Balanced the heading with text-wrap')).toBeVisible();

  expect(JSON.parse(cli('show', n, '--json')).status).toBe('resolved');
});

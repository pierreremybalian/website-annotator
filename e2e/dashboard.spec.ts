import { expect, test, type APIRequestContext } from '@playwright/test';

const WORKER = 'http://localhost:8787';
const SITE = 'http://localhost:5173';
const OWNER = 'dev@annotate.test';

interface Seed {
  projectKey: string;
  accessKey: string;
}

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 5, 6, 7, 8]);

/** A widget report on the dev project, sent the way the widget sends it. */
async function report(request: APIRequestContext, seed: Seed, title: string): Promise<{ id: string; number: number }> {
  const meta = {
    title,
    notes: 'Reported from the e2e test.',
    reporter: { name: 'Jane Client', email: 'jane@client.example' },
    anchor: { selector: 'h1', relative: { x: 0, y: 0, width: 1, height: 1 }, absolute: { x: 10, y: 10, width: 200, height: 40 }, viewportWidth: 1280, text: 'Hello' },
    env: { url: `${SITE}/`, title: 'Dev', referrer: '', viewport: { width: 1280, height: 800 }, dpr: 1, scroll: { x: 0, y: 0 }, userAgent: 'e2e', browser: 'Chrome', os: 'macOS', language: 'en', timestamp: new Date().toISOString(), consoleErrors: [] },
  };
  const res = await request.post(`${WORKER}/v1/issues`, {
    headers: { 'X-Annotate-Project': seed.projectKey, 'X-Annotate-Access': seed.accessKey, Origin: SITE },
    multipart: { meta: JSON.stringify(meta), selection: { name: 's.png', mimeType: 'image/png', buffer: png }, context: { name: 'c.jpg', mimeType: 'image/jpeg', buffer: jpeg } },
  });
  expect(res.status()).toBe(201);
  return res.json();
}

test('log in by code, see a widget report on the board, move it, comment', async ({ page, request }) => {
  const seed: Seed = await (await request.post(`${WORKER}/dev/seed`)).json();
  const title = `Hero text overlaps ${Date.now()}`;
  const issue = await report(request, seed, title);

  // Logged out: the dashboard sends you to the login page.
  await page.goto(`${WORKER}/app/`);
  await expect(page).toHaveURL(/\/login\?next=/);
  await page.getByPlaceholder('you@agency.com').fill(OWNER);
  await page.getByRole('button', { name: 'Email me a login code' }).click();
  await expect(page.getByText('Check your email')).toBeVisible();
  const { mail } = await (await request.get(`${WORKER}/dev/mail`)).json();
  const code = /code is (\d{6})/.exec(mail.find((m: { to: string }) => m.to === OWNER).text)![1]!;
  await page.getByLabel('6-digit code').fill(code);

  // In: the dev agency's projects.
  await expect(page).toHaveURL(/\/app\/o\/dev-org$/);
  await page.getByRole('link', { name: /Dev site\b/ }).first().click();
  const card = page.locator('.issue-card', { hasText: title });
  await expect(page.getByRole('region', { name: 'New' }).locator('.issue-card', { hasText: title })).toBeVisible();

  // Drag it to review: the widget (and the mock Trello board) see the move.
  await card.locator('.issue-card-inner').dragTo(page.getByRole('region', { name: 'Ready for review' }));
  await expect(page.getByRole('region', { name: 'Ready for review' }).locator('.issue-card', { hasText: title })).toBeVisible();
  await expect
    .poll(async () => (await (await request.get(`${WORKER}/v1/issues/${issue.id}`, { headers: { 'X-Annotate-Project': seed.projectKey, 'X-Annotate-Access': seed.accessKey } })).json()).issue.status)
    .toBe('review');

  // Open it and reply.
  await card.click();
  const drawer = page.getByRole('complementary', { name: 'Issue' });
  await expect(drawer.getByRole('heading', { name: title })).toBeVisible();
  await expect(drawer.getByLabel('Status')).toHaveValue('review');
  await drawer.getByPlaceholder(/Reply to the reporter/).fill('Fixed on staging, can you check?');
  await drawer.getByRole('button', { name: 'Comment' }).click();
  await expect(drawer.locator('.comment', { hasText: 'Fixed on staging, can you check?' })).toBeVisible();
  const widget = await (await request.get(`${WORKER}/v1/issues/${issue.id}`, { headers: { 'X-Annotate-Project': seed.projectKey, 'X-Annotate-Access': seed.accessKey } })).json();
  expect(widget.issue.comments.at(-1)).toMatchObject({ author: 'Dev Owner', text: 'Fixed on staging, can you check?', via: 'app' });

  // Settings: the install snippet and a fresh agent key.
  await page.keyboard.press('Escape');
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.locator('pre', { hasText: `data-project="${seed.projectKey}"` })).toBeVisible();
  await page.getByPlaceholder(/Where it's used/).fill('e2e');
  await page.getByRole('button', { name: 'Create key' }).click();
  await expect(page.getByText('Save this as .annotate.json now.')).toBeVisible();
});

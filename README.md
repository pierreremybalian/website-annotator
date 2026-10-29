# Annotate

Self-hosted website feedback. Click the button, drag a box, add notes; the report lands on a Trello card with screenshots, and everyone browsing the site in feedback mode sees pins where issues were reported.

```
packages/widget      embeddable script (Preact, Shadow DOM, snapdom capture)
packages/worker      Cloudflare Worker: API, Trello connect popup, webhook, D1 + R2
packages/wp-plugin   WordPress plugin: Connect Trello button, injects the widget
packages/shared      types shared by all of the above
e2e/                 Playwright end-to-end tests (widget + Worker, fake Trello)
```

## Local development

No Trello account needed: `TRELLO_MOCK=1` in `packages/worker/.dev.vars` swaps in an in-memory Trello and enables `/dev/*` helper routes.

```bash
pnpm install
cp packages/worker/.dev.vars.example packages/worker/.dev.vars
pnpm --filter @annotate/worker db:migrate:local
pnpm dev:worker            # http://localhost:8787
pnpm dev:widget            # http://localhost:5173 — demo page with the widget
curl -X POST localhost:8787/dev/seed   # creates the dev project the demo page uses
```

Tests: `pnpm typecheck`, `pnpm test` (unit), `npx playwright test` (e2e; starts both servers itself).

## Deploying

1. **Trello Power-Up** (once): https://trello.com/power-ups/admin → New → generate an API key and secret. Add your Worker URL (e.g. `https://feedback.baliandesign.com`) to the key's allowed origins.
2. **Cloudflare resources**:
   ```bash
   cd packages/worker
   npx wrangler d1 create annotate            # paste database_id into wrangler.toml
   npx wrangler r2 bucket create annotate-screenshots
   ```
3. **Config** in `wrangler.toml` `[vars]`: set `PUBLIC_URL` to the Worker's public URL and `ALLOWED_TRELLO_ORG` to your Trello workspace id. If you leave it empty, any Trello user can connect a board to your Worker. Leave `TRELLO_MOCK = "0"`.
4. **Secrets**:
   ```bash
   npx wrangler secret put TRELLO_KEY
   npx wrangler secret put TRELLO_SECRET
   openssl rand -base64 32 | npx wrangler secret put TOKEN_ENC_KEY
   openssl rand -base64 32 | npx wrangler secret put SIGNING_SECRET
   ```
5. **Ship**: `pnpm build && pnpm --filter @annotate/worker db:migrate:remote && pnpm --filter @annotate/worker deploy`, then attach the custom domain in the Cloudflare dashboard.

## Using it

- **WordPress**: zip `packages/wp-plugin/annotate`, install it, then go to Settings → Annotate → **Connect Trello** → log in → pick a board (or let it create one). Logged-in editors see the widget immediately. Send clients the activation link shown on the settings page.
- **Any other site**: open `<worker>/connect` and follow the same flow. It ends with a `<script>` tag to paste and an activation link.

## Known limits

- Screenshots are rendered from the DOM. Iframes (YouTube, maps) show as placeholders, and cross-origin images without CORS headers show as grey boxes. An image proxy on the Worker would fix the images.
- A pin can drift if its element is removed or redesigned. It then falls back to its original page position and shows a dashed outline.
- With real Trello, status changes arrive through the board webhook, which needs a public `PUBLIC_URL`. Locally, opening a pin refreshes its status straight from the card.

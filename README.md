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

1. **Trello app** (once): https://trello.com/apps/admin → New. Choose **Trello Auth** (not OAuth 2.0) and generate an API key and secret.
2. **Credentials**: put them in `packages/worker/.prod.vars` (gitignored) as `TRELLO_KEY=` and `TRELLO_SECRET=`.
3. **Cloudflare resources** (already done for the Balian Design account; ids are in `wrangler.toml`): `wrangler d1 create annotate`, `wrangler r2 bucket create annotate-screenshots`, then `pnpm --filter @annotate/worker db:migrate:remote`.
4. **Deploy**: `scripts/deploy.sh`. It builds the widget, deploys, sets `PUBLIC_URL` to the live URL, generates `TOKEN_ENC_KEY`/`SIGNING_SECRET` into `.prod.vars`, and uploads all secrets. It's safe to re-run.
5. **Lock it down**: add the Worker URL to the Trello API key's allowed origins, then do the first Connect right away. The first Trello account to connect becomes the owner, and after that only members of the owner's workspaces can connect. Set `ALLOWED_TRELLO_ORG` to pin access to one specific workspace instead.

## Using it

- **WordPress**: zip `packages/wp-plugin/annotate`, install it, then go to Settings → Annotate → **Connect Trello** → log in → pick a board (or let it create one). Logged-in editors see the widget immediately. Send clients the activation link shown on the settings page.
- **Any other site**: open `<worker>/connect` and follow the same flow. It ends with a `<script>` tag to paste and an activation link.

## Known limits

- Screenshots are rendered from the DOM. Iframes (YouTube, maps) show as placeholders, and cross-origin images without CORS headers show as grey boxes. An image proxy on the Worker would fix the images.
- A pin can drift if its element is removed or redesigned. It then falls back to its original page position and shows a dashed outline.
- With real Trello, status changes arrive through the board webhook, which needs a public `PUBLIC_URL`. Locally, opening a pin refreshes its status straight from the card.

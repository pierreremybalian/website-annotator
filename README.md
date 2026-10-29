# Annotate

Self-hosted website feedback, in the spirit of Marker.io. Click the button, drag a box over the problem, add a note, and a Trello card appears with screenshots, page URL and browser details. Anyone browsing the site in feedback mode sees **pins** where issues were reported, with live status and comments from Trello.

By [Pierre Balian](https://balian.dev) · [github.com/pierreremybalian](https://github.com/pierreremybalian) · v0.1.0 ([changelog](CHANGELOG.md))

```
packages/widget      embeddable script: capture, report form, pins          → README
packages/worker      Cloudflare Worker: API, Connect Trello popup, webhook  → README
packages/wp-plugin   WordPress plugin: Connect button, widget injection     → README
packages/shared      TypeScript contracts shared by widget and Worker       → README
e2e/                 Playwright end-to-end tests (widget + Worker, fake Trello)
scripts/             deploy.sh (Worker), package-plugin.sh (plugin zip)
```

Package docs: [widget](packages/widget/README.md) · [worker](packages/worker/README.md) · [wp-plugin](packages/wp-plugin/README.md) · [shared](packages/shared/README.md)

## How it fits together

```
client site ── widget.js ──▶ Cloudflare Worker ──▶ Trello (cards, attachments, comments)
                               │  D1: projects, issues, pin anchors
                               │  R2: screenshots for pin popovers
Trello board ── webhook ──────▶┘  (list moves → pin status)
```

- **Connecting a board**: Settings → Annotate → Connect Trello → log in → pick a board → Connect. No keys to copy.
- **Who sees the widget**: logged-in users with the chosen role, plus anyone who opened the site's activation link (`?annotate=<key>`). Regular visitors download nothing.
- **Status**: moving a card to Done in Trello resolves its pin.

## Local development

No Trello account needed: the Worker's `.dev.vars` turns on an in-memory fake Trello.

```bash
pnpm install
cp packages/worker/.dev.vars.example packages/worker/.dev.vars
pnpm --filter @annotate/worker db:migrate:local
pnpm dev:worker                               # http://localhost:8787
pnpm dev:widget                               # http://localhost:5173 (demo page)
curl -X POST localhost:8787/dev/seed          # creates the demo page's project
```

```bash
pnpm typecheck
pnpm test                                     # unit tests (widget + Worker)
npx playwright test                           # e2e; starts both dev servers itself
```

## Deploying

1. **Trello app** (once): at https://trello.com/apps/admin, click **New**, choose **Trello Auth** (not OAuth 2.0), and generate an API key and secret.
2. **Credentials**: put them in `packages/worker/.prod.vars` (gitignored) as `TRELLO_KEY=` and `TRELLO_SECRET=`.
3. **Cloudflare resources** (already done for this account; ids are in `wrangler.toml`): `wrangler d1 create annotate`, `wrangler r2 bucket create annotate-screenshots`, then `pnpm --filter @annotate/worker db:migrate:remote`.
4. **Deploy**: `scripts/deploy.sh` builds the widget, deploys, sets `PUBLIC_URL`, generates the Worker's own secrets into `.prod.vars`, and uploads all secrets. It's safe to re-run.
5. **Lock it down**: add the Worker URL to the Trello API key's allowed origins, then do the first Connect right away. The first Trello account to connect becomes the owner, and after that only members of the owner's workspaces can connect.

Live Worker: https://annotate.pierre-51f.workers.dev

## Releasing the plugin

```bash
scripts/package-plugin.sh                     # → dist/annotate-<version>.zip
```

See [wp-plugin/README](packages/wp-plugin/README.md#releasing) for bumping the version.

## Known limits

- Screenshots are rendered from the DOM. Iframes (YouTube, maps) show as placeholders, and cross-origin images without CORS headers show as grey boxes.
- A pin can drift if its element is removed or redesigned. It falls back to its original page position and shows a dashed outline.
- Status changes arrive by Trello webhook in production. Locally (fake Trello), opening a pin refreshes its status.

# Annotate

Self-hosted website feedback for QA that coding agents can work on. Clients click an element on the site and leave a note. A Trello card appears with screenshots and enough context for a coding agent to find the source file. The agent fixes it through the `annotate` CLI, ships it, checks it on the live page and closes it.

Works on any site. There are adapters for **WordPress** and **Astro**.

By [Pierre Balian](https://balian.dev) · [github.com/pierreremybalian](https://github.com/pierreremybalian) · v0.2.0 ([changelog](CHANGELOG.md))

```
packages/widget      embeddable script: element picking, report form, pins, issues panel
packages/worker      Cloudflare Worker: widget API, agent API, Connect Trello popup, webhook
packages/cli         `annotate` CLI for humans and coding agents (+ Claude Code skill)
packages/wp-plugin   WordPress plugin: Connect button, widget injection, page/block context
packages/astro       Astro integration: widget injection, page context, component source map
packages/shared      TypeScript contracts shared by everything above
e2e/                 Playwright end-to-end tests (widget + Worker + CLI, fake Trello)
scripts/             deploy.sh (Worker), package-plugin.sh (plugin zip)
```

Package docs: [widget](packages/widget/README.md) · [worker](packages/worker/README.md) · [cli](packages/cli/README.md) · [wp-plugin](packages/wp-plugin/README.md) · [astro](packages/astro/README.md) · [shared](packages/shared/README.md) · [0.2 plan](docs/plans/0.2-agentic-qa.md)

## The loop

```
client clicks an element ──▶ Worker ──▶ Trello card (humans)
                               ▲ │
   annotate issues/show/claim  │ ▼  claim → "In progress"; agent fixes, deploys, checks the live page
   annotate resolve ───────────┘    → "Done", pin leaves the page
```

Agents only resolve after the fix is live and checked on the reported page. Anyone can reopen an issue from Trello. A card a person moves to "Ready for review" gets **Looks good ✓ / Still broken** on its pin.

## Setup

- **WordPress**: install the plugin zip (`scripts/package-plugin.sh`), then go to Settings → Annotate → **Connect Trello**.
- **Astro or any other site**: run `annotate connect` in the site's repo. It opens the same Trello popup, writes `.annotate.json`, and prints the `<script>` tag or the `@annotate/astro` config.
- **Coding agents**: in the site's repo, run `annotate init` (link an existing project) and `annotate skill install`. Then ask Claude Code to "fix the open QA issues".

Who sees the widget: logged-in users with the chosen role (WordPress), staging builds in always-on mode (Astro), and anyone who opened the site's activation link (`?annotate=<key>`). Regular visitors download nothing.

## Local development

No Trello account needed: the Worker's `.dev.vars` turns on an in-memory fake Trello.

```bash
pnpm install
cp packages/worker/.dev.vars.example packages/worker/.dev.vars
pnpm --filter @annotate/worker db:migrate:local
pnpm dev:worker                               # http://localhost:8787
pnpm dev:widget                               # http://localhost:5173 (demo page)
curl -X POST localhost:8787/dev/seed          # dev project + agent token at_dev-token
ANNOTATE_TOKEN=at_dev-token node packages/cli/dist/annotate.mjs issues --endpoint http://localhost:8787
```

```bash
pnpm typecheck
pnpm test                                     # unit tests (widget, worker, cli, astro)
npx playwright test                           # e2e; starts both dev servers itself
```

## Deploying

1. **Trello app** (once): at https://trello.com/apps/admin, click **New**, choose **Trello Auth** (not OAuth 2.0), and generate an API key and secret.
2. **Credentials**: put them in `packages/worker/.prod.vars` (gitignored) as `TRELLO_KEY=` and `TRELLO_SECRET=`.
3. **Cloudflare resources** (already done for this account; ids are in `wrangler.toml`): `wrangler d1 create annotate`, `wrangler r2 bucket create annotate-screenshots`, then `pnpm --filter @annotate/worker db:migrate:remote`.
4. **Deploy**: `scripts/deploy.sh` applies pending D1 migrations, builds the widget, deploys, sets `PUBLIC_URL`, generates the Worker's own secrets into `.prod.vars`, and uploads all secrets. It's safe to re-run.
5. **Lock it down**: add the Worker URL to the Trello API key's allowed origins, then do the first Connect right away. The first Trello account to connect becomes the owner, and after that only members of the owner's workspaces can connect.

Live Worker: https://annotate.pierre-51f.workers.dev

## Known limits

- Screenshots are rendered from the DOM. Iframes (YouTube, maps) show as placeholders, and cross-origin images without CORS headers show as grey boxes.
- If a picked element is removed or its text changes, the pin falls back to its original position with a dashed outline.
- Status changes arrive by Trello webhook in production. Locally (fake Trello), opening a pin refreshes its status.

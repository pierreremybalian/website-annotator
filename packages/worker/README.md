# @annotate/worker

The backend: a Cloudflare Worker ([Hono](https://hono.dev)) with D1 for data and R2 for screenshots. It receives reports from the widget, creates Trello cards, serves pins, runs the **Connect Trello** popup and receives Trello's webhooks. It also serves `widget.js`.

Live: https://annotate.pierre-51f.workers.dev

## API

All `/v1/*` calls send `X-Annotate-Project: pk_…` and `X-Annotate-Access: ak_…`. A browser's `Origin` must be in the project's allowed origins. Request and response types live in [`@annotate/shared`](../shared/src/index.ts).

| Route | |
|---|---|
| `POST /v1/issues` | multipart `meta` (JSON) + `selection` (PNG) + `context` (JPEG) → stores the images in R2, creates the Trello card `#N title` with both images attached, returns `{id, number, shortUrl}` |
| `GET /v1/issues?url=…[&all=1]` | pins for a page. URLs are normalized (hash, tracking params and trailing slash ignored). Resolved issues are hidden unless `all=1` |
| `GET /v1/issues/:id` | details + Trello comments. Also re-reads the card, so status self-heals if a webhook was missed |
| `POST /v1/issues/:id/comments` | posts `**Name** (via widget): text` to the card |
| `GET /v1/screenshots/<key>?exp&sig` | signed, expiring image URLs (an `<img>` can't send headers) |
| `GET /v1/project` | connection status for the WP settings page |
| `/connect/*` | the Connect Trello popup (below) |
| `HEAD/POST /trello/webhook` | Trello webhook, verified with HMAC-SHA1 (`X-Trello-Webhook`) |
| `GET /health` | `{ok: true}` |

## Connect Trello flow

`/connect?origin=&name=&site=[&project=&access=]` opens in a popup from the WP plugin, or directly for non-WordPress sites:

1. **Log in with Trello.** Uses the Trello Auth API-key flow (`trello.com/1/authorize`, `expiration=never`). The token comes back in the URL fragment.
2. **Pick a board** or **Create a new board for me** (lists New / In progress / Done). The "new issues" and "resolved" lists are pre-selected.
3. **Connect.** Creates the project with `pk_`/`ak_` keys and registers the board webhook. The popup then sends the keys to the opener with `postMessage` and closes itself. A standalone run shows the `<script>` tag and the activation link instead.

The flow is tied to one browser by a short-lived HttpOnly cookie. Trello tokens are stored encrypted with AES-GCM and never sent back to the browser.

**Who can connect**: the first Trello member to log in becomes the owner. After that, only the owner and members of the owner's Trello workspaces can connect. Set `ALLOWED_TRELLO_ORG` to restrict connections to one workspace instead.

**Status sync**: moving a card to a "done" list resolves the pin. Moving it to the "new" list sets it back to new, and any other list means in progress. Archiving or deleting the card removes the pin.

## Configuration

| Name | Where | |
|---|---|---|
| `PUBLIC_URL` | `wrangler.toml` | Public base URL; used for Trello `return_url`, webhook callback and signed URLs. `.dev.vars` overrides it to localhost |
| `ALLOWED_TRELLO_ORG` | `wrangler.toml` | Optional workspace id; overrides the owner rule |
| `TRELLO_MOCK` | `.dev.vars` only | `1` = in-memory fake Trello + `/dev/*` routes |
| `TRELLO_KEY`, `TRELLO_SECRET` | secret | Trello Auth API key and secret |
| `TOKEN_ENC_KEY` | secret | base64 32-byte AES key for stored tokens |
| `SIGNING_SECRET` | secret | HMAC key for screenshot URLs |

Production secrets are uploaded by [`scripts/deploy.sh`](../../scripts/deploy.sh) from the gitignored `.prod.vars`.

## Data

D1 tables (`migrations/`): `projects` (keys, allowed origins, encrypted token, board and lists, webhook), `issues` (Trello card, page URL, anchor, environment, reporter, status, R2 keys), `connect_sessions` (15-minute popup sessions) and `settings` (owner).

R2 keys: `<projectId>/<issueId>/selection.png` and `context.jpg`.

## Local development

```bash
cp .dev.vars.example .dev.vars              # TRELLO_MOCK=1, localhost PUBLIC_URL
pnpm db:migrate:local
pnpm dev                                     # http://localhost:8787
curl -X POST localhost:8787/dev/seed         # dev project: pk "dev-project", ak "dev-access"
```

Mock-only helpers: `POST /dev/move-card {cardId, listId}` and `POST /dev/delete-card {cardId}` simulate Trello changes, and `GET /dev/state` dumps the fake board.

```bash
pnpm test          # vitest in workerd: issues, auth, URLs, connect, webhook
pnpm typecheck
```

## Layout

```
src/index.ts            routes + error handling
src/auth.ts             project/access/Origin checks, CORS
src/trello.ts           Trello client + in-memory mock
src/crypto.ts           token encryption, HMAC helpers
src/owner.ts            who may connect
src/card.ts             card title/description formatting
src/sign.ts             signed screenshot URLs
src/url.ts              page-URL normalization
src/routes/             issues, comments, screenshots, project, connect, webhook, dev
src/connect/            server-rendered popup pages
```

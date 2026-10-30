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
| `POST /v1/issues/:id/confirm` | from `review` only: card → first done list, status `resolved` ("Looks good ✓" on the pin) |
| `POST /v1/issues/:id/reopen` | from `review`/`resolved`: card → new list with the reporter's note ("Still broken") |
| `GET /v1/screenshots/<key>?exp&sig` | signed, expiring image URLs (an `<img>` can't send headers) |
| `GET /v1/project` | connection status for the WP settings page |
| `/v1/agent/*` | agent API for the CLI (below) |
| `POST /cli/sessions`, `POST /cli/sessions/:id/poll` | browser → CLI hand-off for `annotate connect` / `init` (below) |
| `/connect/*` | the Connect Trello popup (below) |
| `HEAD/POST /trello/webhook` | Trello webhook, verified with HMAC-SHA1 (`X-Trello-Webhook`) |
| `GET /health` | `{ok: true}` |

## Connect Trello flow

`/connect?origin=&name=&site=[&project=&access=]` opens in a popup from the WP plugin, or directly for non-WordPress sites:

1. **Log in with Trello.** Uses the Trello Auth API-key flow (`trello.com/1/authorize`, `expiration=never`). The token comes back in the URL fragment.
2. **Pick a board** or **Create a new board for me** (lists New / In progress / Ready for review / Done). The "new issues", "ready for review" and "resolved" lists are pre-selected. If the board has no review list, Annotate can create one.
3. **Connect.** Creates the project with `pk_`/`ak_` keys and registers the board webhook. The popup then sends the keys to the opener with `postMessage` and closes itself. A standalone run shows the `<script>` tag and the activation link instead.

The flow is tied to one browser by a short-lived HttpOnly cookie. Trello tokens are stored encrypted with AES-GCM and never sent back to the browser.

**Who can connect**: the first Trello member to log in becomes the owner. After that, only the owner and members of the owner's Trello workspaces can connect. Set `ALLOWED_TRELLO_ORG` to restrict connections to one workspace instead.

**Status sync**: the card's list sets the status. The "new" list means `new`, the "ready for review" list means `review`, a "done" list means `resolved`, and any other list means `in_progress`. Archiving or deleting the card removes the pin.

## Agent API (`/v1/agent/*`)

Used by the [`annotate` CLI](../cli/README.md). Authenticate with `Authorization: Bearer at_…`, a per-project agent token stored as a SHA-256 hash. It's separate from the widget's access key, which lives in client browsers. Issues are addressed by their **number**.

| Route | |
|---|---|
| `GET /project` | name, board, origins, counts per status |
| `GET /issues?status=open\|new\|in_progress\|review\|resolved\|archived\|all&url=` | `open` (default) = new + in progress |
| `GET /issues/:n` | everything: notes, anchor, env, **context** (element HTML, selector, landmark, styles, source hints, page context), comments, signed screenshot URLs |
| `POST /issues/:n/claim` `{agent, minutes?}` | lease (default 30 min, max 240); a `new` issue's card → "In progress" (found or created on first use); 409 `claimed` if another agent holds it |
| `POST /issues/:n/release` | drop the lease; card back to the new list if it's still in "In progress" |
| `POST /issues/:n/comments` `{text, author?}` | `**author** (via agent): text` |
| `POST /issues/:n/resolve` `{note, commit?, author?}` | card → first done list, status `resolved`, lease released. Agents call it only after checking the fix live |
| `POST /issues/:n/reopen` `{note, author?}` | card → new list |
| `GET / POST / DELETE /origins` `{origin}` | the sites allowed to load the widget (max 20) |

## CLI hand-off (`annotate connect` / `annotate init`)

Device-style, so the CLI never sees a Trello token:

1. The CLI `POST`s `/cli/sessions` with `{verifierHash, mode}` and opens the returned `/connect?cli=<id>` in the browser.
2. The same Connect flow runs. In CLI mode the board step also offers **Link an existing project**: any project whose board your Trello account can see.
3. Finishing mints an agent token and stores the result encrypted on the session. The CLI polls `/cli/sessions/:id/poll` with its verifier: `202` pending, then `200` once (the result is deleted), `403` for a wrong verifier, `410` if expired after 15 minutes.

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

D1 tables (`migrations/`):
- `projects`: keys, allowed origins, encrypted Trello token, board, new/in-progress/review/done lists, webhook.
- `issues`: Trello card, page URL, anchor, environment, **context**, reporter, status, claim lease, resolution, R2 keys.
- `agent_tokens`: hashed CLI tokens.
- `connect_sessions` and `cli_sessions`: 15-minute popup and CLI hand-off sessions.
- `settings`: the owner.

R2 keys: `<projectId>/<issueId>/selection.png` and `context.jpg`.

## Local development

```bash
cp .dev.vars.example .dev.vars              # TRELLO_MOCK=1, localhost PUBLIC_URL
pnpm db:migrate:local
pnpm dev                                     # http://localhost:8787
curl -X POST localhost:8787/dev/seed         # dev project: pk "dev-project", ak "dev-access", agent token "at_dev-token"
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
src/agent-auth.ts       Bearer agent-token check
src/agent-tokens.ts     mint agent tokens
src/progress.ts         find or create the "In progress" list (used by claim)
src/routes/             issues, comments, screenshots, project, agent, cli, connect, webhook, dev
src/connect/            server-rendered popup pages (incl. CLI mode)
```

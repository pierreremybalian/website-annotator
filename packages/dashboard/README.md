# @annotate/dashboard

The Annotate web app: projects, the board, issues, team and settings. Preact + Vite, built into the Worker's static assets (`packages/worker/public/app`) and served at `/app/`. It talks to the Worker's `/v1/app/*` API with the session cookie set by the email login (`/login`), same origin only.

By [Pierre Balian](https://balian.dev) · [GitHub](https://github.com/pierreremybalian/website-annotator)

Live: https://annotate.balian.dev/app/

## Pages

| Path | |
|---|---|
| `/app/` | goes to the last organization's projects (or says you're not in one yet) |
| `/app/o/:org` | projects, with open counts; New project |
| `/app/o/:org/team` | members and roles, invitations |
| `/app/p/:id` | the board; `?issue=<id>` opens the issue drawer |
| `/app/p/:id/settings` | install snippet, activation link, allowed sites, agent keys, Trello, delete |

## Development

```bash
pnpm dev:worker                 # http://localhost:8787
curl -X POST localhost:8787/dev/seed
pnpm dev:dashboard              # http://localhost:5174/app/ → log in as dev@annotate.test
curl localhost:8787/dev/mail    # the login code
```

```bash
pnpm --filter @annotate/dashboard build    # → packages/worker/public/app
pnpm --filter @annotate/dashboard test
```

The e2e test (`e2e/dashboard.spec.ts`) logs in, moves a widget report on the board and comments.

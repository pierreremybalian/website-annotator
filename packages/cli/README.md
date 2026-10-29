# @annotate/cli

`annotate` fetches the QA issues reported through the Annotate widget, maps them to files in your checkout, and hands fixes back for a human to confirm. Coding agents (Claude Code) run it through Bash, and people use it too. It's a single Node file (Node ≥20) with no runtime dependencies. `annotate --help` and `annotate <command> --help` are the reference.

## Install

```bash
pnpm --filter @annotate/cli build
npm install -g ./packages/cli
```

Or run it without installing it:

```bash
node packages/cli/dist/annotate.mjs --help
```

## Set up a repo

```bash
annotate connect --site https://example.com
annotate init
annotate skill install
```

- `connect` creates a project on a new Trello board. `init` links the repo to an existing project.
- Both open the browser and print the link too (`--no-open` skips the browser). They wait up to 15 minutes for you to finish there.
- When you're done, they write `.annotate.json` (mode 0600) to the current directory and add it, plus `.annotate/screenshots/`, to the repo's `.gitignore`. They also print the widget embed snippet, the Astro setup and the activation link.
- `skill install` installs the Claude Code skill (see [Skill](#skill)).

The CLI never sees a Trello token. The hand-off works like a device login:
1. The CLI keeps a random verifier and sends only its SHA-256.
2. The browser finishes the normal connect flow.
3. The CLI collects an agent token (`at_…`) by polling with the verifier.

## Commands

| Command | What it does |
|---|---|
| `connect [--site <url>]` / `init` | Browser hand-off; writes `.annotate.json` |
| `project` (`whoami`) | Project, board, allowed origins, issue counts |
| `issues [--status s] [--url u]` | Table of #, status, title, page, claimant. Status: `open` (default: new + in progress), `new`, `in_progress`, `review`, `resolved`, `archived`, `all` |
| `show <n>` | Notes; where (page, viewport, selector, landmark, **resolved source files**); element HTML and styles; env and console errors; comments; Trello link |
| `screenshot <n> [--context] [-o path]` | Saves to `.annotate/screenshots/issue-<n>[-context].<ext>` and prints the absolute path |
| `claim <n> [--minutes m] [--as name]` | Leases the issue (default 30 min, max 240). The default name is `<user>@<hostname>` |
| `release <n>` | Drops the lease |
| `comment <n> <text…>` | Adds a comment; it shows on the Trello card and the pin |
| `resolve <n> --note "…" [--commit <sha>\|auto]` | Moves the issue to **review** ("Ready for review"). `auto` = `git rev-parse --short HEAD` |
| `reopen <n> --note "…"` | Moves the issue back to new |
| `origins [list] \| add <origin> \| remove <origin>` | Sets the sites allowed to load the widget |
| `skill install [--global] \| skill print` | Installs or prints the Claude Code skill |

Issues are addressed by their number (`12` or `"#12"`). Agents never close issues: `resolve` moves an issue to review, and a person on the site clicks **Confirm** (resolved) or **Still broken** (back to new).

### `--json`

Every command accepts `--json`. It prints raw JSON on stdout and nothing else, which makes it the stable contract for scripts and agents. Errors still go to stderr.

- `issues` prints `{"issues": AgentIssue[]}` exactly as the API returns it.
- Write commands (claim, release, comment, resolve, reopen) print `{"issue": AgentIssueDetail}`.
- `show` prints the API's `AgentIssueDetail` with one extra top-level field, `resolvedSources: [{hint, files}]`.
- `screenshot` prints `{"path"}`.

The types are in `packages/shared/src/index.ts`.

### Source resolution (`show`)

Source hints come from the page: `data-annotate-source`, `data-annotate-block` (WordPress), `data-astro-source-file` (Astro dev), and `data-astro-cid-*` (Astro production). `show` maps them to files **locally**, so file paths never cross the network.

The search starts at the git root (or the cwd outside a repo). It skips `node_modules`, `vendor`, `.git`, `dist`, `build`, `.astro`, `wp-content/uploads` and a few caches, and it caps the depth and file count.

| Hint | Resolved to |
|---|---|
| `wp-block acf/hero` | The directory of each `block.json` whose `"name"` matches, plus its `renderTemplate`, `acf.renderTemplate` or `render`. Also `blocks/hero/` and `template-parts/blocks/hero*` |
| `astro-source` | The file path as given (made relative to the root), with `:line`. A path from another machine falls back to its longest suffix that exists locally |
| `astro-cid` | Looked up in each `.annotate/astro-cids.json` (written by `@annotate/astro`) |
| `annotate` | The path if it exists, else files with that basename |
| `page-template` | The WordPress `context.page.template`, found in the theme |

Paths are relative to the git root. Directories end in `/`, and `files: []` means nothing matched locally.

## Config

- `.annotate.json` is found by walking up from the cwd, the way git finds `.git`. Its fields are `endpoint`, `projectKey`, `agentToken`, `projectName`, `boardName` and `boardUrl`.
- `ANNOTATE_TOKEN` overrides the agent token, so CI needs no file.
- The endpoint comes from the first of these that's set: `--endpoint`, `ANNOTATE_ENDPOINT`, `.annotate.json`, then the default `https://annotate.pierre-51f.workers.dev`.
- Colors appear only on a TTY. Set `NO_COLOR` to turn them off.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | OK (also when a list is empty) |
| 1 | Error or network failure; hand-off expired or timed out |
| 2 | Usage error |
| 3 | Not found (404), or not configured ("Run `annotate init`") |
| 4 | Conflict (409), e.g. another agent has claimed the issue. The message names the claimant |
| 5 | Auth: bad or revoked token (401/403), or the hand-off verifier was rejected |

Errors go to stderr as `error: <message>`.

## Skill

`skills/annotate-qa/SKILL.md` is embedded in the build.

- `annotate skill install` writes it to `<git root>/.claude/skills/annotate-qa/SKILL.md`.
- `annotate skill install --global` writes it to `~/.claude/skills/annotate-qa/SKILL.md`.

It teaches Claude Code the routine: list, claim, read the issue and screenshot, locate the source, make a minimal fix, verify, commit, then `resolve --commit auto`. If it's blocked, it comments and releases instead. It never reopens issues.

## Development

```bash
pnpm --filter @annotate/cli typecheck
pnpm --filter @annotate/cli test
pnpm --filter @annotate/cli build
```

The tests run every command in-process with a mocked `fetch`, using temporary directories and git repos.

import { DEFAULT_ENDPOINT } from './config';

export const EXIT_CODES_LINE =
  'Exit codes: 0 ok · 1 error/network · 2 usage · 3 not found or not configured · 4 conflict (claimed) · 5 auth';

export const GLOBAL_HELP = `annotate: QA issues from the Annotate feedback widget, for humans and coding agents.

Usage: annotate <command> [args] [--json]

Setup
  connect [--site <url>]           Connect a new Trello board in the browser; writes .annotate.json
  init                             Link this repo to an existing project (browser); writes .annotate.json
  skill install [--global]         Install the Claude Code skill (.claude/skills/annotate-qa/SKILL.md)
  skill print                      Print the skill

Issues (addressed by number: 12 or "#12")
  project                          Project, board, allowed origins, issue counts (alias: whoami)
  issues [--status s] [--url u]    List issues (default: open = new + in progress)
  show <n>                         Everything about #n, plus the local source files it maps to
  screenshot <n> [--context] [-o path]
                                   Download the screenshot and print its path
  claim <n> [--minutes m] [--as name]
                                   Lease #n so other agents skip it (default 30 min)
  release <n>                      Drop the lease
  comment <n> <text…>              Add a comment (Trello card + pin)
  resolve <n> --note "…" [--commit <sha>|auto]
                                   Mark fixed → review ("Ready for review"); a human confirms
  reopen <n> --note "…"            Move back to new
  origins [list|add|remove] [<origin>]
                                   Sites allowed to load the widget

Global options
  --json              Raw JSON on stdout and nothing else: the stable contract for scripts and agents
  --endpoint <url>    Worker URL. Precedence: --endpoint, ANNOTATE_ENDPOINT, .annotate.json,
                      ${DEFAULT_ENDPOINT}
  -h, --help          Help; annotate <command> --help for details
  -v, --version       Print the version

Config
  .annotate.json is found by walking up from the cwd, like git. connect/init write it (mode 0600)
  and add it to .gitignore. ANNOTATE_TOKEN overrides its agent token.
  Errors go to stderr as "error: <message>".

${EXIT_CODES_LINE}
`;

const ISSUE_FIELDS = `AgentIssue: id, number, title, status, pageUrl, notes, reporterName, createdAt,
                 updatedAt, shortUrl, claimedBy, claimedUntil (null = free), screenshotUrl,
                 contextUrl, selector, sources`;

export const COMMAND_HELP: Record<string, string> = {
  connect: `Usage: annotate connect [--site <url>] [--no-open]

Create a project on a new Trello board. Opens the browser (the URL is printed too), waits up to
15 min for you to finish, then writes .annotate.json (mode 0600) at the git root (else the cwd), adds it to the repo's
.gitignore, and prints the widget embed snippet.

  --site <url>   Prefill the site URL
  --no-open      Don't open the browser; just print the URL
  --json         {configPath, endpoint, projectKey, projectName, boardName, boardUrl, origins, accessKey, gitignore}

Exit codes: 0 connected · 1 expired, timed out or network · 5 verifier rejected`,

  init: `Usage: annotate init [--no-open]

Link this repo to an existing project (one your Trello account can access). Same browser
hand-off as connect; writes .annotate.json (mode 0600) at the git root (else the cwd) and adds it to .gitignore.

  --no-open      Don't open the browser; just print the URL
  --json         {configPath, endpoint, projectKey, projectName, boardName, boardUrl, origins, accessKey, gitignore}

Exit codes: 0 linked · 1 expired, timed out or network · 5 verifier rejected`,

  project: `Usage: annotate project [--json]   (alias: whoami)

The project this repo is linked to: name, key, Trello board, allowed origins, issue counts.

  --json   AgentProject: {name, projectKey, boardName, boardUrl, origins, counts: {new, in_progress, review, resolved, archived}}

${EXIT_CODES_LINE}`,

  issues: `Usage: annotate issues [--status <s>] [--url <u>] [--json]

List issues: #, status, title, page path, claimed by. Prints "No open issues." (exit 0) when empty.

  --status <s>   open (default; new + in_progress) | new | in_progress | review | resolved | archived | all
  --url <u>      Only issues reported on this page URL
  --json         {"issues": AgentIssue[]}, exactly as the API returns it
                 ${ISSUE_FIELDS}

${EXIT_CODES_LINE}`,

  show: `Usage: annotate show <n> [--json]

Everything about issue #n: notes; where (page URL, viewport, selector, landmark, resolved source
files); the element's HTML and key styles; browser and console errors; comments; Trello link.

Source files are found locally, from the git root (else the cwd). Hints, nearest the element first:
  wp-block       block name → dir of the block.json with that "name" (+ its render template),
                 blocks/<slug>/, template-parts/blocks/<slug>*
  astro-source   data-astro-source-file, with :line
  astro-cid      hash → .annotate/astro-cids.json (written by @annotate/astro)
  annotate       data-annotate-source: the path if it exists, else files with that basename
  page-template  the WordPress page template from the page context

  --json   AgentIssueDetail (AgentIssue + anchor, env, context, comments, resolution) plus
           "resolvedSources": [{"hint": {kind, value, file?, line?, depth}, "files": [path, …]}]
           Paths are relative to the git root; directories end in "/"; files: [] = no local match.

${EXIT_CODES_LINE}`,

  screenshot: `Usage: annotate screenshot <n> [--context] [-o <path>] [--json]

Download the issue's screenshot (the selected area) and print the saved file's absolute path.
Default location: .annotate/screenshots/issue-<n>[-context].<ext> next to .annotate.json (else the cwd).

  --context        The full viewport with the selection drawn on it, instead of the crop
  -o, --output     File or directory to save to
  --json           {"path": "<absolute path>"}

${EXIT_CODES_LINE}`,

  claim: `Usage: annotate claim <n> [--minutes <m>] [--as <name>] [--json]

Lease issue #n so other agents skip it. Release it with
\`annotate release\`; \`annotate resolve\` releases it too.

  --minutes <m>   Lease length, 1-240 (server default 30)
  --as <name>     Who is working on it (default: <user>@<hostname>)
  --json          {"issue": AgentIssueDetail}

Exit code 4 if someone else holds the lease (the message names them). ${EXIT_CODES_LINE}`,

  release: `Usage: annotate release <n> [--json]

Drop your lease on #n so someone else can take it.

  --json   The API response

${EXIT_CODES_LINE}`,

  comment: `Usage: annotate comment <n> <text…> [--as <name>] [--json]

Add a comment to #n. It appears on the Trello card and the pin. Put -- before text that starts with "-".

  --as <name>   Author (default: <user>@<hostname>)
  --json        The API response

${EXIT_CODES_LINE}`,

  resolve: `Usage: annotate resolve <n> --note "<what changed>" [--commit <sha>|auto] [--as <name>] [--json]

Mark #n fixed: status review ("Ready for review" on Trello) and the lease released. Agents never
close issues; a human confirms on the site (Confirm → resolved, Still broken → new).

  --note <text>     Required. What changed, in plain words; shown on the card and the pin
  --commit <sha>    The fixing commit; "auto" = git rev-parse --short HEAD (warns on a dirty tree)
  --as <name>       Author (default: <user>@<hostname>)
  --json            {"issue": AgentIssueDetail}

${EXIT_CODES_LINE}`,

  reopen: `Usage: annotate reopen <n> --note "<why>" [--as <name>] [--json]

Move #n back to new with a note (for humans; agents shouldn't reopen issues).

  --note <text>   Required
  --as <name>     Author (default: <user>@<hostname>)
  --json          {"issue": AgentIssueDetail}

${EXIT_CODES_LINE}`,

  origins: `Usage: annotate origins [list] | origins add <origin> | origins remove <origin>   [--json]

Sites (origins) allowed to load the widget and send reports, e.g. https://example.com.
A full URL is reduced to its origin.

  --json   {"origins": string[]}

${EXIT_CODES_LINE}`,

  skill: `Usage: annotate skill install [--global] | annotate skill print   [--json]

The Claude Code skill (annotate-qa) that teaches an agent the fix routine.

  install           Write it to <git root or cwd>/.claude/skills/annotate-qa/SKILL.md
  install --global  Write it to ~/.claude/skills/annotate-qa/SKILL.md
  print             Print it to stdout
  --json            install: {"path", "status": "created"|"updated"|"unchanged"}; print: {"content"}

Exit codes: 0 ok · 1 write failed · 2 usage`,
};

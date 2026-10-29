---
name: annotate-qa
description: Fix website QA issues that clients and teammates reported with the Annotate feedback widget, using the `annotate` CLI (list, claim, locate the source, fix, verify, hand back for review). Use when asked to "fix the QA issues", work through "annotate issues", handle "client feedback on the site", fix "issues from the feedback widget", feedback pins or Trello feedback cards, or when a repo has an .annotate.json.
---

# Annotate QA

Issues come from the Annotate widget on the live site. The `annotate` CLI lists them, leases them to you, and hands them back for a human to confirm. Run it through Bash.

- `--json` output is the contract: parse it, never scrape the human output. `annotate <cmd> --help` documents each command and its JSON.
- Exit codes: 0 ok, 1 error/network, 2 usage, 3 not found or not configured, 4 claimed by someone else, 5 auth.
- Exit 3 with "Run `annotate init`", or exit 5: stop and ask the user to run `annotate init` (it needs their browser). Don't work around it.
- `annotate` not on PATH: try `node packages/cli/dist/annotate.mjs`, else ask the user to install it.

## Routine: one issue at a time

1. **Pick.** Run `annotate issues --json` → `{"issues": [...]}`. Take the issue the user named, else the oldest with `claimedBy: null`.
2. **Claim.** Run `annotate claim <n>`. Exit 4 means another agent holds it: pick a different one. For a long job, use `--minutes 90` (max 240).
3. **Read.** Run `annotate show <n> --json` and `annotate screenshot <n>`. The latter prints a path: open that image with the Read tool to see what the reporter saw (`--context` gives the full viewport). Read:
   - `notes`, and every entry in `comments` (later comments refine or change the request);
   - `pageUrl`, plus `env.viewport.width` (the bug may only appear at that width);
   - `context.element` (`html`, `text`, `landmark`, `styles`), `selector`, `env.consoleErrors`.
4. **Locate.** Start from `resolvedSources[].files`: local paths relative to the git root, nearest the element first, `:line` when known, directories ending in `/`. If that's empty or wrong, grep for the classes in `selector` or `context.element.html`, the `landmark`, or the element's `text`. Before editing, confirm that the file really renders this element.
5. **Fix.** Make the smallest change that addresses the report, following the project's conventions. Don't refactor or restyle unrelated code.
6. **Verify.**
   - Run the build, lint and tests that cover the change.
   - If you can render the page (dev server, Playwright, a screenshot), check it at the reported viewport width.
   - If you can't verify visually, say so in the resolve note.
7. **Commit.** Commit only this fix, e.g. `Fix hero CTA overlapping the menu on mobile (annotate #12)`.
8. **Resolve.** Run `annotate resolve <n> --note "<what changed, in plain words for the client>" --commit auto`. The issue moves to "Ready for review", and a human confirms it on the site.

Then go back to step 1 for the next issue.

## Rules

- Never claim, in a note or to the user, that something is fixed without verifying it.
- Blocked, unclear, or not a code problem (content, hosting, a third-party embed)? Run `annotate comment <n> "<findings, what you tried, what you need>"`, then `annotate release <n>`. Don't guess.
- Never reopen issues on the human's behalf, and don't touch issues in `review` or `resolved` unless asked. Confirming and reopening are the human's decisions.
- Work one issue at a time: claim, fix, then resolve (or release) before you claim the next.
- Keep notes and comments short and factual. They appear on the Trello card and the pin, where the client reads them.

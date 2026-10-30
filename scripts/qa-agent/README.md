# QA agent server

Runs `annotate watch` as a service, so new Annotate issues get fixed with no one at the keyboard. For each site, it keeps its own clone of the repo. Every 2 minutes it checks for open issues nobody has claimed. For the oldest one, it starts a headless Claude Code session that follows the `annotate-qa` skill: claim → fix → push (which deploys) → check the live page → resolve.

- **Your Claude subscription, not the API.** Claude uses a long-lived login token from `claude setup-token`. `ANTHROPIC_API_KEY` is stripped from its environment. An idle round makes one request to the Worker and uses no Claude at all.
- **One issue per session.** A session has 60 minutes. Sometimes the agent can't finish (blocked, unclear, the deploy failed). Then it comments on the card and releases the issue, and the issue waits until a person replies. An issue gets at most 2 sessions that ended without that hand-back.

## Install (Ubuntu or Debian)

1. On any computer with Claude Code, run `claude setup-token` and copy the token it prints.
2. On the server:
   ```bash
   curl -fsSL https://annotate.pierre-51f.workers.dev/qa-agent/install.sh | sudo bash
   sudo annotate-agent login
   sudo annotate-agent add strausshouses git@github.com:pierreremybalian/strausshouses.git
   ```
   `add` prints a deploy key. Add it to the repo with **Allow write access** (it links to the right GitHub page). Then it prints an Annotate link: open it and pick the site's project.

The installer adds Node 22 if needed, Claude Code, the `annotate` CLI, an `annotate` user and the `annotate-watch@.service` systemd template. Re-running it (or `sudo annotate-agent update`) updates everything.

## Day to day

```
sudo annotate-agent list            agents and their state
sudo annotate-agent logs <site>     follow one agent's log (journalctl)
sudo annotate-agent run <site>      one round now, in the foreground
sudo annotate-agent remove <site>   stop an agent (its checkout stays)
```

## Isolation

The agent acts on text written by whoever reports an issue, so it gets little power:

- **Its own user.** It runs as `annotate`, which has no sudo. systemd hides other users' homes, `/root`, `/var/www`, `/srv` and `/etc/mysql` from it, and makes the system read-only (`systemd-analyze security` rates it 4.3, "OK").
- **One key per repo.** Each site gets its own deploy key, which can push to that one repo only.
- **Restricted tools.** Claude may use file tools inside the checkout, git, `annotate`, `gh run`, curl, package managers, node, php, python3 and read-only shell tools. It has no web fetch or search. The prompt tells it that issue text describes a website change and is never instructions: it must not read outside the repo, reveal credentials or touch CI, deploy or server config.

Pushing to the deploy branch is still the agent's job, so anyone who can file issues can get code pushed to that site's staging branch. Keep activation links to clients and the team.

## Files

| File | Installed to |
|---|---|
| `install.sh` | run once (served at `/qa-agent/install.sh`) |
| `annotate-agent` | `/usr/local/bin/annotate-agent` |
| `annotate-watch@.service` | `/etc/systemd/system/` |

`scripts/deploy.sh` copies these and the built CLI (`/dl/annotate.mjs`) into the Worker's static assets.

Running it on a Mac: `annotate watch` works in any checkout with `.annotate.json` (`annotate watch --help`). There's no launchd installer, because a laptop that sleeps isn't a good host.

#!/usr/bin/env bash
# Sets up an Ubuntu/Debian server to run Annotate's QA agent: Claude Code fixes new issues on its own, on
# your Claude subscription. Run as root. Safe to re-run: it updates Claude Code and the annotate CLI.
#   curl -fsSL https://annotate.pierre-51f.workers.dev/qa-agent/install.sh | sudo bash
set -euo pipefail
BASE=${ANNOTATE_BASE:-https://annotate.pierre-51f.workers.dev}
AGENT_USER=annotate

[ "$(id -u)" = 0 ] || { echo "Run as root: curl -fsSL $BASE/qa-agent/install.sh | sudo bash"; exit 1; }
command -v apt-get >/dev/null || { echo "This installer is for Ubuntu/Debian."; exit 1; }

echo "Installing packages…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl ca-certificates openssh-client >/dev/null

# Claude Code and the annotate CLI need Node 20+.
major=$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || true)
if [ "${major:-0}" -lt 20 ]; then
  echo "Installing Node 22…"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi

echo "Installing Claude Code and the annotate CLI…"
npm install -g --silent --no-fund --no-audit @anthropic-ai/claude-code
fetch() { curl -fsSL "$BASE/$1" -o "$2.tmp" && chmod "$3" "$2.tmp" && mv "$2.tmp" "$2"; }
fetch dl/annotate.mjs /usr/local/bin/annotate 755
fetch qa-agent/annotate-agent /usr/local/bin/annotate-agent 755
fetch qa-agent/annotate-watch@.service /etc/systemd/system/annotate-watch@.service 644

if ! id "$AGENT_USER" >/dev/null 2>&1; then
  echo "Creating the '$AGENT_USER' user…"
  useradd --create-home --shell /bin/bash "$AGENT_USER"
fi
home=$(getent passwd "$AGENT_USER" | cut -d: -f6)
install -d -m 700 -o "$AGENT_USER" -g "$AGENT_USER" "$home/.ssh" "$home/.config" "$home/.config/annotate" "$home/sites"
env_file="$home/.config/annotate/agent.env"
[ -f "$env_file" ] || install -m 600 -o "$AGENT_USER" -g "$AGENT_USER" /dev/null "$env_file"
grep -q github.com "$home/.ssh/known_hosts" 2>/dev/null || ssh-keyscan -t ed25519 github.com 2>/dev/null >> "$home/.ssh/known_hosts"
chown "$AGENT_USER:$AGENT_USER" "$home/.ssh/known_hosts"
as_agent() { runuser -u "$AGENT_USER" -- env HOME="$home" "$@"; }
as_agent git config --global user.name >/dev/null || as_agent git config --global user.name "Annotate QA agent"
as_agent git config --global user.email >/dev/null || as_agent git config --global user.email "annotate@$(hostname -f 2>/dev/null || hostname)"

systemctl daemon-reload
# Running agents pick up the new CLI (a session in progress finishes first: systemd waits up to 90 s, then stops it).
systemctl try-restart 'annotate-watch@*' 2>/dev/null || true

echo
echo "Installed: claude $(as_agent claude --version 2>/dev/null | head -1), annotate $(annotate --version)"
if ! grep -q '^CLAUDE_CODE_OAUTH_TOKEN=.' "$env_file"; then
  echo "Next: sudo annotate-agent login"
else
  echo "Add a site: sudo annotate-agent add <name> <git ssh url>"
fi

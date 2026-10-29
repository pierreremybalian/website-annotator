#!/usr/bin/env bash
# Production deploy: build the widget, deploy the Worker, point PUBLIC_URL at it, upload secrets.
# Reads Trello credentials from packages/worker/.prod.vars (gitignored); generates the Worker's
# own secrets there on first run. Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")/../packages/worker"
VARS=.prod.vars
[ -f "$VARS" ] || { echo "Missing packages/worker/$VARS"; exit 1; }

grep -qE '^TOKEN_ENC_KEY=.+' "$VARS" || echo "TOKEN_ENC_KEY=$(openssl rand -base64 32)" >> "$VARS"
grep -qE '^SIGNING_SECRET=.+' "$VARS" || echo "SIGNING_SECRET=$(openssl rand -base64 32)" >> "$VARS"
set -a; . "./$VARS"; set +a
: "${TRELLO_KEY:?TRELLO_KEY is empty in $VARS}"
: "${TRELLO_SECRET:?TRELLO_SECRET is empty in $VARS}"

pnpm --filter @annotate/widget build

out=$(npx wrangler deploy 2>&1) || { echo "$out"; exit 1; }
url=$(grep -oE 'https://[a-z0-9.-]+\.workers\.dev' <<<"$out" | head -1)
[ -n "$url" ] || { echo "$out"; echo "Couldn't find the workers.dev URL above."; exit 1; }

if ! grep -q "^PUBLIC_URL = \"$url\"" wrangler.toml; then
  sed -i '' "s#^PUBLIC_URL = .*#PUBLIC_URL = \"$url\"#" wrangler.toml
  npx wrangler deploy >/dev/null
fi

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
node -e 'const k=["TRELLO_KEY","TRELLO_SECRET","TOKEN_ENC_KEY","SIGNING_SECRET"];console.log(JSON.stringify(Object.fromEntries(k.map(n=>[n,process.env[n]]))))' > "$tmp"
npx wrangler secret bulk "$tmp" >/dev/null

curl -fsS "$url/health" >/dev/null && echo "Deployed and healthy: $url"

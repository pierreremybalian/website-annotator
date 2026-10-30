#!/usr/bin/env bash
# Production deploy: apply D1 migrations, build the widget, deploy the Worker, point PUBLIC_URL at it,
# upload secrets. Reads Trello credentials from packages/worker/.prod.vars (gitignored); generates the
# Worker's own secrets there on first run. Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")/../packages/worker"
VARS=.prod.vars
[ -f "$VARS" ] || { echo "Missing packages/worker/$VARS"; exit 1; }

# Some wrangler commands (d1 migrations) ignore account_id in wrangler.toml when the login can see
# several accounts, so pass it explicitly.
CLOUDFLARE_ACCOUNT_ID=$(sed -nE 's/^account_id = "([0-9a-f]+)".*/\1/p' wrangler.toml)
[ -n "$CLOUDFLARE_ACCOUNT_ID" ] || { echo "No account_id in wrangler.toml"; exit 1; }
export CLOUDFLARE_ACCOUNT_ID

# Migrations are additive, so they go first: the running Worker keeps working against the new schema.
# D1 sometimes rejects the first request after wrangler refreshes its OAuth login (error 7403); retry.
for attempt in 1 2 3; do
  npx wrangler d1 migrations apply annotate --remote && break
  [ "$attempt" = 3 ] && exit 1
  echo "D1 request failed (attempt $attempt); retrying in 5s…"
  sleep 5
done

grep -qE '^TOKEN_ENC_KEY=.+' "$VARS" || echo "TOKEN_ENC_KEY=$(openssl rand -base64 32)" >> "$VARS"
grep -qE '^SIGNING_SECRET=.+' "$VARS" || echo "SIGNING_SECRET=$(openssl rand -base64 32)" >> "$VARS"
set -a; . "./$VARS"; set +a
: "${TRELLO_KEY:?TRELLO_KEY is empty in $VARS}"
: "${TRELLO_SECRET:?TRELLO_SECRET is empty in $VARS}"

pnpm --filter @annotate/widget build
# The CLI and the QA agent installer are served from the Worker too (curl … | sudo bash on a server).
pnpm --filter @annotate/cli build >/dev/null
mkdir -p public/dl public/qa-agent
cp ../cli/dist/annotate.mjs public/dl/annotate.mjs
cp ../../scripts/qa-agent/install.sh ../../scripts/qa-agent/annotate-agent ../../scripts/qa-agent/annotate-watch@.service public/qa-agent/

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

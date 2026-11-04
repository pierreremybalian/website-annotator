-- One-off, after migration 0006: the first agency. Moves every project connected before accounts into
-- Balian Design, with pierre@baliandesign.com as its owner. Not a migration, so tests and other installs
-- don't get it. Safe to re-run.
-- Run it as a command: --file goes through D1's import API, which a wrangler OAuth login can't use.
--   cd packages/worker && npx wrangler d1 execute annotate --remote --command "$(grep -v '^--' ../../scripts/bootstrap-balian.sql)"
-- Done for production on 2026-11-04.
INSERT OR IGNORE INTO users (id, email, name, created_at) VALUES ('usr_pierre', 'pierre@baliandesign.com', 'Pierre Balian', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
INSERT OR IGNORE INTO orgs (id, name, created_at, updated_at) VALUES ('org_balian', 'Balian Design', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
INSERT OR IGNORE INTO memberships (org_id, user_id, role, created_at)
  SELECT 'org_balian', id, 'owner', strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM users WHERE email = 'pierre@baliandesign.com';
UPDATE projects SET org_id = 'org_balian', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE org_id IS NULL;
-- Projects connected the old way (the Trello popup) join this org until connecting asks for an Annotate login.
INSERT OR REPLACE INTO settings (key, value) VALUES ('legacy_org', 'org_balian');

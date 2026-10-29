-- 0.2: review status, context capture, agent claims, agent tokens, CLI hand-off.
ALTER TABLE projects ADD COLUMN review_list_id TEXT;      -- Trello "Ready for review" list; created lazily if null

ALTER TABLE issues ADD COLUMN context TEXT;               -- JSON IssueContext (null for pre-0.2 reports)
ALTER TABLE issues ADD COLUMN claimed_by TEXT;
ALTER TABLE issues ADD COLUMN claimed_until INTEGER;      -- epoch ms
ALTER TABLE issues ADD COLUMN resolution TEXT;            -- latest resolve note
CREATE UNIQUE INDEX issues_number ON issues (project_id, number);

CREATE TABLE agent_tokens (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,   -- hex SHA-256 of the full token ("at_…")
  label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX agent_tokens_project ON agent_tokens (project_id);

CREATE TABLE cli_sessions (
  id TEXT PRIMARY KEY,
  verifier_hash TEXT NOT NULL,       -- base64url SHA-256 of the CLI's verifier
  mode TEXT NOT NULL,                -- 'connect' | 'link'
  label TEXT,
  site_url TEXT,
  result_enc TEXT,                   -- AES-GCM JSON CliResult once the browser finishes
  expires_at INTEGER NOT NULL        -- epoch ms
);

ALTER TABLE connect_sessions ADD COLUMN cli_session_id TEXT;

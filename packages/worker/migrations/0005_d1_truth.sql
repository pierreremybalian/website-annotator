-- 0.3: D1 is the source of truth (issues, statuses and comments); Trello becomes an optional per-project sync,
-- so its columns go nullable. SQLite can't drop NOT NULL in place, so projects, issues and agent_tokens are
-- rebuilt. D1 keeps foreign keys on and DROP TABLE on a parent runs its ON DELETE CASCADE: the children are
-- copied out and dropped first, so dropping projects has nothing to cascade into. Column names are unchanged,
-- so the 0.2 Worker keeps running on this schema.
PRAGMA defer_foreign_keys = on;

CREATE TABLE _projects AS SELECT * FROM projects;
CREATE TABLE _issues AS SELECT * FROM issues;
CREATE TABLE _agent_tokens AS SELECT * FROM agent_tokens;
DROP TABLE agent_tokens;
DROP TABLE issues;
DROP TABLE projects;

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  public_key TEXT NOT NULL UNIQUE,
  access_key TEXT NOT NULL,
  allowed_origins TEXT NOT NULL DEFAULT '[]',   -- JSON string[] of origins, e.g. ["https://client.com"]
  next_number INTEGER NOT NULL DEFAULT 1,
  ignore_query INTEGER NOT NULL DEFAULT 0,
  -- Trello sync: all null for a project without a board
  trello_token_enc TEXT,                        -- AES-GCM, see src/crypto.ts
  trello_member_id TEXT,
  trello_board_id TEXT,
  trello_board_name TEXT,
  trello_board_url TEXT,
  new_list_id TEXT,
  done_list_ids TEXT NOT NULL DEFAULT '[]',     -- JSON string[]
  review_list_id TEXT,
  progress_list_id TEXT,
  webhook_id TEXT,
  token_revoked INTEGER NOT NULL DEFAULT 0,
  trello_error TEXT,                            -- last failed push, shown in the dashboard
  trello_reconciled_at INTEGER,                 -- epoch ms of the last cron pull of the board
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO projects (id, name, public_key, access_key, allowed_origins, next_number, ignore_query, trello_token_enc,
  trello_member_id, trello_board_id, trello_board_name, trello_board_url, new_list_id, done_list_ids, review_list_id,
  progress_list_id, webhook_id, token_revoked, created_at, updated_at)
SELECT id, name, public_key, access_key, allowed_origins, next_number, ignore_query, trello_token_enc,
  trello_member_id, trello_board_id, trello_board_name, trello_board_url, new_list_id, done_list_ids, review_list_id,
  progress_list_id, webhook_id, token_revoked, created_at, updated_at FROM _projects;

CREATE TABLE issues (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  page_url TEXT NOT NULL,                       -- normalized, see src/url.ts
  page_url_raw TEXT NOT NULL,
  title TEXT NOT NULL,
  notes TEXT NOT NULL,
  anchor TEXT NOT NULL,                         -- JSON Anchor
  env TEXT NOT NULL,                            -- JSON CaptureEnv
  context TEXT,                                 -- JSON IssueContext (null for pre-0.2 reports)
  reporter_name TEXT NOT NULL,
  reporter_email TEXT NOT NULL,                 -- as typed in the widget: unverified
  screenshot_key TEXT NOT NULL,
  context_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  status_at INTEGER,                            -- epoch ms of the last status change made in Annotate
  claimed_by TEXT,
  claimed_until INTEGER,                        -- epoch ms
  resolution TEXT,                              -- latest resolve note
  trello_card_id TEXT,
  trello_short_url TEXT,
  trello_list_id TEXT,                          -- list the card was last moved to or seen in
  trello_pending INTEGER NOT NULL DEFAULT 0,    -- 1 = a push to Trello failed; the cron retries
  comments_imported_at TEXT,                    -- null = the card's Trello comments aren't in D1 yet
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO issues (id, project_id, number, page_url, page_url_raw, title, notes, anchor, env, context, reporter_name,
  reporter_email, screenshot_key, context_key, status, claimed_by, claimed_until, resolution, trello_card_id,
  trello_short_url, created_at, updated_at)
SELECT id, project_id, number, page_url, page_url_raw, title, notes, anchor, env, context, reporter_name,
  reporter_email, screenshot_key, context_key, status, claimed_by, claimed_until, resolution, trello_card_id,
  trello_short_url, created_at, updated_at FROM _issues;

CREATE TABLE agent_tokens (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,              -- hex SHA-256 of the full token ("at_…")
  label TEXT NOT NULL,
  created_by TEXT,                              -- users.id; null = minted before accounts
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
INSERT INTO agent_tokens (id, project_id, token_hash, label, created_at, last_used_at)
SELECT id, project_id, token_hash, label, created_at, last_used_at FROM _agent_tokens;

DROP TABLE _agent_tokens;
DROP TABLE _issues;
DROP TABLE _projects;

CREATE INDEX projects_board ON projects (trello_board_id);
CREATE INDEX issues_page ON issues (project_id, page_url);
CREATE INDEX issues_board ON issues (project_id, status);
CREATE UNIQUE INDEX issues_card ON issues (trello_card_id);
CREATE UNIQUE INDEX issues_number ON issues (project_id, number);
CREATE INDEX issues_trello_pending ON issues (project_id) WHERE trello_pending = 1;
CREATE INDEX issues_comments_todo ON issues (project_id) WHERE comments_imported_at IS NULL AND trello_card_id IS NOT NULL;
CREATE INDEX agent_tokens_project ON agent_tokens (project_id);

-- A later rebuild of issues must copy comments out first, for the same cascade reason.
CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues (id) ON DELETE CASCADE,
  via TEXT NOT NULL,                            -- 'widget' | 'agent' | 'trello' | 'app'
  author_name TEXT NOT NULL,
  author_email TEXT,                            -- widget: as typed (unverified); app: the logged-in user's
  user_id TEXT,                                 -- app comments
  text TEXT NOT NULL,
  trello_action_id TEXT UNIQUE,                 -- the Trello comment this mirrors (pushed or imported)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX comments_issue ON comments (issue_id, created_at);

PRAGMA defer_foreign_keys = off;

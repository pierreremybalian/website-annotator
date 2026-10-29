CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  public_key TEXT NOT NULL UNIQUE,
  access_key TEXT NOT NULL,
  allowed_origins TEXT NOT NULL DEFAULT '[]',   -- JSON string[] of origins, e.g. ["https://client.com"]
  trello_token_enc TEXT NOT NULL,               -- AES-GCM, see src/crypto.ts
  trello_member_id TEXT NOT NULL,
  trello_board_id TEXT NOT NULL,
  trello_board_name TEXT NOT NULL,
  trello_board_url TEXT NOT NULL,
  new_list_id TEXT NOT NULL,
  done_list_ids TEXT NOT NULL DEFAULT '[]',     -- JSON string[]
  webhook_id TEXT,
  token_revoked INTEGER NOT NULL DEFAULT 0,
  next_number INTEGER NOT NULL DEFAULT 1,
  ignore_query INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX projects_board ON projects (trello_board_id);

CREATE TABLE connect_sessions (
  id TEXT PRIMARY KEY,
  opener_origin TEXT,          -- origin to postMessage the result to; null for standalone use
  site_name TEXT,
  site_url TEXT,
  project_id TEXT,             -- set when reconnecting an existing project
  trello_token_enc TEXT,
  trello_member_id TEXT,
  expires_at INTEGER NOT NULL  -- epoch ms
);

CREATE TABLE issues (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  trello_card_id TEXT NOT NULL,
  trello_short_url TEXT NOT NULL,
  page_url TEXT NOT NULL,      -- normalized, see src/url.ts
  page_url_raw TEXT NOT NULL,
  title TEXT NOT NULL,
  notes TEXT NOT NULL,
  anchor TEXT NOT NULL,        -- JSON Anchor
  env TEXT NOT NULL,           -- JSON CaptureEnv
  reporter_name TEXT NOT NULL,
  reporter_email TEXT NOT NULL,
  screenshot_key TEXT NOT NULL,
  context_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX issues_page ON issues (project_id, page_url);
CREATE UNIQUE INDEX issues_card ON issues (trello_card_id);

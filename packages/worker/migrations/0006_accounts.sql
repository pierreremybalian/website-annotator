-- 0.3: accounts. People log in with a link or code sent by email. An org (an agency) has members with a role;
-- a client sees only the projects listed for them in project_members. Every project belongs to one org.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,                   -- lowercased and trimmed
  name TEXT NOT NULL DEFAULT '',
  email_verified_at TEXT,                       -- first login; null = invited, never logged in
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free',            -- room for billing; nothing reads it yet
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE memberships (
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'client')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX memberships_user ON memberships (user_id);

-- The projects a 'client' sees. Other roles see every project in their org and have no rows here.
CREATE TABLE project_members (
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX project_members_user ON project_members (user_id);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,                  -- hex SHA-256 of the cookie value
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,                  -- epoch ms
  seen_at INTEGER NOT NULL,                     -- bumped at most daily
  expires_at INTEGER NOT NULL                   -- seen_at + 30 days (sliding)
);
CREATE INDEX sessions_user ON sessions (user_id);

-- One login: a link (in the email) and a 6-digit code (also in the email, for popups and other devices).
CREATE TABLE login_tokens (
  id TEXT PRIMARY KEY,                          -- also the requesting browser's login cookie value
  kind TEXT NOT NULL,                           -- 'login' (link + code, 15 min) | 'invite' (link only, 7 days)
  email TEXT NOT NULL,
  link_hash TEXT NOT NULL UNIQUE,               -- hex SHA-256 of the link secret
  code_hash TEXT,                               -- base64 HMAC-SHA256(SIGNING_SECRET, 'login:<id>:<code>')
  attempts INTEGER NOT NULL DEFAULT 0,          -- wrong codes; 5 kills the token
  next TEXT,                                    -- same-origin path to go to after logging in
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX login_tokens_email ON login_tokens (email);

CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,                         -- e.g. 'login:email:<email>', 'login:ip:<ip>', 'mail:day'
  window_start INTEGER NOT NULL,                -- epoch ms
  count INTEGER NOT NULL
);

-- Null = not adopted by an org yet (projects connected before accounts). No cascade: deleting an org is explicit.
ALTER TABLE projects ADD COLUMN org_id TEXT REFERENCES orgs (id);
CREATE INDEX projects_org ON projects (org_id);

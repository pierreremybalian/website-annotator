-- Small key/value store. 'owner' = JSON { memberId, orgIds } of the first Trello member to connect.
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

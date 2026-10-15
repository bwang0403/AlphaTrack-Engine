CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE,
  password_hash TEXT,
  password_salt TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('registered', 'demo')),
  created_at TEXT NOT NULL,
  CHECK ((kind = 'registered' AND username IS NOT NULL AND password_hash IS NOT NULL AND password_salt IS NOT NULL)
      OR (kind = 'demo' AND username IS NULL AND password_hash IS NULL AND password_salt IS NULL))
);

-- Preserve existing paper accounts and active sessions during rollout.
INSERT INTO users (id, kind, created_at)
SELECT id, 'demo', created_at FROM accounts;

ALTER TABLE sessions ADD COLUMN user_id TEXT REFERENCES users(id);
UPDATE sessions SET user_id = account_id;
CREATE INDEX sessions_user_id_idx ON sessions(user_id);

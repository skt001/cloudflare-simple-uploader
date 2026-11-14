ALTER TABLE files ADD COLUMN download_password_hash TEXT;
ALTER TABLE files ADD COLUMN delete_key_hash TEXT;

CREATE TABLE file_download_tokens (
  token_hash TEXT PRIMARY KEY NOT NULL,
  file_id TEXT NOT NULL REFERENCES files (id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
) STRICT;

CREATE INDEX file_download_tokens_expires ON file_download_tokens (expires_at);

CREATE TABLE file_auth_attempts (
  file_id TEXT NOT NULL REFERENCES files (id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('download', 'delete')),
  window_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  PRIMARY KEY (file_id, purpose)
) STRICT;

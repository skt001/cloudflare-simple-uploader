CREATE TABLE files (
  id TEXT PRIMARY KEY NOT NULL,
  file_no INTEGER NOT NULL UNIQUE,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size > 0),
  comment TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  download_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('uploading', 'ready'))
) STRICT;

CREATE INDEX files_status_file_no ON files (status, file_no DESC);

CREATE TABLE file_chunks (
  file_id TEXT NOT NULL REFERENCES files (id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  data BLOB NOT NULL,
  PRIMARY KEY (file_id, chunk_index)
) STRICT;

-- Receipt photos and other attachments. The bytes live in R2 (the muninn-backups bucket, under files/), sealed with
-- DATA_KEY and the file id, so neither R2 nor a D1 export alone reveals them. Only metadata is here.
CREATE TABLE files (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX files_item ON files(item_id);

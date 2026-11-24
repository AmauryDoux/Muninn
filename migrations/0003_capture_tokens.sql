-- Capture-only tokens for iOS Shortcuts (Action button, Siri, Share sheet).
-- A token can add a note and nothing else: it cannot read, search or change anything.
-- Only the SHA-256 of the token is stored; the token itself is shown once.
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL CHECK (scope IN ('capture')),
  created_at TEXT NOT NULL,
  last_used_at TEXT
) STRICT;

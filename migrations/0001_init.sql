-- Muninn v1 schema. Ids are ULIDs. Times are ISO-8601 UTC strings.
-- Columns ending in _enc hold AES-256-GCM ciphertext (base64url "iv.ct"), with the row id as associated data.

CREATE TABLE captures (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('text', 'voice')),
  raw_text_enc TEXT NOT NULL,
  transcript_enc TEXT,
  client_id TEXT UNIQUE,        -- idempotency key from the offline capture queue
  parse_enc TEXT,               -- validated model output (holds note text, so encrypted)
  parser_version TEXT NOT NULL,
  model TEXT
) STRICT;

CREATE TABLE items (
  id TEXT PRIMARY KEY,
  capture_id TEXT REFERENCES captures(id),
  kind TEXT NOT NULL CHECK (kind IN ('task', 'note', 'fact', 'event')),
  title_enc TEXT NOT NULL,
  details_enc TEXT,
  for_person_id TEXT REFERENCES people(id),
  requested_by_person_id TEXT REFERENCES people(id),
  window_start TEXT,
  window_end TEXT,
  due_at TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'dropped')),
  place_hint TEXT,
  confidence REAL,
  recurrence TEXT,
  snoozed_until TEXT,
  reminded_start_at TEXT,
  reminded_end_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX items_status_window ON items(status, window_start);
CREATE INDEX items_created ON items(created_at);
CREATE INDEX items_requested_by ON items(requested_by_person_id, created_at);
CREATE INDEX items_for ON items(for_person_id, created_at);

CREATE TABLE people (
  id TEXT PRIMARY KEY,
  name_enc TEXT NOT NULL,
  aliases_enc TEXT NOT NULL,    -- encrypted JSON array of lowercase aliases
  relation TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE facts (
  id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('person', 'me', 'thing')),
  subject_id TEXT,
  key TEXT NOT NULL,
  value_enc TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('told', 'asked', 'observed')),
  confidence REAL NOT NULL DEFAULT 1,
  review_after TEXT,
  created_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
) STRICT;
CREATE INDEX facts_subject ON facts(subject_type, subject_id, key, active);

CREATE TABLE patterns (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  value_json TEXT NOT NULL,
  sample_size INTEGER NOT NULL,
  computed_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  user_locked INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  type TEXT NOT NULL,           -- correction, act, snooze, dismiss, done, push_sent, push_opened, model_usage, ...
  item_id TEXT,
  nudge_type TEXT,
  payload_json TEXT
) STRICT;
CREATE INDEX events_type_at ON events(type, at);

CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  device_label TEXT,
  created_at TEXT NOT NULL,
  last_ok_at TEXT
) STRICT;

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

-- Additions to the spec's eight tables, kept separate so auth state is easy to audit.

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,     -- SHA-256 of the cookie value; the raw value is never stored
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  reauth_at TEXT NOT NULL,      -- last strong check, for sensitive screens
  version INTEGER NOT NULL,     -- must equal settings.session_version ("sign out all devices")
  user_agent TEXT
) STRICT;

CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,          -- credential id, base64url
  public_key TEXT NOT NULL,     -- COSE public key, base64url
  counter INTEGER NOT NULL,
  transports TEXT,
  label TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT
) STRICT;

CREATE TABLE auth_attempts (
  ip_hash TEXT NOT NULL,
  at TEXT NOT NULL
) STRICT;
CREATE INDEX auth_attempts_ip ON auth_attempts(ip_hash, at);

-- Fallback vector store used when no Vectorize binding is configured.
CREATE TABLE capture_vectors (
  capture_id TEXT PRIMARY KEY REFERENCES captures(id),
  item_id TEXT,
  created_at TEXT NOT NULL,
  vec BLOB NOT NULL             -- Float32Array, little-endian
) STRICT;

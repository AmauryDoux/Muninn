-- Narrow tokens: "capture" for iOS Shortcuts (Action button, Siri, Share sheet), "calendar" for a calendar feed,
-- "nudge" for arrival automations.
-- A capture token can add a note and nothing else. A calendar token can only read dated item titles as iCalendar.
-- A nudge token can only ask for a push about open items at a place; the titles go to your devices, not the caller.
-- Only the SHA-256 of the token is stored; the token itself is shown once.
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL CHECK (scope IN ('capture', 'calendar', 'nudge')), -- calendar: read-only feed; nudge: arrival pushes
  created_at TEXT NOT NULL,
  last_used_at TEXT
) STRICT;

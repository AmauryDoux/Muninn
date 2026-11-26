-- Linked Google accounts (read-only Calendar access), their calendars, and a cache of their events.
-- Tokens, emails, calendar ids and names, event titles and places are encrypted (AES-GCM, AAD table:id:column).
CREATE TABLE google_accounts (
  id TEXT PRIMARY KEY,
  -- HMAC of Google's stable account id ("sub"), so linking the same account again updates it instead of adding one.
  sub_mac TEXT NOT NULL UNIQUE,
  email_enc TEXT NOT NULL,
  refresh_token_enc TEXT NOT NULL,
  access_token_enc TEXT,
  access_expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'revoked')),
  last_error TEXT,
  created_at TEXT NOT NULL,
  calendars_synced_at TEXT
) STRICT;

CREATE TABLE google_calendars (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES google_accounts(id) ON DELETE CASCADE,
  -- HMAC of account id + Google's calendar id: finds the row again on the next calendar list without decrypting.
  cal_mac TEXT NOT NULL UNIQUE,
  cal_id_enc TEXT NOT NULL,
  name_enc TEXT NOT NULL,
  color TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  -- Hash of the last event list fetched: an unchanged calendar costs no writes.
  events_hash TEXT,
  synced_at TEXT,
  last_error TEXT
) STRICT;
CREATE INDEX google_calendars_account ON google_calendars(account_id);

CREATE TABLE calendar_events (
  id TEXT PRIMARY KEY,
  calendar_id TEXT NOT NULL REFERENCES google_calendars(id) ON DELETE CASCADE,
  -- Google's etag: a row is rewritten only when the event changed.
  etag TEXT NOT NULL,
  all_day INTEGER NOT NULL,
  -- Timed: UTC instants. All-day: local dates YYYY-MM-DD, end exclusive. Not encrypted: times, like items'.
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  title_enc TEXT NOT NULL,
  location_enc TEXT
) STRICT;
CREATE INDEX calendar_events_range ON calendar_events(start_at);
CREATE INDEX calendar_events_calendar ON calendar_events(calendar_id);

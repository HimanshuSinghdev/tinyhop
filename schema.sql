-- Tinyhop database schema (Cloudflare D1 / SQLite).
-- This is the single source of truth. The Worker applies it on first request
-- (every statement is idempotent), so there is nothing to run by hand.

-- One row per short link. We never store who created it, only a hash of the
-- secret "manage key" that lets the creator see stats and delete the link.
CREATE TABLE IF NOT EXISTS links (
  code          TEXT PRIMARY KEY,
  url           TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER,
  token_hash    TEXT NOT NULL,
  clicks        INTEGER NOT NULL DEFAULT 0,
  last_click_at INTEGER
);

-- One row per human click. No IP address, no user agent string, no cookies.
-- Only coarse facts: day, country, device type, browser family, referrer host.
CREATE TABLE IF NOT EXISTS clicks (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  code     TEXT NOT NULL,
  ts       INTEGER NOT NULL,
  day      TEXT NOT NULL,
  country  TEXT NOT NULL,
  device   TEXT NOT NULL,
  browser  TEXT NOT NULL,
  referrer TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_clicks_code_ts ON clicks (code, ts);

-- Short-lived counters for rate limiting. The key is a salted hash, rows are
-- deleted when their window ends.
CREATE TABLE IF NOT EXISTS rate_limits (
  key        TEXT PRIMARY KEY,
  count      INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Abuse reports from the public "Report a link" form. We do not store who reported.
CREATE TABLE IF NOT EXISTS reports (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  code    TEXT NOT NULL,
  reason  TEXT NOT NULL,
  details TEXT NOT NULL,
  ts      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reports_ts ON reports (ts);

CREATE TABLE IF NOT EXISTS apps (
  app_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS records (
  scope TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  collection TEXT NOT NULL,
  record_key TEXT NOT NULL,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, owner_id, collection, record_key)
);

CREATE TABLE IF NOT EXISTS onay_sync_devices (
  token_hash TEXT PRIMARY KEY,
  phone_hash TEXT NOT NULL,
  device_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS device_pairings (
  code_hash TEXT PRIMARY KEY,
  phone_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pair_rate_limits (
  rate_key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id TEXT NOT NULL,
  action TEXT NOT NULL,
  scope TEXT NOT NULL,
  collection TEXT NOT NULL,
  record_key TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_device_pairings_expires_at ON device_pairings(expires_at);
CREATE INDEX IF NOT EXISTS idx_pair_rate_limits_window_start ON pair_rate_limits(window_start);


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

-- The central source of truth that a phone number has completed registration.
-- The phone itself is stored as a hash; the device id identifies the first
-- registered device that can approve pairing requests for that number.
CREATE TABLE IF NOT EXISTS registered_phones (
  phone_hash TEXT PRIMARY KEY,
  owner_device_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS device_pairings (
  code_hash TEXT PRIMARY KEY,
  phone_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pair_requests (
  request_id TEXT PRIMARY KEY,
  phone_hash TEXT NOT NULL,
  requester_device_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired','claimed')),
  pair_code_hash TEXT,
  payload_json TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  approved_at INTEGER,
  claimed_at INTEGER
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
CREATE INDEX IF NOT EXISTS idx_pair_requests_phone_status ON pair_requests(phone_hash, status, created_at);
CREATE INDEX IF NOT EXISTS idx_pair_requests_expires_at ON pair_requests(expires_at);
CREATE INDEX IF NOT EXISTS idx_pair_requests_requester_status ON pair_requests(phone_hash, requester_device_id, status, created_at);

CREATE TABLE IF NOT EXISTS pair_presence (
  phone_hash TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  last_seen INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pair_presence_expires_at ON pair_presence(expires_at);
CREATE INDEX IF NOT EXISTS idx_pair_rate_limits_window_start ON pair_rate_limits(window_start);
CREATE INDEX IF NOT EXISTS idx_registered_phones_owner_device_id ON registered_phones(owner_device_id);

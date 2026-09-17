-- RFC 8628 CLI device authorization (ADR 0016).
--
-- `devices` is deliberately separate from `connector_records`: connector_records
-- represents operator-provisioned tunnel-proxy infrastructure (POST /connectors,
-- MCP scopes only), while `devices` represents a self-enrolled CLI keypair that
-- only becomes trusted after a human approves it in the browser. See ADR 0016.

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  name TEXT NOT NULL,
  public_key_pem TEXT NOT NULL UNIQUE,
  allowed_scopes_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  refresh_token_hash TEXT,
  refresh_token_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT,
  FOREIGN KEY (principal_id) REFERENCES actors(id)
);

CREATE TABLE IF NOT EXISTS oauth_device_authorizations (
  id TEXT PRIMARY KEY,
  device_code_hash TEXT NOT NULL UNIQUE,
  user_code_hash TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  requested_scopes_json TEXT NOT NULL,
  device_public_key_pem TEXT NOT NULL,
  device_name TEXT NOT NULL,
  principal_id TEXT,
  device_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'denied', 'consumed', 'expired')),
  poll_interval_seconds INTEGER NOT NULL DEFAULT 5,
  last_polled_at TEXT,
  poll_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  approved_at TEXT,
  denied_at TEXT,
  consumed_at TEXT,
  FOREIGN KEY (principal_id) REFERENCES actors(id),
  FOREIGN KEY (device_id) REFERENCES devices(id)
);

CREATE INDEX IF NOT EXISTS idx_oauth_device_authorizations_status_expires
  ON oauth_device_authorizations (status, expires_at);

CREATE INDEX IF NOT EXISTS idx_devices_principal
  ON devices (principal_id);

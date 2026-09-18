-- Device authorization hardening: persist verifiable opaque access tokens and detect refresh-token reuse.
ALTER TABLE devices ADD COLUMN access_token_hash TEXT;
ALTER TABLE devices ADD COLUMN access_token_expires_at TEXT;
ALTER TABLE devices ADD COLUMN previous_refresh_token_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_access_token_hash
  ON devices (access_token_hash)
  WHERE access_token_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_devices_previous_refresh_token_hash
  ON devices (previous_refresh_token_hash)
  WHERE previous_refresh_token_hash IS NOT NULL;

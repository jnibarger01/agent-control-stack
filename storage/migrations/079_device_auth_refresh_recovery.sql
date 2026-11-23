-- Device refresh-token proof-of-possession client binding and AES-256-GCM idempotent recovery envelopes.
-- Stores only ciphertext + AAD-bound metadata; never raw tokens or keys.

ALTER TABLE devices ADD COLUMN client_id TEXT NOT NULL DEFAULT 'acs-cli';

CREATE TABLE IF NOT EXISTS device_refresh_recovery_envelopes (
  predecessor_refresh_token_hash TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  successor_refresh_token_hash TEXT NOT NULL,
  key_id TEXT NOT NULL,
  iv_base64url TEXT NOT NULL,
  auth_tag_base64url TEXT NOT NULL,
  ciphertext_base64url TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_device_refresh_recovery_device
  ON device_refresh_recovery_envelopes (device_id);

CREATE INDEX IF NOT EXISTS idx_device_refresh_recovery_expires
  ON device_refresh_recovery_envelopes (expires_at);

-- Device DPoP key-thumbprint binding and persistent JTI replay protection (RFC 9449).
-- Never stores raw tokens or private keys.

ALTER TABLE devices ADD COLUMN public_key_jkt TEXT;

CREATE TABLE IF NOT EXISTS device_dpop_jtis (
  jkt TEXT NOT NULL,
  jti TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (jkt, jti)
);

CREATE INDEX IF NOT EXISTS idx_device_dpop_jtis_expires
  ON device_dpop_jtis (expires_at);

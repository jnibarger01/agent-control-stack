-- Managed ACS/Desktop Commander runtime registration and short-lived capability provenance.
-- Forward-only: do not alter historical migrations.

CREATE TABLE IF NOT EXISTS desktop_commander_runtimes (
  runtime_id TEXT PRIMARY KEY,
  identity_config_fingerprint TEXT NOT NULL CHECK (length(identity_config_fingerprint) = 64 AND identity_config_fingerprint = lower(identity_config_fingerprint)),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  registered_at TEXT NOT NULL CHECK (julianday(registered_at) IS NOT NULL),
  attested_at TEXT NOT NULL CHECK (julianday(attested_at) IS NOT NULL),
  revoked_at TEXT,
  revocation_reason TEXT,
  CHECK ((status = 'active' AND revoked_at IS NULL AND revocation_reason IS NULL) OR (status = 'revoked' AND revoked_at IS NOT NULL AND revocation_reason IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS desktop_commander_runtime_scopes (
  runtime_id TEXT NOT NULL REFERENCES desktop_commander_runtimes(runtime_id),
  scope_name TEXT NOT NULL CHECK (scope_name IN ('fs.read', 'fs.write', 'process.exec', 'process.spawn', 'network.read', 'network.write')),
  PRIMARY KEY (runtime_id, scope_name)
);

CREATE TABLE IF NOT EXISTS desktop_commander_bootstrap_challenges (
  challenge_id TEXT PRIMARY KEY,
  runtime_id TEXT NOT NULL,
  challenge_hash TEXT NOT NULL UNIQUE CHECK (length(challenge_hash) = 64 AND challenge_hash = lower(challenge_hash)),
  expected_identity_config_fingerprint TEXT NOT NULL CHECK (length(expected_identity_config_fingerprint) = 64 AND expected_identity_config_fingerprint = lower(expected_identity_config_fingerprint)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'consumed', 'expired', 'aborted')),
  issued_at TEXT NOT NULL CHECK (julianday(issued_at) IS NOT NULL),
  expires_at TEXT NOT NULL CHECK (julianday(expires_at) IS NOT NULL AND julianday(expires_at) > julianday(issued_at)),
  consumed_at TEXT,
  CHECK ((status = 'consumed' AND consumed_at IS NOT NULL) OR (status <> 'consumed' AND consumed_at IS NULL))
);

CREATE TABLE IF NOT EXISTS desktop_commander_bootstrap_challenge_scopes (
  challenge_id TEXT NOT NULL REFERENCES desktop_commander_bootstrap_challenges(challenge_id),
  scope_name TEXT NOT NULL CHECK (scope_name IN ('fs.read', 'fs.write', 'process.exec', 'process.spawn', 'network.read', 'network.write')),
  PRIMARY KEY (challenge_id, scope_name)
);

CREATE TABLE IF NOT EXISTS desktop_commander_capability_issuances (
  capability_issuance_id TEXT PRIMARY KEY,
  lease_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  runtime_id TEXT NOT NULL REFERENCES desktop_commander_runtimes(runtime_id),
  action_hash TEXT NOT NULL CHECK (length(action_hash) = 64 AND action_hash = lower(action_hash)),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64 AND request_hash = lower(request_hash)),
  invocation_hash TEXT NOT NULL CHECK (length(invocation_hash) = 64 AND invocation_hash = lower(invocation_hash)),
  approval_id TEXT,
  key_id TEXT NOT NULL,
  nonce_hash TEXT NOT NULL UNIQUE CHECK (length(nonce_hash) = 64 AND nonce_hash = lower(nonce_hash)),
  issued_at TEXT NOT NULL CHECK (julianday(issued_at) IS NOT NULL),
  expires_at TEXT NOT NULL CHECK (julianday(expires_at) IS NOT NULL AND julianday(expires_at) > julianday(issued_at) AND julianday(expires_at) <= julianday(issued_at) + 30.0 / 86400.0),
  FOREIGN KEY (lease_id, attempt_id, work_item_id) REFERENCES attempt_leases(lease_id, attempt_id, work_item_id),
  FOREIGN KEY (approval_id, work_item_id) REFERENCES execution_plan_approvals(approval_id, work_item_id)
);

CREATE TABLE IF NOT EXISTS desktop_commander_capability_issuance_scopes (
  capability_issuance_id TEXT NOT NULL REFERENCES desktop_commander_capability_issuances(capability_issuance_id),
  scope_name TEXT NOT NULL CHECK (scope_name IN ('fs.read', 'fs.write', 'process.exec', 'process.spawn', 'network.read', 'network.write')),
  PRIMARY KEY (capability_issuance_id, scope_name)
);

CREATE INDEX IF NOT EXISTS idx_dc_runtimes_active ON desktop_commander_runtimes(runtime_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_dc_bootstrap_pending ON desktop_commander_bootstrap_challenges(runtime_id, status, expires_at) WHERE status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS idx_dc_bootstrap_one_pending_per_runtime ON desktop_commander_bootstrap_challenges(runtime_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_dc_capability_issuance_lease ON desktop_commander_capability_issuances(lease_id, action_hash, issued_at);
CREATE INDEX IF NOT EXISTS idx_dc_capability_issuance_runtime ON desktop_commander_capability_issuances(runtime_id, issued_at);

CREATE TRIGGER IF NOT EXISTS desktop_commander_runtimes_no_delete BEFORE DELETE ON desktop_commander_runtimes BEGIN SELECT RAISE(ABORT, 'desktop_commander_runtimes: append-only'); END;
CREATE TRIGGER IF NOT EXISTS desktop_commander_runtime_scopes_no_change BEFORE UPDATE ON desktop_commander_runtime_scopes BEGIN SELECT RAISE(ABORT, 'desktop_commander_runtime_scopes: immutable'); END;
CREATE TRIGGER IF NOT EXISTS desktop_commander_runtime_scopes_no_delete BEFORE DELETE ON desktop_commander_runtime_scopes BEGIN SELECT RAISE(ABORT, 'desktop_commander_runtime_scopes: append-only'); END;
CREATE TRIGGER IF NOT EXISTS desktop_commander_capability_issuances_no_change BEFORE UPDATE ON desktop_commander_capability_issuances BEGIN SELECT RAISE(ABORT, 'desktop_commander_capability_issuances: append-only'); END;
CREATE TRIGGER IF NOT EXISTS desktop_commander_capability_issuances_no_delete BEFORE DELETE ON desktop_commander_capability_issuances BEGIN SELECT RAISE(ABORT, 'desktop_commander_capability_issuances: append-only'); END;
CREATE TRIGGER IF NOT EXISTS desktop_commander_capability_issuance_scopes_no_change BEFORE UPDATE ON desktop_commander_capability_issuance_scopes BEGIN SELECT RAISE(ABORT, 'desktop_commander_capability_issuance_scopes: immutable'); END;
CREATE TRIGGER IF NOT EXISTS desktop_commander_capability_issuance_scopes_no_delete BEFORE DELETE ON desktop_commander_capability_issuance_scopes BEGIN SELECT RAISE(ABORT, 'desktop_commander_capability_issuance_scopes: append-only'); END;

-- Owner-controlled full-auto foundation. This migration intentionally makes no
-- approval bypass: execution code must verify a persisted binding before it
-- can authorize a full_auto claim.
PRAGMA foreign_keys = OFF;

CREATE TABLE execution_mode_state_v037 (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mode TEXT NOT NULL CHECK (mode IN ('strict', 'admin', 'full_auto')),
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0)
);

INSERT INTO execution_mode_state_v037 (id, mode, updated_at, updated_by, reason, revision)
SELECT id, mode, updated_at, updated_by, reason, 0
FROM execution_mode_state;

DROP TABLE execution_mode_state;
ALTER TABLE execution_mode_state_v037 RENAME TO execution_mode_state;
PRAGMA foreign_keys = ON;

CREATE TABLE authorization_bindings (
  binding_id TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL,
  authorization_mode TEXT NOT NULL CHECK (authorization_mode IN ('interactive_approved', 'full_auto')),
  binding_hash TEXT NOT NULL UNIQUE,
  work_item_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  action_hash TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  runtime_id TEXT NOT NULL,
  fencing_epoch INTEGER NOT NULL,
  mode_revision INTEGER NOT NULL,
  mode_state_hash TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  policy_decision_hash TEXT NOT NULL,
  required_scopes_hash TEXT NOT NULL,
  capability_scope_hash TEXT NOT NULL,
  principal_issuer TEXT NOT NULL,
  principal_subject TEXT NOT NULL,
  principal_actor_id TEXT NOT NULL,
  result_nonce_hash TEXT NOT NULL UNIQUE,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  approval_id TEXT,
  CHECK ((authorization_mode = 'interactive_approved' AND approval_id IS NOT NULL) OR (authorization_mode = 'full_auto' AND approval_id IS NULL))
);

CREATE INDEX idx_authorization_bindings_lease_attempt ON authorization_bindings(lease_id, attempt_id);
CREATE INDEX idx_authorization_bindings_expiry ON authorization_bindings(expires_at);

CREATE TRIGGER authorization_bindings_no_update BEFORE UPDATE ON authorization_bindings
BEGIN SELECT RAISE(ABORT, 'authorization_bindings: append-only'); END;
CREATE TRIGGER authorization_bindings_no_delete BEFORE DELETE ON authorization_bindings
BEGIN SELECT RAISE(ABORT, 'authorization_bindings: append-only'); END;
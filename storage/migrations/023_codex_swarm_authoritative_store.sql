-- Durable disabled-by-default Codex Swarm authority records. Only
-- SqliteWorkItemStore writes these rows; no proof, credential, raw session, or
-- caller-provided reason is persisted.
CREATE TABLE codex_swarm_dispatch_reservations (
  idempotency_key TEXT PRIMARY KEY CHECK (length(trim(idempotency_key)) > 0),
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  attempt_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  fencing_epoch INTEGER NOT NULL CHECK (fencing_epoch > 0),
  envelope_hash TEXT NOT NULL CHECK (length(envelope_hash) = 64 AND envelope_hash = lower(envelope_hash)),
  start_status TEXT NOT NULL CHECK (start_status IN ('reserved', 'started', 'failed_start', 'cancelled')),
  start_code TEXT,
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  completed_at TEXT,
  UNIQUE(attempt_id, lease_id, fencing_epoch),
  FOREIGN KEY(attempt_id, work_item_id) REFERENCES execution_attempts(attempt_id, work_item_id),
  FOREIGN KEY(lease_id, attempt_id) REFERENCES attempt_leases(lease_id, attempt_id)
);
CREATE TRIGGER codex_swarm_dispatch_reservations_no_delete BEFORE DELETE ON codex_swarm_dispatch_reservations BEGIN SELECT RAISE(ABORT, 'codex_swarm_dispatch_reservations: append-only'); END;
CREATE TRIGGER codex_swarm_dispatch_reservations_transition_guard
BEFORE UPDATE ON codex_swarm_dispatch_reservations
WHEN NEW.idempotency_key IS NOT OLD.idempotency_key OR NEW.work_item_id IS NOT OLD.work_item_id
  OR NEW.attempt_id IS NOT OLD.attempt_id OR NEW.lease_id IS NOT OLD.lease_id
  OR NEW.fencing_epoch IS NOT OLD.fencing_epoch OR NEW.envelope_hash IS NOT OLD.envelope_hash
  OR OLD.start_status <> 'reserved' OR NEW.start_status NOT IN ('started', 'failed_start', 'cancelled')
  OR NEW.completed_at IS NULL
BEGIN SELECT RAISE(ABORT, 'codex_swarm_dispatch_reservations: immutable binding or invalid transition'); END;

CREATE TABLE codex_swarm_cancellation_receipts (
  cancellation_id TEXT PRIMARY KEY,
  authenticated_principal_id TEXT NOT NULL REFERENCES actors(id),
  request_id TEXT NOT NULL CHECK (length(trim(request_id)) > 0),
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  attempt_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  fencing_epoch INTEGER NOT NULL CHECK (fencing_epoch > 0),
  canonical_intent_hash TEXT NOT NULL CHECK (length(canonical_intent_hash)=64 AND canonical_intent_hash=lower(canonical_intent_hash)),
  context_hash TEXT NOT NULL CHECK (length(context_hash)=64 AND context_hash=lower(context_hash)),
  proof_binding_hash TEXT NOT NULL CHECK (length(proof_binding_hash)=64 AND proof_binding_hash=lower(proof_binding_hash)),
  provider_generation INTEGER NOT NULL CHECK (provider_generation > 0),
  session_epoch_binding_hash TEXT NOT NULL CHECK (length(session_epoch_binding_hash)=64 AND session_epoch_binding_hash=lower(session_epoch_binding_hash)),
  receipt_status TEXT NOT NULL CHECK (receipt_status IN ('accepted','already_cancelled','not_cancellable')),
  external_status TEXT NOT NULL CHECK (external_status IN ('accepted','already_cancelled','denied')),
  external_code TEXT CHECK (external_code IS NULL OR external_code IN ('cancellation_not_cancellable')),
  serialized_outcome TEXT NOT NULL CHECK (length(serialized_outcome) > 0),
  outcome_hash TEXT NOT NULL CHECK (length(outcome_hash)=64 AND outcome_hash=lower(outcome_hash)),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE(authenticated_principal_id, request_id),
  UNIQUE(cancellation_id, attempt_id, lease_id, fencing_epoch),
  FOREIGN KEY(attempt_id, work_item_id) REFERENCES execution_attempts(attempt_id, work_item_id),
  FOREIGN KEY(lease_id, attempt_id) REFERENCES attempt_leases(lease_id, attempt_id),
  CHECK ((receipt_status IN ('accepted','already_cancelled') AND external_status=receipt_status AND external_code IS NULL) OR (receipt_status='not_cancellable' AND external_status='denied' AND external_code='cancellation_not_cancellable'))
);
CREATE INDEX idx_codex_swarm_cancellation_receipts_attempt ON codex_swarm_cancellation_receipts(attempt_id, created_at);
CREATE TRIGGER codex_swarm_cancellation_receipts_no_update BEFORE UPDATE ON codex_swarm_cancellation_receipts BEGIN SELECT RAISE(ABORT, 'codex_swarm_cancellation_receipts: append-only'); END;
CREATE TRIGGER codex_swarm_cancellation_receipts_no_delete BEFORE DELETE ON codex_swarm_cancellation_receipts BEGIN SELECT RAISE(ABORT, 'codex_swarm_cancellation_receipts: append-only'); END;

CREATE TABLE codex_swarm_cancellation_supervision (
  cancellation_id TEXT PRIMARY KEY REFERENCES codex_swarm_cancellation_receipts(cancellation_id),
  attempt_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  fencing_epoch INTEGER NOT NULL CHECK (fencing_epoch > 0),
  supervisor_state TEXT NOT NULL CHECK (supervisor_state IN ('pending','claimed','signalled','signal_failed','crash_unresolved','compensated')),
  claim_id TEXT UNIQUE,
  claimed_at TEXT CHECK (claimed_at IS NULL OR julianday(claimed_at) IS NOT NULL),
  signalled_at TEXT CHECK (signalled_at IS NULL OR julianday(signalled_at) IS NOT NULL),
  terminal_at TEXT CHECK (terminal_at IS NULL OR julianday(terminal_at) IS NOT NULL),
  failure_code TEXT CHECK (failure_code IS NULL OR failure_code IN ('cancellation_supervisor_failed','cancellation_supervisor_crash_unresolved')),
  CHECK ((supervisor_state='pending' AND claim_id IS NULL AND claimed_at IS NULL AND signalled_at IS NULL AND terminal_at IS NULL AND failure_code IS NULL) OR (supervisor_state='claimed' AND claim_id IS NOT NULL AND claimed_at IS NOT NULL AND signalled_at IS NULL AND terminal_at IS NULL AND failure_code IS NULL) OR (supervisor_state='signalled' AND claim_id IS NOT NULL AND claimed_at IS NOT NULL AND signalled_at IS NOT NULL AND terminal_at IS NOT NULL AND failure_code IS NULL) OR (supervisor_state IN ('signal_failed','crash_unresolved','compensated') AND claim_id IS NOT NULL AND claimed_at IS NOT NULL AND terminal_at IS NOT NULL AND failure_code IS NOT NULL))
);
CREATE UNIQUE INDEX uq_codex_swarm_cancellation_supervision_tuple ON codex_swarm_cancellation_supervision(attempt_id, lease_id, fencing_epoch);
CREATE TRIGGER codex_swarm_cancellation_supervision_no_delete BEFORE DELETE ON codex_swarm_cancellation_supervision BEGIN SELECT RAISE(ABORT, 'codex_swarm_cancellation_supervision: append-only'); END;
CREATE TRIGGER codex_swarm_cancellation_supervision_guard
BEFORE UPDATE ON codex_swarm_cancellation_supervision
WHEN NEW.cancellation_id IS NOT OLD.cancellation_id OR NEW.attempt_id IS NOT OLD.attempt_id OR NEW.lease_id IS NOT OLD.lease_id OR NEW.fencing_epoch IS NOT OLD.fencing_epoch
  OR (OLD.supervisor_state='pending' AND NOT (NEW.supervisor_state='claimed' AND NEW.claim_id IS NOT NULL AND NEW.claimed_at IS NOT NULL))
  OR (OLD.supervisor_state='claimed' AND NOT (NEW.supervisor_state IN ('signalled','signal_failed','crash_unresolved') AND NEW.claim_id IS OLD.claim_id AND NEW.claimed_at IS OLD.claimed_at AND NEW.terminal_at IS NOT NULL))
  OR (OLD.supervisor_state IN ('signal_failed','crash_unresolved') AND NOT (NEW.supervisor_state='compensated' AND NEW.claim_id IS OLD.claim_id AND NEW.claimed_at IS OLD.claimed_at AND NEW.failure_code IS OLD.failure_code))
  OR OLD.supervisor_state IN ('signalled','compensated')
BEGIN SELECT RAISE(ABORT, 'codex_swarm_cancellation_supervision: immutable binding or invalid transition'); END;

CREATE TABLE codex_swarm_cancellation_compensations (
  cancellation_id TEXT PRIMARY KEY REFERENCES codex_swarm_cancellation_receipts(cancellation_id),
  supervision_claim_id TEXT NOT NULL UNIQUE REFERENCES codex_swarm_cancellation_supervision(claim_id),
  compensation_code TEXT NOT NULL CHECK (compensation_code IN ('cancellation_supervisor_failed','cancellation_supervisor_crash_unresolved')),
  disposition TEXT NOT NULL CHECK (disposition IN ('unknown','quarantined')),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL)
);
CREATE TRIGGER codex_swarm_cancellation_compensations_no_update BEFORE UPDATE ON codex_swarm_cancellation_compensations BEGIN SELECT RAISE(ABORT, 'codex_swarm_cancellation_compensations: append-only'); END;
CREATE TRIGGER codex_swarm_cancellation_compensations_no_delete BEFORE DELETE ON codex_swarm_cancellation_compensations BEGIN SELECT RAISE(ABORT, 'codex_swarm_cancellation_compensations: append-only'); END;

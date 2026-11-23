-- R1.1 append-only retry-fence evidence. Migration 079 is new: historical migrations are unchanged.
-- A cleanup verdict must bind the execution unit and the disposition of external effects.
-- There is deliberately no automatic backfill for unknown/quarantined attempts.
CREATE TABLE IF NOT EXISTS attempt_execution_scopes (
  attempt_id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  fencing_epoch INTEGER NOT NULL CHECK (fencing_epoch > 0),
  unit_name TEXT NOT NULL CHECK (length(unit_name) BETWEEN 1 AND 256),
  recorded_at TEXT NOT NULL CHECK (julianday(recorded_at) IS NOT NULL),
  FOREIGN KEY (attempt_id, work_item_id) REFERENCES execution_attempts(attempt_id, work_item_id),
  FOREIGN KEY (lease_id, attempt_id, work_item_id)
    REFERENCES attempt_leases(lease_id, attempt_id, work_item_id)
);

CREATE TABLE IF NOT EXISTS attempt_cleanup_evidence (
  attempt_id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  fencing_epoch INTEGER NOT NULL CHECK (fencing_epoch > 0),
  unit_name TEXT NOT NULL CHECK (length(unit_name) BETWEEN 1 AND 256),
  verdict TEXT NOT NULL CHECK (verdict = 'verified'),
  evidence_hash TEXT NOT NULL CHECK (length(evidence_hash) = 64 AND evidence_hash = lower(evidence_hash)),
  effects_disposition TEXT NOT NULL CHECK (effects_disposition IN ('no_external_effects', 'reconciled')),
  effects_evidence_hash TEXT NOT NULL
    CHECK (length(effects_evidence_hash) = 64 AND effects_evidence_hash = lower(effects_evidence_hash)),
  observed_at TEXT NOT NULL CHECK (julianday(observed_at) IS NOT NULL),
  recorded_at TEXT NOT NULL CHECK (julianday(recorded_at) IS NOT NULL),
  FOREIGN KEY (attempt_id, work_item_id) REFERENCES execution_attempts(attempt_id, work_item_id),
  FOREIGN KEY (lease_id, attempt_id, work_item_id)
    REFERENCES attempt_leases(lease_id, attempt_id, work_item_id)
);

CREATE INDEX IF NOT EXISTS idx_attempt_execution_scopes_work_item
  ON attempt_execution_scopes(work_item_id, attempt_id);
CREATE INDEX IF NOT EXISTS idx_attempt_cleanup_evidence_work_item
  ON attempt_cleanup_evidence(work_item_id, attempt_id);

CREATE TRIGGER IF NOT EXISTS attempt_execution_scopes_no_update
BEFORE UPDATE ON attempt_execution_scopes BEGIN
  SELECT RAISE(ABORT, 'attempt_execution_scopes: append-only');
END;
CREATE TRIGGER IF NOT EXISTS attempt_execution_scopes_no_delete
BEFORE DELETE ON attempt_execution_scopes BEGIN
  SELECT RAISE(ABORT, 'attempt_execution_scopes: append-only');
END;
CREATE TRIGGER IF NOT EXISTS attempt_cleanup_evidence_no_update
BEFORE UPDATE ON attempt_cleanup_evidence BEGIN
  SELECT RAISE(ABORT, 'attempt_cleanup_evidence: append-only');
END;
CREATE TRIGGER IF NOT EXISTS attempt_cleanup_evidence_no_delete
BEFORE DELETE ON attempt_cleanup_evidence BEGIN
  SELECT RAISE(ABORT, 'attempt_cleanup_evidence: append-only');
END;

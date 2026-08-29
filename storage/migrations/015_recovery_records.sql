CREATE TABLE IF NOT EXISTS recovery_records (
  record_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  decision TEXT NOT NULL CHECK (decision IN ('resumable', 'retryable', 'validation_pending', 'cleanup_pending', 'terminal_failed')),
  retry_allowed INTEGER NOT NULL CHECK (retry_allowed IN (0, 1)),
  reason TEXT NOT NULL,
  retry_after_ms INTEGER CHECK (retry_after_ms IS NULL OR retry_after_ms >= 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_recovery_records_attempt ON recovery_records(attempt_id, created_at DESC);
CREATE TRIGGER IF NOT EXISTS recovery_records_no_update BEFORE UPDATE ON recovery_records BEGIN
  SELECT RAISE(ABORT, 'recovery_records: append-only');
END;
CREATE TRIGGER IF NOT EXISTS recovery_records_no_delete BEFORE DELETE ON recovery_records BEGIN
  SELECT RAISE(ABORT, 'recovery_records: append-only');
END;

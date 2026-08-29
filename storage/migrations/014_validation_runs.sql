CREATE TABLE IF NOT EXISTS validation_runs (
  run_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  passed INTEGER NOT NULL CHECK (passed IN (0, 1)),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS validation_checks (
  check_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES validation_runs(run_id),
  name TEXT NOT NULL,
  passed INTEGER NOT NULL CHECK (passed IN (0, 1)),
  detail TEXT NOT NULL,
  stdout TEXT,
  stderr TEXT
);
CREATE INDEX IF NOT EXISTS idx_validation_runs_attempt ON validation_runs(attempt_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_validation_checks_run ON validation_checks(run_id);
CREATE TRIGGER IF NOT EXISTS validation_runs_no_update BEFORE UPDATE ON validation_runs BEGIN
  SELECT RAISE(ABORT, 'validation_runs: append-only');
END;
CREATE TRIGGER IF NOT EXISTS validation_runs_no_delete BEFORE DELETE ON validation_runs BEGIN
  SELECT RAISE(ABORT, 'validation_runs: append-only');
END;
CREATE TRIGGER IF NOT EXISTS validation_checks_no_update BEFORE UPDATE ON validation_checks BEGIN
  SELECT RAISE(ABORT, 'validation_checks: append-only');
END;
CREATE TRIGGER IF NOT EXISTS validation_checks_no_delete BEFORE DELETE ON validation_checks BEGIN
  SELECT RAISE(ABORT, 'validation_checks: append-only');
END;

-- Enforce global uniqueness of execution_results.idempotency_key (non-null).
-- If existing duplicate non-null keys exist, this migration will fail with
-- a UNIQUE constraint error — inspect and reconcile those rows before retrying.
CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_results_idempotency_key
  ON execution_results(idempotency_key);
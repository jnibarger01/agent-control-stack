-- NON-CANONICAL FIXTURE. This file is deliberately NOT registered in
-- `migrationFiles` in packages/shared/src/migration.ts and must never be added to
-- the canonical migration order just because of its numeric prefix.
--
-- It exists only to reconstruct an earlier lineage in migration recovery tests, in
-- which this migration's content shipped under version 37 instead of 38. The
-- canonical v37 migration is 037_jc_reusable_work_item_index.sql, and the canonical
-- migration carrying this content is 038_execution_results_idempotency_unique.sql.
-- Do not renumber: recovery and its tests depend on these exact filenames.
--
-- Editing this file changes the checksum that migration recovery derives for the
-- historical 37 layout, which is intentional and is detected as checksum drift.
-- Enforce global uniqueness of execution_results.idempotency_key (non-null).
-- If existing duplicate non-null keys exist, this migration will fail with
-- a UNIQUE constraint error — inspect and reconcile those rows before retrying.
CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_results_idempotency_key
  ON execution_results(idempotency_key);
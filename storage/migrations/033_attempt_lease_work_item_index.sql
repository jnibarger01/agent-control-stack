-- Mission Control reads attempt leases per work item: the dashboard batches
-- `WHERE work_item_id IN (...)` for every rendered work item and the work-item
-- detail panel reads `WHERE work_item_id = ?`. The only existing indexes on the
-- append-only attempt_leases table lead with lease_id/attempt_id/status/worker,
-- so both reads degrade to a full scan plus a sort on every dashboard render
-- and poll, and the scan grows with every lease ever issued.
--
-- Column order matches the read paths' ordering
-- (`ORDER BY issued_at ASC, fencing_epoch ASC`), so the per-work-item detail
-- lookup is satisfied entirely from the index.
CREATE INDEX IF NOT EXISTS idx_attempt_leases_work_item
  ON attempt_leases(work_item_id, issued_at, fencing_epoch);

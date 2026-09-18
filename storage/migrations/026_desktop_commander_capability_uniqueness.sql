-- Managed capability uniqueness: one lease/attempt/invocation may mint exactly
-- one Desktop Commander capability. Concurrent issuance attempts are serialized
-- by SQLite writes and the second insert fails on this unique index, so the
-- database — not application prechecks — is the authority for the invariant.
-- Forward-only: do not alter historical migrations.

CREATE UNIQUE INDEX IF NOT EXISTS idx_dc_capability_one_per_invocation
  ON desktop_commander_capability_issuances(lease_id, attempt_id, work_item_id, invocation_hash);

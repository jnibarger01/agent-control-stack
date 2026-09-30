-- Approval bundles / change sets.
--
-- A bundle is a review artifact. It holds no authority of its own: approving a
-- bundle mints one row per covered change into `execution_plan_approvals`, and
-- execution authority continues to flow through `attempt_lease_approvals` and
-- the attempt lease exactly as it did before bundles existed.
--
-- `action_hash` is the Policy Gate `actionFingerprint` for the change. Because
-- that fingerprint already binds requester, risk, kind, description, params,
-- command, cwd, paths, write, network and destructive, a change can only ever
-- be authorized as the exact operation a reviewer saw. Changing any of those
-- produces a different action_hash, which matches no grant and fails closed.
--
-- Revisions are append-only. `parent_manifest_hash` chains them, and the
-- contiguity trigger below makes a gap or a rewind impossible to write, so
-- "previously approved" is a verifiable claim rather than a hopeful one.
CREATE TABLE IF NOT EXISTS approval_bundles (
  bundle_id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'draft','pending','approved','partially_approved','rejected',
    'modified','invalidated','executing','completed','failed'
  )),
  current_revision INTEGER NOT NULL CHECK (current_revision >= 1),
  current_manifest_hash TEXT NOT NULL
    CHECK (length(current_manifest_hash) = 64 AND current_manifest_hash = lower(current_manifest_hash)),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_approval_bundles_mission
  ON approval_bundles(mission_id, status);
CREATE INDEX IF NOT EXISTS idx_approval_bundles_execution
  ON approval_bundles(execution_id);

CREATE TABLE IF NOT EXISTS approval_bundle_revisions (
  bundle_id TEXT NOT NULL REFERENCES approval_bundles(bundle_id),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  manifest_hash TEXT NOT NULL
    CHECK (length(manifest_hash) = 64 AND manifest_hash = lower(manifest_hash)),
  parent_manifest_hash TEXT
    CHECK (parent_manifest_hash IS NULL
           OR (length(parent_manifest_hash) = 64 AND parent_manifest_hash = lower(parent_manifest_hash))),
  -- The canonical manifest, byte for byte as it was hashed.
  manifest_json TEXT NOT NULL,
  title TEXT NOT NULL,
  rationale TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'draft','pending','approved','partially_approved','rejected',
    'modified','invalidated','executing','completed','failed'
  )),
  base_state_json TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  created_by_actor_id TEXT NOT NULL CHECK (length(trim(created_by_actor_id)) > 0),
  expires_at TEXT CHECK (expires_at IS NULL OR julianday(expires_at) IS NOT NULL),
  PRIMARY KEY (bundle_id, revision),
  -- A parent hash is recorded if and only if this is not the first revision.
  CHECK ((revision = 1 AND parent_manifest_hash IS NULL)
         OR (revision > 1 AND parent_manifest_hash IS NOT NULL))
);

-- Revisions are immutable. Rewriting history would let a bundle retroactively
-- claim that something a reviewer never saw was part of the approved set.
CREATE TRIGGER IF NOT EXISTS approval_bundle_revisions_no_update
BEFORE UPDATE ON approval_bundle_revisions
BEGIN
  SELECT RAISE(ABORT, 'approval_bundle_revisions: revisions are immutable');
END;

CREATE TRIGGER IF NOT EXISTS approval_bundle_revisions_no_delete
BEFORE DELETE ON approval_bundle_revisions
BEGIN
  SELECT RAISE(ABORT, 'approval_bundle_revisions: append-only');
END;

-- Revision numbers must be contiguous and ascending. A concurrent or out-of-order
-- revision write is rejected by the database, not merely by the caller.
CREATE TRIGGER IF NOT EXISTS approval_bundle_revisions_contiguity_guard
BEFORE INSERT ON approval_bundle_revisions
WHEN NEW.revision > 1 AND NOT EXISTS (
  SELECT 1 FROM approval_bundle_revisions AS previous
  WHERE previous.bundle_id = NEW.bundle_id
    AND previous.revision = NEW.revision - 1
    AND previous.manifest_hash = NEW.parent_manifest_hash
)
BEGIN
  SELECT RAISE(ABORT, 'approval_bundle_revisions: revision does not extend the current head');
END;

CREATE TABLE IF NOT EXISTS approval_bundle_changes (
  bundle_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  change_id TEXT NOT NULL CHECK (length(trim(change_id)) > 0),
  change_digest TEXT NOT NULL
    CHECK (length(change_digest) = 64 AND change_digest = lower(change_digest)),
  action_hash TEXT NOT NULL
    CHECK (length(action_hash) = 64 AND action_hash = lower(action_hash)),
  change_type TEXT NOT NULL,
  target TEXT NOT NULL,
  summary TEXT NOT NULL,
  risk TEXT NOT NULL CHECK (risk IN ('low','medium','high','critical')),
  destructive INTEGER NOT NULL DEFAULT 0 CHECK (destructive IN (0,1)),
  network INTEGER NOT NULL DEFAULT 0 CHECK (network IN (0,1)),
  depends_on_json TEXT NOT NULL,
  command_json TEXT,
  change_json TEXT NOT NULL,
  PRIMARY KEY (bundle_id, revision, change_id),
  FOREIGN KEY (bundle_id, revision) REFERENCES approval_bundle_revisions(bundle_id, revision)
);

CREATE TRIGGER IF NOT EXISTS approval_bundle_changes_no_update
BEFORE UPDATE ON approval_bundle_changes
BEGIN
  SELECT RAISE(ABORT, 'approval_bundle_changes: changes are immutable per revision');
END;

CREATE TRIGGER IF NOT EXISTS approval_bundle_changes_no_delete
BEFORE DELETE ON approval_bundle_changes
BEGIN
  SELECT RAISE(ABORT, 'approval_bundle_changes: append-only');
END;

CREATE TABLE IF NOT EXISTS approval_bundle_decisions (
  decision_id TEXT PRIMARY KEY,
  bundle_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('approve_all','approve_selected','reject','invalidate')),
  approved_by_actor_id TEXT NOT NULL CHECK (length(trim(approved_by_actor_id)) > 0),
  reason TEXT NOT NULL,
  change_ids_json TEXT NOT NULL,
  manifest_hash TEXT NOT NULL
    CHECK (length(manifest_hash) = 64 AND manifest_hash = lower(manifest_hash)),
  decided_at TEXT NOT NULL CHECK (julianday(decided_at) IS NOT NULL),
  FOREIGN KEY (bundle_id, revision) REFERENCES approval_bundle_revisions(bundle_id, revision)
);

CREATE TRIGGER IF NOT EXISTS approval_bundle_decisions_no_delete
BEFORE DELETE ON approval_bundle_decisions
BEGIN
  SELECT RAISE(ABORT, 'approval_bundle_decisions: append-only');
END;

-- One decision per (revision, kind, actor) so a retried approval request cannot
-- manufacture a second grant from the same human act.
CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_bundle_decisions_idempotent
  ON approval_bundle_decisions(bundle_id, revision, kind, approved_by_actor_id);

CREATE INDEX IF NOT EXISTS idx_approval_bundle_decisions_bundle
  ON approval_bundle_decisions(bundle_id, decided_at);

CREATE TABLE IF NOT EXISTS approval_bundle_grants (
  grant_id TEXT PRIMARY KEY,
  bundle_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  change_id TEXT NOT NULL,
  manifest_hash TEXT NOT NULL
    CHECK (length(manifest_hash) = 64 AND manifest_hash = lower(manifest_hash)),
  action_hash TEXT NOT NULL
    CHECK (length(action_hash) = 64 AND action_hash = lower(action_hash)),
  mission_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  plan_hash TEXT NOT NULL
    CHECK (length(plan_hash) = 64 AND plan_hash = lower(plan_hash)),
  -- The authoritative `execution_plan_approvals` row this grant stands for. The
  -- bundle never issues authority of its own; it points at the row that does.
  approval_id TEXT NOT NULL,
  approved_by_actor_id TEXT NOT NULL CHECK (length(approved_by_actor_id) <> 'acs:admin'),
  status TEXT NOT NULL DEFAULT 'granted'
    CHECK (status IN ('granted','consumed','invalidated','expired')),
  base_state_json TEXT NOT NULL,
  granted_at TEXT NOT NULL CHECK (julianday(granted_at) IS NOT NULL),
  expires_at TEXT NOT NULL CHECK (julianday(expires_at) > julianday(granted_at)),
  invalidated_at TEXT CHECK (invalidated_at IS NULL OR julianday(invalidated_at) IS NOT NULL),
  invalidation_reason TEXT,
  FOREIGN KEY (bundle_id, revision) REFERENCES approval_bundle_revisions(bundle_id, revision),
  FOREIGN KEY (approval_id, work_item_id) REFERENCES execution_plan_approvals(approval_id, work_item_id)
);

-- A change is granted at most once per revision. Re-approving the same change in
-- the same revision is a no-op rather than a second grant.
CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_bundle_grants_one_per_change
  ON approval_bundle_grants(bundle_id, revision, change_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_bundle_grants_one_per_approval
  ON approval_bundle_grants(approval_id);
CREATE INDEX IF NOT EXISTS idx_approval_bundle_grants_action
  ON approval_bundle_grants(action_hash, status);
CREATE INDEX IF NOT EXISTS idx_approval_bundle_grants_work_item
  ON approval_bundle_grants(work_item_id, status);

-- The grant binding is immutable; only its lifecycle status may move, and only
-- through a legal transition.
CREATE TRIGGER IF NOT EXISTS approval_bundle_grants_binding_guard
BEFORE UPDATE ON approval_bundle_grants
WHEN NEW.grant_id <> OLD.grant_id
  OR NEW.bundle_id <> OLD.bundle_id
  OR NEW.revision <> OLD.revision
  OR NEW.change_id <> OLD.change_id
  OR NEW.manifest_hash <> OLD.manifest_hash
  OR NEW.action_hash <> OLD.action_hash
  OR NEW.mission_id <> OLD.mission_id
  OR NEW.execution_id <> OLD.execution_id
  OR NEW.work_item_id <> OLD.work_item_id
  OR NEW.plan_hash <> OLD.plan_hash
  OR NEW.approval_id <> OLD.approval_id
  OR NEW.approved_by_actor_id <> OLD.approved_by_actor_id
  OR NEW.base_state_json <> OLD.base_state_json
  OR NEW.granted_at <> OLD.granted_at
  OR NEW.expires_at <> OLD.expires_at
  OR OLD.status <> 'granted'
  OR NEW.status NOT IN ('consumed','invalidated','expired')
  OR (NEW.status = 'invalidated' AND (NEW.invalidated_at IS NULL OR NEW.invalidation_reason IS NULL))
BEGIN
  SELECT RAISE(ABORT, 'approval_bundle_grants: binding is immutable or transition is illegal');
END;

CREATE TRIGGER IF NOT EXISTS approval_bundle_grants_no_delete
BEFORE DELETE ON approval_bundle_grants
BEGIN
  SELECT RAISE(ABORT, 'approval_bundle_grants: append-only');
END;

-- Approval strategy decides how privileged work may be authorized.
--
-- This is a dedicated single-row table rather than a new column on
-- `execution_mode_state`, because the migration-repair paths in
-- `packages/shared/src/migration.ts` re-execute migration SQL, and
-- `ALTER TABLE ... ADD COLUMN` is not idempotent: a second execution fails with
-- "duplicate column name". A single-row table with `IF NOT EXISTS` plus an
-- idempotent seed is safe under re-execution, and keeps the same one-canonical-row
-- shape the execution mode already uses.
--
-- The default is PER_ACTION, which is exactly the pre-bundle behaviour, so an
-- existing deployment is unchanged by this migration.
CREATE TABLE IF NOT EXISTS approval_strategy_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  strategy TEXT NOT NULL
    CHECK (strategy IN ('PER_ACTION','BUNDLE','POLICY_AUTONOMOUS')),
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  reason TEXT NOT NULL
);

INSERT INTO approval_strategy_state (id, strategy, updated_at, updated_by, reason)
VALUES (1, 'PER_ACTION', '1970-01-01T00:00:00.000Z', 'system', 'default per-action approval')
ON CONFLICT (id) DO NOTHING;

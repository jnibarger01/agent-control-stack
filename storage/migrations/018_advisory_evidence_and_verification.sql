-- 018_advisory_evidence_and_verification
--
-- ADR 0015. Append-only, content-addressed PROJECTIONS over the canonical
-- work-item + audit state. None of these tables is a second authoritative
-- lifecycle, approval store, lease store, result store, or audit chain:
--   * every row is written in the same SQLite transaction as its canonical
--     audit event (packages/work-items),
--   * every table is append-only (immutable + no-delete triggers),
--   * terminal work-item acceptance stays in execution_results / attempt_results.

-- --- advisory plan proposals (UNTRUSTED until ACS admits) -------------------
CREATE TABLE IF NOT EXISTS plan_proposals (
  proposal_hash TEXT PRIMARY KEY CHECK (length(proposal_hash) = 64 AND proposal_hash = lower(proposal_hash)),
  proposal_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  principal_id TEXT NOT NULL,
  proposal_json TEXT NOT NULL CHECK (json_valid(proposal_json)),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  admitted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_plan_proposals_work_item ON plan_proposals(work_item_id, created_at);
CREATE TRIGGER IF NOT EXISTS plan_proposals_no_delete BEFORE DELETE ON plan_proposals BEGIN
  SELECT RAISE(ABORT, 'plan_proposals: append-only');
END;
-- The only field that may change is admitted_at, and only NULL -> a timestamp.
CREATE TRIGGER IF NOT EXISTS plan_proposals_immutable_guard BEFORE UPDATE ON plan_proposals
WHEN NEW.proposal_hash <> OLD.proposal_hash
  OR NEW.proposal_id <> OLD.proposal_id
  OR NEW.work_item_id <> OLD.work_item_id
  OR NEW.principal_id <> OLD.principal_id
  OR NEW.proposal_json <> OLD.proposal_json
  OR NEW.created_at <> OLD.created_at
  OR OLD.admitted_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'plan_proposals: only NULL admitted_at may be set once');
END;

-- --- ACS-owned machine evidence manifests (content-addressed, immutable) ----
CREATE TABLE IF NOT EXISTS evidence_manifests (
  manifest_hash TEXT PRIMARY KEY CHECK (length(manifest_hash) = 64 AND manifest_hash = lower(manifest_hash)),
  attempt_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  admitted_plan_hash TEXT NOT NULL CHECK (length(admitted_plan_hash) = 64),
  plan_hash TEXT NOT NULL CHECK (length(plan_hash) = 64),
  action_hash TEXT NOT NULL CHECK (length(action_hash) = 64),
  base_workspace_revision TEXT NOT NULL,
  result_workspace_revision TEXT NOT NULL,
  manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (attempt_id, manifest_hash)
);
CREATE INDEX IF NOT EXISTS idx_evidence_manifests_attempt ON evidence_manifests(attempt_id, created_at);
CREATE TRIGGER IF NOT EXISTS evidence_manifests_no_update BEFORE UPDATE ON evidence_manifests BEGIN
  SELECT RAISE(ABORT, 'evidence_manifests: content-addressed and immutable');
END;
CREATE TRIGGER IF NOT EXISTS evidence_manifests_no_delete BEFORE DELETE ON evidence_manifests BEGIN
  SELECT RAISE(ABORT, 'evidence_manifests: append-only');
END;

-- --- advisory review findings (immutable; MUST reference an evidence manifest)
CREATE TABLE IF NOT EXISTS review_findings (
  finding_hash TEXT PRIMARY KEY CHECK (length(finding_hash) = 64 AND finding_hash = lower(finding_hash)),
  finding_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  attempt_id TEXT NOT NULL,
  reviewer_principal_id TEXT NOT NULL,
  reviewer_provider TEXT NOT NULL,
  evidence_manifest_hash TEXT NOT NULL REFERENCES evidence_manifests(manifest_hash),
  verdict TEXT NOT NULL CHECK (verdict IN ('PASS', 'NEEDS_CHANGES', 'BLOCK', 'UNKNOWN')),
  finding_json TEXT NOT NULL CHECK (json_valid(finding_json)),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_review_findings_attempt ON review_findings(attempt_id, created_at);
CREATE TRIGGER IF NOT EXISTS review_findings_no_update BEFORE UPDATE ON review_findings BEGIN
  SELECT RAISE(ABORT, 'review_findings: immutable');
END;
CREATE TRIGGER IF NOT EXISTS review_findings_no_delete BEFORE DELETE ON review_findings BEGIN
  SELECT RAISE(ABORT, 'review_findings: append-only');
END;

-- --- reviewer grants (ACS-issued, single-consume, attempt+revision bound) ---
CREATE TABLE IF NOT EXISTS reviewer_grants (
  grant_hash TEXT PRIMARY KEY CHECK (length(grant_hash) = 64 AND grant_hash = lower(grant_hash)),
  grant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  plan_id TEXT NOT NULL,
  admitted_plan_hash TEXT NOT NULL CHECK (length(admitted_plan_hash) = 64),
  attempt_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  workspace_revision TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'consumed', 'expired', 'revoked')),
  grant_json TEXT NOT NULL CHECK (json_valid(grant_json)),
  issued_at TEXT NOT NULL CHECK (julianday(issued_at) IS NOT NULL),
  expires_at TEXT NOT NULL CHECK (julianday(expires_at) IS NOT NULL),
  consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_reviewer_grants_attempt ON reviewer_grants(attempt_id, issued_at);
CREATE TRIGGER IF NOT EXISTS reviewer_grants_no_delete BEFORE DELETE ON reviewer_grants BEGIN
  SELECT RAISE(ABORT, 'reviewer_grants: append-only');
END;
CREATE TRIGGER IF NOT EXISTS reviewer_grants_transition_guard BEFORE UPDATE ON reviewer_grants
WHEN NEW.grant_hash <> OLD.grant_hash
  OR NEW.grant_id <> OLD.grant_id
  OR NEW.principal_id <> OLD.principal_id
  OR NEW.attempt_id <> OLD.attempt_id
  OR NEW.workspace_revision <> OLD.workspace_revision
  OR NEW.admitted_plan_hash <> OLD.admitted_plan_hash
  OR NEW.grant_json <> OLD.grant_json
  OR NEW.issued_at <> OLD.issued_at
  OR (OLD.status <> 'issued' AND NEW.status <> OLD.status)
BEGIN
  SELECT RAISE(ABORT, 'reviewer_grants: only a single issued -> terminal status transition is allowed');
END;

-- --- attempt phase log (additive projection; NOT the work-item lifecycle) ---
CREATE TABLE IF NOT EXISTS attempt_phases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  phase TEXT NOT NULL CHECK (
    phase IN ('planning', 'admitted', 'executing', 'collecting_evidence', 'reviewing', 'accepted', 'rejected')
  ),
  note TEXT,
  recorded_at TEXT NOT NULL CHECK (julianday(recorded_at) IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_attempt_phases_attempt ON attempt_phases(attempt_id, id);
CREATE TRIGGER IF NOT EXISTS attempt_phases_no_update BEFORE UPDATE ON attempt_phases BEGIN
  SELECT RAISE(ABORT, 'attempt_phases: append-only');
END;
CREATE TRIGGER IF NOT EXISTS attempt_phases_no_delete BEFORE DELETE ON attempt_phases BEGIN
  SELECT RAISE(ABORT, 'attempt_phases: append-only');
END;

-- The current attempt phase is derived from the latest attempt_phases row. We
-- deliberately do NOT add a column to execution_attempts: that table's
-- immutable-transition guard (migration 006) must not be widened, and the phase
-- is a non-authoritative projection anyway.

-- --- verification requirement (one per attempt; fixed at admission) ---------
CREATE TABLE IF NOT EXISTS verification_requirements (
  attempt_id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  policy_version TEXT NOT NULL,
  reviewers_required INTEGER NOT NULL CHECK (reviewers_required >= 0),
  requirement_json TEXT NOT NULL CHECK (json_valid(requirement_json)),
  recorded_at TEXT NOT NULL CHECK (julianday(recorded_at) IS NOT NULL)
);
CREATE TRIGGER IF NOT EXISTS verification_requirements_no_update BEFORE UPDATE ON verification_requirements BEGIN
  SELECT RAISE(ABORT, 'verification_requirements: fixed at admission, append-only');
END;
CREATE TRIGGER IF NOT EXISTS verification_requirements_no_delete BEFORE DELETE ON verification_requirements BEGIN
  SELECT RAISE(ABORT, 'verification_requirements: append-only');
END;

-- --- verification decisions (ACS authority outcome; append-only) -----------
CREATE TABLE IF NOT EXISTS verification_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  outcome TEXT NOT NULL CHECK (
    outcome IN (
      'attempt_accepted', 'attempt_rejected', 'replan_required',
      'verification_disputed', 'human_escalation_required'
    )
  ),
  evidence_manifest_hash TEXT NOT NULL CHECK (length(evidence_manifest_hash) = 64),
  review_finding_hashes_json TEXT NOT NULL CHECK (json_valid(review_finding_hashes_json)),
  verification_policy_version TEXT NOT NULL,
  decided_at TEXT NOT NULL CHECK (julianday(decided_at) IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_verification_decisions_attempt ON verification_decisions(attempt_id, id);
CREATE TRIGGER IF NOT EXISTS verification_decisions_no_update BEFORE UPDATE ON verification_decisions BEGIN
  SELECT RAISE(ABORT, 'verification_decisions: append-only');
END;
CREATE TRIGGER IF NOT EXISTS verification_decisions_no_delete BEFORE DELETE ON verification_decisions BEGIN
  SELECT RAISE(ABORT, 'verification_decisions: append-only');
END;

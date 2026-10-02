CREATE TABLE change_set_approvals (
  approval_id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  manifest_hash TEXT NOT NULL,
  request_id TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  approval_hash TEXT NOT NULL CHECK (length(approval_hash) = 64),
  audit_event_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  UNIQUE (mission_id, request_id),
  FOREIGN KEY (mission_id, revision, manifest_hash)
    REFERENCES change_set_revisions(mission_id, revision, manifest_hash)
);
CREATE TABLE change_set_approval_revocations (
  approval_id TEXT PRIMARY KEY REFERENCES change_set_approvals(approval_id),
  revoked_by_actor_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  audit_event_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id)
);
CREATE TRIGGER change_set_approvals_no_update BEFORE UPDATE ON change_set_approvals
BEGIN SELECT RAISE(ABORT, 'change set approvals are immutable'); END;
CREATE TRIGGER change_set_approvals_no_delete BEFORE DELETE ON change_set_approvals
BEGIN SELECT RAISE(ABORT, 'change set approvals are immutable'); END;
CREATE TRIGGER change_set_approval_revocations_no_update BEFORE UPDATE ON change_set_approval_revocations
BEGIN SELECT RAISE(ABORT, 'change set approval revocations are immutable'); END;
CREATE TRIGGER change_set_approval_revocations_no_delete BEFORE DELETE ON change_set_approval_revocations
BEGIN SELECT RAISE(ABORT, 'change set approval revocations are immutable'); END;

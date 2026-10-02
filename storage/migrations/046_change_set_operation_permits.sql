CREATE TABLE change_set_operation_permits (
  permit_id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  manifest_hash TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  approval_id TEXT NOT NULL REFERENCES change_set_approvals(approval_id),
  execution_work_item_id TEXT NOT NULL UNIQUE REFERENCES work_items(id),
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  permit_hash TEXT NOT NULL CHECK (length(permit_hash) = 64),
  audit_event_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  UNIQUE (mission_id, manifest_hash, operation_id),
  FOREIGN KEY (mission_id, revision, manifest_hash)
    REFERENCES change_set_revisions(mission_id, revision, manifest_hash)
);
CREATE TRIGGER change_set_operation_permits_no_update BEFORE UPDATE ON change_set_operation_permits
BEGIN SELECT RAISE(ABORT, 'change set operation permits are immutable'); END;
CREATE TRIGGER change_set_operation_permits_no_delete BEFORE DELETE ON change_set_operation_permits
BEGIN SELECT RAISE(ABORT, 'change set operation permits are immutable'); END;
